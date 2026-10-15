#!/usr/bin/env python3
"""Trend engine v2 for the EPL operator site.

Every card is a fact from our data tied to a line that Winline really offers for the match (exact
line, current odds). Families: result, goals, halves, goal order, corners, cards, chances, players.
Each card gets a "coolness" tier from its score (history vs price, sample, price band, how striking the
fact is): Огонь >= 80, Сильная >= 65, Рабочая >= 50, Фон >= 35 (lower scores are dropped).

The basic rules live in epl_insights.py and are used here as they are; this module adds the club
match history (halves, first/last goal, corners, cards), the new rule families, the player rules,
the grading and the boards for the "Команды" and "Игроки" pages.
"""
from __future__ import annotations

import math
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import epl_insights as ins  # noqa: E402

TIERS = ((80, "fire", "Огонь", 5), (65, "strong", "Сильная", 4), (50, "solid", "Рабочая", 3), (35, "background", "Фон", 2))
PER_RULE_LIMIT = 3
MATCH_LIMIT = 45
FORM_N = 8
FORM_MIN = 6
VENUE_N = 8
TOP_MIN_HITS = 4  # Сильная/Огонь need at least four hits, and a short sample only when it is perfect ("4 из 4")
TOP_MIN_SAMPLE = 8

# rule -> (market category, basis of the fact)
RULE_META = {
    "h2h_win_rate": ("Исход", "Личные встречи"), "h2h_unbeaten_run": ("Исход", "Личные встречи"),
    "h2h_total": ("Голы", "Личные встречи"), "h2h_btts": ("Голы", "Личные встречи"),
    "team_scoring_form": ("Голы", "Форма"), "form_unbeaten_run": ("Исход", "Форма"),
    "chance_creation": ("Голы", "Моменты"), "player_scorer_form": ("Игроки", "Форма"),
    "form_win_rate": ("Исход", "Форма"), "venue_form": ("Исход", "Форма"), "win_to_nil": ("Исход", "Форма"),
    "clean_sheet": ("Исход", "Форма"), "handicap_margin": ("Исход", "Форма"),
    "match_total_form": ("Голы", "Форма"), "btts_form": ("Голы", "Форма"), "team_goals_bucket": ("Голы", "Форма"),
    "first_half_total": ("Таймы", "Форма"), "team_first_half_goal": ("Таймы", "Форма"),
    "second_half_heavier": ("Таймы", "Форма"), "scores_both_halves": ("Таймы", "Форма"),
    "wins_a_half": ("Таймы", "Форма"), "half_time_lead": ("Таймы", "Форма"),
    "scores_first": ("Ход матча", "Форма"), "last_goal": ("Ход матча", "Форма"), "early_goal": ("Ход матча", "Форма"),
    "corners_total_form": ("Угловые", "Форма"), "team_corners": ("Угловые", "Форма"),
    "cards_total_form": ("Карточки", "Форма"),
    "player_xg_value": ("Игроки", "Модель"), "player_vs_opponent": ("Игроки", "Личные встречи"),
    "player_first_scorer": ("Игроки", "Форма"),
}


def grade(score: int) -> tuple[str, str, int]:
    for threshold, tier, label, stars in TIERS:
        if score >= threshold:
            return tier, label, stars
    return "none", "—", 0


def half_of(minute: str | None) -> int | None:
    match = re.match(r"\s*(\d+)", minute or "")
    return None if not match else (1 if int(match.group(1)) <= 45 else 2)


def minute_of(minute: str | None) -> int | None:
    match = re.match(r"\s*(\d+)", minute or "")
    return int(match.group(1)) if match else None


def club_rows(matches: list[dict], stats: dict[int, dict[int, dict]]) -> dict[int, list[dict]]:
    """Per club, oldest first: result, halves, first/last goal, corners, cards, shots of every league match.
    Halves and goal order need the scoring team of every goal (match detail pages); otherwise they stay None."""
    rows: dict[int, list[dict]] = defaultdict(list)
    for m in sorted(matches, key=lambda m: (m["kickoff_utc"] or "", m["id"])):
        goals = m["goals"]
        known = all(g.get("team_id") is not None and half_of(g.get("minute")) for g in goals)
        per_team = stats.get(m["id"]) or {}
        for club, opp, venue in ((m["home"]["id"], m["away"]["id"], "H"), (m["away"]["id"], m["home"]["id"], "A")):
            gf, ga = (m["home"]["score"], m["away"]["score"]) if venue == "H" else (m["away"]["score"], m["home"]["score"])
            row = {"id": m["id"], "kickoff": m["kickoff_utc"] or "", "season": m["season"], "venue": venue, "opp": opp,
                   "gf": gf, "ga": ga, "ht": None, "h2": None, "first": None, "first_min": None, "last": None,
                   "corners": None, "cards": None, "shots": None}
            if known:
                h1f = sum(1 for g in goals if g["team_id"] == club and half_of(g["minute"]) == 1)
                h1a = sum(1 for g in goals if g["team_id"] != club and half_of(g["minute"]) == 1)
                row["ht"], row["h2"] = (h1f, h1a), (gf - h1f, ga - h1a)
                if goals:
                    row["first"] = "for" if goals[0]["team_id"] == club else "against"
                    row["first_min"] = minute_of(goals[0]["minute"])
                    row["last"] = "for" if goals[-1]["team_id"] == club else "against"
                else:
                    row["first"] = row["last"] = "none"
            own, theirs = per_team.get(club), per_team.get(opp)
            if own and theirs and "shots" in own and "shots" in theirs:  # a valid stats block: unlisted counters are zero
                row["corners"] = (own.get("corners_won", 0), theirs.get("corners_won", 0))
                row["cards"] = (own.get("yellow_cards", 0) + own.get("red_cards", 0), theirs.get("yellow_cards", 0) + theirs.get("red_cards", 0))
                row["shots"] = (own.get("shots", 0), theirs.get("shots", 0))
            rows[club].append(row)
    return rows


