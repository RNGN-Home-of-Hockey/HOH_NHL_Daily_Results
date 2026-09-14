const NHL = "https://api-web.nhle.com/v1";
const TEAM_CODES = ["ANA","BOS","BUF","CGY","CAR","CHI","COL","CBJ","DAL","DET","EDM","FLA","LAK","MIN","MTL","NSH","NJD","NYI","NYR","OTT","PHI","PIT","SJS","SEA","STL","TBL","TOR","UTA","VAN","VGK","WSH","WPG"];
const DEFAULT_INTERVAL_MINUTES = 360;

export async function runCenterScheduleMaintenance(env,{now=null,force=false}={}) {
  if (!env.DB) return {ok:false,error:"missing_d1_binding"};
  const clock = now ? new Date(now) : new Date();
  if (!Number.isFinite(clock.getTime())) return {ok:false,error:"invalid_now"};
  const season = currentSeasonId(clock);
  const intervalMinutes = envInt(env.CENTER_SCHEDULE_SYNC_INTERVAL_MINUTES, DEFAULT_INTERVAL_MINUTES, 30, 1440);
  const metaKey = `center_schedule_sync:${season}`;

  const last = await env.DB.prepare(`SELECT meta_value,updated_at FROM data_core_meta WHERE meta_key=? LIMIT 1;`).bind(metaKey).first().catch(()=>null);
  if (!force && last?.updated_at) {
    const age = clock.getTime() - Date.parse(`${String(last.updated_at).replace(" ","T")}Z`);
    if (Number.isFinite(age) && age >= 0 && age < intervalMinutes*60*1000) {
      return {ok:true,skipped:true,reason:"fresh",season,interval_minutes:intervalMinutes,last_sync:last.updated_at};
    }
  }

  const payloads = await Promise.all(TEAM_CODES.map(async tri=>{
    try {
      const response = await fetch(`${NHL}/club-schedule-season/${tri}/${season}`,{headers:{Accept:"application/json","User-Agent":"HOH-NHL-Center/6"}});
      if (!response.ok) return {tri,games:[],error:`HTTP ${response.status}`};
      const data = await response.json();
      return {tri,games:Array.isArray(data?.games)?data.games:[],error:null};
    } catch (error) {
      return {tri,games:[],error:errorText(error)};
    }
  }));

  const unique = new Map();
  for (const payload of payloads) {
    for (const raw of payload.games) {
      const game = normalizeGame(raw,season);
      if (game) unique.set(game.game_pk,game);
    }
  }
  if (unique.size < 500) {
    return {ok:false,error:"schedule_source_incomplete",season,unique_games:unique.size,source_errors:payloads.filter(x=>x.error)};
  }

  const statements=[];
  for (const game of unique.values()) {
    statements.push(env.DB.prepare(`
      INSERT INTO games (game_pk,season_id,game_type,scheduled_start_utc,game_state,home_tri,away_tri,home_score,away_score,current_period,period_type,venue_name,last_synced_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(game_pk) DO UPDATE SET
        season_id=excluded.season_id,
        game_type=excluded.game_type,
        scheduled_start_utc=excluded.scheduled_start_utc,
        game_state=excluded.game_state,
        home_tri=excluded.home_tri,
        away_tri=excluded.away_tri,
        home_score=CASE WHEN excluded.home_score IS NULL THEN games.home_score ELSE excluded.home_score END,
        away_score=CASE WHEN excluded.away_score IS NULL THEN games.away_score ELSE excluded.away_score END,
        current_period=CASE WHEN excluded.current_period IS NULL THEN games.current_period ELSE excluded.current_period END,
        period_type=CASE WHEN excluded.period_type IS NULL THEN games.period_type ELSE excluded.period_type END,
        venue_name=COALESCE(excluded.venue_name,games.venue_name),
        last_synced_at=CURRENT_TIMESTAMP;
    `).bind(game.game_pk,game.season_id,game.game_type,game.scheduled_start_utc,game.game_state,game.home_tri,game.away_tri,game.home_score,game.away_score,game.current_period,game.period_type,game.venue_name));
  }

  let written=0;
  for (let index=0; index<statements.length; index+=75) {
    const chunk=statements.slice(index,index+75);
    if (!chunk.length) continue;
    await env.DB.batch(chunk);
    written+=chunk.length;
  }

  const summary={season,unique_games:unique.size,written,source_errors:payloads.filter(x=>x.error).map(x=>({team:x.tri,error:x.error})),synced_at:clock.toISOString()};
  await env.DB.prepare(`
    INSERT INTO data_core_meta (meta_key,meta_value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP;
  `).bind(metaKey,JSON.stringify(summary)).run();

  return {ok:true,skipped:false,interval_minutes:intervalMinutes,...summary};
}

function normalizeGame(raw,season){
  const id=Number(raw?.id),home=upper(raw?.homeTeam?.abbrev),away=upper(raw?.awayTeam?.abbrev),start=raw?.startTimeUTC||raw?.startTimeUtc;
  if(!Number.isSafeInteger(id)||id<=0||!home||!away||!start)return null;
  return {
    game_pk:id,
    season_id:String(raw?.season||season),
    game_type:integerOrNull(raw?.gameType),
    scheduled_start_utc:start,
    game_state:upper(raw?.gameState||"FUT"),
    home_tri:home,
    away_tri:away,
    home_score:numberOrNull(raw?.homeTeam?.score),
    away_score:numberOrNull(raw?.awayTeam?.score),
    current_period:integerOrNull(raw?.periodDescriptor?.number),
    period_type:raw?.periodDescriptor?.periodType||raw?.gameOutcome?.lastPeriodType||null,
    venue_name:localized(raw?.venue),
  };
}
function currentSeasonId(date){const y=date.getUTCFullYear(),m=date.getUTCMonth()+1,start=m>=7?y:y-1;return `${start}${start+1}`}
function localized(value){if(!value)return null;if(typeof value==="string")return value;return value.default||value.en||Object.values(value)[0]||null}
function upper(v){return String(v||"").trim().toUpperCase()}
function integerOrNull(v){const n=Number(v);return Number.isSafeInteger(n)?n:null}
function numberOrNull(v){if(v===null||v===undefined||v==="")return null;const n=Number(v);return Number.isFinite(n)?n:null}
function envInt(value,fallback,min,max){const n=Number(value);return Number.isSafeInteger(n)&&n>=min&&n<=max?n:fallback}
function errorText(error){return String(error?.message||error||"unknown_error")}
