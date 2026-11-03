from __future__ import annotations

import logging
import shutil
import threading
from collections.abc import Callable
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from gallery_dl import config, exception as gdl_exception, extractor as gdl_extractor, job, text as gdl_text, util as gdl_util
from gallery_dl.extractor import pinterest as pinmod

from settings import (
    DOWNLOADS,
    default_settings,
    load_settings,
    normalize_dest,
    normalize_range,
    range_label,
)

DOWNLOAD_LOCK = threading.Lock()
PAGE_SIZE = 50

EventCallback = Callable[[dict], None]


def is_pinterest_url(raw: str) -> bool:
    try:
        parsed = urlparse(raw.strip())
    except ValueError:
        return False
    if parsed.scheme not in {"http", "https"}:
        return False
    host = (parsed.hostname or "").lower()
    return host == "pin.it" or host.endswith(".pin.it") or "pinterest." in host


def pin_related_url(raw: str) -> str | None:
    parsed = urlparse(raw.strip())
    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) < 2 or parts[0].lower() != "pin":
        return None
    host = parsed.hostname or "www.pinterest.com"
    scheme = parsed.scheme or "https"
    return f"{scheme}://{host}/pin/{parts[1]}/#related"


JS_MAX_SAFE_INT = 9_007_199_254_740_991


def _js_number_id(raw: str) -> str:
    text = str(raw).strip()
    if not text.isdigit():
        return text
    value = int(text)
    if value <= JS_MAX_SAFE_INT:
        return text
    return str(int(float(text)))


def _pin_id_candidates(raw: str) -> list[str]:
    text = str(raw).strip()
    ids = [text]
    if text.isdigit() and int(text) > JS_MAX_SAFE_INT:
        for rounded in (str(int(float(text))), str(int(float(int(text))))):
            if rounded not in ids:
                ids.append(rounded)
    return ids


def _pin_extractor(page_url: str, pin_id: str):
    parsed = urlparse(page_url.strip())
    host = parsed.hostname or "www.pinterest.com"
    scheme = parsed.scheme or "https"
    extr = gdl_extractor.find(f"{scheme}://{host}/pin/{pin_id}/")
    if not extr:
        return None
    extr.initialize()
    _warm_extractor(extr)
    return extr


def _lookup_pin(pin_id: str, page_url: str) -> dict | None:
    extr = _pin_extractor(page_url, pin_id)
    if not extr:
        return None
    try:
        data = extr.api.pin(pin_id)
    except Exception:
        return None
    if isinstance(data, dict) and data.get("id"):
        return data
    return None


def _lookup_pin_json_number(pin_id: str, page_url: str) -> dict | None:
    if not str(pin_id).isdigit():
        return None
    extr = _pin_extractor(page_url, pin_id)
    if not extr:
        return None
    try:
        payload = extr.api._call("Pin", {"id": int(pin_id), "field_set_key": "detailed"})
        data = (payload.get("resource_response") or {}).get("data")
    except Exception:
        return None
    if isinstance(data, dict) and data.get("id"):
        return data
    return None


def _canonical_pin_url(raw: str) -> str:
    parsed = urlparse(raw.strip())
    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) < 2 or parts[0].lower() != "pin":
        return raw.split("#")[0]
    host = parsed.hostname or "www.pinterest.com"
    scheme = parsed.scheme or "https"
    pin_id = parts[1]
    page = f"{scheme}://{host}/pin/{pin_id}/"
    found = _lookup_pin(pin_id, page) or _lookup_pin_json_number(pin_id, page)
    if not found:
        for candidate in _pin_id_candidates(pin_id)[1:]:
            found = _lookup_pin(candidate, page)
            if found:
                break
    if found:
        return f"{scheme}://{host}/pin/{found.get('id') or pin_id}/"
    return page


PROFILE_PARTS = {"_created", "_saved", "pins", "likes", "followers", "following"}
RESERVED_PATHS = {"pin", "search", "ideas", "today", "shop"}


def _url_parts(raw: str) -> list[str]:
    parsed = urlparse(raw.strip())
    return [part for part in parsed.path.split("/") if part]


