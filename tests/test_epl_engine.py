#!/usr/bin/env python3
"""Checks for tools/epl_engine.py on synthetic data (no network)."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import epl_engine as eng  # noqa: E402
import epl_insights as ins  # noqa: E402

BEFORE = "2026-10-18T15:30:00Z"
NAMES = {1: "Арсенал", 2: "Ноттингем", 9: "Прочие"}


def match(mid, date, home, away, home_score, away_score, goals=None):
    side = lambda cid, score: {"id": cid, "name": f"C{cid}", "abbr": "X", "score": score}
    return {"id": mid, "season": "2026/27", "kickoff_utc": f"{date}T15:00:00Z", "home": side(home, home_score), "away": side(away, away_score),
            "goals": goals or []}


def goal(team, minute, person=0, kind="G"):
    return {"person_id": person, "team_id": team, "minute": minute, "kind": kind}


def market(market_id, family, outcomes, *, period="FT", scope="match", line=None, variant=None, key=None, template="", param=None):
    return {"key": key or f"{market_id}:{scope}:{line or ''}", "market_id": market_id, "family": family, "variant": variant, "period": period,
            "scope": scope, "line": line, "template": template, "param": param,
            "outcomes": [{"index": i, "side": s, "odds": o, "label": label} for i, (s, o, label) in enumerate(outcomes)]}


def ctx_for(matches, players=None, apps=None):
    return {"by_club": ins.index_matches(matches), "stats": {}, "names": NAMES, "before": BEFORE, "home": 1, "away": 2,
            "players": players or [], "rows": eng.club_rows(matches, {}), "apps": apps or {}}


def season_of(club, results):
    """`results` = (goals for, goals against) of club's home matches against club 9, oldest first, four days apart."""
    out = []
    for i, (gf, ga) in enumerate(results):
        day = f"2026-{8 + i // 7:02d}-{1 + (i % 7) * 4:02d}"
        out.append(match(club * 1000 + i, day, club, 9, gf, ga))
    return out


def test_grade_and_minutes():
    assert eng.grade(82)[0] == "fire" and eng.grade(65)[0] == "strong" and eng.grade(50)[0] == "solid" and eng.grade(35)[0] == "background"
    assert eng.grade(20)[0] == "none"
    assert eng.half_of("45+2'") == 1 and eng.half_of("46'") == 2 and eng.half_of(None) is None
    assert eng.minute_of("90+4'") == 90


def test_club_rows_halves_and_order():
    m = match(1, "2026-09-01", 1, 2, 2, 1, goals=[goal(2, "12'"), goal(1, "45+2'"), goal(1, "78'")])
    rows = eng.club_rows([m], {})
    home, away = rows[1][0], rows[2][0]
    assert home["ht"] == (1, 1) and home["h2"] == (1, 0) and home["first"] == "against" and home["last"] == "for"
    assert away["ht"] == (1, 1) and away["h2"] == (0, 1) and away["first"] == "for" and away["first_min"] == 12
    unknown = match(2, "2026-09-08", 1, 2, 1, 0, goals=[{"person_id": 0, "team_id": None, "minute": "10'", "kind": "G"}])
    assert eng.club_rows([unknown], {})[1][0]["ht"] is None  # a goal without a side: halves stay unknown
    goalless = eng.club_rows([match(3, "2026-09-15", 1, 2, 0, 0)], {})[1][0]
    assert goalless["first"] == "none" and goalless["ht"] == (0, 0)


def test_top_tiers_need_four_hits():
    card = {"rule": "team_goals_bucket", "score": 72, "evidence": {"sample": 6, "hits": 3, "rate": 0.5, "implied_by_price": 0.16},
            "market": {"odds": 6.2}}
    assert eng.finish(card)["tier"] == "solid"
    perfect = {"rule": "player_vs_opponent", "score": 77, "evidence": {"sample": 4, "hits": 4, "rate": 1.0, "implied_by_price": 0.38},
               "market": {"odds": 2.65}}
    assert eng.finish(perfect)["tier"] == "strong"  # "4 из 4" is a headline


def test_handicap_takes_the_boldest_covered_line():
    games = season_of(1, [(2, 0), (3, 1), (2, 0), (1, 0), (3, 0), (2, 1), (4, 1), (2, 0)])  # always won, mostly by 2+
    games += season_of(2, [(1, 1)] * 8)
    cheap = market(400, "handicap", [("home", 1.1, "1"), ("away", 6.0, "2")], key="h1")
    bold = market(400, "handicap", [("home", 1.9, "1"), ("away", 1.9, "2")], key="h2")
    cheap["outcomes"][0]["line"], cheap["outcomes"][1]["line"] = 0.5, -0.5
    bold["outcomes"][0]["line"], bold["outcomes"][1]["line"] = -1.5, 1.5
    cards = eng.rule_handicap_margin({"markets": [cheap, bold]}, ctx_for(games))
    arsenal = [c for c in cards if c["market"]["label"].startswith("Арсенал")]
    assert len(arsenal) == 1 and arsenal[0]["market"]["line"] == -1.5  # +0.5 at 1.10 is too cheap to talk about
    assert "6 из 8" in arsenal[0]["title"]


