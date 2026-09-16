#!/usr/bin/env python3
"""Build NHL player 2026-27 cap-hit/AAV cache for HOH Center from PuckPedia team pages."""
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
PUCK = "https://puckpedia.com"
UA = "Mozilla/5.0 (compatible; HOH-NHL-Center/1.0; +https://github.com/RNGN-Home-of-Hockey/HOH_NHL_Daily_Results)"
SEASON = "2026-27"

TEAM_SLUGS = {
    "ANA":"anaheim-ducks","BOS":"boston-bruins","BUF":"buffalo-sabres","CGY":"calgary-flames",
    "CAR":"carolina-hurricanes","CHI":"chicago-blackhawks","COL":"colorado-avalanche","CBJ":"columbus-blue-jackets",
    "DAL":"dallas-stars","DET":"detroit-red-wings","EDM":"edmonton-oilers","FLA":"florida-panthers",
    "LAK":"los-angeles-kings","MIN":"minnesota-wild","MTL":"montreal-canadiens","NSH":"nashville-predators",
    "NJD":"new-jersey-devils","NYI":"new-york-islanders","NYR":"new-york-rangers","OTT":"ottawa-senators",
    "PHI":"philadelphia-flyers","PIT":"pittsburgh-penguins","SJS":"san-jose-sharks","SEA":"seattle-kraken",
    "STL":"st-louis-blues","TBL":"tampa-bay-lightning","TOR":"toronto-maple-leafs","UTA":"utah-mammoth",
    "VAN":"vancouver-canucks","VGK":"vegas-golden-knights","WSH":"washington-capitals","WPG":"winnipeg-jets",
}


def localized(value: Any) -> str:
    if isinstance(value, str): return value
    if isinstance(value, dict): return str(value.get("default") or value.get("en") or next(iter(value.values()), ""))
    return ""


def norm(text: str) -> str:
    s = unicodedata.normalize("NFKD", str(text or ""))
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = re.sub(r"[^a-z0-9]+", " ", s).strip()
    return re.sub(r"\s+", " ", s)


def display_name(raw: str) -> str:
    raw = re.sub(r"\s+", " ", raw or "").strip()
    if "," in raw:
        last, first = [x.strip() for x in raw.split(",", 1)]
        return f"{first} {last}".strip()
    return raw


def money(text: str) -> int | None:
    m = re.search(r"\$([0-9][0-9,]*(?:\.\d+)?)\s*([MK])?", text or "", re.I)
    if not m: return None
    value = float(m.group(1).replace(",", ""))
    suffix = (m.group(2) or "").upper()
    if suffix == "M": value *= 1_000_000
    elif suffix == "K": value *= 1_000
    return int(round(value))


def nhl_roster(session: requests.Session, tri: str) -> list[dict[str, Any]]:
    r = session.get(f"{NHL}/roster/{tri}/current", timeout=25)
    r.raise_for_status()
    data = r.json()
    out: list[dict[str, Any]] = []
    for section in ("forwards", "defensemen", "goalies"):
        for p in data.get(section) or []:
            full = " ".join(x for x in (localized(p.get("firstName")), localized(p.get("lastName"))) if x)
            out.append({"player_id": int(p["id"]), "name": full, "key": norm(full)})
    return out


def puck_rows(session: requests.Session, tri: str) -> tuple[list[dict[str, Any]], str]:
    url = f"{PUCK}/team/{TEAM_SLUGS[tri]}"
    r = session.get(url, timeout=30)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")
    out: list[dict[str, Any]] = []
    seen: set[tuple[str,int]] = set()
    for tr in soup.find_all("tr"):
        link = tr.find("a", href=re.compile(r"^/player/"))
        if not link: continue
        name = display_name(" ".join(link.stripped_strings))
        if len(name.split()) < 2: continue
        amount = money(" ".join(tr.stripped_strings))
        if not amount or amount < 100_000 or amount > 30_000_000: continue
        key = (norm(name), amount)
        if key in seen: continue
        seen.add(key)
        out.append({"name": name, "key": norm(name), "cap_hit": amount, "url": requests.compat.urljoin(PUCK, link.get("href") or "")})
    return out, url


def match(roster: list[dict[str, Any]], rows: list[dict[str, Any]]) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
    result: dict[str, dict[str, Any]] = {}
    unresolved: list[dict[str, Any]] = []
    used: set[int] = set()
    by_key: dict[str, list[int]] = {}
    for i, row in enumerate(rows): by_key.setdefault(row["key"], []).append(i)
    pending = []
    for p in roster:
        ids = [i for i in by_key.get(p["key"], []) if i not in used]
        if len(ids) == 1:
            i = ids[0]; used.add(i); result[str(p["player_id"])] = rows[i]
        else:
            pending.append(p)
    for p in pending:
        scored = sorted(((SequenceMatcher(None, p["key"], row["key"]).ratio(), i) for i, row in enumerate(rows) if i not in used), reverse=True)
        best = scored[0] if scored else (0.0, -1)
        second = scored[1][0] if len(scored) > 1 else 0.0
        if best[0] >= 0.91 and best[0] - second >= 0.035:
            i = best[1]; used.add(i); result[str(p["player_id"])] = rows[i]
        else:
            unresolved.append({"player_id": p["player_id"], "full_name_en": p["name"], "best_score": round(best[0], 4)})
    return result, unresolved


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="player_salary_2026_27.json")
    ap.add_argument("--sleep", type=float, default=0.15)
    args = ap.parse_args()
    session = requests.Session()
    session.headers.update({"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"})
    all_players: dict[str, Any] = {}
    teams: dict[str, Any] = {}
    unresolved_all: list[dict[str, Any]] = []
    for tri in TEAM_SLUGS:
        try:
            roster = nhl_roster(session, tri)
            rows, source_url = puck_rows(session, tri)
            hit, miss = match(roster, rows)
            for pid, row in hit.items():
                all_players[pid] = {
                    "team": tri,
                    "full_name_en": row["name"],
                    "cap_hit": int(row["cap_hit"]),
                    "aav": int(row["cap_hit"]),
                    "source_url": row["url"],
                }
            unresolved_all.extend({"team": tri, **x} for x in miss)
            teams[tri] = {"nhl": len(roster), "puckpedia": len(rows), "matched": len(hit), "unresolved": len(miss), "source_url": source_url}
            print(f"{tri}: NHL {len(roster)} / PuckPedia {len(rows)} / matched {len(hit)} / unresolved {len(miss)}")
        except Exception as exc:
            teams[tri] = {"error": str(exc)}
            print(f"{tri}: ERROR {exc}")
        time.sleep(max(0.0, args.sleep))
    payload = {
        "season": SEASON,
        "source": "PuckPedia team cap pages",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "players": all_players,
        "unresolved": unresolved_all,
        "teams": teams,
    }
    Path(args.out).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"players": len(all_players), "unresolved": len(unresolved_all), "teams": len(teams)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
