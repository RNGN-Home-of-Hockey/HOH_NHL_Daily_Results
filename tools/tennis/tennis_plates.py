#!/usr/bin/env python3
"""Draft plates for WTA matches on Winline's line: facts, and prices they can stand next to.

Follows the hockey pipeline in docs/BETTING_INSIGHT_ENGINE.md: signal, evidence with its sample,
a real price, an editor who decides. A trial on 787 finished matches found no proven edge in
history against this market, so a plate states what happened and the price, never that a bet is
good. The gate below only picks what is worth an editor's look.

    python tools/tennis/tennis_plates.py
    python tools/tennis/tennis_plates.py --date 2026-11-05
    python tools/tennis/tennis_plates.py --player Саснович --json
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sqlite3
import sys
import unicodedata
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

DEFAULT_DB = Path(__file__).resolve().parents[2] / "local-data" / "tennis" / "tennis.sqlite"
MIN_ODDS = 1.50  # as the hockey selector
MAX_ODDS = 3.50
MIN_SAMPLE = 10
MIN_HIT = 0.60
SURFACE_MONTHS = 24
SURFACE_LIMIT = 20
FORM_MONTHS = 12
FORM_LIMIT = 10
Z90 = 1.2816
MAX_LINE_CARDS = 3
MIN_PRICED = 5
MIN_ROLE = 8
ROLE_LIMIT = 100
RESULTS_LIMIT = 20
TOURS = ("WTA", "ATP")
SURFACE_RU = {"hard": "харде", "clay": "грунте", "grass": "траве", "carpet": "ковре"}


def wilson_low(hits: int, n: int) -> float:
    if not n:
        return 0.0
    p = hits / n
    d = 1 + Z90 ** 2 / n
    return (p + Z90 ** 2 / (2 * n) - Z90 * math.sqrt(p * (1 - p) / n + Z90 ** 2 / (4 * n * n))) / d


def fair_price(mine: float, other: float) -> float:
    """What the market expects of this side, the bookmaker's margin taken out."""
    return (1 / mine) / (1 / mine + 1 / other)


def folded(text: str) -> str:
    plain = unicodedata.normalize("NFKD", text.replace("ё", "е").replace("Ё", "Е")).lower()
    return "".join(c for c in plain if c.isalpha() and not unicodedata.combining(c))


def games_of(score: str | None) -> list[tuple[int, int]]:
    return [(int(a), int(b)) for a, b in re.findall(r"(\d+)-(\d+)", re.sub(r"\(\d+\)", "", score or ""))]


def load_history(db: sqlite3.Connection) -> dict:
    """Singles results by WTA id, newest first. Walkovers are not matches; a retirement counts for
    the result but not for games, as it was cut short."""
    players = defaultdict(list)
    for winner, loser, score, status, played, surface, event, winner_name, loser_name, winner_price, loser_price, handicap, total_line in db.execute(
            """SELECT m.winner_id, m.loser_id, m.score, m.status, COALESCE(m.match_date, t.start_date), t.surface, t.name,
                      w.full_name, l.full_name, x.winner_price, x.loser_price, x.handicap, x.total
               FROM wta_match m JOIN wta_tournament t ON t.group_id = m.group_id AND t.year = m.year
               LEFT JOIN wta_player w ON w.player_id = m.winner_id LEFT JOIN wta_player l ON l.player_id = m.loser_id
               LEFT JOIN wta_match_line x ON x.match_key = m.match_key
               WHERE m.discipline = 'S' AND m.status IN ('completed', 'retired')
                 AND m.winner_id IS NOT NULL AND m.loser_id IS NOT NULL"""):
        sets = games_of(score)
        base = {"date": played, "surface": (surface or "").lower(), "full": status == "completed",
                "total": sum(a + b for a, b in sets), "score": score, "tournament": event, "status": status, "total_line": total_line}
        margin = sum(a - b for a, b in sets)
        players[winner].append({**base, "won": True, "margin": margin, "opp": loser, "own_name": winner_name, "opp_name": loser_name,
                                "price": winner_price, "opp_price": loser_price, "own_handicap": handicap})
        players[loser].append({**base, "won": False, "margin": -margin, "opp": winner, "own_name": loser_name, "opp_name": winner_name,
                               "price": loser_price, "opp_price": winner_price, "own_handicap": None if handicap is None else -handicap})
    for rows in players.values():
        rows.sort(key=lambda r: r["date"] or "", reverse=True)
    return players


