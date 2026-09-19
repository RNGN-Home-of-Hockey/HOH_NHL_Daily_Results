#!/usr/bin/env python3
"""Build the 2026-27 NHL salary/AAV cache for HOH Center.

The cache is matched to official NHL player IDs. MarkerZone exposes a public
server-rendered 2026-27 salary table with both single-season cash salary and cap
hit. The product sorts by AAV/cap hit by default and can still expose cash salary.
"""
from __future__ import annotations

import argparse
import json
import re
import time
import unicodedata
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

import requests
from bs4 import BeautifulSoup

NHL = "https://api-web.nhle.com/v1"
SOURCE_URL = "https://www.markerzone.com/hockey/stats/nhl/salaries.php?a=168"
SOURCE_NAME = "MarkerZone NHL salaries 2026-27"
UA = "Mozilla/5.0 (compatible; HOH-NHL-Center/1.2; +https://github.com/RNGN-Home-of-Hockey/HOH_NHL_Daily_Results)"
SEASON = "2026-27"
TEAMS = (
    "ANA","BOS","BUF","CGY","CAR","CHI","COL","CBJ","DAL","DET","EDM","FLA","LAK","MIN","MTL","NSH",
    "NJD","NYI","NYR","OTT","PHI","PIT","SJS","SEA","STL","TBL","TOR","UTA","VAN","VGK","WSH","WPG",
)
TEAM_ALIASES = {"LV":"VGK","MON":"MTL"}


