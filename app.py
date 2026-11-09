from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import threading
from pathlib import Path
from queue import Queue

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from downloader import download_pinterest, is_pinterest_url, list_downloads, resolve_download
from ig_cookies import (
    clear_cookies,
    status as ig_status,
    write_netscape,
    write_netscape_text,
    write_sessionid,
)
from ig_downloader import download_instagram, is_instagram_url
from settings import load_settings, normalize_dest, save_settings
from updater import check_update, download_update
from version import app_version

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"

app = FastAPI(title="Pinterest Download by GEMADIPADA")
app.mount("/static", StaticFiles(directory=STATIC), name="static")


class DownloadRequest(BaseModel):
    url: str = Field(min_length=8, max_length=2000)
    dest: str | None = None
    start: int | None = None
    end: int | None = None
    limit: int | None = None


class SettingsRequest(BaseModel):
    dest: str | None = None
    start: int | None = None
    end: int | None = None
    limit: int | None = None


class OpenFolderRequest(BaseModel):
    dest: str | None = None
    folder: str = ""


class InstagramCookiesRequest(BaseModel):
    cookies: list[dict] = Field(default_factory=list)


class InstagramSessionRequest(BaseModel):
    sessionid: str = Field(default="", max_length=4000)
    csrftoken: str = Field(default="", max_length=4000)
    cookies_text: str = Field(default="", max_length=200000)


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/api/settings")
def get_settings():
    return load_settings()


@app.post("/api/settings")
def update_settings(body: SettingsRequest):
    try:
        return save_settings(body.dest, start=body.start, end=body.end, limit=body.limit)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.get("/api/files")
def files(dest: str | None = None):
    return {"files": list_downloads(dest)}


@app.get("/api/file/{rel_path:path}")
def file_preview(rel_path: str, dest: str | None = None):
    try:
        path = resolve_download(rel_path, dest)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(404, "File tidak ditemukan") from exc
    return FileResponse(path)


def _pick_folder_native(start: str | None = None) -> str | None:
    """Native folder dialog for browser mode (no Electron preload)."""
    initial = ""
    if start:
        try:
            initial = str(normalize_dest(start))
        except ValueError:
            initial = ""

    if sys.platform == "darwin":
        script = 'POSIX path of (choose folder with prompt "Pilih folder unduhan"'
        if initial and Path(initial).is_dir():
            safe = initial.replace("\\", "\\\\").replace('"', '\\"')
            script += f' default location POSIX file "{safe}"'
        script += ")"
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            return None
        path = (result.stdout or "").strip().rstrip("/")
        return path or None

    if sys.platform == "win32":
        # PowerShell folder browser
        ps = (
            "Add-Type -AssemblyName System.Windows.Forms; "
            "$d = New-Object System.Windows.Forms.FolderBrowserDialog; "
            '$d.Description = "Pilih folder unduhan"; '
            "if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }"
        )
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps],
            capture_output=True,
            text=True,
            check=False,
        )
        path = (result.stdout or "").strip()
        return path or None

    # Linux: zenity / kdialog
    for cmd in (
        ["zenity", "--file-selection", "--directory", "--title=Pilih folder unduhan"],
        ["kdialog", "--getexistingdirectory", initial or str(Path.home())],
    ):
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, check=False)
        except FileNotFoundError:
            continue
        if result.returncode == 0:
            path = (result.stdout or "").strip()
            if path:
                return path
    return None


@app.post("/api/pick-folder")
def pick_folder(body: SettingsRequest = SettingsRequest()):
    start = body.dest or load_settings().get("dest")
    path = _pick_folder_native(start)
    if not path:
        return {"ok": False, "canceled": True, "path": None}
    try:
        saved = save_settings(path)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"ok": True, "canceled": False, "path": saved["dest"]}


@app.post("/api/open-folder")
def open_folder(body: OpenFolderRequest):
    try:
        root = normalize_dest(body.dest or load_settings()["dest"])
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    target = root if not body.folder else (root / body.folder)
    target = target.resolve()
    if root.resolve() not in target.parents and target != root.resolve():
        raise HTTPException(400, "Folder tidak valid")
    target.mkdir(parents=True, exist_ok=True)
    if sys.platform == "win32":
        os.startfile(target)
    elif sys.platform == "darwin":
        subprocess.run(["open", str(target)], check=False)
    else:
        subprocess.run(["xdg-open", str(target)], check=False)
    return {"ok": True, "path": str(target)}


@app.post("/api/download")
def start_download(body: DownloadRequest):
    url = body.url.strip()
    if not is_pinterest_url(url):
        raise HTTPException(400, "URL harus dari pinterest.com atau pin.it")

    events: Queue = Queue()

    def emit(event: dict) -> None:
        events.put(event)

    def worker() -> None:
        try:
            download_pinterest(
                url,
                emit,
                dest=body.dest,
                start=body.start,
                end=body.end,
                limit=body.limit,
            )
        except Exception as exc:
            events.put({"type": "error", "message": str(exc)})
            events.put({"type": "done", "ok": False, "count": 0, "failed": 0, "folder": ""})
        finally:
            events.put(None)

    async def stream():
        loop = asyncio.get_running_loop()
        threading.Thread(target=worker, daemon=True).start()
        while True:
            item = await loop.run_in_executor(None, events.get)
            if item is None:
                break
            yield f"data: {json.dumps(item, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/instagram/status")
def instagram_status():
    return ig_status()


@app.post("/api/instagram/cookies")
def instagram_cookies(body: InstagramCookiesRequest):
    try:
        return write_netscape(body.cookies)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/api/instagram/session")
def instagram_session(body: InstagramSessionRequest):
    try:
        if (body.cookies_text or "").strip():
            return write_netscape_text(body.cookies_text)
        return write_sessionid(body.sessionid, body.csrftoken)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/api/instagram/logout")
def instagram_logout():
    return clear_cookies()


@app.post("/api/instagram/download")
def start_instagram_download(body: DownloadRequest):
    url = body.url.strip()
    if not is_instagram_url(url):
        raise HTTPException(400, "URL harus dari instagram.com")

    events: Queue = Queue()

    def emit(event: dict) -> None:
        events.put(event)

    def worker() -> None:
        try:
            download_instagram(
                url,
                emit,
                dest=body.dest,
                start=body.start,
                end=body.end,
                limit=body.limit,
            )
        except Exception as exc:
            events.put({"type": "error", "message": str(exc)})
            events.put({"type": "done", "ok": False, "count": 0, "failed": 0, "folder": ""})
        finally:
            events.put(None)

    async def stream():
        loop = asyncio.get_running_loop()
        threading.Thread(target=worker, daemon=True).start()
        while True:
            item = await loop.run_in_executor(None, events.get)
            if item is None:
                break
            yield f"data: {json.dumps(item, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/version")
def version():
    return {"version": app_version()}


@app.get("/api/update")
def update_info():
    try:
        return check_update()
    except Exception as exc:
        raise HTTPException(502, f"Gagal cek pembaruan: {exc}") from exc


@app.post("/api/update/download")
def update_download():
    try:
        return download_update()
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(502, f"Gagal unduh pembaruan: {exc}") from exc


@app.get("/health")
def health():
    return {"ok": True, "version": app_version()}