def test_clean_sheet_and_total_rules():
    games = season_of(1, [(1, 0), (2, 0), (0, 0), (1, 0), (3, 1), (1, 0), (2, 0), (0, 1)])
    games += season_of(2, [(0, 0), (1, 0), (0, 1), (1, 1), (0, 0), (1, 0), (0, 0), (2, 0)])
    event = {"markets": [market(700, "clean_sheet", [("yes", 2.2, "Да"), ("no", 1.6, "Нет")], scope="home"),
                         market(100, "total", [("over", 1.7, "Б"), ("under", 2.1, "М")], line=2.5)]}
    ctx = ctx_for(games)
    clean = eng.rule_clean_sheet(event, ctx)
    assert len(clean) == 1 and "не пропускал в 6 из 8" in clean[0]["title"] and clean[0]["market"]["odds"] == 2.2
    totals = eng.rule_match_total_form(event, ctx)
    assert len(totals) == 1 and totals[0]["market"]["side"] == "under" and "15 из 16" in totals[0]["title"]


def test_scores_first_reads_the_goal_order():
    games = []
    for i in range(8):
        day = f"2026-09-{1 + i * 3:02d}"
        games.append(match(10 + i, day, 1, 9, 1, 0 if i < 6 else 2,
                           goals=[goal(1, "10'")] + ([goal(9, "50'"), goal(9, "60'")] if i >= 6 else [])))
        games.append(match(30 + i, day, 2, 9, 0, 1, goals=[goal(9, "30'")]))
    event = {"markets": [market(600, "goal_sequence", [("home", 1.8, "1"), ("draw", 9.0, "Нет"), ("away", 2.4, "2")], variant="next", param="1")]}
    cards = eng.rule_scores_first(event, ctx_for(games))
    assert len(cards) == 1 and "Арсенал открывал счёт в 8 из 8" in cards[0]["title"] and cards[0]["market"]["odds"] == 1.8


def test_scoring_probability_blends_a_prior():
    def player(position, xg, minutes, past=None):
        return {"position": position, "season_2026_27": {"minutes": minutes, "expected_goals": xg},
                "season_2026_27_by_gameweek": [{"minutes": 90}] * 5, "past_seasons": past or []}
    lucky_defender = eng.scoring_probability(player("D", 1.5, 450))  # 0.3 xG per 90 after five games
    assert lucky_defender[3] < 0.15 and lucky_defender[0] < 0.15  # pulled back towards a defender's usual level
    striker = eng.scoring_probability(player("F", 3.0, 540, past=[{"minutes": 2700, "expected_goals": 15.0}]))
    assert abs(striker[3] - 0.5) < 1e-9 and striker[1] == 90 and striker[2] == 5
    assert eng.scoring_probability(player("G", 0.0, 900)) is None
    assert eng.scoring_probability(player("F", 1.0, 200)) is None


def test_xg_value_skips_longshots():
    def priced(odds):
        return {"markets": [{"key": "p", "market_id": 900, "family": "player_goal", "variant": "anytime", "period": "FT", "scope": "match",
                             "line": None, "subject": {"name": "Букайо Сака", "team": "home"},
                             "outcomes": [{"index": 0, "side": "yes", "odds": odds, "label": "Да"}]}]}
    saka = {"pl_id": 8, "club": {"id": 1}, "surname_ru": "Сака", "position": "F",
            "season_2026_27": {"minutes": 720, "expected_goals": 4.0}, "season_2026_27_by_gameweek": [{"minutes": 90}] * 8,
            "past_seasons": [{"minutes": 2700, "expected_goals": 15.0}]}
    assert len(eng.rule_player_xg_value(priced(3.0), ctx_for([], players=[saka]))) == 1  # ~39% against 33%
    assert eng.rule_player_xg_value(priced(1.9), ctx_for([], players=[saka])) == []  # priced fairly
    defender = dict(saka, position="D", season_2026_27={"minutes": 720, "expected_goals": 0.6}, past_seasons=[])
    assert eng.rule_player_xg_value(priced(15.0), ctx_for([], players=[defender])) == []  # long odds, small chance: noise


