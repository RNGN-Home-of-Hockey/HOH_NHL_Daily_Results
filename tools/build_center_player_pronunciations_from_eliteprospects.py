#!/usr/bin/env python3
"""Build a verified Elite Prospects player-audio cache for current NHL roster players.

Elite Prospects exposes pronunciation clips under:
https://files.eliteprospects.com/layout/player_audio/<name>.mp3

The collector never trusts a constructed URL blindly: each candidate is checked and only
HTTP 200/206 responses that look like audio are written to the cache.
"""
from __future__ import annotations

import argparse
import json
import re
import unicodedata
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests

NHL_API = "https://api-web.nhle.com/v1"
EP_BASE = "https://files.eliteprospects.com/layout/player_audio"
TEAM_CODES = [
    "ANA","BOS","BUF","CGY","CAR","CHI","COL","CBJ","DAL","DET","EDM","FLA",
    "LAK","MIN","MTL","NSH","NJD","NYI","NYR","OTT","PHI","PIT","SJS","SEA",
    "STL","TBL","TOR","UTA","VAN","VGK","WSH","WPG",
]
HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; HOH-NHL-Center/1.0; +https://github.com/RNGN-Home-of-Hockey/HOH_NHL_Daily_Results)",
    "Accept": "audio/mpeg,audio/*;q=0.9,*/*;q=0.3",
}


def localized(value) -> str:
    if isinstance(value, dict):
        return str(value.get("default") or value.get("en") or next(iter(value.values()), ""))
    return str(value or "")


def ascii_token(value: str) -> str:
    value = unicodedata.normalize("NFKD", str(value or ""))
    value = "".join(ch for ch in value if not unicodedata.combining(ch))
    value = value.replace("’", "'").replace("‘", "'")
    value = value.lower()
    value = re.sub(r"[^a-z0-9]+", "_", value).strip("_")
    return re.sub(r"_+", "_", value)


def candidate_slugs(first: str, last: str) -> list[str]:
    first0, last0 = ascii_token(first), ascii_token(last)
    out: list[str] = []
    def add(v: str):
        v = re.sub(r"_+", "_", v).strip("_")
        if v and v not in out:
            out.append(v)
    add(f"{first0}_{last0}")
    add(f"{first0.replace('_','')}_{last0.replace('_','')}")
    # Common initials such as J.T. Miller -> jt_miller / j_t_miller.
    if len(first0.replace("_", "")) <= 4:
        add(f"{first0.replace('_','')}_{last0}")
        add(f"{first0}_{last0.replace('_','')}")
    # Some names include suffixes or compound surnames. Keep a conservative variant.
    last_parts = [p for p in last0.split("_") if p]
    if len(last_parts) > 1:
        add(f"{first0}_{''.join(last_parts)}")
    return out[:5]


def load_roster() -> list[dict]:
    s = requests.Session(); s.headers.update({"User-Agent": HEADERS["User-Agent"], "Accept": "application/json"})
    players: dict[int, dict] = {}
    for tri in TEAM_CODES:
        r = s.get(f"{NHL_API}/roster/{tri}/current", timeout=25)
        r.raise_for_status()
        d = r.json()
        for group in ("forwards", "defensemen", "goalies"):
            for raw in d.get(group) or []:
                pid = raw.get("id")
                if not isinstance(pid, int):
                    continue
                first = localized(raw.get("firstName")).strip()
                last = localized(raw.get("lastName")).strip()
                if not first or not last:
                    continue
                players[pid] = {
                    "player_id": pid,
                    "first_name": first,
                    "last_name": last,
                    "full_name_en": f"{first} {last}",
                    "team_tri": tri,
                }
    return list(players.values())


def looks_audio(resp: requests.Response) -> bool:
    if resp.status_code not in (200, 206):
        return False
    ctype = (resp.headers.get("content-type") or "").lower()
    clen = resp.headers.get("content-length") or ""
    if "audio" in ctype or "mpeg" in ctype or "mp3" in ctype:
        return True
    # The EP file host occasionally uses application/octet-stream for MP3s.
    if "octet-stream" in ctype:
        try:
            return int(clen or 0) > 1000
        except Exception:
            return True
    return False


def verify_url(url: str, session: requests.Session) -> bool:
    try:
        r = session.head(url, headers=HEADERS, allow_redirects=True, timeout=9)
        if looks_audio(r):
            return True
        if r.status_code not in (403, 405):
            return False
    except requests.RequestException:
        pass
    try:
        r = session.get(url, headers={**HEADERS, "Range": "bytes=0-4095"}, stream=True, allow_redirects=True, timeout=12)
        ok = looks_audio(r)
        r.close()
        return ok
    except requests.RequestException:
        return False


def probe(player: dict) -> tuple[int, dict | None]:
    s = requests.Session()
    for slug in candidate_slugs(player["first_name"], player["last_name"]):
        url = f"{EP_BASE}/{slug}.mp3"
        if verify_url(url, s):
            return player["player_id"], {
                "player_id": player["player_id"],
                "full_name_en": player["full_name_en"],
                "team_tri": player["team_tri"],
                "pronunciation_url": url,
                "pronunciation_source": "eliteprospects_player_audio",
            }
    return player["player_id"], None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="state/center_player_pronunciations_eliteprospects.json")
    ap.add_argument("--workers", type=int, default=24)
    args = ap.parse_args()

    players = load_roster()
    mapped: dict[str, dict] = {}
    misses: list[dict] = []
    with ThreadPoolExecutor(max_workers=max(2, min(args.workers, 40))) as ex:
        future_map = {ex.submit(probe, p): p for p in players}
        done = 0
        for fut in as_completed(future_map):
            p = future_map[fut]
            try:
                pid, row = fut.result()
            except Exception as exc:
                print(f"probe error {p['full_name_en']}: {exc}", flush=True)
                row = None; pid = p["player_id"]
            if row:
                mapped[str(pid)] = row
            else:
                misses.append(p)
            done += 1
            if done % 100 == 0 or done == len(players):
                print(json.dumps({"checked": done, "total": len(players), "matched": len(mapped)}), flush=True)

    payload = {
        "source": "eliteprospects_player_audio",
        "source_pattern": f"{EP_BASE}/<normalized_player_name>.mp3",
        "matched": len(mapped),
        "roster_players": len(players),
        "players": dict(sorted(mapped.items(), key=lambda kv: int(kv[0]))),
        "unresolved": sorted(misses, key=lambda x: (x["team_tri"], x["full_name_en"])),
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"out": str(out), "matched": len(mapped), "roster_players": len(players), "unresolved": len(misses)}), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
