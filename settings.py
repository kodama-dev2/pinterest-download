from __future__ import annotations

import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent
HOME = Path(os.environ.get("PINTEREST_DL_HOME", ROOT))
DOWNLOADS = HOME / "downloads"
SETTINGS_PATH = HOME / "settings.json"
PRESET_RANGES = ((1, 100), (101, 200), (201, 300), (301, 400), (401, 500))
ALLOWED_STARTS = tuple(start for start, _end in PRESET_RANGES)
RANGE_SIZE = 100
DEFAULT_START = 1
DEFAULT_END = 100
DEFAULT_LIMIT = RANGE_SIZE
MAX_RANGE_SIZE = 2000
MAX_START = 100_000


def default_settings() -> dict:
    return {
        "dest": str(DOWNLOADS),
        "start": DEFAULT_START,
        "end": DEFAULT_END,
        "limit": DEFAULT_LIMIT,
    }


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


def _int_value(raw, name: str) -> int:
    try:
        return int(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} harus angka") from exc


def normalize_range(start=None, end=None, limit=None) -> dict:
    begin = _int_value(start if start is not None else DEFAULT_START, "Awal rentang")
    if begin < 1 or begin > MAX_START:
        raise ValueError(f"Awal rentang harus 1 sampai {MAX_START}")

    finish = None
    if end is not None and str(end).strip() != "":
        finish = _int_value(end, "Akhir rentang")
    elif limit is not None and str(limit).strip() != "":
        size = _int_value(limit, "Jumlah rentang")
        if size < 1:
            raise ValueError("Jumlah rentang minimal 1")
        finish = begin + size - 1
    else:
        preset = next((item[1] for item in PRESET_RANGES if item[0] == begin), None)
        finish = preset if preset is not None else begin + RANGE_SIZE - 1

    if finish < begin:
        raise ValueError("Akhir rentang harus lebih besar atau sama dengan awal")
    size = finish - begin + 1
    if size > MAX_RANGE_SIZE:
        raise ValueError(
            f"Satu rentang maksimal {MAX_RANGE_SIZE} pin. Pecah jadi 1–1000, lalu 1001–2000"
        )
    if finish > MAX_START + MAX_RANGE_SIZE - 1:
        raise ValueError("Akhir rentang terlalu besar")
    return {
        "start": begin,
        "end": finish,
        "limit": size,
        "label": f"{begin}–{finish}",
    }


def normalize_start(raw) -> int:
    return normalize_range(start=raw)["start"]


def normalize_limit(raw) -> int:
    if raw is None:
        return RANGE_SIZE
    return normalize_range(start=DEFAULT_START, limit=raw)["limit"]


def range_label(start: int, end=None, limit=None) -> str:
    return normalize_range(start=start, end=end, limit=limit)["label"]


def load_settings() -> dict:
    data = default_settings()
    has_end = False
    if SETTINGS_PATH.exists():
        try:
            stored = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
            if isinstance(stored, dict):
                has_end = "end" in stored
                data.update(stored)
        except (OSError, json.JSONDecodeError):
            pass
    dest = normalize_dest(data.get("dest"))
    parsed = normalize_range(
        data.get("start"),
        data.get("end") if has_end else None,
        data.get("limit"),
    )
    return {
        "dest": str(dest),
        "start": parsed["start"],
        "end": parsed["end"],
        "limit": parsed["limit"],
        "label": parsed["label"],
    }


def save_settings(dest: str | None = None, start=None, end=None, limit=None) -> dict:
    current = load_settings()
    if dest is not None:
        current["dest"] = str(normalize_dest(dest))
    parsed = normalize_range(
        start if start is not None else current["start"],
        end if end is not None else (None if start is not None else current["end"]),
        limit if limit is not None else None,
    )
    current.update(parsed)
    SETTINGS_PATH.write_text(
        json.dumps(
            {
                "dest": current["dest"],
                "start": current["start"],
                "end": current["end"],
                "limit": current["limit"],
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    return current
