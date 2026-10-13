#!/usr/bin/env python3
"""Checks for tools/epl_insights.py on synthetic data (no network)."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import epl_insights as ins  # noqa: E402

BEFORE = "2026-10-18T15:30:00Z"
NAMES = {1: "Арсенал", 2: "Ноттингем", 9: "Прочие"}


def match(mid, date, home, away, home_score, away_score):
    side = lambda cid, score: {"id": cid, "name": f"C{cid}", "abbr": "X", "score": score}
    return {"id": mid, "season": "2025/26", "kickoff_utc": f"{date}T15:00:00Z", "home": side(home, home_score), "away": side(away, away_score), "goals": []}


def market(market_id, family, outcomes, *, period="FT", scope="match", line=None, variant=None, key=None):
    return {"key": key or f"{market_id}:{line or ''}", "market_id": market_id, "family": family, "variant": variant, "period": period,
            "scope": scope, "line": line, "outcomes": [{"index": i, "side": s, "odds": o, "label": s} for i, (s, o) in enumerate(outcomes)]}


def ctx_for(matches, stats=None, players=None):
    return {"by_club": ins.index_matches(matches), "stats": stats or {}, "names": NAMES, "before": BEFORE, "home": 1, "away": 2, "players": players or []}


def head_to_head(arsenal_wins, total):
    """Arsenal (club 1) against club 2: the newest `arsenal_wins` meetings are Arsenal wins, the rest losses."""
    matches = []
    for i in range(total):
        arsenal_won = total - 1 - i < arsenal_wins  # i = 0 is the oldest meeting
        home = 1 if i % 2 == 0 else 2
        score = (2, 0) if (home == 1) == arsenal_won else (0, 2)
        matches.append(match(100 + i, f"{2021 + i // 2}-0{1 + (i % 2) * 5}-15", home, 3 - home, *score))
    return matches


def test_wilson_and_score():
    assert ins.wilson_lower(7, 10) < ins.wilson_lower(70, 100) < 0.7  # a bigger sample earns more trust
    assert ins.wilson_lower(0, 0) == 0.0
    assert ins.editorial_score(0.6, 3.0, 10) > ins.editorial_score(0.6, 1.5, 10)  # same history, bigger price: more to say
    assert ins.editorial_score(0.6, 3.0, 10) > ins.editorial_score(0.6, 3.0, 4)  # smaller sample: less


def test_helpers():
    assert ins.span([match(1, "2021-05-01", 1, 2, 0, 0), match(2, "2026-02-01", 2, 1, 0, 0)]) == "2021–2026"
    assert ins.span([match(1, "2026-05-01", 1, 2, 0, 0)]) == "2026"
    assert ins.goals_phrase(2.5) == "2,5 гола" and ins.goals_phrase(2) == "2 голов"
    assert ins.side_hits([2, 2, 1, 3], 2, "under") == 1 and ins.side_hits([2, 2, 1, 3], 2, "over") == 1  # exact hits are pushes
    assert ins.days_before("2026-10-18T15:30:00Z", 1) == "2026-10-17T15:30:00Z"


def test_h2h_win_rule_and_freshness():
    event = {"markets": [market(490, "match_result", [("home", 2.4), ("draw", 3.4), ("away", 3.0)])]}
    cands = ins.rule_h2h_results(event, ctx_for(head_to_head(8, 10)))
    assert len(cands) == 1
    c = cands[0]
    assert c["rule"] == "h2h_win_rate" and "Арсенал выиграл 8 из последних 10" in c["title"]
    assert (c["market"]["side"], c["market"]["odds"], c["evidence"]["span"]) == ("home", 2.4, "2021–2025")
    mirrored = ins.rule_h2h_results(event, ctx_for(head_to_head(3, 10)))  # Arsenal won 3, so Nottingham won 7
    assert [c["market"]["side"] for c in mirrored] == ["away"] and "Ноттингем выиграл 7 из последних 10" in mirrored[0]["title"]
    assert ins.rule_h2h_results(event, ctx_for(head_to_head(5, 5))) == []  # sample below the minimum
    old = [match(1 + i, f"2010-0{1 + i}-01", 1, 2, 2, 0) for i in range(8)]
    assert ins.rule_h2h_results(event, ctx_for(old)) == []  # the latest meeting is far too old


def test_unbeaten_run_uses_double_chance():
    event = {"markets": [market(114, "double_chance", [("home_draw", 1.4), ("home_away", 1.3), ("draw_away", 2.0)])]}
    run = [c for c in ins.rule_h2h_results(event, ctx_for(head_to_head(8, 10))) if c["rule"] == "h2h_unbeaten_run"]
    assert len(run) == 1 and run[0]["market"]["side"] == "home_draw" and "8 матчей подряд" in run[0]["title"]


def test_totals_ignore_pushes():
    # totals of the ten meetings: six exactly 2, four 1 -> 'under 2' was hit only 4 times (the 2s are refunds)
    pushes = [match(i, f"202{1 + i // 2}-0{1 + i % 2 * 5}-01", 1, 2, 1, 1 if i < 6 else 0) for i in range(10)]
    event = {"markets": [market(1049, "total", [("over", 2.0), ("under", 1.8)], line=2.0)]}
    assert ins.rule_h2h_goals(event, ctx_for(pushes)) == []
    lows = [match(i, f"202{1 + i // 2}-0{1 + i % 2 * 5}-01", 1, 2, 1, 0) for i in range(10)]
    low_event = {"markets": [market(1049, "total", [("over", 2.4), ("under", 1.6)], line=2.5)]}
    found = [c for c in ins.rule_h2h_goals(low_event, ctx_for(lows)) if c["rule"] == "h2h_total"]
    assert len(found) == 1 and found[0]["market"]["side"] == "under" and "забито меньше 2,5 гола" in found[0]["title"]
    assert found[0]["evidence"]["hits"] == 10 and found[0]["evidence"]["sample"] == 10


def test_chance_creation_groups_lines_into_one_card():
    games, stats = [], {}
    for i in range(24):  # club 1 against everyone else: 5 shots in the box
        games.append(match(500 + i, f"2025-{1 + i % 9:02d}-{1 + i:02d}", 1, 9, 1, 1))
        stats[500 + i] = {1: {"shots_inside_box": 5}, 9: {"shots_inside_box": 5}}
    meets = []
    for i in range(5):  # against club 2: 9 shots in the box
        meets.append(match(700 + i, f"2025-1{i % 3}-1{i}", 1, 2, 0, 0))
        stats[700 + i] = {1: {"shots_inside_box": 9}, 2: {"shots_inside_box": 4}}
    event = {"markets": [market(1050, "total", [("over", 2.1), ("under", 1.7)], scope="home", line=1.5, key="a"),
                         market(1050, "total", [("over", 4.0), ("under", 1.2)], scope="home", line=2.5, key="b")]}
    cards = ins.build_match_insights(event, ctx_for(games + meets, stats))
    chance = [c for c in cards if c["rule"] == "chance_creation"]
    assert len(chance) == 1 and len(chance[0]["alternatives"]) == 1 and "создаёт гораздо больше моментов" in chance[0]["title"]
    assert chance[0]["details"]["mean_vs_opponent"] == 9.0 and chance[0]["details"]["mean_vs_others"] == 5.0


def test_player_name_matching():
    players = [{"club": {"id": 1}, "surname_ru": "Доуман", "pl_id": 7}, {"club": {"id": 1}, "surname_ru": "Сака", "pl_id": 8},
               {"club": {"id": 2}, "surname_ru": "Доумен", "pl_id": 9}]
    assert ins.match_player("Макс Доумен", 1, players)["pl_id"] == 7  # Winline spells it its own way; same club only
    assert ins.match_player("Неизвестный Игрок", 1, players) is None


def main() -> None:
    for name, function in sorted(globals().items()):
        if name.startswith("test_") and callable(function):
            function()
            print(f"ok  {name}")


if __name__ == "__main__":
    main()