def load_atp_history(db: sqlite3.Connection, tour: str = "ATP") -> dict:
    """The men's tour from tennis-data until it has a collector of its own: tour-level main draws,
    closing prices on the winner, no handicap or total of the match. Same row shape as load_history."""
    from wta_lines import td_price  # noqa: PLC0415 - wta_lines imports this module
    players = defaultdict(list)
    for winner, loser, played, surface, event, sets_json, comment, odds in db.execute(
            """SELECT winner, loser, match_date, surface, tournament, sets_json, comment, odds_json FROM td_match
               WHERE tour = ? AND comment IN ('Completed', 'Retired') AND match_date IS NOT NULL""", (tour,)):
        sets = json.loads(sets_json) if sets_json else []
        margin = sum(a - b for a, b in sets)
        full = comment == "Completed"
        price = td_price(odds) or {}
        base = {"date": played, "surface": (surface or "").lower(), "full": full, "total": sum(a + b for a, b in sets),
                "score": "  ".join(f"{a}-{b}" for a, b in sets), "tournament": event, "status": "completed" if full else "retired",
                "total_line": None, "own_handicap": None}
        key_w, key_l = td_key(winner), td_key(loser)
        players[key_w].append({**base, "won": True, "margin": margin, "opp": key_l, "own_name": winner, "opp_name": loser,
                               "price": price.get("winner_price"), "opp_price": price.get("loser_price")})
        players[key_l].append({**base, "won": False, "margin": -margin, "opp": key_w, "own_name": loser, "opp_name": winner,
                               "price": price.get("loser_price"), "opp_price": price.get("winner_price")})
    for rows in players.values():
        rows.sort(key=lambda r: r["date"] or "", reverse=True)
    return players


def recent(rows: list[dict], cutoff: str, surface=None, months=SURFACE_MONTHS, limit=SURFACE_LIMIT) -> list[dict]:
    since = (date.fromisoformat(cutoff) - timedelta(days=30 * months)).isoformat()
    found = [r for r in rows if r["date"] and since <= r["date"] < cutoff and (not surface or r["surface"] == surface)]
    return found[:limit]


def td_key(name: str) -> str:
    """A tennis-data name as a player's key: there are no ids in those files."""
    words = name.replace(",", " ").split()
    initials = [w for w in words if w.endswith(".")]
    return f"{folded(' '.join(w for w in words if not w.endswith('.')))}|{folded(initials[0])[:1] if initials else ''}"


def atp_key(latin: str | None) -> str | None:
    words = (latin or "").split()
    return f"{folded(' '.join(words[1:]))}|{folded(words[0])[:1]}" if len(words) >= 2 else None


def player_key(tour: str, wta_id, latin):
    if tour == "WTA":
        return int(wta_id) if wta_id else None
    return atp_key(latin)


def player_index(db: sqlite3.Connection, tour: str = "WTA") -> dict:
    """(surname, initial) -> player keys, from BOLSHE's Russian names. Winline writes 'Саснович А.'."""
    index = defaultdict(set)
    for name, wta_id, latin in db.execute("SELECT name_ru, wta_id, name_latin FROM player WHERE name_ru IS NOT NULL AND tour = ?", (tour,)):
        words = name.split()
        key = player_key(tour, wta_id, latin)
        if len(words) >= 2 and key:
            index[(folded(" ".join(words[1:])), folded(words[0])[:1])].add(key)
    return index


