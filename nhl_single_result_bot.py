#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
HOH · NHL Single Result Bot — per-game posts & autopost (no repeats)
"""

from __future__ import annotations
import os
import re
import json
import time
import textwrap
import pathlib
import html
import unicodedata
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Callable, Dict, List, Optional, Tuple
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone, date
from difflib import SequenceMatcher
from zoneinfo import ZoneInfo
from urllib.parse import quote_plus, urljoin

import requests

try:
    from bs4 import BeautifulSoup as BS  # type: ignore
    HAS_BS = True
except Exception:
    HAS_BS = False

TG_API = "https://api.telegram.org"
DEFAULT_TELEGRAM_CHAT_ID = "-1003167239288"
NHLE_BASE = "https://api-web.nhle.com/v1"
PBP_FMT = NHLE_BASE + "/gamecenter/{gamePk}/play-by-play"
SCHED_FMT = NHLE_BASE + "/schedule/{ymd}"

PT_TZ = ZoneInfo("America/Los_Angeles")


def _env_str(name: str, default: str = "") -> str:
    v = os.getenv(name)
    return v if v is not None else default


def _env_bool(name: str, default: bool = False) -> bool:
    v = os.getenv(name)
    if v is None:
        return default
    return str(v).strip().lower() in ("1", "true", "yes", "y", "on")


DRY_RUN = _env_bool("DRY_RUN", False)
DEBUG_VERBOSE = _env_bool("DEBUG_VERBOSE", False)
STATE_PATH = _env_str("STATE_PATH", "state/posted_games.json").strip() or "state/posted_games.json"
TARGET_DATE = _env_str("TARGET_DATE", "").strip()
HOH_DATA_CORE_URL = _env_str("HOH_DATA_CORE_URL", "https://hoh-nhl-daily-results.znamteam-903.workers.dev").strip().rstrip("/")
TELEGRAM_INTERACTIVE_ENABLED = _env_bool("TELEGRAM_INTERACTIVE_ENABLED", True)
HOH_CHANNEL_URL = _env_str("HOH_CHANNEL_URL", "http://t.me/home_of_hockey").strip() or "http://t.me/home_of_hockey"
BOT_COMMANDS_VERSION = "2026-09-21-v1"
SPORTSRU_NAMES_PATH = _env_str("SPORTSRU_NAMES_PATH", "ru_full_names.json").strip() or "ru_full_names.json"
SPORTSRU_ON_DEMAND_ENABLED = _env_bool("SPORTSRU_ON_DEMAND_ENABLED", True)
SPORTSRU_HOST = "https://www.sports.ru"
SPORTSRU_SEARCH_URL = SPORTSRU_HOST + "/search/?q="
INTERACTIVE_STARTED_AT = time.monotonic()

TEAM_RU = {
    "ANA": "Анахайм", "ARI": "Аризона", "BOS": "Бостон", "BUF": "Баффало", "CGY": "Калгари", "CAR": "Каролина",
    "CHI": "Чикаго", "COL": "Колорадо", "CBJ": "Коламбус", "DAL": "Даллас", "DET": "Детройт", "EDM": "Эдмонтон",
    "FLA": "Флорида", "LAK": "Лос-Анджелес", "MIN": "Миннесота", "MTL": "Монреаль", "NSH": "Нэшвилл",
    "NJD": "Нью-Джерси", "NYI": "Айлендерс", "NYR": "Рейнджерс", "OTT": "Оттава", "PHI": "Филадельфия",
    "PIT": "Питтсбург", "SJS": "Сан-Хосе", "SEA": "Сиэтл", "STL": "Сент-Луис", "TBL": "Тампа-Бэй",
    "TOR": "Торонто", "VAN": "Ванкувер", "VGK": "Вегас", "WSH": "Вашингтон", "WPG": "Виннипег", "UTA": "Юта",
}
TEAM_EMOJI = {
    "ANA": "🦆", "ARI": "🦂", "BOS": "🐻", "BUF": "🦬", "CGY": "🔥", "CAR": "🌪️", "CHI": "🦅", "COL": "⛰️", "CBJ": "💣",
    "DAL": "⭐️", "DET": "🛡️", "EDM": "🛢️", "FLA": "🐆", "LAK": "👑", "MIN": "🌲", "MTL": "🇨🇦", "NSH": "🐯",
    "NJD": "😈", "NYI": "🏝️", "NYR": "🗽", "OTT": "🛡", "PHI": "🛩", "PIT": "🐧", "SJS": "🦈", "SEA": "🦑", "STL": "🎵",
    "TBL": "⚡", "TOR": "🍁", "VAN": "🐳", "VGK": "🎰", "WSH": "🦅", "WPG": "✈️", "UTA": "🧊",
}

SPORTSRU_SLUGS = {
    "ANA": ["anaheim-ducks"],
    "ARI": ["arizona-coyotes"],
    "BOS": ["boston-bruins"],
    "BUF": ["buffalo-sabres"],
    "CGY": ["calgary-flames"],
    "CAR": ["carolina-hurricanes"],
    "CHI": ["chicago-blackhawks"],
    "COL": ["colorado-avalanche"],
    "CBJ": ["columbus-blue-jackets"],
    "DAL": ["dallas-stars"],
    "DET": ["detroit-red-wings"],
    "EDM": ["edmonton-oilers"],
    "FLA": ["florida-panthers"],
    "LAK": ["los-angeles-kings", "la-kings"],
    "MIN": ["minnesota-wild"],
    "MTL": ["montreal-canadiens"],
    "NSH": ["nashville-predators"],
    "NJD": ["new-jersey-devils"],
    "NYI": ["new-york-islanders"],
    "NYR": ["new-york-rangers"],
    "OTT": ["ottawa-senators"],
    "PHI": ["philadelphia-flyers"],
    "PIT": ["pittsburgh-penguins"],
    "SJS": ["san-jose-sharks"],
    "SEA": ["seattle-kraken"],
    "STL": ["st-louis-blues", "saint-louis-blues", "stlouis-blues"],
    "TBL": ["tampa-bay-lightning"],
    "TOR": ["toronto-maple-leafs"],
    "VAN": ["vancouver-canucks"],
    "VGK": ["vegas", "vegas-golden-knights", "vegas-knights", "vgk"],
    "WSH": ["washington-capitals"],
    "WPG": ["winnipeg-jets"],
    "UTA": ["utah-mammoth", "utah", "utah-hockey-club", "utah-hc", "utah-hc-nhl", "utah-mammoths"],
}

UA_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    "Accept-Language": "ru,en;q=0.8",
}


def dbg(*args: Any) -> None:
    if DEBUG_VERBOSE:
        print("[DBG]", *args, flush=True)


def _get_with_retries(url: str, timeout: int = 30, tries: int = 3, backoff: float = 0.75, as_text: bool = False):
    last = None
    for attempt in range(1, tries + 1):
        try:
            r = requests.get(url, headers=UA_HEADERS, timeout=timeout)
            r.raise_for_status()
            if as_text:
                r.encoding = r.apparent_encoding or "utf-8"
                return r.text
            return r.json()
        except Exception as e:
            last = e
            status = getattr(getattr(e, "response", None), "status_code", None)
            if status in (400, 401, 403, 404):
                raise
            if attempt < tries:
                sleep_s = backoff * (2 ** (attempt - 1))
                dbg(f"retry {attempt}/{tries} for {url} after {sleep_s:.2f}s: {repr(e)}")
                time.sleep(sleep_s)
            else:
                raise
    raise last


def http_get_json(url: str, timeout: int = 30) -> Any:
    return _get_with_retries(url, timeout=timeout, as_text=False)


def http_get_text(url: str, timeout: int = 30) -> str:
    return _get_with_retries(url, timeout=timeout, as_text=True)


@dataclass
class TeamRecord:
    wins: int
    losses: int
    ot: int
    points: int

    def as_str(self) -> str:
        return f"{self.wins}-{self.losses}-{self.ot}"


@dataclass
class GameMeta:
    gamePk: int
    gameDateUTC: datetime
    state: str
    home_tri: str
    away_tri: str
    home_score: int
    away_score: int
    game_type: int = 0
    series_game: Optional[int] = None
    home_series_wins: Optional[int] = None
    away_series_wins: Optional[int] = None


@dataclass
class ScoringEvent:
    period: int
    period_type: str
    time: str
    team_for: str
    home_goals: int
    away_goals: int
    scorer: str
    assists: List[str] = field(default_factory=list)
    scorer_id: Optional[int] = None
    assist_ids: List[int] = field(default_factory=list)
    is_shootout_winner: bool = False
    is_shootout_scored: bool = False


@dataclass
class SRUGoal:
    time: Optional[str]
    scorer_ru: Optional[str]
    assists_ru: List[str]


@dataclass
class SRUShootoutWinner:
    scorer_ru: Optional[str]


def _upper_str(x: Any) -> str:
    try:
        return str(x or "").upper()
    except Exception:
        return ""


def _first_int(*vals) -> int:
    for v in vals:
        if v is None:
            continue
        try:
            s = str(v).strip()
            if s == "":
                continue
            return int(float(s))
        except Exception:
            continue
    return 0


def _truthy(val: Any) -> bool:
    if isinstance(val, bool):
        return val
    if isinstance(val, (int, float)):
        return val != 0
    if isinstance(val, str):
        return val.strip().lower() in ("1", "true", "yes", "y", "on")
    return False


def _extract_name(obj_or_str: Any) -> Optional[str]:
    if not obj_or_str:
        return None
    if isinstance(obj_or_str, str):
        return obj_or_str.strip() or None
    if isinstance(obj_or_str, dict):
        for k in ("name", "default", "fullName", "firstLastName", "lastFirstName", "shortName"):
            v = obj_or_str.get(k)
            if isinstance(v, str) and v.strip():
                return v.strip()
    return None


def _clean_person_name(s: str) -> str:
    s = (s or "").strip()
    s = re.sub(r"^\(+", "", s)
    s = re.sub(r"\)+$", "", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip()


def _clean_assists(items: List[str]) -> List[str]:
    out: List[str] = []
    seen = set()
    for a in items or []:
        aa = _clean_person_name(a)
        if not aa:
            continue
        if aa not in seen:
            seen.add(aa)
            out.append(aa)
    return out


def _roster_name_map(data: dict) -> Dict[int, str]:
    out: Dict[int, str] = {}
    for spot in data.get("rosterSpots") or []:
        pid = _first_int(spot.get("playerId"))
        if not pid:
            continue
        first = _extract_name(spot.get("firstName")) or ""
        last = _extract_name(spot.get("lastName")) or ""
        full = _clean_person_name(f"{first} {last}")
        if full:
            out[pid] = full
    return out


def _player_name_from_id(details: dict, roster_names: Dict[int, str], *keys: str) -> str:
    for key in keys:
        pid = _first_int(details.get(key))
        if pid and pid in roster_names:
            return roster_names[pid]
    return ""


def _contains_cyrillic(value: str) -> bool:
    return bool(re.search(r"[А-Яа-яЁё]", str(value or "")))


def _contains_latin(value: str) -> bool:
    return bool(re.search(r"[A-Za-z]", str(value or "")))


def _sportsru_short_name(full_name_ru: str) -> str:
    """Keep Sports.ru spelling, but use the surname form used in goal summaries."""
    name = _clean_person_name(full_name_ru)
    if not name:
        return ""
    parts = name.split()
    if len(parts) <= 1:
        return name
    particles = {"ван", "вон", "фон", "де", "дер", "ден", "ла", "ле", "ди", "да", "дель"}
    if len(parts) >= 3 and parts[-2].lower().strip(".\'’") in particles:
        return " ".join(parts[-2:])
    return parts[-1]


def load_sportsru_names(path: str = SPORTSRU_NAMES_PATH) -> Dict[int, str]:
    """Player-id -> Sports.ru Russian display name. Never invent transliterations here."""
    p = pathlib.Path(path)
    if not p.exists():
        print(f"[WARN] Sports.ru name cache missing: {path}")
        return {}
    try:
        raw = json.loads(p.read_text("utf-8") or "{}")
    except Exception as exc:
        print(f"[WARN] Sports.ru name cache unreadable: {exc}")
        return {}
    out: Dict[int, str] = {}
    for raw_id, raw_name in (raw or {}).items():
        try:
            pid = int(raw_id)
        except Exception:
            continue
        name = _sportsru_short_name(str(raw_name or ""))
        if pid > 0 and name and _contains_cyrillic(name):
            out[pid] = name
    dbg("Sports.ru names loaded:", len(out))
    return out


def _sportsru_latin_norm(value: str) -> str:
    raw = unicodedata.normalize("NFKD", str(value or ""))
    raw = raw.encode("ascii", "ignore").decode("ascii").lower()
    return re.sub(r"[^a-z0-9]+", " ", raw).strip()


def _sportsru_person_slug(full_name_en: str) -> str:
    return _sportsru_latin_norm(full_name_en).replace(" ", "-")


SPORTSRU_CYR_LAT = {
    "а":"a","б":"b","в":"v","г":"g","д":"d","е":"e","ё":"e","ж":"zh","з":"z","и":"i","й":"i",
    "к":"k","л":"l","м":"m","н":"n","о":"o","п":"p","р":"r","с":"s","т":"t","у":"u","ф":"f",
    "х":"kh","ц":"ts","ч":"ch","ш":"sh","щ":"shch","ъ":"","ы":"y","ь":"","э":"e","ю":"yu","я":"ya",
}


def _sportsru_ru_latin(value: str) -> str:
    raw = "".join(SPORTSRU_CYR_LAT.get(ch, ch) for ch in str(value or "").lower().replace("ё", "е"))
    raw = unicodedata.normalize("NFKD", raw)
    raw = "".join(ch for ch in raw if not unicodedata.combining(ch))
    raw = re.sub(r"[^a-z0-9]+", " ", raw).strip()
    return raw.replace("kh", "h").replace("ts", "c").replace("iy", "i").replace("yy", "y")


def _sportsru_name_similarity(full_name_en: str, name_ru: str) -> float:
    en = _sportsru_latin_norm(full_name_en)
    ru = _sportsru_ru_latin(name_ru)
    if not en or not ru:
        return 0.0
    best = SequenceMatcher(None, en, ru).ratio()
    ep, rp = en.split(), ru.split()
    if len(ep) >= 2 and len(rp) >= 2:
        first = SequenceMatcher(None, ep[0], rp[0]).ratio()
        last = SequenceMatcher(None, ep[-1], rp[-1]).ratio()
        best = max(best, 0.68 * last + 0.32 * first)
    return best


def _sportsru_team_roster_url(team_tri: str) -> str:
    slugs = SPORTSRU_SLUGS.get(str(team_tri or "").upper(), [])
    if not slugs:
        return ""
    return f"{SPORTSRU_HOST}/hockey/club/{slugs[0]}/team/"


def fetch_sportsru_team_roster_names(team_tri: str) -> List[str]:
    """Return full Russian player names from the current Sports.ru club roster."""
    if not HAS_BS:
        return []
    url = _sportsru_team_roster_url(team_tri)
    if not url:
        return []
    try:
        page = http_get_text(url, timeout=12)
    except Exception as exc:
        dbg(f"Sports.ru roster fetch failed {team_tri} {url}: {exc}")
        return []

    soup = BS(page, "html.parser")
    names: List[str] = []
    seen = set()
    position_words = ("вратарь", "защитник", "нападающий")

    for row in soup.find_all("tr"):
        text = " ".join(row.stripped_strings)
        if not any(word in text.lower() for word in position_words):
            continue
        links = row.find_all("a")
        for link in links:
            name = _clean_person_name(" ".join(link.stripped_strings))
            if len(name.split()) < 2 or not _contains_cyrillic(name) or _contains_latin(name):
                continue
            if name not in seen:
                seen.add(name)
                names.append(name)
            break

    # Fallback for alternate Sports.ru layouts where roster items are not table rows.
    if not names:
        for row in soup.find_all(["li", "div"]):
            text = " ".join(row.stripped_strings)
            if not any(word in text.lower() for word in position_words):
                continue
            for link in row.find_all("a"):
                name = _clean_person_name(" ".join(link.stripped_strings))
                if len(name.split()) < 2 or not _contains_cyrillic(name) or _contains_latin(name):
                    continue
                if name not in seen:
                    seen.add(name)
                    names.append(name)
                break
    dbg(f"Sports.ru roster {team_tri}: {len(names)} names from {url}")
    return names


def resolve_sportsru_name_from_team_roster(full_name_en: str, roster_names: List[str]) -> str:
    scored = sorted(
        ((_sportsru_name_similarity(full_name_en, name), name) for name in roster_names),
        reverse=True,
    )
    if not scored:
        return ""
    best_score, best_name = scored[0]
    second_score = scored[1][0] if len(scored) > 1 else 0.0
    margin = best_score - second_score

    # Russian transliteration can score lower than expected even when the roster
    # candidate is clearly unique (Avery Hayes -> Эйвери Хэйс is a real example).
    # Keep the strict path, but also accept a lower absolute score only when the
    # winner is separated from the rest of the roster by a large margin.
    confident = (
        (best_score >= 0.70 and margin >= 0.045)
        or (best_score >= 0.62 and margin >= 0.12)
    )
    if confident:
        dbg(f"Sports.ru roster match {full_name_en} -> {best_name} ({best_score:.3f}, margin {margin:.3f})")
        return best_name
    dbg(f"Sports.ru roster no confident match {full_name_en}: best={best_name} score={best_score:.3f} margin={margin:.3f}")
    return ""


def _sportsru_profile_name(url: str, expected_full_name_en: str) -> str:
    """Read and validate the Russian H1 from a Sports.ru hockey person/player page."""
    if not HAS_BS:
        return ""
    try:
        page = http_get_text(url, timeout=20)
    except Exception as exc:
        dbg(f"Sports.ru profile fetch failed {url}: {exc}")
        return ""

    soup = BS(page, "html.parser")
    heading = soup.find("h1") or soup.find("h2")
    if not heading:
        return ""
    name_ru = _clean_person_name(" ".join(heading.stripped_strings))
    if len(name_ru.split()) < 2 or not _contains_cyrillic(name_ru):
        return ""

    expected = _sportsru_latin_norm(expected_full_name_en)
    if expected:
        body = _sportsru_latin_norm(" ".join(soup.stripped_strings))
        if expected not in body:
            return ""
    return name_ru


def resolve_sportsru_player_name(full_name_en: str) -> str:
    """Resolve one fresh NHL player directly from Sports.ru, independent of roster caches."""
    full_name_en = _clean_person_name(full_name_en)
    slug = _sportsru_person_slug(full_name_en)
    if not SPORTSRU_ON_DEMAND_ENABLED or not HAS_BS or not slug:
        return ""

    direct_urls = (
        f"{SPORTSRU_HOST}/hockey/person/{slug}/",
        f"{SPORTSRU_HOST}/hockey/player/{slug}/",
    )
    tried = set()
    for url in direct_urls:
        tried.add(url)
        name_ru = _sportsru_profile_name(url, full_name_en)
        if name_ru:
            return name_ru

    try:
        search_html = http_get_text(SPORTSRU_SEARCH_URL + quote_plus(full_name_en), timeout=20)
        soup = BS(search_html, "html.parser")
        links = soup.select('a[href*="/hockey/person/"], a[href*="/hockey/player/"]')
        for link in links[:8]:
            href = str(link.get("href") or "").strip()
            if not href:
                continue
            url = urljoin(SPORTSRU_HOST, href)
            if url in tried:
                continue
            tried.add(url)
            name_ru = _sportsru_profile_name(url, full_name_en)
            if name_ru:
                return name_ru
    except Exception as exc:
        dbg(f"Sports.ru search failed for {full_name_en}: {exc}")
    return ""


def resolve_event_people_from_sportsru(
    events: List[ScoringEvent],
    names_by_id: Dict[int, str],
) -> List[ScoringEvent]:
    """Resolve fresh scorers/assists from Sports.ru immediately before rendering.

    Fast path: one current Sports.ru roster page per scoring team.
    Slow fallback: individual profile lookup only when roster matching misses.
    """
    if not SPORTSRU_ON_DEMAND_ENABLED:
        return events

    resolved_by_english: Dict[str, str] = {}
    team_rosters: Dict[str, List[str]] = {}

    def roster_for(team_tri: str) -> List[str]:
        tri = str(team_tri or "").upper()
        if tri not in team_rosters:
            team_rosters[tri] = fetch_sportsru_team_roster_names(tri)
        return team_rosters[tri]

    def resolve_one(pid: int, current: str, team_tri: str) -> str:
        current = _clean_person_name(current)
        if not current:
            return current
        if _contains_cyrillic(current) and not _contains_latin(current):
            return current

        if pid > 0:
            cached = _clean_person_name(names_by_id.get(pid, ""))
            if cached and _contains_cyrillic(cached) and not _contains_latin(cached):
                return cached

        key = _sportsru_latin_norm(current)
        if key in resolved_by_english:
            return resolved_by_english[key] or current

        full_ru = resolve_sportsru_name_from_team_roster(current, roster_for(team_tri))
        if not full_ru:
            full_ru = resolve_sportsru_player_name(current)

        short_ru = _sportsru_short_name(full_ru) if full_ru else ""
        resolved_by_english[key] = short_ru
        if short_ru:
            if pid > 0:
                names_by_id[pid] = short_ru
            print(f"[INFO] Sports.ru on-demand resolved {pid or '-'}: {current} -> {short_ru}")
            return short_ru

        print(f"[WARN] Sports.ru on-demand unresolved {pid or '-'}: {current}")
        return current

    for ev in events:
        ev.scorer = resolve_one(int(ev.scorer_id or 0), ev.scorer, ev.team_for)
        if ev.assists:
            translated: List[str] = []
            for idx, original in enumerate(ev.assists):
                pid = int(ev.assist_ids[idx]) if idx < len(ev.assist_ids) and ev.assist_ids[idx] else 0
                translated.append(resolve_one(pid, original, ev.team_for))
            ev.assists = _clean_assists(translated)
    return events


def assert_no_english_scoring_names(
    events: List[ScoringEvent],
    official_has_shootout: bool = False,
    sportsru_winner: Optional[SRUShootoutWinner] = None,
) -> None:
    """Never publish a result containing Latin scorer/assist names."""
    unresolved: List[str] = []
    seen = set()

    def add(name: str, pid: int = 0) -> None:
        clean = _clean_person_name(name)
        if not clean or not _contains_latin(clean) or not _is_valid_player_name(clean):
            return
        key = (clean, int(pid or 0))
        if key in seen:
            return
        seen.add(key)
        unresolved.append(f"{clean} (player_id={pid})" if pid else clean)

    for ev in events:
        if ev.period_type == "SHOOTOUT":
            continue
        add(ev.scorer, int(ev.scorer_id or 0))
        for idx, assist in enumerate(ev.assists):
            pid = int(ev.assist_ids[idx]) if idx < len(ev.assist_ids) and ev.assist_ids[idx] else 0
            add(assist, pid)

    if official_has_shootout:
        winner = get_winning_shootout_name(events, True, sportsru_winner)
        add(winner or "")

    if unresolved:
        raise RuntimeError(
            "Sports.ru Russian name resolution incomplete; refusing publication: "
            + ", ".join(unresolved)
        )


def apply_sportsru_names(events: List[ScoringEvent], names_by_id: Dict[int, str]) -> List[ScoringEvent]:
    """Use the shared Sports.ru cache for every NHL event that exposes player ids."""
    for ev in events:
        if ev.scorer_id and ev.scorer_id in names_by_id:
            ev.scorer = names_by_id[ev.scorer_id]
        if ev.assist_ids:
            translated: List[str] = []
            for idx, original in enumerate(ev.assists):
                pid = ev.assist_ids[idx] if idx < len(ev.assist_ids) else 0
                translated.append(names_by_id.get(pid, original))
            ev.assists = _clean_assists(translated)
    return events


def _is_valid_player_name(s: str) -> bool:
    s = _clean_person_name(s)
    if not s:
        return False
    if len(s) > 40:
        return False
    if "НХЛ." in s or "Серия буллитов" in s:
        return False
    if re.search(r"\d{1,2}\.\d{1,2}\.\d{4}", s):
        return False
    if re.search(r"\d", s):
        return False
    return True


def _is_final_state(state: str) -> bool:
    return _upper_str(state) in ("FINAL", "OFF")


def _is_not_started_state(state: str) -> bool:
    return _upper_str(state) in ("PRE", "FUT", "SCHEDULED")


def _is_liveish_state(state: str) -> bool:
    return _upper_str(state) in ("LIVE", "CRIT")


def _current_hockey_day_pt() -> str:
    now_pt = datetime.now(PT_TZ)
    hockey_day = now_pt.date() if now_pt.hour >= 6 else (now_pt.date() - timedelta(days=1))
    return hockey_day.isoformat()


def _target_base_date() -> date:
    if TARGET_DATE:
        try:
            return datetime.strptime(TARGET_DATE, "%Y-%m-%d").date()
        except Exception:
            print(f"[ERR] bad TARGET_DATE: {TARGET_DATE}, expected YYYY-MM-DD")
    return datetime.fromisoformat(_current_hockey_day_pt()).date()


def fetch_standings_map() -> Dict[str, TeamRecord]:
    url = f"{NHLE_BASE}/standings/now"
    data = http_get_json(url)
    teams: Dict[str, TeamRecord] = {}
    nodes: List[dict] = []

    if isinstance(data, dict):
        if isinstance(data.get("standings"), list):
            nodes = data["standings"]
        elif isinstance(data.get("records"), list):
            nodes = data["records"]
        elif isinstance(data.get("standings"), dict):
            nodes = data["standings"].get("overallRecords", []) or []
    elif isinstance(data, list):
        nodes = data

    for r in nodes:
        abbr = ""
        ta = r.get("teamAbbrev")
        if isinstance(ta, str):
            abbr = ta.upper()
        elif isinstance(ta, dict):
            abbr = _upper_str(ta.get("default") or ta.get("tricode"))
        if not abbr:
            abbr = _upper_str(r.get("teamAbbrevTricode") or r.get("teamTriCode") or r.get("team"))

        rec = r.get("record") or r.get("overallRecord") or r.get("overallRecords") or {}
        wins = _first_int(rec.get("wins"), r.get("wins"), rec.get("gamesPlayedWins"))
        losses = _first_int(rec.get("losses"), r.get("losses"), rec.get("gamesPlayedLosses"), rec.get("regulationLosses"), r.get("regulationLosses"))
        ot = _first_int(rec.get("ot"), r.get("ot"), rec.get("otLosses"), r.get("otLosses"), rec.get("overtimeLosses"), r.get("overtimeLosses"))
        pts = _first_int(r.get("points"), rec.get("points"), r.get("pts"), r.get("teamPoints"))
        if abbr:
            teams[abbr] = TeamRecord(wins, losses, ot, pts)
    return teams


def _iter_dates_around_today(num_back: int = 2, num_fwd: int = 2) -> List[str]:
    now = datetime.now(timezone.utc).date()
    return [(now + timedelta(days=off)).isoformat() for off in range(-num_back, num_fwd + 1)]


def _list_games_for_dates(dates: List[str]) -> List[dict]:
    raw: List[dict] = []
    for day in dates:
        js = http_get_json(SCHED_FMT.format(ymd=day))
        games = js.get("games")
        if games is None:
            weeks = js.get("gameWeek") or []
            games = []
            for w in weeks:
                games.extend(w.get("games") or [])
        raw.extend(games or [])
    return raw


def _game_to_meta(g: dict) -> Optional[GameMeta]:
    gid = _first_int(g.get("id"), g.get("gameId"), g.get("gamePk"))
    if gid == 0:
        return None

    state = _upper_str(g.get("gameState") or g.get("gameStatus"))
    gd = g.get("startTimeUTC") or g.get("gameDate") or ""
    try:
        gdt = datetime.fromisoformat(str(gd).replace("Z", "+00:00"))
    except Exception:
        gdt = datetime.now(timezone.utc)

    home = g.get("homeTeam", {}) or {}
    away = g.get("awayTeam", {}) or {}
    htri = _upper_str(home.get("abbrev") or home.get("triCode") or home.get("teamAbbrev"))
    atri = _upper_str(away.get("abbrev") or away.get("triCode") or away.get("teamAbbrev"))
    hscore = _first_int(home.get("score"))
    ascore = _first_int(away.get("score"))
    game_type = _first_int(g.get("gameType"))

    series_game: Optional[int] = None
    home_series_wins: Optional[int] = None
    away_series_wins: Optional[int] = None
    series = g.get("seriesStatus") or {}
    if isinstance(series, dict) and series:
        game_no = _first_int(series.get("gameNumberOfSeries"))
        series_game = game_no or None
        top = _upper_str(series.get("topSeedTeamAbbrev"))
        bottom = _upper_str(series.get("bottomSeedTeamAbbrev"))
        top_wins = _first_int(series.get("topSeedWins"))
        bottom_wins = _first_int(series.get("bottomSeedWins"))
        if htri == top:
            home_series_wins = top_wins
        elif htri == bottom:
            home_series_wins = bottom_wins
        if atri == top:
            away_series_wins = top_wins
        elif atri == bottom:
            away_series_wins = bottom_wins

    if (
        series_game
        and _is_final_state(state)
        and home_series_wins is not None
        and away_series_wins is not None
        and hscore != ascore
        and home_series_wins + away_series_wins == series_game - 1
    ):
        if hscore > ascore:
            home_series_wins += 1
        else:
            away_series_wins += 1

    return GameMeta(
        gid,
        gdt,
        state,
        htri,
        atri,
        hscore,
        ascore,
        game_type,
        series_game,
        home_series_wins,
        away_series_wins,
    )


def resolve_game_by_query(q: str) -> Optional[GameMeta]:
    q = q.strip()
    if not q:
        return None

    try:
        date_part, rest = q.split(" ", 1)
        y, m, d = map(int, date_part.split("-"))
    except Exception:
        print(f"[DBG] GAME_QUERY bad format: {q}")
        return None

    rest = rest.strip().upper().replace(" ", "")
    home = away = ""
    if "@" in rest:
        away, home = rest.split("@", 1)
    elif "-" in rest:
        left, right = rest.split("-", 1)
        home, away = left, right
    else:
        return None

    js_for_day = _list_games_for_dates([f"{y:04d}-{m:02d}-{d:02d}"])
    if d > 1:
        js_for_day += _list_games_for_dates([f"{y:04d}-{m:02d}-{d-1:02d}"])

    metas = [_game_to_meta(g) for g in js_for_day]
    metas = [m for m in metas if m]
    for m in metas:
        if m.home_tri == home and m.away_tri == away:
            dbg(f"Resolved GAME_PK={m.gamePk} for {q}")
            return m

    print(f"[DBG] Unable to resolve GAME_PK for {q}")
    return None


_ASSIST_KEYS = (
    "assist1PlayerName", "assist2PlayerName", "assist3PlayerName",
    "assist1", "assist2", "assist3",
    "primaryAssist", "secondaryAssist", "tertiaryAssist",
)
_SCORER_KEYS = (
    "scoringPlayerName", "scorerName", "shootingPlayerName", "scoringPlayer",
    "goalScorer", "primaryScorer", "playerName", "player",
    "shooterName", "shootoutShooterName", "shooter", "byPlayerName",
)


def _normalize_period_type(t: str) -> str:
    t = _upper_str(t)
    if t in ("", "REG"):
        return "REGULAR"
    if t == "OT":
        return "OVERTIME"
    if t == "SO":
        return "SHOOTOUT"
    return t


def _players_fallback_names(p: dict) -> Tuple[str, List[str]]:
    scorer = ""
    assists: List[str] = []
    try:
        for pl in p.get("players") or []:
            pt = (_upper_str(pl.get("playerType")) or _upper_str(pl.get("type"))).strip()
            nm = _extract_name(pl.get("player") or pl.get("playerName") or pl.get("name"))
            if pt in ("SCORER", "SHOOTOUTSCORER", "SHOOTER", "GOALSCORER"):
                if nm:
                    scorer = nm
            elif pt in ("ASSIST", "PRIMARYASSIST", "SECONDARYASSIST", "TERTIARYASSIST"):
                if nm:
                    assists.append(nm)
    except Exception:
        pass
    return scorer, assists


def _is_deciding_shootout_goal(details: dict) -> bool:
    for key in ("isGameWinningGoal", "isWinningGoal", "isGameDecidingGoal", "gameWinningGoal", "decidingGoal"):
        if _truthy(details.get(key)):
            return True
    return False


def _extract_shootout_scorer(play: dict, details: dict, roster_names: Dict[int, str]) -> str:
    for k in _SCORER_KEYS:
        nm = _extract_name(details.get(k))
        if nm:
            return _clean_person_name(nm)
    nm = _player_name_from_id(details, roster_names, "scoringPlayerId", "shootingPlayerId", "playerId")
    if nm:
        return _clean_person_name(nm)
    for k in ("scoringPlayerName", "scorerName", "shootingPlayerName"):
        v = play.get(k)
        if isinstance(v, str) and v.strip():
            return _clean_person_name(v)
    sfb, _ = _players_fallback_names(play)
    return _clean_person_name(sfb)


def fetch_scoring_official(gamePk: int, home_tri: str, away_tri: str) -> Tuple[List[ScoringEvent], bool]:
    data = http_get_json(PBP_FMT.format(gamePk=gamePk))
    plays = data.get("plays", []) or []
    roster_names = _roster_name_map(data)
    events: List[ScoringEvent] = []

    official_has_shootout = False
    prev_h = prev_a = 0
    prev_so_h = prev_so_a = 0

    for p in plays:
        pd = p.get("periodDescriptor", {}) or {}
        period = _first_int(pd.get("number") or p.get("period"))
        ptype = _normalize_period_type(pd.get("periodType") or "REG")
        type_key = _upper_str(p.get("typeDescKey"))
        det = p.get("details", {}) or {}
        t = str(p.get("timeInPeriod") or "00:00").replace(":", ".")

        if ptype == "SHOOTOUT":
            official_has_shootout = True

            scorer = _extract_shootout_scorer(p, det, roster_names)
            scorer_id = _first_int(det.get("scoringPlayerId"), det.get("shootingPlayerId"), det.get("playerId")) or None

            h = det.get("homeScore")
            a = det.get("awayScore")
            if not (isinstance(h, int) and isinstance(a, int)):
                sc = p.get("score", {}) or {}
                h = sc.get("home", prev_so_h)
                a = sc.get("away", prev_so_a)

            h = _first_int(h, prev_so_h)
            a = _first_int(a, prev_so_a)

            scored = False
            if h > prev_so_h or a > prev_so_a:
                scored = True
            for k in ("wasGoal", "shotWasGoal", "isGoal", "isScored", "scored"):
                if _truthy(det.get(k)):
                    scored = True

            team = home_tri if h > prev_so_h else (
                away_tri if a > prev_so_a else _upper_str(
                    det.get("eventOwnerTeamAbbrev") or p.get("teamAbbrev") or det.get("teamAbbrev") or det.get("scoringTeamAbbrev")
                )
            )

            if scorer or scored:
                events.append(
                    ScoringEvent(
                        period=period,
                        period_type="SHOOTOUT",
                        time=t,
                        team_for=team,
                        home_goals=h,
                        away_goals=a,
                        scorer=scorer,
                        assists=[],
                        scorer_id=scorer_id,
                        assist_ids=[],
                        is_shootout_winner=_is_deciding_shootout_goal(det),
                        is_shootout_scored=scored,
                    )
                )

            prev_so_h, prev_so_a = h, a
            continue

        if type_key != "GOAL":
            continue

        h = det.get("homeScore")
        a = det.get("awayScore")
        if not (isinstance(h, int) and isinstance(a, int)):
            sc = p.get("score", {}) or {}
            if isinstance(sc.get("home"), int) and isinstance(sc.get("away"), int):
                h, a = sc["home"], sc["away"]
            else:
                h, a = prev_h, prev_a

        team = home_tri if h > prev_h else (
            away_tri if a > prev_a else _upper_str(
                det.get("eventOwnerTeamAbbrev") or p.get("teamAbbrev") or det.get("teamAbbrev") or det.get("scoringTeamAbbrev")
            )
        )

        scorer = ""
        for k in _SCORER_KEYS:
            nm = _extract_name(det.get(k))
            if nm:
                scorer = nm
                break
        if not scorer:
            scorer = _player_name_from_id(det, roster_names, "scoringPlayerId", "shootingPlayerId", "playerId")
        if not scorer:
            for k in ("scoringPlayerName", "scorerName", "shootingPlayerName"):
                v = p.get(k)
                if isinstance(v, str) and v.strip():
                    scorer = v.strip()
                    break
        if not scorer:
            sfb, _ = _players_fallback_names(p)
            if sfb:
                scorer = sfb

        scorer_id = _first_int(det.get("scoringPlayerId"), det.get("shootingPlayerId"), det.get("playerId")) or None
        assist_ids = [
            pid for pid in (
                _first_int(det.get("assist1PlayerId")),
                _first_int(det.get("assist2PlayerId")),
                _first_int(det.get("assist3PlayerId")),
            ) if pid
        ]

        assists: List[str] = []
        for k in _ASSIST_KEYS:
            nm = _extract_name(det.get(k))
            if nm:
                assists.append(nm)
        for k in ("assist1PlayerId", "assist2PlayerId", "assist3PlayerId"):
            nm = _player_name_from_id(det, roster_names, k)
            if nm:
                assists.append(nm)
        if not assists:
            _, afb = _players_fallback_names(p)
            if afb:
                assists = afb

        events.append(
            ScoringEvent(
                period=period,
                period_type=ptype,
                time=t,
                team_for=team,
                home_goals=_first_int(h),
                away_goals=_first_int(a),
                scorer=_clean_person_name(scorer),
                assists=_clean_assists(assists),
                scorer_id=scorer_id,
                assist_ids=assist_ids,
            )
        )
        prev_h, prev_a = _first_int(h), _first_int(a)

    return events, official_has_shootout


TIME_RE = re.compile(r"\b(\d{1,2})[:.](\d{2})\b")


def _extract_time(text: str) -> Optional[str]:
    m = TIME_RE.search(text or "")
    return f"{int(m.group(1)):02d}.{m.group(2)}" if m else None


def parse_sportsru_goals_html(html: str, side: str) -> List[SRUGoal]:
    res: List[SRUGoal] = []
    if not HAS_BS:
        return res

    soup = BS(html, "html.parser")
    ul = soup.select_one(f"ul.match-summary__goals-list--{side}") or soup.select_one(
        f"ul.match-summary__goals-list.match-summary__goals-list--{side}"
    )
    if not ul:
        return res

    for li in ul.find_all("li", recursive=False):
        raw = li.get_text(" ", strip=True)
        if "Серия буллитов" in raw:
            continue
        anchors = [a.get_text(strip=True) for a in li.find_all("a")]
        scorer_ru = anchors[0] if anchors else None
        assists_ru = anchors[1:] if len(anchors) > 1 else []
        time_ru = _extract_time(raw)
        res.append(SRUGoal(time_ru, scorer_ru, assists_ru))
    return res


def parse_sportsru_shootout_winner_html(html: str) -> Optional[SRUShootoutWinner]:
    if not HAS_BS:
        return None

    soup = BS(html, "html.parser")
    containers = soup.select(
        "ul.match-summary__goals-list--home, "
        "ul.match-summary__goals-list--away, "
        "ul.match-summary__goals-list.match-summary__goals-list--home, "
        "ul.match-summary__goals-list.match-summary__goals-list--away"
    )

    for ul in containers:
        for li in ul.find_all("li", recursive=False):
            raw = li.get_text(" ", strip=True)
            if "Серия буллитов" not in raw:
                continue

            anchors = [a.get_text(strip=True) for a in li.find_all("a")]
            if not anchors:
                continue

            name = _clean_person_name(anchors[0])
            if _is_valid_player_name(name):
                return SRUShootoutWinner(scorer_ru=name)

    return None


def fetch_sportsru_goals(home_tri: str, away_tri: str) -> Tuple[List[SRUGoal], List[SRUGoal], Optional[SRUShootoutWinner], str]:
    h_list = SPORTSRU_SLUGS.get(home_tri, [])
    a_list = SPORTSRU_SLUGS.get(away_tri, [])
    tried: List[str] = []

    for hslug in h_list:
        for aslug in a_list:
            for left, right in ((hslug, aslug), (aslug, hslug)):
                url = f"https://www.sports.ru/hockey/match/{left}-vs-{right}/"
                tried.append(url)
                try:
                    html = http_get_text(url, timeout=20)
                except Exception as e:
                    dbg(f"sports.ru fetch fail {url}: {repr(e)}")
                    continue

                left_is_home = left in h_list
                home_side = "home" if left_is_home else "away"
                away_side = "away" if left_is_home else "home"

                h = parse_sportsru_goals_html(html, home_side)
                a = parse_sportsru_goals_html(html, away_side)
                so = parse_sportsru_shootout_winner_html(html)

                if h or a or so:
                    dbg(f"sports.ru ok for {url}: home={len(h)} away={len(a)} so={getattr(so, 'scorer_ru', None)}")
                    return h, a, so, url

    dbg("sports.ru tried URLs (no data):", " | ".join(tried))
    return [], [], None, ""


def merge_official_with_sportsru(
    evs: List[ScoringEvent],
    sru_home: List[SRUGoal],
    sru_away: List[SRUGoal],
    home_tri: str,
    away_tri: str,
) -> List[ScoringEvent]:
    h_i = a_i = 0
    out: List[ScoringEvent] = []

    for ev in evs:
        if ev.period_type == "SHOOTOUT":
            out.append(ev)
            continue

        if ev.team_for == home_tri and h_i < len(sru_home):
            g = sru_home[h_i]
            h_i += 1
            if g.scorer_ru:
                ev.scorer = _sportsru_short_name(g.scorer_ru) or _clean_person_name(g.scorer_ru)
            if g.assists_ru:
                ev.assists = _clean_assists([_sportsru_short_name(a) or a for a in g.assists_ru])
        elif ev.team_for == away_tri and a_i < len(sru_away):
            g = sru_away[a_i]
            a_i += 1
            if g.scorer_ru:
                ev.scorer = _sportsru_short_name(g.scorer_ru) or _clean_person_name(g.scorer_ru)
            if g.assists_ru:
                ev.assists = _clean_assists([_sportsru_short_name(a) or a for a in g.assists_ru])

        ev.assists = _clean_assists(ev.assists)
        out.append(ev)

    return out


def _italic(s: str) -> str:
    return f"<i>{s}</i>"


def period_title_text(num: int, ptype: str, ot_index: Optional[int], ot_total: int) -> str:
    t = (ptype or "").upper()
    if t == "REGULAR":
        return f"{num}-й период"
    if t == "OVERTIME":
        return "Овертайм" if ot_total <= 1 else f"Овертайм №{ot_index or 1}"
    if t == "SHOOTOUT":
        return "Буллиты"
    return f"Период {num}"


def compute_player_marks(events: List[ScoringEvent]) -> Dict[str, str]:
    goals: Dict[str, int] = {}
    assists: Dict[str, int] = {}

    for ev in events:
        if ev.period_type == "SHOOTOUT":
            continue

        scorer = _clean_person_name(ev.scorer)
        if scorer:
            goals[scorer] = goals.get(scorer, 0) + 1

        for a in _clean_assists(ev.assists):
            assists[a] = assists.get(a, 0) + 1

    marks: Dict[str, str] = {}
    for n in set(goals) | set(assists):
        suffix = ""
        if goals.get(n, 0) >= 2:
            suffix += " 🔥"
        if assists.get(n, 0) >= 3:
            suffix += " 🏒"
        if suffix:
            marks[n] = suffix
    return marks


def find_last_mentions(events: List[ScoringEvent], winning_so_name: Optional[str]) -> Dict[str, int]:
    last_idx: Dict[str, int] = {}
    idx = 0

    for ev in events:
        if ev.period_type == "SHOOTOUT":
            continue

        scorer = _clean_person_name(ev.scorer)
        if scorer:
            last_idx[scorer] = idx
        idx += 1

        for a in _clean_assists(ev.assists):
            last_idx[a] = idx
            idx += 1

    if winning_so_name:
        last_idx[_clean_person_name(winning_so_name)] = idx

    return last_idx


def _event_time_sort_value(ev: ScoringEvent) -> int:
    try:
        mm, ss = str(ev.time or "00.00").replace(":", ".").split(".", 1)
        return int(mm) * 60 + int(ss)
    except Exception:
        return 0


def find_winning_goal_event(meta: GameMeta, events: List[ScoringEvent]) -> Optional[ScoringEvent]:
    if meta.home_score == meta.away_score:
        return None

    winner = meta.home_tri if meta.home_score > meta.away_score else meta.away_tri
    candidates = [
        ev for ev in events
        if ev.period_type != "SHOOTOUT"
        and ev.team_for == winner
        and ev.home_goals == meta.home_score
        and ev.away_goals == meta.away_score
        and _is_valid_player_name(ev.scorer)
    ]
    if candidates:
        return sorted(candidates, key=lambda ev: (ev.period, _event_time_sort_value(ev)))[-1]

    fallback = [
        ev for ev in events
        if ev.period_type != "SHOOTOUT"
        and ev.team_for == winner
        and _is_valid_player_name(ev.scorer)
    ]
    if fallback:
        return sorted(fallback, key=lambda ev: (ev.period, _event_time_sort_value(ev)))[-1]
    return None


def overtime_winner_line(meta: GameMeta, events: List[ScoringEvent]) -> Optional[str]:
    ev = find_winning_goal_event(meta, events)
    if not ev or ev.period_type != "OVERTIME":
        return None

    ot_index = max(1, ev.period - 3)
    prep = "во" if ot_index == 2 else "в"
    scorer = _clean_person_name(ev.scorer)
    return f"<b>Победный гол {prep} {ot_index}-м ОТ — {scorer}</b>"


def decorate_name(name: str, marks: Dict[str, str], last_mentions: Dict[str, int], current_idx: int) -> str:
    clean = _clean_person_name(name)
    if not clean:
        return "—"
    if clean in marks and last_mentions.get(clean) == current_idx:
        return f"{clean}{marks[clean]}"
    return clean


def line_goal(ev: ScoringEvent, marks: Dict[str, str], last_mentions: Dict[str, int], idx_ref: List[int]) -> str:
    score = f"{ev.home_goals}:{ev.away_goals}"

    who = decorate_name(ev.scorer, marks, last_mentions, idx_ref[0])
    idx_ref[0] += 1

    assists_out: List[str] = []
    for a in _clean_assists(ev.assists):
        assists_out.append(decorate_name(a, marks, last_mentions, idx_ref[0]))
        idx_ref[0] += 1

    assists_text = ""
    if len(assists_out) == 1:
        assists_text = f" ({assists_out[0]})"
    elif len(assists_out) >= 2:
        assists_text = f" ({', '.join(assists_out)})"

    return f"{score} – {ev.time} {who}{assists_text}"


def get_winning_shootout_name(
    events: List[ScoringEvent],
    official_has_shootout: bool,
    sportsru_winner: Optional[SRUShootoutWinner],
) -> Optional[str]:
    if not official_has_shootout:
        return None

    if sportsru_winner and sportsru_winner.scorer_ru and _is_valid_player_name(sportsru_winner.scorer_ru):
        return _sportsru_short_name(sportsru_winner.scorer_ru) or _clean_person_name(sportsru_winner.scorer_ru)

    for ev in events:
        if ev.period_type == "SHOOTOUT" and ev.is_shootout_winner and _is_valid_player_name(ev.scorer):
            return _clean_person_name(ev.scorer)

    scored_attempts = [
        ev for ev in events
        if ev.period_type == "SHOOTOUT" and ev.is_shootout_scored and _is_valid_player_name(ev.scorer)
    ]
    if scored_attempts:
        return _clean_person_name(scored_attempts[-1].scorer)

    return None


def build_single_match_text(
    meta: GameMeta,
    standings: Dict[str, TeamRecord],
    events: List[ScoringEvent],
    official_has_shootout: bool,
    sportsru_winner: Optional[SRUShootoutWinner] = None,
) -> str:
    he = TEAM_EMOJI.get(meta.home_tri, "")
    ae = TEAM_EMOJI.get(meta.away_tri, "")
    hn = TEAM_RU.get(meta.home_tri, meta.home_tri)
    an = TEAM_RU.get(meta.away_tri, meta.away_tri)
    hrec = standings.get(meta.home_tri).as_str() if meta.home_tri in standings else "?"
    arec = standings.get(meta.away_tri).as_str() if meta.away_tri in standings else "?"
    hmark = str(meta.home_series_wins) if meta.home_series_wins is not None else hrec
    amark = str(meta.away_series_wins) if meta.away_series_wins is not None else arec

    winning_so_name = get_winning_shootout_name(events, official_has_shootout, sportsru_winner)

    head_lines = []
    if meta.series_game:
        head_lines.append(f"<i>Матч №{meta.series_game}</i>")
    head_lines.extend([
        f"{he} <b>«{hn}»: {meta.home_score}</b> ({hmark})",
        f"{ae} <b>«{an}»: {meta.away_score}</b> ({amark})",
    ])
    regular_and_ot = [ev for ev in events if ev.period_type != "SHOOTOUT"]

    marks = compute_player_marks(events)
    last_mentions = find_last_mentions(regular_and_ot, winning_so_name)
    winning_ot_line = overtime_winner_line(meta, regular_and_ot)
    if winning_ot_line:
        head_lines.append("")
        head_lines.append(winning_ot_line)

    head = "\n".join(head_lines)

    groups: Dict[Tuple[int, str], List[ScoringEvent]] = {}
    for ev in regular_and_ot:
        groups.setdefault((ev.period, ev.period_type), []).append(ev)

    for pnum in (1, 2, 3):
        if (pnum, "REGULAR") not in groups:
            groups[(pnum, "REGULAR")] = []

    max_ot_period = max(
        [k[0] for k in groups if (k[1] or "").upper() == "OVERTIME"],
        default=3,
    )
    for pnum in range(4, max_ot_period + 1):
        groups.setdefault((pnum, "OVERTIME"), [])

    ot_keys = sorted([k for k in groups if (k[1] or "").upper() == "OVERTIME"], key=lambda x: x[0])
    ot_total = len(ot_keys)
    ot_order = {k: i + 1 for i, k in enumerate(ot_keys)}

    lines = [head]
    sort_key = lambda x: (x[0], 0 if (x[1] or "").upper() == "REGULAR" else 1)
    idx_ref = [0]

    for key in sorted(groups.keys(), key=sort_key):
        pnum, ptype = key
        ot_idx = ot_order.get(key)
        title = period_title_text(pnum, ptype, ot_idx, ot_total)
        lines.append("")
        lines.append(_italic(title))
        per = groups[key]
        if not per:
            lines.append("Голов не было")
        else:
            for ev in per:
                lines.append(line_goal(ev, marks, last_mentions, idx_ref))

    if winning_so_name:
        lines.append("")
        lines.append("Победный буллит")
        lines.append(f"{meta.home_score}:{meta.away_score} – {winning_so_name}")

    return "\n".join(lines).strip()


def build_game_result_for_meta(
    meta: GameMeta,
    standings: Dict[str, TeamRecord],
    sportsru_names: Dict[int, str],
    progress_callback: Optional[Callable[[str], None]] = None,
) -> str:
    """One authoritative result renderer for autopost, menu and whole-day output."""
    if progress_callback:
        progress_callback("nhl_events")
    evs, official_has_shootout = fetch_scoring_official(meta.gamePk, meta.home_tri, meta.away_tri)
    # Sports.ru roster cache is the primary shared spelling source by NHL player id.
    evs = apply_sportsru_names(evs, sportsru_names)
    if progress_callback:
        progress_callback("sportsru_names")
    # Fresh preseason/camp players can appear in NHL play-by-play before they reach
    # the daily Sports.ru roster cache. Resolve those individual profiles now.
    evs = resolve_event_people_from_sportsru(evs, sportsru_names)
    if progress_callback:
        progress_callback("sportsru_match")
    # Match page remains an additional Sports.ru source when its goal summary is populated.
    sru_home, sru_away, sru_so_winner, _ = fetch_sportsru_goals(meta.home_tri, meta.away_tri)
    merged = merge_official_with_sportsru(evs, sru_home, sru_away, meta.home_tri, meta.away_tri)
    merged = apply_sportsru_names(merged, sportsru_names)
    # Hard publication guard: unresolved English scorer/assist names must fail
    # the run instead of leaking into Telegram.
    assert_no_english_scoring_names(merged, official_has_shootout, sru_so_winner)
    if progress_callback:
        progress_callback("render")
    return build_single_match_text(
        meta=meta,
        standings=standings,
        events=merged,
        official_has_shootout=official_has_shootout,
        sportsru_winner=sru_so_winner,
    )


def load_state(path: str) -> Dict[str, Any]:
    p = pathlib.Path(path)
    if not p.exists():
        p.parent.mkdir(parents=True, exist_ok=True)
        return {"posted": {}}
    try:
        return json.loads(p.read_text("utf-8") or "{}") or {"posted": {}}
    except Exception:
        return {"posted": {}}


def save_state(path: str, data: Dict[str, Any]) -> None:
    p = pathlib.Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, ensure_ascii=False, indent=2), "utf-8")


def _telegram_token() -> str:
    return _env_str("TELEGRAM_BOT_TOKEN", "").strip()


def _telegram_chat_value(value: Any) -> Any:
    s = str(value or "").strip()
    return int(s) if s.strip("-").isdigit() else s


def telegram_api_request(method: str, payload: Optional[Dict[str, Any]] = None, timeout: int = 30) -> Dict[str, Any]:
    token = _telegram_token()
    if not token:
        return {"ok": False, "error_code": 0, "description": "Telegram token not set"}
    url = f"{TG_API}/bot{token}/{method}"
    try:
        resp = requests.post(
            url,
            headers={"Content-Type": "application/json"},
            data=json.dumps(payload or {}, ensure_ascii=False),
            timeout=timeout,
        )
    except Exception as exc:
        return {"ok": False, "error_code": 0, "description": str(exc)}
    try:
        data = resp.json()
    except Exception:
        data = {"ok": False, "error_code": resp.status_code, "description": resp.text[:500]}
    if resp.status_code != 200 and data.get("error_code") is None:
        data["error_code"] = resp.status_code
    return data


def send_telegram_text(
    text: str,
    chat_id: Optional[Any] = None,
    reply_markup: Optional[Dict[str, Any]] = None,
    message_thread_id: Optional[int] = None,
    disable_notification: bool = False,
) -> bool:
    token = _telegram_token()
    default_chat = _env_str("TELEGRAM_CHAT_ID", DEFAULT_TELEGRAM_CHAT_ID).strip()
    workflow_target_chat = _env_str("TELEGRAM_TARGET_CHAT_ID", "").strip()
    target_chat = chat_id if chat_id is not None else (workflow_target_chat or default_chat)
    if not token or target_chat in (None, ""):
        print("[ERR] Telegram token/chat_id not set")
        return False

    payload: Dict[str, Any] = {
        "chat_id": _telegram_chat_value(target_chat),
        "text": text,
        "disable_web_page_preview": True,
        "disable_notification": bool(disable_notification),
        "parse_mode": "HTML",
    }
    if reply_markup:
        payload["reply_markup"] = reply_markup

    if message_thread_id is not None:
        payload["message_thread_id"] = int(message_thread_id)
    elif chat_id is None:
        if workflow_target_chat:
            thread = _env_str("TELEGRAM_TARGET_THREAD_ID", "").strip()
        else:
            thread = _env_str("TELEGRAM_THREAD_ID", "").strip()
        if thread:
            try:
                payload["message_thread_id"] = int(thread)
            except Exception:
                pass

    if DRY_RUN:
        print("[DRY RUN] " + textwrap.shorten(text, 240, placeholder="…"))
        return False

    data = telegram_api_request("sendMessage", payload)
    dbg("TG sendMessage:", data)
    if not data.get("ok", False):
        print(f"[ERR] sendMessage failed: {data.get('error_code')} {data.get('description')}")
        return False
    return True


def edit_telegram_text(
    chat_id: Any,
    message_id: int,
    text: str,
    reply_markup: Optional[Dict[str, Any]] = None,
) -> bool:
    payload: Dict[str, Any] = {
        "chat_id": _telegram_chat_value(chat_id),
        "message_id": int(message_id),
        "text": text,
        "disable_web_page_preview": True,
        "parse_mode": "HTML",
    }
    if reply_markup is not None:
        payload["reply_markup"] = reply_markup
    data = telegram_api_request("editMessageText", payload)
    dbg("TG editMessageText:", data)
    return bool(data.get("ok"))


def _interactive_status_message_id() -> int:
    try:
        return int(_env_str("TELEGRAM_STATUS_MESSAGE_ID", "").strip() or "0")
    except Exception:
        return 0


def _interactive_status_chat_id() -> str:
    return _env_str("TELEGRAM_TARGET_CHAT_ID", "").strip()


def update_interactive_status(text: str) -> bool:
    message_id = _interactive_status_message_id()
    chat_id = _interactive_status_chat_id()
    if not message_id or not chat_id or DRY_RUN:
        return False
    return edit_telegram_text(chat_id, message_id, text)


def interactive_elapsed_s() -> int:
    return max(0, int(round(time.monotonic() - INTERACTIVE_STARTED_AT)))


def answer_callback_query(callback_id: str, text: str = "") -> None:
    if not callback_id:
        return
    payload: Dict[str, Any] = {"callback_query_id": callback_id}
    if text:
        payload["text"] = text[:180]
    telegram_api_request("answerCallbackQuery", payload, timeout=15)


def set_bot_commands_if_needed(state: Dict[str, Any]) -> None:
    if not TELEGRAM_INTERACTIVE_ENABLED or state.get("bot_commands_version") == BOT_COMMANDS_VERSION:
        return
    commands = [
        {"command": "menu", "description": "Меню результатов и расписания НХЛ"},
        {"command": "today", "description": "Матчи сегодняшнего игрового дня"},
        {"command": "yesterday", "description": "Матчи предыдущего игрового дня"},
        {"command": "schedule", "description": "Расписание: /schedule 2026-09-21"},
        {"command": "results", "description": "Результаты дня: /results 2026-09-21"},
        {"command": "game", "description": "Матч по gamePk: /game 2026020001"},
    ]
    data = telegram_api_request("setMyCommands", {"commands": commands}, timeout=20)
    if data.get("ok"):
        state["bot_commands_version"] = BOT_COMMANDS_VERSION
    else:
        print(f"[WARN] setMyCommands failed: {data.get('error_code')} {data.get('description')}")



def get_meta_by_gamepk_scan_schedule(gamePk: int) -> Optional[GameMeta]:
    raw = _list_games_for_dates(_iter_dates_around_today(3, 3))
    for g in raw:
        gid = _first_int(g.get("id"), g.get("gameId"), g.get("gamePk"))
        if gid == gamePk:
            return _game_to_meta(g)
    return None

def autopost_current_hockey_day() -> List[GameMeta]:
    base_day = _target_base_date()

    dates = [
        (base_day - timedelta(days=2)).isoformat(),
        (base_day - timedelta(days=1)).isoformat(),
        base_day.isoformat(),
        (base_day + timedelta(days=1)).isoformat(),
        (base_day + timedelta(days=2)).isoformat(),
    ]

    print("TARGET_DATE:", TARGET_DATE or "(empty)")
    print("Autopost base date:", base_day.isoformat())
    print("Autopost schedule dates:", dates)

    raw = _list_games_for_dates(dates)
    metas = [_game_to_meta(g) for g in raw]
    metas = [m for m in metas if m]

    print("ALL games raw:", [(m.gamePk, m.away_tri, m.home_tri, m.state) for m in metas])

    finals = [m for m in metas if _is_final_state(m.state)]

    seen = set()
    uniq: List[GameMeta] = []
    for m in sorted(finals, key=lambda x: x.gameDateUTC):
        if m.gamePk not in seen:
            seen.add(m.gamePk)
            uniq.append(m)

    return uniq


def _meta_hockey_day_pt(meta: GameMeta) -> date:
    return meta.gameDateUTC.astimezone(PT_TZ).date()


def latest_final_hockey_day() -> List[GameMeta]:
    base_day = _target_base_date()
    dates = [(base_day - timedelta(days=off)).isoformat() for off in range(0, 8)]

    print("TARGET_DATE:", TARGET_DATE or "(empty)")
    print("Latest final hockey day base date:", base_day.isoformat())
    print("Latest final hockey day scan dates:", dates)

    raw = _list_games_for_dates(dates)
    metas = [_game_to_meta(g) for g in raw]
    metas = [m for m in metas if m and _is_final_state(m.state)]

    seen = set()
    uniq: List[GameMeta] = []
    for m in sorted(metas, key=lambda x: x.gameDateUTC):
        if m.gamePk not in seen:
            seen.add(m.gamePk)
            uniq.append(m)

    by_day: Dict[date, List[GameMeta]] = {}
    for m in uniq:
        day = _meta_hockey_day_pt(m)
        if day <= base_day:
            by_day.setdefault(day, []).append(m)

    if not by_day:
        print("Latest final hockey day: no final games found")
        return []

    latest_day = max(by_day.keys())
    result = sorted(by_day[latest_day], key=lambda x: x.gameDateUTC)
    print("Latest final hockey day:", latest_day.isoformat())
    print("Latest final games:", [m.gamePk for m in result])
    return result


RU_MONTHS = {
    1: "января", 2: "февраля", 3: "марта", 4: "апреля", 5: "мая", 6: "июня",
    7: "июля", 8: "августа", 9: "сентября", 10: "октября", 11: "ноября", 12: "декабря",
}


def _ru_day_label(day: date) -> str:
    return f"{day.day} {RU_MONTHS[day.month]}"


def _competition_title(metas: List[GameMeta]) -> str:
    types = [m.game_type for m in metas if m.game_type]
    if not types:
        return "НХЛ"
    game_type = max(set(types), key=types.count)
    return {
        1: "Предсезонка НХЛ",
        2: "Регулярный чемпионат НХЛ",
        3: "Плей-офф НХЛ",
    }.get(game_type, "НХЛ")


def _games_word(n: int) -> str:
    n = abs(int(n))
    if n % 10 == 1 and n % 100 != 11:
        return "матч"
    if n % 10 in (2, 3, 4) and n % 100 not in (12, 13, 14):
        return "матча"
    return "матчей"


def _parse_menu_date(raw: str, fallback: Optional[date] = None) -> Optional[date]:
    s = str(raw or "").strip()
    if not s:
        return fallback
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except Exception:
        return None


def _menu_today_pt() -> date:
    return datetime.now(PT_TZ).date()


def games_for_pt_day(day: date) -> List[GameMeta]:
    """All NHL games whose puck-drop belongs to the selected Los Angeles calendar day."""
    dates = [
        (day - timedelta(days=1)).isoformat(),
        day.isoformat(),
        (day + timedelta(days=1)).isoformat(),
    ]
    raw = _list_games_for_dates(dates)
    by_id: Dict[int, GameMeta] = {}
    for game in raw:
        meta = _game_to_meta(game)
        if not meta:
            continue
        if meta.gameDateUTC.astimezone(PT_TZ).date() != day:
            continue
        by_id[meta.gamePk] = meta
    return sorted(by_id.values(), key=lambda m: (m.gameDateUTC, m.gamePk))


def _game_status_bucket(meta: GameMeta) -> str:
    if _is_final_state(meta.state):
        return "final"
    if _is_liveish_state(meta.state) or _upper_str(meta.state) in ("INTERMISSION",):
        return "live"
    return "upcoming"


def build_schedule_menu(day: date) -> Tuple[str, Dict[str, Any], List[GameMeta]]:
    metas = games_for_pt_day(day)
    final_count = sum(1 for m in metas if _game_status_bucket(m) == "final")
    live_count = sum(1 for m in metas if _game_status_bucket(m) == "live")
    upcoming_count = len(metas) - final_count - live_count
    comp = _competition_title(metas)

    lines = [
        f"🗓 <b>{html.escape(comp)} • {_ru_day_label(day)} • {len(metas)} {_games_word(len(metas))}</b>",
        "",
        f"Лос-Анджелес (PT) · завершено <b>{final_count}</b> · в игре <b>{live_count}</b> · впереди <b>{upcoming_count}</b>",
    ]
    if not metas:
        lines.extend(["", "На этот игровой день матчей не найдено."])
    else:
        lines.append("")
        for idx, meta in enumerate(metas, 1):
            away_name = TEAM_RU.get(meta.away_tri, meta.away_tri)
            home_name = TEAM_RU.get(meta.home_tri, meta.home_tri)
            ae = TEAM_EMOJI.get(meta.away_tri, "")
            he = TEAM_EMOJI.get(meta.home_tri, "")
            bucket = _game_status_bucket(meta)
            if bucket == "final":
                tail = f"<b>{meta.away_score}:{meta.home_score}</b> ✅"
            elif bucket == "live":
                tail = f"<b>{meta.away_score}:{meta.home_score}</b> 🔴 LIVE"
            else:
                tail = meta.gameDateUTC.astimezone(PT_TZ).strftime("%H:%M")
            lines.append(
                f"{idx}. {ae} «{html.escape(away_name)}» — {he} «{html.escape(home_name)}» · {tail}"
            )

    keyboard: List[List[Dict[str, str]]] = []
    for meta in metas:
        bucket = _game_status_bucket(meta)
        if bucket == "final":
            label = f"✅ {meta.away_tri} {meta.away_score}:{meta.home_score} {meta.home_tri}"
        elif bucket == "live":
            label = f"🔴 {meta.away_tri} {meta.away_score}:{meta.home_score} {meta.home_tri}"
        else:
            local_time = meta.gameDateUTC.astimezone(PT_TZ).strftime("%H:%M")
            label = f"🕒 {local_time} · {meta.away_tri} — {meta.home_tri}"
        keyboard.append([{
            "text": label[:64],
            "callback_data": f"g:{meta.gamePk}:{day.isoformat()}",
        }])

    if final_count:
        label = "📋 Все результаты дня" if final_count == len(metas) else f"📋 Завершённые матчи · {final_count}/{len(metas)}"
        keyboard.append([{"text": label, "callback_data": f"f:{day.isoformat()}"}])

    keyboard.append([
        {"text": "← День", "callback_data": f"d:{(day - timedelta(days=1)).isoformat()}"},
        {"text": "🏠 Меню", "callback_data": "m"},
        {"text": "День →", "callback_data": f"d:{(day + timedelta(days=1)).isoformat()}"},
    ])
    return "\n".join(lines), {"inline_keyboard": keyboard}, metas


def build_main_menu() -> Tuple[str, Dict[str, Any]]:
    today = _menu_today_pt()
    text = (
        "🏒 <b>HOH · Результаты НХЛ</b>\n\n"
        "Расписание и результаты сгруппированы по календарному дню Лос-Анджелеса (PT).\n"
        "Выбери день, затем конкретный матч или весь завершённый игровой день.\n\n"
        "Для произвольной даты: <code>/schedule YYYY-MM-DD</code>"
    )
    keyboard = {
        "inline_keyboard": [
            [
                {"text": "🗓 Сегодня", "callback_data": f"d:{today.isoformat()}"},
                {"text": "↩️ Вчера", "callback_data": f"d:{(today - timedelta(days=1)).isoformat()}"},
            ],
            [
                {"text": "2 дня назад", "callback_data": f"d:{(today - timedelta(days=2)).isoformat()}"},
                {"text": "Завтра", "callback_data": f"d:{(today + timedelta(days=1)).isoformat()}"},
            ],
        ]
    }
    return text, keyboard


def _find_game_for_menu(game_pk: int, day: Optional[date] = None) -> Optional[GameMeta]:
    if day is not None:
        for meta in games_for_pt_day(day):
            if meta.gamePk == game_pk:
                return meta
    return get_meta_by_gamepk_scan_schedule(game_pk)


def _subscription_footer() -> str:
    url = html.escape(HOH_CHANNEL_URL, quote=True)
    return f'🏒 <a href="{url}"><b>ПОДПИШИСЬ НА HOME OF HOCKEY: СМОТРИ ВСЕ МАТЧИ НХЛ</b></a>'


def build_full_day_messages(
    day: date,
    standings: Dict[str, TeamRecord],
    sportsru_names: Dict[int, str],
    max_chars: int = 3800,
    progress_callback: Optional[Callable[[int, int, GameMeta, Optional[Exception]], None]] = None,
) -> List[str]:
    metas = games_for_pt_day(day)
    finals = [m for m in metas if _is_final_state(m.state)]
    if not finals:
        return [
            f"🗓 <b>{html.escape(_competition_title(metas))} • {_ru_day_label(day)}</b>\n\n"
            "Завершённых матчей пока нет."
        ]

    total = len(metas)
    comp = _competition_title(metas)
    header = f"🗓 <b>{html.escape(comp)} • {_ru_day_label(day)} • {total} {_games_word(total)}</b>\n\n"
    if len(finals) == total:
        header += "Результаты надёжно спрятаны 👇"
    else:
        header += f"Завершено {len(finals)} из {total}. Результаты надёжно спрятаны 👇"

    blocks_by_index: Dict[int, str] = {}
    workers = min(4, max(1, len(finals)))

    def render_one(meta: GameMeta) -> str:
        # Each parallel renderer gets its own mutable cache copy.
        return build_game_result_for_meta(meta, standings, dict(sportsru_names))

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(render_one, meta): (idx, meta) for idx, meta in enumerate(finals)}
        completed = 0
        for future in as_completed(futures):
            idx, meta = futures[future]
            error: Optional[Exception] = None
            try:
                blocks_by_index[idx] = future.result()
            except Exception as exc:
                error = exc
                print(f"[ERR] whole-day game render failed {meta.gamePk}: {exc}")
                hn = TEAM_RU.get(meta.home_tri, meta.home_tri)
                an = TEAM_RU.get(meta.away_tri, meta.away_tri)
                blocks_by_index[idx] = (
                    f"{TEAM_EMOJI.get(meta.home_tri,'')} <b>«{html.escape(hn)}»: {meta.home_score}</b>\n"
                    f"{TEAM_EMOJI.get(meta.away_tri,'')} <b>«{html.escape(an)}»: {meta.away_score}</b>\n"
                    "⚠️ <i>Подробности этого матча не собраны — проверяю данные игроков.</i>"
                )
            completed += 1
            if progress_callback:
                progress_callback(completed, len(finals), meta, error)

    blocks = [blocks_by_index[i] for i in range(len(finals))]

    sep = "——————————————————"
    footer = _subscription_footer()
    messages: List[str] = []
    current = header
    continuation = f"🗓 <b>{html.escape(comp)} • {_ru_day_label(day)} • продолжение</b>"

    for block in blocks:
        piece = f"\n{sep}\n{block}"
        reserve = len(footer) + 4
        if len(current) + len(piece) + reserve > max_chars and current != header:
            messages.append(current)
            current = continuation + piece
        elif len(current) + len(piece) + reserve > max_chars and current == header:
            # A single game should normally fit. Keep valid HTML in its own message if it is unusually long.
            messages.append(current)
            current = continuation + piece
        else:
            current += piece

    footer_piece = f"\n\n{footer}"
    if len(current) + len(footer_piece) > max_chars:
        messages.append(current)
        current = footer
    else:
        current += footer_piece
    messages.append(current)
    return messages


def send_schedule_message(
    chat_id: Any,
    day: date,
    message_thread_id: Optional[int] = None,
    edit_message_id: Optional[int] = None,
) -> bool:
    text, markup, _ = build_schedule_menu(day)
    if edit_message_id is not None and edit_telegram_text(chat_id, edit_message_id, text, markup):
        return True
    return send_telegram_text(
        text,
        chat_id=chat_id,
        reply_markup=markup,
        message_thread_id=message_thread_id,
    )


def send_game_from_menu(
    chat_id: Any,
    game_pk: int,
    day: Optional[date],
    standings: Dict[str, TeamRecord],
    sportsru_names: Dict[int, str],
    message_thread_id: Optional[int] = None,
) -> bool:
    meta = _find_game_for_menu(game_pk, day)
    if not meta:
        return send_telegram_text(
            "Матч не найден в доступном окне расписания.",
            chat_id=chat_id,
            message_thread_id=message_thread_id,
        )
    if not _is_final_state(meta.state):
        text = pending_game_text(meta)
    else:
        text = build_game_result_for_meta(meta, standings, sportsru_names)
    back_day = day or meta.gameDateUTC.astimezone(PT_TZ).date()
    markup = {"inline_keyboard": [[
        {"text": "← К расписанию", "callback_data": f"d:{back_day.isoformat()}"},
        {"text": "🏠 Меню", "callback_data": "m"},
    ]]}
    return send_telegram_text(
        text,
        chat_id=chat_id,
        reply_markup=markup,
        message_thread_id=message_thread_id,
    )


def send_full_day_from_menu(
    chat_id: Any,
    day: date,
    standings: Dict[str, TeamRecord],
    sportsru_names: Dict[int, str],
    message_thread_id: Optional[int] = None,
) -> bool:
    messages = build_full_day_messages(day, standings, sportsru_names)
    ok = True
    for idx, text in enumerate(messages):
        markup = None
        if idx == len(messages) - 1:
            markup = {"inline_keyboard": [[
                {"text": "← К расписанию", "callback_data": f"d:{day.isoformat()}"},
                {"text": "🏠 Меню", "callback_data": "m"},
            ]]}
        if not send_telegram_text(
            text,
            chat_id=chat_id,
            reply_markup=markup,
            message_thread_id=message_thread_id,
        ):
            ok = False
    return ok


def _handle_menu_command(
    message: Dict[str, Any],
    standings: Dict[str, TeamRecord],
    sportsru_names: Dict[int, str],
) -> None:
    text = str(message.get("text") or "").strip()
    if not text.startswith("/"):
        return
    chat = message.get("chat") or {}
    chat_id = chat.get("id")
    if chat_id is None:
        return
    thread_id = message.get("message_thread_id")
    command_token, *rest = text.split(maxsplit=1)
    command = command_token.split("@", 1)[0].lower()
    arg = rest[0].strip() if rest else ""
    today = _menu_today_pt()

    if command in ("/start", "/menu"):
        menu_text, markup = build_main_menu()
        send_telegram_text(menu_text, chat_id=chat_id, reply_markup=markup, message_thread_id=thread_id)
        return
    if command == "/today":
        send_schedule_message(chat_id, today, thread_id)
        return
    if command == "/yesterday":
        send_schedule_message(chat_id, today - timedelta(days=1), thread_id)
        return
    if command in ("/schedule", "/day"):
        day = _parse_menu_date(arg, today)
        if day is None:
            send_telegram_text(
                "Формат даты: <code>/schedule YYYY-MM-DD</code>",
                chat_id=chat_id,
                message_thread_id=thread_id,
            )
        else:
            send_schedule_message(chat_id, day, thread_id)
        return
    if command == "/results":
        day = _parse_menu_date(arg, today - timedelta(days=1))
        if day is None:
            send_telegram_text(
                "Формат даты: <code>/results YYYY-MM-DD</code>",
                chat_id=chat_id,
                message_thread_id=thread_id,
            )
        else:
            send_full_day_from_menu(chat_id, day, standings, sportsru_names, thread_id)
        return
    if command == "/game":
        try:
            game_pk = int(arg)
        except Exception:
            game_pk = 0
        if game_pk <= 0:
            send_telegram_text(
                "Формат: <code>/game GAME_PK</code>",
                chat_id=chat_id,
                message_thread_id=thread_id,
            )
        else:
            send_game_from_menu(chat_id, game_pk, None, standings, sportsru_names, thread_id)


def _handle_callback(
    callback: Dict[str, Any],
    standings: Dict[str, TeamRecord],
    sportsru_names: Dict[int, str],
) -> None:
    callback_id = str(callback.get("id") or "")
    data = str(callback.get("data") or "")
    message = callback.get("message") or {}
    chat = message.get("chat") or {}
    chat_id = chat.get("id")
    message_id = message.get("message_id")
    thread_id = message.get("message_thread_id")
    if chat_id is None:
        answer_callback_query(callback_id)
        return

    if data == "m":
        answer_callback_query(callback_id)
        text, markup = build_main_menu()
        if message_id and edit_telegram_text(chat_id, int(message_id), text, markup):
            return
        send_telegram_text(text, chat_id=chat_id, reply_markup=markup, message_thread_id=thread_id)
        return

    if data.startswith("d:"):
        day = _parse_menu_date(data[2:])
        if day is None:
            answer_callback_query(callback_id, "Некорректная дата")
            return
        answer_callback_query(callback_id, "Загружаю расписание")
        send_schedule_message(chat_id, day, thread_id, int(message_id) if message_id else None)
        return

    if data.startswith("g:"):
        parts = data.split(":")
        try:
            game_pk = int(parts[1])
        except Exception:
            game_pk = 0
        day = _parse_menu_date(parts[2]) if len(parts) >= 3 else None
        if game_pk <= 0:
            answer_callback_query(callback_id, "Матч не найден")
            return
        answer_callback_query(callback_id, "Загружаю матч")
        send_game_from_menu(chat_id, game_pk, day, standings, sportsru_names, thread_id)
        return

    if data.startswith("f:"):
        day = _parse_menu_date(data[2:])
        if day is None:
            answer_callback_query(callback_id, "Некорректная дата")
            return
        answer_callback_query(callback_id, "Собираю результаты дня")
        send_full_day_from_menu(chat_id, day, standings, sportsru_names, thread_id)
        return

    answer_callback_query(callback_id)


def process_telegram_updates(
    state: Dict[str, Any],
    standings: Dict[str, TeamRecord],
    sportsru_names: Dict[int, str],
) -> None:
    """Poll menu commands without affecting result autoposting.

    If this token ever gets a webhook, Telegram returns 409; autoposting remains
    operational and we only log that the interactive transport needs to move to
    the webhook.
    """
    if not TELEGRAM_INTERACTIVE_ENABLED or not _telegram_token():
        return

    set_bot_commands_if_needed(state)
    offset = _first_int(state.get("telegram_update_offset"))
    payload: Dict[str, Any] = {
        "limit": 50,
        "timeout": 0,
        "allowed_updates": ["message", "callback_query"],
    }
    if offset > 0:
        payload["offset"] = offset
    data = telegram_api_request("getUpdates", payload, timeout=20)
    if not data.get("ok"):
        code = data.get("error_code")
        desc = str(data.get("description") or "")
        if code == 409:
            print("[WARN] Telegram menu polling skipped: this bot token has an active webhook")
        else:
            print(f"[WARN] getUpdates failed: {code} {desc}")
        return

    updates = data.get("result") or []
    for update in updates:
        update_id = _first_int(update.get("update_id"))
        try:
            if isinstance(update.get("callback_query"), dict):
                _handle_callback(update["callback_query"], standings, sportsru_names)
            elif isinstance(update.get("message"), dict):
                _handle_menu_command(update["message"], standings, sportsru_names)
        except Exception as exc:
            print(f"[ERR] Telegram interactive update {update_id} failed: {exc}")
        finally:
            if update_id >= 0:
                state["telegram_update_offset"] = max(
                    _first_int(state.get("telegram_update_offset")),
                    update_id + 1,
                )


def pending_game_text(meta: GameMeta) -> str:
    matchup = f"{meta.away_tri} - {meta.home_tri}"
    if _is_not_started_state(meta.state):
        return f"{matchup} ещё не началась"
    if _is_liveish_state(meta.state):
        return f"{matchup} ещё не завершилась"
    return f"{matchup} статус: {meta.state}"

def main() -> None:
    game_pk = _env_str("GAME_PK", "").strip()
    game_query = _env_str("GAME_QUERY", "").strip()
    resend_last_day = _env_bool("RESEND_LAST_DAY", False)
    full_day_mode = _env_bool("FULL_DAY_MENU", False)

    if game_pk or game_query:
        update_interactive_status(
            "🟡 <b>Карточка матча</b>\n\n"
            "1/5 · ✅ Запрос получен\n"
            "2/5 · ⏳ Ищу матч в NHL…"
        )
    elif full_day_mode:
        update_interactive_status(
            f"🟡 <b>Все результаты дня • {html.escape(TARGET_DATE or '')}</b>\n\n"
            "✅ Запрос получен\n"
            "⏳ Загружаю список матчей…"
        )

    standings = fetch_standings_map()
    sportsru_names = load_sportsru_names()
    state = load_state(STATE_PATH)

    if full_day_mode:
        day = _parse_menu_date(TARGET_DATE, _menu_today_pt())
        if day is None:
            update_interactive_status("❌ <b>Все результаты дня</b>\n\nНекорректная дата.")
            print(f"[ERR] invalid FULL_DAY_MENU date: {TARGET_DATE}")
            return

        full_failures: List[Tuple[int, str]] = []

        def full_progress(done: int, total: int, meta: GameMeta, error: Optional[Exception]) -> None:
            away = TEAM_RU.get(meta.away_tri, meta.away_tri)
            home = TEAM_RU.get(meta.home_tri, meta.home_tri)
            if error:
                full_failures.append((meta.gamePk, str(error)))
            icon = "⚠️" if error else "✅"
            remaining = max(0, total - done)
            update_interactive_status(
                f"🟡 <b>Все результаты дня • {_ru_day_label(day)}</b>\n\n"
                f"{done}/{total} матчей обработано\n"
                f"{icon} {html.escape(away)} — {html.escape(home)}\n"
                + (f"⏳ Осталось: {remaining}" if remaining else "⏳ Формирую сообщение…")
            )

        messages = build_full_day_messages(
            day,
            standings,
            sportsru_names,
            progress_callback=full_progress,
        )

        if full_failures:
            update_interactive_status(
                f"❌ <b>День не отправлен полностью</b>\n\n"
                f"Собрано: {len([1 for _ in games_for_pt_day(day) if _is_final_state(_.state)]) - len(full_failures)}\n"
                f"С ошибкой: {len(full_failures)}\n"
                "Неполный день не публикую."
            )
            raise RuntimeError(
                "FULL_DAY_MENU incomplete: "
                + ", ".join(str(game_pk) for game_pk, _ in full_failures)
            )

        sent = 0
        for message in messages:
            if send_telegram_text(message):
                sent += 1
        if sent == len(messages):
            update_interactive_status(
                f"✅ <b>Все результаты дня готовы</b>\n\n"
                f"Отправлено сообщений: {sent}\n"
                f"Время сборки: {interactive_elapsed_s()} сек."
            )
        else:
            update_interactive_status(
                f"⚠️ <b>Результаты собраны, но Telegram принял не всё</b>\n\n"
                f"Отправлено: {sent}/{len(messages)} сообщений."
            )
        print(f"FULL_DAY_MENU OK ({sent}/{len(messages)} messages)")
        return

    # Polling remains available for installations without a webhook. The
    # production HOH result bot uses the Cloudflare webhook for its menu.
    process_telegram_updates(state, standings, sportsru_names)
    save_state(STATE_PATH, state)

    posted: Dict[str, bool] = state.get("posted", {}) or {}
    force_repost: Dict[str, bool] = state.get("force_repost", {}) or {}

    dbg("already posted:", sorted(posted.keys())[:20], "total=", len(posted))
    dbg("force repost:", sorted(force_repost.keys()))

    metas: List[GameMeta] = []
    manual_mode = False

    if game_pk:
        gid = int(game_pk)
        meta = get_meta_by_gamepk_scan_schedule(gid)
        if not meta:
            update_interactive_status(
                "❌ <b>Карточка матча</b>\n\nМатч не найден в расписании NHL."
            )
            print(f"[ERR] GAME_PK not found in schedule window: {gid}")
            return
        metas = [meta]
        manual_mode = True
        away = TEAM_RU.get(meta.away_tri, meta.away_tri)
        home = TEAM_RU.get(meta.home_tri, meta.home_tri)
        update_interactive_status(
            "🟡 <b>Карточка матча</b>\n\n"
            "1/5 · ✅ Запрос получен\n"
            f"2/5 · ✅ Матч найден: {html.escape(away)} — {html.escape(home)}\n"
            "3/5 · ⏳ Загружаю события NHL…"
        )
    elif game_query:
        meta = resolve_game_by_query(game_query)
        if not meta:
            print(f"[ERR] GAME_QUERY not resolved: {game_query}")
            return
        metas = [meta]
        manual_mode = True
    else:
        if resend_last_day:
            print("RESEND_LAST_DAY enabled: reposting the latest final hockey day")
            metas = latest_final_hockey_day()
        else:
            metas = autopost_current_hockey_day()
        print("FINAL games:", [m.gamePk for m in metas])
        print("FINAL games raw:", [(m.gamePk, m.away_tri, m.home_tri, m.state) for m in metas])
        if not resend_last_day:
            metas = [
                m for m in metas
                if force_repost.get(str(m.gamePk)) or not posted.get(str(m.gamePk))
            ]
        print("Need to post:", [m.gamePk for m in metas])

    new_posts = 0
    failed_posts = 0

    for meta in metas:
        if manual_mode and not _is_final_state(meta.state):
            text = pending_game_text(meta)
            dbg("Pending preview:\n" + text)
            if send_telegram_text(text):
                new_posts += 1
            else:
                failed_posts += 1
            continue

        def game_progress(stage: str) -> None:
            away = TEAM_RU.get(meta.away_tri, meta.away_tri)
            home = TEAM_RU.get(meta.home_tri, meta.home_tri)
            if stage == "nhl_events":
                tail = "3/5 · ⏳ Загружаю события NHL…"
            elif stage == "sportsru_names":
                tail = "3/5 · ✅ События NHL получены\n4/5 · ⏳ Проверяю русские имена Sports.ru…"
            elif stage == "sportsru_match":
                tail = "4/5 · ⏳ Сверяю имена и страницу матча Sports.ru…"
            else:
                tail = "4/5 · ✅ Данные проверены\n5/5 · ⏳ Собираю и отправляю карточку…"
            update_interactive_status(
                "🟡 <b>Карточка матча</b>\n\n"
                f"✅ {html.escape(away)} — {html.escape(home)}\n"
                f"{tail}"
            )

        try:
            text = build_game_result_for_meta(
                meta,
                standings,
                sportsru_names,
                progress_callback=game_progress if manual_mode else None,
            )
        except Exception as exc:
            if manual_mode:
                update_interactive_status(
                    "❌ <b>Карточка матча не собрана</b>\n\n"
                    "NHL-данные получены, но проверка русских имён не завершилась.\n"
                    "Запуск остановлен, чтобы не отправлять английские фамилии."
                )
                raise

            # One unresolved fresh player must not block every other completed
            # game in the five-minute autopost cycle. Keep the publication guard
            # for this game, record the failure, and continue with the rest.
            failed_posts += 1
            print(f"[ERR] skipping autopost game {meta.gamePk}: {exc}")
            continue
        dbg("Single match preview:\n" + text[:900].replace("\n", "¶") + "…")
        sent_ok = send_telegram_text(text)
        if not sent_ok:
            failed_posts += 1
            if manual_mode:
                update_interactive_status(
                    "❌ <b>Карточка собрана, но Telegram не принял сообщение</b>"
                )
            print(f"[ERR] not marking posted because Telegram send failed: {meta.gamePk}")
            continue

        if manual_mode:
            update_interactive_status(
                "✅ <b>Карточка матча готова</b>\n\n"
                f"Отправлено в чат.\nВремя сборки: {interactive_elapsed_s()} сек."
            )

        force_repost.pop(str(meta.gamePk), None)
        if not manual_mode and not resend_last_day:
            posted[str(meta.gamePk)] = True
            new_posts += 1
            dbg(f"mark posted {meta.gamePk}")
        else:
            new_posts += 1

    state["posted"] = posted
    state["force_repost"] = force_repost
    save_state(STATE_PATH, state)
    print(f"OK (posted {new_posts}, failed {failed_posts})")


if __name__ == "__main__":
    main()
