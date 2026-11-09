from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from pathlib import Path
from urllib.parse import urlparse

from gallery_dl import config, exception as gdl_exception, extractor as gdl_extractor, job

from ig_cookies import SESSION_DEAD, clear_cookies, cookies_path, status as cookie_status
from settings import DOWNLOADS, default_settings, load_settings, normalize_dest, normalize_range, range_label

DOWNLOAD_LOCK = threading.Lock()
EventCallback = Callable[[dict], None]


def _friendly_ig_error(raw: str) -> str:
    text = (raw or "").strip()
    lower = text.lower()
    if "are private" in lower or "posts are private" in lower:
        return (
            "Akun Instagram ini privat. Login harus follow akun itu dulu, "
            "baru unduh bisa jalan."
        )
    if "redirect to home" in lower or "redirect to login" in lower or "redirect to challenge" in lower:
        return SESSION_DEAD
    if "requested user could not be found" in lower or "usernotfound" in lower.replace(" ", ""):
        return (
            "User Instagram tidak ditemukan, atau session login sudah tidak valid. "
            "Cek URL/username, lalu tempel sessionid baru dan Simpan session."
        )
    if "login" in lower or "auth" in lower or "unauthorized" in lower or "403" in lower:
        return SESSION_DEAD
    return text or "Gagal mengambil data dari Instagram"


def is_instagram_url(raw: str) -> bool:
    try:
        parsed = urlparse(raw.strip())
    except ValueError:
        return False
    if parsed.scheme not in {"http", "https"}:
        return False
    host = (parsed.hostname or "").lower()
    return host == "instagram.com" or host.endswith(".instagram.com")


def normalize_instagram_url(raw: str) -> str:
    cleaned = raw.strip().split("#")[0]
    parsed = urlparse(cleaned)
    parts = [part for part in parsed.path.split("/") if part]
    if not parts:
        return cleaned.rstrip("/") + "/"
    first = parts[0].lower()
    if first in {"p", "tv", "reel", "reels", "stories", "explore", "share"}:
        return cleaned.rstrip("/") + "/"
    # Bare profile → keep as /USER/ so gallery-dl uses UserExtractor → posts.
    # Do NOT force /posts/ alone on old extractors; bare profile is the stable form.
    if len(parts) == 1:
        return f"https://www.instagram.com/{parts[0]}/"
    if len(parts) == 2 and parts[1].lower() in {"posts", "reels", "tagged", "saved", "photos"}:
        return f"https://www.instagram.com/{parts[0]}/{parts[1].lower()}/"
    return cleaned.rstrip("/") + "/"


def _safe_rel(path: Path, dest: Path) -> str:
    try:
        return str(path.resolve().relative_to(dest.resolve()))
    except ValueError:
        return path.name


def _post_key(kwdict: dict) -> str:
    # Prefer post-level ids so carousel slides stay one "post" for range limits.
    for field in ("post_shortcode", "sidecar_media_id", "post_id", "shortcode", "media_id"):
        value = kwdict.get(field)
        if value is not None and str(value).strip():
            return str(value).strip()
    return ""


def _slide_num(kwdict: dict) -> int:
    try:
        return max(int(kwdict.get("num") or 1), 1)
    except (TypeError, ValueError):
        return 1


def _slide_letter(num: int) -> str:
    """1 -> a, 2 -> b, ... 26 -> z, 27 -> aa (carousel suffix)."""
    n = max(int(num), 1)
    letters = []
    while n > 0:
        n, rem = divmod(n - 1, 26)
        letters.append(chr(ord("a") + rem))
    return "".join(reversed(letters))


def _post_label(post_no: int, slide: int, slides: int, width: int) -> str:
    base = f"{post_no:0{width}d}"
    if slides > 1 or slide > 1:
        return f"{base}{_slide_letter(slide)}"
    return base


def _new_ig_state(start: int, limit: int, skip: int, dest: Path, on_event: EventCallback | None) -> dict:
    """Mutable bag shared by parent + child DownloadJobs (gallery-dl forks children)."""
    return {
        "on_event": on_event,
        "saved": [],
        "failed": 0,
        "dest": dest,
        "limit": limit,
        "start": start,
        "skip": skip,
        "skipped": 0,
        "posts_taken": 0,
        "last_post_key": "",
        "skipping_post": "",
    }