def recent_rows(ctx: dict, club: int, *, need: str | None = None, venue: str | None = None, n: int = FORM_N) -> list[dict]:
    """The club's latest league matches before the kickoff, newest first, not older than the form window."""
    since = ins.days_before(ctx["before"], ins.FORM_DAYS)
    out = []
    for row in reversed(ctx["rows"].get(club, [])):
        if row["kickoff"] >= ctx["before"]:
            continue
        if row["kickoff"] < since:
            break
        if (need and row[need] is None) or (venue and row["venue"] != venue):
            continue
        out.append(row)
        if len(out) == n:
            break
    return out


def by_label(market: dict, label: str) -> dict | None:
    wanted = label.strip().lower()
    return next((o for o in market["outcomes"] if (o.get("label") or "").strip().lower() == wanted), None)


def wow_factor(hits: int, n: int, odds: float, run: int | None = None) -> float:
    """How striking the fact is, 0..1: a perfect record, a long run, a near-perfect record, a real price."""
    rate = hits / n if n else 0.0
    if n >= 8 and hits == n:
        return 1.0
    if run and run >= 8:
        return 0.9
    if n >= 6 and rate >= 0.9:
        return 0.7
    if rate >= 0.8:
        return 0.45
    return 0.25 if odds >= 3.0 and rate >= 0.5 else 0.0


def finish(card: dict | None) -> dict | None:
    """Add category, basis, tier and the operator's 'why' reasons to a card made by epl_insights.make_candidate."""
    if not card:
        return None
    category, basis = RULE_META.get(card["rule"], ("Прочее", "Форма"))
    e = card["evidence"]
    if e["hits"] < TOP_MIN_HITS or (e["sample"] < TOP_MIN_SAMPLE and e["hits"] < e["sample"]):
        card["score"] = min(card["score"], TIERS[1][0] - 1)  # "3 из 6" can be worth a look, never a headline
    tier, label, stars = grade(card["score"])
    reasons = [f"история {round(e['rate'] * 100)}% против {round(e['implied_by_price'] * 100)}% по цене", f"выборка {e['sample']}",
               f"кэф {card['market']['odds']:.2f}"]
    if e.get("span"):
        reasons.append(e["span"])
    card.update({"category": category, "basis": basis, "tier": tier, "tier_label": label, "stars": stars, "reasons": reasons})
    return card


def span_rows(rows: list[dict]) -> str:
    years = sorted({r["kickoff"][:4] for r in rows if r["kickoff"]})
    return years[0] if len(years) == 1 else f"{years[0]}–{years[-1]}" if years else ""


def make(rule: str, title: str, market: dict, picked: dict | None, label: str, *, hits: int, n: int, window: str, sample_rows=None,
         weight: float = 0.55, run: int | None = None, tags=None, details=None) -> dict | None:
    if not picked or n <= 0:
        return None
    evidence = {"sample": n, "hits": hits, "window": window}
    if sample_rows:
        evidence["span"] = span_rows(sample_rows)
    card = ins.make_candidate(rule, title, evidence, market, picked, label, weight=weight, tags=tags or [f"{hits} из {n}"],
                              details=details or {}, wow=wow_factor(hits, n, picked["odds"], run))
    return finish(card)


def signed(value: float) -> str:
    return f"+{ins.fmt_line(value)}" if value > 0 else f"−{ins.fmt_line(abs(value))}" if value < 0 else "0"


# ----------------------------------------------------------------------------------------------------
# Team rules. ctx: rows (club_rows), names, before, home, away (+ the epl_insights keys)
# ----------------------------------------------------------------------------------------------------

def clubs(ctx: dict):
    return ((ctx["home"], ctx["away"], "home"), (ctx["away"], ctx["home"], "away"))


def rule_form_win_rate(event: dict, ctx: dict) -> list:
    out = []
    for club, _, side in clubs(ctx):
        rows = recent_rows(ctx, club)
        if len(rows) < FORM_MIN:
            continue
        wins = sum(1 for r in rows if r["gf"] > r["ga"])
        if wins / len(rows) >= 0.7:
            for market in ins.find_markets(event, "match_result", variant=None):
                out.append(make("form_win_rate", f"{ctx['names'][club]} выиграл {wins} из {len(rows)} последних матчей АПЛ", market,
                                ins.outcome(market, side), f"Победа {ctx['names'][club]}", hits=wins, n=len(rows),
                                window=f"последние {len(rows)} матчей АПЛ", sample_rows=rows, weight=0.5))
    return out


def rule_venue_form(event: dict, ctx: dict) -> list:
    out = []
    for club, _, side in clubs(ctx):
        venue = "H" if side == "home" else "A"
        where = "дома" if venue == "H" else "в гостях"
        rows = recent_rows(ctx, club, venue=venue, n=VENUE_N)
        if len(rows) < FORM_MIN:
            continue
        unbeaten = sum(1 for r in rows if r["gf"] >= r["ga"])
        wins = sum(1 for r in rows if r["gf"] > r["ga"])
        name = ctx["names"][club]
        if wins / len(rows) >= 0.7:
            for market in ins.find_markets(event, "match_result", variant=None):
                out.append(make("venue_form", f"{name} выиграл {wins} из {len(rows)} последних матчей {where}", market, ins.outcome(market, side),
                                f"Победа {name}", hits=wins, n=len(rows), window=f"матчи {where}", sample_rows=rows))
        elif unbeaten / len(rows) >= 0.85:
            for market in ins.find_markets(event, "double_chance"):
                out.append(make("venue_form", f"{name} не проигрывал в {unbeaten} из {len(rows)} последних матчей {where}", market,
                                ins.outcome(market, "home_draw" if side == "home" else "draw_away"), f"{name} или ничья",
                                hits=unbeaten, n=len(rows), window=f"матчи {where}", sample_rows=rows))
    return out