def is_profile_page(raw: str) -> bool:
    parts = _url_parts(raw)
    if not parts or parts[0].lower() in RESERVED_PATHS:
        return False
    return len(parts) == 1 or (len(parts) == 2 and parts[1].lower() == "_saved")


def source_urls(raw: str) -> list[str]:
    cleaned = raw.strip()
    parsed = urlparse(cleaned)
    parts = [part for part in parsed.path.split("/") if part]
    if not parts:
        return [cleaned]
    reserved = RESERVED_PATHS
    if parts[0].lower() in reserved:
        return [cleaned]
    if len(parts) == 1 or (len(parts) == 2 and parts[1].lower() == "_saved"):
        host = parsed.hostname or "www.pinterest.com"
        scheme = parsed.scheme or "https"
        user = parts[0]
        base = f"{scheme}://{host}/{user}"
        return [f"{base}/_created/", f"{base}/pins/", f"{base}/"]
    if len(parts) == 2 and parts[1].lower() in PROFILE_PARTS:
        return [cleaned]
    board = cleaned.split("#")[0].rstrip("/") + "/"
    host = parsed.hostname or "www.pinterest.com"
    scheme = parsed.scheme or "https"
    user_pins = f"{scheme}://{host}/{parts[0]}/pins/"
    if (parsed.fragment or "").lower() == "related":
        return [cleaned, user_pins]
    return [board, f"{board}#related", user_pins]


def _next_bookmarks(data: dict):
    response = data.get("resource_response") or {}
    resource = data.get("resource") or {}
    options = resource.get("options") or {}
    candidates = (
        options.get("bookmarks"),
        response.get("bookmarks"),
        response.get("bookmark"),
        resource.get("bookmarks"),
        resource.get("bookmark"),
    )
    for raw in candidates:
        if raw in (None, "", "-end-"):
            continue
        values = raw if isinstance(raw, list) else [raw]
        if not values:
            continue
        first = str(values[0])
        if first == "-end-" or first.startswith("Y2JOb25lO"):
            continue
        return values
    return None


def _page_results(data: dict):
    results = (data.get("resource_response") or {}).get("data")
    if isinstance(results, dict):
        return results.get("results") or []
    return results or []


def _source_path(extractor) -> str:
    parsed = urlparse(getattr(extractor, "url", "") or "")
    path = parsed.path or "/"
    if path != "/" and not path.endswith("/"):
        path += "/"
    return path.split("#")[0]


def _warm_extractor(extractor) -> None:
    if getattr(extractor, "_pinterest_dl_warmed", False):
        return
    url = getattr(extractor, "url", "") or ""
    if url:
        try:
            extractor.request(url.split("#")[0])
        except Exception:
            pass
    extractor._pinterest_dl_warmed = True


def _patched_call(self, resource, options):
    _warm_extractor(self.extractor)
    path = _source_path(self.extractor)
    self.headers["X-Pinterest-Source-Url"] = path
    if resource == "BoardFeed":
        self.headers["X-Pinterest-PWS-Handler"] = "www/[username]/[slug].js"
    elif resource in {"RelatedPinFeed", "Pin"}:
        self.headers["X-Pinterest-PWS-Handler"] = "www/pin/[id].js"
    elif resource in {"UserPins", "UserActivityPins", "Boards"}:
        self.headers["X-Pinterest-PWS-Handler"] = "www/[username].js"
    try:
        self.cookies.update(self.extractor.session.cookies.get_dict())
    except Exception:
        pass
    url = f"{self.root}/resource/{resource}Resource/get/"
    params = {
        "data": gdl_util.json_dumps({"options": options}),
        "source_url": path,
    }
    response = self.extractor.request(
        url, params=params, headers=self.headers, fatal=False
    )
    try:
        data = response.json()
    except ValueError:
        data = {}
    if response.history:
        self.root = gdl_text.root_from_url(response.url)
    if response.status_code < 400:
        return data
    if response.status_code == 404:
        kind = self.extractor.subcategory.rpartition("-")[2]
        raise gdl_exception.NotFoundError(kind)
    raise gdl_exception.AbortExtraction("API request failed")


