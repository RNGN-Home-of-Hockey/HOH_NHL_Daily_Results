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


def test_live_lines_are_read_only_while_the_match_is_played():
    # 2026-10-17: Эвертон—Челси was over ~2 h after the kickoff; reading its page in the third hour failed every time
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "snapshots").mkdir()
        line = {"events": [{"event_id": 1, "starts_at": "2026-10-17T11:30:00.999Z", "markets": []},
                           {"event_id": 2, "starts_at": "2026-10-17T14:00:00.999Z", "markets": []}]}
        at = lambda h, m: datetime(2026, 10, 17, h, m, tzinfo=timezone.utc)  # noqa: E731
        assert site.started_ids(root, line, at(13, 27)) == [1]          # 117 minutes in: still played
        assert site.started_ids(root, line, at(13, 50)) == []           # 140 minutes: over (it stays on the site)
        assert site.started_ids(root, line, at(14, 5)) == [2]           # the next one kicked off
        assert site.started_ids(root, line, at(11, 0)) == []            # nothing kicked off yet


def test_standard_live_plates_while_the_match_is_played():
    # 2026-10-17: in the second half the commentators had no plate at all — not even the win, the draw, the total
    ctx = {"names": {1: "Брентфорд", 2: "Ливерпуль"}, "home": 1, "away": 2}

    def market(market_id, family, key, outcomes, line=None, variant=None):
        return {"market_id": market_id, "family": family, "period": "FT", "scope": "match", "key": key, "line": line, "variant": variant,
                "outcomes": [{"index": i, "side": side, "odds": odds} for i, (side, odds) in enumerate(outcomes)]}
    live = {"markets": [market(490, "match_result", "490", [("home", 1.67), ("draw", 3.75), ("away", 5.5)]),
                        market(1234, "match_result", "1234:80", [("home", 1.2), ("draw", 4.0), ("away", 9.0)]),  # «result at minute 80»
                        market(114, "double_chance", "114", [("home_draw", 1.1), ("draw_away", 2.2)]),
                        market(1049, "total", "1049:2.5", [("over", 1.65), ("under", 2.25)], line=2.5),
                        market(1049, "total", "1049:3.5", [("over", 3.4), ("under", 1.3)], line=3.5)]}
    cards = site.live_cards(live, ctx, covered={"490#2"})  # the away win is on a pre-match plate already
    bets = sorted((c["market"]["key"], c["market"]["odds"]) for c in cards)
    assert bets == [("1049:2.5#0", 1.65), ("1049:2.5#1", 2.25), ("114#1", 2.2), ("490#0", 1.67), ("490#1", 3.75)]
    assert all(c["rule"] == "live_line" and c["market"]["live"] == "open" and c["plate"]["bet"] for c in cards)


def test_a_match_missing_from_one_live_capture_keeps_its_prices():
    # 2026-10-17: Ман Сити—Ипсвич did not open once (timeout) and lost every live plate until the next capture
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        live = lambda at, ids: {"captured_at": at, "events": [{"event_id": i, "markets": [{"key": "490"}]} for i in ids]}  # noqa: E731
        for name, at, ids in (("2026-10-17T15-30-00-000Z", "2026-10-17T15:30:00.000Z", [1, 2, 3]),
                              ("2026-10-17T15-36-00-000Z", "2026-10-17T15:36:00.000Z", [1, 2]),
                              ("2026-10-17T15-38-00-000Z", "2026-10-17T15:38:00.000Z", [1])):
            (root / "snapshots" / name).mkdir(parents=True)
            (root / "snapshots" / name / "index.json.gz").write_bytes(gzip.compress(json.dumps(live(at, ids)).encode("utf-8")))
        (root / "latest.json").write_text(json.dumps(live("2026-10-17T15:38:00.000Z", [1])), encoding="utf-8")
        at, events = site.load_live(root, datetime(2026, 10, 17, 15, 39, tzinfo=timezone.utc))
        assert at == "2026-10-17T15:38:00.000Z"
        assert {i: e["live_captured_at"][11:16] for i, e in events.items()} == {1: "15:38", 2: "15:36"}  # 3 is too old


def main() -> None:
    for name, function in sorted(globals().items()):
        if name.startswith("test_") and callable(function):
            function()
            print(f"ok  {name}")


if __name__ == "__main__":
    main()