def localized(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return str(value.get("default") or value.get("en") or next(iter(value.values()), ""))
    return ""


def norm(text: str) -> str:
    s = unicodedata.normalize("NFKD", str(text or ""))
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = re.sub(r"[^a-z0-9]+", " ", s).strip()
    s = re.sub(r"\s+", " ", s)
    aliases = {
        # Existing full-name variants from the salary source.
        "kristopher letang":"kris letang",
        "janis jerome moser":"j j moser",
        "john jason peterka":"jj peterka",

        # NHL roster short names / salary-table legal names.
        "alex killorn":"alexander killorn",
        "timmy washe":"tim washe",
        "will borgen":"william borgen",
        "matt coronato":"matthew coronato",
        "jake middleton":"jacob middleton",
        "mike benning":"michael benning",
        "zach sawchenko":"zachary sawchenko",
        "fedor svechkov":"fyodor svechkov",
        "zach werenski":"zachary werenski",
        "cam talbot":"cameron talbot",
        "mattias janmark":"mattias janmark nylen",
        "matt savoie":"matthew savoie",
        "joshua brown":"josh brown",
        "damien carfagna":"damian carfagna",
        "mikey anderson":"michael anderson",
        "matt boldy":"matthew boldy",
        "mike matheson":"michael matheson",
        "nick perbix":"nicklaus perbix",
        "matt murray":"matthew murray",
        "nico daws":"nicolas daws",
        "tony deangelo":"anthony deangelo",
        "matthew kessel":"matt kessel",
        "matt rempe":"matthew rempe",
        "joe veleno":"joseph veleno",
        "gabe perreault":"gabriel perreault",
        "michael amadio":"mike amadio",
        "cam dineen":"cameron dineen",
        "dan vladar":"daniel vladar",
        "nick robertson":"nicholas robertson",
        "tommy novak":"thomas novak",
        "ben kindel":"benjamin kindel",
        "cam lund":"cameron lund",
        "matty beniers":"matthew beniers",
        "jacob quillan":"jake quillan",
        "bo groulx":"benoit olivier groulx",
        "henrik rybinski":"henry rybinski",
        "victor mancini":"vittorio mancini",
        "aleksei medvedev":"alexei medvedev",
        "alex ovechkin":"alexander ovechkin",
        "danil zhilkin":"danny zhilkin",
        "dmitri voronkov":"dmitry voronkov",
        "nikita susuev":"nikita susuyev",
        "cooper flinton":"robert flinton",
    }
    return aliases.get(s, s)


def parse_int_money(text: str) -> int | None:
    raw = re.sub(r"[^0-9]", "", str(text or ""))
    if not raw:
        return None
    value = int(raw)
    return value if 100_000 <= value <= 30_000_000 else None


def nhl_roster(session: requests.Session, tri: str) -> list[dict[str, Any]]:
    r = session.get(f"{NHL}/roster/{tri}/current", timeout=25)
    r.raise_for_status()
    data = r.json()
    out: list[dict[str, Any]] = []
    for section, forced_position in (("forwards", ""), ("defensemen", "D"), ("goalies", "G")):
        for p in data.get(section) or []:
            full = " ".join(x for x in (localized(p.get("firstName")), localized(p.get("lastName"))) if x).strip()
            if not full:
                continue
            position = str(p.get("positionCode") or p.get("position") or forced_position or "").upper().strip()
            out.append({
                "player_id":int(p["id"]),"name":full,"key":norm(full),"nhl_team":tri,
                "position":position,
            })
    return out


def load_nhl_pool(session: requests.Session, sleep: float) -> list[dict[str, Any]]:
    by_id: dict[int, dict[str, Any]] = {}
    errors: dict[str, str] = {}
    for tri in TEAMS:
        try:
            for p in nhl_roster(session, tri):
                by_id[p["player_id"]] = p
        except Exception as exc:
            errors[tri] = str(exc)
            print(f"{tri}: NHL ERROR {exc}")
        time.sleep(max(0.0, sleep))
    if errors:
        print(f"NHL roster errors: {errors}")
    return list(by_id.values())


def normalize_team(value: str) -> str:
    team = re.sub(r"[^A-Z]", "", str(value or "").upper())
    team = TEAM_ALIASES.get(team, team)
    return team if team in TEAMS else ""


def source_position(text: str) -> str:
    """Extract the roster position MarkerZone prints next to the player name."""
    m = re.search(r"\((C|LW|RW|D|G)(?:[/, ](?:C|LW|RW|D|G))*\)", str(text or "").upper())
    return m.group(1) if m else ""


def source_rows(session: requests.Session) -> list[dict[str, Any]]:
    r = session.get(SOURCE_URL, timeout=35)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")
    out: list[dict[str, Any]] = []
    seen: set[tuple[str,int,int]] = set()

    # MarkerZone player rows are server-rendered. Anchor text is the player name;
    # the row contains team plus the final two monetary columns: salary, cap hit.
    for link in soup.find_all("a", href=True):
        name = re.sub(r"\s+", " ", link.get_text(" ", strip=True)).strip()
        if len(name.split()) < 2 or not re.search(r"[A-Za-z]", name):
            continue
        href = str(link.get("href") or "")
        if "player" not in href.lower() and "fiche" not in href.lower():
            continue
        row = link.find_parent("tr") or link.find_parent("div")
        if not row:
            continue
        cells = [re.sub(r"\s+", " ", x.get_text(" ", strip=True)).strip() for x in row.find_all(["td","th"])]
        row_text = re.sub(r"\s+", " ", row.get_text(" ", strip=True)).strip()
        team = ""
        for candidate in re.findall(r"(?<![A-Z])([A-Z]{2,3})(?![A-Z])", row_text.upper()):
            normalized = normalize_team(candidate)
            if normalized:
                team = normalized
                break
        amounts: list[int] = []
        for cell in cells:
            value = parse_int_money(cell)
            if value is not None:
                amounts.append(value)
        if len(amounts) < 2:
            # Fallback: MarkerZone sometimes renders monetary cells without a clean td split.
            for m in re.finditer(r"(?<!\d)(\d{1,2}(?:[\s\u00a0]\d{3}){1,2})(?!\d)", row_text):
                value = parse_int_money(m.group(1))
                if value is not None:
                    amounts.append(value)
        if len(amounts) < 2:
            continue
        salary_cash, cap_hit = amounts[-2], amounts[-1]
        key = (norm(name), salary_cash, cap_hit)
        if key in seen:
            continue
        seen.add(key)
        out.append({
            "name":name,"key":norm(name),"team":team,"position":source_position(row_text),
            "salary_cash":salary_cash,"cap_hit":cap_hit,"aav":cap_hit,
            "url":requests.compat.urljoin(SOURCE_URL, href),
        })

    # Layout-independent fallback using the row text around player anchors.
    if len(out) < 350:
        for row in soup.find_all(["tr","div"]):
            text = re.sub(r"\s+", " ", row.get_text(" ", strip=True)).strip()
            m = re.search(r"(?:^|\s)\d+\s*[-.]?\s*([A-Z][A-Za-zÀ-ž.'’-]+(?:\s+[A-Z][A-Za-zÀ-ž.'’-]+){1,3})\s*\((?:C|LW|RW|D|G)\)", text)
            if not m:
                continue
            name = m.group(1).strip()
            amounts = [parse_int_money(x) for x in re.findall(r"(?<!\d)(\d{1,2}(?:[\s\u00a0]\d{3}){1,2})(?!\d)", text)]
            amounts = [x for x in amounts if x]
            if len(amounts) < 2:
                continue
            team = ""
            for candidate in re.findall(r"(?<![A-Z])([A-Z]{2,3})(?![A-Z])", text.upper()):
                normalized = normalize_team(candidate)
                if normalized:
                    team = normalized
                    break
            salary_cash, cap_hit = amounts[-2], amounts[-1]
            key = (norm(name), salary_cash, cap_hit)
            if key in seen:
                continue
            seen.add(key)
            out.append({"name":name,"key":norm(name),"team":team,"position":source_position(text),"salary_cash":salary_cash,"cap_hit":cap_hit,"aav":cap_hit,"url":SOURCE_URL})
    return out


def match(pool: list[dict[str, Any]], rows: list[dict[str, Any]]) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
    result: dict[str, dict[str, Any]] = {}
    unresolved: list[dict[str, Any]] = []
    by_key: dict[str, list[dict[str, Any]]] = {}
    for p in pool:
        by_key.setdefault(p["key"], []).append(p)
    used: set[int] = set()
    pending: list[dict[str, Any]] = []

    for row in rows:
        candidates = [p for p in by_key.get(row["key"], []) if p["player_id"] not in used]
        same_team = [p for p in candidates if row["team"] and p["nhl_team"] == row["team"]]
        team_pool = same_team or candidates
        same_position = [p for p in team_pool if row.get("position") and p.get("position") == row["position"]]
        chosen = (
            same_position[0] if len(same_position)==1
            else team_pool[0] if len(team_pool)==1
            else None
        )
        if chosen:
            used.add(chosen["player_id"])
            result[str(chosen["player_id"])] = {
                **row,"nhl_name":chosen["name"],
                "match_method":"exact_name_position" if same_position else "exact_name",
            }
        else:
            pending.append(row)

    available = [p for p in pool if p["player_id"] not in used]
    for row in pending:
        candidates = [p for p in available if not row["team"] or p["nhl_team"]==row["team"]]
        if row.get("position"):
            positioned = [p for p in candidates if p.get("position")==row["position"]]
            if positioned:
                candidates = positioned
        if not candidates:
            candidates = available
        scored = sorted(((SequenceMatcher(None,row["key"],p["key"]).ratio(),p) for p in candidates),key=lambda x:x[0],reverse=True)
        best = scored[0] if scored else (0.0,None)
        second = scored[1][0] if len(scored)>1 else 0.0
        # Position/team restrictions make the remaining nickname/legal-name aliases much safer.
        threshold = 0.86 if row.get("position") and row.get("team") else 0.91
        margin = 0.025 if row.get("position") and row.get("team") else 0.035
        if best[1] and best[0]>=threshold and best[0]-second>=margin:
            p=best[1];used.add(p["player_id"]);available=[x for x in available if x["player_id"]!=p["player_id"]]
            result[str(p["player_id"])]={**row,"nhl_name":p["name"],"match_method":"fuzzy_name_position" if row.get("position") else "fuzzy_name","match_score":round(best[0],4)}
        else:
            unresolved.append({"full_name_en":row["name"],"team":row["team"],"position":row.get("position") or "","salary_cash":row["salary_cash"],"aav":row["aav"],"best_score":round(best[0],4)})
    return result, unresolved


def main() -> int:
    ap=argparse.ArgumentParser()
    ap.add_argument("--out",default="player_salary_2026_27.json")
    ap.add_argument("--sleep",type=float,default=0.10)
    args=ap.parse_args()
    session=requests.Session();session.headers.update({"User-Agent":UA,"Accept-Language":"en-US,en;q=0.9"})
    pool=load_nhl_pool(session,args.sleep)
    rows=source_rows(session)
    matched,unresolved=match(pool,rows)
    players:dict[str,Any]={}
    for pid,row in matched.items():
        players[pid]={
            "team":row["team"],"position":row.get("position") or "","full_name_en":row["name"],"nhl_name":row.get("nhl_name"),
            "salary_cash":int(row["salary_cash"]),"cap_hit":int(row["cap_hit"]),"aav":int(row["aav"]),
            "source_url":row["url"],"match_method":row.get("match_method"),"match_score":row.get("match_score"),
        }
    payload={
        "season":SEASON,"source":SOURCE_NAME,"source_url":SOURCE_URL,"generated_at":datetime.now(timezone.utc).isoformat(),
        "nhl_pool":len(pool),"source_contracts":len(rows),"players":players,"unresolved":unresolved,
    }
    Path(args.out).write_text(json.dumps(payload,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"nhl_pool":len(pool),"source_contracts":len(rows),"players":len(players),"unresolved":len(unresolved)}))
    return 0


if __name__=="__main__":
    raise SystemExit(main())
