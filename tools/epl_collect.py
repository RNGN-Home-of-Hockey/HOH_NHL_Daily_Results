#!/usr/bin/env python3
"""Collect English Premier League statistics for the HOH football broadcast cards.

Sources (no keys, one request at a time with a pause, resumable):
- Premier League stats API (footballapi.pulselive.com): every completed league match since
  1992/93 with goals, match details (lineups, cards, substitutions) for matches between clubs of
  the current season, 2026/27 squads, PL career statistics of every squad player and all-time
  rankings (names and milestones).
- Fantasy Premier League API: season statistics, xG/xA, gameweek history, past seasons.
- Sports.ru: Russian club/player names. `names` only downloads the club pages and stops quietly
  when the site refuses us; it never tries to get around a refusal.

Everything lives under local-data/epl/ (git-ignored): `raw/` keeps every payload exactly as
received plus raw/manifest.jsonl (url, sha256, time), `normalized/` is produced by `build`.
Cached files are reused, so an interrupted run continues where it stopped.

Usage:
  python -I tools/epl_collect.py {matches,details,squads,ranked,fpl,names,build,all} [--refresh]
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import random
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone
from difflib import SequenceMatcher
from itertools import combinations
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "local-data" / "epl"
RAW = OUT / "raw"
NORM = OUT / "normalized"
MANIFEST = RAW / "manifest.jsonl"

UA = "HOH-EPL-Research/0.1 (+https://github.com/RNGN-Home-of-Hockey/HOH_NHL_Daily_Results)"
PL = "https://footballapi.pulselive.com/football"
PL_HEADERS = {"Origin": "https://www.premierleague.com"}
FPL = "https://fantasy.premierleague.com/api"
SPORTS = "https://www.sports.ru"
CURRENT_SEASON = 841  # Premier League 2026/27 in the PL stats API
HOST_GAP = {"footballapi.pulselive.com": 0.4, "fantasy.premierleague.com": 0.5, "www.sports.ru": 2.0}
RANKED = ("appearances", "goals", "goal_assist", "clean_sheet", "yellow_card", "red_card")
EMPTY_RUN_LIMIT = 40  # consecutive empty detail pages that mark the start of the API's history
# Match events that are goals: G goal, P penalty goal, O own goal. In all three the event's teamId is
# the side the goal counts for (for an own goal the player belongs to the other club).
GOAL_EVENTS = ("G", "P", "O")
# Letters that Unicode decomposition does not turn into plain ASCII.
LATIN_FIXES = str.maketrans({"ø": "o", "Ø": "O", "æ": "ae", "Æ": "AE", "ß": "ss", "đ": "d", "Đ": "D", "ł": "l", "Ł": "L", "œ": "oe", "ı": "i"})

# Sports.ru club slugs by Premier League club name (2026/27 clubs, checked on the tournament page).
SPORTS_CLUBS = {
    "arsenal": "arsenal", "aston villa": "aston-villa", "bournemouth": "bournemouth",
    "brentford": "brentford", "brighton & hove albion": "brighton", "chelsea": "chelsea",
    "coventry city": "coventry-city-fc", "crystal palace": "crystal-palace", "everton": "everton",
    "fulham": "fulham", "hull city": "hull", "ipswich town": "ipswich-town", "leeds united": "leeds",
    "liverpool": "liverpool", "manchester city": "manchester-city", "manchester united": "mu",
    "newcastle united": "newcastle", "nottingham forest": "nottingham-forest",
    "sunderland": "sunderland", "tottenham hotspur": "tottenham",
}

# Career statistics kept in players.json: our name -> PL API stat name. A stat missing from the
# payload means zero (the API omits zero values); all 200+ raw stats stay in raw/.
CAREER_STATS = {
    "appearances": "appearances", "starts": "game_started", "minutes": "mins_played",
    "goals": "goals", "assists": "goal_assist", "goals_open_play": "goals_openplay",
    "penalty_goals": "att_pen_goal", "headed_goals": "att_hd_goal", "winning_goals": "winning_goal",
    "shots": "total_scoring_att", "shots_on_target": "ontarget_scoring_att",
    "big_chances_created": "big_chance_created", "big_chances_scored": "big_chance_scored",
    "big_chances_missed": "big_chance_missed", "hit_woodwork": "hit_woodwork",
    "penalties_won": "penalty_won", "yellow_cards": "yellow_card", "red_cards": "red_card",
    "clean_sheets": "clean_sheet", "goals_conceded": "goals_conceded", "wins": "wins",
    "draws": "draws", "losses": "losses", "saves": "saves", "tackles": "total_tackle",
    "interceptions": "interception", "fouls": "fouls", "was_fouled": "was_fouled",
    "offsides": "total_offside", "passes": "total_pass", "accurate_passes": "accurate_pass",
    "touches": "touches", "key_passes": "total_att_assist", "crosses": "total_cross",
    "duels_won": "duel_won", "aerials_won": "aerial_won",
}
FPL_SEASON_FIELDS = (
    "minutes", "starts", "goals_scored", "assists", "clean_sheets", "goals_conceded", "own_goals",
    "penalties_saved", "penalties_missed", "yellow_cards", "red_cards", "saves", "bonus",
    "defensive_contribution", "total_points", "expected_goals", "expected_assists",
    "expected_goal_involvements", "expected_goals_conceded", "expected_goals_per_90",
    "expected_assists_per_90", "ict_index", "influence", "creativity", "threat", "form",
    "points_per_game", "selected_by_percent",
)
FPL_ROUND_FIELDS = (
    "round", "opponent_team", "was_home", "kickoff_time", "minutes", "starts", "goals_scored",
    "assists", "clean_sheets", "yellow_cards", "red_cards", "saves", "bonus", "total_points",
    "expected_goals", "expected_assists",
)
FPL_PAST_FIELDS = (
    "season_name", "minutes", "starts", "goals_scored", "assists", "clean_sheets", "goals_conceded",
    "yellow_cards", "red_cards", "saves", "bonus", "total_points", "expected_goals",
    "expected_assists",
)


class Refused(Exception):
    """A site keeps failing; the stage stops instead of pushing harder."""


class EmptyBody(Exception):
    """HTTP 200 with no content: the API simply has nothing for this resource."""


MISSING = object()  # a 404 answer (the resource does not exist)
_last_hit: dict[str, float] = {}


def log(message: str) -> None:
    print(message, flush=True)


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def http_get(url: str, headers: dict[str, str] | None = None, tries: int = 4, timeout: int = 45) -> tuple[int, bytes]:
    host = urlparse(url).netloc
    for attempt in range(1, tries + 1):
        pause = _last_hit.get(host, 0.0) + HOST_GAP.get(host, 1.0) - time.monotonic()
        if pause > 0:
            time.sleep(pause)
        request = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "gzip", **(headers or {})})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                body = response.read()
                if response.headers.get("Content-Encoding") == "gzip":
                    body = gzip.decompress(body)
                return response.status, body
        except urllib.error.HTTPError as error:
            if error.code not in (429, 500, 502, 503, 504) or attempt == tries:
                raise
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if attempt == tries:
                raise
        finally:
            _last_hit[host] = time.monotonic()
        time.sleep(min(60.0, 2.0 ** attempt * 2) + random.random())
    raise RuntimeError("unreachable")


def record(url: str, dest: Path, status: int, body: bytes) -> None:
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    row = {
        "url": url, "file": dest.relative_to(RAW).as_posix(), "status": status, "bytes": len(body),
        "sha256": hashlib.sha256(body).hexdigest(), "fetched_at": now_iso(),
    }
    with MANIFEST.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def fetch(url: str, dest: Path, *, headers: dict[str, str] | None = None, max_age_hours: float | None = None,
          refresh: bool = False, as_text: bool = False):
    """Return the parsed JSON (or text) of `url`, reusing the cached file while it is fresh."""
    if dest.exists() and not refresh:
        age_hours = (time.time() - dest.stat().st_mtime) / 3600
        if max_age_hours is None or age_hours <= max_age_hours:
            body = dest.read_bytes()
            return body.decode("utf-8") if as_text else json.loads(body)
    status, body = http_get(url, headers)
    if not body.strip():
        time.sleep(3)  # the API sometimes answers 200 with nothing for a page that exists: ask once more
        status, body = http_get(url, headers)
        if not body.strip():
            raise EmptyBody(url)
    parsed = body.decode("utf-8") if as_text else json.loads(body)  # a broken payload is never cached
    dest.parent.mkdir(parents=True, exist_ok=True)
    partial = dest.with_name(dest.name + ".part")
    partial.write_bytes(body)
    partial.replace(dest)
    record(url, dest, status, body)
    return parsed


class Guard:
    """Keeps a long loop going through single failures, stops it after a run of them."""

    def __init__(self, limit: int = 8) -> None:
        self.limit, self.streak, self.failures = limit, 0, 0

    def attempt(self, function, *args, **kwargs):
        try:
            result = function(*args, **kwargs)
            self.streak = 0
            return result
        except EmptyBody:
            self.streak = 0
            return MISSING
        except urllib.error.HTTPError as error:
            if error.code == 404:
                self.streak = 0
                return MISSING
            self._fail(error)
        except (urllib.error.URLError, TimeoutError, ConnectionError, json.JSONDecodeError) as error:
            self._fail(error)
        return None

    def _fail(self, error: Exception) -> None:
        self.streak += 1
        self.failures += 1
        log(f"  ! {type(error).__name__}: {error}")
        if self.streak >= self.limit:
            raise Refused(f"{self.limit} failures in a row, stopping this stage")


def write_json(path: Path, payload, indent: int | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_name(path.name + ".part")
    partial.write_text(json.dumps(payload, ensure_ascii=False, indent=indent, separators=None if indent else (",", ":")), encoding="utf-8")
    partial.replace(path)


def load_json(path: Path):
    return json.loads(path.read_bytes())


# ---------------------------------------------------------------------------------------------
# Small pure helpers (covered by tests/test_epl_collect.py)
# ---------------------------------------------------------------------------------------------

def short_season(label: str) -> str:
    match = re.search(r"(\d{4})\s*/\s*(\d{2,4})", label or "")
    return f"{match.group(1)}/{match.group(2)[-2:]}" if match else (label or "")


def minute_label(clock_label: str | None) -> str | None:
    match = re.match(r"\s*(\d+)(?:\+(\d+))?", clock_label or "")
    if not match:
        return None
    return f"{match.group(1)}+{match.group(2)}'" if match.group(2) else f"{match.group(1)}'"


def to_int(value) -> int | None:
    return None if value is None else int(value)


def normalize_fixture(fixture: dict) -> dict | None:
    """Slim record of one completed league match (home team first, as the API lists them)."""
    teams = fixture.get("teams") or []
    if len(teams) != 2 or any(team.get("score") is None for team in teams):
        return None
    gameweek = fixture.get("gameweek") or {}
    season = gameweek.get("compSeason") or {}
    millis = (fixture.get("kickoff") or {}).get("millis")
    kickoff = datetime.fromtimestamp(millis / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if millis else None

    def side(entry: dict) -> dict:
        team = entry["team"]
        return {"id": int(team["id"]), "name": team["name"], "abbr": (team.get("club") or {}).get("abbr"), "score": int(entry["score"])}

    goals = [
        {
            "person_id": int(goal["personId"]), "assist_id": to_int(goal.get("assistId")), "team_id": None,
            "minute": minute_label((goal.get("clock") or {}).get("label")), "kind": goal.get("description") or goal.get("type"),
        }
        for goal in fixture.get("goals") or [] if goal.get("personId") is not None
    ]
    return {
        "id": int(fixture["id"]), "season": short_season(season.get("label", "")), "season_id": to_int(season.get("id")),
        "gameweek": to_int(gameweek.get("gameweek")), "kickoff_utc": kickoff,
        "home": side(teams[0]), "away": side(teams[1]),
        "ground": (fixture.get("ground") or {}).get("name"), "attendance": to_int(fixture.get("attendance")),
        "goals": goals, "has_details": False,
    }


def slim_detail(detail: dict) -> dict:
    """Goals (with the scoring team), cards, substitutions and lineups of one match."""
    events = detail.get("events") or []

    def base(event: dict) -> dict:
        return {
            "person_id": to_int(event.get("personId")), "team_id": to_int(event.get("teamId")),
            "minute": minute_label((event.get("clock") or {}).get("label")), "kind": event.get("description") or event.get("type"),
        }

    goals = [{**base(e), "assist_id": to_int(e.get("assistId"))} for e in events if e.get("type") in GOAL_EVENTS and e.get("personId") is not None]
    cards = [base(e) for e in events if e.get("type") == "B"]
    subs = [base(e) for e in events if e.get("type") == "S"]
    lineups = {}
    for team_list in detail.get("teamLists") or []:
        lineups[str(int(team_list["teamId"]))] = {
            "formation": (team_list.get("formation") or {}).get("label"),
            "starters": [to_int(p.get("id")) for p in team_list.get("lineup") or []],
            "substitutes": [to_int(p.get("id")) for p in team_list.get("substitutes") or []],
        }
    referee = next((o["name"]["display"] for o in detail.get("matchOfficials") or [] if o.get("role") == "MAIN"), None)
    half = detail.get("halfTimeScore") or {}
    return {
        "goals": goals, "cards": cards, "substitutions": subs, "lineups": lineups, "referee": referee,
        "half_time": [half.get("homeScore"), half.get("awayScore")] if half else None,
    }


def result_for(match: dict, club: int) -> tuple[str, int, int]:
    home = match["home"]["id"] == club
    goals_for, goals_against = (match["home"]["score"], match["away"]["score"]) if home else (match["away"]["score"], match["home"]["score"])
    return ("W" if goals_for > goals_against else "L" if goals_for < goals_against else "D"), goals_for, goals_against


def brief(match: dict) -> dict:
    return {
        "id": match["id"], "season": match["season"], "date": (match["kickoff_utc"] or "")[:10] or None,
        "home": match["home"]["name"], "away": match["away"]["name"],
        "score": f"{match['home']['score']}-{match['away']['score']}", "ground": match["ground"],
    }


def summarize_pair(club_a: dict, club_b: dict, pair_matches: list[dict], names: dict[int, str]) -> dict:
    """Head-to-head record of two clubs; `pair_matches` must be sorted oldest first."""
    a, b = club_a["id"], club_b["id"]
    totals = {"played": 0, "a_wins": 0, "b_wins": 0, "draws": 0, "a_goals": 0, "b_goals": 0}
    hosting = {a: {"played": 0, "w": 0, "d": 0, "l": 0, "gf": 0, "ga": 0}, b: {"played": 0, "w": 0, "d": 0, "l": 0, "gf": 0, "ga": 0}}
    biggest = {a: None, b: None}
    scorers: Counter = Counter()
    for match in pair_matches:
        result_a, goals_a, goals_b = result_for(match, a)
        totals["played"] += 1
        totals["a_goals"] += goals_a
        totals["b_goals"] += goals_b
        totals["a_wins" if result_a == "W" else "b_wins" if result_a == "L" else "draws"] += 1
        host = match["home"]["id"]
        row = hosting[host]
        host_result = result_for(match, host)
        row["played"] += 1
        row[host_result[0].lower()] += 1
        row["gf"] += host_result[1]
        row["ga"] += host_result[2]
        for club, result in ((a, result_a), (b, {"W": "L", "L": "W", "D": "D"}[result_a])):
            if result == "W":
                margin = abs(goals_a - goals_b)
                if biggest[club] is None or margin > biggest[club][0]:
                    biggest[club] = (margin, match)
        for goal in match["goals"]:
            if goal["kind"] != "O":
                scorers[(goal["person_id"], goal["team_id"])] += 1
    latest_first = list(reversed(pair_matches))
    form_a = "".join(result_for(m, a)[0] for m in latest_first[:10])
    run = {a: 0, b: 0}
    for club in (a, b):
        for match in latest_first:
            if result_for(match, club)[0] == "L":
                break
            run[club] += 1
    return {
        "club_a": club_a, "club_b": club_b, **totals,
        "a_hosting": hosting[a], "b_hosting": hosting[b],
        "first_meeting": brief(pair_matches[0]) if pair_matches else None,
        "last_meeting": brief(pair_matches[-1]) if pair_matches else None,
        "form_a_last10_latest_first": form_a, "unbeaten_run": {"a": run[a], "b": run[b]},
        "biggest_win_a": {"margin": biggest[a][0], **brief(biggest[a][1])} if biggest[a] else None,
        "biggest_win_b": {"margin": biggest[b][0], **brief(biggest[b][1])} if biggest[b] else None,
        "top_scorers": [
            {"person_id": pid, "name": names.get(pid), "team_id": team, "goals": count}
            for (pid, team), count in scorers.most_common(8)
        ],
        "matches": [m["id"] for m in pair_matches],
    }


def normalize_latin(text: str | None) -> str:
    """Lower-case ASCII words: 'Martin Ødegaard' -> 'martin odegaard'."""
    text = unicodedata.normalize("NFKD", (text or "").translate(LATIN_FIXES))
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def parse_pl_birth(label: str | None) -> str | None:
    try:
        return datetime.strptime(label or "", "%d %B %Y").date().isoformat()
    except ValueError:
        return None


def name_similarity(a: str, b: str) -> float:
    """0..1, the better of character similarity and the share of common words, so that
    'gabriel martinelli' fits 'gabriel martinelli silva'."""
    words_a, words_b = set(a.split()), set(b.split())
    if not words_a or not words_b:
        return 0.0
    return max(SequenceMatcher(None, a, b).ratio(), len(words_a & words_b) / min(len(words_a), len(words_b)))


def parse_sportsru_team(html: str) -> dict:
    """Club name and players (Russian names) from the JSON-LD block of a Sports.ru squad page."""
    for block in re.findall(r'<script type="application/ld\+json">(.*?)</script>', html, re.S):
        try:
            data = json.loads(block)
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict) and data.get("@type") == "SportsTeam":
            athletes = []
            for person in data.get("athlete") or []:
                url = person.get("url") or ""
                athletes.append({
                    "name_ru": (person.get("name") or "").strip() or None, "slug": url.rstrip("/").rsplit("/", 1)[-1], "url": url,
                    "position_ru": person.get("jobTitle"), "nationality_ru": person.get("nationality"),
                    "birth_date": person.get("birthDate"), "height": person.get("height"),
                })
            return {"club_ru": data.get("name"), "athletes": athletes}
    return {"club_ru": None, "athletes": []}


def russian_surname(full_name: str | None) -> str | None:
    """'Вирджил ван Дейк' -> 'ван Дейк'; a single word (Бразилия, 'Рафинья') stays as it is."""
    parts = (full_name or "").split()
    if not parts:
        return None
    return " ".join(parts[1:]) if len(parts) > 1 else parts[0]


def match_russian_names(players: list[dict], athletes_by_club: dict[int, list[dict]]) -> dict[int, dict]:
    """pl_id -> {'athlete', 'match'}. Best pairs first, each Sports.ru player used once:
    club+birth date+similar name, club+birth date alone when it is unique in the squad (new players
    have only a number in their Sports.ru address), club+very similar name, then another
    club+birth date+name (transfers)."""
    birth_of = {p["pl_id"]: parse_pl_birth(p["birth_date"]) for p in players}
    players_per_birth = Counter((p["club"]["id"], birth_of[p["pl_id"]]) for p in players if birth_of[p["pl_id"]])
    athletes_per_birth = Counter((club, a["birth_date"]) for club, athletes in athletes_by_club.items() for a in athletes if a["birth_date"])
    pairs = []
    for player in players:
        latin = normalize_latin(player["name"])
        birth = birth_of[player["pl_id"]]
        for club_id, athletes in athletes_by_club.items():
            for athlete in athletes:
                sim = name_similarity(latin, normalize_latin(athlete["slug"].replace("-", " ")))
                same_birth = bool(birth and athlete["birth_date"] == birth)
                if club_id == player["club"]["id"]:
                    if same_birth and sim >= 0.34:
                        pairs.append((3 + sim, "club+birth", player, athlete))
                    elif same_birth and players_per_birth[(club_id, birth)] == 1 and athletes_per_birth[(club_id, birth)] == 1:
                        pairs.append((2.5 + sim / 10, "club+birth-only", player, athlete))
                    elif sim >= 0.85:
                        pairs.append((2 + sim, "club+name", player, athlete))
                elif same_birth and sim >= 0.6:
                    pairs.append((1 + sim, "transfer", player, athlete))
    matched: dict[int, dict] = {}
    used: set[str] = set()
    for _, kind, player, athlete in sorted(pairs, key=lambda pair: -pair[0]):
        if player["pl_id"] in matched or athlete["url"] in used:
            continue
        matched[player["pl_id"]] = {"athlete": athlete, "match": kind}
        used.add(athlete["url"])
    return matched


# ---------------------------------------------------------------------------------------------
# Collection stages
# ---------------------------------------------------------------------------------------------

def pl_seasons() -> list[tuple[int, str]]:
    data = fetch(f"{PL}/competitions/1/compseasons?page=0&pageSize=100", RAW / "pulselive" / "compseasons.json",
                 headers=PL_HEADERS, max_age_hours=12)
    return sorted((int(s["id"]), short_season(s["label"])) for s in data["content"])


def current_teams(refresh: bool = False) -> list[dict]:
    data = fetch(f"{PL}/teams?comps=1&compSeasons={CURRENT_SEASON}&altIds=true&pageSize=40",
                 RAW / "pulselive" / f"teams-{CURRENT_SEASON}.json", headers=PL_HEADERS, max_age_hours=12, refresh=refresh)
    return data["content"]


def stage_matches(refresh: bool) -> None:
    seasons = pl_seasons()
    for number, (season_id, label) in enumerate(seasons, 1):
        live = season_id == CURRENT_SEASON
        page = 0
        while True:
            url = f"{PL}/fixtures?comps=1&compSeasons={season_id}&statuses=C&sort=asc&page={page}&pageSize=100"
            data = fetch(url, RAW / "pulselive" / "fixtures" / f"{season_id:03d}-p{page:02d}.json", headers=PL_HEADERS,
                         max_age_hours=6 if live else None, refresh=refresh)
            page += 1
            if page >= data["pageInfo"]["numPages"]:
                break
        log(f"matches: season {label} done ({number}/{len(seasons)})")


def load_matches() -> list[dict]:
    matches: dict[int, dict] = {}
    for path in sorted((RAW / "pulselive" / "fixtures").glob("*.json")):
        for fixture in load_json(path)["content"]:
            match = normalize_fixture(fixture)
            if match:
                matches[match["id"]] = match
    return sorted(matches.values(), key=lambda m: (m["kickoff_utc"] or "", m["id"]))


def stage_squads(refresh: bool) -> None:
    teams = current_teams(refresh)
    squad: list[tuple[int, dict]] = []
    for team in teams:
        staff = fetch(f"{PL}/teams/{int(team['id'])}/compseasons/{CURRENT_SEASON}/staff?altIds=true&compSeasonId={CURRENT_SEASON}",
                      RAW / "pulselive" / "staff" / f"{int(team['id'])}.json", headers=PL_HEADERS, max_age_hours=12, refresh=refresh)
        squad.extend((int(team["id"]), player) for player in staff["players"])
    log(f"squads: {len(teams)} clubs, {len(squad)} players; downloading PL career statistics")
    guard = Guard()
    for number, (_, player) in enumerate(squad, 1):
        pid = int(player["id"])
        guard.attempt(fetch, f"{PL}/stats/player/{pid}?comps=1", RAW / "pulselive" / "player-stats" / f"{pid}.json",
                      headers=PL_HEADERS, max_age_hours=20, refresh=refresh)
        if number % 50 == 0:
            log(f"squads: {number}/{len(squad)} career files")
    log(f"squads: done, {guard.failures} failed requests")


def stage_ranked(refresh: bool) -> None:
    for entity in RANKED:
        page = 0
        while True:
            url = f"{PL}/stats/ranked/players/{entity}?page={page}&pageSize=100&comps=1&compCodeForActivePlayer=EN_PR&altIds=true"
            data = fetch(url, RAW / "pulselive" / "ranked" / f"{entity}-p{page:03d}.json", headers=PL_HEADERS,
                         max_age_hours=20, refresh=refresh)
            page += 1
            if page >= data["stats"]["pageInfo"]["numPages"]:
                break
        log(f"ranked: {entity} done ({page} pages)")


def stage_details(refresh: bool) -> None:
    clubs = {int(t["id"]) for t in current_teams()}
    todo = [m for m in load_matches() if m["home"]["id"] in clubs and m["away"]["id"] in clubs]
    todo.sort(key=lambda m: m["kickoff_utc"] or "", reverse=True)  # newest first: the most useful data arrives first
    folder = RAW / "pulselive" / "fixture-details"
    missing_path = folder / "_missing.txt"
    missing = set(missing_path.read_text().split()) if missing_path.exists() else set()
    # The API serves no detail pages before some date. After a long run of empty answers we record that
    # date and stop asking for older matches (delete both _ files to check again).
    stop_path = folder / "_no_details_before.txt"
    stop_before = stop_path.read_text().strip() if stop_path.exists() else ""
    todo = [m for m in todo if (m["kickoff_utc"] or "") >= stop_before]
    log(f"details: {len(todo)} matches between 2026/27 clubs to check, {len(missing)} known to have no detail page")
    guard = Guard()
    empty_run = 0
    for number, match in enumerate(todo, 1):
        if str(match["id"]) in missing:
            continue
        result = guard.attempt(fetch, f"{PL}/fixtures/{match['id']}", folder / f"{match['id']}.json",
                               headers=PL_HEADERS, refresh=refresh)
        if result is MISSING:
            folder.mkdir(parents=True, exist_ok=True)
            with missing_path.open("a", encoding="utf-8") as handle:
                handle.write(f"{match['id']}\n")
            empty_run += 1
            if empty_run >= EMPTY_RUN_LIMIT:
                stop_path.write_text(match["kickoff_utc"] or "", encoding="utf-8")
                log(f"details: {EMPTY_RUN_LIMIT} empty answers in a row, no detail pages before {match['kickoff_utc']}")
                break
        elif result is not None:
            empty_run = 0
        if number % 100 == 0:
            log(f"details: {number}/{len(todo)}")
    log(f"details: done, {guard.failures} failed requests")


def stage_fpl(refresh: bool) -> None:
    bootstrap = fetch(f"{FPL}/bootstrap-static/", RAW / "fpl" / "bootstrap-static.json", max_age_hours=6, refresh=refresh)
    fetch(f"{FPL}/fixtures/", RAW / "fpl" / "fixtures.json", max_age_hours=6, refresh=refresh)
    elements = bootstrap["elements"]
    log(f"fpl: bootstrap ok, {len(elements)} players; downloading per-player history")
    guard = Guard()
    for number, element in enumerate(elements, 1):
        element_id = int(element["id"])
        guard.attempt(fetch, f"{FPL}/element-summary/{element_id}/", RAW / "fpl" / "element-summary" / f"{element_id}.json",
                      max_age_hours=20, refresh=refresh)
        if number % 100 == 0:
            log(f"fpl: {number}/{len(elements)}")
    log(f"fpl: done, {guard.failures} failed requests")


def stage_names(refresh: bool) -> None:
    """Download the Sports.ru squad page of every club (names are read from it in `build`)."""
    guard = Guard(limit=2)
    saved = 0
    for team in current_teams():
        slug = SPORTS_CLUBS.get(team["name"].lower())
        if not slug:
            log(f"names: no Sports.ru slug for '{team['name']}'")
            continue
        try:
            page = guard.attempt(fetch, f"{SPORTS}/football/club/{slug}/team/", RAW / "sportsru" / f"team-{slug}.html",
                                 max_age_hours=24 * 7, refresh=refresh, as_text=True)
        except Refused as error:
            log(f"names: Sports.ru refuses requests ({error}); nothing downloaded, not retrying with other tricks")
            return
        saved += page not in (None, MISSING)
    log(f"names: {saved} club pages saved")


# ---------------------------------------------------------------------------------------------
# build: normalized data sets and the coverage report
# ---------------------------------------------------------------------------------------------

def load_people() -> tuple[dict[int, dict], dict[int, dict]]:
    """Person id -> names (ranking pages and squads), and all-time rank/value per entity."""
    people: dict[int, dict] = {}
    all_time: dict[int, dict] = defaultdict(dict)

    def remember(owner: dict) -> None:
        pid = to_int(owner.get("id"))
        if pid is None:
            return
        name = owner.get("name") or {}
        people.setdefault(pid, {
            "name": name.get("display"), "first": name.get("first"), "last": name.get("last"),
            "nationality": (owner.get("nationalTeam") or {}).get("isoCode"), "position": (owner.get("info") or {}).get("position"),
        })

    for path in sorted((RAW / "pulselive" / "ranked").glob("*.json")):
        entity = path.name.split("-p")[0]
        for row in load_json(path)["stats"]["content"]:
            remember(row["owner"])
            all_time[int(row["owner"]["id"])][entity] = {"rank": int(row["rank"]), "value": row["value"]}
    for path in sorted((RAW / "pulselive" / "staff").glob("*.json")):
        for player in load_json(path)["players"]:
            remember(player)
    return people, all_time


def load_details() -> dict[int, dict]:
    details = {}
    for path in (RAW / "pulselive" / "fixture-details").glob("*.json"):
        details[int(path.stem)] = slim_detail(load_json(path))
    return details


def numeric(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return value
    return int(number) if number.is_integer() and not isinstance(value, str) else number


def build_players(teams: list[dict], people: dict, all_time: dict) -> tuple[list[dict], dict]:
    fpl_path = RAW / "fpl" / "bootstrap-static.json"
    fpl = load_json(fpl_path) if fpl_path.exists() else {"elements": [], "teams": []}
    fpl_by_opta = {}
    for element in fpl["elements"]:
        for key in (str(element.get("opta_code") or "").lstrip("p"), str(element.get("code") or "")):
            if key:
                fpl_by_opta.setdefault(key, element)
    fpl_team_names = {int(t["id"]): t["name"] for t in fpl["teams"]}
    players, matched_fpl = [], set()
    for team in teams:
        tid = int(team["id"])
        staff = load_json(RAW / "pulselive" / "staff" / f"{tid}.json")
        for entry in staff["players"]:
            pid = int(entry["id"])
            stats_path = RAW / "pulselive" / "player-stats" / f"{pid}.json"
            career, entity = {}, {}
            if stats_path.exists():
                payload = load_json(stats_path)
                entity = payload.get("entity") or {}
                raw_stats = {s["name"]: s["value"] for s in payload.get("stats") or []}
                career = {ours: numeric(raw_stats.get(theirs, 0)) for ours, theirs in CAREER_STATS.items()}
            opta = str((entry.get("altIds") or {}).get("opta") or "").lstrip("p")
            element = fpl_by_opta.get(opta)
            fpl_block = history = past = None
            if element:
                matched_fpl.add(int(element["id"]))
                fpl_block = {f: numeric(element.get(f)) for f in FPL_SEASON_FIELDS}
                fpl_block.update({
                    "fpl_id": int(element["id"]), "web_name": element.get("web_name"), "status": element.get("status"),
                    "news": element.get("news") or None, "news_added": element.get("news_added"),
                    "chance_of_playing_next_round": element.get("chance_of_playing_next_round"), "price_tenths": element.get("now_cost"),
                    "penalties_order": element.get("penalties_order"), "direct_freekicks_order": element.get("direct_freekicks_order"),
                    "corners_order": element.get("corners_and_indirect_freekicks_order"),
                })
                summary_path = RAW / "fpl" / "element-summary" / f"{int(element['id'])}.json"
                if summary_path.exists():
                    summary = load_json(summary_path)
                    history = [{**{f: numeric(row.get(f)) for f in FPL_ROUND_FIELDS},
                                "opponent": fpl_team_names.get(row.get("opponent_team"))} for row in summary.get("history") or []]
                    past = [{f: numeric(row.get(f)) for f in FPL_PAST_FIELDS} for row in summary.get("history_past") or []]
            name = entry.get("name") or {}
            birth = (entry.get("birth") or {}).get("date") or {}
            players.append({
                "pl_id": pid, "opta_id": (entry.get("altIds") or {}).get("opta"),
                "name": name.get("display"), "first_name": name.get("first"), "last_name": name.get("last"),
                "name_ru": None, "surname_ru": None, "name_ru_source": None, "name_ru_match": None, "sportsru_url": None,
                "club": {"id": tid, "name": team["name"], "abbr": (team.get("club") or {}).get("abbr")},
                "position": (entry.get("info") or {}).get("position"), "position_detail": (entry.get("info") or {}).get("positionInfo"),
                "shirt_number": to_int((entry.get("info") or {}).get("shirtNum")),
                "nationality": (entry.get("nationalTeam") or {}).get("country"), "nationality_iso": (entry.get("nationalTeam") or {}).get("isoCode"),
                "birth_date": birth.get("label"), "birth_place": ((entity.get("birth") or {}).get("place")),
                "height_cm": to_int(entry.get("height")), "weight_kg": to_int(entry.get("weight")),
                "joined_club": (entry.get("joinDate") or {}).get("label"),
                "pl_career": career or None, "pl_all_time_rank": all_time.get(pid) or None,
                "season_2026_27": fpl_block, "season_2026_27_by_gameweek": history, "past_seasons": past,
            })
    unmatched_fpl = [e for e in fpl["elements"] if int(e["id"]) not in matched_fpl]
    return players, {
        "fpl_players": len(fpl["elements"]), "fpl_matched": len(matched_fpl),
        "fpl_unmatched": [f"{e['first_name']} {e['second_name']} ({fpl_team_names.get(e['team'])})" for e in unmatched_fpl[:40]],
    }


def apply_russian_names(players: list[dict], teams: list[dict]) -> tuple[dict[int, dict], dict]:
    """Fill name_ru/surname_ru from the saved Sports.ru squad pages; returns club names and a report."""
    parsed: dict[int, dict] = {}
    for team in teams:
        slug = SPORTS_CLUBS.get(team["name"].lower())
        path = RAW / "sportsru" / f"team-{slug}.html" if slug else None
        if path and path.exists():
            parsed[int(team["id"])] = parse_sportsru_team(path.read_text(encoding="utf-8"))
    matches = match_russian_names(players, {club: page["athletes"] for club, page in parsed.items()})
    for player in players:
        found = matches.get(player["pl_id"])
        if found:
            athlete = found["athlete"]
            player.update({
                "name_ru": athlete["name_ru"], "surname_ru": russian_surname(athlete["name_ru"]),
                "name_ru_source": "sports.ru", "name_ru_match": found["match"], "sportsru_url": athlete["url"],
            })
    used = {found["athlete"]["url"] for found in matches.values()}
    on_site = [a for page in parsed.values() for a in page["athletes"]]
    report = {
        "squad_pages": len(parsed), "athletes_on_sportsru": len(on_site), "players_matched": len(matches),
        "by_match": dict(Counter(found["match"] for found in matches.values())),
        "players_without_name": [f"{p['name']} ({p['club']['name']})" for p in players if not p["name_ru"]][:80],
        "sportsru_athletes_unused": [f"{a['name_ru']} ({a['slug']})" for a in on_site if a["url"] not in used][:40],
    }
    return {club: page["club_ru"] for club, page in parsed.items()}, report


def stage_build(_refresh: bool = False) -> None:
    NORM.mkdir(parents=True, exist_ok=True)
    teams = current_teams()
    clubs = {int(t["id"]): {"id": int(t["id"]), "name": t["name"], "abbr": (t.get("club") or {}).get("abbr")} for t in teams}
    matches = load_matches()
    details = load_details()
    people, all_time = load_people()
    goal_kinds: Counter = Counter()
    for match in matches:
        detail = details.get(match["id"])
        if detail:
            match["has_details"] = True
            if detail["goals"]:
                match["goals"] = detail["goals"]
        for goal in match["goals"]:
            goal_kinds[goal["kind"]] += 1
    names = {pid: p["name"] for pid, p in people.items() if p.get("name")}

    by_pair: dict[frozenset, list[dict]] = defaultdict(list)
    for match in matches:
        if match["home"]["id"] in clubs and match["away"]["id"] in clubs:
            by_pair[frozenset((match["home"]["id"], match["away"]["id"]))].append(match)
    h2h = {}
    for a, b in combinations(sorted(clubs), 2):
        pair_matches = by_pair.get(frozenset((a, b)), [])
        h2h[f"{a}-{b}"] = summarize_pair(clubs[a], clubs[b], pair_matches, names)

    players, fpl_report = build_players(teams, people, all_time)
    club_names_ru, names_report = apply_russian_names(players, teams)
    for club_id, club in clubs.items():
        club["name_ru"] = club_names_ru.get(club_id)
    scorer_ids ={g["person_id"] for m in matches for g in m["goals"]}
    consistent = sum(1 for m in matches if len(m["goals"]) == m["home"]["score"] + m["away"]["score"])
    scoreless = sum(1 for m in matches if m["home"]["score"] + m["away"]["score"] == 0)
    per_season = Counter(m["season"] for m in matches)
    scope = [m for m in matches if m["home"]["id"] in clubs and m["away"]["id"] in clubs]
    with_team = sum(1 for m in scope if m["has_details"] and all(g["team_id"] is not None for g in m["goals"]))
    report = {
        "generated_at": now_iso(),
        "seasons": {"count": len(per_season), "first": min(per_season, default=None), "last": max(per_season, default=None)},
        "matches": {
            "total": len(matches), "goal_list_matches_score": consistent, "scoreless_matches": scoreless,
            "goal_list_complete_pct": round(100 * consistent / len(matches), 1) if matches else None,
            "per_season": dict(sorted(per_season.items())), "goal_kinds": dict(goal_kinds),
        },
        "persons": {
            "scorers_and_assisters_ids": len(scorer_ids), "names_known": len(people),
            "scorer_ids_without_name": len([p for p in scorer_ids if p not in names]),
        },
        "head_to_head": {
            "pairs_total": len(h2h), "pairs_with_meetings": sum(1 for p in h2h.values() if p["played"]),
            "matches_in_scope": len(scope), "scope_with_details": sum(1 for m in scope if m["has_details"]),
            "scope_goals_with_team": with_team,
        },
        "players": {
            "squad_players": len(players), "with_career_stats": sum(1 for p in players if p["pl_career"]),
            "with_fpl_season": sum(1 for p in players if p["season_2026_27"]),
            "with_gameweek_history": sum(1 for p in players if p["season_2026_27_by_gameweek"]),
            "with_past_seasons": sum(1 for p in players if p["past_seasons"]),
            "with_russian_name": sum(1 for p in players if p["name_ru"]),
            **fpl_report,
        },
        "names_ru": names_report,
    }
    write_json(NORM / "teams.json", list(clubs.values()), indent=2)
    write_json(NORM / "matches.json", matches)
    write_json(NORM / "match_details.json", {str(k): v for k, v in details.items()})
    write_json(NORM / "h2h.json", h2h)
    write_json(NORM / "players.json", players)
    write_json(NORM / "people.json", {str(k): v for k, v in people.items()})
    write_json(NORM / "report.json", report, indent=2)
    log(json.dumps(report, ensure_ascii=False, indent=2))


STAGES = {
    "matches": stage_matches, "details": stage_details, "squads": stage_squads, "ranked": stage_ranked,
    "fpl": stage_fpl, "names": stage_names, "build": stage_build,
}
ALL_ORDER = ("matches", "squads", "ranked", "fpl", "details", "names", "build")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("stage", choices=[*STAGES, "all"])
    parser.add_argument("--refresh", action="store_true", help="ignore cached files and download again")
    args = parser.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8")
    failed = False
    for name in ALL_ORDER if args.stage == "all" else (args.stage,):
        log(f"== {name}")
        try:
            STAGES[name](args.refresh)
        except (Refused, urllib.error.URLError, TimeoutError, ConnectionError) as error:
            failed = True
            log(f"!! stage '{name}' stopped: {type(error).__name__}: {error}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
