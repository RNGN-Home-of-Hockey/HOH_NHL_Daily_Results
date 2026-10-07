#!/usr/bin/env python3
"""Production wrapper for legacy official NBA backfill with same-feed URL fallback.

Some GitHub runners intermittently receive a 403 from data.nba.com on the historical
`/data/10s/v2015/` alias for an individual file. The equivalent `/data/v2015/`
resource is tried before a game is declared failed. Integrity remains strict: if
both URLs fail, the season fails exactly as before.
"""
from __future__ import annotations

import backfill_nba_cdn as importer

_original_fetch_json = importer.fetch_json


def resilient_fetch_json(url: str, timeout: int, attempts: int):
    try:
        return _original_fetch_json(url, timeout, attempts)
    except Exception as primary:
        marker = "/data/10s/v2015/"
        if marker not in url:
            raise
        alternate = url.replace(marker, "/data/v2015/", 1)
        try:
            return _original_fetch_json(alternate, timeout, attempts)
        except Exception as secondary:
            raise RuntimeError(
                f"both official NBA feed aliases failed; primary={primary}; alternate={secondary}"
            ) from secondary


importer.fetch_json = resilient_fetch_json


if __name__ == "__main__":
    raise SystemExit(importer.main())
