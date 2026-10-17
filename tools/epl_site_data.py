#!/usr/bin/env python3
"""Build the data file of the operator site: upcoming EPL matches with every Winline line, head-to-head,
form, team statistics and insight candidates.

  python -I tools/epl_site_data.py [--winline PATH] [--out PATH]

Reads local-data/epl/normalized/*.json (tools/epl_collect.py build) and the Winline snapshot
(tools/winline_football/capture.mjs); writes local-data/epl/site/site.json. Odds movement: every card and player
line carries the price of the kept snapshot about a day earlier (`was`, `odds_was`; `move_since` = its time).
"""
from __future__ import annotations

import argparse
from collections import Counter
import gzip
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import epl_collect as epl  # noqa: E402
import epl_engine as eng  # noqa: E402
import epl_text as T  # noqa: E402
import epl_markets  # noqa: E402,F401 - registers the market rules' categories before the payload lists them
import epl_insights as ins  # noqa: E402

STAT_KEYS = ("xg_proxy", "shots", "shots_on_target", "shots_inside_box", "touches_in_opp_box", "possession_pct", "corners_won",
             "fouls_conceded", "yellow_cards", "ppda")
AGAINST_KEYS = ("xg_proxy", "shots", "shots_inside_box")
FORM_LIMIT = 5
STATS_RECENT = 6
STATS_BASELINE = 114  # three seasons


def load(name: str):
    return json.loads((epl.NORM / name).read_text(encoding="utf-8"))


MOVE_HOURS = 24


