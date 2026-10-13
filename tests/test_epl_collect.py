#!/usr/bin/env python3
"""Pure-logic checks for tools/epl_collect.py (synthetic data, no network)."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import epl_collect as epl  # noqa: E402

A = {"id": 1, "name": "Alpha FC", "abbr": "ALP"}
B = {"id": 2, "name": "Beta United", "abbr": "BET"}


def match(match_id, home, away, home_score, away_score, goals=(), kickoff="2024-01-0{}T15:00:00Z"):
    return {
        "id": match_id, "season": "2023/24", "kickoff_utc": kickoff.format(match_id),
        "home": {**home, "score": home_score}, "away": {**away, "score": away_score},
        "ground": "Test Park", "goals": list(goals),
    }


def goal(person, team, kind="G"):
    return {"person_id": person, "assist_id": None, "team_id": team, "minute": "10'", "kind": kind}


def test_short_season():
    assert epl.short_season("English Premier League Season 2026/2027") == "2026/27"
    assert epl.short_season("2025/26") == "2025/26"
    assert epl.short_season("1999/00") == "1999/00"
    assert epl.short_season("") == ""


def test_minute_label():
    assert epl.minute_label("65'00") == "65'"
    assert epl.minute_label("45+2'00") == "45+2'"
    assert epl.minute_label(None) is None


def test_normalize_fixture():
    fixture = {
        "id": 7.0, "kickoff": {"millis": 1_700_000_000_000},
        "gameweek": {"gameweek": 12.0, "compSeason": {"label": "2023/24", "id": 719.0}},
        "teams": [{"team": {"id": 1.0, "name": "Alpha FC", "club": {"abbr": "ALP"}}, "score": 2.0},
                  {"team": {"id": 2.0, "name": "Beta United", "club": {"abbr": "BET"}}, "score": 1.0}],
        "ground": {"name": "Test Park"}, "attendance": 1000.0,
        "goals": [{"personId": 10.0, "assistId": 11.0, "clock": {"label": "45+2'00"}, "type": "G", "description": "P"},
                  {"clock": {"label": "50'00"}, "type": "G"}],
    }
    record = epl.normalize_fixture(fixture)
    assert record["id"] == 7 and record["season"] == "2023/24" and record["gameweek"] == 12
    assert record["kickoff_utc"] == "2023-11-14T22:13:20Z"
    assert record["home"] == {"id": 1, "name": "Alpha FC", "abbr": "ALP", "score": 2}
    assert record["away"]["score"] == 1
    assert record["goals"] == [{"person_id": 10, "assist_id": 11, "team_id": None, "minute": "45+2'", "kind": "P"}]
    unfinished = {**fixture, "teams": [{**fixture["teams"][0], "score": None}, fixture["teams"][1]]}
    assert epl.normalize_fixture(unfinished) is None


def test_slim_detail():
    detail = {
        "events": [
            {"type": "G", "personId": 10, "teamId": 1, "assistId": 11, "clock": {"label": "65'00"}, "description": "G"},
            {"type": "B", "personId": 12, "teamId": 2, "clock": {"label": "8'00"}, "description": "Y"},
            {"type": "S", "personId": 13, "teamId": 2, "clock": {"label": "56'00"}, "description": "ON"},
            {"type": "P", "personId": 14, "teamId": 1, "clock": {"label": "80'00"}, "description": "P"},
            {"type": "O", "personId": 15, "teamId": 1, "clock": {"label": "90+1'00"}, "description": "O"},
            {"type": "PS", "clock": {"label": "0'00"}},
        ],
        "teamLists": [{"teamId": 1, "formation": {"label": "4-2-3-1"}, "lineup": [{"id": 20}], "substitutes": [{"id": 21}]}],
        "matchOfficials": [{"role": "MAIN", "name": {"display": "A. Referee"}}, {"role": "VAR", "name": {"display": "B. Other"}}],
        "halfTimeScore": {"homeScore": 0, "awayScore": 1},
    }
    slim = epl.slim_detail(detail)
    assert slim["goals"] == [
        {"person_id": 10, "team_id": 1, "minute": "65'", "kind": "G", "assist_id": 11},
        {"person_id": 14, "team_id": 1, "minute": "80'", "kind": "P", "assist_id": None},
        {"person_id": 15, "team_id": 1, "minute": "90+1'", "kind": "O", "assist_id": None},  # team 1 is credited
    ]
    assert slim["cards"][0]["kind"] == "Y" and slim["substitutions"][0]["kind"] == "ON"
    assert slim["lineups"]["1"] == {"formation": "4-2-3-1", "starters": [20], "substitutes": [21]}
    assert slim["referee"] == "A. Referee" and slim["half_time"] == [0, 1]


def test_summarize_pair():
    matches = [
        match(1, A, B, 2, 1, [goal(10, 1), goal(10, 1), goal(20, 2)]),
        match(2, B, A, 0, 0),
        match(3, A, B, 1, 3, [goal(10, 1), goal(20, 2), goal(20, 2), goal(30, 1, "O"), goal(40, 2)]),
    ]
    summary = epl.summarize_pair(A, B, matches, {10: "Ten", 20: "Twenty"})
    assert (summary["played"], summary["a_wins"], summary["b_wins"], summary["draws"]) == (3, 1, 1, 1)
    assert (summary["a_goals"], summary["b_goals"]) == (3, 4)
    assert summary["a_hosting"] == {"played": 2, "w": 1, "d": 0, "l": 1, "gf": 3, "ga": 4}
    assert summary["b_hosting"] == {"played": 1, "w": 0, "d": 1, "l": 0, "gf": 0, "ga": 0}
    assert summary["form_a_last10_latest_first"] == "LDW"
    assert summary["unbeaten_run"] == {"a": 0, "b": 2}
    assert summary["biggest_win_a"]["margin"] == 1 and summary["biggest_win_b"]["margin"] == 2
    assert summary["last_meeting"]["score"] == "1-3" and summary["first_meeting"]["date"] == "2024-01-01"
    scorers = {(s["person_id"], s["team_id"]): s["goals"] for s in summary["top_scorers"]}
    assert scorers[(10, 1)] == 3 and scorers[(20, 2)] == 3 and (30, 1) not in scorers  # own goal is not a scorer
    assert summary["top_scorers"][0]["name"] in {"Ten", "Twenty"}
    assert summary["matches"] == [1, 2, 3]
    empty = epl.summarize_pair(A, B, [], {})
    assert empty["played"] == 0 and empty["last_meeting"] is None and empty["form_a_last10_latest_first"] == ""


def main() -> None:
    for name, function in sorted(globals().items()):
        if name.startswith("test_") and callable(function):
            function()
            print(f"ok  {name}")


if __name__ == "__main__":
    main()
