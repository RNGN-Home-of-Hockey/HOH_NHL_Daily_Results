#!/usr/bin/env python3
"""Build the 2026-27 NHL cap-hit/AAV cache for HOH Center.

PuckPedia blocks GitHub-hosted runners with HTTP 403, so the automated cache uses
HighDanger's server-rendered 2026-27 contract table and matches those factual AAV
values to NHL player IDs from the official NHL roster API.
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
SOURCE_URL = "https://highdanger.com/nhl-contracts"
SOURCE_NAME = "HighDanger 2026-27 NHL contracts (AAV)"
UA = "Mozilla/5.0 (compatible; HOH-NHL-Center/1.1; +https://github.com/RNGN-Home-of-Hockey/HOH_NHL_Daily_Results)"
SEASON = "2026-27"
TEAMS = (
    "ANA","BOS","BUF","CGY","CAR","CHI","COL","CBJ","DAL","DET","EDM","FLA","LAK","MIN","MTL","NSH",
    "NJD","NYI","NYR","OTT","PHI","PIT","SJS","SEA","STL","TBL","TOR","UTA","VAN","VGK","WSH","WPG",
)


def localized(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return str(value.get("default") or value.get("en") or next(iter(value.values()), ""))
    return ""


def norm(text: str) -> str:
    s = unicodedata.normalize("NFKD", str(text or ""))
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = s.replace("stutzle", "stuetzle")
    s = re.sub(r"[^a-z0-9]+", " ", s).strip()
    return re.sub(r"\s+", " ", s)


def money(text: str) -> int | None:
    m = re.search(r"\$\s*([0-9][0-9,]*(?:\.\d+)?)\s*([MK])?", str(text or ""), re.I)
    if not m:
        return None
    value = float(m.group(1).replace(",", ""))
    suffix = (m.group(2) or "").upper()
    if suffix == "M":
        value *= 1_000_000
    elif suffix == "K":
        value *= 1_000
    return int(round(value))


def nhl_roster(session: requests.Session, tri: str) -> list[dict[str, Any]]:
    r = session.get(f"{NHL}/roster/{tri}/current", timeout=25)
    r.raise_for_status()
    data = r.json()
    out: list[dict[str, Any]] = []
    for section in ("forwards", "defensemen", "goalies"):
        for p in data.get(section) or []:
            full = " ".join(x for x in (localized(p.get("firstName")), localized(p.get("lastName"))) if x).strip()
            if not full:
                continue
            out.append({
                "player_id": int(p["id"]),
                "name": full,
                "key": norm(full),
                "nhl_team": tri,
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


def contract_rows(session: requests.Session) -> list[dict[str, Any]]:
    r = session.get(SOURCE_URL, timeout=35)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")
    rows: list[dict[str, Any]] = []
    seen: set[tuple[str, str, int]] = set()

    for tr in soup.find_all("tr"):
        cells = [re.sub(r"\s+", " ", td.get_text(" ", strip=True)).strip() for td in tr.find_all(["td", "th"])]
        if len(cells) < 6:
            continue
        amount_idx = next((i for i, cell in enumerate(cells) if "$" in cell and money(cell)), None)
        if amount_idx is None:
            continue
        # Current table columns: rank, player, team, position, age, AAV, expires.
        name = cells[1] if len(cells) > 1 else ""
        team = cells[2].upper() if len(cells) > 2 else ""
        amount = money(cells[amount_idx])
        if not name or len(name.split()) < 2 or not amount or amount < 100_000 or amount > 30_000_000:
            continue
        if team not in TEAMS:
            team = ""
        link = None
        player_link = tr.find("a", href=True)
        if player_link:
            link = requests.compat.urljoin(SOURCE_URL, player_link.get("href") or "")
        key = (norm(name), team, amount)
        if key in seen:
            continue
        seen.add(key)
        rows.append({
            "name": name,
            "key": norm(name),
            "team": team,
            "cap_hit": amount,
            "aav": amount,
            "url": link or SOURCE_URL,
        })

    if len(rows) < 350:
        # Defensive fallback for a layout that renders rows without <td> cells.
        text = "\n".join(soup.stripped_strings)
        line_re = re.compile(
            r"(?m)^\s*\d+\s+([A-Z][A-Za-zÀ-ž.'’-]+(?:\s+[A-Z][A-Za-zÀ-ž.'’-]+){1,3})\s+"
            r"(ANA|BOS|BUF|CGY|CAR|CHI|COL|CBJ|DAL|DET|EDM|FLA|LAK|MIN|MTL|NSH|NJD|NYI|NYR|OTT|PHI|PIT|SJS|SEA|STL|TBL|TOR|UTA|VAN|VGK|WSH|WPG)\s+"
            r"(?:C|LW|RW|D|G)\s+(?:\d+|—)\s+(\$[0-9.]+[MK])",
            re.I,
        )
        for m in line_re.finditer(text):
            name, team, amount_text = m.group(1).strip(), m.group(2).upper(), m.group(3)
            amount = money(amount_text)
            if not amount:
                continue
            key = (norm(name), team, amount)
            if key in seen:
                continue
            seen.add(key)
            rows.append({"name": name, "key": norm(name), "team": team, "cap_hit": amount, "aav": amount, "url": SOURCE_URL})

    return rows


def match(pool: list[dict[str, Any]], rows: list[dict[str, Any]]) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
    result: dict[str, dict[str, Any]] = {}
    unresolved: list[dict[str, Any]] = []
    by_key: dict[str, list[dict[str, Any]]] = {}
    for p in pool:
        by_key.setdefault(p["key"], []).append(p)

    used_players: set[int] = set()
    pending: list[dict[str, Any]] = []
    for row in rows:
        candidates = [p for p in by_key.get(row["key"], []) if p["player_id"] not in used_players]
        same_team = [p for p in candidates if row["team"] and p["nhl_team"] == row["team"]]
        chosen = same_team[0] if len(same_team) == 1 else (candidates[0] if len(candidates) == 1 else None)
        if chosen:
            used_players.add(chosen["player_id"])
            result[str(chosen["player_id"])] = {**row, "nhl_name": chosen["name"], "match_method": "exact_name"}
        else:
            pending.append(row)

    available = [p for p in pool if p["player_id"] not in used_players]
    for row in pending:
        candidates = [p for p in available if not row["team"] or p["nhl_team"] == row["team"]]
        scored = sorted(((SequenceMatcher(None, row["key"], p["key"]).ratio(), p) for p in candidates), key=lambda x: x[0], reverse=True)
        best = scored[0] if scored else (0.0, None)
        second = scored[1][0] if len(scored) > 1 else 0.0
        if best[1] and best[0] >= 0.93 and best[0] - second >= 0.035:
            p = best[1]
            used_players.add(p["player_id"])
            available = [x for x in available if x["player_id"] != p["player_id"]]
            result[str(p["player_id"])] = {**row, "nhl_name": p["name"], "match_method": "fuzzy_name", "match_score": round(best[0], 4)}
        else:
            unresolved.append({"full_name_en": row["name"], "team": row["team"], "aav": row["aav"], "best_score": round(best[0], 4)})
    return result, unresolved


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="player_salary_2026_27.json")
    ap.add_argument("--sleep", type=float, default=0.10)
    args = ap.parse_args()

    session = requests.Session()
    session.headers.update({"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"})
    pool = load_nhl_pool(session, args.sleep)
    rows = contract_rows(session)
    matched, unresolved = match(pool, rows)

    players: dict[str, Any] = {}
    by_team: dict[str, dict[str, int]] = {tri: {"source": 0, "matched": 0} for tri in TEAMS}
    for row in rows:
        if row["team"] in by_team:
            by_team[row["team"]]["source"] += 1
    for pid, row in matched.items():
        if row["team"] in by_team:
            by_team[row["team"]]["matched"] += 1
        players[pid] = {
            "team": row["team"],
            "full_name_en": row["name"],
            "nhl_name": row.get("nhl_name"),
            "cap_hit": int(row["cap_hit"]),
            "aav": int(row["aav"]),
            "source_url": row["url"],
            "match_method": row.get("match_method"),
            "match_score": row.get("match_score"),
        }

    payload = {
        "season": SEASON,
        "source": SOURCE_NAME,
        "source_url": SOURCE_URL,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "nhl_pool": len(pool),
        "source_contracts": len(rows),
        "players": players,
        "unresolved": unresolved,
        "teams": by_team,
    }
    Path(args.out).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"nhl_pool": len(pool), "source_contracts": len(rows), "players": len(players), "unresolved": len(unresolved), "teams": len(by_team)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
