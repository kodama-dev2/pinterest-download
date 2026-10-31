from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from pathlib import Path
from urllib.parse import urlparse

from gallery_dl import config, exception as gdl_exception, job

from settings import DOWNLOADS, default_settings, load_settings, normalize_dest, normalize_limit

DOWNLOAD_LOCK = threading.Lock()

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


def _configure(dest: Path, limit: int) -> None:
    config.clear()
    config.set((), "base-directory", str(dest))
    config.set(("extractor",), "image-range", f"1-{limit}")
    config.set(("extractor", "pinterest"), "videos", False)
    config.set(("extractor", "pinterest"), "sections", True)
    config.set(("extractor", "pinterest"), "stories", True)
    config.set(("downloader",), "retries", 4)
    config.set(("downloader",), "timeout", 30.0)
    config.set(("output",), "mode", "null")


def _safe_rel(path: Path, dest: Path) -> str:
    try:
        return str(path.resolve().relative_to(dest.resolve()))
    except ValueError:
        return path.name


class ProgressJob(job.DownloadJob):
    def __init__(self, url, parent=None):
        super().__init__(url, parent)
        self._on_event = getattr(parent, "_on_event", None)
        self.saved = getattr(parent, "saved", [])
        self.failed_box = getattr(parent, "failed_box", {"n": 0})
        self.dest = getattr(parent, "dest", DOWNLOADS)
        self.limit = getattr(parent, "limit", default_settings()["limit"])

    def handle_url(self, url, kwdict):
        if len(self.saved) >= self.limit:
            raise gdl_exception.StopExtraction()
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
        number = len(self.saved) + 1
        self.saved.append(rel)
        self._emit({"type": "file", "path": rel, "name": path.name, "number": number})
        if len(self.saved) >= self.limit:
            raise gdl_exception.StopExtraction()

    def _number_file(self, path: Path) -> Path:
        index = len(self.saved) + 1
        width = max(2, len(str(self.limit)))
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


def download_pinterest(
    url: str,
    on_event: EventCallback,
    dest: str | None = None,
    limit=None,
) -> dict:
    cleaned = url.strip()
    if not is_pinterest_url(cleaned):
        raise ValueError("URL harus dari pinterest.com atau pin.it")

    settings = load_settings()
    dest_path = normalize_dest(dest or settings["dest"])
    max_files = normalize_limit(limit if limit is not None else settings["limit"])

    on_event(
        {
            "type": "status",
            "message": f"Mengambil sampai {max_files} image ke {dest_path}...",
        }
    )

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
    try:
        with DOWNLOAD_LOCK:
            _configure(dest_path, max_files)
            progress = ProgressJob(cleaned)
            progress._on_event = on_event
            progress.saved = []
            progress.failed_box = {"n": 0}
            progress.dest = dest_path
            progress.limit = max_files
            try:
                status = progress.run()
            except gdl_exception.NoExtractorError as exc:
                raise ValueError("URL Pinterest tidak dikenali") from exc
            except gdl_exception.GalleryDLException as exc:
                raise ValueError(str(exc) or "Gagal mengambil data dari Pinterest") from exc
    finally:
        logger.removeHandler(handler)

    folder = str(dest_path)
    if progress.saved:
        first = dest_path / progress.saved[0]
        folder = str(first.parent)

    if not progress.saved:
        if errors:
            raise ValueError(errors[-1])
        if status:
            raise ValueError("Tidak ada image yang bisa diunduh dari URL ini")

    result = {
        "type": "done",
        "ok": True,
        "count": len(progress.saved),
        "failed": progress.failed_box["n"],
        "folder": folder,
        "dest": str(dest_path),
        "limit": max_files,
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