def snapshot_time(folder: Path) -> datetime | None:
    try:  # folder names are capture times: 2026-10-14T21-20-16-263Z
        return datetime.strptime(folder.name[:19], "%Y-%m-%dT%H-%M-%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def reference_prices(winline_dir: Path, now: datetime) -> tuple[str | None, dict]:
    """Prices of the kept Winline snapshot about MOVE_HOURS before `now` (the latest one at least that old, else
    the oldest kept): {(event id, market key, outcome index): odds} and that snapshot's capture time."""
    folders = sorted((f, snapshot_time(f)) for f in (winline_dir / "snapshots").glob("*") if f.is_dir() and snapshot_time(f))
    if len(folders) < 2:
        return None, {}
    cutoff = now - timedelta(hours=MOVE_HOURS)
    older = [f for f, t in folders if t <= cutoff]
    for folder in (older[-1:] or []) + [f for f, _ in folders]:
        gz, plain = folder / "index.json.gz", folder / "index.json"
        if gz.exists() or plain.exists():
            payload = json.loads(gzip.decompress(gz.read_bytes()) if gz.exists() else plain.read_bytes())
            prices = {(e["event_id"], m["key"], o["index"]): o["odds"] for e in payload.get("events") or [] for m in e["markets"] for o in m["outcomes"]}
            return payload.get("captured_at"), prices
    return None, {}


LIVE_KEEP_HOURS = 3  # a match stays on the site this long after its kickoff
LIVE_LOOKBACK = 60  # snapshots searched (newest first) for a match that left the pre-match line


def started_events(winline_dir: Path, now: datetime, current_ids: set) -> list[dict]:
    """Matches that kicked off and so left Winline's pre-match line (owner 2026-10-17: a live match vanished from the
    list): the newest kept snapshot that still had each one, for LIVE_KEEP_HOURS after the kickoff, marked live, with
    the same event id — so the match page, its plates and its OBS link stay the same. Its plates are built on the last
    snapshot taken before the kickoff (Winline keeps a match in the pre-match line for ~25 minutes after it, already
    with in-play prices), else on the newest one (`frozen_at` = that snapshot's capture time)."""
    folders = sorted(((f, snapshot_time(f)) for f in (winline_dir / "snapshots").glob("*") if f.is_dir() and snapshot_time(f)),
                     key=lambda x: x[1], reverse=True)[:LIVE_LOOKBACK]
    before_kickoff: dict = {}
    newest: dict = {}
    for folder, taken in folders:
        gz, plain = folder / "index.json.gz", folder / "index.json"
        if not (gz.exists() or plain.exists()):
            continue
        payload = json.loads(gzip.decompress(gz.read_bytes()) if gz.exists() else plain.read_bytes())
        for event in payload.get("events") or []:
            if event["event_id"] in current_ids or event["event_id"] in before_kickoff:
                continue
            try:
                start = datetime.fromisoformat(str(event["starts_at"]).replace("Z", "+00:00"))
            except ValueError:
                continue
            if start.tzinfo is None:
                start = start.replace(tzinfo=timezone.utc)
            if not start <= now <= start + timedelta(hours=LIVE_KEEP_HOURS):
                continue
            kept = {**event, "live": True, "frozen_at": payload.get("captured_at")}
            newest.setdefault(event["event_id"], kept)
            if taken <= start:
                before_kickoff[event["event_id"]] = kept
    return [before_kickoff.get(event_id, event) for event_id, event in newest.items()]


LIVE_FRESH_MINUTES = 20  # older live lines are not shown as live prices
LIVE_GRACE_MINUTES = 6  # a match missing from the last live capture keeps the prices of one this recent


LIVE_CAPTURE_MINUTES = 135  # a league match is over by then (2 x 45 + break + stoppages); it stays ON THE SITE LIVE_KEEP_HOURS


def started_ids(winline_dir: Path, snapshot: dict, now: datetime) -> list[int]:
    """Event ids of the matches being played: kicked off in the last LIVE_CAPTURE_MINUTES (still in the pre-match line or
    not). 2026-10-17: Эвертон—Челси was over ~2 h after the kickoff, its Winline page had no line any more and every
    capture of the third hour failed - hoh-epl-live «упала» and the live prices of the other matches were not published."""
    def since_kickoff(event: dict) -> timedelta:
        start = datetime.fromisoformat(str(event["starts_at"]).replace("Z", "+00:00"))
        if start.tzinfo is None:
            start = start.replace(tzinfo=timezone.utc)
        return now - start
    window = timedelta(minutes=LIVE_CAPTURE_MINUTES)
    started = started_events(winline_dir, now, {e["event_id"] for e in snapshot["events"]})
    return [e["event_id"] for e in [*started, *snapshot["events"]] if timedelta(0) <= since_kickoff(e) <= window]


def load_live(live_dir: Path, now: datetime) -> tuple[str | None, dict]:
    """The live lines captured by deploy/epl/run_live.sh (winline-live/latest.json), when fresh: {event id: event}."""
    path = live_dir / "latest.json"
    if not path.exists():
        return None, {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    try:
        taken = datetime.fromisoformat(str(payload.get("captured_at")).replace("Z", "+00:00"))
    except ValueError:
        return None, {}
    if now - taken > timedelta(minutes=LIVE_FRESH_MINUTES):
        return None, {}
    events = {e["event_id"]: dict(e, live_captured_at=payload["captured_at"]) for e in payload.get("events") or [] if e.get("markets")}
    # a match whose page did not open this time (2026-10-17: Ман Сити—Ипсвич timed out once and lost every live plate)
    # keeps its prices from a capture of the last few minutes
    folders = sorted((p for p in (live_dir / "snapshots").glob("*") if (p / "index.json.gz").exists()), reverse=True)[:8]
    for folder in folders:
        try:
            older = json.loads(gzip.decompress((folder / "index.json.gz").read_bytes()))
            at = datetime.fromisoformat(str(older.get("captured_at")).replace("Z", "+00:00"))
        except (OSError, ValueError):
            continue
        if now - at > timedelta(minutes=LIVE_GRACE_MINUTES):
            break
        for e in older.get("events") or []:
            if e.get("markets") and e["event_id"] not in events:
                events[e["event_id"]] = dict(e, live_captured_at=older["captured_at"])
    return payload["captured_at"], events


def apply_live(cards: list[dict], live_event: dict) -> None:
    """The pre-match plates of a match being played get the live price of the same bet (same market, same outcome):
    `market.live` = 'open' with the live odds (the pre-match ones kept as `odds_prematch`), or 'closed' when Winline
    took the bet off in play. The plates themselves stay the pre-match facts: history does not know the score."""
    prices = {(m["key"], o["index"]): o["odds"] for m in live_event["markets"] for o in m["outcomes"]}
    for card in cards:
        market_key, _, index = card["market"]["key"].partition("#")
        odds = prices.get((market_key, int(index))) if index.isdigit() else None
        card["market"]["odds_prematch"] = card["market"]["odds"]
        if odds:
            card["market"].update(odds=odds, live="open" if odds >= eng.MIN_ODDS else "low")  # under 1.50: no plate (owner rule)
        else:
            card["market"]["live"] = "closed"


def live_cards(live_event: dict, ctx: dict, covered: set) -> list[dict]:
    """Plates of the standard bets of the live line for a match being played (owner 2026-10-17: «во втором тайме нет
    даже стандартных — победа, ничья, тотал»): each club's win, the draw, «не проиграет», the main total over / under,
    both to score yes / no — at 1.50 or more, except a bet a pre-match plate already carries live (`covered` keys).
    No history behind them: the headline says it is a bet in play, the price is the live one."""
    names = ctx["names"]
    home, away = names[ctx["home"]], names[ctx["away"]]
    out = []

    def add(market, outcome, subject, bet, crest, label):
        odds = outcome.get("odds")
        key = f"{market['key']}#{outcome['index']}"
        if not odds or odds < eng.MIN_ODDS or key in covered:
            return
        card = {"rule": "live_line", "title": f"{subject}: ставка по ходу матча по лайв-линии Winline",
                "evidence": {"sample": 0, "hits": 0, "rate": None, "rate_conservative": None, "implied_by_price": round(1 / odds, 3),
                             "window": "лайв-линия Winline"},
                "market": {"market_id": market["market_id"], "family": market["family"], "period": market["period"], "scope": market["scope"],
                           "line": outcome.get("line", market.get("line")), "side": outcome.get("side"), "odds": odds, "label": label, "key": key,
                           "live": "open"},
                "score": 55, "tags": ["лайв"], "details": {}, "category": "Лайв", "basis": "Лайв-линия", "tier": "solid", "tier_label": "Лайв",
                "stars": 3, "reasons": ["кэф лайв-линии Winline"], "alternatives": [], "support": [],
                "plate": {"crest": crest, "bet": bet, "headline": T.first_fit((f"{subject} — ставка в лайве", subject))}}
        card["plate"] = eng.finish_plate(card, ctx)
        out.append(card)

    totals = []
    for market in live_event["markets"]:
        if market["period"] != "FT" or market["scope"] != "match" or not market["outcomes"]:
            continue
        family, by_side = market["family"], {o.get("side"): o for o in market["outcomes"]}
        # only the main markets (the live line also has «result at minute 80» and the like): 490 result, 114 double
        # chance, 58 both to score, 1049 match total
        if market["market_id"] not in (490, 114, 58, 1049):
            continue
        if family == "match_result" and market.get("variant") is None:
            if "home" in by_side:
                add(market, by_side["home"], f"Победа {T.gen(home)}", "победа в матче", "home", f"Победа {home}")
            if "draw" in by_side:
                add(market, by_side["draw"], "Ничья", "ничья", "match", "Ничья")
            if "away" in by_side:
                add(market, by_side["away"], f"Победа {T.gen(away)}", "победа в матче", "away", f"Победа {away}")
        elif family == "double_chance":
            if "home_draw" in by_side:
                add(market, by_side["home_draw"], f"{home} не проиграет", "не проиграет", "home", f"{home} или ничья")
            if "draw_away" in by_side:
                add(market, by_side["draw_away"], f"{away} не проиграет", "не проиграет", "away", f"{away} или ничья")
        elif family == "btts" and market["market_id"] == 58:
            if "yes" in by_side:
                add(market, by_side["yes"], "Обе команды забьют", "обе забьют", "match", "Обе забьют — Да")
            if "no" in by_side:
                add(market, by_side["no"], "Хотя бы одна команда не забьёт", "обе забьют — нет", "match", "Обе забьют — Нет")
        elif family == "total" and market.get("line") is not None and {"over", "under"} <= set(by_side):
            totals.append(market)
    if totals:  # the main total: the line with the most even prices
        def spread(m):
            prices = {o.get("side"): o["odds"] for o in m["outcomes"]}
            return abs(prices["over"] - prices["under"])
        market = min(totals, key=spread)
        by_side, line = {o.get("side"): o for o in market["outcomes"]}, market["line"]
        add(market, by_side["over"], f"{T.cap(T.total('over', line))} в матче", f"тотал больше {T.line(line)}", "match", f"Тотал больше {T.line(line)}")
        add(market, by_side["under"], f"{T.cap(T.total('under', line))} в матче", f"тотал меньше {T.line(line)}", "match", f"Тотал меньше {T.line(line)}")
    return out


def mark_moves(cards: list[dict], players: list[dict], event: dict, prices: dict) -> None:
    """Odds of the reference snapshot as `was` on the cards and `odds_was` on the player rows (when they differ)."""
    if not prices:
        return
    for card in cards:
        key, _, index = card["market"]["key"].rpartition("#")
        was = prices.get((event["event_id"], key, int(index))) if index.isdigit() else None
        if was and was != card["market"]["odds"]:
            card["market"]["was"] = was
    keys = {(m.get("subject") or {}).get("name", "") + "|" + (m.get("variant") or ""): m for m in event["markets"] if m["family"] == "player_goal"}
    for row in players:
        moved = {}
        for variant, odds in (row.get("odds") or {}).items():
            market = keys.get(f"{row['name']}|{variant}")
            was = prices.get((event["event_id"], market["key"], market["outcomes"][0]["index"])) if market and market["outcomes"] else None
            if was and was != odds:
                moved[variant] = was
        if moved:
            row["odds_was"] = moved


def norm_name(text: str) -> str:
    return (text or "").lower().replace("ё", "е").strip()


def club_for(winline_name: str, teams: list[dict]) -> dict | None:
    wanted = norm_name(winline_name)
    names = [(norm_name(t["name_ru"] or ""), t) for t in teams]
    for ru, team in names:
        if ru and ru == wanted:
            return team
    for ru, team in names:
        if ru and (wanted.startswith(ru) or ru.startswith(wanted)):
            return team
    return None


def iso_seconds(value: str) -> str:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def form_rows(by_club: dict, club: int, before: str, names: dict[int, str]) -> list[dict]:
    rows = []
    for m in ins.recent(by_club, club, before, FORM_LIMIT):
        result, scored, conceded = epl.result_for(m, club)
        home = m["home"]["id"] == club
        rows.append({"date": (m["kickoff_utc"] or "")[:10], "opponent": names.get(m["away" if home else "home"]["id"], "?"),
                     "venue": "H" if home else "A", "score": f"{scored}:{conceded}", "result": result})
    return rows


def averages(by_club: dict, stats: dict, club: int, before: str, limit: int) -> dict:
    matches = ins.recent(by_club, club, before, limit)
    out = {"matches": len(matches)}
    if matches:
        out["goals_for"] = round(sum(ins.goals(m, club)[0] for m in matches) / len(matches), 2)
        out["goals_against"] = round(sum(ins.goals(m, club)[1] for m in matches) / len(matches), 2)
    for key in STAT_KEYS:
        values = [stats[m["id"]][club][key] for m in matches if key in (stats.get(m["id"]) or {}).get(club, {})]
        if values:
            out[key] = round(sum(values) / len(values), 2)
            out[f"{key}_n"] = len(values)
    for key in AGAINST_KEYS:
        values = []
        for m in matches:
            opp = m["away" if m["home"]["id"] == club else "home"]["id"]
            value = (stats.get(m["id"]) or {}).get(opp, {}).get(key)
            if value is not None:
                values.append(value)
        if values:
            out[f"{key}_against"] = round(sum(values) / len(values), 2)
    return out


def h2h_block(h2h: dict, home: int, away: int, matches_by_id: dict, names: dict, people: dict, before: str) -> dict:
    pair = h2h[f"{min(home, away)}-{max(home, away)}"]
    sample = [matches_by_id[mid] for mid in pair["matches"] if (matches_by_id[mid]["kickoff_utc"] or "") < before]
    sample.sort(key=lambda m: m["kickoff_utc"] or "", reverse=True)
    home_w = sum(1 for m in sample if epl.result_for(m, home)[0] == "W")
    away_w = sum(1 for m in sample if epl.result_for(m, home)[0] == "L")
    last = [{"date": (m["kickoff_utc"] or "")[:10], "season": m["season"], "home": names.get(m["home"]["id"]), "away": names.get(m["away"]["id"]),
             "score": f"{m['home']['score']}:{m['away']['score']}"} for m in sample[:10]]
    scorers = []
    for entry in pair["top_scorers"][:5]:
        person = people.get(str(entry["person_id"])) or {}
        scorers.append({"name": entry["name"] or person.get("name"), "goals": entry["goals"], "club": names.get(entry["team_id"])})
    return {"played": len(sample), "home_wins": home_w, "draws": len(sample) - home_w - away_w, "away_wins": away_w,
            "goals_home": sum(ins.goals(m, home)[0] for m in sample), "goals_away": sum(ins.goals(m, home)[1] for m in sample),
            "last": last, "top_scorers": scorers, "unbeaten_run": pair["unbeaten_run"], "first": pair["first_meeting"]}


def quick_odds(event: dict) -> dict:
    quick: dict = {}
    result = ins.find_markets(event, "match_result", variant=None)
    if result:
        quick["x12"] = [o["odds"] for o in result[0]["outcomes"]]
    dc = ins.find_markets(event, "double_chance")
    if dc:
        quick["dc"] = [o["odds"] for o in dc[0]["outcomes"]]
    btts = ins.find_markets(event, "btts")
    if btts:
        quick["btts"] = [o["odds"] for o in btts[0]["outcomes"]]
    totals = [m for m in ins.find_markets(event, "total") if m.get("line") is not None and len(m["outcomes"]) == 2]
    totals = [m for m in totals if m["line"] % 1 == 0.5] or totals  # a half line has no refund: the cleaner headline price
    if totals:
        best = min(totals, key=lambda m: abs(m["outcomes"][0]["odds"] - m["outcomes"][1]["odds"]))
        quick["total"] = {"line": best["line"], "over": best["outcomes"][0]["odds"], "under": best["outcomes"][1]["odds"]}
    return quick


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--winline", default=str(epl.OUT / "winline" / "latest.json"))
    parser.add_argument("--out", default=str(epl.OUT / "site" / "site.json"))
    parser.add_argument("--live", default=str(epl.OUT / "winline-live"), help="folder of the live lines (deploy/epl/run_live.sh)")
    parser.add_argument("--live-ids", action="store_true", help="print the event ids of the matches being played and stop")
    args = parser.parse_args(argv)
    sys.stdout.reconfigure(encoding="utf-8")
    if args.live_ids:
        snapshot = json.loads(Path(args.winline).read_text(encoding="utf-8"))
        print(",".join(str(i) for i in started_ids(Path(args.winline).parent, snapshot, datetime.now(timezone.utc))))
        return 0

    teams, matches, h2h = load("teams.json"), load("matches.json"), load("h2h.json")
    stats = {int(k): {int(t): v for t, v in per.items()} for k, per in load("team_match_stats.json").items()}
    if (epl.NORM / "xg_proxy.json").exists():  # our own non-penalty xG model (tools/epl_xg.py)
        for match_id, per_team in load("xg_proxy.json").items():
            for team_id, value in per_team.items():
                stats.setdefault(int(match_id), {}).setdefault(int(team_id), {})["xg_proxy"] = value
    players, people = load("players.json"), load("people.json")
    snapshot = json.loads(Path(args.winline).read_text(encoding="utf-8"))
    names = {t["id"]: t["name_ru"] or t["name"] for t in teams}
    matches_by_id = {m["id"]: m for m in matches}
    by_club = ins.index_matches(matches)
    details = {int(k): v for k, v in load("match_details.json").items()}
    rows = eng.club_rows(matches, stats, details)
    apps = eng.appearances(details, matches_by_id)
    xg = ({int(k): {int(t): v for t, v in per.items()} for k, per in load("xg_proxy.json").items()}
          if (epl.NORM / "xg_proxy.json").exists() else {})

    move_since, prices = reference_prices(Path(args.winline).parent, datetime.now(timezone.utc))
    # every match that kicked off — gone from the pre-match line or still in it (Winline keeps it ~25 min, already with
    # in-play prices) — is built on its last snapshot before the kickoff and gets the live prices (2026-10-17)
    started = started_events(Path(args.winline).parent, datetime.now(timezone.utc), set())
    kicked_off = {e["event_id"] for e in started}
    snapshot["events"] = [e for e in snapshot["events"] if e["event_id"] not in kicked_off]
    live_at, live_events = load_live(Path(args.live), datetime.now(timezone.utc))
    out_matches, skipped = [], []
    for event in snapshot["events"] + started:
        home, away = club_for(event["home"], teams), club_for(event["away"], teams)
        if not home or not away:
            skipped.append(f"{event['home']} - {event['away']}")
            continue
        before = iso_seconds(event["starts_at"])
        ctx = {"by_club": by_club, "stats": stats, "names": names, "before": before, "home": home["id"], "away": away["id"], "players": players,
               "rows": rows, "apps": apps}
        cards = eng.build_cards(event, ctx)
        board = eng.player_board_rows(event, ctx, cards)
        mark_moves(cards, board, event, prices)
        live_odds = event.get("frozen_at") and event["event_id"] in live_events
        if live_odds:
            apply_live(cards, live_events[event["event_id"]])
            covered = {c["market"]["key"] for c in cards if c["market"].get("live") == "open"}
            cards = live_cards(live_events[event["event_id"]], ctx, covered) + cards
        out_matches.append({
            "event_id": event["event_id"], "starts_at": before, "live": event.get("live", False), "captured_at": event.get("captured_at"),
            "frozen_at": event.get("frozen_at"), "live_odds_at": live_events[event["event_id"]]["live_captured_at"] if live_odds else None,
            "home": {"id": home["id"], "name": home["name"], "name_ru": names[home["id"]], "name_full": event["home"]},
            "away": {"id": away["id"], "name": away["name"], "name_ru": names[away["id"]], "name_full": event["away"]},
            "quick": quick_odds(event), "summary": event["summary"], "markets": event["markets"], "players": board,
            "h2h": h2h_block(h2h, home["id"], away["id"], matches_by_id, names, people, before),
            "form": {"home": form_rows(by_club, home["id"], before, names), "away": form_rows(by_club, away["id"], before, names)},
            "stats": {side: {"recent": averages(by_club, stats, club["id"], before, STATS_RECENT),
                             "baseline": averages(by_club, stats, club["id"], before, STATS_BASELINE)}
                      for side, club in (("home", home), ("away", away))},
            "insights": cards,
        })
    out_matches.sort(key=lambda m: m["starts_at"])
    now = epl.now_iso()
    teams_board = []
    for team in teams:
        club = team["id"]
        upcoming = next((m for m in out_matches if club in (m["home"]["id"], m["away"]["id"])), None)
        tiers = Counter(c["tier"] for m in out_matches if club in (m["home"]["id"], m["away"]["id"]) for c in m["insights"])
        teams_board.append({"id": club, "name": team["name"], "name_ru": names[club], "abbr": team.get("abbr"),
                            "profile": eng.team_profile(rows.get(club, []), now, xg, club), "cards_by_tier": dict(tiers),
                            "next": ({"event_id": upcoming["event_id"], "starts_at": upcoming["starts_at"],
                                      "opponent": upcoming["away" if upcoming["home"]["id"] == club else "home"]["name_ru"],
                                      "venue": "H" if upcoming["home"]["id"] == club else "A"} if upcoming else None)})
    payload = {"generated_at": now, "winline_captured_at": snapshot["captured_at"], "move_since": move_since, "league": "АПЛ", "matches": out_matches,
               "teams": teams_board, "tiers": [{"id": t, "label": label, "min_score": s, "stars": st} for s, t, label, st in eng.TIERS],
               "categories": sorted({c for c, _ in eng.RULE_META.values()}), "bases": sorted({b for _, b in eng.RULE_META.values()})}
    epl.write_json(Path(args.out), payload)
    total = sum(len(m["insights"]) for m in out_matches)
    print(f"site data: {len(out_matches)} matches, {total} insight candidates, skipped {skipped or 'none'} -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