def yes_no_rule(event, ctx, *, rule, family, predicate, title, label, period="FT", threshold=0.5, need=None, weight=0.55, template=None):
    """A Да/Нет market about one club (scope home/away): share of its recent matches where `predicate` held."""
    out = []
    for club, _, side in clubs(ctx):
        rows = recent_rows(ctx, club, need=need)
        if len(rows) < FORM_MIN:
            continue
        hits = sum(1 for r in rows if predicate(r))
        if hits / len(rows) < threshold:
            continue
        for market in ins.find_markets(event, family, period=period, scope=side):
            if template and template not in market["template"].lower():
                continue
            out.append(make(rule, title(ctx["names"][club], hits, len(rows)), market, by_label(market, "Да"), label(ctx["names"][club]),
                            hits=hits, n=len(rows), window=f"последние {len(rows)} матчей АПЛ", sample_rows=rows, weight=weight))
    return out


def rule_win_to_nil(event, ctx):
    return yes_no_rule(event, ctx, rule="win_to_nil", family="win_to_nil", predicate=lambda r: r["gf"] > 0 and r["ga"] == 0, threshold=0.5,
                       title=lambda n, h, t: f"{n} выигрывал всухую в {h} из {t} последних матчей", label=lambda n: f"{n} победит всухую — да")


def rule_clean_sheet(event, ctx):
    return yes_no_rule(event, ctx, rule="clean_sheet", family="clean_sheet", predicate=lambda r: r["ga"] == 0, threshold=0.5,
                       title=lambda n, h, t: f"{n} не пропускал в {h} из {t} последних матчей", label=lambda n: f"{n} не пропустит — да")


def rule_scores_both_halves(event, ctx):
    return yes_no_rule(event, ctx, rule="scores_both_halves", family="halves", need="ht", template="забьет в обоих", threshold=0.5,
                       predicate=lambda r: r["ht"][0] > 0 and r["h2"][0] > 0,
                       title=lambda n, h, t: f"{n} забивал в обоих таймах в {h} из {t} последних матчей", label=lambda n: f"{n} забьёт в обоих таймах — да")


def rule_wins_a_half(event, ctx):
    out = yes_no_rule(event, ctx, rule="wins_a_half", family="halves", need="ht", template="одном из таймов", threshold=0.75,
                      predicate=lambda r: r["ht"][0] > r["ht"][1] or r["h2"][0] > r["h2"][1],
                      title=lambda n, h, t: f"{n} выигрывал хотя бы один тайм в {h} из {t} последних матчей", label=lambda n: f"{n} выиграет хотя бы один тайм — да")
    out += yes_no_rule(event, ctx, rule="wins_a_half", family="halves", need="ht", template="победит в обоих", threshold=0.5,
                       predicate=lambda r: r["ht"][0] > r["ht"][1] and r["h2"][0] > r["h2"][1],
                       title=lambda n, h, t: f"{n} выигрывал оба тайма в {h} из {t} последних матчей", label=lambda n: f"{n} выиграет оба тайма — да")
    return out


HANDICAP_MIN_ODDS = 1.4  # a cushion the market already prices near-certain is not a story


def rule_handicap_margin(event, ctx):
    out = []
    for club, _, side in clubs(ctx):
        rows = recent_rows(ctx, club)
        if len(rows) < FORM_MIN:
            continue
        passing = []
        for market in ins.find_markets(event, "handicap"):
            picked = ins.outcome(market, side)
            if not picked or picked.get("line") in (None, 0) or picked["odds"] < HANDICAP_MIN_ODDS:
                continue
            line = picked["line"]
            hits = sum(1 for r in rows if r["gf"] - r["ga"] + line > 0)
            if hits / len(rows) >= 0.75:
                passing.append((picked["odds"], market, picked, hits))
        if passing:  # one card per club: the boldest line the record still covers
            _, market, picked, hits = max(passing, key=lambda x: x[0])
            name, line = ctx["names"][club], picked["line"]
            out.append(make("handicap_margin", f"{name}: фора {signed(line)} проходила бы в {hits} из {len(rows)} последних матчей", market,
                            picked, f"{name} фора {signed(line)}", hits=hits, n=len(rows), window=f"последние {len(rows)} матчей АПЛ",
                            sample_rows=rows))
    return out


def pooled(ctx: dict, need: str | None = None) -> list[dict]:
    """Both clubs' recent matches together (each needs at least FORM_MIN)."""
    home, away = recent_rows(ctx, ctx["home"], need=need), recent_rows(ctx, ctx["away"], need=need)
    return home + away if len(home) >= FORM_MIN and len(away) >= FORM_MIN else []


def two_names(ctx: dict) -> str:
    return f"{ctx['names'][ctx['home']]} и {ctx['names'][ctx['away']]}"


def over_under_rule(event, ctx, *, rule, value, markets, title, label, need=None, threshold=0.75, unit=ins.goals_phrase):
    rows = pooled(ctx, need)
    if not rows:
        return []
    values = [value(r) for r in rows]
    out = []
    for market in markets:
        line = market.get("line")
        if line is None:
            continue
        for side, word in (("over", "больше"), ("under", "меньше")):
            hits = ins.side_hits(values, line, side)
            if hits / len(values) >= threshold:
                out.append(make(rule, title(word, unit(line), hits, len(values)), market, ins.outcome(market, side), label(word, ins.fmt_line(line)),
                                hits=hits, n=len(values), window="последние матчи обеих команд", sample_rows=rows))
    return out