def _patched_pagination(self, resource, options):
    options = dict(options)
    if resource == "RelatedPinFeed":
        options.setdefault("page_size", 50)
        options.setdefault("add_vase", True)
        options.setdefault("pins_only", True)
    else:
        options.setdefault("page_size", 25)
    seen: set[tuple] = set()
    retried = 0
    while True:
        data = self._call(resource, options)
        results = _page_results(data)
        bookmarks = _next_bookmarks(data)
        if (
            resource in {"BoardFeed", "RelatedPinFeed"}
            and not bookmarks
            and not options.get("bookmarks")
            and retried < 1
        ):
            retried += 1
            self.extractor._pinterest_dl_warmed = False
            _warm_extractor(self.extractor)
            continue
        if not results:
            break
        yield from results
        if not bookmarks:
            break
        token = tuple(str(item) for item in bookmarks)
        if token in seen:
            break
        seen.add(token)
        options["bookmarks"] = bookmarks
        options.pop("bookmark", None)


if not getattr(pinmod.PinterestAPI._call, "_pinterest_dl_call_patched", False):
    pinmod.PinterestAPI._call = _patched_call
    _patched_call._pinterest_dl_call_patched = True

if not getattr(pinmod.PinterestAPI._pagination, "_pinterest_dl_patched", False):
    pinmod.PinterestAPI._pagination = _patched_pagination
    _patched_pagination._pinterest_dl_patched = True


def ffmpeg_path() -> str | None:
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def _prefer_progressive_video(self, video):
    video_formats = video["video_list"]
    for fmt in ("V_720P", "V_EXP7", "V_EXP6", "V_EXP5", "V_EXP4", "V_EXP3"):
        media = video_formats.get(fmt)
        url = (media or {}).get("url") or ""
        if media and url and not url.endswith(".m3u8"):
            return media
    return pinmod.PinterestExtractor._extract_video_original(self, video)


if not getattr(pinmod.PinterestExtractor, "_pinterest_dl_video_patched", False):
    pinmod.PinterestExtractor._extract_video_original = pinmod.PinterestExtractor._extract_video
    pinmod.PinterestExtractor._extract_video = _prefer_progressive_video
    pinmod.PinterestExtractor._pinterest_dl_video_patched = True


def _configure(dest: Path, limit: int) -> None:
    global PAGE_SIZE
    PAGE_SIZE = min(max(int(limit), 25), 200)
    config.clear()
    config.set((), "base-directory", str(dest))
    config.set(("extractor", "pinterest"), "videos", True)
    config.set(("extractor", "pinterest"), "sections", False)
    config.set(("extractor", "pinterest"), "stories", True)
    config.set(("downloader",), "retries", 4)
    config.set(("downloader",), "timeout", 30.0)
    config.set(("downloader", "ytdl"), "enabled", True)
    config.set(("downloader", "ytdl"), "module", "yt_dlp")
    ffmpeg = ffmpeg_path()
    if ffmpeg:
        config.set(
            ("downloader", "ytdl"),
            "raw-options",
            {"ffmpeg_location": ffmpeg, "merge_output_format": "mp4"},
        )
    config.set(("output",), "mode", "null")


def _safe_rel(path: Path, dest: Path) -> str:
    try:
        return str(path.resolve().relative_to(dest.resolve()))
    except ValueError:
        return path.name


def _pin_key(kwdict: dict) -> str:
    pin_id = str(kwdict.get("id") or "").strip()
    signature = str(kwdict.get("image_signature") or "").strip()
    return pin_id or signature


