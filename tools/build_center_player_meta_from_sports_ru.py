#!/usr/bin/env python3
"""Build full Russian NHL player names for HOH products from Sports.ru rosters.

Outputs:
- a rich payload compatible with POST /api/telegram-center-admin/player-meta/import;
- a compact NHL player-id -> full Russian name JSON map reusable by the Center
  and the daily Results Bot.

Matching stays conservative, but is no longer limited to sweater number. It uses
number/position first and then Russian-to-Latin name similarity with uniqueness
and confidence-margin guards. Sports.ru remains the source of the Russian name.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

import requests
from bs4 import BeautifulSoup

NHL = "https://api-web.nhle.com/v1"
SPORTS = "https://www.sports.ru"
UA = "Mozilla/5.0 (compatible; HOH-NHL-Center/1.2; +https://github.com/RNGN-Home-of-Hockey/HOH_NHL_Daily_Results)"

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
CYR = {
    "а":"a","б":"b","в":"v","г":"g","д":"d","е":"e","ё":"e","ж":"zh","з":"z","и":"i","й":"i",
    "к":"k","л":"l","м":"m","н":"n","о":"o","п":"p","р":"r","с":"s","т":"t","у":"u","ф":"f",
    "х":"kh","ц":"ts","ч":"ch","ш":"sh","щ":"shch","ъ":"","ы":"y","ь":"","э":"e","ю":"yu","я":"ya",
}


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


def clean_sports_name(name: str) -> str:
    """Strip duplicate Latin labels from Sports.ru anchors such as 'Aatu Аату Рятю'."""
    name = re.sub(r"\s+", " ", str(name or "")).strip()
    if not name:
        return ""
    has_cyr = bool(re.search(r"[А-Яа-яЁё]", name))
    has_latin = bool(re.search(r"[A-Za-z]", name))
    if has_cyr and has_latin:
        cyr_tokens = [token for token in name.split() if re.search(r"[А-Яа-яЁё]", token)]
        if len(cyr_tokens) >= 2:
            name = " ".join(cyr_tokens)
    # Russian name cache must never keep an English duplicate in parentheses either.
    name = re.sub(r"\s*\([A-Za-z][^)]*\)\s*$", "", name).strip()
    return name


def parse_sports_roster(html: str) -> list[SportsPlayer]:
    soup = BeautifulSoup(html, "html.parser")
    out: list[SportsPlayer] = []
    seen: set[tuple[int | None, str, str | None]] = set()

    for row in soup.find_all(["tr", "li", "div"]):
        text = " ".join(row.stripped_strings)
        if not text or not any(word in text.lower() for word in POS_RU):
            continue
        link = row.find("a", href=re.compile(r"/hockey/(?:person|player)/|/hockey/[^/]+/"))
        if not link:
            continue
        raw_name = " ".join(link.stripped_strings).strip()
        name = clean_sports_name(raw_name)
        if len(name.split()) < 2 or not re.search(r"[А-Яа-яЁё]", name):
            continue
        pos = next((code for ru, code in POS_RU.items() if ru in text.lower()), None)
        before_index = text.find(raw_name)
        if before_index < 0:
            before_index = text.find(name)
        before = text[: max(0, before_index)]
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

    text = "\n".join(soup.stripped_strings)
    pat = re.compile(r"(?m)^\s*(?:(\d{1,2})\s+)?([А-ЯЁ][А-Яа-яЁё'’-]+(?:\s+[А-ЯЁ][А-Яа-яЁё'’-]+){1,3})\s+\d{1,2}\s+\d{3}\s+\d{2,3}\s+(вратарь|защитник|нападающий)\s*$")
    for m in pat.finditer(text):
        name = clean_sports_name(m.group(2))
        out.append(SportsPlayer(int(m.group(1)) if m.group(1) else None, name, POS_RU[m.group(3)], None))
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


def latinize(text: str) -> str:
    out = []
    for ch in str(text or "").lower().replace("ё", "е"):
        out.append(CYR.get(ch, ch))
    raw = unicodedata.normalize("NFKD", "".join(out))
    raw = "".join(c for c in raw if not unicodedata.combining(c))
    raw = re.sub(r"[^a-z0-9]+", " ", raw).strip()
    raw = raw.replace("kh", "h").replace("ts", "c").replace("iy", "i").replace("yy", "y")
    return re.sub(r"\s+", " ", raw)


def name_forms(text: str) -> list[str]:
    n = latinize(text)
    if not n:
        return []
    parts = n.split()
    forms = [n]
    if len(parts) >= 2:
        forms.append(" ".join(reversed(parts)))
    return list(dict.fromkeys(forms))


def similarity(left: str, right: str) -> float:
    best = 0.0
    for a in name_forms(left):
        for b in name_forms(right):
            best = max(best, SequenceMatcher(None, a, b).ratio())
            ap, bp = a.split(), b.split()
            if ap and bp:
                last = SequenceMatcher(None, ap[-1], bp[-1]).ratio()
                first = SequenceMatcher(None, ap[0], bp[0]).ratio()
                best = max(best, 0.68 * last + 0.32 * first)
    return best


def sports_person_slug(full_name_en: str) -> str:
    raw = unicodedata.normalize("NFKD", str(full_name_en or ""))
    raw = "".join(ch for ch in raw if not unicodedata.combining(ch))
    raw = raw.replace("’", "").replace("'", "").replace(".", "")
    raw = raw.encode("ascii", "ignore").decode("ascii").lower()
    return re.sub(r"[^a-z0-9]+", "-", raw).strip("-")


def sports_person_name(session: requests.Session, full_name_en: str) -> tuple[str, str] | None:
    """Resolve an NHL player through Sports.ru's canonical /person/<english-slug>/ page.

    This covers preseason/camp players who already have a Sports.ru person page
    but are not yet listed on the club roster page.
    """
    slug = sports_person_slug(full_name_en)
    if not slug:
        return None
    url = f"{SPORTS}/hockey/person/{slug}/"
    try:
        r = session.get(url, timeout=20)
        if r.status_code == 404:
            return None
        r.raise_for_status()
    except Exception:
        return None

    soup = BeautifulSoup(r.text, "html.parser")
    h1 = soup.find("h1")
    if not h1:
        return None
    name_ru = clean_sports_name(" ".join(h1.stripped_strings))
    if len(name_ru.split()) < 2 or not re.search(r"[А-Яа-яЁё]", name_ru):
        return None

    # Sports.ru person pages print the Latin canonical name under the Russian H1.
    # Guard against a slug collision/redirect before accepting the spelling.
    body = " ".join(soup.stripped_strings)
    en_norm = re.sub(r"[^a-z0-9]+", " ", unicodedata.normalize("NFKD", full_name_en).encode("ascii", "ignore").decode("ascii").lower()).strip()
    body_norm = re.sub(r"[^a-z0-9]+", " ", unicodedata.normalize("NFKD", body).encode("ascii", "ignore").decode("ascii").lower())
    if en_norm and en_norm not in body_norm:
        return None
    return name_ru, url


def resolve_unmatched_person_pages(
    session: requests.Session,
    unresolved: list[dict[str, Any]],
    sleep_seconds: float,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    matched: list[dict[str, Any]] = []
    still: list[dict[str, Any]] = []
    for row in unresolved:
        hit = sports_person_name(session, str(row.get("full_name_en") or ""))
        if hit:
            name_ru, url = hit
            clean = {k: v for k, v in row.items() if k != "candidate_names_ru"}
            matched.append({
                **clean,
                "full_name_ru": name_ru,
                "sports_ru_url": url,
                "match_method": "sports_person_slug",
                "match_score": 1.0,
            })
        else:
            still.append(row)
        time.sleep(max(0.0, sleep_seconds))
    return matched, still


def match_team(nhl_rows: list[dict[str, Any]], sports_rows: list[SportsPlayer]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    matched: list[dict[str, Any]] = []
    unresolved: list[dict[str, Any]] = []
    used: set[int] = set()

    def accept(p: dict[str, Any], idx: int, method: str, score: float = 1.0) -> None:
        s = sports_rows[idx]
        used.add(idx)
        matched.append({**p, "full_name_ru": clean_sports_name(s.name_ru), "sports_ru_url": s.url, "match_method": method, "match_score": round(score, 4)})

    pending: list[dict[str, Any]] = []
    for p in nhl_rows:
        candidates = [i for i, s in enumerate(sports_rows) if i not in used and s.number == p["number"] and s.broad_position == p["broad_position"]]
        if len(candidates) == 1:
            accept(p, candidates[0], "number_position")
        else:
            pending.append(p)

    still: list[dict[str, Any]] = []
    for p in pending:
        scored: list[tuple[float, int]] = []
        for i, s in enumerate(sports_rows):
            if i in used or s.broad_position != p["broad_position"]:
                continue
            score = similarity(p["full_name_en"], s.name_ru)
            if p.get("number") is not None and s.number == p.get("number"):
                score = min(1.0, score + 0.08)
            scored.append((score, i))
        scored.sort(reverse=True)
        best = scored[0] if scored else (0.0, -1)
        second = scored[1][0] if len(scored) > 1 else 0.0
        if best[0] >= 0.80 and best[0] - second >= 0.055:
            accept(p, best[1], "name_similarity", best[0])
        else:
            still.append(p)

    for p in still:
        en = name_forms(p["full_name_en"])
        en_parts = en[0].split() if en else []
        candidates: list[int] = []
        if len(en_parts) >= 2:
            ef, el = en_parts[0][0], en_parts[-1]
            for i, s in enumerate(sports_rows):
                if i in used or s.broad_position != p["broad_position"]:
                    continue
                for form in name_forms(s.name_ru):
                    sp = form.split()
                    if len(sp) >= 2 and sp[0][:1] == ef and SequenceMatcher(None, sp[-1], el).ratio() >= 0.90:
                        candidates.append(i)
                        break
        candidates = list(dict.fromkeys(candidates))
        if len(candidates) == 1:
            accept(p, candidates[0], "surname_initial", 0.90)
        else:
            unresolved.append({**p, "candidate_names_ru": [clean_sports_name(sports_rows[i].name_ru) for i in candidates[:5]]})

    return matched, unresolved


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--teams", default=",".join(SPORTS_SLUGS), help="Comma-separated NHL tri-codes")
    ap.add_argument("--out", default="state/center_player_meta_sports_ru.json")
    ap.add_argument("--full-names-out", default="ru_full_names.json", help="Reusable player-id -> full Russian name map")
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
            person_hit, miss = resolve_unmatched_person_pages(session, miss, min(max(args.sleep, 0.0), 0.08))
            hit.extend(person_hit)
            players.extend(hit)
            unresolved.extend({"team": tri, **x} for x in miss)
            methods: dict[str, int] = {}
            for p in hit:
                methods[p.get("match_method") or "unknown"] = methods.get(p.get("match_method") or "unknown", 0) + 1
            team_summary[tri] = {"nhl": len(nhl_rows), "sports": len(sports_rows), "matched": len(hit), "unresolved": len(miss), "methods": methods, "sports_url": sports_team_url(tri)}
            print(f"{tri}: NHL {len(nhl_rows)} / Sports {len(sports_rows)} / matched {len(hit)} / unresolved {len(miss)} / {methods}", file=sys.stderr)
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

    generated_at = datetime.now(timezone.utc).isoformat()
    for p in players:
        p.pop("number", None)
        p.pop("broad_position", None)
        p["full_name_ru"] = clean_sports_name(p.get("full_name_ru") or "")
        p["source_updated_at"] = generated_at

    payload = {
        "generated_at": generated_at,
        "source": "sports.ru roster pages + NHL roster API",
        "players": players,
        "unresolved": unresolved,
        "teams": team_summary,
    }
    path = Path(args.out)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    names_path = Path(args.full_names_out)
    existing_names: dict[str, str] = {}
    if names_path.exists():
        try:
            raw_existing = json.loads(names_path.read_text(encoding="utf-8") or "{}")
            existing_names = {
                str(pid): clean_sports_name(name)
                for pid, name in raw_existing.items()
                if str(pid).isdigit() and clean_sports_name(name)
            }
        except Exception:
            existing_names = {}

    fresh_names = {
        str(p["player_id"]): clean_sports_name(p["full_name_ru"])
        for p in sorted(players, key=lambda x: int(x["player_id"]))
        if clean_sports_name(p.get("full_name_ru") or "")
    }
    # Both maps originate from Sports.ru. Keeping the previous verified value
    # prevents a transient team-page failure from deleting Russian names used
    # by Telegram, Broadcast, Center and other HOH surfaces.
    full_names = {**existing_names, **fresh_names}
    names_path.parent.mkdir(parents=True, exist_ok=True)
    names_path.write_text(json.dumps(dict(sorted(full_names.items(), key=lambda kv: int(kv[0]))), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(json.dumps({"out": str(path), "full_names_out": str(names_path), "teams": len(teams), "players": len(players), "unresolved": len(unresolved)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