class IgProgressJob(job.DownloadJob):
    """Download Instagram posts; carousel slides of an accepted post are never trimmed."""

    def __init__(self, url, parent=None):
        super().__init__(url, parent)
        # Always reuse the same dict so child jobs share counters/limits.
        shared = getattr(parent, "ig_state", None)
        if shared is None:
            shared = _new_ig_state(
                default_settings()["start"],
                default_settings()["limit"],
                0,
                DOWNLOADS,
                None,
            )
        self.ig_state = shared

    @property
    def saved(self):
        return self.ig_state["saved"]

    @property
    def failed_box(self):
        return {"n": self.ig_state["failed"]}

    def handle_url(self, url, kwdict):
        state = self.ig_state
        key = _post_key(kwdict) or f"file:{url}"

        # Remaining slides of a skipped carousel/post.
        if state["skipping_post"] and key == state["skipping_post"]:
            return

        if key != state["last_post_key"]:
            # New post boundary.
            if state["skipped"] < state["skip"]:
                state["skipped"] += 1
                state["last_post_key"] = key
                state["skipping_post"] = key
                if state["skipped"] == state["skip"] or state["skipped"] % 25 == 0:
                    self._emit(
                        {
                            "type": "status",
                            "message": (
                                f"Melewati {state['skipped']} post menuju "
                                f"{range_label(state['start'], limit=state['limit'])}..."
                            ),
                        }
                    )
                return

            if state["posts_taken"] >= state["limit"]:
                # depth=2: stop child posts extractor and parent user dispatcher.
                raise gdl_exception.StopExtraction(2)

            state["posts_taken"] += 1
            state["last_post_key"] = key
            state["skipping_post"] = ""
            slides = int(kwdict.get("count") or 0)
            slide = _slide_num(kwdict)
            post_no = state["start"] + state["posts_taken"] - 1
            end_no = state["start"] + state["limit"] - 1
            if slides > 1 or slide > 1:
                self._emit(
                    {
                        "type": "status",
                        "message": (
                            f"Post {post_no}/{end_no}: carousel {slides or '?'} slide... "
                            f"({len(state['saved'])} file)"
                        ),
                    }
                )
            elif state["posts_taken"] == 1 or state["posts_taken"] % 10 == 0:
                self._emit(
                    {
                        "type": "status",
                        "message": (
                            f"Post {post_no}/{end_no}... ({len(state['saved'])} file)"
                        ),
                    }
                )

        # Accepted post: always save every slide/video in the carousel.
        super().handle_url(url, kwdict)
        pathfmt = self.pathfmt
        if not pathfmt or not getattr(pathfmt, "path", None):
            return
        path = Path(str(pathfmt.path))
        if not path.exists():
            state["failed"] += 1
            self._emit({"type": "error", "message": f"Gagal unduh {path.name}"})
            return
        path = self._number_file(path, kwdict)
        rel = _safe_rel(path, state["dest"])
        if rel in state["saved"]:
            return
        post_no = state["start"] + state["posts_taken"] - 1
        slide = _slide_num(kwdict)
        slides = int(kwdict.get("count") or 0)
        width = max(3, len(str(state["start"] + max(state["limit"], 1) - 1)))
        label = _post_label(post_no, slide, slides, width)
        state["saved"].append(rel)
        event = {
            "type": "file",
            "path": rel,
            "name": path.name,
            "number": label,
            "label": label,
            "post": post_no,
            "slide": slide,
            "slides": slides,
            "posts_taken": state["posts_taken"],
            "posts_limit": state["limit"],
            "files": len(state["saved"]),
        }
        # Video list preview must use Instagram cover/rthumb, never the .mp4 itself.
        if path.suffix.lower() in {".mp4", ".mov", ".m4v", ".webm"}:
            thumb = str(kwdict.get("display_url") or "").strip()
            if thumb.startswith("http"):
                event["thumb"] = thumb
            event["kind"] = "video"
        else:
            event["kind"] = "image"
        self._emit(event)

    def _number_file(self, path: Path, kwdict: dict) -> Path:
        state = self.ig_state
        # Post index in range; carousel slides share it as 001a, 001b, 001c...
        index = state["start"] + state["posts_taken"] - 1
        width = max(3, len(str(state["start"] + max(state["limit"], 1) - 1)))
        slide = _slide_num(kwdict)
        slides = int(kwdict.get("count") or 0)
        label = _post_label(index, slide, slides, width)
        code = str(
            kwdict.get("post_shortcode")
            or kwdict.get("shortcode")
            or kwdict.get("media_id")
            or "media"
        )
        code = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in code)[:40]
        name = f"{label}_{code}{path.suffix}"
        target = path.with_name(name)
        if path.name == name:
            return path
        if target.exists():
            path.unlink(missing_ok=True)
            return target
        path.rename(target)
        return target

    def _emit(self, event: dict) -> None:
        on_event = self.ig_state.get("on_event")
        if on_event:
            on_event(event)


