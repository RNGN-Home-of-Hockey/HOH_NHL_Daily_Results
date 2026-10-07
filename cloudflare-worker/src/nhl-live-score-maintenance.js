import { fetchNhlJson } from "./data-core-importer.js";

const NHL_BASE="https://api-web.nhle.com/v1";
const META_KEY="nhl_live_score_sync_state";

export async function runNhlLiveScoreMaintenance(env,{fetchImpl=fetch,nowMs=Date.now()}={}){
  if(!env?.DB)return {ok:false,error:"missing_d1_binding"};
  let payload;
  try{
    payload=await fetchNhlJson(fetchImpl,`${NHL_BASE}/score/now`,{timeoutMs:10000,maxAttempts:2});
  }catch(error){
    const state={fetched_at:new Date(nowMs).toISOString(),ok:false,error:String(error?.message||error)};
    await saveState(env.DB,state).catch(()=>{});
    return state;
  }
  const games=(Array.isArray(payload?.games)?payload.games:[]).map(normalizeScoreGame).filter(Boolean);
  let written=0;
  for(let i=0;i<games.length;i+=50){
    const chunk=games.slice(i,i+50).map(g=>env.DB.prepare(`
      INSERT INTO games(game_pk,season_id,game_type,scheduled_start_utc,game_state,home_tri,away_tri,home_score,away_score,current_period,period_type,venue_name,last_synced_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(game_pk) DO UPDATE SET
        season_id=excluded.season_id,
        game_type=excluded.game_type,
        scheduled_start_utc=excluded.scheduled_start_utc,
        game_state=excluded.game_state,
        home_tri=excluded.home_tri,
        away_tri=excluded.away_tri,
        home_score=excluded.home_score,
        away_score=excluded.away_score,
        current_period=COALESCE(excluded.current_period,games.current_period),
        period_type=COALESCE(excluded.period_type,games.period_type),
        venue_name=COALESCE(excluded.venue_name,games.venue_name),
        last_synced_at=CURRENT_TIMESTAMP;
    `).bind(g.game_pk,g.season_id,g.game_type,g.scheduled_start_utc,g.game_state,g.home_tri,g.away_tri,g.home_score,g.away_score,g.current_period,g.period_type,g.venue_name));
    if(chunk.length){await env.DB.batch(chunk);written+=chunk.length}
  }
  const state={fetched_at:new Date(nowMs).toISOString(),ok:true,games_seen:games.length,games_written:written};
  await saveState(env.DB,state).catch(()=>{});
  return state;
}

export async function persistNhlLiveGame(db,game){
  if(!db||!game||!Number.isSafeInteger(Number(game.game_pk)))return {ok:false,error:"invalid_game"};
  const result=await db.prepare(`
    UPDATE games SET
      game_state=?,home_score=?,away_score=?,current_period=COALESCE(?,current_period),period_type=COALESCE(?,period_type),last_synced_at=CURRENT_TIMESTAMP
    WHERE game_pk=?;
  `).bind(
    String(game.game_state||"").toUpperCase()||"LIVE",
    finiteOrZero(game.home_score),finiteOrZero(game.away_score),
    intOrNull(game.period_number??game.current_period),game.period_type||null,Number(game.game_pk)
  ).run();
  return {ok:true,game_pk:Number(game.game_pk),updated:Number(result?.meta?.changes||0)};
}

function normalizeScoreGame(raw){
  const id=Number(raw?.id),home=String(raw?.homeTeam?.abbrev||"").toUpperCase(),away=String(raw?.awayTeam?.abbrev||"").toUpperCase();
  const start=String(raw?.startTimeUTC||"");
  if(!Number.isSafeInteger(id)||id<=0||!home||!away||!start)return null;
  return {
    game_pk:id,season_id:String(raw?.season||""),game_type:intOrNull(raw?.gameType)||2,scheduled_start_utc:start,
    game_state:String(raw?.gameState||"FUT").toUpperCase(),home_tri:home,away_tri:away,
    home_score:finiteOrZero(raw?.homeTeam?.score),away_score:finiteOrZero(raw?.awayTeam?.score),
    current_period:intOrNull(raw?.periodDescriptor?.number),period_type:raw?.periodDescriptor?.periodType||raw?.gameOutcome?.lastPeriodType||null,
    venue_name:localized(raw?.venue)
  };
}
async function saveState(db,value){await db.prepare(`INSERT INTO data_core_meta(meta_key,meta_value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP;`).bind(META_KEY,JSON.stringify(value)).run()}
function finiteOrZero(v){const n=Number(v);return Number.isFinite(n)?n:0}
function intOrNull(v){const n=Number(v);return Number.isSafeInteger(n)?n:null}
function localized(v){if(!v)return null;if(typeof v==="string")return v;return v.default||v.en||Object.values(v)[0]||null}

// Live Center diversity v3 release marker: normal push-triggered CI + production deploy.
