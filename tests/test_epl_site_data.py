#!/usr/bin/env python3
"""Checks for the odds movement in tools/epl_site_data.py (temporary snapshot folders, no network)."""
from datetime import datetime, timezone
import gzip
import json
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import epl_site_data as site  # noqa: E402


def snapshot(root: Path, name: str, odds: float) -> None:
    folder = root / "snapshots" / name
    folder.mkdir(parents=True)
    payload = {"captured_at": name, "events": [{"event_id": 7, "markets": [{"key": "1049:2.5", "outcomes": [{"index": 0, "odds": odds}]}]}]}
    (folder / "index.json.gz").write_bytes(gzip.compress(json.dumps(payload).encode("utf-8")))


def test_reference_is_about_a_day_old():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        snapshot(root, "2026-10-13T08-00-00-000Z", 2.4)
        snapshot(root, "2026-10-14T06-00-00-000Z", 2.2)
        snapshot(root, "2026-10-15T07-00-00-000Z", 1.9)
        since, prices = site.reference_prices(root, datetime(2026, 10, 15, 7, 10, tzinfo=timezone.utc))
        assert since == "2026-10-14T06-00-00-000Z" and prices[(7, "1049:2.5", 0)] == 2.2
        since, _ = site.reference_prices(root, datetime(2026, 10, 13, 20, 0, tzinfo=timezone.utc))
        assert since == "2026-10-13T08-00-00-000Z"  # no snapshot a day old yet: the oldest kept one


def test_moves_are_marked_on_cards():
    cards = [{"market": {"key": "1049:2.5#0", "odds": 1.9}}, {"market": {"key": "1049:3.5#1", "odds": 3.0}}]
    site.mark_moves(cards, [], {"event_id": 7, "markets": []}, {(7, "1049:2.5", 0): 2.2})
    assert cards[0]["market"]["was"] == 2.2 and "was" not in cards[1]["market"]


def main() -> None:
    for name, function in sorted(globals().items()):
        if name.startswith("test_") and callable(function):
            function()
            print(f"ok  {name}")


if __name__ == "__main__":
    main()
