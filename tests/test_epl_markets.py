#!/usr/bin/env python3
"""Checks for tools/epl_markets.py (market-driven rules) on synthetic data (no network)."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import epl_engine as eng  # noqa: E402
import epl_insights as ins  # noqa: E402
import epl_markets as mk  # noqa: E402

BEFORE = "2026-10-18T15:30:00Z"
NAMES = {1: "Арсенал", 2: "Ноттингем", 9: "Прочие"}
EVENT_NAMES = {"home": "Арсенал", "away": "Ноттингем Форест"}


def match(mid, date, home, away, hs, as_, goals=None):
    side = lambda cid, score: {"id": cid, "name": f"C{cid}", "abbr": "X", "score": score}
    return {"id": mid, "season": "2026/27", "kickoff_utc": f"{date}T15:00:00Z", "home": side(home, hs), "away": side(away, as_), "goals": goals or []}


def goal(team, minute):
    return {"person_id": 0, "team_id": team, "minute": minute, "kind": "G"}


def season(club, results, start=0):
    """club's home matches against club 9: (goals for, goals against, [goal list as (team, minute)])."""
    out = []
    for i, (gf, ga, goals) in enumerate(results):
        day = f"2026-{8 + (start + i) // 7:02d}-{1 + ((start + i) % 7) * 4:02d}"
        out.append(match(club * 1000 + i, day, club, 9, gf, ga, [goal(t, m) for t, m in goals]))
    return out


def ctx_for(matches, details=None):
    return {"by_club": ins.index_matches(matches), "stats": {}, "names": NAMES, "before": BEFORE, "home": 1, "away": 2,
            "players": [], "rows": eng.club_rows(matches, {}, details), "apps": {}}


def market(market_id, family, outcomes, *, period="FT", scope="match", param=None, template="", variant=None, line=None):
    return {"key": f"{market_id}:{param}", "market_id": market_id, "family": family, "variant": variant, "period": period, "scope": scope,
            "line": line, "param": param, "template": template,
            "outcomes": [{"index": i, "label": label, "side": side, "odds": odds, "line": o_line}
                         for i, (label, side, odds, o_line) in enumerate(outcomes)]}


def test_labels_and_names():
    assert mk.count_range("0-3 карточки") == (0, 3) and mk.count_range("4 карточки") == (4, 4)
    assert mk.count_range("12 карточек и более") == (12, None) and mk.count_range("Нет гола") == (0, 0)
    assert mk.count_range("2 гола и более") == (2, None) and mk.count_range("Только Эвертон") is None
    m = market(992, "combo", [], period="1H", param="1.5", template="@1P@ исход и тотал [a]")
    assert mk.market_name(m, EVENT_NAMES) == "1-й тайм исход и тотал 1,5"
    m = market(103, "cards", [], scope="home", template="Кол-во карточек (@NP@) @1")
    assert mk.market_name(m, EVENT_NAMES) == "Кол-во карточек Арсенал"


def test_combo_labels():
    total = market(1036, "combo", [], param="2.5")
    rule, spec = mk.combo_spec(total, {"label": "П1/Больше"}, EVENT_NAMES)
    assert rule == "combo_result_total" and spec == {"on": "FT", "res": "h", "total": ("over", 2.5)}
    assert mk.combo_spec(market(392, "combo", []), {"label": "Н/П2"}, EVENT_NAMES)[1] == {"on": "FT", "ht": "d", "res": "a"}
    assert mk.combo_spec(market(463, "combo", []), {"label": "П2 в 3 и более"}, EVENT_NAMES)[1]["margin"] == (3, None)
    first = mk.combo_spec(market(989, "combo", [], param="1"), {"label": "Ноттингем Форест/П1"}, EVENT_NAMES)[1]
    assert first == {"on": "FT", "first": "a", "res": "h"}
    assert mk.combo_spec(market(679, "btts", [], period="1H"), {"label": "Да / Нет"}, EVENT_NAMES)[1]["btts_halves"] == (True, False)


def test_outcome_semantics():
    v = {"FT": (2, 1), "1H": (0, 1), "2H": (2, 0), "corners": (7, 3), "cards": (1, 3), "cards_1H": (0, 1),
         "first": "a", "first_min": 12, "first_card": "a", "first_card_min": 30}
    assert mk.test({"on": "FT", "res": "h", "total": ("over", 2.5)}, v) is True
    assert mk.test({"on": "FT", "ht": "a", "res": "h"}, v) is True  # a comeback: behind at the break, won
    assert mk.test({"on": "FT", "eh": 1, "res": "d"}, v) is True  # 0:1 handicap, won by exactly one = draw
    assert mk.test({"on": "corners", "hcap": ("a", 3.5)}, v) is False  # 3 + 3.5 < 7
    assert mk.test({"on": "FT", "first_min": (11, 20)}, v) is True
    assert mk.test({"on": "FT", "halves_total": ("under", 2.5, True)}, v) is True
    assert mk.test({"on": "cards", "first_card": "a", "first_card_by": 45}, v) is True
    assert mk.test({"on": "1H", "res": "h"}, {**v, "1H": None}) is None  # no halves for that match: not counted


