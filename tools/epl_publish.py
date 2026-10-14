#!/usr/bin/env python3
"""Send the operator site data (site.json) to the hoh-epl worker, which keeps it in KV.

  python -I tools/epl_publish.py [--site PATH] [--url https://hoh-epl.rngn.workers.dev] [--key-file PATH]

The key is the worker secret EPL_INGEST_KEY, read from a file (default ~/.hoh-epl/ingest.key, or
EPL_INGEST_KEY_FILE); it is never printed. The body is gzip-compressed (header x-epl-encoding: gzip).
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import epl_collect as epl  # noqa: E402

DEFAULT_URL = "https://hoh-epl.rngn.workers.dev"
DEFAULT_KEY = Path.home() / ".hoh-epl" / "ingest.key"


def publish(site: Path, url: str, key: str, timeout: float = 60.0) -> dict:
    body = gzip.compress(site.read_bytes(), compresslevel=6)
    request = urllib.request.Request(
        url.rstrip("/") + "/api/ingest", data=body, method="POST",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json", "x-epl-encoding": "gzip",
                 "User-Agent": "hoh-epl-publisher/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:300]
        raise RuntimeError(f"ingest answered HTTP {error.code}: {detail}") from None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--site", default=str(epl.OUT / "site" / "site.json"))
    parser.add_argument("--url", default=os.environ.get("EPL_SITE_URL", DEFAULT_URL))
    parser.add_argument("--key-file", default=os.environ.get("EPL_INGEST_KEY_FILE", str(DEFAULT_KEY)))
    args = parser.parse_args(argv)
    key = Path(args.key_file).read_text(encoding="ascii").strip()
    if not key:
        raise SystemExit(f"empty key file {args.key_file}")
    result = publish(Path(args.site), args.url, key)
    print(f"published: {result.get('matches')} matches, {result.get('cards')} cards, {result.get('bytes')} bytes, "
          f"lines {result.get('winline_captured_at')} -> {args.url}")
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