def rule_match_total_form(event, ctx):
    return over_under_rule(event, ctx, rule="match_total_form", value=lambda r: r["gf"] + r["ga"], markets=ins.find_markets(event, "total"),
                           title=lambda w, u, h, n: f"{w.capitalize()} {u} в {h} из {n} последних матчей {two_names(ctx)}",
                           label=lambda w, l: f"Тотал {w} {l}")


def rule_first_half_total(event, ctx):
    return over_under_rule(event, ctx, rule="first_half_total", need="ht", value=lambda r: r["ht"][0] + r["ht"][1],
                           markets=ins.find_markets(event, "total", period="1H"),
                           title=lambda w, u, h, n: f"Первый тайм: {w} {u} в {h} из {n} последних матчей {two_names(ctx)}",
                           label=lambda w, l: f"1-й тайм: тотал {w} {l}")


def corner_markets(event: dict, scope: str) -> list[dict]:
    return [m for m in event["markets"] if m["family"] == "corners" and m["variant"] == "total" and m["scope"] == scope and m["period"] == "FT"]


def rule_corners_total_form(event, ctx):
    corners = lambda l: f"{ins.fmt_line(l)} угловых"  # noqa: E731
    out = over_under_rule(event, ctx, rule="corners_total_form", need="corners", value=lambda r: r["corners"][0] + r["corners"][1],
                          markets=corner_markets(event, "match"), unit=corners,
                          title=lambda w, u, h, n: f"Угловые: {w} {u} в {h} из {n} последних матчей {two_names(ctx)}",
                          label=lambda w, l: f"Тотал угловых {w} {l}")
    for club, _, side in clubs(ctx):
        rows = recent_rows(ctx, club, need="corners")
        if len(rows) < FORM_MIN:
            continue
        values = [r["corners"][0] for r in rows]
        for market in corner_markets(event, side):
            for s, word in (("over", "больше"), ("under", "меньше")):
                hits = ins.side_hits(values, market["line"], s)
                if hits / len(values) >= 0.75:
                    name = ctx["names"][club]
                    out.append(make("team_corners", f"{name} подавал {word} {corners(market['line'])} в {hits} из {len(values)} последних матчей",
                                    market, ins.outcome(market, s), f"Угловые {name} {word} {ins.fmt_line(market['line'])}",
                                    hits=hits, n=len(values), window="последние матчи", sample_rows=rows))
    return out


def rule_cards_total_form(event, ctx):
    cards = lambda l: f"{ins.fmt_line(l)} карточек"  # noqa: E731
    markets = [m for m in event["markets"] if m["family"] == "cards" and m["variant"] == "total" and m["scope"] == "match" and m["period"] == "FT"]
    out = over_under_rule(event, ctx, rule="cards_total_form", need="cards", value=lambda r: r["cards"][0] + r["cards"][1], markets=markets,
                          title=lambda w, u, h, n: f"Карточки: {w} {u} в {h} из {n} последних матчей {two_names(ctx)}",
                          label=lambda w, l: f"Тотал карточек {w} {l}", unit=cards, threshold=0.8)
    for card in out:
        if card:
            card["tags"].append("карточки: сверить правила подсчёта Winline")
    return out


def rule_btts_form(event, ctx):
    rows = pooled(ctx)
    if not rows:
        return []
    both = sum(1 for r in rows if r["gf"] > 0 and r["ga"] > 0)
    out = []
    for market in ins.find_markets(event, "btts"):
        for side, hits, text in (("yes", both, "обе команды забивали"), ("no", len(rows) - both, "забивала не больше одной команды")):
            if hits / len(rows) >= 0.75:
                out.append(make("btts_form", f"В {hits} из {len(rows)} последних матчей {two_names(ctx)} {text}", market, ins.outcome(market, side),
                                "Обе забьют — Да" if side == "yes" else "Обе забьют — Нет", hits=hits, n=len(rows),
                                window="последние матчи обеих команд", sample_rows=rows))
    return out


def rule_team_goals_bucket(event, ctx):
    out = []
    for club, _, side in clubs(ctx):
        rows = recent_rows(ctx, club)
        if len(rows) < FORM_MIN:
            continue
        for market in ins.find_markets(event, "goals_count", scope=side, variant="bucket"):
            for o in market["outcomes"]:
                bucket = o.get("bucket")
                if not bucket:
                    continue
                hits = sum(1 for r in rows if r["gf"] >= bucket["min"] and (bucket["max"] is None or r["gf"] <= bucket["max"]))
                if hits / len(rows) < 0.5:
                    continue
                name = ctx["names"][club]
                text = ("не забивал" if bucket["max"] == 0 else f"забивал {bucket['min']} и больше" if bucket["max"] is None
                        else f"забивал ровно {bucket['min']}")
                out.append(make("team_goals_bucket", f"{name} {text} в {hits} из {len(rows)} последних матчей", market, o,
                                f"{name}: {o['label']}", hits=hits, n=len(rows), window=f"последние {len(rows)} матчей", sample_rows=rows))
    return out


