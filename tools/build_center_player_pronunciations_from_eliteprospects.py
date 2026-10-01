#!/usr/bin/env python3
"""Build and locally cache pronunciation audio + profile metadata for current NHL players.

Primary pronunciation source: Elite Prospects public player-audio CDN.
Fallback pronunciation source: official NHL team pronunciation-guide cache.

The current NHL roster is authoritative for who must be tracked. Every run re-checks
unresolved players so mid-season call-ups automatically acquire a profile/audio record
as soon as the upstream source publishes one. Verified MP3s are copied into the Worker
static assets so the Mini App does not depend on third-party hotlinking at playback time.
"""
from __future__ import annotations

import argparse
import html
import json
import re
import unicodedata
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import quote, urljoin

import requests

NHL_API = "https://api-web.nhle.com/v1"
EP_ORIGIN = "https://www.eliteprospects.com"
EP_AUTOCOMPLETE = "https://autocomplete.eliteprospects.com/players"
EP_BASE = "https://files.eliteprospects.com/layout/player_audio"
_EP_BUILD_ID: str | None = None
TEAM_CODES = [
    "ANA","BOS","BUF","CGY","CAR","CHI","COL","CBJ","DAL","DET","EDM","FLA",
    "LAK","MIN","MTL","NSH","NJD","NYI","NYR","OTT","PHI","PIT","SJS","SEA",
    "STL","TBL","TOR","UTA","VAN","VGK","WSH","WPG",
]
HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; HOH-NHL-Center/2.0; +https://github.com/RNGN-Home-of-Hockey/HOH_NHL_Daily_Results)",
}
AUDIO_HEADERS = {
    **HEADERS,
    "Accept": "audio/mpeg,audio/*;q=0.9,application/octet-stream;q=0.5,*/*;q=0.2",
}
HTML_HEADERS = {
    **HEADERS,
    "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.2",
    "Accept-Language": "en-US,en;q=0.8",
}
MAX_AUDIO_BYTES = 8 * 1024 * 1024


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


