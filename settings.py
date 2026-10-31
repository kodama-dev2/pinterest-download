from __future__ import annotations

import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent
HOME = Path(os.environ.get("PINTEREST_DL_HOME", ROOT))
DOWNLOADS = HOME / "downloads"
SETTINGS_PATH = HOME / "settings.json"
ALLOWED_LIMITS = (25, 50, 100, 200)
DEFAULT_LIMIT = 50


def default_settings() -> dict:
    return {"dest": str(DOWNLOADS), "limit": DEFAULT_LIMIT}


def normalize_dest(raw: str | None) -> Path:
    if not raw or not str(raw).strip():
        dest = DOWNLOADS
    else:
        dest = Path(str(raw).strip()).expanduser()
        dest = dest.resolve() if dest.is_absolute() else (ROOT / dest).resolve()
    dest.mkdir(parents=True, exist_ok=True)
    if not dest.is_dir():
        raise ValueError("Folder unduhan tidak valid")
    return dest


def normalize_limit(raw) -> int:
    try:
        limit = int(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError("Jumlah foto harus 25, 50, 100, atau 200") from exc
    if limit not in ALLOWED_LIMITS:
        raise ValueError("Jumlah foto harus 25, 50, 100, atau 200")
    return limit


def load_settings() -> dict:
    data = default_settings()
    if SETTINGS_PATH.exists():
        try:
            stored = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
            if isinstance(stored, dict):
                data.update(stored)
        except (OSError, json.JSONDecodeError):
            pass
    dest = normalize_dest(data.get("dest"))
    limit = normalize_limit(data.get("limit") or DEFAULT_LIMIT)
    return {"dest": str(dest), "limit": limit}


def save_settings(dest: str | None = None, limit=None) -> dict:
    current = load_settings()
    if dest is not None:
        current["dest"] = str(normalize_dest(dest))
    if limit is not None:
        current["limit"] = normalize_limit(limit)
    SETTINGS_PATH.write_text(json.dumps(current, indent=2), encoding="utf-8")
    return current
