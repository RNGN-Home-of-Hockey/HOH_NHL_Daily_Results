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
_EP_BUILD_ID_CACHE: str | None = None


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


def discover_ep_profile(player: dict, session: requests.Session) -> tuple[str | None, dict | None]:
    """Resolve the canonical Elite Prospects profile through its public autocomplete API."""
    name = player["full_name_en"]
    birth_year = str(player.get("birth_date") or "")[:4]
    try:
        r = session.get(
            EP_AUTOCOMPLETE,
            params={"q": name},
            headers={**HEADERS, "Accept": "application/json", "Accept-Language": "en-US,en;q=0.8"},
            timeout=15,
        )
        if not r.ok:
            return None, None
        items = r.json()
    except (requests.RequestException, ValueError):
        return None, None
    if not isinstance(items, list):
        return None, None

    wanted_full = compact_token(name)
    wanted_first = compact_token(player["first_name"])
    wanted_last = compact_token(player["last_name"])
    ranked: list[tuple[int, dict]] = []
    for raw in items:
        if not isinstance(raw, dict):
            continue
        ep_id = str(raw.get("id") or "").strip()
        slug = str(raw.get("slug") or "").strip()
        fullname = str(raw.get("fullname") or "").strip()
        if not ep_id.isdigit() or not slug or not fullname:
            continue
        compact_full = compact_token(fullname)
        score = 0
        if compact_full == wanted_full:
            score += 140
        if wanted_first and wanted_first in compact_full:
            score += 25
        if wanted_last and wanted_last in compact_full:
            score += 55
        result_year = str(raw.get("age") or "").strip()
        if birth_year and result_year == birth_year:
            score += 35
        result_team = compact_token(raw.get("team") or "")
        if result_team and compact_token(player.get("team_tri") or "") in result_team:
            score += 3
        ranked.append((score, raw))
    if not ranked:
        return None, None
    ranked.sort(key=lambda x: x[0], reverse=True)
    score, best = ranked[0]
    if score < 100:
        return None, None
    ep_id = str(best["id"]).strip()
    slug = str(best["slug"]).strip()
    return f"{EP_ORIGIN}/player/{ep_id}/{slug}", best

def extract_audio_urls_from_value(value, out: list[str], hint: str = "") -> None:
    """Collect EP-hosted pronunciation MP3 URLs from HTML or nested Next.js JSON."""
    if isinstance(value, dict):
        for key, child in value.items():
            key_hint = str(key or "").lower()
            if isinstance(child, str) and ("audio" in key_hint or "pronun" in key_hint):
                raw = html.unescape(child.replace("\\/", "/")).strip()
                if ".mp3" in raw.lower():
                    if raw.startswith("https://"):
                        candidate = raw
                    elif raw.startswith("/"):
                        candidate = urljoin("https://files.eliteprospects.com", raw)
                    else:
                        candidate = f"{EP_BASE}/{raw.lstrip('/')}"
                    if candidate.startswith("https://files.eliteprospects.com/") and candidate not in out:
                        out.append(candidate)
            extract_audio_urls_from_value(child, out, key_hint)
        return
    if isinstance(value, (list, tuple)):
        for child in value:
            extract_audio_urls_from_value(child, out, hint)
        return
    if value is None:
        return
    text = html.unescape(str(value).replace("\\/", "/"))
    patterns = [
        r'https://files\.eliteprospects\.com/[^"\'<>\s]+\.mp3(?:\?[^"\'<>\s]*)?',
        r'(/[^"\'<>\s]*player_audio/[^"\'<>\s]+\.mp3(?:\?[^"\'<>\s]*)?)',
    ]
    for pattern in patterns:
        for raw in re.findall(pattern, text, flags=re.I):
            url = raw if raw.startswith("https://") else urljoin("https://files.eliteprospects.com", raw)
            if url not in out:
                out.append(url)
    if ("audio" in hint or "pronun" in hint) and re.fullmatch(r'[^/\\\s]+\.mp3(?:\?.*)?', text.strip(), flags=re.I):
        url = f"{EP_BASE}/{text.strip()}"
        if url not in out:
            out.append(url)