def rule_team_first_half_goal(event, ctx):
    out = []
    for club, _, side in clubs(ctx):
        rows = recent_rows(ctx, club, need="ht")
        if len(rows) < FORM_MIN:
            continue
        values = [r["ht"][0] for r in rows]
        for market in ins.find_markets(event, "total", period="1H", scope=side):
            if market.get("line") != 0.5:
                continue
            for s, word in (("over", "забивал"), ("under", "не забивал")):
                hits = ins.side_hits(values, 0.5, s)
                if hits / len(values) >= 0.75:
                    name = ctx["names"][club]
                    out.append(make("team_first_half_goal", f"{name} {word} в первом тайме в {hits} из {len(values)} последних матчей", market,
                                    ins.outcome(market, s), f"1-й тайм: тотал {name} {'больше' if s == 'over' else 'меньше'} 0,5",
                                    hits=hits, n=len(values), window="последние матчи", sample_rows=rows))
    return out


def rule_second_half_heavier(event, ctx):
    rows = pooled(ctx, "ht")
    if not rows:
        return []
    second = sum(1 for r in rows if sum(r["h2"]) > sum(r["ht"]))
    first = sum(1 for r in rows if sum(r["ht"]) > sum(r["h2"]))
    out = []
    for market in [m for m in ins.find_markets(event, "halves") if "результативный тайм" in m["template"].lower()]:
        for label, hits, text in (("2-й тайм", second, "второй тайм был результативнее первого"), ("1-й тайм", first, "первый тайм был результативнее второго")):
            if hits / len(rows) >= 0.6:
                out.append(make("second_half_heavier", f"В {hits} из {len(rows)} последних матчей {two_names(ctx)} {text}", market,
                                by_label(market, label), f"Самый результативный тайм — {label}", hits=hits, n=len(rows),
                                window="последние матчи обеих команд", sample_rows=rows))
    return out


def rule_half_time_lead(event, ctx):
    out = []
    for club, _, side in clubs(ctx):
        rows = recent_rows(ctx, club, need="ht")
        if len(rows) < FORM_MIN:
            continue
        hits = sum(1 for r in rows if r["ht"][0] > r["ht"][1])
        if hits / len(rows) >= 0.6:
            for market in ins.find_markets(event, "match_result", period="1H", variant=None):
                name = ctx["names"][club]
                out.append(make("half_time_lead", f"{name} вёл после первого тайма в {hits} из {len(rows)} последних матчей", market,
                                ins.outcome(market, side), f"1-й тайм: победа {name}", hits=hits, n=len(rows), window="последние матчи", sample_rows=rows))
    return out


def goal_order_rule(event, ctx, *, rule, key, variant, title):
    out = []
    for club, _, side in clubs(ctx):
        rows = recent_rows(ctx, club, need="first")
        if len(rows) < FORM_MIN:
            continue
        hits = sum(1 for r in rows if r[key] == "for")
        if hits / len(rows) < 0.6:
            continue
        markets = [m for m in ins.find_markets(event, "goal_sequence", variant=variant) if variant != "next" or m.get("param") == "1"]
        for market in markets:
            name = ctx["names"][club]
            out.append(make(rule, title(name, hits, len(rows)), market, by_label(market, "1" if side == "home" else "2"),
                            f"{'Первый' if key == 'first' else 'Последний'} гол — {name}", hits=hits, n=len(rows), window="последние матчи", sample_rows=rows))
    return out


def rule_scores_first(event, ctx):
    return goal_order_rule(event, ctx, rule="scores_first", key="first", variant="next",
                           title=lambda n, h, t: f"{n} открывал счёт в {h} из {t} последних матчей")


def rule_last_goal(event, ctx):
    return goal_order_rule(event, ctx, rule="last_goal", key="last", variant="last",
                           title=lambda n, h, t: f"{n} забивал последний гол матча в {h} из {t} последних матчей")


def rule_early_goal(event, ctx):
    rows = pooled(ctx, "first")
    if not rows:
        return []
    out = []
    for market in [m for m in ins.find_markets(event, "goal_sequence", variant="interval") if m.get("param") == "1"]:
        for o in market["outcomes"]:
            match = re.match(r"^1-(\d+)$", (o.get("label") or "").strip())
            if not match:
                continue
            limit = int(match.group(1))
            hits = sum(1 for r in rows if r["first_min"] is not None and r["first_min"] <= limit)
            if hits / len(rows) >= 0.45:
                out.append(make("early_goal", f"Первый гол до {limit}-й минуты в {hits} из {len(rows)} последних матчей {two_names(ctx)}", market, o,
                                f"Первый гол на 1–{limit} минуте", hits=hits, n=len(rows), window="последние матчи обеих команд", sample_rows=rows))
    return out


# ----------------------------------------------------------------------------------------------------
# Player rules. ctx also has: players (records), apps (pl_id -> appearances newest first)
# ----------------------------------------------------------------------------------------------------

def appearances(details: dict[int, dict], matches_by_id: dict[int, dict]) -> dict[int, list[dict]]:
    """pl_id -> league appearances known from match detail pages (started or came on), newest first, with goals and
    whether the player scored the match's first / last goal."""
    apps: dict[int, list[dict]] = defaultdict(list)
    for mid, d in details.items():
        m = matches_by_id.get(mid)
        if not m:
            continue
        came_on = {s["person_id"] for s in d.get("substitutions") or [] if s.get("kind") == "ON"}
        all_goals = d.get("goals") or []
        own = [g for g in all_goals if g.get("kind") != "O"]
        for team_id, lineup in (d.get("lineups") or {}).items():
            team = int(team_id)
            opp = m["away"]["id"] if m["home"]["id"] == team else m["home"]["id"]
            for pid in (lineup.get("starters") or []) + [p for p in lineup.get("substitutes") or [] if p in came_on]:
                if pid is None:
                    continue
                apps[pid].append({"match": mid, "kickoff": m["kickoff_utc"] or "", "team": team, "opp": opp,
                                  "goals": sum(1 for g in own if g["person_id"] == pid),
                                  "first": bool(all_goals) and all_goals[0]["person_id"] == pid and all_goals[0].get("kind") != "O",
                                  "last": bool(all_goals) and all_goals[-1]["person_id"] == pid and all_goals[-1].get("kind") != "O"})
    for items in apps.values():
        items.sort(key=lambda a: a["kickoff"], reverse=True)
    return apps


