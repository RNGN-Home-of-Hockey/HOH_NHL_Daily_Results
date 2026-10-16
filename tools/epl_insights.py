#!/usr/bin/env python3
"""Insight rules for EPL broadcast plates (football analogy of the NHL betting-insight engine).

A candidate is a short, defensible fact from our data that maps to a Winline line that really exists
for the match (exact line, current odds). No market on Winline = no card. The score is editorial
relevance, never a win probability or a tip: it mixes how much the history beats the price, how big
the sample is and whether the price is a usable one.

Rules: head-to-head wins / unbeaten run / totals / both teams to score, scoring form against the exact
team-total line, chance creation against this opponent (shots in the box vs the club's usual), league
form runs, and player-to-score lines for players in goalscoring form.
"""
from __future__ import annotations

import math
import sys
from collections import defaultdict
from datetime import datetime, timedelta
from difflib import SequenceMatcher
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import epl_collect as epl  # noqa: E402  (result_for)
import epl_text as T  # noqa: E402  (Russian wording, plate texts)

H2H_WINDOW = 10
H2H_MIN = 6
FORM_WINDOW = 8
FORM_MIN = 6
H2H_FRESH_DAYS = 6 * 366  # the latest meeting must be this recent, or the head-to-head story is stale
FORM_DAYS = 420  # form windows look back about 14 months, never into another era
BASELINE_DAYS = 1100  # three seasons
CHANCE_MIN_MEETINGS = 4
CHANCE_MIN_BASELINE = 20
CHANCE_METRICS = (("xg_proxy", "ожидаемых голов (модель)"), ("shots_inside_box", "ударов из штрафной"),
                  ("shots_on_target", "ударов в створ"), ("shots", "ударов"))
# how the chance metrics read in a card: (more, fewer, noun after the average: None = "ожидаемого гола", else shots + tail).
# Shots are shots, not "моменты" (owner 2026-10-16: «удар это не момент»).
CHANCE_WORDS = {"xg_proxy": ("создаёт больше моментов", "создаёт меньше моментов", None),
                "shots_inside_box": ("чаще бьёт из штрафной", "реже бьёт из штрафной", ""),
                "shots_on_target": ("чаще попадает в створ", "реже попадает в створ", " в створ"),
                "shots": ("чаще бьёт по воротам", "реже бьёт по воротам", "")}
CHANCE_GAP = {"xg_proxy": 0.5, "shots_inside_box": 1.5, "shots_on_target": 1.5, "shots": 2.0}  # absolute difference that counts (xG model: ~3x its 0.18 error of a 6-match average)
MIN_SCORE = 35


def wilson_lower(hits: int, n: int, z: float = 1.0) -> float:
    """Lower bound of the success rate: a small sample cannot look more convincing than a big one."""
    if n <= 0:
        return 0.0
    p = hits / n
    centre = p + z * z / (2 * n)
    margin = z * math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)
    return max(0.0, (centre - margin) / (1 + z * z / n))


def editorial_score(rate_low: float, odds: float, sample: int, weight: float = 0.5, wow: float = 0.0) -> int:
    """0..100: history against the price, sample size, a usable price, how striking the fact is, rule weight."""
    lift = rate_low / (1.0 / odds)  # history against what the price implies; >1 means the history is stronger
    lift_part = min(max((lift - 0.9) / 1.1, 0.0), 1.0)
    sample_part = min(sample / 10.0, 1.0)
    odds_part = 1.0 if 1.5 <= odds <= 5.0 else 0.6 if odds <= 8.0 else 0.3
    return round(100 * (0.40 * lift_part + 0.20 * sample_part + 0.15 * odds_part + 0.15 * wow + 0.10 * weight))


def default_wow(hits: int, n: int, odds: float) -> float:
    """How striking a record is, 0..1: perfect, near perfect, strong, or a real price with a solid record."""
    rate = hits / n if n else 0.0
    if n >= 8 and hits == n:
        return 1.0
    if n >= 6 and rate >= 0.9:
        return 0.7
    if rate >= 0.8:
        return 0.45
    return 0.25 if odds >= 3.0 and rate >= 0.5 else 0.0