def test_appearances_skip_own_goals():
    m = match(1, "2026-09-01", 1, 2, 2, 1)
    details = {1: {"lineups": {"1": {"starters": [11, 12], "substitutes": [13, 14]}, "2": {"starters": [21], "substitutes": []}},
                   "substitutions": [{"person_id": 13, "kind": "ON"}],
                   "goals": [goal(1, "5'", person=21, kind="O"), goal(1, "40'", person=11), goal(2, "88'", person=21)]}}
    apps = eng.appearances(details, {1: m})
    assert set(apps) == {11, 12, 13, 21}  # 14 stayed on the bench
    assert apps[11][0]["goals"] == 1 and not apps[11][0]["first"]
    assert apps[21][0]["goals"] == 1 and apps[21][0]["last"] and not apps[21][0]["first"]  # the own goal is not his first goal
    assert apps[21][0]["opp"] == 1


def test_build_cards_groups_and_limits():
    games = season_of(1, [(1, 0)] * 8) + season_of(2, [(0, 0)] * 8)
    lines = [market(100, "total", [("over", o, "Б"), ("under", u, "М")], line=line, key=f"t{line}")
             for line, o, u in ((1.5, 2.6, 1.5), (2.5, 4.5, 1.2), (3.5, 8.0, 1.05))]
    cards = eng.build_cards({"markets": lines}, ctx_for(games))
    assert any(c["rule"] == "match_total_form" for c in cards)
    assert sum(1 for c in cards if c["rule"] == "match_total_form") <= eng.PER_RULE_LIMIT
    assert all(c["category"] and c["basis"] and c["reasons"] and c["tier"] for c in cards)
    assert cards == sorted(cards, key=lambda c: (-c["score"], -c["evidence"]["sample"]))


def test_news_in_russian():
    assert eng.news_ru("Knee injury - Unknown return date") == "Травма колена — срок возвращения неизвестен"
    assert eng.news_ru("Hamstring injury - Expected back 25 Oct") == "Травма задней поверхности бедра — ожидается к 25 октября"
    assert eng.news_ru("Unspecified injury - 75% chance of playing") == "Травма — шанс сыграть 75%"
    assert eng.news_ru("Suspended until 2 Nov") == "Дисквалификация до 2 ноября"
    assert eng.news_ru("Something new") == "Something new" and eng.news_ru(None) is None


def test_injured_players_get_no_cards():
    def priced(odds):
        return {"markets": [{"key": "p", "market_id": 900, "family": "player_goal", "variant": "anytime", "period": "FT", "scope": "match",
                             "line": None, "subject": {"name": "Букайо Сака", "team": "home"},
                             "outcomes": [{"index": 0, "side": "yes", "odds": odds, "label": "Да"}]}]}
    saka = {"pl_id": 8, "club": {"id": 1}, "surname_ru": "Сака", "position": "F",
            "season_2026_27": {"minutes": 720, "expected_goals": 4.0, "status": "a", "chance_of_playing_next_round": None},
            "season_2026_27_by_gameweek": [{"minutes": 90}] * 8, "past_seasons": [{"minutes": 2700, "expected_goals": 15.0}]}
    fit = eng.build_cards(priced(3.0), ctx_for([], players=[saka]))
    injured = dict(saka, season_2026_27={**saka["season_2026_27"], "status": "i", "chance_of_playing_next_round": 0})
    doubt = dict(saka, season_2026_27={**saka["season_2026_27"], "status": "d", "chance_of_playing_next_round": 75})
    assert len(fit) == 1 and eng.build_cards(priced(3.0), ctx_for([], players=[injured])) == []
    doubtful = eng.build_cards(priced(3.0), ctx_for([], players=[doubt]))
    assert doubtful[0]["score"] == fit[0]["score"] - eng.DOUBT_PENALTY and "под вопросом" in doubtful[0]["tags"]


def test_no_cards_below_min_odds():
    games = season_of(1, [(1, 0)] * 8) + season_of(2, [(0, 0)] * 8)  # 16 of 16 matches under 1.5 and under 2.5
    lines = [market(100, "total", [("over", 4.0, "Б"), ("under", 1.25, "М")], line=2.5, key="t2.5"),
             market(100, "total", [("over", 2.6, "Б"), ("under", 1.55, "М")], line=1.5, key="t1.5")]
    cards = eng.build_cards({"markets": lines}, ctx_for(games))
    totals = [c for c in cards if c["rule"] == "match_total_form"]
    assert totals and all(c["market"]["odds"] >= eng.MIN_ODDS for c in cards)
    assert totals[0]["market"]["line"] == 1.5 and not any(a["odds"] < eng.MIN_ODDS for c in cards for a in c["alternatives"])


def main() -> None:
    for name, function in sorted(globals().items()):
        if name.startswith("test_") and callable(function):
            function()
            print(f"ok  {name}")


if __name__ == "__main__":
    main()