def test_views_mirror_the_away_club():
    games = season(2, [(2, 0, [(2, "10'"), (2, "50'")])] * 6)  # club 2 (the visitor) wins 2:0 at home against club 9
    games += season(1, [(1, 1, [(1, "5'"), (9, "80'")])] * 6)
    home_views, away_views = mk.views(ctx_for(games), need="ht")
    assert away_views[0]["FT"] == (0, 2) and away_views[0]["first"] == "a"  # from the fixture's side: the away team won
    assert home_views[0]["FT"] == (1, 1) and home_views[0]["first"] == "h"


def test_pooled_card_gate_and_titles():
    home = season(1, [(2, 1, [(1, "10'"), (9, "20'"), (1, "60'")])] * 5 + [(0, 0, [])] * 3)
    away = season(2, [(1, 2, [(2, "10'"), (9, "20'"), (9, "60'")])] * 5 + [(1, 1, [(2, "3'"), (9, "4'")])] * 3, start=1)
    ctx = ctx_for(home + away)
    sides = mk.views(ctx)
    m = market(1036, "combo", [("П1/Больше", None, 3.0, None), ("Н/Больше", None, 9.0, None)], param="2.5", template="Исход и тотал [a] (@NP@)")
    spec = {"on": "FT", "res": "h", "total": ("over", 2.5)}
    card = mk.pooled_card("combo_result_total", EVENT_NAMES, ctx, m, m["outcomes"][0], spec, sides, min_rate=0.4)
    assert card and card["evidence"]["hits"] == 10 and card["evidence"]["sample"] == 16
    assert card["title"] == "Арсенал — победы и 3+ гола в 5 из 8 последних матчей, Ноттингем — поражения и 3+ гола в 5 из 8", card["title"]
    assert card["plate"]["crest"] == "home" and card["plate"]["bet"] == "победит и тотал больше 2,5"
    assert card["market"]["label"] == "Исход и тотал 2,5: П1/Больше"
    draw = mk.pooled_card("combo_result_total", EVENT_NAMES, ctx, m, m["outcomes"][1], {"on": "FT", "res": "d", "total": ("over", 2.5)}, sides, min_rate=0.4)
    assert draw is None  # no draw had three goals
    cheap = dict(m["outcomes"][0], odds=1.5)  # 10 of 16 does not beat a 67% price
    assert mk.pooled_card("combo_result_total", EVENT_NAMES, ctx, m, cheap, spec, sides, min_rate=0.4) is None


def test_margin_words():
    assert mk.margin_noun(">", 0) == "победы" and mk.margin_noun(">", 1) == "победы в 2+ мяча"
    assert mk.margin_noun("<", 1) == "без побед" and mk.margin_noun("=", -1) == "поражения ровно в 1 мяч"
    assert mk.margin_bet(">", -1) == "не проиграет" and mk.margin_bet(">", -2) == "фора +1,5" and mk.margin_bet(">", 1) == "победит в 2+ мяча"
    assert mk.corner_noun(">", -0.5) == "не меньше угловых, чем у соперника" and mk.corner_noun("<", 0.5) == "не больше угловых, чем у соперника"


def test_second_half_european_handicap_reads_plainly():
    # owner 2026-10-16: «2-й тайм европейский гандикап 1:0» is too hard — the plate says «2-й тайм: не проиграет»
    spec = {"on": "2H", "eh": mk.european_start({"param": "1:0"}), "res": "h"}  # the home side starts a goal up
    assert mk.favoured(spec) == "h" and mk.club_bet(spec, "h") == "2-й тайм: не проиграет"
    assert mk.club_view(spec, "h") == "без поражений" and mk.club_view(spec, "a") == "без побед"
    assert mk.match_fact({"on": "1H", "count": (2, 2)}) == "ровно 2 гола в первом тайме"
    assert mk.match_bet({"on": "FT", "res": "d", "total": ("under", 4.5)}) == "ничья и тотал меньше 4,5"


def test_card_facts_from_match_pages():
    detail = {"cards": [{"team_id": 9, "minute": "45+2'", "kind": "Y"}, {"team_id": 1, "minute": "30'", "kind": "Y"},
                        {"team_id": 1, "minute": "70'", "kind": "YR"}]}
    facts = eng.card_facts(detail, 1)
    assert facts["cards_ev"] == (2, 1) and facts["cards_h1"] == (1, 1)  # 45+2 is still the first half
    assert facts["first_card"] == "for" and facts["first_card_min"] == 30
    assert eng.card_facts({"cards": []}, 1)["first_card"] == "none" and eng.card_facts({}, 1)["cards_ev"] is None


def main() -> None:
    for name, function in sorted(globals().items()):
        if name.startswith("test_") and callable(function):
            function()
            print(f"ok  {name}")


if __name__ == "__main__":
    main()