def find_wta_id(team: str | None, index: dict) -> int | None:
    """Only a single candidate counts: a wrong player on air is worse than no plate."""
    words = (team or "").split()
    initials = [w for w in words if w.endswith(".")]
    surname = folded(" ".join(w for w in words if not w.endswith(".")))
    if not surname or not initials:
        return None
    found = index.get((surname, folded(initials[0])[:1]), set())
    return next(iter(found)) if len(found) == 1 else None


def learned_players(db: sqlite3.Connection, names: dict, tour: str = "WTA") -> dict:
    """Winline player id -> WTA id, from matches BOLSHE has already tied to Winline. Its two players
    may be in the other order, which the prices tell, or a name when the prices are level. An id
    that ever points at two players is dropped."""
    learned = defaultdict(set)
    for team1, team2, name1, name2, odd1, odd2, pre1, pre2, wta1, wta2, latin1, latin2 in db.execute(
            """SELECT e.team1_id, e.team2_id, e.team1, e.team2, l.odd1, l.odd2, o.pre1, o.pre2, a.wta_id, b.wta_id, a.name_latin, b.name_latin
               FROM winline_event e
               JOIN match_odds o ON o.wl_id = e.wl_id JOIN match m ON m.match_id = o.match_id
               JOIN player a ON a.fs_id = m.p1_fs_id JOIN player b ON b.fs_id = m.p2_fs_id
               JOIN winline_line l ON l.wl_id = e.wl_id AND l.market = 'Победитель'
               WHERE a.tour = ? AND o.pre1 IS NOT NULL AND e.is_doubles = 0
               GROUP BY e.wl_id""", (tour,)):
        id1, id2 = player_key(tour, wta1, latin1), player_key(tour, wta2, latin2)
        if not id1 or not id2:
            continue
        straight = abs(odd1 - pre1) + abs(odd2 - pre2)
        crossed = abs(odd1 - pre2) + abs(odd2 - pre1)
        if straight == crossed or pre1 == pre2:
            known = find_wta_id(name1, names) or find_wta_id(name2, names)
            if known not in (id1, id2):
                continue
            first = known if find_wta_id(name1, names) == known else (id1 if known == id2 else id2)
        else:
            first = id1 if straight < crossed else id2
        second = id2 if first == id1 else id1
        if team1 and team2:
            learned[team1].add(first)
            learned[team2].add(second)
    return {wl: next(iter(ids)) for wl, ids in learned.items() if len(ids) == 1}


def surface_index(db: sqlite3.Connection, tour: str = "WTA") -> dict:
    """City -> surface, newest event winning, from BOLSHE's directory. Winline's feed has no surface."""
    index = {}
    for city, surface in db.execute(
            "SELECT tournament, surface FROM tournament WHERE tour = ? AND surface IS NOT NULL AND tournament IS NOT NULL ORDER BY first_seen", (tour,)):
        index[folded(city)] = surface.lower()
    return index


def surface_of(tournament: str | None, index: dict) -> str | None:
    return index.get(folded((tournament or "").split(",")[0]))


def record(rows: list[dict]) -> tuple[int, int]:
    wins = sum(r["won"] for r in rows)
    return wins, len(rows) - wins


def priced_record(rows: list[dict]) -> dict | None:
    """Results read against the price of the same match: as favourite and as underdog."""
    priced = [r for r in rows if r.get("price") and r.get("opp_price") and r["price"] != r["opp_price"]]
    if not priced:
        return None
    favourite = [r for r in priced if r["price"] < r["opp_price"]]
    underdog = [r for r in priced if r["price"] > r["opp_price"]]
    return {"n": len(priced), "favourite": record(favourite), "underdog": record(underdog)}


def priced_words(found: dict) -> str:
    return f"фаворитом {found['favourite'][0]}-{found['favourite'][1]}, андердогом {found['underdog'][0]}-{found['underdog'][1]}"