def player_lines(event: dict, ctx: dict) -> list[dict]:
    """Winline player goal lines grouped per player, with our player record attached when the name matches."""
    grouped: dict[tuple, dict] = {}
    for market in event["markets"]:
        if market["family"] != "player_goal" or not market.get("subject") or not market["outcomes"]:
            continue
        subject = market["subject"]
        entry = grouped.setdefault((subject["team"], subject["name"]), {"name": subject["name"], "team": subject["team"], "markets": {}})
        entry["markets"][market["variant"]] = market
    for entry in grouped.values():
        entry["club"] = ctx["home"] if entry["team"] == "home" else ctx["away"]
        entry["player"] = ins.match_player(entry["name"], entry["club"], ctx["players"])
    return list(grouped.values())


POSITION_XG90 = {"D": 0.05, "M": 0.15, "F": 0.35}  # usual non-goalkeeper levels, used when there is no previous season
PRIOR_MINUTES = 900


def scoring_probability(player: dict) -> tuple[float, float, int, float] | None:
    """(chance to score, expected minutes, matches played, xG per 90 used). xG per 90 of this season (Opta via Fantasy)
    is blended with last season at half weight, or with the usual level of the position, so that a few weeks of
    numbers cannot make a defender look like a striker; expected minutes = average of the last five gameweeks
    (0 when he did not play); Poisson. Needs 270+ minutes this season; goalkeepers are skipped."""
    season = player.get("season_2026_27") or {}
    history = player.get("season_2026_27_by_gameweek") or []
    minutes = season.get("minutes") or 0
    if minutes < 270 or not history or player.get("position") not in POSITION_XG90:
        return None
    previous = next((p for p in reversed(player.get("past_seasons") or []) if (p.get("minutes") or 0) >= 450), None)
    if previous:
        prior_xg, prior_minutes = 0.5 * float(previous.get("expected_goals") or 0), 0.5 * previous["minutes"]
    else:
        prior_minutes = PRIOR_MINUTES
        prior_xg = POSITION_XG90[player["position"]] * prior_minutes / 90
    xg90 = (float(season.get("expected_goals") or 0) + prior_xg) / ((minutes + prior_minutes) / 90)
    last = history[-5:]
    expected_minutes = sum(r.get("minutes") or 0 for r in last) / len(last)
    probability = 1.0 - math.exp(-xg90 * expected_minutes / 90.0)
    return probability, expected_minutes, sum(1 for r in history if (r.get("minutes") or 0) > 0), xg90


XG_MIN_PROBABILITY = 0.2  # below that a 'value' price is mostly model noise on a defender
XG_MAX_ODDS = 8.0


def rule_player_xg_value(event, ctx):
    out = []
    for entry in player_lines(event, ctx):
        market, player = entry["markets"].get("anytime"), entry["player"]
        if not market or not player:
            continue
        model = scoring_probability(player)
        picked = ins.outcome(market, "yes")
        if not model or not picked:
            continue
        prob, mins, played, xg90 = model
        implied = 1.0 / picked["odds"]
        if prob < XG_MIN_PROBABILITY or picked["odds"] > XG_MAX_ODDS or prob / implied < 1.15:
            continue
        name = player.get("surname_ru") or entry["name"]
        title = (f"{name}: xG {ins.fmt_line(round(xg90, 2))} за 90 минут, в среднем {round(mins)} мин. в последних 5 турах — "
                 f"по модели шанс забить {round(prob * 100)}%, кэф подразумевает {round(implied * 100)}%")
        confidence = min(1.0, ((player.get("season_2026_27") or {}).get("minutes") or 0) / 900)
        card = ins.make_candidate("player_xg_value", title, {"sample": played, "hits": round(prob * played), "window": "сезон 2026/27, xG Opta (Fantasy)"},
                                  market, picked, f"{name} забьёт", weight=0.7, tags=[f"модель {round(prob * 100)}%", f"цена {round(implied * 100)}%"],
                                  details={"player_id": player["pl_id"], "xg_per_90": round(xg90, 3), "expected_minutes": round(mins)},
                                  rate_low=prob * (0.75 + 0.25 * confidence), wow=0.5 if prob / implied >= 1.4 else 0.2)
        out.append(finish(card))
    return out


def rule_player_vs_opponent(event, ctx):
    out = []
    since = ins.days_before(ctx["before"], 6 * 366)
    for entry in player_lines(event, ctx):
        market, player = entry["markets"].get("anytime"), entry["player"]
        if not market or not player:
            continue
        opp = ctx["away"] if entry["club"] == ctx["home"] else ctx["home"]
        apps = [a for a in ctx["apps"].get(player["pl_id"], []) if a["opp"] == opp and since <= a["kickoff"] < ctx["before"]][:8]
        if len(apps) < 4:
            continue
        hits = sum(1 for a in apps if a["goals"] > 0)
        if hits / len(apps) < 0.5:
            continue
        name = player.get("surname_ru") or entry["name"]
        out.append(make("player_vs_opponent", f"{name} забивал {ctx['names'][opp]} в {hits} из {len(apps)} последних встреч", market,
                        ins.outcome(market, "yes"), f"{name} забьёт", hits=hits, n=len(apps), window="встречи с этим соперником",
                        weight=0.7, details={"player_id": player["pl_id"], "goals": [a["goals"] for a in apps]}))
    return out


