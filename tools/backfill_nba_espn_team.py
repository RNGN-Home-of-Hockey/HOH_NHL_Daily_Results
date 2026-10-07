#!/usr/bin/env python3
"""Complete NBA backfill from ESPN team schedules + summaries with canonical NBA IDs.

Used for seasons where legacy data.nba.com game detail is incomplete/stale.
ESPN supplies complete event discovery + box scores; data.nba.com remains the
canonical identity source for NBA team/player/game IDs wherever available.
"""
from __future__ import annotations

import concurrent.futures
import copy
import gzip
import hashlib
import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import backfill_nba_espn as base

SOURCE = "espn-team-schedules+data.nba.com-player-directory"
ESPN_TEAM_SCHEDULE = (
    "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/"
    "{team_id}/schedule?season={season_end}&seasontype={season_type}"
)
ESPN_TEAM_ID_TO_NBA = {
    "1": "ATL", "2": "BOS", "3": "NOP", "4": "CHI", "5": "CLE", "6": "DAL",
    "7": "DEN", "8": "DET", "9": "GSW", "10": "HOU", "11": "IND", "12": "LAC",
    "13": "LAL", "14": "MIA", "15": "MIL", "16": "MIN", "17": "BKN", "18": "NYK",
    "19": "ORL", "20": "PHI", "21": "PHX", "22": "POR", "23": "SAC", "24": "SAS",
    "25": "OKC", "26": "UTA", "27": "WAS", "28": "TOR", "29": "MEM", "30": "CHA",
}
ESPN_TEAMS = {abbr: int(team_id) for team_id, abbr in ESPN_TEAM_ID_TO_NBA.items()}
ESPN_ABBR_TO_NBA = {
    "GS": "GSW", "NO": "NOP", "NY": "NYK", "SA": "SAS", "WSH": "WAS", "UTAH": "UTA",
}
NAME_ALIASES = {
    "kjmartin": "kenyonmartin",
    "cammcgriff": "cameronmcgriff",
    "vjedgecombe": "valdezedgecombe",
    "jaserichardson": "jasonrichardson",
}
PLAYER_ID_OVERRIDES = {
    "dejonjarreau": 1630610,
    "seanpedulla": 1642951,
    "malachismith": 1641869,
    "alexantetokounmpo": 1630828,
    "trevonscott": 1630286,
    "buddyboeheim": 1631205,
    "grantnelson": 1641761,
    "paytonsandfort": 1642362,
    "tobyokani": 1643253,
    "jaysonkent": 1643257,
    "lucaswilliamson": 1631351,
}


def canonical_team_abbr(team):
    if not isinstance(team, dict):
        return ""
    by_id = ESPN_TEAM_ID_TO_NBA.get(str(team.get("id") or ""))
    if by_id:
        return by_id
    raw = str(team.get("abbreviation") or "").upper()
    return ESPN_ABBR_TO_NBA.get(raw, raw)


def normalize_event(event):
    event = copy.deepcopy(event)
    for comp in event.get("competitions") or []:
        for competitor in comp.get("competitors") or []:
            team = competitor.get("team") or {}
            abbr = canonical_team_abbr(team)
            if abbr:
                team["abbreviation"] = abbr
    return event


def normalize_summary(payload):
    payload = copy.deepcopy(payload)
    for comp in ((payload.get("header") or {}).get("competitions") or []):
        for competitor in comp.get("competitors") or []:
            team = competitor.get("team") or {}
            abbr = canonical_team_abbr(team)
            if abbr:
                team["abbreviation"] = abbr
    box = payload.get("boxscore") or {}
    for group in box.get("players") or []:
        team = group.get("team") or {}
        abbr = canonical_team_abbr(team)
        if abbr:
            team["abbreviation"] = abbr
    for row in box.get("teams") or []:
        team = row.get("team") or {}
        abbr = canonical_team_abbr(team)
        if abbr:
            team["abbreviation"] = abbr
    return payload


