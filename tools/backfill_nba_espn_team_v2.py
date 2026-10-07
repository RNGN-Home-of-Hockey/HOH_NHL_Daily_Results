#!/usr/bin/env python3
"""Production wrapper for complete ESPN-team-schedule NBA backfill.

The wrapper makes official game-ID matching deterministic and supplies canonical
NBA player IDs for late 2025-26 roster additions absent from the frozen 2025
legacy player directory. IDs are NBA/G-League identity IDs, not ESPN IDs.
"""
from __future__ import annotations

from datetime import timedelta

import backfill_nba_espn_team as importer

# Players added after the legacy 2025 data.nba.com directory stopped refreshing.
# These are canonical NBA/G-League player identity IDs.
importer.PLAYER_ID_OVERRIDES.update({
    "acebailey": 1642846,
    "leakyblack": 1641778,
    "omeryurtseven": 1630209,
    "adamabal": 1642380,
    "alondeswilliams": 1631214,
    "skallabissiere": 1627746,
    "julianreese": 1642882,
    "anderssongarcia": 1643158,
    "joshoduro": 1642490,
    "kadaryrichmond": 1642955,
    "dariusbrownii": 1642468,
    "bezmbeng": 1643016,
})


def deterministic_local_event_date(event, _official_by_pair=None):
    dt = importer.event_utc_date(event)
    if dt is None:
        raise ValueError(f"event {event.get('id')} missing date")
    return (dt - timedelta(hours=6)).date()


importer.local_event_date = deterministic_local_event_date


if __name__ == "__main__":
    importer.main()
