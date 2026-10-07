#!/usr/bin/env python3
"""Production wrapper for complete ESPN-team-schedule NBA backfill.

The underlying importer previously used a +/- 1 day fuzzy official-schedule match.
That can map two games between the same teams to one NBA game_id. NBA games start
before 06:00 UTC only after their US-local calendar date, so UTC-6 deterministically
recovers the schedule date for all NBA arenas. The base parser then uses an official
NBA game_id only on an exact (date, home, away) key match; otherwise it keeps a
stable ESPN event key.
"""
from __future__ import annotations

from datetime import timedelta

import backfill_nba_espn_team as importer


def deterministic_local_event_date(event, _official_by_pair=None):
    dt = importer.event_utc_date(event)
    if dt is None:
        raise ValueError(f"event {event.get('id')} missing date")
    return (dt - timedelta(hours=6)).date()


importer.local_event_date = deterministic_local_event_date


if __name__ == "__main__":
    importer.main()