def compact_token(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", ascii_token(value))


def candidate_slugs(first: str, last: str) -> list[str]:
    first0, last0 = ascii_token(first), ascii_token(last)
    fparts = [p for p in first0.split("_") if p]
    lparts = [p for p in last0.split("_") if p]
    out: list[str] = []

    def add(v: str):
        v = re.sub(r"_+", "_", v).strip("_")
        if v and v not in out:
            out.append(v)

    add(f"{first0}_{last0}")
    add(f"{''.join(fparts)}_{''.join(lparts)}")
    if len(fparts) > 1:
        add(f"{fparts[0]}_{last0}")
        add(f"{''.join(fparts)}_{last0}")
    if len(lparts) > 1:
        add(f"{first0}_{''.join(lparts)}")
        add(f"{first0}_{lparts[-1]}")
    # J.T., A.J., P-O and similar public-name forms.
    flat_first = "".join(fparts)
    if 1 < len(flat_first) <= 4:
        add(f"{flat_first}_{last0}")
        add(f"{'_'.join(flat_first)}_{last0}")
    # Suffixes occasionally appear in NHL feeds but not in the EP audio filename.
    clean_last = re.sub(r"_(jr|sr|ii|iii|iv)$", "", last0)
    if clean_last != last0:
        add(f"{first0}_{clean_last}")
    return out[:10]


def load_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def load_roster() -> list[dict]:
    s = requests.Session()
    s.headers.update({**HEADERS, "Accept": "application/json"})
    players: dict[int, dict] = {}
    for tri in TEAM_CODES:
        r = s.get(f"{NHL_API}/roster/{tri}/current", timeout=25)
        r.raise_for_status()
        d = r.json()
        for group, forced in (("forwards", None), ("defensemen", "D"), ("goalies", "G")):
            for raw in d.get(group) or []:
                pid = raw.get("id")
                if not isinstance(pid, int):
                    continue
                first = localized(raw.get("firstName")).strip()
                last = localized(raw.get("lastName")).strip()
                if not first or not last:
                    continue
                h = raw.get("heightInInches")
                w = raw.get("weightInPounds")
                players[pid] = {
                    "player_id": pid,
                    "first_name": first,
                    "last_name": last,
                    "full_name_en": f"{first} {last}",
                    "team_tri": tri,
                    "position_code": forced or str(raw.get("positionCode") or raw.get("position") or "").upper() or None,
                    "sweater_number": raw.get("sweaterNumber"),
                    "shoots_catches": str(raw.get("shootsCatches") or "").strip() or None,
                    "birth_date": str(raw.get("birthDate") or "").strip() or None,
                    "birth_country": str(raw.get("birthCountry") or "").strip().upper() or None,
                    "height_cm": round(float(h) * 2.54) if isinstance(h, (int, float)) else None,
                    "weight_kg": round(float(w) * 0.45359237) if isinstance(w, (int, float)) else None,
                }
    return list(players.values())


def looks_audio_response(resp: requests.Response) -> bool:
    if resp.status_code not in (200, 206):
        return False
    ctype = (resp.headers.get("content-type") or "").lower()
    if "audio" in ctype or "mpeg" in ctype or "mp3" in ctype:
        return True
    if "octet-stream" in ctype:
        try:
            return int(resp.headers.get("content-length") or 0) > 1000
        except Exception:
            return True
    return False


def verified_url(url: str, session: requests.Session) -> bool:
    try:
        r = session.head(url, headers=AUDIO_HEADERS, allow_redirects=True, timeout=9)
        if looks_audio_response(r):
            return True
        if r.status_code not in (403, 405):
            return False
    except requests.RequestException:
        pass
    try:
        r = session.get(
            url,
            headers={**AUDIO_HEADERS, "Range": "bytes=0-4095"},
            stream=True,
            allow_redirects=True,
            timeout=15,
        )
        ok = looks_audio_response(r)
        r.close()
        return ok
    except requests.RequestException:
        return False


def download_audio(url: str, target: Path, session: requests.Session) -> bool:
    # Existing local assets remain authoritative during transient upstream failures.
    if target.is_file() and target.stat().st_size > 1000:
        return True
    tmp = target.with_suffix(".tmp")
    try:
        with session.get(url, headers=AUDIO_HEADERS, stream=True, allow_redirects=True, timeout=25) as r:
            if not looks_audio_response(r):
                return False
            total = 0
            target.parent.mkdir(parents=True, exist_ok=True)
            with tmp.open("wb") as fh:
                for chunk in r.iter_content(65536):
                    if not chunk:
                        continue
                    total += len(chunk)
                    if total > MAX_AUDIO_BYTES:
                        raise ValueError("audio_too_large")
                    fh.write(chunk)
        if total <= 1000:
            tmp.unlink(missing_ok=True)
            return False
        tmp.replace(target)
        return True
    except Exception:
        tmp.unlink(missing_ok=True)
        return False


def extract_ep_links(text: str) -> list[str]:
    text = html.unescape(str(text or "").replace("\\/", "/"))
    out: list[str] = []
    for raw in re.findall(r'href=["\']([^"\']*/player/\d+/[^"\'?#]+)', text, flags=re.I):
        url = urljoin(EP_ORIGIN, raw)
        if url not in out:
            out.append(url)
    return out


def profile_score(url: str, player: dict) -> int:
    slug = ascii_token(url.rsplit("/", 1)[-1])
    first = ascii_token(player["first_name"])
    last = ascii_token(player["last_name"])
    full = f"{first}_{last}"
    score = 0
    if slug == full:
        score += 100
    if compact_token(first) and compact_token(first) in compact_token(slug):
        score += 15
    if compact_token(last) and compact_token(last) in compact_token(slug):
        score += 35
    return score


def discover_ep_profile(player: dict, session: requests.Session) -> tuple[str | None, str | None]:
    name = player["full_name_en"]
    # Current EliteProspects search box uses this public unauthenticated autocomplete
    # backend. It returns stable player id + slug and avoids scraping the client-rendered
    # advanced-search page.
    try:
        r = session.get(
            EP_AUTOCOMPLETE,
            params={"q": name},
            headers={**HEADERS, "Accept": "application/json"},
            timeout=15,
        )
        if r.ok:
            rows = r.json()
            if isinstance(rows, list):
                birth_year = str(player.get("birth_date") or "")[:4]
                scored: list[tuple[int, dict]] = []
                target = compact_token(name)
                for raw in rows:
                    if not isinstance(raw, dict):
                        continue
                    pid = str(raw.get("id") or "").strip()
                    slug = str(raw.get("slug") or "").strip()
                    full = str(raw.get("fullname") or "").strip()
                    if not pid or not slug:
                        continue
                    score = 0
                    if compact_token(full) == target:
                        score += 120
                    score += profile_score(f"{EP_ORIGIN}/player/{pid}/{slug}", player)
                    if birth_year and str(raw.get("age") or "").strip() == birth_year:
                        score += 30
                    if score >= 70:
                        scored.append((score, raw))
                if scored:
                    scored.sort(key=lambda x: x[0], reverse=True)
                    raw = scored[0][1]
                    return f"{EP_ORIGIN}/player/{raw['id']}/{raw['slug']}", None
    except (requests.RequestException, ValueError, TypeError, KeyError):
        pass

    # Legacy/fallback HTML search paths in case the autocomplete service changes.
    for search_url in (
        f"{EP_ORIGIN}/search/player?name={quote(name)}",
        f"{EP_ORIGIN}/search/player?q={quote(name)}",
        f"{EP_ORIGIN}/search?q={quote(name)}",
    ):
        try:
            r = session.get(search_url, headers=HTML_HEADERS, allow_redirects=True, timeout=15)
            if not r.ok:
                continue
            links = extract_ep_links(r.text)
            if not links:
                continue
            links.sort(key=lambda x: profile_score(x, player), reverse=True)
            best = links[0]
            if profile_score(best, player) < 40:
                continue
            return best, r.text
        except requests.RequestException:
            continue
    return None, None


def extract_audio_urls_from_value(value, out: list[str]) -> None:
    if isinstance(value, dict):
        for v in value.values():
            extract_audio_urls_from_value(v, out)
        return
    if isinstance(value, list):
        for v in value:
            extract_audio_urls_from_value(v, out)
        return
    if not isinstance(value, str):
        return
    text = html.unescape(value.replace("\\/", "/"))
    for raw in re.findall(r'https://files\.eliteprospects\.com/[^"\'\\s<>]+\.mp3(?:\?[^"\'\\s<>]*)?', text, flags=re.I):
        if raw not in out:
            out.append(raw)


def ep_build_id(session: requests.Session) -> str | None:
    global _EP_BUILD_ID
    if _EP_BUILD_ID:
        return _EP_BUILD_ID
    try:
        r = session.get(f"{EP_ORIGIN}/leagues", headers=HTML_HEADERS, timeout=20)
        if not r.ok:
            return None
        m = re.search(r'"buildId"\s*:\s*"([^"]+)"', r.text)
        if m:
            _EP_BUILD_ID = m.group(1)
            return _EP_BUILD_ID
    except requests.RequestException:
        return None
    return None


def extract_profile_audio(profile_url: str, prefetched_html: str | None, session: requests.Session) -> list[str]:
    out: list[str] = []
    page = prefetched_html or ""
    if not page:
        try:
            r = session.get(profile_url, headers=HTML_HEADERS, allow_redirects=True, timeout=15)
            if r.ok:
                page = r.text
        except requests.RequestException:
            pass
    if page:
        extract_audio_urls_from_value(page, out)

    # EP detail pages are Next.js. The structured data route is more reliable than
    # rendered HTML and includes page properties that may be loaded client-side.
    m = re.search(r"/player/(\d+)/([^/?#]+)", profile_url)
    build = ep_build_id(session)
    if m and build:
        try:
            data_url = f"{EP_ORIGIN}/_next/data/{build}/player/{m.group(1)}/{m.group(2)}.json"
            r = session.get(
                data_url,
                headers={**HEADERS, "Accept": "application/json", "x-nextjs-data": "1"},
                timeout=20,
            )
            if r.ok:
                extract_audio_urls_from_value(r.json(), out)
        except (requests.RequestException, ValueError):
            pass
    return out


def find_ep_audio(player: dict, old: dict | None, session: requests.Session) -> tuple[str | None, str | None]:
    old = old or {}
    profile_url = str(old.get("eliteprospects_url") or "").strip() or None
    old_url = str(old.get("pronunciation_url") or "").strip()
    candidates: list[str] = []
    if old.get("pronunciation_source") == "eliteprospects_player_audio" and old_url:
        candidates.append(old_url)
    for slug in candidate_slugs(player["first_name"], player["last_name"]):
        candidates.append(f"{EP_BASE}/{slug}.mp3")
    for url in dict.fromkeys(candidates):
        if verified_url(url, session):
            if not profile_url:
                profile_url, _ = discover_ep_profile(player, session)
            return url, profile_url

    found_profile, _search_html = discover_ep_profile(player, session)
    if found_profile:
        profile_url = found_profile
        for url in extract_profile_audio(found_profile, None, session):
            if verified_url(url, session):
                return url, profile_url
    return None, profile_url


def row_base(player: dict, profile_url: str | None) -> dict:
    return {
        "player_id": player["player_id"],
        "first_name": player["first_name"],
        "last_name": player["last_name"],
        "full_name_en": player["full_name_en"],
        "team_tri": player["team_tri"],
        "position_code": player.get("position_code"),
        "sweater_number": player.get("sweater_number"),
        "shoots_catches": player.get("shoots_catches"),
        "birth_date": player.get("birth_date"),
        "birth_country": player.get("birth_country"),
        "height_cm": player.get("height_cm"),
        "weight_kg": player.get("weight_kg"),
        "eliteprospects_url": profile_url,
        "eliteprospects_search_url": f"{EP_ORIGIN}/search/player?name={quote(player['full_name_en'])}",
    }


def probe(
    player: dict,
    old_players: dict,
    nhl_audio: dict,
    audio_dir: Path,
) -> tuple[int, dict | None, dict]:
    pid = player["player_id"]
    sid = str(pid)
    old = old_players.get(sid) or {}
    session = requests.Session()
    local_file = audio_dir / f"{pid}.mp3"
    local_url = f"/player-audio/{pid}.mp3"

    ep_url, ep_profile = find_ep_audio(player, old, session)
    source = None
    remote_url = None
    if ep_url:
        source = "eliteprospects_player_audio"
        remote_url = ep_url
    else:
        fallback = nhl_audio.get(sid) or {}
        fallback_url = str(fallback.get("pronunciation_url") or "").strip()
        if fallback_url and verified_url(fallback_url, session):
            source = str(fallback.get("pronunciation_source") or "nhl.com_team_pronunciation_guide")
            remote_url = fallback_url

    # Preserve a previously downloaded exact clip if the source is temporarily unavailable.
    if not remote_url and local_file.is_file() and local_file.stat().st_size > 1000:
        old_remote = str(old.get("pronunciation_url") or "").strip() or None
        old_source = str(old.get("pronunciation_source") or "").strip() or "local_cached_pronunciation"
        row = {
            **row_base(player, ep_profile or old.get("eliteprospects_url")),
            "pronunciation_url": old_remote,
            "pronunciation_source": old_source,
            "audio_local_path": local_url,
            "audio_cached": True,
            "upstream_verified": False,
        }
        return pid, row, {"player": player, "reason": "upstream_temporarily_unavailable_local_preserved"}

    if not remote_url:
        miss = {**row_base(player, ep_profile or old.get("eliteprospects_url")), "reason": "no_verified_audio"}
        return pid, None, miss

    if not download_audio(remote_url, local_file, session):
        miss = {**row_base(player, ep_profile or old.get("eliteprospects_url")), "reason": "audio_download_failed", "candidate_url": remote_url}
        return pid, None, miss

    row = {
        **row_base(player, ep_profile or old.get("eliteprospects_url")),
        "pronunciation_url": remote_url,
        "pronunciation_source": source,
        "audio_local_path": local_url,
        "audio_cached": True,
        "upstream_verified": True,
    }
    return pid, row, {}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="state/center_player_pronunciations_eliteprospects.json")
    ap.add_argument("--audio-dir", default="cloudflare-worker/public/player-audio")
    ap.add_argument("--nhl-audio-cache", default="state/center_player_pronunciations_nhl.json")
    ap.add_argument("--workers", type=int, default=24)
    args = ap.parse_args()

    out = Path(args.out)
    audio_dir = Path(args.audio_dir)
    audio_dir.mkdir(parents=True, exist_ok=True)
    old_payload = load_json(out)
    old_players = old_payload.get("players") or {}
    nhl_payload = load_json(Path(args.nhl_audio_cache))
    nhl_audio = nhl_payload.get("players") or {}

    players = load_roster()
    mapped: dict[str, dict] = {}
    profiles: dict[str, dict] = {}
    misses: list[dict] = []
    with ThreadPoolExecutor(max_workers=max(2, min(args.workers, 32))) as ex:
        future_map = {
            ex.submit(probe, p, old_players, nhl_audio, audio_dir): p
            for p in players
        }
        done = 0
        for fut in as_completed(future_map):
            p = future_map[fut]
            try:
                pid, row, miss = fut.result()
            except Exception as exc:
                print(f"probe error {p['full_name_en']}: {exc}", flush=True)
                pid, row, miss = p["player_id"], None, {**row_base(p, None), "reason": "probe_exception"}
            if row:
                mapped[str(pid)] = row
                profiles[str(pid)] = row
            else:
                missing_row = miss or {**row_base(p, None), "reason": "unresolved"}
                missing_row = {**missing_row, "pronunciation_available": False, "audio_cached": False}
                profiles[str(pid)] = missing_row
                misses.append(missing_row)
            done += 1
            if done % 50 == 0 or done == len(players):
                ep_count = sum(1 for x in mapped.values() if x.get("pronunciation_source") == "eliteprospects_player_audio")
                print(json.dumps({"checked": done, "total": len(players), "audio": len(mapped), "eliteprospects": ep_count}), flush=True)

    ep_count = sum(1 for x in mapped.values() if x.get("pronunciation_source") == "eliteprospects_player_audio")
    nhl_count = len(mapped) - ep_count
    profile_count = sum(1 for x in profiles.values() if x.get("eliteprospects_url"))
    payload = {
        "source": "eliteprospects_player_audio_with_nhl_fallback",
        "source_pattern": f"{EP_BASE}/<normalized_player_name>.mp3",
        "matched": len(mapped),
        "eliteprospects_audio_matched": ep_count,
        "nhl_audio_fallback_matched": nhl_count,
        "eliteprospects_profiles_resolved": profile_count,
        "roster_players": len(players),
        "audio_storage": "/player-audio/<nhl_player_id>.mp3",
        "players": dict(sorted(mapped.items(), key=lambda kv: int(kv[0]))),
        "profiles": dict(sorted(profiles.items(), key=lambda kv: int(kv[0]))),
        "unresolved": sorted(misses, key=lambda x: (x.get("team_tri") or "", x.get("full_name_en") or "")),
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({
        "out": str(out),
        "matched": len(mapped),
        "eliteprospects_audio": ep_count,
        "nhl_fallback_audio": nhl_count,
        "profiles": profile_count,
        "roster_players": len(players),
        "unresolved": len(misses),
    }), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