class ProgressJob(job.DownloadJob):
    def __init__(self, url, parent=None):
        super().__init__(url, parent)
        self._on_event = getattr(parent, "_on_event", None)
        self.saved = getattr(parent, "saved", [])
        self.failed_box = getattr(parent, "failed_box", {"n": 0})
        self.seen_pins = getattr(parent, "seen_pins", set())
        self.pin_ids = getattr(parent, "pin_ids", [])
        self.dest = getattr(parent, "dest", DOWNLOADS)
        self.limit = getattr(parent, "limit", default_settings()["limit"])
        self.start = getattr(parent, "start", default_settings()["start"])
        self.skip = getattr(parent, "skip", max(self.start - 1, 0))
        self.skipped = getattr(parent, "skipped", 0)

    def handle_url(self, url, kwdict):
        if len(self.saved) >= self.limit:
            raise gdl_exception.StopExtraction()
        key = _pin_key(kwdict)
        if key and key in self.seen_pins:
            return
        if key:
            self.seen_pins.add(key)
        agg = kwdict.get("aggregated_pin_data")
        agg_id = str(agg.get("id") or "") if isinstance(agg, dict) else ""
        for candidate in (key, agg_id, str(kwdict.get("story_pin_data_id") or "")):
            if candidate.isdigit() and candidate not in self.pin_ids:
                self.pin_ids.append(candidate)
        if self.skipped < self.skip:
            self.skipped += 1
            if self.skipped == self.skip or self.skipped % 25 == 0:
                self._emit(
                    {
                        "type": "status",
                        "message": (
                            f"Melewati {self.skipped} pin menuju "
                            f"{range_label(self.start, limit=self.limit)}..."
                        ),
                    }
                )
            return
        super().handle_url(url, kwdict)
        pathfmt = self.pathfmt
        if not pathfmt or not getattr(pathfmt, "path", None):
            return
        path = Path(str(pathfmt.path))
        if not path.exists():
            self.failed_box["n"] += 1
            self._emit({"type": "error", "message": f"Gagal unduh {path.name}"})
            return
        path = self._number_file(path)
        rel = _safe_rel(path, self.dest)
        if rel in self.saved:
            return
        number = self.start + len(self.saved)
        self.saved.append(rel)
        self._emit({"type": "file", "path": rel, "name": path.name, "number": number})
        if len(self.saved) >= self.limit:
            raise gdl_exception.StopExtraction()

    def _number_file(self, path: Path) -> Path:
        index = self.start + len(self.saved)
        width = max(3, len(str(self.start + max(self.limit, 1) - 1)))
        prefix = f"{index:0{width}d}_"
        if path.name.startswith(prefix):
            return path
        target = path.with_name(prefix + path.name)
        if target.exists():
            return target
        path.rename(target)
        return target

    def _emit(self, event: dict) -> None:
        if self._on_event:
            self._on_event(event)


def _run_job(
    source: str,
    on_event: EventCallback,
    dest_path: Path,
    max_files: int,
    previous: ProgressJob | None,
    start: int = 1,
    skip: int = 0,
) -> ProgressJob:
    job_run = ProgressJob(source)
    job_run._on_event = on_event
    job_run.saved = previous.saved if previous else []
    job_run.failed_box = previous.failed_box if previous else {"n": 0}
    job_run.seen_pins = previous.seen_pins if previous else set()
    job_run.pin_ids = previous.pin_ids if previous else []
    job_run.dest = dest_path
    job_run.limit = max_files
    job_run.start = previous.start if previous else start
    job_run.skip = previous.skip if previous else skip
    job_run.skipped = previous.skipped if previous else 0
    job_run.run()
    return job_run


def _safe_name(key: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in key)
    return (cleaned or "pin")[:80]


def is_pin_page(raw: str) -> bool:
    return pin_related_url(raw) is not None


def _pin_folder(dest: Path, pin: dict) -> Path:
    board = pin.get("board") or {}
    owner = (board.get("owner") or {}).get("username") or (pin.get("pinner") or {}).get(
        "username"
    ) or "pinterest"
    name = board.get("name") or "pins"
    folder = dest / _safe_name(str(owner)) / _safe_name(str(name))
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def _save_folder(dest: Path, pin: dict, flat: bool, override: Path | None = None) -> Path:
    if override is not None:
        override.mkdir(parents=True, exist_ok=True)
        return override
    if flat:
        dest.mkdir(parents=True, exist_ok=True)
        return dest
    return _pin_folder(dest, pin)


def _board_page_url(profile_url: str, board: dict) -> str | None:
    path = str(board.get("url") or "").strip()
    if not path:
        owner = ((board.get("owner") or {}).get("username") or "").strip()
        slug = str(board.get("slug") or board.get("name") or "").strip()
        if owner and slug:
            path = f"/{owner}/{slug}/"
    if not path:
        return None
    if path.startswith("http://") or path.startswith("https://"):
        return path
    parsed = urlparse(profile_url.strip())
    host = parsed.hostname or "www.pinterest.com"
    scheme = parsed.scheme or "https"
    if not path.startswith("/"):
        path = f"/{path}"
    if not path.endswith("/"):
        path += "/"
    return f"{scheme}://{host}{path}"