def rule_player_first_scorer(event, ctx):
    out = []
    since = ins.days_before(ctx["before"], 420)
    for entry in player_lines(event, ctx):
        player = entry["player"]
        if not player:
            continue
        apps = [a for a in ctx["apps"].get(player["pl_id"], []) if since <= a["kickoff"] < ctx["before"]][:20]
        if len(apps) < 8:
            continue
        name = player.get("surname_ru") or entry["name"]
        for variant, text in (("first", "первый"), ("last", "последний")):
            market = entry["markets"].get(variant)
            if not market:
                continue
            hits = sum(1 for a in apps if a[variant])
            if hits / len(apps) >= 0.2:
                out.append(make("player_first_scorer", f"{name} забивал {text} гол матча в {hits} из {len(apps)} последних матчей", market,
                                ins.outcome(market, "yes"), f"{name} забьёт {text} гол", hits=hits, n=len(apps), window="матчи за год", weight=0.6,
                                details={"player_id": player["pl_id"]}))
    return out


ENGINE_RULES = (
    rule_form_win_rate, rule_venue_form, rule_win_to_nil, rule_clean_sheet, rule_handicap_margin, rule_match_total_form, rule_btts_form,
    rule_team_goals_bucket, rule_first_half_total, rule_team_first_half_goal, rule_second_half_heavier, rule_scores_both_halves,
    rule_wins_a_half, rule_half_time_lead, rule_scores_first, rule_last_goal, rule_early_goal, rule_corners_total_form,
    rule_cards_total_form, rule_player_xg_value, rule_player_vs_opponent, rule_player_first_scorer,
)


DOUBT_PENALTY = 10


def availability(player: dict | None) -> str:
    """'out' (Fantasy: injured, suspended, gone, or under 50% to play), 'doubt' (50-75%) or 'ok'."""
    season = (player or {}).get("season_2026_27") or {}
    status, chance = season.get("status"), season.get("chance_of_playing_next_round")
    if status in ("i", "s", "u", "n") or (chance is not None and chance < 50):
        return "out"
    if status == "d" or (chance is not None and chance < 100):
        return "doubt"
    return "ok"


def build_cards(event: dict, ctx: dict) -> list[dict]:
    """Every card for one match, strongest first: the same fact on several lines = one card with alternatives;
    at most PER_RULE_LIMIT per rule and MATCH_LIMIT per match. No player card for a player Fantasy lists as out;
    a doubtful one loses DOUBT_PENALTY points and gets the tag «под вопросом»."""
    candidates = []
    for rule in ins.RULES:
        candidates += [finish(c) for c in rule(event, ctx)]
    for rule in ENGINE_RULES:
        candidates += rule(event, ctx)
    players = {p["pl_id"]: p for p in ctx.get("players") or []}
    seen, grouped = set(), {}
    for card in candidates:
        if not card:
            continue
        pid = (card.get("details") or {}).get("player_id")
        if pid is not None:
            fit = availability(players.get(pid))
            if fit == "out":
                continue
            if fit == "doubt":
                card = finish({**card, "score": max(0, card["score"] - DOUBT_PENALTY), "tags": [*card.get("tags", []), "под вопросом"]})
        key = (card["rule"], card["market"]["key"])
        if key in seen:
            continue
        seen.add(key)
        grouped.setdefault((card["rule"], card["title"]), []).append(card)
    cards = []
    for group in grouped.values():
        group.sort(key=lambda c: -c["score"])
        best = dict(group[0])
        best["alternatives"] = [{"label": c["market"]["label"], "odds": c["market"]["odds"], "line": c["market"]["line"], "score": c["score"],
                                 "market_id": c["market"]["market_id"], "key": c["market"]["key"]} for c in group[1:]]
        cards.append(best)
    cards.sort(key=lambda c: (-c["score"], -c["evidence"]["sample"]))
    per_rule, out = Counter(), []
    for card in cards:
        if per_rule[card["rule"]] >= PER_RULE_LIMIT:
            continue
        per_rule[card["rule"]] += 1
        out.append(card)
    return out[:MATCH_LIMIT]


# ----------------------------------------------------------------------------------------------------
# Boards for the "Команды" and "Игроки" pages
# ----------------------------------------------------------------------------------------------------

def share(hits: int, n: int) -> float | None:
    return round(hits / n, 3) if n else None


def mean(values: list[float]) -> float | None:
    return round(sum(values) / len(values), 2) if values else None


def team_profile(rows_all: list[dict], before: str, xg: dict[int, dict[int, float]], club: int) -> dict:
    """The club's last eight league matches in numbers (form, goals, halves, order, corners, cards, model xG)."""
    since = ins.days_before(before, ins.FORM_DAYS)
    rows = [r for r in reversed(rows_all) if since <= r["kickoff"] < before][:FORM_N]
    n = len(rows)
    halves = [r for r in rows if r["ht"] is not None]
    order = [r for r in rows if r["first"] not in (None, "none")]
    stats_rows = [r for r in rows if r["corners"] is not None]
    xg_rows = [((xg.get(r["id"]) or {}).get(club), (xg.get(r["id"]) or {}).get(r["opp"])) for r in rows]
    unbeaten = 0
    for r in rows:
        if r["gf"] < r["ga"]:
            break
        unbeaten += 1
    return {
        "matches": n, "form": "".join("W" if r["gf"] > r["ga"] else "D" if r["gf"] == r["ga"] else "L" for r in rows[:5]),
        "wins": sum(1 for r in rows if r["gf"] > r["ga"]), "draws": sum(1 for r in rows if r["gf"] == r["ga"]),
        "losses": sum(1 for r in rows if r["gf"] < r["ga"]), "unbeaten_run": unbeaten,
        "goals_for": mean([r["gf"] for r in rows]), "goals_against": mean([r["ga"] for r in rows]),
        "over_2_5": share(sum(1 for r in rows if r["gf"] + r["ga"] > 2.5), n), "btts": share(sum(1 for r in rows if r["gf"] and r["ga"]), n),
        "clean_sheets": share(sum(1 for r in rows if r["ga"] == 0), n), "failed_to_score": share(sum(1 for r in rows if r["gf"] == 0), n),
        "first_half_goals": mean([sum(r["ht"]) for r in halves]), "second_half_goals": mean([sum(r["h2"]) for r in halves]),
        "scores_first": share(sum(1 for r in order if r["first"] == "for"), len(order)),
        "corners_for": mean([r["corners"][0] for r in stats_rows]), "corners_against": mean([r["corners"][1] for r in stats_rows]),
        "cards": mean([r["cards"][0] for r in stats_rows]),
        "xg_for": mean([a for a, _ in xg_rows if a is not None]), "xg_against": mean([b for _, b in xg_rows if b is not None]),
    }