def fact_cards(event: dict, hist: dict, form: dict, h2h: list[dict], surface: str | None) -> list[dict]:
    """What can be said whatever the line. No gate beyond a minimum of matches."""
    cards = []
    names = {1: event["team1"], 2: event["team2"]}
    for side in (1, 2):
        if len(form[side]) >= 5:
            wins, losses = record(form[side])
            cards.append({"kind": "form", "side": side, "hits": wins, "n": wins + losses,
                          "what": f"Победы и поражения за {FORM_MONTHS} месяцев, на всех покрытиях.",
                          "text": f"{names[side]}: {wins}-{losses} в последних {wins + losses} матчах"})
        if surface and len(hist[side]) >= MIN_SAMPLE:
            wins, losses = record(hist[side])
            cards.append({"kind": "surface", "side": side, "hits": wins, "n": wins + losses,
                          "what": f"Победы и поражения только на этом покрытии, не больше {SURFACE_LIMIT} матчей за {SURFACE_MONTHS // 12} года.",
                          "text": f"{names[side]}: {wins}-{losses} в последних {wins + losses} матчах на {SURFACE_RU.get(surface, surface)}"})
        found = priced_record(hist[side])
        if found and found["n"] >= MIN_PRICED:
            cards.append({"kind": "priced", "side": side, "hits": found["favourite"][0] + found["underdog"][0], "n": found["n"],
                          "what": f"По цене каждого из этих матчей: кто был фаворитом у букмекеров тогда. Цены известны для {found['n']} матчей.",
                          "text": f"{names[side]}: {priced_words(found)}"})
        done = [r for r in hist[side] if r.get("full")]
        capped = [r for r in done if r.get("own_handicap") is not None and r["margin"] + r["own_handicap"] != 0]
        if len(capped) >= MIN_PRICED:
            hits = sum(r["margin"] + r["own_handicap"] > 0 for r in capped)
            cards.append({"kind": "own_handicap", "side": side, "hits": hits, "n": len(capped),
                          "what": "Фора бралась та, что стояла на тот самый матч, а не сегодняшняя.",
                          "text": f"{names[side]}: своя фора сыграла в {hits} из {len(capped)}"})
        totalled = [r for r in done if r.get("total_line") is not None and r["total"] != r["total_line"]]
        if len(totalled) >= MIN_PRICED:
            over = sum(r["total"] > r["total_line"] for r in totalled)
            cards.append({"kind": "own_total", "side": side, "hits": over, "n": len(totalled),
                          "what": "Тотал брался тот, что стоял на тот самый матч, а не сегодняшний.",
                          "text": f"{names[side]}: свой тотал, больше {over}, меньше {len(totalled) - over}"})
    if h2h:
        first, second = record(h2h)
        if first == second:
            text = f"Личные встречи: {first}-{second}"
        else:
            leader = names[1] if first > second else names[2]
            text = f"Личные встречи: {leader} ведёт {max(first, second)}-{min(first, second)}"
        cards.append({"kind": "h2h", "side": None, "hits": first, "n": first + second, "text": text})
    return cards


def priced(side_price: float, other_price: float, hits: int, n: int, min_n: int = MIN_SAMPLE, min_hit: float = MIN_HIT) -> dict | None:
    """The gate: a real price in range, enough matches, and a record above what the price expects."""
    if not (MIN_ODDS <= side_price <= MAX_ODDS) or n < min_n or hits / n < min_hit:
        return None
    fair, low = fair_price(side_price, other_price), wilson_low(hits, n)
    if low <= fair:
        return None
    return {"price": side_price, "market_expects": round(fair, 3), "hits": hits, "n": n,
            "low": round(low, 3), "score": round(low - fair, 3)}


def scope_words(surface: str | None) -> str:
    place = f"на {SURFACE_RU.get(surface, surface)} " if surface else ""
    return f"{place}за {SURFACE_MONTHS // 12} года"