def _profile_boards(url: str) -> list[dict]:
    extr = gdl_extractor.find(url)
    if not extr:
        return []
    extr.initialize()
    _warm_extractor(extr)
    user = getattr(extr, "user", "") or ""
    try:
        stream = extr.api.boards(user)
    except Exception:
        return []
    boards: list[dict] = []
    seen: set[str] = set()
    for board in stream:
        if not isinstance(board, dict):
            continue
        if str(board.get("type") or "").lower() == "story":
            continue
        name = str(board.get("name") or board.get("slug") or "").strip()
        page = _board_page_url(url, board)
        key = str(board.get("id") or page or name)
        if not name or not page or key in seen:
            continue
        seen.add(key)
        owner = ((board.get("owner") or {}).get("username") or user or "pinterest")
        boards.append(
            {
                "name": name,
                "owner": owner,
                "url": page,
                "pin_count": int(board.get("pin_count") or 0),
            }
        )
    return boards


def _profile_feeds(url: str) -> list[dict]:
    boards = _profile_boards(url)
    if boards:
        return boards
    parts = _url_parts(url)
    user = parts[0] if parts else "pinterest"
    parsed = urlparse(url.strip())
    host = parsed.hostname or "www.pinterest.com"
    scheme = parsed.scheme or "https"
    base = f"{scheme}://{host}/{user}"
    return [
        {
            "name": "created",
            "owner": user,
            "url": f"{base}/_created/",
            "pin_count": 0,
        },
        {
            "name": "pins",
            "owner": user,
            "url": f"{base}/pins/",
            "pin_count": 0,
        },
    ]


def _best_file(extr, pin: dict):
    try:
        files = extr._extract_files(pin) or []
    except Exception:
        files = []
    progressive = None
    hls = None
    image = None
    for file in files:
        url = file.get("url") or ""
        if not url or url.startswith("text:"):
            continue
        if url.endswith(".m3u8") or "m3u8" in url or url.startswith("ytdl:"):
            hls = hls or file
        elif ".mp4" in url or url.endswith(".mov"):
            progressive = progressive or file
        else:
            image = image or file
    if progressive:
        return progressive
    if hls:
        return hls
    orig = (pin.get("images") or {}).get("orig") or {}
    if orig.get("url"):
        return orig
    return image


