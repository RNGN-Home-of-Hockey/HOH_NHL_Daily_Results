#!/usr/bin/env python3
"""Draft plates for WTA matches on Winline's line: facts, and prices they can stand next to.

Follows the hockey pipeline in docs/BETTING_INSIGHT_ENGINE.md: signal, evidence with its sample,
a real price, an editor who decides. A trial on 787 finished matches found no proven edge in
history against this market, so a plate states what happened and the price, never that a bet is
good. The gate below only picks what is worth an editor's look.

    python tools/tennis/wta_plates.py
    python tools/tennis/wta_plates.py --date 2026-11-05
    python tools/tennis/wta_plates.py --player Саснович --json
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
    for winner, loser, score, status, played, surface in db.execute(
            """SELECT m.winner_id, m.loser_id, m.score, m.status, COALESCE(m.match_date, t.start_date), t.surface
               FROM wta_match m JOIN wta_tournament t ON t.group_id = m.group_id AND t.year = m.year
               WHERE m.discipline = 'S' AND m.status IN ('completed', 'retired')
                 AND m.winner_id IS NOT NULL AND m.loser_id IS NOT NULL"""):
        sets = games_of(score)
        base = {"date": played, "surface": (surface or "").lower(), "full": status == "completed",
                "total": sum(a + b for a, b in sets)}
        margin = sum(a - b for a, b in sets)
        players[winner].append({**base, "won": True, "margin": margin, "opp": loser})
        players[loser].append({**base, "won": False, "margin": -margin, "opp": winner})
    for rows in players.values():
        rows.sort(key=lambda r: r["date"] or "", reverse=True)
    return players


def recent(rows: list[dict], cutoff: str, surface=None, months=SURFACE_MONTHS, limit=SURFACE_LIMIT) -> list[dict]:
    since = (date.fromisoformat(cutoff) - timedelta(days=30 * months)).isoformat()
    found = [r for r in rows if r["date"] and since <= r["date"] < cutoff and (not surface or r["surface"] == surface)]
    return found[:limit]


def player_index(db: sqlite3.Connection) -> dict:
    """(surname, initial) -> WTA ids, from BOLSHE's Russian names. Winline writes 'Саснович А.'."""
    index = defaultdict(set)
    for name, wta_id in db.execute("SELECT name_ru, wta_id FROM player WHERE wta_id IS NOT NULL AND name_ru IS NOT NULL AND tour = 'WTA'"):
        words = name.split()
        if len(words) >= 2:
            index[(folded(" ".join(words[1:])), folded(words[0])[:1])].add(int(wta_id))
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


def learned_players(db: sqlite3.Connection, names: dict) -> dict:
    """Winline player id -> WTA id, from matches BOLSHE has already tied to Winline. Its two players
    may be in the other order, which the prices tell, or a name when the prices are level. An id
    that ever points at two players is dropped."""
    learned = defaultdict(set)
    for team1, team2, name1, name2, odd1, odd2, pre1, pre2, id1, id2 in db.execute(
            """SELECT e.team1_id, e.team2_id, e.team1, e.team2, l.odd1, l.odd2, o.pre1, o.pre2, a.wta_id, b.wta_id
               FROM winline_event e
               JOIN match_odds o ON o.wl_id = e.wl_id JOIN match m ON m.match_id = o.match_id
               JOIN player a ON a.fs_id = m.p1_fs_id JOIN player b ON b.fs_id = m.p2_fs_id
               JOIN winline_line l ON l.wl_id = e.wl_id AND l.market = 'Победитель'
               WHERE a.wta_id IS NOT NULL AND b.wta_id IS NOT NULL AND o.pre1 IS NOT NULL AND e.is_doubles = 0
               GROUP BY e.wl_id"""):
        id1, id2 = int(id1), int(id2)
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


def surface_index(db: sqlite3.Connection) -> dict:
    """City -> surface, newest event winning, from BOLSHE's directory. Winline's feed has no surface."""
    index = {}
    for city, surface in db.execute(
            "SELECT tournament, surface FROM tournament WHERE tour = 'WTA' AND surface IS NOT NULL AND tournament IS NOT NULL ORDER BY first_seen"):
        index[folded(city)] = surface.lower()
    return index


def surface_of(tournament: str | None, index: dict) -> str | None:
    return index.get(folded((tournament or "").split(",")[0]))


def record(rows: list[dict]) -> tuple[int, int]:
    wins = sum(r["won"] for r in rows)
    return wins, len(rows) - wins


def fact_cards(event: dict, hist: dict, form: dict, h2h: list[dict], surface: str | None) -> list[dict]:
    """What can be said whatever the line. No gate beyond a minimum of matches."""
    cards = []
    names = {1: event["team1"], 2: event["team2"]}
    for side in (1, 2):
        if len(form[side]) >= 5:
            wins, losses = record(form[side])
            cards.append({"kind": "form", "side": side, "hits": wins, "n": wins + losses,
                          "text": f"{names[side]}: {wins}-{losses} в последних {wins + losses} матчах"})
        if surface and len(hist[side]) >= MIN_SAMPLE:
            wins, losses = record(hist[side])
            cards.append({"kind": "surface", "side": side, "hits": wins, "n": wins + losses,
                          "text": f"{names[side]}: {wins}-{losses} в последних {wins + losses} матчах на {SURFACE_RU.get(surface, surface)}"})
    if h2h:
        first, second = record(h2h)
        if first == second:
            text = f"Личные встречи: {first}-{second}"
        else:
            leader = names[1] if first > second else names[2]
            text = f"Личные встречи: {leader} ведёт {max(first, second)}-{min(first, second)}"
        cards.append({"kind": "h2h", "side": None, "hits": first, "n": first + second, "text": text})
    return cards