def reason_words(gate: dict) -> str:
    """Why this line was picked, in the words an editor can check against the numbers."""
    return (f"Цена {gate['price']} значит, что рынок ждёт такого исхода примерно в {round(gate['market_expects'] * 100)} % случаев "
            f"(маржа букмекера убрана). По этой истории даже осторожная оценка даёт {round(gate['low'] * 100)} %, "
            "это выше, поэтому строка попала в отбор. Это описание прошлого, а не прогноз: соперники в этих матчах были другие.")


def evidence_row(row: dict, player: str, hit: bool, note: str) -> dict:
    return {"date": row["date"], "player": player, "opponent": row.get("opp_name"), "score": row.get("score"),
            "tournament": row.get("tournament"), "won": row["won"], "hit": hit, "note": note,
            "price": row.get("price"), "opp_price": row.get("opp_price")}


def same_role(rows: list[dict], favourite: bool) -> list[dict]:
    """Past matches with a known price where the player was in the role she or he has today."""
    return [r for r in rows if r.get("price") and r.get("opp_price") and r["price"] != r["opp_price"]
            and (r["price"] < r["opp_price"]) == favourite]


def line_cards(event: dict, lines: list[dict], hist: dict, surface: str | None = None) -> list[dict]:
    """A plate next to a price, for the match winner only, on both tours. A record counts only in the
    role of today: an underdog is judged by matches as an underdog, each at the price it had then."""
    names = {1: event["team1"], 2: event["team2"]}
    scope = scope_words(surface)
    best = None
    for line in lines:
        if line["market"] != "Победитель":
            continue
        for side, mine, other in ((1, line["odd1"], line["odd2"]), (2, line["odd2"], line["odd1"])):
            if mine == other:
                continue
            favourite = mine < other
            role = "фаворит" if favourite else "андердог"
            played = same_role(hist[side], favourite)
            wins = sum(r["won"] for r in played)
            gate = priced(mine, other, wins, len(played), MIN_ROLE, 0.0)
            if not gate or (best and gate["score"] <= best["score"]):
                continue
            what = f"Сегодня {names[side]}: {role}. В этой роли {scope}: побед {wins} из {len(played)}, по цене каждого матча."
            best = {"kind": "line", "family": "winner", "text": f"Победа {names[side]} — {mine}", **gate, "what": what, "why": reason_words(gate),
                    "matches": [evidence_row(r, names[side], r["won"], "победа" if r["won"] else "поражение") for r in played]}
    return [best] if best else []


def resolve(side_id, team, ids: dict, learned: dict):
    return learned.get(side_id) or find_wta_id(team, ids)


def build(event: dict, lines: list[dict], players: dict, player_ids: dict, surfaces: dict, learned: dict | None = None) -> dict:
    cutoff = (event["start_at"] or "")[:10]
    learned = learned or {}
    id1 = resolve(event.get("team1_id"), event["team1"], player_ids, learned)
    id2 = resolve(event.get("team2_id"), event["team2"], player_ids, learned)
    result = {"wl_id": event["wl_id"], "tournament": event["tournament"], "start_at": event["start_at"],
              "team1": event["team1"], "team2": event["team2"], "url": event["url"], "linked": bool(id1 and id2),
              "facts": [], "lines": [], "notes": [], "form_rows": {1: [], 2: []}, "h2h_rows": []}
    if not (id1 and id2 and cutoff):
        result["notes"].append("нет однозначной связи с игроками в базе")
        return result
    surface = surface_of(event["tournament"], surfaces)
    if not surface:
        result["notes"].append("покрытие турнира неизвестно: нужен свежий справочник BOLSHE")
    rows = {1: players.get(id1, []), 2: players.get(id2, [])}
    hist = {side: recent(rows[side], cutoff, surface) if surface else [] for side in (1, 2)}
    form = {side: recent(rows[side], cutoff, None, FORM_MONTHS, FORM_LIMIT) for side in (1, 2)}
    h2h = [r for r in rows[1] if r["opp"] == id2 and r["date"] and r["date"] < cutoff]
    result["facts"] = fact_cards(event, hist, form, h2h, surface)
    pool = {side: recent(rows[side], cutoff, surface, limit=ROLE_LIMIT) if surface else [] for side in (1, 2)}
    result["lines"] = line_cards(event, lines, pool, surface)
    result["surface"] = surface
    result["form_rows"] = {side: recent(rows[side], cutoff, None, 120, RESULTS_LIMIT) for side in (1, 2)}
    result["h2h_rows"] = h2h[:30]
    return result


