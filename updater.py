from __future__ import annotations

import json
import os
import platform
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from settings import HOME
from version import REPO, app_version, is_newer

GITHUB_API = f"https://api.github.com/repos/{REPO}/releases/latest"
GITHUB_ATOM = f"https://github.com/{REPO}/releases.atom"
GITHUB_LATEST = f"https://github.com/{REPO}/releases/latest"
GITHUB_RELEASES = f"https://github.com/{REPO}/releases"
USER_AGENT = "PinterestDownloadByGEMADIPADA/1.0.8 (+https://github.com/kodama-dev2/pinterest-download)"
PRODUCT = "Pinterest Download by GEMADIPADA"
CACHE_PATH = HOME / "update-cache.json"
CACHE_TTL = 45 * 60
TAG_RE = re.compile(r"/releases/tag/(v?\d+(?:\.\d+){1,3})")
TITLE_RE = re.compile(r"<title>\s*(?:[^<]*?\s)?v?(\d+(?:\.\d+){1,3})\s*<", re.I)


def _runtime() -> tuple[str, str]:
    system = (os.environ.get("PINTEREST_DL_OS") or sys.platform).lower()
    machine = (os.environ.get("PINTEREST_DL_ARCH") or platform.machine()).lower()
    if system.startswith("win"):
        os_name = "win"
    else:
        os_name = "mac"
    arch = "arm64" if machine in {"arm64", "aarch64"} else "x64"
    return os_name, arch


def _pick_asset(assets: list, os_name: str, arch: str) -> dict | None:
    ext = "zip" if os_name == "win" else "dmg"
    tokens = (os_name, arch, ext)
    for item in assets or []:
        name = str(item.get("name") or "").lower().replace(" ", ".")
        if all(token in name for token in tokens):
            return item
    return None


def _asset_name(version: str, os_name: str, arch: str, dotted: bool = True) -> str:
    ext = "zip" if os_name == "win" else "dmg"
    product = PRODUCT.replace(" ", ".") if dotted else PRODUCT
    return f"{product}-{version}-{os_name}-{arch}.{ext}"


def _download_url(version: str, name: str) -> str:
    return f"https://github.com/{REPO}/releases/download/v{version}/{name}"


def _payload(latest: str, asset_name: str = "", asset_url: str = "") -> dict:
    current = app_version()
    os_name, arch = _runtime()
    name = asset_name or _asset_name(latest, os_name, arch)
    url = asset_url or _download_url(latest, name)
    return {
        "current": current,
        "latest": latest or current,
        "available": bool(latest and is_newer(latest, current)),
        "name": f"v{latest}" if latest else f"v{current}",
        "url": f"https://github.com/{REPO}/releases/latest",
        "asset": name if latest else "",
        "asset_url": url if latest else "",
        "os": os_name,
        "arch": arch,
    }


def _read_cache() -> dict | None:
    try:
        data = json.loads(CACHE_PATH.read_text())
    except Exception:
        return None
    info = data.get("info")
    checked = data.get("checked_at")
    if not isinstance(info, dict) or not isinstance(checked, (int, float)):
        return None
    info["current"] = app_version()
    info["available"] = bool(info.get("latest") and is_newer(str(info.get("latest") or ""), info["current"]))
    return {"checked_at": checked, "info": info}


def _write_cache(info: dict) -> None:
    try:
        CACHE_PATH.write_text(
            json.dumps({"checked_at": time.time(), "info": info}, ensure_ascii=False)
        )
    except Exception:
        pass


def _extract_tag(text: str) -> str:
    match = TAG_RE.search(text or "")
    if match:
        return match.group(1).lstrip("v")
    title = TITLE_RE.search(text or "")
    return title.group(1) if title else ""


def _fetch(url: str, accept: str | None = None) -> tuple[str, str]:
    headers = {"User-Agent": USER_AGENT}
    if accept:
        headers["Accept"] = accept
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=20) as response:
        body = response.read().decode("utf-8", "replace")
        return response.geturl() or url, body


def _from_atom() -> dict:
    _final, feed = _fetch(GITHUB_ATOM, "application/atom+xml")
    latest = _extract_tag(feed)
    if not latest:
        raise ValueError("Rilis GitHub tidak terbaca.")
    return _payload(latest)


