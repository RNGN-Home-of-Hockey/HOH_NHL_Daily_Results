#!/usr/bin/env python3
"""Map current NHL roster players to the official NHL pronunciation guide PDF."""
from __future__ import annotations

import argparse
import io
import json
import re
import unicodedata
from pathlib import Path

import requests
from pypdf import PdfReader

NHL_API = "https://api-web.nhle.com/v1"
GUIDE_URL = "https://media.nhl.com/site/asset/public/ext/2025-26/2025-26Pronunciations.pdf"
TEAM_CODES = [
    "ANA","BOS","BUF","CGY","CAR","CHI","COL","CBJ","DAL","DET","EDM","FLA",
    "LAK","MIN","MTL","NSH","NJD","NYI","NYR","OTT","PHI","PIT","SJS","SEA",
    "STL","TBL","TOR","UTA","VAN","VGK","WSH","WPG",
]
HEADERS = {"User-Agent":"HOH-NHL-Center-Pronunciation-Text/1.0","Accept":"application/json,application/pdf"}


def norm(value: str) -> str:
    value = unicodedata.normalize("NFKD", str(value or ""))
    value = "".join(ch for ch in value if not unicodedata.combining(ch))
    value = value.replace("’", "'").replace("‘", "'")
    return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()


def localized(value) -> str:
    if isinstance(value, dict):
        return str(value.get("default") or value.get("en") or next(iter(value.values()), ""))
    return str(value or "")


def roster(session: requests.Session) -> list[dict]:
    out = {}
    for tri in TEAM_CODES:
        r = session.get(f"{NHL_API}/roster/{tri}/current", timeout=25)
        r.raise_for_status()
        d = r.json()
        for group in ("forwards","defensemen","goalies"):
            for raw in d.get(group) or []:
                pid = raw.get("id")
                if not isinstance(pid,int):
                    continue
                first = localized(raw.get("firstName")).strip()
                last = localized(raw.get("lastName")).strip()
                if first and last:
                    out[pid] = {"player_id":pid,"first_name":first,"last_name":last,"full_name_en":f"{first} {last}","team_tri":tri}
    return list(out.values())


def pdf_lines(session: requests.Session) -> list[str]:
    r = session.get(GUIDE_URL, timeout=45)
    r.raise_for_status()
    reader = PdfReader(io.BytesIO(r.content))
    lines=[]
    for page in reader.pages:
        text = page.extract_text() or ""
        lines.extend(" ".join(x.split()) for x in text.splitlines() if x.strip())
    return lines


def build_index(lines: list[str]) -> dict[str,str]:
    idx={}
    for line in lines:
        if line.startswith("Last Name First Name") or line.startswith("2025-26 NHL"):
            continue
        if "(" not in line or ")" not in line:
            continue
        left, _, right = line.partition("(")
        name = " ".join(left.split()).strip()
        pronunciation = "(" + right.strip()
        if not pronunciation.endswith(")"):
            end = pronunciation.rfind(")")
            if end >= 0:
                pronunciation = pronunciation[:end+1]
        key = norm(name)
        if key and key not in idx:
            idx[key] = pronunciation
    return idx


def main() -> int:
    ap=argparse.ArgumentParser()
    ap.add_argument("--out",default="state/center_player_pronunciation_text_nhl.json")
    args=ap.parse_args()
    s=requests.Session(); s.headers.update(HEADERS)
    players=roster(s)
    lines=pdf_lines(s)
    idx=build_index(lines)
    mapped={}; unresolved=[]
    for p in players:
        key=norm(f"{p['last_name']} {p['first_name']}")
        pron=idx.get(key)
        if not pron:
            # Some PDF rows omit punctuation/diacritics differently; normalized prefix matching is safe when unique.
            candidates=[v for k,v in idx.items() if k==key or k.startswith(key+' ') or key.startswith(k+' ')]
            if len(candidates)==1:
                pron=candidates[0]
        if pron:
            mapped[str(p['player_id'])]={
                "player_id":p["player_id"],"full_name_en":p["full_name_en"],"team_tri":p["team_tri"],
                "pronunciation_text":pron,"pronunciation_source":"official_nhl_2025_26_pdf","source_url":GUIDE_URL,
            }
        else:
            unresolved.append(p)
    payload={"source":"official_nhl_2025_26_pronunciation_guide","source_url":GUIDE_URL,"matched":len(mapped),"roster_players":len(players),"players":mapped,"unresolved":unresolved}
    out=Path(args.out); out.parent.mkdir(parents=True,exist_ok=True); out.write_text(json.dumps(payload,ensure_ascii=False,indent=2,sort_keys=True)+"\n",encoding="utf-8")
    print(json.dumps({"out":str(out),"matched":len(mapped),"roster_players":len(players),"unresolved":len(unresolved)},ensure_ascii=False),flush=True)
    return 0


if __name__=="__main__":
    raise SystemExit(main())