def enrich_event_from_summary(event, payload):
    """Team schedule events omit final scores; summary.header has authoritative final competitors+scores."""
    out = copy.deepcopy(event)
    header_comps = ((payload.get("header") or {}).get("competitions") or [])
    if header_comps:
        src = header_comps[0]
        if not (out.get("competitions") or []):
            out["competitions"] = [copy.deepcopy(src)]
        else:
            dst = out["competitions"][0]
            dst["competitors"] = copy.deepcopy(src.get("competitors") or [])
            if src.get("status") is not None:
                dst["status"] = copy.deepcopy(src.get("status"))
            if src.get("date"):
                dst["date"] = src.get("date")
        if not out.get("date") and src.get("date"):
            out["date"] = src.get("date")
    return normalize_event(out)


def mapped_player(name, abbr, by_name):
    key = base.canon(name)
    candidates = by_name.get(key, [])
    if not candidates and key in NAME_ALIASES:
        candidates = by_name.get(NAME_ALIASES[key], [])
    if candidates:
        same = [p for p in candidates if str(p.get("ta") or "").upper() == abbr]
        if len(same) == 1:
            return same[0]
        if len(candidates) == 1:
            return candidates[0]
        if same:
            return same[0]
        return candidates[0]
    pid = PLAYER_ID_OVERRIDES.get(key)
    if pid:
        parts = str(name or "").strip().split(None, 1)
        return {"pid": pid, "fn": parts[0] if parts else name, "ln": parts[1] if len(parts) > 1 else "", "ta": abbr}
    return None


def classify_type(local_date, event, official_type):
    if official_type:
        return official_type
    espn_type = int(event.get("_espn_season_type") or 0)
    if espn_type == 5:
        return "Play-In"
    if espn_type == 3:
        return "Playoffs"
    text = (
        str(event.get("name") or "") + " " +
        " ".join(str((n or {}).get("headline") or "") for n in ((event.get("competitions") or [{}])[0].get("notes") or []))
    ).lower()
    if "nba cup" in text and ("final" in text or "championship" in text):
        return "NBA Cup Final"
    return "Regular Season"


def event_utc_date(event):
    value = str(event.get("date") or "")
    if not value:
        value = str(((event.get("competitions") or [{}])[0]).get("date") or "")
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def official_match(event, official_by_pair):
    home, away, _ = base.competitors(event)
    ha = canonical_team_abbr(home.get("team") or {})
    aa = canonical_team_abbr(away.get("team") or {})
    dt = event_utc_date(event)
    if not ha or not aa or dt is None:
        return None
    rows = official_by_pair.get((ha, aa), [])
    for d in (dt.date(), (dt - timedelta(days=1)).date(), (dt + timedelta(days=1)).date()):
        for row in rows:
            if row["game_date"] == d.isoformat():
                return row
    return None


def local_event_date(event, official_by_pair):
    matched = official_match(event, official_by_pair)
    if matched:
        return date.fromisoformat(matched["game_date"])
    dt = event_utc_date(event)
    if dt is None:
        raise ValueError(f"event {event.get('id')} missing date")
    return (dt - timedelta(hours=6)).date()