def index_matches(matches: list[dict]) -> dict[int, list[dict]]:
    by_club: dict[int, list[dict]] = defaultdict(list)
    for match in matches:
        by_club[match["home"]["id"]].append(match)
        by_club[match["away"]["id"]].append(match)
    for items in by_club.values():
        items.sort(key=lambda m: (m["kickoff_utc"] or "", m["id"]))
    return by_club


def days_before(moment: str, days: int) -> str:
    return (datetime.fromisoformat(moment.replace("Z", "+00:00")) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")


def span(sample: list[dict]) -> str:
    """'2019-2026' for the years a sample of matches covers."""
    years = sorted({(m["kickoff_utc"] or "")[:4] for m in sample if m["kickoff_utc"]})
    return years[0] if len(years) == 1 else f"{years[0]}–{years[-1]}" if years else ""


def recent(by_club: dict[int, list[dict]], club: int, before: str, limit: int, since: str | None = None) -> list[dict]:
    """The club's latest matches before `before` (and not older than `since`), newest first."""
    return [m for m in reversed(by_club.get(club, []))
            if (m["kickoff_utc"] or "") < before and (since is None or (m["kickoff_utc"] or "") >= since)][:limit]


def meetings(by_club: dict[int, list[dict]], club: int, other: int, before: str, limit: int | None = None) -> list[dict]:
    found = [m for m in recent(by_club, club, before, 10_000) if other in (m["home"]["id"], m["away"]["id"])]
    return found[:limit] if limit else found


def goals(match: dict, club: int) -> tuple[int, int]:
    _, scored, conceded = epl.result_for(match, club)
    return scored, conceded


def find_markets(event: dict, family: str, *, period: str = "FT", scope: str = "match", variant="any") -> list[dict]:
    return [
        m for m in event["markets"]
        if m["family"] == family and m["period"] == period and m["scope"] == scope and (variant == "any" or m["variant"] == variant)
    ]


def outcome(market: dict, side: str) -> dict | None:
    return next((o for o in market["outcomes"] if o["side"] == side), None)


def market_ref(market: dict, picked: dict, label: str) -> dict:
    return {
        "market_id": market["market_id"], "family": market["family"], "period": market["period"], "scope": market["scope"],
        "line": picked.get("line", market.get("line")), "side": picked["side"], "odds": picked["odds"], "label": label,
        "key": f"{market['key']}#{picked['index']}",
    }


def make_candidate(rule: str, title: str, evidence: dict, market: dict, picked: dict, label: str, *, weight: float = 0.5,
                   tags: list[str] | None = None, details: dict | None = None, wow: float | None = None,
                   rate_low: float | None = None, plate: dict | None = None) -> dict | None:
    """plate: what the Winline plate says — {crest: home/away/match, bet, team (default: the crest's club or the pair),
    headline (default: the title shortened)}; epl_engine.build_cards completes it."""
    if rate_low is None:
        rate_low = wilson_lower(evidence["hits"], evidence["sample"])
    if wow is None:
        wow = default_wow(evidence["hits"], evidence["sample"], picked["odds"])
    score = editorial_score(rate_low, picked["odds"], evidence["sample"], weight, wow)
    if score < MIN_SCORE:
        return None
    evidence = {**evidence, "rate": round(evidence["hits"] / evidence["sample"], 3), "rate_conservative": round(rate_low, 3),
                "implied_by_price": round(1.0 / picked["odds"], 3)}
    return {
        "rule": rule, "title": title, "evidence": evidence, "market": market_ref(market, picked, label),
        "score": score, "tags": tags or [], "details": details or {}, "plate": plate or {},
    }


def fmt_line(value: float) -> str:
    return f"{value:g}".replace(".", ",")


def goals_phrase(line: float) -> str:
    """'2,5 гола' for half lines, '2 голов' for whole ones."""
    return f"{fmt_line(line)} {'голов' if float(line).is_integer() else 'гола'}"


def side_hits(values: list[float], line: float, side: str) -> int:
    """Over/under hits against the exact line: a whole-number line that is hit exactly is a push (a refund), not a win."""
    return sum(1 for v in values if (v > line if side == "over" else v < line))


def count_word(n: int, one: str, few: str, many: str) -> str:
    n100, n10 = abs(n) % 100, abs(n) % 10
    return one if n10 == 1 and n100 != 11 else few if 2 <= n10 <= 4 and not 12 <= n100 <= 14 else many


# ----------------------------------------------------------------------------------------------------
# Rules. `ctx` keys: by_club, stats (match id -> team id -> stats), names (club id -> Russian name),
# before (kickoff of the match), home / away (club ids), players (list of player records).
# ----------------------------------------------------------------------------------------------------

def rule_h2h_results(event: dict, ctx: dict) -> list[dict]:
    out = []
    home, away, names = ctx["home"], ctx["away"], ctx["names"]
    result_markets = find_markets(event, "match_result", variant=None)
    dc_markets = find_markets(event, "double_chance")
    for club, other, side_win, side_dc in ((home, away, "home", "home_draw"), (away, home, "away", "draw_away")):
        sample = meetings(ctx["by_club"], club, other, ctx["before"], H2H_WINDOW)
        if len(sample) < H2H_MIN or sample[0]["kickoff_utc"] < days_before(ctx["before"], H2H_FRESH_DAYS):
            continue
        results = [epl.result_for(m, club)[0] for m in sample]
        wins = results.count("W")
        n = len(results)
        if wins / n >= 0.6:
            for market in result_markets:
                picked = outcome(market, side_win)
                if picked:
                    title = T.agree(names[club], f"{names[club]} выиграл {wins} из {n} последних матчей с {T.ins(names[other])}")
                    out.append(make_candidate("h2h_win_rate", title, {"sample": n, "hits": wins, "window": "личные встречи АПЛ", "span": span(sample)},
                                              market, picked, f"Победа {names[club]}", weight=0.7, tags=[f"{wins} из {n}"],
                                              details={"results_newest_first": "".join(results), "match_ids": [m["id"] for m in sample]},
                                              plate={"crest": side_win, "bet": "победа в матче"}))
        run = 0
        for result in results:
            if result == "L":
                break
            run += 1
        if run >= 5:
            for market in dc_markets:
                picked = outcome(market, side_dc)
                if picked:
                    word = count_word(run, "матч", "матча", "матчей")
                    title = f"{names[club]} не проигрывает {T.dat(names[other])} {run} {word} подряд"
                    out.append(make_candidate("h2h_unbeaten_run", title, {"sample": run, "hits": run, "window": "серия личных встреч", "span": span(sample[:run])},
                                              market, picked, f"{names[club]} или ничья", weight=0.8, tags=[f"серия {run}"],
                                              details={"match_ids": [m["id"] for m in sample[:run]]},
                                              plate={"crest": side_win, "bet": "не проиграет"}))
    return [c for c in out if c]


def rule_h2h_goals(event: dict, ctx: dict) -> list[dict]:
    out = []
    home, away, names = ctx["home"], ctx["away"], ctx["names"]
    sample = meetings(ctx["by_club"], home, away, ctx["before"], H2H_WINDOW)
    n = len(sample)
    if n < H2H_MIN or sample[0]["kickoff_utc"] < days_before(ctx["before"], H2H_FRESH_DAYS):
        return out
    window = {"window": "личные встречи АПЛ", "span": span(sample)}
    totals = [m["home"]["score"] + m["away"]["score"] for m in sample]
    for market in find_markets(event, "total"):
        line = market.get("line")
        if line is None:
            continue
        for side, word in (("over", "больше"), ("under", "меньше")):
            hits = side_hits(totals, line, side)
            if hits / n >= 0.7:
                picked = outcome(market, side)
                if picked:
                    title = f"В {hits} из {n} последних встреч {T.gen(names[home])} и {T.gen(names[away])} забито {T.total(side, line)}"
                    out.append(make_candidate("h2h_total", title, {"sample": n, "hits": hits, **window}, market, picked,
                                              f"Тотал {word} {fmt_line(line)}", weight=0.6, tags=[f"{hits} из {n}", f"линия {fmt_line(line)}"],
                                              details={"totals_newest_first": totals},
                                              plate={"crest": "match", "bet": f"тотал {word} {fmt_line(line)}",
                                                     "headline": f"{T.cap(T.total(side, line))} в {hits} из {n} последних встреч"}))
    both = sum(1 for m in sample if m["home"]["score"] > 0 and m["away"]["score"] > 0)
    for market in find_markets(event, "btts"):
        for side, hits, word in (("yes", both, "забивали обе команды"), ("no", n - both, "хотя бы одна команда не забила")):
            if hits / n >= 0.7:
                picked = outcome(market, side)
                if picked:
                    title = f"В {hits} из {n} последних встреч {T.gen(names[home])} и {T.gen(names[away])} {word}"
                    out.append(make_candidate("h2h_btts", title, {"sample": n, "hits": hits, **window}, market, picked,
                                              "Обе забьют — Да" if side == "yes" else "Обе забьют — Нет", weight=0.55, tags=[f"{hits} из {n}"],
                                              plate={"crest": "match", "bet": "обе забьют" if side == "yes" else "обе забьют — нет",
                                                     "headline": f"{T.cap(word)} в {hits} из {n} последних встреч"}))
    return [c for c in out if c]


def rule_team_scoring_form(event: dict, ctx: dict) -> list[dict]:
    out = []
    names = ctx["names"]
    for club, scope in ((ctx["home"], "home"), (ctx["away"], "away")):
        sample = recent(ctx["by_club"], club, ctx["before"], FORM_WINDOW, since=days_before(ctx["before"], FORM_DAYS))
        if len(sample) < FORM_MIN:
            continue
        scored = [goals(m, club)[0] for m in sample]
        n = len(scored)
        for market in find_markets(event, "total", scope=scope):
            line = market.get("line")
            if line is None:
                continue
            for side, word in (("over", "больше"), ("under", "меньше")):
                hits = side_hits(scored, line, side)
                if hits / n >= 0.75:
                    picked = outcome(market, side)
                    if picked:
                        title = T.agree(names[club], f"{names[club]} забивал {T.total(side, line)} в {hits} из {n} последних матчей АПЛ")
                        out.append(make_candidate("team_scoring_form", title, {"sample": n, "hits": hits, "window": f"последние {n} матчей АПЛ", "span": span(sample)},
                                                  market, picked, f"Тотал {names[club]} {word} {fmt_line(line)}", weight=0.6,
                                                  tags=[f"{hits} из {n}", f"линия {fmt_line(line)}"], details={"goals_newest_first": scored},
                                                  plate={"crest": scope, "bet": f"инд. тотал {word} {fmt_line(line)}"}))
    return [c for c in out if c]


def average(values: list[float]) -> float:
    return sum(values) / len(values)


def rule_chance_creation(event: dict, ctx: dict) -> list[dict]:
    """A club creates clearly more (or fewer) chances against this opponent than against everyone else."""
    out = []
    names, stats = ctx["names"], ctx["stats"]
    for club, other, scope in ((ctx["home"], ctx["away"], "home"), (ctx["away"], ctx["home"], "away")):
        every = recent(ctx["by_club"], club, ctx["before"], 10_000, since=days_before(ctx["before"], BASELINE_DAYS))
        for key, label in CHANCE_METRICS:
            versus, baseline = [], []
            for m in every:
                value = (stats.get(m["id"]) or {}).get(club, {}).get(key)
                if value is None:
                    continue
                (versus if other in (m["home"]["id"], m["away"]["id"]) else baseline).append(value)
            versus = versus[:6]
            baseline = baseline[:114]
            if len(versus) < CHANCE_MIN_MEETINGS or len(baseline) < CHANCE_MIN_BASELINE:
                continue
            mean_vs, mean_base = average(versus), average(baseline)
            if mean_base <= 0:
                continue
            ratio = mean_vs / mean_base
            gap = CHANCE_GAP[key]
            more = ratio >= 1.25 and mean_vs - mean_base >= gap
            fewer = ratio <= 0.75 and mean_base - mean_vs >= gap
            if not (more or fewer):
                continue
            for market in find_markets(event, "total", scope=scope):
                line = market.get("line")
                if line not in ((1.5, 2.5) if more else (1.5,)):  # a modest line: fewer chances do not mean a blank
                    continue
                picked = outcome(market, "over" if more else "under")
                if not picked:
                    continue
                more_text, fewer_text, tail = CHANCE_WORDS[key]
                verb = more_text if more else fewer_text
                digits = 2 if key == "xg_proxy" else 1
                value, usual = T.num(mean_vs, digits), T.num(mean_base, digits)
                noun = "ожидаемого гола" if tail is None else T.word(round(mean_vs, digits), "shot") + tail
                title = f"{names[club]} {verb} против {T.gen(names[other])}: в среднем {value} {noun} за матч, в остальных играх — {usual}"
                hits = sum(1 for v in versus if (v > mean_base if more else v < mean_base))
                out.append(make_candidate("chance_creation", title, {"sample": len(versus), "hits": hits, "window": f"{label}: встречи против остальных"},
                                          market, picked, f"Тотал {names[club]} {'больше' if more else 'меньше'} {fmt_line(line)}", weight=0.9,
                                          tags=[f"×{ratio:.2f} к обычному", label],
                                          details={"metric": key, "mean_vs_opponent": round(mean_vs, 2), "mean_vs_others": round(mean_base, 2),
                                                   "values_vs_opponent_newest_first": versus, "meetings": len(versus), "baseline_matches": len(baseline)},
                                          plate={"crest": scope, "bet": f"инд. тотал {'больше' if more else 'меньше'} {fmt_line(line)}",
                                                 "headline": T.first_fit((f"{names[club]} {verb} против {T.gen(names[other])}: {value} против {usual}",
                                                                          f"{names[club]} {verb} против {T.gen(names[other])}"))}))
            break  # the first metric that shows a real gap is enough for one club
    return [c for c in out if c]


def rule_form_run(event: dict, ctx: dict) -> list[dict]:
    out = []
    names = ctx["names"]
    for club, side_dc in ((ctx["home"], "home_draw"), (ctx["away"], "draw_away")):
        results = [epl.result_for(m, club)[0] for m in recent(ctx["by_club"], club, ctx["before"], 12, since=days_before(ctx["before"], FORM_DAYS))]
        unbeaten = 0
        for result in results:
            if result == "L":
                break
            unbeaten += 1
        if unbeaten >= 6:
            for market in find_markets(event, "double_chance"):
                picked = outcome(market, side_dc)
                if picked:
                    word = count_word(unbeaten, "матч", "матча", "матчей")
                    out.append(make_candidate("form_unbeaten_run", f"{names[club]} не проигрывает в АПЛ {unbeaten} {word} подряд",
                                              {"sample": unbeaten, "hits": unbeaten, "window": "текущая серия в АПЛ"}, market, picked,
                                              f"{names[club]} или ничья", weight=0.5, tags=[f"серия {unbeaten}"],
                                              plate={"crest": "home" if side_dc == "home_draw" else "away", "bet": "не проиграет"}))
    return [c for c in out if c]


def match_player(name_ru: str, club: int, players: list[dict]) -> dict | None:
    """Winline spells names its own way: match by the surname inside the club."""
    surname = (name_ru.split()[-1] if name_ru else "").lower().replace("ё", "е")
    best, best_score = None, 0.0
    for p in players:
        if p["club"]["id"] != club or not p.get("surname_ru"):
            continue
        candidate = p["surname_ru"].split()[-1].lower().replace("ё", "е")
        score = SequenceMatcher(None, surname, candidate).ratio()
        if score > best_score:
            best, best_score = p, score
    return best if best_score >= 0.8 else None


def rule_player_scorer(event: dict, ctx: dict) -> list[dict]:
    out = []
    for market in find_markets(event, "player_goal", scope="player", variant="anytime"):
        subject = market.get("subject")
        picked = outcome(market, "yes")
        if not subject or not picked:
            continue
        club = ctx["home"] if subject["team"] == "home" else ctx["away"]
        player = match_player(subject["name"], club, ctx["players"])
        history = (player or {}).get("season_2026_27_by_gameweek") or []
        played = [row for row in history if (row.get("minutes") or 0) > 0][-5:]
        if len(played) < 4:
            continue
        scored = sum(1 for row in played if (row.get("goals_scored") or 0) > 0)
        season = player.get("season_2026_27") or {}
        taker = season.get("penalties_order") == 1
        if scored / len(played) < 0.6 and not (taker and (season.get("goals_scored") or 0) >= 3):
            continue
        n = len(played)
        season_goals = season.get("goals_scored") or 0
        if scored / n >= 0.6:
            title = f"{player['surname_ru']} забивал в {scored} из {n} последних матчей АПЛ" + (" и бьёт пенальти" if taker else "")
        else:
            title = f"{player['surname_ru']} бьёт пенальти и забил {season_goals} {count_word(season_goals, 'гол', 'гола', 'голов')} в сезоне АПЛ"
        out.append(make_candidate("player_scorer_form", title, {"sample": n, "hits": scored, "window": f"последние {n} матчей с игровым временем"},
                                  market, picked, f"{player['surname_ru']} забьёт", weight=0.6,
                                  tags=[f"{scored} из {n}"] + (["пенальти"] if taker else []),
                                  details={"player_id": player["pl_id"], "goals_by_gameweek": [row.get("goals_scored") for row in played]},
                                  plate={"crest": subject["team"], "team": player["surname_ru"], "bet": "забьёт гол"}))
    return [c for c in out if c]


RULES = (rule_h2h_results, rule_h2h_goals, rule_team_scoring_form, rule_chance_creation, rule_form_run, rule_player_scorer)


PER_RULE_LIMIT = 2
MATCH_LIMIT = 12


def build_match_insights(event: dict, ctx: dict) -> list[dict]:
    """Candidates for one match, strongest first. The same fact on several lines becomes one card with
    `alternatives`; at most PER_RULE_LIMIT cards per rule and MATCH_LIMIT per match, so the list stays readable."""
    seen, grouped = set(), {}
    for rule in RULES:
        for candidate in rule(event, ctx):
            key = (candidate["rule"], candidate["market"]["key"])
            if key in seen:
                continue
            seen.add(key)
            group = grouped.setdefault((candidate["rule"], candidate["title"]), [])
            group.append(candidate)
    cards = []
    for group in grouped.values():
        group.sort(key=lambda c: -c["score"])
        best = dict(group[0])
        best["alternatives"] = [{"label": c["market"]["label"], "odds": c["market"]["odds"], "line": c["market"]["line"], "score": c["score"],
                                 "market_id": c["market"]["market_id"], "key": c["market"]["key"]} for c in group[1:]]
        cards.append(best)
    cards.sort(key=lambda c: (-c["score"], -c["evidence"]["sample"]))
    per_rule, out = defaultdict(int), []
    for card in cards:
        if per_rule[card["rule"]] >= PER_RULE_LIMIT:
            continue
        per_rule[card["rule"]] += 1
        out.append(card)
    return out[:MATCH_LIMIT]
