from __future__ import annotations

import argparse

import uvicorn

from downloader import download_pinterest


def main() -> None:
    parser = argparse.ArgumentParser(description="Pinterest image downloader")
    parser.add_argument("url", nargs="?", help="URL pin, board, atau profil Pinterest")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--dest", help="Folder tujuan unduhan")
    parser.add_argument("--start", type=int, help="Awal rentang, misalnya 1, 201, atau 1001")
    parser.add_argument("--end", type=int, help="Akhir rentang, misalnya 100, 1000, atau 2000")
    parser.add_argument("--limit", type=int, help="Jumlah pin jika --end tidak diisi")
    args = parser.parse_args()

    if args.url:
        def emit(event: dict) -> None:
            kind = event.get("type")
            if kind == "status":
                print(event["message"])
            elif kind == "file":
                print(f"tersimpan  {event['path']}")
            elif kind == "error":
                print(f"error      {event['message']}")
            elif kind == "done":
                print(f"selesai    {event['count']} image")

        download_pinterest(
            args.url,
            emit,
            dest=args.dest,
            start=args.start,
            end=args.end,
            limit=args.limit,
        )
        return

    uvicorn.run("app:app", host="127.0.0.1", port=args.port, reload=False)


if __name__ == "__main__":
    main()
