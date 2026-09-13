const API = "/api/telegram-center-admin";
const NHL = "https://api-web.nhle.com/v1";

const TEAM_CODES = ["ANA","BOS","BUF","CGY","CAR","CHI","COL","CBJ","DAL","DET","EDM","FLA","LAK","MIN","MTL","NSH","NJD","NYI","NYR","OTT","PHI","PIT","SJS","SEA","STL","TBL","TOR","UTA","VAN","VGK","WSH","WPG"];

export async function handleTelegramCenterCatalogAdmin(request, env, path) {
  if (!path.startsWith(API)) return null;
  if (!env.DB) return json({ok:false,error:"missing_d1_binding"},503);

  if (path === `${API}/schedule/status` && request.method === "GET") return scheduleStatus(request,env);
  if (path === `${API}/schedule/sync` && request.method === "POST") {
    if (!(await authorized(request,env))) return json({ok:false,error:"unauthorized"},401);
    return scheduleSync(request,env);
  }
  if (path === `${API}/player-meta/import` && request.method === "POST") {
    if (!(await authorized(request,env))) return json({ok:false,error:"unauthorized"},401);
    return playerMetaImport(request,env);
  }
  if (path === `${API}/groups/rebuild` && request.method === "POST") {
    if (!(await authorized(request,env))) return json({ok:false,error:"unauthorized"},401);
    return rebuildGroups(env);
  }
  return json({ok:false,error:"not_found"},404);
}

async function scheduleStatus(request,env){
  const season=String(new URL(request.url).searchParams.get("season")||"").replace(/\D/g,"");
  try{
    const rows=season?await env.DB.prepare(`SELECT game_type,COUNT(*) count,MIN(scheduled_start_utc) first_game,MAX(scheduled_start_utc) last_game FROM games WHERE season_id=? GROUP BY game_type ORDER BY game_type;`).bind(season).all():await env.DB.prepare(`SELECT season_id,game_type,COUNT(*) count,MIN(scheduled_start_utc) first_game,MAX(scheduled_start_utc) last_game FROM games GROUP BY season_id,game_type ORDER BY CAST(season_id AS INTEGER) DESC,game_type;`).all();
    return json({ok:true,season:season||null,rows:rows.results||[]});
  }catch(error){return json({ok:false,error:"schedule_status_failed",detail:errorText(error)},503)}
}

async function scheduleSync(request,env){
  let body={};try{body=await request.json()}catch{}
  const season=normalizeSeason(body.season||new URL(request.url).searchParams.get("season"));
  if(!season)return json({ok:false,error:"invalid_season"},400);
  const codes=Array.isArray(body.teams)&&body.teams.length?body.teams.map(x=>String(x).toUpperCase()).filter(x=>TEAM_CODES.includes(x)):TEAM_CODES;
  try{
    const payloads=await Promise.all(codes.map(async tri=>{
      try{const r=await fetch(`${NHL}/club-schedule-season/${tri}/${season}`,{headers:{Accept:"application/json"}});if(!r.ok)return {tri,games:[],error:`HTTP ${r.status}`};const d=await r.json();return {tri,games:d?.games||[],error:null}}catch(error){return {tri,games:[],error:errorText(error)}}
    }));
    const unique=new Map();
    for(const p of payloads)for(const g of p.games||[]){const n=normalizeScheduleGame(g,season);if(n)unique.set(n.game_pk,n)}
    const statements=[];
    for(const g of unique.values()) statements.push(env.DB.prepare(`
      INSERT INTO games (game_pk,season_id,game_type,scheduled_start_utc,game_state,home_tri,away_tri,home_score,away_score,current_period,period_type,venue_name,last_synced_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(game_pk) DO UPDATE SET season_id=excluded.season_id,game_type=excluded.game_type,scheduled_start_utc=excluded.scheduled_start_utc,game_state=excluded.game_state,home_tri=excluded.home_tri,away_tri=excluded.away_tri,home_score=excluded.home_score,away_score=excluded.away_score,current_period=excluded.current_period,period_type=excluded.period_type,venue_name=excluded.venue_name,last_synced_at=CURRENT_TIMESTAMP;
    `).bind(g.game_pk,g.season_id,g.game_type,g.scheduled_start_utc,g.game_state,g.home_tri,g.away_tri,g.home_score,g.away_score,g.current_period,g.period_type,g.venue_name));
    let written=0;for(let i=0;i<statements.length;i+=75){const chunk=statements.slice(i,i+75);if(chunk.length){await env.DB.batch(chunk);written+=chunk.length}}
    return json({ok:true,season,teams_requested:codes.length,unique_games:unique.size,written,source_errors:payloads.filter(x=>x.error).map(x=>({team:x.tri,error:x.error}))});
  }catch(error){console.error("center schedule sync failed",season,error);return json({ok:false,error:"schedule_sync_failed",detail:errorText(error)},503)}
}

