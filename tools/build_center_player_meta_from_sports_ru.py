#!/usr/bin/env python3
"""Build Russian NHL player names for HOH NHL Center from Sports.ru roster pages.

Output is compatible with POST /api/telegram-center-admin/player-meta/import.
The matcher is conservative: current NHL roster player is linked only when the
Sports.ru row has a unique jersey-number + broad-position match.

No database write is performed by this script.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests
from bs4 import BeautifulSoup

NHL = "https://api-web.nhle.com/v1"
SPORTS = "https://www.sports.ru"
UA = "Mozilla/5.0 (compatible; HOH-NHL-Center/1.0; +https://github.com/RNGN-Home-of-Hockey/HOH_NHL_Daily_Results)"

SPORTS_SLUGS = {
    "ANA": "hockey/club/anaheim-ducks",
    "BOS": "hockey/club/boston-bruins",
    "BUF": "hockey/club/buffalo-sabres",
    "CGY": "hockey/club/calgary-flames",
    "CAR": "hockey/club/carolina-hurricanes",
    "CHI": "hockey/club/chicago-blackhawks",
    "COL": "hockey/club/colorado-avalanche",
    "CBJ": "hockey/club/columbus-blue-jackets",
    "DAL": "hockey/club/dallas-stars",
    "DET": "hockey/club/detroit-red-wings",
    "EDM": "hockey/club/edmonton-oilers",
    "FLA": "hockey/club/florida-panthers",
    "LAK": "hockey/club/los-angeles-kings",
    "MIN": "hockey/club/minnesota-wild",
    "MTL": "hockey/club/montreal-canadiens",
    "NSH": "hockey/club/nashville-predators",
    "NJD": "hockey/club/new-jersey-devils",
    "NYI": "hockey/club/new-york-islanders",
    "NYR": "hockey/club/new-york-rangers",
    "OTT": "hockey/club/ottawa-senators",
    "PHI": "hockey/club/philadelphia-flyers",
    "PIT": "hockey/club/pittsburgh-penguins",
    "SJS": "hockey/club/san-jose-sharks",
    "SEA": "hockey/club/seattle-kraken",
    "STL": "hockey/club/st-louis-blues",
    "TBL": "hockey/club/tampa-bay-lightning",
    "TOR": "hockey/club/toronto-maple-leafs",
    "UTA": "utah-mammoth",
    "VAN": "hockey/club/vancouver-canucks",
    "VGK": "hockey/club/vegas",
    "WSH": "hockey/club/washington-capitals",
    "WPG": "hockey/club/winnipeg-jets",
}

POS_RU = {"вратарь": "G", "защитник": "D", "нападающий": "F"}


@dataclass
class SportsPlayer:
    number: int | None
    name_ru: str
    broad_position: str | None
    url: str | None


def localized(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return str(value.get("default") or value.get("en") or next(iter(value.values()), ""))
    return ""


def nhl_broad_position(section: str, raw: dict[str, Any]) -> str:
    if section == "goalies":
        return "G"
    if section == "defensemen":
        return "D"
    return "F"


def get_json(session: requests.Session, url: str) -> dict[str, Any]:
    r = session.get(url, timeout=25)
    r.raise_for_status()
    return r.json()


def sports_team_url(tri: str) -> str:
    return f"{SPORTS}/{SPORTS_SLUGS[tri]}/team/"


def parse_sports_roster(html: str) -> list[SportsPlayer]:
    soup = BeautifulSoup(html, "html.parser")
    out: list[SportsPlayer] = []
    seen: set[tuple[int | None, str, str | None]] = set()

    # Sports.ru currently renders roster rows as table-like text. Prefer DOM rows,
    # but keep a text fallback because markup changes more often than content.
    for row in soup.find_all(["tr", "li", "div"]):
        text = " ".join(row.stripped_strings)
        if not text or not any(word in text.lower() for word in POS_RU):
            continue
        link = row.find("a", href=re.compile(r"/hockey/(?:person|player)/|/hockey/[^/]+/"))
        if not link:
            continue
        name = " ".join(link.stripped_strings).strip()
        if len(name.split()) < 2 or not re.search(r"[А-Яа-яЁё]", name):
            continue
        pos = next((code for ru, code in POS_RU.items() if ru in text.lower()), None)
        before = text[: max(0, text.find(name))]
        nums = re.findall(r"(?<!\d)(\d{1,2})(?!\d)", before)
        number = int(nums[-1]) if nums else None
        href = link.get("href")
        url = requests.compat.urljoin(SPORTS, href) if href else None
        key = (number, name, pos)
        if key in seen:
            continue
        seen.add(key)
        out.append(SportsPlayer(number, name, pos, url))

    if out:
        return out

    # Text fallback for simplified HTML/cached snapshots.
    text = "\n".join(soup.stripped_strings)
    pat = re.compile(r"(?m)^\s*(?:(\d{1,2})\s+)?([А-ЯЁ][А-Яа-яЁё'’-]+(?:\s+[А-ЯЁ][А-Яа-яЁё'’-]+){1,3})\s+\d{1,2}\s+\d{3}\s+\d{2,3}\s+(вратарь|защитник|нападающий)\s*$")
    for m in pat.finditer(text):
        out.append(SportsPlayer(int(m.group(1)) if m.group(1) else None, m.group(2).strip(), POS_RU[m.group(3)], None))
    return out


def nhl_roster(session: requests.Session, tri: str) -> list[dict[str, Any]]:
    data = get_json(session, f"{NHL}/roster/{tri}/current")
    rows: list[dict[str, Any]] = []
    for section in ("forwards", "defensemen", "goalies"):
        for p in data.get(section) or []:
            rows.append({
                "player_id": int(p["id"]),
                "number": int(p["sweaterNumber"]) if p.get("sweaterNumber") is not None else None,
                "broad_position": nhl_broad_position(section, p),
                "full_name_en": " ".join(x for x in (localized(p.get("firstName")), localized(p.get("lastName"))) if x),
            })
    return rows


def provisional_country(session: requests.Session, player_id: int) -> str | None:
    try:
        data = get_json(session, f"{NHL}/player/{player_id}/landing")
        code = str(data.get("birthCountry") or "").strip().upper()
        return code or None
    except Exception:
        return None


def match_team(nhl_rows: list[dict[str, Any]], sports_rows: list[SportsPlayer]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    matched: list[dict[str, Any]] = []
    unresolved: list[dict[str, Any]] = []
    for p in nhl_rows:
        candidates = [s for s in sports_rows if s.number == p["number"] and s.broad_position == p["broad_position"]]
        if len(candidates) == 1:
            s = candidates[0]
            matched.append({**p, "full_name_ru": s.name_ru, "sports_ru_url": s.url})
        else:
            unresolved.append({**p, "candidate_names_ru": [s.name_ru for s in candidates]})
    return matched, unresolved


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--teams", default=",".join(SPORTS_SLUGS), help="Comma-separated NHL tri-codes")
    ap.add_argument("--out", default="state/center_player_meta_sports_ru.json")
    ap.add_argument("--sleep", type=float, default=0.15)
    ap.add_argument("--countries", action="store_true", help="Add provisional NHL birth-country codes (extra API calls)")
    args = ap.parse_args()

    teams = [x.strip().upper() for x in args.teams.split(",") if x.strip().upper() in SPORTS_SLUGS]
    session = requests.Session()
    session.headers.update({"User-Agent": UA, "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.6"})
    players: list[dict[str, Any]] = []
    unresolved: list[dict[str, Any]] = []
    team_summary: dict[str, Any] = {}

    for tri in teams:
        try:
            r = session.get(sports_team_url(tri), timeout=25)
            r.raise_for_status()
            sports_rows = parse_sports_roster(r.text)
            nhl_rows = nhl_roster(session, tri)
            hit, miss = match_team(nhl_rows, sports_rows)
            players.extend(hit)
            unresolved.extend({"team": tri, **x} for x in miss)
            team_summary[tri] = {"nhl": len(nhl_rows), "sports": len(sports_rows), "matched": len(hit), "unresolved": len(miss), "sports_url": sports_team_url(tri)}
            print(f"{tri}: NHL {len(nhl_rows)} / Sports {len(sports_rows)} / matched {len(hit)} / unresolved {len(miss)}", file=sys.stderr)
        except Exception as exc:
            team_summary[tri] = {"error": str(exc), "sports_url": sports_team_url(tri)}
            print(f"{tri}: ERROR {exc}", file=sys.stderr)
        time.sleep(max(0.0, args.sleep))

    if args.countries:
        for i, p in enumerate(players, 1):
            country = provisional_country(session, int(p["player_id"]))
            p["primary_country_code"] = country
            p["countries"] = [country] if country else []
            if i % 50 == 0:
                print(f"countries: {i}/{len(players)}", file=sys.stderr)
            time.sleep(max(0.0, args.sleep))

    for p in players:
        p.pop("number", None)
        p.pop("broad_position", None)
        p["source_updated_at"] = datetime.now(timezone.utc).isoformat()

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "sports.ru roster pages + NHL roster API",
        "players": players,
        "unresolved": unresolved,
        "teams": team_summary,
    }
    path = Path(args.out)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"out": str(path), "teams": len(teams), "players": len(players), "unresolved": len(unresolved)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