def pronunciation_debug_values(value, path: str = "", out: list | None = None) -> list:
    out = out if out is not None else []
    if len(out) >= 80:
        return out
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{path}.{key}" if path else str(key)
            key_l = str(key).lower()
            if ("pronun" in key_l or "audio" in key_l) and not isinstance(child, (dict, list, tuple)):
                out.append((child_path, str(child)[:500]))
            pronunciation_debug_values(child, child_path, out)
        return out
    if isinstance(value, (list, tuple)):
        for i, child in enumerate(value):
            pronunciation_debug_values(child, f"{path}[{i}]", out)
        return out
    text = str(value or "")
    if ("pronun" in text.lower() or ".mp3" in text.lower()) and len(out) < 80:
        out.append((path, text[:500]))
    return out


def ep_build_id(session: requests.Session) -> str | None:
    """Read the current Elite Prospects Next.js build id once per process."""
    global _EP_BUILD_ID_CACHE
    if _EP_BUILD_ID_CACHE:
        return _EP_BUILD_ID_CACHE
    try:
        r = session.get(f"{EP_ORIGIN}/leagues", headers=HTML_HEADERS, allow_redirects=True, timeout=20)
        if not r.ok:
            return None
        page = r.text
        m = re.search(r'<script[^>]+id=["\']__NEXT_DATA__["\'][^>]*>(.*?)</script>', page, flags=re.I | re.S)
        if m:
            try:
                data = json.loads(html.unescape(m.group(1)))
                build = str(data.get("buildId") or "").strip()
                if build:
                    _EP_BUILD_ID_CACHE = build
                    return build
            except ValueError:
                pass
        m = re.search(r'"buildId"\s*:\s*"([^"]+)"', page)
        if m:
            _EP_BUILD_ID_CACHE = m.group(1)
            return _EP_BUILD_ID_CACHE
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
                data = r.json()
                extract_audio_urls_from_value(data, out)
                if "/player/300591/" in profile_url:
                    print("EP_BOUCHARD_PRON_DEBUG", json.dumps(pronunciation_debug_values(data), ensure_ascii=False), flush=True)
        except (requests.RequestException, ValueError):
            pass
    if "/player/300591/" in profile_url and page:
        print("EP_BOUCHARD_HTML_DEBUG", json.dumps(pronunciation_debug_values(page), ensure_ascii=False), flush=True)
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

    found_profile, profile_meta = discover_ep_profile(player, session)
    if found_profile:
        profile_url = found_profile
        profile_audio: list[str] = []
        ep_slug = ascii_token(str((profile_meta or {}).get("slug") or ""))
        ep_name = str((profile_meta or {}).get("fullname") or "").strip()
        if ep_slug:
            profile_audio.append(f"{EP_BASE}/{ep_slug}.mp3")
        if ep_name:
            profile_audio.append(f"{EP_BASE}/{ascii_token(ep_name)}.mp3")
        for url in [*dict.fromkeys(profile_audio), *extract_profile_audio(found_profile, None, session)]:
            if verified_url(url, session):
                return url, profile_url
    return None, profile_url


def row_base(player: dict, profile_url: str | None) -> dict:
    ep_id = None
    ep_slug = None
    if profile_url:
        m = re.search(r"/player/(\d+)/([^/?#]+)", str(profile_url))
        if m:
            ep_id, ep_slug = m.group(1), m.group(2)
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
        "eliteprospects_id": ep_id,
        "eliteprospects_slug": ep_slug,
        "eliteprospects_search_url": f"{EP_AUTOCOMPLETE}?q={quote(player['full_name_en'])}",
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
    old_players = old_payload.get("profiles") or old_payload.get("players") or {}
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