def fetch_team_schedule_events(season, timeout, attempts, workers):
    season_end = int(season[:4]) + 1
    jobs = [(abbr, team_id, st) for abbr, team_id in ESPN_TEAMS.items() for st in (2, 3, 5)]
    found, raw_rows, failures = {}, [], []

    def job(item):
        abbr, team_id, st = item
        url = ESPN_TEAM_SCHEDULE.format(team_id=team_id, season_end=season_end, season_type=st)
        try:
            payload, raw = base.fetch_json(url, timeout, attempts)
            return abbr, st, payload, raw, None
        except Exception as exc:
            return abbr, st, None, None, str(exc)

    with concurrent.futures.ThreadPoolExecutor(max_workers=min(workers, 16)) as ex:
        futs = [ex.submit(job, item) for item in jobs]
        done = 0
        for f in concurrent.futures.as_completed(futs):
            abbr, st, payload, raw, err = f.result()
            done += 1
            if err:
                failures.append({"team": abbr, "season_type": st, "error": err})
                continue
            raw_rows.append((abbr, st, raw))
            for raw_event in payload.get("events") or []:
                status_type = ((((raw_event.get("competitions") or [{}])[0].get("status") or {}).get("type") or {}))
                state = status_type.get("state") or (((raw_event.get("status") or {}).get("type") or {}).get("state"))
                completed = status_type.get("completed")
                if state != "post" or completed is not True:
                    continue
                event = normalize_event(raw_event)
                home, away, _ = base.competitors(event)
                ha = canonical_team_abbr(home.get("team") or {})
                aa = canonical_team_abbr(away.get("team") or {})
                if ha not in ESPN_TEAMS or aa not in ESPN_TEAMS:
                    continue
                eid = str(event.get("id") or "")
                if not eid:
                    continue
                event["_espn_season_type"] = st
                prev = found.get(eid)
                if prev is None or st > int(prev.get("_espn_season_type") or 0):
                    found[eid] = event
            if done % 15 == 0 or done == len(futs):
                print(f"{season}: team schedules {done}/{len(futs)}", flush=True)

    if failures:
        raise RuntimeError(f"{season}: team schedule request failures={len(failures)} sample={failures[:3]}")
    by_type = {2: 0, 3: 0, 5: 0}
    for event in found.values():
        st = int(event.get("_espn_season_type") or 0)
        by_type[st] = by_type.get(st, 0) + 1
    print(f"{season}: unique ESPN events={len(found)} by_type={by_type}", flush=True)
    if by_type.get(2, 0) < 1230:
        raise RuntimeError(f"{season}: incomplete regular-season discovery: {by_type.get(2,0)} < 1230")
    if by_type.get(5, 0) < 6:
        raise RuntimeError(f"{season}: incomplete play-in discovery: {by_type.get(5,0)} < 6")
    if by_type.get(3, 0) < 70:
        raise RuntimeError(f"{season}: incomplete playoff discovery: {by_type.get(3,0)} < 70")
    h = hashlib.sha256()
    for abbr, st, raw in sorted(raw_rows, key=lambda x: (x[0], x[1])):
        h.update(abbr.encode()); h.update(b"\0"); h.update(str(st).encode()); h.update(b"\0"); h.update(raw); h.update(b"\n")
    return found, h.hexdigest(), raw_rows


