const NHL = "https://api-web.nhle.com/v1";
const TEAM_CODES = ["ANA","BOS","BUF","CGY","CAR","CHI","COL","CBJ","DAL","DET","EDM","FLA","LAK","MIN","MTL","NSH","NJD","NYI","NYR","OTT","PHI","PIT","SJS","SEA","STL","TBL","TOR","UTA","VAN","VGK","WSH","WPG"];
const DEFAULT_INTERVAL_MINUTES = 360;
const DEFAULT_ROSTER_INTERVAL_MINUTES = 1440;

export async function runCenterScheduleMaintenance(env,{now=null,force=false}={}) {
  if (!env.DB) return {ok:false,error:"missing_d1_binding"};
  const clock = now ? new Date(now) : new Date();
  if (!Number.isFinite(clock.getTime())) return {ok:false,error:"invalid_now"};
  const season = currentSeasonId(clock);

  const rosterResult=await refreshRostersIfDue(env,clock,force);
  if(rosterResult && rosterResult.ok===false)return rosterResult;

  const intervalMinutes = envInt(env.CENTER_SCHEDULE_SYNC_INTERVAL_MINUTES, DEFAULT_INTERVAL_MINUTES, 30, 1440);
  const metaKey = `center_schedule_sync:${season}:v2-preseason`;
  const last = await env.DB.prepare(`SELECT meta_value,updated_at FROM data_core_meta WHERE meta_key=? LIMIT 1;`).bind(metaKey).first().catch(()=>null);
  if (!force && fresh(last?.updated_at,clock,intervalMinutes)) {
    return {ok:true,maintenance:"schedule",skipped:true,reason:"fresh",season,interval_minutes:intervalMinutes,last_sync:last.updated_at,roster:rosterResult};
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
  for (const payload of payloads) for (const raw of payload.games) {
    const game = normalizeGame(raw,season);
    if (game) unique.set(game.game_pk,game);
  }

  // Club season feeds can omit preseason. Merge the official near-term league
  // schedule explicitly so gameType=1 appears in Data Core before the season.
  const nearTerm = await fetchNearTermLeagueSchedule(clock,season);
  for (const raw of nearTerm.games) {
    const game = normalizeGame(raw,season);
    if (game) unique.set(game.game_pk,game);
  }

  if (unique.size < 500) {
    return {ok:false,maintenance:"schedule",error:"schedule_source_incomplete",season,unique_games:unique.size,source_errors:payloads.filter(x=>x.error)};
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
  await writeMeta(env.DB,metaKey,JSON.stringify(summary));
  return {ok:true,maintenance:"schedule",skipped:false,interval_minutes:intervalMinutes,...summary,roster:rosterResult};
}

async function fetchNearTermLeagueSchedule(clock,season){
  const unique=new Map(),errors=[];
  // NHL schedule endpoint returns a week window. Three anchors cover the next
  // three weeks and include preseason + the first regular-season games.
  for(const dayOffset of [0,7,14]){
    const day=new Date(clock.getTime()+dayOffset*86400000).toISOString().slice(0,10);
    try{
      const response=await fetch(`${NHL}/schedule/${day}`,{headers:{Accept:"application/json","User-Agent":"HOH-NHL-Center/7"}});
      if(!response.ok){errors.push({day,error:`HTTP ${response.status}`});continue}
      const data=await response.json();
      for(const week of Array.isArray(data?.gameWeek)?data.gameWeek:[]){
        for(const raw of Array.isArray(week?.games)?week.games:[]){
          if(raw?.id)unique.set(Number(raw.id),raw);
        }
      }
    }catch(error){errors.push({day,error:errorText(error)})}
  }
  return {games:[...unique.values()],errors,season};
}

async function refreshRostersIfDue(env,clock,force){
  const interval=envInt(env.CENTER_ROSTER_SYNC_INTERVAL_MINUTES,DEFAULT_ROSTER_INTERVAL_MINUTES,360,10080);
  const key="center_roster_sync:all32";
  const last=await env.DB.prepare(`SELECT meta_value,updated_at FROM data_core_meta WHERE meta_key=? LIMIT 1;`).bind(key).first().catch(()=>null);
  if(!force&&fresh(last?.updated_at,clock,interval))return {ok:true,maintenance:"rosters",skipped:true,reason:"fresh",last_sync:last.updated_at,interval_minutes:interval};

  const payloads=await Promise.all(TEAM_CODES.map(async tri=>{
    try{
      const response=await fetch(`${NHL}/roster/${tri}/current`,{headers:{Accept:"application/json","User-Agent":"HOH-NHL-Center/6"}});
      if(!response.ok)return {tri,players:[],error:`HTTP ${response.status}`};
      const data=await response.json(),players=[];
      for(const [section,forced] of [["forwards",null],["defensemen","D"],["goalies","G"]]){
        for(const raw of data?.[section]||[]){const player=normalizePlayer(raw,tri,forced);if(player)players.push(player)}
      }
      return {tri,players,error:null};
    }catch(error){return {tri,players:[],error:errorText(error)}}
  }));

  const healthy=payloads.filter(x=>!x.error&&x.players.length>=15);
  if(healthy.length<28)return {ok:false,maintenance:"rosters",error:"roster_source_incomplete",teams_ok:healthy.length,source_errors:payloads.filter(x=>x.error||x.players.length<15).map(x=>({team:x.tri,error:x.error||"too_few_players",players:x.players.length}))};

  let written=0;
  for(const team of healthy){
    const statements=[env.DB.prepare(`UPDATE players SET active=0,updated_at=CURRENT_TIMESTAMP WHERE current_team_tri=?;`).bind(team.tri)];
    for(const p of team.players) statements.push(env.DB.prepare(`
      INSERT INTO players (player_id,first_name_en,last_name_en,full_name_en,current_team_tri,position_code,sweater_number,shoots_catches,active,updated_at)
      VALUES (?,?,?,?,?,?,?,?,1,CURRENT_TIMESTAMP)
      ON CONFLICT(player_id) DO UPDATE SET
        first_name_en=excluded.first_name_en,last_name_en=excluded.last_name_en,full_name_en=excluded.full_name_en,
        current_team_tri=excluded.current_team_tri,position_code=excluded.position_code,sweater_number=excluded.sweater_number,
        shoots_catches=excluded.shoots_catches,active=1,updated_at=CURRENT_TIMESTAMP;
    `).bind(p.player_id,p.first_name_en,p.last_name_en,p.full_name_en,p.current_team_tri,p.position_code,p.sweater_number,p.shoots_catches));
    for(let i=0;i<statements.length;i+=75)await env.DB.batch(statements.slice(i,i+75));
    written+=team.players.length;
  }
  const summary={teams_ok:healthy.length,players_written:written,source_errors:payloads.filter(x=>x.error).map(x=>({team:x.tri,error:x.error})),synced_at:clock.toISOString()};
  await writeMeta(env.DB,key,JSON.stringify(summary));
  return {ok:true,maintenance:"rosters",skipped:false,interval_minutes:interval,...summary};
}

function normalizePlayer(p,tri,forced){const id=Number(p?.id),first=localized(p?.firstName),last=localized(p?.lastName);if(!Number.isSafeInteger(id)||id<=0||(!first&&!last))return null;let pos=forced||upper(p?.positionCode||p?.position);return {player_id:id,first_name_en:first||null,last_name_en:last||null,full_name_en:[first,last].filter(Boolean).join(" "),current_team_tri:tri,position_code:pos||null,sweater_number:integerOrNull(p?.sweaterNumber),shoots_catches:String(p?.shootsCatches||"").trim()||null}}
function normalizeGame(raw,season){
  const id=Number(raw?.id),home=upper(raw?.homeTeam?.abbrev),away=upper(raw?.awayTeam?.abbrev),start=raw?.startTimeUTC||raw?.startTimeUtc;
  if(!Number.isSafeInteger(id)||id<=0||!home||!away||!start)return null;
  return {game_pk:id,season_id:String(raw?.season||season),game_type:integerOrNull(raw?.gameType),scheduled_start_utc:start,game_state:upper(raw?.gameState||"FUT"),home_tri:home,away_tri:away,home_score:numberOrZero(raw?.homeTeam?.score),away_score:numberOrZero(raw?.awayTeam?.score),current_period:integerOrNull(raw?.periodDescriptor?.number),period_type:raw?.periodDescriptor?.periodType||raw?.gameOutcome?.lastPeriodType||null,venue_name:localized(raw?.venue)};
}
async function writeMeta(db,key,value){await db.prepare(`INSERT INTO data_core_meta (meta_key,meta_value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP;`).bind(key,value).run()}
function fresh(updatedAt,clock,minutes){if(!updatedAt)return false;const age=clock.getTime()-Date.parse(`${String(updatedAt).replace(" ","T")}Z`);return Number.isFinite(age)&&age>=0&&age<minutes*60*1000}
function currentSeasonId(date){const y=date.getUTCFullYear(),m=date.getUTCMonth()+1,start=m>=7?y:y-1;return `${start}${start+1}`}
function localized(value){if(!value)return null;if(typeof value==="string")return value;return value.default||value.en||Object.values(value)[0]||null}
function upper(v){return String(v||"").trim().toUpperCase()}
function integerOrNull(v){const n=Number(v);return Number.isSafeInteger(n)?n:null}
function numberOrNull(v){if(v===null||v===undefined||v==="")return null;const n=Number(v);return Number.isFinite(n)?n:null}
function numberOrZero(v){const n=Number(v);return Number.isFinite(n)?n:0}
function envInt(value,fallback,min,max){const n=Number(value);return Number.isSafeInteger(n)&&n>=min&&n<=max?n:fallback}
function errorText(error){return String(error?.message||error||"unknown_error")}
