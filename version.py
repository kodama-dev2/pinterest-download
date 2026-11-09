from __future__ import annotations

import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = "kodama-dev2/pinterest-download"


def app_version() -> str:
    env = (os.environ.get("PINTEREST_DL_VERSION") or "").strip()
    if env:
        return env.lstrip("v")
    pkg = ROOT / "package.json"
    if pkg.exists():
        try:
            return str(json.loads(pkg.read_text()).get("version") or "1.0.5")
        except Exception:
            pass
    return "1.0.5"


def _parse(raw: str) -> tuple[int, ...]:
    parts = []
    for chunk in raw.lstrip("v").split("."):
        digits = "".join(ch for ch in chunk if ch.isdigit())
        parts.append(int(digits or 0))
    return tuple(parts or (0,))


def is_newer(latest: str, current: str) -> bool:
    return _parse(latest) > _parse(current)