def download_instagram(
    url: str,
    on_event: EventCallback,
    dest: str | None = None,
    limit=None,
    start=None,
    end=None,
) -> dict:
    cleaned = url.strip()
    if not is_instagram_url(cleaned):
        raise ValueError("URL harus dari instagram.com")
    auth = cookie_status()
    if not auth["logged_in"]:
        raise ValueError("Login Instagram dulu: tempel sessionid lalu Simpan session.")

    settings = load_settings()
    dest_path = normalize_dest(dest or settings["dest"])
    parsed = normalize_range(
        start if start is not None else settings["start"],
        end if end is not None else (None if start is not None else settings["end"]),
        limit if limit is not None else None,
    )
    range_start = parsed["start"]
    max_posts = parsed["limit"]
    skip = max(range_start - 1, 0)
    label = parsed["label"]
    source = normalize_instagram_url(cleaned)

    on_event({"type": "status", "message": "Menunggu giliran..."})
    errors: list[str] = []

    class _ErrorHandler(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            message = record.getMessage()
            if record.levelno >= logging.ERROR:
                errors.append(message)
                on_event({"type": "error", "message": _friendly_ig_error(message)})
            elif record.levelno >= logging.WARNING and "private" in message.lower():
                errors.append(message)

    handler = _ErrorHandler()
    # gallery-dl logs under extractor names; catch both.
    logger = logging.getLogger("instagram")
    logger.addHandler(handler)
    gdl_logger = logging.getLogger("gallery_dl")
    gdl_logger.addHandler(handler)
    job_run = None
    try:
        with DOWNLOAD_LOCK:
            on_event(
                {
                    "type": "status",
                    "message": (
                        f"Mengambil Instagram {label} ke {dest_path}... "
                        "Carousel diunduh lengkap."
                    ),
                }
            )
            if not gdl_extractor.find(source):
                raise ValueError("URL Instagram tidak dikenali")
            config.clear()
            config.set((), "base-directory", str(dest_path))
            config.set(("extractor", "instagram"), "cookies", str(cookies_path()))
            config.set(("extractor", "instagram"), "videos", True)
            config.set(("extractor", "instagram"), "previews", False)
            config.set(("extractor", "instagram"), "order-files", "asc")
            config.set(("downloader",), "retries", 4)
            config.set(("downloader",), "timeout", 30.0)
            config.set(("output",), "mode", "null")
            state = _new_ig_state(range_start, max_posts, skip, dest_path, on_event)
            job_run = IgProgressJob(source)
            job_run.ig_state = state
            try:
                job_run.run()
            except gdl_exception.StopExtraction:
                pass
            except gdl_exception.NotFoundError as exc:
                raise ValueError(_friendly_ig_error(str(exc))) from exc
            except gdl_exception.AuthRequired as exc:
                clear_cookies()
                raise ValueError(SESSION_DEAD) from exc
            except gdl_exception.AbortExtraction as exc:
                message = _friendly_ig_error(str(exc))
                if message == SESSION_DEAD or "redirect" in str(exc).lower():
                    clear_cookies()
                    raise ValueError(SESSION_DEAD) from exc
                raise ValueError(message) from exc
            except gdl_exception.GalleryDLException as exc:
                message = _friendly_ig_error(str(exc))
                if message == SESSION_DEAD:
                    clear_cookies()
                raise ValueError(message or "Gagal mengambil data dari Instagram") from exc
    finally:
        logger.removeHandler(handler)
        gdl_logger.removeHandler(handler)

    if job_run is None:
        raise ValueError("Unduhan Instagram gagal dimulai")

    state = job_run.ig_state
    saved = state["saved"]
    failed = state["failed"]
    if not saved:
        if errors:
            message = _friendly_ig_error(errors[-1])
            if message == SESSION_DEAD:
                clear_cookies()
            raise ValueError(message)
        raise ValueError("Tidak ada file yang bisa diunduh. Cek login atau URL-nya.")

    result = {
        "type": "done",
        "ok": True,
        "count": len(saved),
        "posts": state["posts_taken"],
        "failed": failed,
        "folder": str(dest_path),
        "dest": str(dest_path),
        "limit": max_posts,
        "start": range_start,
        "end": parsed["end"],
        "label": label,
        "skipped": state["skipped"],
        "source": "instagram",
    }
    on_event(result)
    return result
