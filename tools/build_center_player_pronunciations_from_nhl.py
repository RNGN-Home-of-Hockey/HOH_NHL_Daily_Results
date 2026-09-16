#!/usr/bin/env python3
"""Build an NHL player pronunciation-audio cache from official NHL team pages.

The collector only follows public NHL.com pronunciation-guide pages and stores the
source/audio URLs; it does not copy or redistribute the audio files themselves.
"""
from __future__ import annotations

import argparse
import json
import re
import time
import unicodedata
from pathlib import Path

import requests
from bs4 import BeautifulSoup

NHL_API = "https://api-web.nhle.com/v1"
TEAM_CODES = [
    "ANA","BOS","BUF","CGY","CAR","CHI","COL","CBJ","DAL","DET","EDM","FLA",
    "LAK","MIN","MTL","NSH","NJD","NYI","NYR","OTT","PHI","PIT","SJS","SEA",
    "STL","TBL","TOR","UTA","VAN","VGK","WSH","WPG",
]
TEAM_SLUGS = {
    "ANA":"ducks","BOS":"bruins","BUF":"sabres","CGY":"flames","CAR":"hurricanes",
    "CHI":"blackhawks","COL":"avalanche","CBJ":"bluejackets","DAL":"stars","DET":"redwings",
    "EDM":"oilers","FLA":"panthers","LAK":"kings","MIN":"wild","MTL":"canadiens",
    "NSH":"predators","NJD":"devils","NYI":"islanders","NYR":"rangers","OTT":"senators",
    "PHI":"flyers","PIT":"penguins","SJS":"sharks","SEA":"kraken","STL":"blues",
    "TBL":"lightning","TOR":"mapleleafs","UTA":"mammoth","VAN":"canucks","VGK":"goldenknights",
    "WSH":"capitals","WPG":"jets",
}
HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/json",
    "User-Agent": "HOH-NHL-Center-Pronunciations/1.0 (+https://github.com/RNGN-Home-of-Hockey/HOH_NHL_Daily_Results)",
}


def norm(value: str) -> str:
    value = unicodedata.normalize("NFKD", str(value or ""))
    value = "".join(ch for ch in value if not unicodedata.combining(ch))
    return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()


def localized(value) -> str:
    if isinstance(value, dict):
        return str(value.get("default") or value.get("en") or next(iter(value.values()), ""))
    return str(value or "")


def roster_players(session: requests.Session, tri: str) -> list[dict]:
    r = session.get(f"{NHL_API}/roster/{tri}/current", timeout=25)
    r.raise_for_status()
    payload = r.json()
    rows = []
    for group in ("forwards", "defensemen", "goalies"):
        for raw in payload.get(group) or []:
            pid = raw.get("id")
            if not isinstance(pid, int):
                continue
            first = localized(raw.get("firstName"))
            last = localized(raw.get("lastName"))
            full = (first + " " + last).strip()
            if full:
                rows.append({"player_id": pid, "full_name_en": full, "team_tri": tri})
    return rows


def audio_href(node) -> str | None:
    for tag in node.find_all("a", href=True):
        href = str(tag.get("href") or "").strip()
        low = href.lower()
        if ".mp3" in low or ("media.d3.nhle.com" in low and "audio" in low):
            return href
    for tag in node.find_all(href=True):
        href = str(tag.get("href") or "").strip()
        if ".mp3" in href.lower():
            return href
    return None


def match_audio_for_player(soup: BeautifulSoup, player_name: str) -> tuple[str | None, str | None]:
    target = norm(player_name)
    if not target:
        return None, None
    candidates = []
    for text_node in soup.find_all(string=True):
        text = " ".join(str(text_node).split())
        if target not in norm(text):
            continue
        node = text_node.parent
        for depth in range(6):
            if node is None:
                break
            text_block = " ".join(node.get_text(" ", strip=True).split())
            if len(text_block) <= 900:
                href = audio_href(node)
                if href:
                    candidates.append((depth, len(text_block), href, text_block))
                    break
            node = node.parent
    if not candidates:
        return None, None
    candidates.sort(key=lambda x: (x[0], x[1]))
    _, _, href, context = candidates[0]
    return href, context[:500]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="state/center_player_pronunciations_nhl.json")
    ap.add_argument("--sleep", type=float, default=0.15)
    args = ap.parse_args()

    session = requests.Session()
    session.headers.update(HEADERS)
    output: dict[str, dict] = {}
    team_status: dict[str, dict] = {}

    for tri in TEAM_CODES:
        slug = TEAM_SLUGS[tri]
        source_url = f"https://www.nhl.com/{slug}/team/pronunciation-guide"
        try:
            roster = roster_players(session, tri)
        except Exception as exc:
            team_status[tri] = {"error": f"roster:{exc}", "matched": 0, "roster": 0}
            print(f"{tri}: roster error {exc}", flush=True)
            continue
        try:
            r = session.get(source_url, timeout=30, allow_redirects=True)
            r.raise_for_status()
            soup = BeautifulSoup(r.text, "html.parser")
        except Exception as exc:
            team_status[tri] = {"error": f"guide:{exc}", "matched": 0, "roster": len(roster), "source_url": source_url}
            print(f"{tri}: guide unavailable ({exc})", flush=True)
            continue

        matched = 0
        for p in roster:
            href, context = match_audio_for_player(soup, p["full_name_en"])
            if not href:
                continue
            if href.startswith("//"):
                href = "https:" + href
            elif href.startswith("/"):
                href = "https://www.nhl.com" + href
            output[str(p["player_id"])] = {
                "player_id": p["player_id"],
                "full_name_en": p["full_name_en"],
                "team_tri": tri,
                "pronunciation_url": href,
                "pronunciation_source": "nhl.com_team_pronunciation_guide",
                "source_url": source_url,
                "context": context,
            }
            matched += 1
        team_status[tri] = {"matched": matched, "roster": len(roster), "source_url": source_url}
        print(f"{tri}: roster {len(roster)} / audio {matched}", flush=True)
        time.sleep(max(0.0, args.sleep))

    payload = {
        "source": "official_nhl_team_pronunciation_guides",
        "players": output,
        "teams": team_status,
        "matched": len(output),
    }
    path = Path(args.out)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"out": str(path), "matched": len(output), "teams": len(team_status)}, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