async function playerMetaImport(request,env){
  let body;try{body=await request.json()}catch{return json({ok:false,error:"invalid_json"},400)}
  const rows=Array.isArray(body)?body:Array.isArray(body?.players)?body.players:[];
  if(!rows.length||rows.length>1000)return json({ok:false,error:"players_array_required_or_too_large"},400);
  const statements=[];let accepted=0;
  for(const raw of rows){const id=Number(raw.player_id);if(!Number.isSafeInteger(id)||id<=0)continue;const countries=Array.isArray(raw.countries)?raw.countries.map(x=>String(x).toUpperCase()).filter(Boolean):[];const primary=String(raw.primary_country_code||countries[0]||"").toUpperCase()||null;statements.push(env.DB.prepare(`
    INSERT INTO player_profile_meta (player_id,full_name_ru,sports_ru_url,eliteprospects_url,pronunciation_url,pronunciation_source,primary_country_code,countries_json,source_updated_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(player_id) DO UPDATE SET full_name_ru=COALESCE(excluded.full_name_ru,player_profile_meta.full_name_ru),sports_ru_url=COALESCE(excluded.sports_ru_url,player_profile_meta.sports_ru_url),eliteprospects_url=COALESCE(excluded.eliteprospects_url,player_profile_meta.eliteprospects_url),pronunciation_url=COALESCE(excluded.pronunciation_url,player_profile_meta.pronunciation_url),pronunciation_source=COALESCE(excluded.pronunciation_source,player_profile_meta.pronunciation_source),primary_country_code=COALESCE(excluded.primary_country_code,player_profile_meta.primary_country_code),countries_json=CASE WHEN excluded.countries_json='[]' THEN player_profile_meta.countries_json ELSE excluded.countries_json END,source_updated_at=COALESCE(excluded.source_updated_at,player_profile_meta.source_updated_at),updated_at=CURRENT_TIMESTAMP;
  `).bind(id,nullable(raw.full_name_ru),nullable(raw.sports_ru_url),nullable(raw.eliteprospects_url),nullable(raw.pronunciation_url),nullable(raw.pronunciation_source),primary,JSON.stringify(countries),nullable(raw.source_updated_at)));accepted++}
  for(let i=0;i<statements.length;i+=75)await env.DB.batch(statements.slice(i,i+75));
  await env.DB.prepare(`UPDATE players SET full_name_ru=(SELECT m.full_name_ru FROM player_profile_meta m WHERE m.player_id=players.player_id) WHERE EXISTS (SELECT 1 FROM player_profile_meta m WHERE m.player_id=players.player_id AND m.full_name_ru IS NOT NULL);`).run();
  return json({ok:true,received:rows.length,accepted});
}

async function rebuildGroups(env){
  try{
    await env.DB.prepare(`DELETE FROM subscription_group_members WHERE group_key='RUS_NHL';`).run();
    const players=await env.DB.prepare(`SELECT p.player_id FROM players p JOIN player_profile_meta m ON m.player_id=p.player_id WHERE p.active=1 AND (m.primary_country_code='RUS' OR m.countries_json LIKE '%RUS%') ORDER BY p.player_id;`).all();
    const statements=(players.results||[]).map((p,i)=>env.DB.prepare(`INSERT OR REPLACE INTO subscription_group_members (group_key,subject_type,subject_key,sort_order) VALUES ('RUS_NHL','player',?,?);`).bind(String(p.player_id),i+1));
    for(let i=0;i<statements.length;i+=75)await env.DB.batch(statements.slice(i,i+75));
    return json({ok:true,group_key:"RUS_NHL",members:statements.length});
  }catch(error){return json({ok:false,error:"group_rebuild_failed",detail:errorText(error)},503)}
}

function normalizeScheduleGame(g,season){const id=Number(g?.id);const home=String(g?.homeTeam?.abbrev||"").toUpperCase(),away=String(g?.awayTeam?.abbrev||"").toUpperCase(),start=g?.startTimeUTC||g?.startTimeUtc;if(!Number.isSafeInteger(id)||!home||!away||!start)return null;return {game_pk:id,season_id:String(g?.season||season),game_type:Number(g?.gameType)||null,scheduled_start_utc:start,game_state:String(g?.gameState||"FUT").toUpperCase(),home_tri:home,away_tri:away,home_score:Number(g?.homeTeam?.score)||0,away_score:Number(g?.awayTeam?.score)||0,current_period:Number(g?.periodDescriptor?.number)||null,period_type:g?.periodDescriptor?.periodType||null,venue_name:g?.venue?.default||g?.venue||null}}
async function authorized(request,env){const expected=String(env.MANAGEMENT_API_SECRET||"").trim(),auth=String(request.headers.get("authorization")||"").trim(),m=/^Bearer\s+(.+)$/i.exec(auth);return Boolean(expected&&m&&await secureEq(m[1],expected))}
async function secureEq(a,b){const e=new TextEncoder(),[x,y]=await Promise.all([crypto.subtle.digest("SHA-256",e.encode(String(a))),crypto.subtle.digest("SHA-256",e.encode(String(b)))]),aa=new Uint8Array(x),bb=new Uint8Array(y);let d=aa.length^bb.length;for(let i=0;i<Math.min(aa.length,bb.length);i++)d|=aa[i]^bb[i];return d===0}
function normalizeSeason(v){const s=String(v||"").replace(/\D/g,"");return /^20\d{6}$/.test(s)?s:null}
function nullable(v){const s=String(v??"").trim();return s||null}
function errorText(e){return String(e?.message||e||"unknown_error")}
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}})}
