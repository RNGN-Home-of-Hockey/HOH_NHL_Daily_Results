#!/usr/bin/env python3
"""Build the data file of the operator site: upcoming EPL matches with every Winline line, head-to-head,
form, team statistics and insight candidates.

  python -I tools/epl_site_data.py [--winline PATH] [--out PATH]

Reads local-data/epl/normalized/*.json (tools/epl_collect.py build) and the Winline snapshot
(tools/winline_football/capture.mjs); writes local-data/epl/site/site.json.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import epl_collect as epl  # noqa: E402
import epl_insights as ins  # noqa: E402

STAT_KEYS = ("shots", "shots_on_target", "shots_inside_box", "touches_in_opp_box", "possession_pct", "corners_won",
             "fouls_conceded", "yellow_cards", "ppda")
FORM_LIMIT = 5
STATS_RECENT = 6
STATS_BASELINE = 114  # three seasons


def load(name: str):
    return json.loads((epl.NORM / name).read_text(encoding="utf-8"))


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
    for key in ("shots", "shots_inside_box"):
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


def player_table(event: dict, ctx: dict) -> list[dict]:
    rows: dict[tuple, dict] = {}
    for market in event["markets"]:
        if market["family"] != "player_goal" or not market.get("subject") or not market["outcomes"]:
            continue
        subject = market["subject"]
        row = rows.setdefault((subject["team"], subject["name"]), {"name": subject["name"], "team": subject["team"], "number": subject.get("number")})
        row[market["variant"]] = market["outcomes"][0]["odds"]
    table = []
    for (team, name), row in rows.items():
        club = ctx["home"] if team == "home" else ctx["away"]
        player = ins.match_player(name, club, ctx["players"])
        if player:
            history = [r for r in (player.get("season_2026_27_by_gameweek") or []) if (r.get("minutes") or 0) > 0][-5:]
            season = player.get("season_2026_27") or {}
            row.update({"pl_id": player["pl_id"], "position": player["position"], "goals_season": season.get("goals_scored"),
                        "xg_season": season.get("expected_goals"), "penalty_taker": season.get("penalties_order") == 1,
                        "last5_goals": [r.get("goals_scored") for r in history], "news": season.get("news")})
        table.append(row)
    table.sort(key=lambda r: (r.get("anytime") or 99))
    return table


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--winline", default=str(epl.OUT / "winline" / "latest.json"))
    parser.add_argument("--out", default=str(epl.OUT / "site" / "site.json"))
    args = parser.parse_args(argv)
    sys.stdout.reconfigure(encoding="utf-8")

    teams, matches, h2h = load("teams.json"), load("matches.json"), load("h2h.json")
    stats = {int(k): {int(t): v for t, v in per.items()} for k, per in load("team_match_stats.json").items()}
    players, people = load("players.json"), load("people.json")
    snapshot = json.loads(Path(args.winline).read_text(encoding="utf-8"))
    names = {t["id"]: t["name_ru"] or t["name"] for t in teams}
    matches_by_id = {m["id"]: m for m in matches}
    by_club = ins.index_matches(matches)

    out_matches, skipped = [], []
    for event in snapshot["events"]:
        home, away = club_for(event["home"], teams), club_for(event["away"], teams)
        if not home or not away:
            skipped.append(f"{event['home']} - {event['away']}")
            continue
        before = iso_seconds(event["starts_at"])
        ctx = {"by_club": by_club, "stats": stats, "names": names, "before": before, "home": home["id"], "away": away["id"], "players": players}
        out_matches.append({
            "event_id": event["event_id"], "starts_at": before, "live": event.get("live", False), "captured_at": event.get("captured_at"),
            "home": {"id": home["id"], "name": home["name"], "name_ru": names[home["id"]]},
            "away": {"id": away["id"], "name": away["name"], "name_ru": names[away["id"]]},
            "quick": quick_odds(event), "summary": event["summary"], "markets": event["markets"], "players": player_table(event, ctx),
            "h2h": h2h_block(h2h, home["id"], away["id"], matches_by_id, names, people, before),
            "form": {"home": form_rows(by_club, home["id"], before, names), "away": form_rows(by_club, away["id"], before, names)},
            "stats": {side: {"recent": averages(by_club, stats, club["id"], before, STATS_RECENT),
                             "baseline": averages(by_club, stats, club["id"], before, STATS_BASELINE)}
                      for side, club in (("home", home), ("away", away))},
            "insights": ins.build_match_insights(event, ctx),
        })
    out_matches.sort(key=lambda m: m["starts_at"])
    payload = {"generated_at": epl.now_iso(), "winline_captured_at": snapshot["captured_at"], "league": "АПЛ", "matches": out_matches}
    epl.write_json(Path(args.out), payload)
    total = sum(len(m["insights"]) for m in out_matches)
    print(f"site data: {len(out_matches)} matches, {total} insight candidates, skipped {skipped or 'none'} -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