def priced(side_price: float, other_price: float, hits: int, n: int) -> dict | None:
    """The gate: a real price in range, enough matches, and a record above what the price expects."""
    if not (MIN_ODDS <= side_price <= MAX_ODDS) or n < MIN_SAMPLE or hits / n < MIN_HIT:
        return None
    fair, low = fair_price(side_price, other_price), wilson_low(hits, n)
    if low <= fair:
        return None
    return {"price": side_price, "market_expects": round(fair, 3), "hits": hits, "n": n,
            "low": round(low, 3), "score": round(low - fair, 3)}


def line_cards(event: dict, lines: list[dict], hist: dict) -> list[dict]:
    """Candidates by market family, the strongest of each family kept. Handicap and total ladders
    offer many rungs of one idea, and one plate per idea is enough."""
    names = {1: event["team1"], 2: event["team2"]}
    best: dict[str, dict] = {}

    def offer(family, text, gate):
        if gate and (family not in best or gate["score"] > best[family]["score"]):
            best[family] = {"kind": "line", "family": family, "text": text, **gate}

    for line in lines:
        market, value, odd1, odd2 = line["market"], line["value"], line["odd1"], line["odd2"]
        if market == "Победитель":
            for side, mine, other in ((1, odd1, odd2), (2, odd2, odd1)):
                wins = sum(r["won"] for r in hist[side])
                offer("winner", f"Победа {names[side]} — {mine}", priced(mine, other, wins, len(hist[side])))
        elif market == "Фора" and value is not None:
            for side, mine, other, cap in ((1, odd1, odd2, value), (2, odd2, odd1, -value)):
                full = [r for r in hist[side] if r["full"]]
                hits = sum(r["margin"] + cap > 0 for r in full)
                offer("handicap", f"{names[side]} {cap:+.1f} по геймам — {mine}", priced(mine, other, hits, len(full)))
        elif market == "Тотал" and value is not None:
            # A total depends on both, so both must have the sample, and their matches are pooled.
            one, two = [r for r in hist[1] if r["full"]], [r for r in hist[2] if r["full"]]
            if len(one) < MIN_SAMPLE or len(two) < MIN_SAMPLE:
                continue
            pool = one + two
            over = sum(r["total"] > value for r in pool)
            offer("total", f"Тотал больше {value} — {odd1}", priced(odd1, odd2, over, len(pool)))
            under = sum(r["total"] < value for r in pool)
            offer("total", f"Тотал меньше {value} — {odd2}", priced(odd2, odd1, under, len(pool)))
    return sorted(best.values(), key=lambda c: -c["score"])[:MAX_LINE_CARDS]


def build(event: dict, lines: list[dict], players: dict, player_ids: dict, surfaces: dict, learned: dict | None = None) -> dict:
    cutoff = (event["start_at"] or "")[:10]
    learned = learned or {}
    id1 = learned.get(event.get("team1_id")) or find_wta_id(event["team1"], player_ids)
    id2 = learned.get(event.get("team2_id")) or find_wta_id(event["team2"], player_ids)
    result = {"wl_id": event["wl_id"], "tournament": event["tournament"], "start_at": event["start_at"],
              "team1": event["team1"], "team2": event["team2"], "url": event["url"], "linked": bool(id1 and id2),
              "facts": [], "lines": [], "notes": []}
    if not (id1 and id2 and cutoff):
        result["notes"].append("нет однозначной связи с игроками WTA")
        return result
    surface = surface_of(event["tournament"], surfaces)
    if not surface:
        result["notes"].append("покрытие турнира неизвестно: нужен свежий справочник BOLSHE")
    rows = {1: players.get(id1, []), 2: players.get(id2, [])}
    hist = {side: recent(rows[side], cutoff, surface) if surface else [] for side in (1, 2)}
    form = {side: recent(rows[side], cutoff, None, FORM_MONTHS, FORM_LIMIT) for side in (1, 2)}
    h2h = [r for r in rows[1] if r["opp"] == id2 and r["date"] and r["date"] < cutoff]
    result["facts"] = fact_cards(event, hist, form, h2h, surface)
    result["lines"] = line_cards(event, lines, hist)
    result["wta_ids"] = [id1, id2]
    return result


def upcoming(db: sqlite3.Connection, day: str | None, player: str | None) -> list[dict]:
    """WTA singles still to start, from the last prices seen."""
    db.row_factory = sqlite3.Row
    last = db.execute("SELECT MAX(taken_at) FROM winline_fetch").fetchone()[0]
    events = [dict(r) for r in db.execute(
        """SELECT * FROM winline_event WHERE circuit = 'WTA' AND is_doubles = 0 AND last_seen = ? ORDER BY start_at""", (last,))]
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
    players, ids, surfaces = load_history(db), player_index(db), surface_index(db)
    learned = learned_players(db, ids)
    results = [build(e, e["lines"], players, ids, surfaces, learned) for e in upcoming(db, args.date, args.player)]
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