@dataclass
class Tour:
    """What the same engine needs for one tour; only where the history comes from differs."""

    players: dict
    ids: dict
    surfaces: dict
    learned: dict


def load_tour(db: sqlite3.Connection, tour: str) -> Tour:
    ids = player_index(db, tour)
    players = load_history(db) if tour == "WTA" else load_atp_history(db)
    return Tour(players, ids, surface_index(db, tour), learned_players(db, ids, tour))


def upcoming(db: sqlite3.Connection, day: str | None, player: str | None) -> list[dict]:
    """Singles of both tours still to start, from the last prices seen."""
    db.row_factory = sqlite3.Row
    last = db.execute("SELECT MAX(taken_at) FROM winline_fetch").fetchone()[0]
    events = [dict(r) for r in db.execute(
        """SELECT * FROM winline_event WHERE circuit IN ('WTA', 'ATP') AND is_doubles = 0 AND last_seen = ? ORDER BY start_at""", (last,))]
    lines = defaultdict(list)
    for row in db.execute("SELECT * FROM winline_current"):
        lines[row["wl_id"]].append(dict(row))
    db.row_factory = None
    if day:
        events = [e for e in events if (e["start_at"] or "").startswith(day)]
    if player:
        wanted = folded(player)
        events = [e for e in events if wanted in folded(e["team1"] or "") or wanted in folded(e["team2"] or "")]
    return [{**e, "lines": lines.get(e["wl_id"], [])} for e in events]


def coverage_note(db: sqlite3.Connection) -> str:
    pages = db.execute("SELECT COUNT(*) FROM wta_parsed WHERE kind = 'player_matches'").fetchone()[0]
    if pages:
        return ""
    return "История пока только из списков турниров: тур и WTA 125 с 2016 года, без ITF и Больших шлемов до 2025."


def show(results: list[dict]) -> None:
    for r in results:
        print(f"\n{(r['start_at'] or '')[:16].replace('T', ' ')} | {r['tournament']}")
        print(f"  {r['team1']} — {r['team2']}")
        for note in r["notes"]:
            print(f"  ! {note}")
        for card in r["facts"]:
            print(f"  факт: {card['text']}")
        for card in r["lines"]:
            print(f"  линия: {card['text']} | {card['hits']} из {card['n']}, рынок ждёт {100 * card['market_expects']:.0f}%")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--date", help="YYYY-MM-DD of the match")
    parser.add_argument("--player", help="part of a player's name as Winline writes it")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    db = sqlite3.connect(f"{args.db.resolve().as_uri()}?mode=ro", uri=True, timeout=30)
    tours = {tour: load_tour(db, tour) for tour in TOURS}
    results = []
    for e in upcoming(db, args.date, args.player):
        tour = tours[e["circuit"]]
        results.append(build(e, e["lines"], tour.players, tour.ids, tour.surfaces, tour.learned))
    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=1))
        return 0
    note = coverage_note(db)
    if note:
        print(note)
    linked = sum(r["linked"] for r in results)
    print(f"Матчей WTA в линии: {len(results)}, связаны с игроками: {linked}, с линией для плашки: {sum(bool(r['lines']) for r in results)}")
    show(results)
    return 0


if __name__ == "__main__":
    sys.exit(main())