def main():
    a = base.args()
    root = Path(a.output_dir); rawdir = root / "raw"; sqldir = root / "sql"
    rawdir.mkdir(parents=True, exist_ok=True); sqldir.mkdir(parents=True, exist_ok=True)
    for f in sqldir.glob("*.sql"):
        f.unlink()
    base.map_player = mapped_player
    base.classify_type = classify_type
    summary, total_failures = [], 0

    for season in a.seasons:
        y = season[:4]
        players_payload, players_raw = base.fetch_json(base.NBA_PLAYERS.format(year=y), a.timeout, a.attempts)
        schedule_payload, schedule_raw = base.fetch_json(base.NBA_SCHEDULE.format(year=y), a.timeout, a.attempts)
        (rawdir / f"players_{season}.json").write_bytes(players_raw)
        (rawdir / f"schedule_{season}.json").write_bytes(schedule_raw)
        _, by_name, team_ids = base.official_directory(players_payload)
        if len(team_ids) != 30:
            raise RuntimeError(f"{season}: expected 30 canonical NBA teams, got {len(team_ids)}")
        official = base.official_schedule(schedule_payload)
        official_by_pair = {}
        for row in official:
            official_by_pair.setdefault((row["home_abbr"], row["away_abbr"]), []).append(row)
        official_by_key = {(r["game_date"], r["home_abbr"], r["away_abbr"]): r for r in official}

        events, discovery_sha, schedule_raws = fetch_team_schedule_events(season, a.timeout, a.attempts, a.workers)
        with gzip.open(rawdir / f"espn_team_schedules_{season}.jsonl.gz", "wt", encoding="utf-8") as gz:
            for abbr, st, rb in sorted(schedule_raws, key=lambda x: (x[0], x[1])):
                gz.write(json.dumps({"team": abbr, "season_type": st, "payload": json.loads(rb.decode("utf-8-sig"))}, separators=(",", ":"), ensure_ascii=False) + "\n")

        teams=[]; games=[]; teamfacts=[]; playerdims=[]; playerfacts=[]; failures=[]
        box_hash = hashlib.sha256(); results = {}

        def summary_job(item):
            eid, event = item
            try:
                payload, rb = base.fetch_json(base.ESPN_SUMMARY.format(event_id=eid), a.timeout, a.attempts)
                return eid, event, normalize_summary(payload), rb, None
            except Exception as exc:
                return eid, event, None, None, str(exc)

        with concurrent.futures.ThreadPoolExecutor(max_workers=a.workers) as ex:
            futs = [ex.submit(summary_job, item) for item in events.items()]
            done = 0
            for f in concurrent.futures.as_completed(futs):
                result = f.result(); results[result[0]] = result; done += 1
                if done % 100 == 0 or done == len(futs):
                    print(f"{season}: summaries {done}/{len(futs)}", flush=True)

        with gzip.open(rawdir / f"espn_summaries_{season}.jsonl.gz", "wt", encoding="utf-8") as gz:
            for eid in sorted(results):
                _, schedule_event, payload, rb, err = results[eid]
                if err:
                    failures.append({"event_id": eid, "error": err}); continue
                box_hash.update(eid.encode()); box_hash.update(b"\0"); box_hash.update(rb); box_hash.update(b"\n")
                try:
                    event = enrich_event_from_summary(schedule_event, payload)
                    event["_espn_season_type"] = schedule_event.get("_espn_season_type")
                    local_date = local_event_date(event, official_by_pair)
                    tt, gg, tf, pd, pf = base.parse_summary(season, local_date, event, payload, official_by_key, by_name, team_ids)
                    teams += tt; games += gg; teamfacts += tf; playerdims += pd; playerfacts += pf
                    gz.write(json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + "\n")
                except Exception as exc:
                    failures.append({"event_id": eid, "error": f"normalize: {exc}"})

        total_failures += len(failures)
        if failures:
            (rawdir / f"failures_{season}.json").write_text(json.dumps(failures, indent=2, ensure_ascii=False), encoding="utf-8")
        unique_games = {g[0] for g in games}
        if len(unique_games) != len(games):
            raise RuntimeError(f"{season}: duplicate game IDs after normalization")
        if len(teamfacts) != len(games) * 2:
            raise RuntimeError(f"{season}: team row count {len(teamfacts)} != 2 * games {len(games)}")

        now = datetime.now(timezone.utc).isoformat(); manifests = []
        for st in sorted({g[2] for g in games}):
            gs = [g for g in games if g[2] == st]; ids = {g[0] for g in gs}
            tf = [r for r in teamfacts if r[0] in ids]; pf = [r for r in playerfacts if r[0] in ids]; dates = [g[3] for g in gs]
            manifests.append([season, st, SOURCE, len(pf), len(tf), len(gs), min(dates), max(dates), hashlib.sha256(players_raw).hexdigest(), None, now, hashlib.sha256(schedule_raw).hexdigest(), box_hash.hexdigest(), len(failures)])
            summary.append({"season": season, "season_type": st, "games": len(gs), "team_rows": len(tf), "player_rows": len(pf), "failed_games": len(failures)})

        files = base.write_sql(sqldir, season, base.statements(teams, games, teamfacts, playerdims, playerfacts, manifests, a.statement_rows), a.statements_per_file)
        print(f"{season}: games={len(games)} team_rows={len(teamfacts)} player_rows={len(playerfacts)} failures={len(failures)} sql_files={len(files)} discovery_sha={discovery_sha[:12]}", flush=True)

    out = {"generated_at": datetime.now(timezone.utc).isoformat(), "source": SOURCE, "rows": summary, "total_failures": total_failures}
    (root / "summary.json").write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")
    if total_failures > a.allow_failures:
        raise RuntimeError(f"ESPN team-schedule NBA backfill had {total_failures} failures; allowed={a.allow_failures}")
    print(json.dumps(out, indent=2), flush=True)


if __name__ == "__main__":
    main()