INJURY_RU = {
    "knee": "колена", "hamstring": "задней поверхности бедра", "thigh": "бедра", "ankle": "голеностопа", "calf": "икры",
    "back": "спины", "shoulder": "плеча", "leg": "ноги", "foot": "стопы", "groin": "паха", "arm": "руки", "achilles": "ахилла",
    "shin": "голени", "hip": "тазобедренного сустава", "head": "головы", "neck": "шеи", "toe": "пальца ноги", "wrist": "запястья",
}
MONTHS_RU = {"jan": "января", "feb": "февраля", "mar": "марта", "apr": "апреля", "may": "мая", "jun": "июня", "jul": "июля",
             "aug": "августа", "sep": "сентября", "oct": "октября", "nov": "ноября", "dec": "декабря"}


def news_ru(text: str | None) -> str | None:
    """Fantasy's English injury news in Russian for the operators ("Knee injury - Unknown return date" →
    "Травма колена — срок возвращения неизвестен"); an unknown wording stays as it is."""
    if not text:
        return None
    date = lambda d, m: f"{int(d)} {MONTHS_RU.get(m[:3].lower(), m)}"
    match = re.match(r"^(?:(\w+) injury|Knock|Illness)\s*-\s*(.+)$", text.strip(), re.I)
    if match:
        part = (match.group(1) or "").lower()
        head = ("Ушиб" if text.lower().startswith("knock") else "Болезнь" if text.lower().startswith("illness")
                else f"Травма {INJURY_RU[part]}" if part in INJURY_RU else "Травма" if part == "unspecified" else None)
        tail = match.group(2)
        if head:
            if (m := re.match(r"^(\d+)% chance of playing$", tail, re.I)):
                return f"{head} — шанс сыграть {m.group(1)}%"
            if (m := re.match(r"^Expected back (\d+) (\w+)$", tail, re.I)):
                return f"{head} — ожидается к {date(m.group(1), m.group(2))}"
            if re.match(r"^Unknown return date$", tail, re.I):
                return f"{head} — срок возвращения неизвестен"
    if (m := re.match(r"^Suspended until (\d+) (\w+)$", text.strip(), re.I)):
        return f"Дисквалификация до {date(m.group(1), m.group(2))}"
    if (m := re.match(r"^Has joined (.+?) on loan", text.strip(), re.I)):
        return f"Ушёл в аренду в {m.group(1)}"
    if re.match(r"^not included in squad", text.strip(), re.I):
        return "Не включён в заявку"
    return text


def player_board_rows(event: dict, ctx: dict, cards: list[dict]) -> list[dict]:
    """Every player Winline prices for the match: odds, our record, model chance vs price, best card."""
    best = {}
    for card in cards:
        pid = (card.get("details") or {}).get("player_id")
        if pid is not None and (pid not in best or card["score"] > best[pid]["score"]):
            best[pid] = card
    rows = []
    for entry in player_lines(event, ctx):
        player = entry["player"]
        row = {"name": entry["name"], "team": entry["team"], "club": ctx["names"][entry["club"]],
               "odds": {variant: m["outcomes"][0]["odds"] for variant, m in entry["markets"].items()}}
        anytime = entry["markets"].get("anytime")
        if player:
            season = player.get("season_2026_27") or {}
            opp = ctx["away"] if entry["club"] == ctx["home"] else ctx["home"]
            vs = [a for a in ctx["apps"].get(player["pl_id"], []) if a["opp"] == opp and a["kickoff"] < ctx["before"]][:8]
            row.update({"pl_id": player["pl_id"], "name_ru": player.get("name_ru"), "position": player.get("position"), "fit": availability(player),
                        "goals": season.get("goals_scored"), "xg": season.get("expected_goals"), "xg90": season.get("expected_goals_per_90"),
                        "minutes": season.get("minutes"), "penalty_taker": season.get("penalties_order") == 1, "news": news_ru(season.get("news")),
                        "last5": [r.get("goals_scored") for r in (player.get("season_2026_27_by_gameweek") or [])[-5:]],
                        "vs_opponent": {"apps": len(vs), "scored_in": sum(1 for a in vs if a["goals"] > 0)}})
            model = scoring_probability(player)
            if model and anytime:
                implied = 1.0 / anytime["outcomes"][0]["odds"]
                row.update({"model_prob": round(model[0], 3), "implied_prob": round(implied, 3), "value": round(model[0] / implied, 2)})
            card = best.get(player["pl_id"])
            if card:
                row.update({"tier": card["tier"], "tier_label": card["tier_label"], "score": card["score"], "best_card": card["title"]})
        rows.append(row)
    rows.sort(key=lambda r: (-(r.get("score") or 0), -(r.get("value") or 0)))
    return rows
