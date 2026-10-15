// Power play and penalty kill of every NHL team in the season, for the live «БОЛЬШИНСТВО» broadcast card.
// Source: the NHL stats API team summary (one request for all 32 teams). Our own tables keep power-play goals but
// not the opportunities, so the percentage comes from the NHL. Kept in data_core_meta and refreshed at most every
// 6 hours; if the NHL does not answer, the last saved numbers are used.

const META_KEY = "nhl_special_teams_v1";
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const SUMMARY_URL = "https://api.nhle.com/stats/rest/en/team/summary";

export async function loadSpecialTeams(db, { seasonId, fetchImpl = fetch, nowMs = Date.now(), timeoutMs = 6000 } = {}) {
  const season = String(seasonId || "").trim();
  if (!db || !/^\d{8}$/.test(season)) return null;
  const cached = await readCache(db);
  if (cached && cached.season === season && nowMs - Date.parse(cached.fetched_at) < MAX_AGE_MS) return cached.teams;
  try {
    const teams = await fetchSpecialTeams(db, season, fetchImpl, timeoutMs);
    if (teams && Object.keys(teams).length >= 16) {
      await writeCache(db, { season, fetched_at: new Date(nowMs).toISOString(), teams });
      return teams;
    }
  } catch (error) {
    console.error("NHL special teams refresh failed", error);
  }
  return cached && cached.season === season ? cached.teams : null;
}

// { TRI: { gp, pp, pk, pp_rank, pk_rank } }, pp/pk as shares (0.234), ranks 1..32 (1 = best)
export function specialTeamsFromSummary(rows, triById) {
  const out = {};
  for (const row of rows || []) {
    const tri = triById.get(Number(row?.teamId));
    const gp = Number(row?.gamesPlayed), pp = Number(row?.powerPlayPct), pk = Number(row?.penaltyKillPct);
    if (!tri || !Number.isFinite(gp) || gp <= 0 || !Number.isFinite(pp) || !Number.isFinite(pk)) continue;
    out[tri] = { gp, pp, pk };
  }
  const rank = (key) => {
    const list = Object.entries(out).sort((a, b) => b[1][key] - a[1][key]);
    list.forEach(([tri], i) => { out[tri][`${key}_rank`] = i + 1; });
  };
  rank("pp");
  rank("pk");
  return out;
}

async function fetchSpecialTeams(db, season, fetchImpl, timeoutMs) {
  const ids = await db.prepare("SELECT tri_code,nhl_team_id FROM teams WHERE nhl_team_id IS NOT NULL;").all();
  const triById = new Map((ids.results || []).map((r) => [Number(r.nhl_team_id), String(r.tri_code).toUpperCase()]));
  const url = `${SUMMARY_URL}?isAggregate=false&isGame=false&cayenneExp=${encodeURIComponent(`gameTypeId=2 and seasonId=${season}`)}`;
  const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`NHL stats HTTP ${response.status}`);
  const payload = await response.json();
  return specialTeamsFromSummary(payload?.data, triById);
}

async function readCache(db) {
  try {
    const row = await db.prepare("SELECT meta_value FROM data_core_meta WHERE meta_key=? LIMIT 1;").bind(META_KEY).first();
    const value = row?.meta_value ? JSON.parse(row.meta_value) : null;
    return value && value.teams && Number.isFinite(Date.parse(value.fetched_at)) ? value : null;
  } catch {
    return null;
  }
}

async function writeCache(db, value) {
  try {
    await db.prepare("INSERT INTO data_core_meta(meta_key,meta_value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP;").bind(META_KEY, JSON.stringify(value)).run();
  } catch (error) {
    console.error("NHL special teams cache write failed", error);
  }
}