def _ytdl_save(url: str, path: Path) -> bool:
    if path.exists() and path.stat().st_size > 0:
        return True
    ffmpeg = ffmpeg_path()
    if not ffmpeg:
        return False
    raw = url[5:] if url.startswith("ytdl:") else url
    try:
        import yt_dlp
    except Exception:
        return False
    target = path.with_suffix(".mp4")
    opts = {
        "outtmpl": str(target.with_suffix("")) + ".%(ext)s",
        "merge_output_format": "mp4",
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "retries": 2,
        "fragment_retries": 2,
        "socket_timeout": 20,
        "ffmpeg_location": ffmpeg,
        "concurrent_fragment_downloads": 4,
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([raw])
    except Exception:
        return False
    produced = target if target.exists() else None
    if produced is None:
        matches = [
            item
            for item in target.parent.glob(target.stem + ".*")
            if item.suffix not in {".part", ".ytdl"}
        ]
        if not matches:
            return False
        produced = matches[0]
        if produced != target:
            produced.replace(target)
    return target.exists() and target.stat().st_size > 0


def _save_media(url: str, path: Path) -> Path | None:
    if url.endswith(".m3u8") or "m3u8" in url or url.startswith("ytdl:"):
        dest = path.with_suffix(".mp4")
        return dest if _ytdl_save(url, dest) else None
    return path if _http_save(url, path) else None


def _feed_sources(url: str) -> list[str]:
    base = url.split("#")[0]
    related = pin_related_url(base)
    if related:
        resolved = _canonical_pin_url(base)
        return [resolved, pin_related_url(resolved) or resolved]
    return [base]


def _iter_feed_pins(url: str):
    seen: set[str] = set()
    for source in _feed_sources(url):
        extr = gdl_extractor.find(source)
        if not extr:
            continue
        extr.initialize()
        _warm_extractor(extr)
        pin_id = str(getattr(extr, "pin_id", "") or "")
        if pin_id:
            resolved = _canonical_pin_url(source)
            real_id = resolved.rstrip("/").split("/")[-1]
            if real_id and real_id != pin_id:
                extr.pin_id = real_id
                extr.url = resolved if "#related" not in source else pin_related_url(resolved)
        try:
            extr.metadata()
        except Exception:
            pass
        try:
            stream = extr.pins()
        except Exception:
            continue
        if stream is None:
            continue
        try:
            for pin in stream:
                if isinstance(pin, tuple) or not isinstance(pin, dict):
                    continue
                key = _pin_key(pin)
                if not key or key in seen:
                    continue
                seen.add(key)
                yield extr, pin
        except Exception:
            continue


def _http_save(url: str, path: Path) -> bool:
    if path.exists() and path.stat().st_size > 0:
        return True
    tmp = path.with_name(path.name + ".part")
    headers = {
        "User-Agent": "Mozilla/5.0",
        "Referer": "https://www.pinterest.com/",
    }
    for _ in range(2):
        try:
            request = Request(url, headers=headers)
            with urlopen(request, timeout=12) as response, tmp.open("wb") as handle:
                shutil.copyfileobj(response, handle, 64 * 1024)
            if tmp.exists() and tmp.stat().st_size > 0:
                tmp.replace(path)
                return True
        except Exception:
            if tmp.exists():
                tmp.unlink(missing_ok=True)
    return False


def _fast_single_feed(
    url: str,
    dest_path: Path,
    start: int,
    skip: int,
    limit: int,
    on_event: EventCallback,
    folder_override: Path | None = None,
    status_prefix: str = "",
) -> dict:
    saved: list[str] = []
    failed = 0
    skipped = 0
    lock = threading.Lock()
    flat = is_pin_page(url)
    folder = folder_override or dest_path
    label = range_label(start, limit=limit)
    width = max(3, len(str(start + max(limit, 1) - 1)))

    def finish(path: Path) -> None:
        with lock:
            if len(saved) >= limit:
                path.unlink(missing_ok=True)
                return
            number = start + len(saved)
            target = path.with_name(f"{number:0{width}d}_{path.name}")
            if path != target:
                if target.exists():
                    path.unlink(missing_ok=True)
                    path = target
                else:
                    path.rename(target)
                    path = target
            rel = _safe_rel(path, dest_path)
            if rel in saved:
                return
            saved.append(rel)
            on_event({"type": "file", "path": rel, "name": path.name, "number": number})
            on_event(
                {
                    "type": "status",
                    "message": f"{status_prefix}{len(saved)} file tersimpan...",
                }
            )

    def work(media_url: str, path: Path) -> None:
        nonlocal failed
        produced = _save_media(media_url, path)
        if produced:
            finish(produced)
            return
        with lock:
            failed += 1

    with ThreadPoolExecutor(max_workers=4) as pool:
        futures: set = set()
        for extr, pin in _iter_feed_pins(url):
            key = _pin_key(pin)
            if skipped < skip:
                skipped += 1
                if skipped == skip or skipped % 25 == 0:
                    on_event(
                        {
                            "type": "status",
                            "message": (
                                f"{status_prefix}Melewati {skipped} pin "
                                f"menuju {label}..."
                            ),
                        }
                    )
                continue
            while True:
                live = {item for item in futures if not item.done()}
                futures = live
                with lock:
                    have = len(saved)
                if have >= limit:
                    break
                if have + len(futures) < limit:
                    break
                wait(futures, return_when=FIRST_COMPLETED)
            with lock:
                if len(saved) >= limit:
                    break
            media = _best_file(extr, pin)
            if not media:
                continue
            media_url = media.get("url") or ""
            if not media_url:
                continue
            if "m3u8" in media_url or media_url.startswith("ytdl:"):
                ext = "mp4"
            else:
                ext = (urlparse(media_url).path.rsplit(".", 1)[-1] or "jpg").lower()
                if ext not in {"jpg", "jpeg", "png", "webp", "gif", "mp4", "mov"}:
                    ext = "jpg"
            folder = _save_folder(dest_path, pin, flat, folder_override)
            path = folder / f"{_safe_name(key)}.{ext}"
            futures.add(pool.submit(work, media_url, path))
        if futures:
            wait(futures)

    return {
        "saved": saved,
        "failed": failed,
        "skipped": skipped,
        "folder": str(folder if saved else dest_path),
    }


def _fast_profile_download(
    url: str,
    dest_path: Path,
    start: int,
    skip: int,
    limit: int,
    on_event: EventCallback,
) -> dict:
    boards = _profile_feeds(url)
    if not boards:
        return {"saved": [], "failed": 0, "skipped": 0, "folder": str(dest_path)}
    label = range_label(start, limit=limit)
    owner = _safe_name(str(boards[0].get("owner") or _url_parts(url)[0]))
    root = dest_path / owner
    on_event(
        {
            "type": "status",
            "message": f"{len(boards)} board di {owner}. Rentang {label} per folder...",
        }
    )
    saved: list[str] = []
    failed = 0
    skipped = 0
    for index, board in enumerate(boards, 1):
        name = str(board.get("name") or "board")
        pin_count = int(board.get("pin_count") or 0)
        if pin_count and pin_count <= skip:
            continue
        folder = root / _safe_name(name)
        prefix = f"Board {index}/{len(boards)} · {name} · "
        on_event({"type": "status", "message": f"{prefix}mengambil {label}..."})
        result = _fast_single_feed(
            str(board["url"]),
            dest_path,
            start,
            skip,
            limit,
            on_event,
            folder_override=folder,
            status_prefix=prefix,
        )
        board_saved = result.get("saved") or []
        saved.extend(board_saved)
        failed += int(result.get("failed") or 0)
        skipped += int(result.get("skipped") or 0)
        on_event(
            {
                "type": "status",
                "message": (
                    f"{prefix}{len(board_saved)} file. "
                    f"Total {len(saved)} file..."
                ),
            }
        )
    return {
        "saved": saved,
        "failed": failed,
        "skipped": skipped,
        "folder": str(root if saved else dest_path),
    }


def _fast_range_download(
    url: str,
    dest_path: Path,
    start: int,
    skip: int,
    limit: int,
    on_event: EventCallback,
) -> dict:
    if is_profile_page(url):
        return _fast_profile_download(
            url, dest_path, start, skip, limit, on_event
        )
    return _fast_single_feed(url, dest_path, start, skip, limit, on_event)


def _collect_feed_pins(url: str, need: int) -> list[dict]:
    extr = gdl_extractor.find(url)
    if not extr:
        return []
    extr.initialize()
    _warm_extractor(extr)
    try:
        meta = extr.metadata() or {}
    except Exception:
        meta = {}
    pins: list[dict] = []
    seen: set[str] = set()
    try:
        stream = extr.pins()
    except Exception:
        return pins
    for pin in stream:
        if isinstance(pin, tuple) or not isinstance(pin, dict):
            continue
        key = _pin_key(pin)
        if not key or key in seen:
            continue
        seen.add(key)
        item = dict(pin)
        if meta:
            item.update(meta)
        pins.append(item)
        if len(pins) >= need:
            break
    return pins


def _emit_pin_files(job_run: ProgressJob, pin: dict) -> None:
    try:
        files = job_run.extractor._extract_files(pin)
    except Exception:
        return
    if not files:
        return
    payload = dict(pin)
    payload["count"] = len(files)
    job_run.handle_directory(payload)
    for payload["num"], file in enumerate(files, 1):
        item = dict(payload)
        item.update(file)
        url = file.get("url") or ""
        if not url:
            continue
        gdl_text.nameext_from_url(url, item)
        if item.get("extension") == "m3u8":
            url = "ytdl:" + url
            item["_ytdl_manifest"] = "hls"
            item["extension"] = "mp4"
        item.setdefault("media_id", "")
        item.setdefault("page_id", "")
        job_run.handle_url(url, item)


def _download_pin_slice(
    source: str,
    pins: list[dict],
    on_event: EventCallback,
    dest_path: Path,
    max_files: int,
    start: int,
) -> ProgressJob:
    job_run = ProgressJob(source)
    job_run._on_event = on_event
    job_run.saved = []
    job_run.failed_box = {"n": 0}
    job_run.seen_pins = set()
    job_run.pin_ids = []
    job_run.dest = dest_path
    job_run.limit = max_files
    job_run.start = start
    job_run.skip = 0
    job_run.skipped = 0
    job_run.extractor.initialize()
    job_run._init()
    for pin in pins:
        if len(job_run.saved) >= max_files:
            break
        try:
            _emit_pin_files(job_run, pin)
        except gdl_exception.StopExtraction:
            break
    return job_run


def download_pinterest(
    url: str,
    on_event: EventCallback,
    dest: str | None = None,
    limit=None,
    start=None,
    end=None,
) -> dict:
    cleaned = url.strip()
    if not is_pinterest_url(cleaned):
        raise ValueError("URL harus dari pinterest.com atau pin.it")

    settings = load_settings()
    dest_path = normalize_dest(dest or settings["dest"])
    parsed = normalize_range(
        start if start is not None else settings["start"],
        end if end is not None else (None if start is not None else settings["end"]),
        limit if limit is not None else None,
    )
    range_start = parsed["start"]
    max_files = parsed["limit"]
    skip = max(range_start - 1, 0)
    label = parsed["label"]
    source = cleaned.split("#")[0]

    on_event({"type": "status", "message": "Menunggu giliran..."})

    errors: list[str] = []

    class _ErrorHandler(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            if record.levelno >= logging.ERROR:
                message = record.getMessage()
                errors.append(message)
                on_event({"type": "error", "message": message})

    handler = _ErrorHandler()
    logger = logging.getLogger("pinterest")
    logger.addHandler(handler)
    progress = {"saved": [], "failed": 0, "skipped": 0, "folder": str(dest_path)}
    try:
        with DOWNLOAD_LOCK:
            on_event(
                {
                    "type": "status",
                    "message": f"Mengambil {label} ke {dest_path}...",
                }
            )
            _configure(dest_path, max_files)
            try:
                progress = _fast_range_download(
                    source, dest_path, range_start, skip, max_files, on_event
                )
            except gdl_exception.NoExtractorError as exc:
                raise ValueError("URL Pinterest tidak dikenali") from exc
            except gdl_exception.GalleryDLException as exc:
                raise ValueError(str(exc) or "Gagal mengambil data dari Pinterest") from exc
    finally:
        logger.removeHandler(handler)

    saved = progress.get("saved") or []
    failed = progress.get("failed") or 0
    folder = progress.get("folder") or str(dest_path)

    if not saved:
        if errors:
            raise ValueError(errors[-1])
        raise ValueError("Tidak ada file yang bisa diunduh dari URL ini")

    result = {
        "type": "done",
        "ok": True,
        "count": len(saved),
        "failed": failed,
        "folder": folder,
        "dest": str(dest_path),
        "limit": max_files,
        "start": range_start,
        "end": parsed["end"],
        "label": label,
        "skipped": progress.get("skipped") or 0,
    }
    on_event(result)
    return result


def list_downloads(dest: str | None = None, limit: int = 120) -> list[dict]:
    dest_path = normalize_dest(dest or load_settings()["dest"])
    if not dest_path.exists():
        return []

    files: list[dict] = []
    for path in dest_path.rglob("*"):
        if not path.is_file() or path.name == ".gitkeep":
            continue
        files.append(
            {
                "name": path.name,
                "path": _safe_rel(path, dest_path),
                "size": path.stat().st_size,
                "mtime": path.stat().st_mtime,
            }
        )
    files.sort(key=lambda item: item["mtime"], reverse=True)
    return files[:limit]


def resolve_download(rel_path: str, dest: str | None = None) -> Path:
    dest_path = normalize_dest(dest or load_settings()["dest"])
    target = (dest_path / rel_path).resolve()
    if dest_path.resolve() not in target.parents and target != dest_path.resolve():
        raise ValueError("Path tidak valid")
    if not target.is_file():
        raise FileNotFoundError(rel_path)
    return target
