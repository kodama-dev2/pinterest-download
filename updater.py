from __future__ import annotations

import json
import os
import platform
import subprocess
import sys
import urllib.request
from pathlib import Path

from version import REPO, app_version, is_newer

GITHUB_API = f"https://api.github.com/repos/{REPO}/releases/latest"
USER_AGENT = "pinterest-download-by-gemadipada"


def _runtime() -> tuple[str, str]:
    system = (os.environ.get("PINTEREST_DL_OS") or sys.platform).lower()
    machine = (os.environ.get("PINTEREST_DL_ARCH") or platform.machine()).lower()
    if system.startswith("win"):
        os_name = "win"
    else:
        os_name = "mac"
    arch = "arm64" if machine in {"arm64", "aarch64"} else "x64"
    return os_name, arch


def _asset_name(os_name: str, arch: str) -> str:
    ext = "zip" if os_name == "win" else "dmg"
    return f"-{os_name}-{arch}.{ext}"


def check_update() -> dict:
    current = app_version()
    request = urllib.request.Request(
        GITHUB_API,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/vnd.github+json",
        },
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        data = json.loads(response.read().decode("utf-8"))
    latest = str(data.get("tag_name") or "").lstrip("v")
    os_name, arch = _runtime()
    needle = _asset_name(os_name, arch)
    asset = None
    for item in data.get("assets") or []:
        name = str(item.get("name") or "")
        if needle in name:
            asset = item
            break
    available = bool(latest and is_newer(latest, current))
    return {
        "current": current,
        "latest": latest or current,
        "available": available,
        "name": data.get("name") or f"v{latest}",
        "url": data.get("html_url") or f"https://github.com/{REPO}/releases/latest",
        "asset": (asset or {}).get("name") or "",
        "asset_url": (asset or {}).get("browser_download_url") or "",
        "os": os_name,
        "arch": arch,
    }


def download_update(dest: Path | None = None) -> dict:
    info = check_update()
    if not info["available"]:
        raise ValueError("Sudah versi terbaru.")
    if not info["asset_url"]:
        raise ValueError("Installer untuk perangkat ini tidak ada di rilis.")
    folder = dest or Path.home() / "Downloads"
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / info["asset"]
    request = urllib.request.Request(
        info["asset_url"],
        headers={"User-Agent": USER_AGENT, "Accept": "application/octet-stream"},
    )
    with urllib.request.urlopen(request, timeout=120) as response, target.open("wb") as handle:
        while True:
            chunk = response.read(1024 * 256)
            if not chunk:
                break
            handle.write(chunk)
    if sys.platform == "win32":
        os.startfile(target)  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.run(["open", str(target)], check=False)
    else:
        subprocess.run(["xdg-open", str(target)], check=False)
    info["path"] = str(target)
    info["ok"] = True
    return info
