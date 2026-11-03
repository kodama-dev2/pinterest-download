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
from settings import load_settings, normalize_dest, save_settings

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


@app.get("/health")
def health():
    return {"ok": True}