def _from_latest() -> dict:
    final, body = _fetch(GITHUB_LATEST, "text/html")
    latest = _extract_tag(final) or _extract_tag(body)
    if not latest:
        raise ValueError("Rilis GitHub tidak terbaca.")
    return _payload(latest)


def _from_releases_page() -> dict:
    _final, html = _fetch(GITHUB_RELEASES, "text/html")
    latest = _extract_tag(html)
    if not latest:
        raise ValueError("Rilis GitHub tidak terbaca.")
    return _payload(latest)


def _from_api() -> dict:
    _final, raw = _fetch(GITHUB_API, "application/vnd.github+json")
    data = json.loads(raw)
    latest = str(data.get("tag_name") or "").lstrip("v")
    os_name, arch = _runtime()
    asset = _pick_asset(data.get("assets") or [], os_name, arch)
    payload = _payload(
        latest,
        str((asset or {}).get("name") or ""),
        str((asset or {}).get("browser_download_url") or ""),
    )
    payload["url"] = data.get("html_url") or payload["url"]
    payload["name"] = data.get("name") or payload["name"]
    return payload


def _friendly(exc: Exception) -> str:
    text = str(exc).lower()
    code = getattr(exc, "code", None)
    if code in {403, 429} or "rate limit" in text or "403" in text or "429" in text:
        return "GitHub lagi membatasi cek rilis. Coba beberapa menit lagi."
    return "Gagal cek pembaruan dari GitHub."


def check_update(force: bool = False) -> dict:
    cached = _read_cache()
    if not force and cached and time.time() - cached["checked_at"] < CACHE_TTL:
        return cached["info"]

    errors: list[Exception] = []
    for loader in (_from_atom, _from_latest, _from_releases_page, _from_api):
        try:
            info = loader()
            if info.get("latest"):
                _write_cache(info)
                return info
        except Exception as exc:
            errors.append(exc)

    if cached:
        return cached["info"]
    raise ValueError(_friendly(errors[-1] if errors else Exception("unknown")))


def _asset_urls(version: str, os_name: str, arch: str, preferred: str = "") -> list[tuple[str, str]]:
    dotted = _asset_name(version, os_name, arch, dotted=True)
    spaced = _asset_name(version, os_name, arch, dotted=False)
    names = []
    for name in (preferred, dotted, spaced):
        if name and name not in names:
            names.append(name)
    urls: list[tuple[str, str]] = []
    for name in names:
        urls.append((name, _download_url(version, name)))
        urls.append((name, f"https://github.com/{REPO}/releases/latest/download/{name}"))
    return urls


def _save_asset(url: str, target: Path) -> None:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": USER_AGENT, "Accept": "application/octet-stream"},
    )
    with urllib.request.urlopen(request, timeout=300) as response, target.open("wb") as handle:
        while True:
            chunk = response.read(1024 * 256)
            if not chunk:
                break
            handle.write(chunk)
    if not target.exists() or target.stat().st_size < 1024:
        raise ValueError("Installer yang diunduh tidak lengkap.")


def download_update(dest: Path | None = None) -> dict:
    info = check_update(force=True)
    if not info["available"]:
        raise ValueError("Sudah versi terbaru.")
    latest = str(info.get("latest") or "")
    os_name, arch = _runtime()
    folder = dest or Path.home() / "Downloads"
    folder.mkdir(parents=True, exist_ok=True)
    last_error: Exception | None = None
    for name, url in _asset_urls(latest, os_name, arch, str(info.get("asset") or "")):
        target = folder / name
        try:
            _save_asset(url, target)
            if sys.platform == "win32":
                os.startfile(target)  # type: ignore[attr-defined]
            elif sys.platform == "darwin":
                subprocess.run(["open", str(target)], check=False)
            else:
                subprocess.run(["xdg-open", str(target)], check=False)
            info["asset"] = name
            info["asset_url"] = url
            info["path"] = str(target)
            info["ok"] = True
            return info
        except Exception as exc:
            last_error = exc
            try:
                target.unlink(missing_ok=True)
            except Exception:
                pass
    if isinstance(last_error, urllib.error.HTTPError) and last_error.code in {403, 429}:
        raise ValueError("GitHub lagi membatasi unduhan rilis. Coba beberapa menit lagi.") from last_error
    raise ValueError("Gagal unduh installer dari rilis GitHub.") from last_error
