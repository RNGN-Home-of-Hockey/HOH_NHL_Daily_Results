const SCRIPT_PATH = "/telegram-app/profiles-v2.js";
const API = "/api/telegram-center-v2";
const NHL = "https://api-web.nhle.com/v1";

export async function handleTelegramCenterProfilesV2(request, env, path) {
  if (path === SCRIPT_PATH) {
    if (request.method !== "GET") return json({ok:false,error:"method_not_allowed"},405);
    return new Response(PROFILE_JS,{headers:{"Content-Type":"application/javascript; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
  }
  if (!path.startsWith(API)) return null;
  if (!env.DB) return json({ok:false,error:"missing_d1_binding"},503);

  if (path === `${API}/teams` && request.method === "GET") return listTeams(env);
  if (path === `${API}/players` && request.method === "GET") return listPlayers(request,env);
  if (path === `${API}/subscriptions` && request.method === "GET") return listSubscriptions(request,env);
  if (path === `${API}/subscriptions` && request.method === "POST") return createSubscription(request,env);

  const deleteSub = new RegExp(`^${API}/subscriptions/(\\d+)$`).exec(path);
  if (deleteSub && request.method === "DELETE") return deleteSubscription(request,env,Number(deleteSub[1]));

  const team = new RegExp(`^${API}/teams/([A-Za-z]{3})$`).exec(path);
  if (team && request.method === "GET") return teamProfile(request,env,team[1].toUpperCase());

  const player = new RegExp(`^${API}/players/(\\d+)$`).exec(path);
  if (player && request.method === "GET") return playerProfile(request,env,Number(player[1]));

  return json({ok:false,error:"not_found"},404);
}

async function listTeams(env) {
  try {
    const rows = await env.DB.prepare(`
      SELECT tri_code,name_en,name_ru,logo_url
      FROM teams WHERE COALESCE(active,1)=1
      ORDER BY COALESCE(name_ru,name_en),tri_code;
    `).all();
    return json({ok:true,teams:(rows.results||[]).map(t=>({...t,logo:teamLogo(t)}))});
  } catch (error) {
    console.error("center v2 team list failed",error);
    return json({ok:false,error:"team_list_failed",teams:[]},503);
  }
}

async function listPlayers(request,env) {
  const url=new URL(request.url);
  const team=String(url.searchParams.get("team")||"").trim().toUpperCase();
  const q=String(url.searchParams.get("q")||"").trim();
  const limit=clampInt(url.searchParams.get("limit"),60,1,100);
  try {
    const rows=await env.DB.prepare(`
      SELECT player_id,full_name_en,full_name_ru,current_team_tri,position_code,sweater_number
      FROM players
      WHERE COALESCE(active,1)=1
        AND (?='' OR current_team_tri=?)
        AND (?='' OR full_name_en LIKE '%'||?||'%' OR COALESCE(full_name_ru,'') LIKE '%'||?||'%')
      ORDER BY COALESCE(full_name_ru,full_name_en),player_id
      LIMIT ?;
    `).bind(team,team,q,q,q,limit).all();
    const season=currentSeasonId();
    return json({ok:true,team:team||null,season,players:(rows.results||[]).map(p=>({...p,photo:playerPhoto(p,season)}))});
  } catch (error) {
    console.error("center v2 player list failed",error);
    return json({ok:false,error:"player_list_failed",players:[]},503);
  }
}

async function teamProfile(request,env,tri) {
  try {
    const team=await env.DB.prepare(`SELECT tri_code,name_en,name_ru,logo_url FROM teams WHERE tri_code=? LIMIT 1;`).bind(tri).first();
    if(!team)return json({ok:false,error:"team_not_found"},404);
    const now=new Date().toISOString();
    const [recentR,rosterR,nextDb,subscription,standings] = await Promise.all([
      env.DB.prepare(`
        SELECT g.game_pk,g.scheduled_start_utc,g.home_tri,g.away_tri,g.home_score,g.away_score,
               CASE WHEN g.home_tri=? THEN g.home_score ELSE g.away_score END AS team_goals,
               CASE WHEN g.home_tri=? THEN g.away_score ELSE g.home_score END AS opp_goals
        FROM games g
        WHERE (g.home_tri=? OR g.away_tri=?) AND UPPER(COALESCE(g.game_state,'')) IN ('FINAL','OFF')
        ORDER BY g.scheduled_start_utc DESC,g.game_pk DESC LIMIT 10;
      `).bind(tri,tri,tri,tri).all(),
      env.DB.prepare(`
        SELECT player_id,full_name_en,full_name_ru,current_team_tri,position_code,sweater_number
        FROM players WHERE current_team_tri=? AND COALESCE(active,1)=1
        ORDER BY CASE position_code WHEN 'C' THEN 1 WHEN 'L' THEN 2 WHEN 'R' THEN 3 WHEN 'D' THEN 4 WHEN 'G' THEN 5 ELSE 6 END,
                 COALESCE(full_name_ru,full_name_en);
      `).bind(tri).all(),
      env.DB.prepare(`
        SELECT game_pk,scheduled_start_utc,home_tri,away_tri,game_state
        FROM games
        WHERE (home_tri=? OR away_tri=?) AND scheduled_start_utc>=?
          AND UPPER(COALESCE(game_state,'')) NOT IN ('FINAL','OFF')
        ORDER BY scheduled_start_utc ASC,game_pk ASC LIMIT 1;
      `).bind(tri,tri,now).first().catch(()=>null),
      currentSubscription(request,env,"team",tri),
      loadNhlStandings(tri),
    ]);
    const recent=recentR.results||[];
    const next=nextDb||await loadNhlNextGame(tri);
    const marketPack=await loadWinlineMarkets(env.DB,next?.game_pk||next?.id||null,"team",[tri]);
    const trends=buildTeamTrends(recent,marketPack.markets);
    const season=currentSeasonId();
    const roster=(rosterR.results||[]).map(p=>({...p,photo:playerPhoto(p,season)}));
    return json({
      ok:true,
      team:{...team,logo:teamLogo(team)},
      standings,
      next_game:normalizeGame(next,tri),
      recent,
      trends,
      markets:marketPack.markets,
      winline_event:marketPack.event,
      roster,
      subscription,
      updated_at:new Date().toISOString(),
    });
  } catch (error) {
    console.error("center v2 team profile failed",tri,error);
    return json({ok:false,error:"team_profile_failed"},503);
  }
}

async function playerProfile(request,env,playerId) {
  if(!Number.isSafeInteger(playerId)||playerId<=0)return json({ok:false,error:"invalid_player_id"},400);
  try {
    const player=await env.DB.prepare(`
      SELECT player_id,full_name_en,full_name_ru,current_team_tri,position_code,sweater_number,shoots_catches
      FROM players WHERE player_id=? LIMIT 1;
    `).bind(playerId).first();
    if(!player)return json({ok:false,error:"player_not_found"},404);
    const now=new Date().toISOString();
    const [landing,recentR,nextDb,subscription]=await Promise.all([
      fetchNhl(`${NHL}/player/${playerId}/landing`).catch(()=>null),
      env.DB.prepare(`
        SELECT s.game_pk,s.goals,s.assists,s.points,s.shots,s.hits,s.blocked_shots,s.plus_minus,
               g.scheduled_start_utc,g.home_tri,g.away_tri,g.home_score,g.away_score
        FROM player_game_stats s JOIN games g ON g.game_pk=s.game_pk
        WHERE s.player_id=? AND UPPER(COALESCE(g.game_state,'')) IN ('FINAL','OFF')
        ORDER BY g.scheduled_start_utc DESC,g.game_pk DESC LIMIT 8;
      `).bind(playerId).all().catch(()=>({results:[]})),
      env.DB.prepare(`
        SELECT game_pk,scheduled_start_utc,home_tri,away_tri,game_state
        FROM games
        WHERE (home_tri=? OR away_tri=?) AND scheduled_start_utc>=?
          AND UPPER(COALESCE(game_state,'')) NOT IN ('FINAL','OFF')
        ORDER BY scheduled_start_utc ASC,game_pk ASC LIMIT 1;
      `).bind(player.current_team_tri,player.current_team_tri,now).first().catch(()=>null),
      currentSubscription(request,env,"player",String(playerId)),
    ]);
    const next=nextDb||await loadNhlNextGame(player.current_team_tri);
    const subjectKeys=[String(playerId),player.full_name_en,player.full_name_ru].filter(Boolean);
    const marketPack=await loadWinlineMarkets(env.DB,next?.game_pk||next?.id||null,"player",subjectKeys);
    const nhl=normalizePlayerLanding(landing,player);
    return json({
      ok:true,
      player:{...player,photo:nhl.photo||playerPhoto(player,currentSeasonId()),team_logo:nhl.team_logo||teamLogo({tri_code:player.current_team_tri})},
      season_stats:nhl.stats,
      bio:nhl.bio,
      next_game:normalizeGame(next,player.current_team_tri),
      recent:recentR.results||[],
      markets:marketPack.markets,
      winline_event:marketPack.event,
      subscription,
      updated_at:new Date().toISOString(),
    });
  } catch (error) {
    console.error("center v2 player profile failed",playerId,error);
    return json({ok:false,error:"player_profile_failed"},503);
  }
}

async function loadNhlStandings(tri) {
  try {
    const payload=await fetchNhl(`${NHL}/standings/now`);
    const row=(payload?.standings||[]).find(r=>upper(r?.teamAbbrev?.default||r?.teamAbbrev)===tri);
    if(!row)return null;
    return {
      season_id:row.seasonId||null,
      games_played:numOrNull(row.gamesPlayed),wins:numOrNull(row.wins),losses:numOrNull(row.losses),ot_losses:numOrNull(row.otLosses),points:numOrNull(row.points),
      goals_for:numOrNull(row.goalFor),goals_against:numOrNull(row.goalAgainst),goal_diff:numOrNull(row.goalDifferential),
      league_sequence:numOrNull(row.leagueSequence),division_sequence:numOrNull(row.divisionSequence),conference_sequence:numOrNull(row.conferenceSequence),
    };
  } catch { return null; }
}

async function loadNhlNextGame(tri) {
  if(!tri)return null;
  try {
    const payload=await fetchNhl(`${NHL}/club-schedule-season/${tri}/${currentSeasonId()}`);
    const now=Date.now()-60*60*1000;
    const games=(payload?.games||[]).filter(g=>Date.parse(g.startTimeUTC||g.startTimeUtc||"")>=now && !["FINAL","OFF"].includes(upper(g.gameState))).sort((a,b)=>Date.parse(a.startTimeUTC)-Date.parse(b.startTimeUTC));
    const g=games[0]; if(!g)return null;
    return {game_pk:g.id,game_state:g.gameState,scheduled_start_utc:g.startTimeUTC,home_tri:upper(g.homeTeam?.abbrev),away_tri:upper(g.awayTeam?.abbrev)};
  } catch { return null; }
}

async function loadWinlineMarkets(db,gamePk,subjectType,subjectKeys) {
  if(!gamePk)return {event:null,markets:[]};
  try {
    const event=await db.prepare(`SELECT winline_event_id,game_pk,status,starts_at,deeplink,updated_at FROM winline_events WHERE game_pk=? LIMIT 1;`).bind(Number(gamePk)).first();
    if(!event)return {event:null,markets:[]};
    const rows=await db.prepare(`
      SELECT winline_market_id,market_type,subject_type,subject_key,outcome_name,odds,deeplink,is_live,active,updated_at
      FROM winline_markets WHERE winline_event_id=? AND active=1 AND odds IS NOT NULL
      ORDER BY is_live DESC,updated_at DESC,winline_market_id ASC LIMIT 80;
    `).bind(event.winline_event_id).all();
    const keys=new Set((subjectKeys||[]).map(v=>String(v).trim().toUpperCase()));
    let markets=rows.results||[];
    if(subjectType==="player"){
      markets=markets.filter(m=>String(m.subject_type||"").toLowerCase()==="player" && keys.has(String(m.subject_key||"").trim().toUpperCase()));
    }else if(subjectType==="team"){
      markets=markets.filter(m=>{
        const type=String(m.subject_type||"").toLowerCase();
        const key=String(m.subject_key||"").trim().toUpperCase();
        return !type||type==="game"||(type==="team"&&keys.has(key));
      });
    }
    return {event,markets:markets.slice(0,30)};
  } catch (error) {
    console.log("center v2 winline unavailable",{gamePk,error:String(error?.message||error)});
    return {event:null,markets:[]};
  }
}

function buildTeamTrends(recent,markets) {
  const rows=(recent||[]).slice(0,10); if(!rows.length)return [];
  const n=rows.length;
  const metrics=[
    {code:"under65",count:rows.filter(g=>Number(g.team_goals||0)+Number(g.opp_goals||0)<=6).length,text:c=>`${c} из ${n} последних матчей — тотал меньше 6.5`,terms:["total","under","6.5"]},
    {code:"win",count:rows.filter(g=>Number(g.team_goals)>Number(g.opp_goals)).length,text:c=>`${c} из ${n} последних матчей команда выиграла`,terms:["moneyline","win"]},
    {code:"team2",count:rows.filter(g=>Number(g.team_goals)>=2).length,text:c=>`${c} из ${n} последних матчей команда забила минимум 2 гола`,terms:["team","total","over","1.5"]},
    {code:"oppUnder35",count:rows.filter(g=>Number(g.opp_goals)<=3).length,text:c=>`${c} из ${n} последних матчей соперник забил не больше 3 голов`,terms:["team","total","under","3.5"]},
  ];
  return metrics.filter(x=>x.count>=Math.max(5,Math.ceil(n*.7))).sort((a,b)=>b.count-a.count).slice(0,4).map(x=>{
    const offered=findMarket(markets,x.terms);
    return {code:x.code,hits:x.count,sample:n,text:x.text(x.count),market:offered?serializeMarket(offered):null};
  });
}

function findMarket(markets,terms) {
  for(const m of markets||[]){
    const hay=`${m.market_type||""} ${m.outcome_name||""}`.toLowerCase();
    const relaxed=terms.filter(t=>t!=="win");
    if(relaxed.every(t=>hay.includes(t)))return m;
  }
  return null;
}

function normalizePlayerLanding(raw,fallback) {
  if(!raw)return {photo:null,team_logo:null,stats:null,bio:null};
  const rs=raw?.featuredStats?.regularSeason?.subSeason||raw?.featuredStats?.regularSeason?.career||null;
  const stats=rs?{
    season:raw?.featuredStats?.season||null,
    games_played:numOrNull(rs.gamesPlayed),goals:numOrNull(rs.goals),assists:numOrNull(rs.assists),points:numOrNull(rs.points),plus_minus:numOrNull(rs.plusMinus),pim:numOrNull(rs.pim),shots:numOrNull(rs.shots),shooting_pct:numOrNull(rs.shootingPctg),power_play_goals:numOrNull(rs.powerPlayGoals),power_play_points:numOrNull(rs.powerPlayPoints),
    wins:numOrNull(rs.wins),losses:numOrNull(rs.losses),ot_losses:numOrNull(rs.otLosses),save_pct:numOrNull(rs.savePctg),gaa:numOrNull(rs.goalsAgainstAvg),shutouts:numOrNull(rs.shutouts),
  }:null;
  const bio={height_in:numOrNull(raw.heightInInches),weight_lb:numOrNull(raw.weightInPounds),birth_date:raw.birthDate||null,birth_country:raw.birthCountry||null,shoots_catches:raw.shootsCatches||fallback.shoots_catches||null};
  return {photo:raw.headshot||null,team_logo:raw.teamLogo||null,stats,bio};
}

function normalizeGame(g,subjectTri) {
  if(!g)return null;
  const home=upper(g.home_tri||g.homeTeam?.abbrev),away=upper(g.away_tri||g.awayTeam?.abbrev);
  return {game_pk:Number(g.game_pk||g.id)||null,start_utc:g.scheduled_start_utc||g.startTimeUTC||null,state:g.game_state||g.gameState||null,home_tri:home,away_tri:away,opponent_tri:home===subjectTri?away:home,is_home:home===subjectTri};
}

function teamLogo(t){const tri=upper(t?.tri_code||t?.team_tri);return t?.logo_url|| (tri?`https://assets.nhle.com/logos/nhl/svg/${tri}_dark.svg`:null)}
function playerPhoto(p,season){const tri=upper(p?.current_team_tri);const id=Number(p?.player_id);return tri&&id?`https://assets.nhle.com/mugs/nhl/${season}/${tri}/${id}.png`:null}
function currentSeasonId(){const d=new Date(),y=d.getUTCFullYear(),m=d.getUTCMonth()+1,start=m>=7?y:y-1;return `${start}${start+1}`}
async function fetchNhl(url){const r=await fetch(url,{headers:{Accept:"application/json","User-Agent":"HOH-NHL-Center/2.0"}});if(!r.ok)throw new Error(`nhl_${r.status}`);return r.json()}
function serializeMarket(m){return {market_type:m.market_type,subject_type:m.subject_type,subject_key:m.subject_key,outcome_name:m.outcome_name,odds:Number(m.odds),deeplink:m.deeplink||null,is_live:Boolean(m.is_live),updated_at:m.updated_at||null}}

async function listSubscriptions(request,env){
  const auth=await centerTelegramAuth(request,env,true);if(!auth.ok)return json({ok:false,error:auth.error,subscriptions:[]},401);
  await upsertTelegramUser(env.DB,auth.user);
  try{
    const r=await env.DB.prepare(`
      SELECT s.subscription_id,s.subject_type,s.subject_key,
             CASE s.subject_type WHEN 'player' THEN COALESCE(p.full_name_ru,p.full_name_en,s.subject_key) WHEN 'team' THEN COALESCE(t.name_ru,t.name_en,s.subject_key) ELSE s.subject_key END AS name,
             p.current_team_tri,p.player_id,t.logo_url
      FROM subscriptions s
      LEFT JOIN players p ON s.subject_type='player' AND p.player_id=CAST(s.subject_key AS INTEGER)
      LEFT JOIN teams t ON s.subject_type='team' AND t.tri_code=s.subject_key
      WHERE s.telegram_user_id=? ORDER BY s.subscription_id DESC;
    `).bind(auth.user.id).all();
    const season=currentSeasonId();
    return json({ok:true,subscriptions:(r.results||[]).map(s=>({...s,image:s.subject_type==="player"?playerPhoto(s,season):teamLogo({tri_code:s.subject_key,logo_url:s.logo_url})}))});
  }catch(error){console.error("center v2 subscriptions failed",error);return json({ok:false,error:"subscriptions_failed",subscriptions:[]},503)}
}

async function createSubscription(request,env){
  const auth=await centerTelegramAuth(request,env,true);if(!auth.ok)return json({ok:false,error:auth.error},401);
  let body={};try{body=await request.json()}catch{return json({ok:false,error:"invalid_json"},400)}
  const type=String(body.type||"").toLowerCase(),key=String(body.key||"").trim().toUpperCase();
  if(!["team","player"].includes(type)||!key)return json({ok:false,error:"invalid_subject"},400);
  if(!(await subjectExists(env.DB,type,key)))return json({ok:false,error:"subject_not_found"},404);
  await upsertTelegramUser(env.DB,auth.user);
  try{
    await env.DB.prepare(`
      INSERT INTO subscriptions (telegram_user_id,subject_type,subject_key,notify_pregame,notify_start,notify_goal,notify_assist,notify_period_end,notify_final)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(telegram_user_id,subject_type,subject_key) DO UPDATE SET notify_pregame=excluded.notify_pregame,notify_start=excluded.notify_start,notify_goal=excluded.notify_goal,notify_assist=excluded.notify_assist,notify_final=excluded.notify_final;
    `).bind(auth.user.id,type,key,1,1,1,type==="player"?1:0,0,1).run();
    const row=await env.DB.prepare(`SELECT subscription_id,subject_type,subject_key FROM subscriptions WHERE telegram_user_id=? AND subject_type=? AND subject_key=? LIMIT 1;`).bind(auth.user.id,type,key).first();
    return json({ok:true,subscription:row});
  }catch(error){console.error("center v2 subscription create failed",error);return json({ok:false,error:"subscription_create_failed"},503)}
}
async function deleteSubscription(request,env,id){const auth=await centerTelegramAuth(request,env,true);if(!auth.ok)return json({ok:false,error:auth.error},401);await env.DB.prepare(`DELETE FROM subscriptions WHERE subscription_id=? AND telegram_user_id=?`).bind(id,auth.user.id).run();return json({ok:true,deleted:id})}
async function currentSubscription(request,env,type,key){const auth=await centerTelegramAuth(request,env,false);if(!auth.ok)return null;try{return await env.DB.prepare(`SELECT subscription_id,subject_type,subject_key FROM subscriptions WHERE telegram_user_id=? AND subject_type=? AND subject_key=? LIMIT 1`).bind(auth.user.id,type,key).first()}catch{return null}}
async function subjectExists(db,type,key){if(type==="team")return Boolean(await db.prepare(`SELECT 1 FROM teams WHERE tri_code=? LIMIT 1`).bind(key).first());const id=Number(key);return Number.isSafeInteger(id)&&id>0&&Boolean(await db.prepare(`SELECT 1 FROM players WHERE player_id=? LIMIT 1`).bind(id).first())}
async function upsertTelegramUser(db,u){await db.prepare(`INSERT INTO telegram_users (telegram_user_id,username,first_name,last_name,language_code,notifications_enabled,updated_at) VALUES (?,?,?,?,?,1,CURRENT_TIMESTAMP) ON CONFLICT(telegram_user_id) DO UPDATE SET username=excluded.username,first_name=excluded.first_name,last_name=excluded.last_name,language_code=excluded.language_code,updated_at=CURRENT_TIMESTAMP`).bind(u.id,u.username,u.first_name,u.last_name,u.language_code).run()}

async function centerTelegramAuth(request,env,required){
  const initData=String(request.headers.get("x-telegram-init-data")||"").trim();if(!initData)return required?{ok:false,error:"missing_telegram_init_data"}:{ok:false,error:"guest"};
  const token=String(env.TELEGRAM_CENTER_BOT_TOKEN||"").trim();if(!token)return {ok:false,error:"missing_telegram_center_token"};
  try{const params=new URLSearchParams(initData),provided=params.get("hash")||"",authDate=Number(params.get("auth_date")||0),userRaw=params.get("user")||"";params.delete("hash");if(!provided||!authDate||!userRaw)return {ok:false,error:"invalid_telegram_init_data"};const max=86400;if(Math.abs(Math.floor(Date.now()/1000)-authDate)>max)return {ok:false,error:"telegram_init_data_expired"};const check=[...params.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join("\n"),e=new TextEncoder();const k1=await crypto.subtle.importKey("raw",e.encode("WebAppData"),{name:"HMAC",hash:"SHA-256"},false,["sign"]),secret=await crypto.subtle.sign("HMAC",k1,e.encode(token)),k2=await crypto.subtle.importKey("raw",secret,{name:"HMAC",hash:"SHA-256"},false,["sign"]),digest=await crypto.subtle.sign("HMAC",k2,e.encode(check)),calc=hex(new Uint8Array(digest));if(!(await safeEqual(calc,provided.toLowerCase())))return {ok:false,error:"telegram_signature_invalid"};const raw=JSON.parse(userRaw),id=Number(raw.id);if(!Number.isSafeInteger(id)||id<=0)return {ok:false,error:"telegram_user_invalid"};return {ok:true,user:{id,username:raw.username||null,first_name:raw.first_name||null,last_name:raw.last_name||null,language_code:raw.language_code||null}}}catch{return {ok:false,error:"telegram_init_data_invalid"}}
}
function hex(b){return [...b].map(v=>v.toString(16).padStart(2,"0")).join("")}
async function safeEqual(a,b){const e=new TextEncoder(),[x,y]=await Promise.all([crypto.subtle.digest("SHA-256",e.encode(String(a))),crypto.subtle.digest("SHA-256",e.encode(String(b)))]),aa=new Uint8Array(x),bb=new Uint8Array(y);let d=aa.length^bb.length;for(let i=0;i<Math.min(aa.length,bb.length);i++)d|=aa[i]^bb[i];return d===0}
function upper(v){return String(v||"").trim().toUpperCase()}
function numOrNull(v){const n=Number(v);return Number.isFinite(n)?n:null}
function clampInt(v,f,min,max){const n=Number(v);return Number.isFinite(n)?Math.min(max,Math.max(min,Math.floor(n))):f}
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}})}

const PROFILE_JS=String.raw`(function(){
'use strict';
const tg=window.Telegram&&window.Telegram.WebApp?window.Telegram.WebApp:null,initData=tg&&tg.initData?tg.initData:'',API='/api/telegram-center-v2';
const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const n=v=>Number.isFinite(Number(v))?Number(v):null,fmt=(v,d=0)=>n(v)==null?'—':Number(v).toFixed(d),pct=v=>n(v)==null?'—':(Number(v)*100).toFixed(1)+'%';
async function api(url,opts){opts=opts||{};const h=Object.assign({},opts.headers||{});if(initData)h['X-Telegram-Init-Data']=initData;if(opts.body)h['Content-Type']='application/json';const r=await fetch(url,Object.assign({},opts,{headers:h,cache:'no-store'}));const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||('HTTP '+r.status));return d}
function css(){if(document.getElementById('centerV2Css'))return;const s=document.createElement('style');s.id='centerV2Css';s.textContent='.v2row{display:flex;align-items:center;gap:11px}.v2avatar{width:46px;height:46px;object-fit:contain;border-radius:12px;background:#111}.v2player{object-fit:cover;object-position:top center}.v2grow{flex:1;min-width:0}.v2arrow{color:#777;font-size:18px}.v2sheet{position:fixed;inset:0;background:#08080acc;z-index:9999;display:flex;align-items:flex-end}.v2panel{width:100%;max-height:92vh;overflow:auto;background:#0b0b0d;border:1px solid #2c2c32;border-radius:22px 22px 0 0;padding:14px 14px calc(28px + env(safe-area-inset-bottom))}.v2head{display:flex;gap:12px;align-items:center;position:sticky;top:-14px;background:#0b0b0df5;padding:12px 0;z-index:3}.v2hero{width:82px;height:82px;object-fit:contain;border-radius:18px;background:#151517}.v2hero.player{object-fit:cover;object-position:top}.v2title{flex:1}.v2title h2{font-size:20px;margin:0 0 4px}.v2muted{color:#85858e;font-size:10px}.v2close{border:1px solid #333;background:#17171a;color:#fff;border-radius:10px;padding:9px 12px}.v2sub{width:100%;margin:10px 0;border:1px solid #67402d;background:#22140e;color:#ff8c5c;border-radius:12px;padding:11px;font-weight:900}.v2sub.on{border-color:#35624a;background:#102219;color:#7ee0ad}.v2h{font-size:12px;color:#c7b7ff;margin:18px 0 8px}.v2stats{display:grid;grid-template-columns:repeat(3,1fr);gap:7px}.v2stat{background:#151517;border:1px solid #29292f;border-radius:12px;padding:10px}.v2stat small{display:block;color:#85858e;font-size:8px;margin-bottom:4px}.v2stat b{font-size:16px}.v2next{border:1px solid #2b2b31;border-radius:14px;background:#141416;padding:12px}.v2next strong{font-size:16px}.v2markets{display:grid;gap:6px}.v2market{display:flex;justify-content:space-between;gap:8px;border:1px solid #2b2b31;background:#141416;border-radius:11px;padding:9px}.v2market b{color:#ff8c5c}.v2trend{border:1px solid #2b2b31;background:#141416;border-radius:12px;padding:10px;margin-bottom:7px}.v2trend b{display:block;font-size:12px}.v2trend span{font-size:9px;color:#85858e}.v2games{display:grid;gap:5px}.v2game{display:flex;justify-content:space-between;border-bottom:1px solid #222;padding:8px 2px;font-size:10px}.v2roster{display:grid;grid-template-columns:1fr 1fr;gap:7px}.v2person{display:flex;gap:8px;align-items:center;background:#141416;border:1px solid #29292f;border-radius:11px;padding:8px}.v2person img{width:38px;height:38px;object-fit:cover;object-position:top;border-radius:9px}.v2filters{display:flex;gap:7px;margin:10px 0}.v2filters input,.v2filters select{flex:1;min-width:0;background:#141416;border:1px solid #2a2a30;color:#fff;border-radius:10px;padding:10px}.v2note{font-size:9px;color:#85858e;margin:7px 0}.v2empty{text-align:center;color:#85858e;padding:28px 10px}@media(max-width:380px){.v2roster{grid-template-columns:1fr}.v2stats{grid-template-columns:repeat(2,1fr)}}';document.head.appendChild(s)}
function tab(){return document.querySelector('.tab.active')?.dataset.tab}
function img(src,cls=''){return src?'<img class="v2avatar '+cls+'" src="'+esc(src)+'" onerror="this.style.visibility=\'hidden\'">':'<div class="v2avatar"></div>'}
function sheet(html){document.getElementById('v2sheet')?.remove();const d=document.createElement('div');d.id='v2sheet';d.className='v2sheet';d.innerHTML='<div class="v2panel">'+html+'</div>';d.onclick=e=>{if(e.target===d||e.target.closest('[data-v2-close]'))d.remove()};document.body.appendChild(d)}
function stat(items){return '<div class="v2stats">'+items.map(x=>'<div class="v2stat"><small>'+esc(x[0])+'</small><b>'+esc(x[1])+'</b></div>').join('')+'</div>'}
function gameBlock(g){if(!g)return '<div class="v2empty">Ближайший матч пока не найден</div>';const dt=new Date(g.start_utc);return '<div class="v2next"><div class="v2muted">'+esc(dt.toLocaleString('ru-RU',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}))+'</div><strong>'+esc(g.is_home?'дома vs ':'в гостях @ ')+esc(g.opponent_tri||'NHL')+'</strong></div>'}
function markets(rows){if(!rows||!rows.length)return '<div class="v2empty">Линия Winline для этого матча пока не загружена</div>';return '<div class="v2markets">'+rows.slice(0,12).map(m=>'<div class="v2market"><span>'+esc(m.outcome_name||m.market_type)+'</span><b>'+fmt(m.odds,2)+'</b></div>').join('')+'</div>'}
function subButton(sub,type,key){return '<button class="v2sub '+(sub?'on':'')+'" data-v2-subtype="'+type+'" data-v2-key="'+esc(key)+'" data-v2-subid="'+(sub?.subscription_id||'')+'">'+(sub?'✓ Вы подписаны':'＋ Подписаться')+'</button>'}
async function teams(){document.getElementById('hohTools')?.remove();const c=document.getElementById('content');c.innerHTML='<div class="v2empty">Загружаю команды…</div>';try{const d=await api(API+'/teams');c.innerHTML='<div class="list">'+d.teams.map(t=>'<div class="row card v2row" data-v2-team="'+esc(t.tri_code)+'">'+img(t.logo)+'<div class="v2grow"><b>'+esc(t.name_ru||t.name_en)+'</b><small>'+esc(t.tri_code)+' · профиль команды</small></div><span class="v2arrow">›</span></div>').join('')+'</div>'}catch(e){c.innerHTML='<div class="empty error">'+esc(e.message)+'</div>'}}
async function players(){document.getElementById('hohTools')?.remove();const team=document.getElementById('teamSelect')?.value||'',q=document.getElementById('playerSearch')?.value||'',c=document.getElementById('content');c.innerHTML='<div class="v2empty">Загружаю игроков…</div>';try{const u=new URLSearchParams({limit:'80'});if(team)u.set('team',team);if(q)u.set('q',q);const d=await api(API+'/players?'+u);c.innerHTML=d.players.length?'<div class="list">'+d.players.map(p=>'<div class="row card v2row" data-v2-player="'+p.player_id+'">'+img(p.photo,'v2player')+'<div class="v2grow"><b>'+esc(p.full_name_ru||p.full_name_en)+'</b><small>'+esc(p.current_team_tri||'NHL')+' · '+esc(p.position_code||'')+(p.sweater_number?' · #'+p.sweater_number:'')+'</small></div><span class="v2arrow">›</span></div>').join('')+'</div>':'<div class="v2empty">Игроки не найдены</div>'}catch(e){c.innerHTML='<div class="empty error">'+esc(e.message)+'</div>'}}
async function mine(){document.getElementById('hohTools')?.remove();const c=document.getElementById('content');if(!initData){c.innerHTML='<div class="v2empty">Откройте Center из Telegram-бота, чтобы управлять подписками.</div>';return}c.innerHTML='<div class="v2empty">Загружаю подписки…</div>';try{const d=await api(API+'/subscriptions');c.innerHTML=d.subscriptions.length?'<div class="list">'+d.subscriptions.map(s=>'<div class="row card v2row" data-v2-'+(s.subject_type==='team'?'team':'player')+'="'+esc(s.subject_key)+'">'+img(s.image,s.subject_type==='player'?'v2player':'')+'<div class="v2grow"><b>'+esc(s.name)+'</b><small>'+esc(s.subject_type==='team'?'Команда':'Игрок')+'</small></div><button class="v2close" data-v2-unsub="'+s.subscription_id+'">×</button></div>').join('')+'</div>':'<div class="v2empty">Подписок пока нет</div>'}catch(e){c.innerHTML='<div class="empty error">'+esc(e.message)+'</div>'}}
async function openTeam(tri){sheet('<div class="v2empty">Загружаю профиль…</div>');try{const d=await api(API+'/teams/'+tri),s=d.standings||{};sheet('<div class="v2head"><img class="v2hero" src="'+esc(d.team.logo||'')+'"><div class="v2title"><h2>'+esc(d.team.name_ru||d.team.name_en)+'</h2><div class="v2muted">'+esc(tri)+' · обновлено сейчас</div></div><button class="v2close" data-v2-close>×</button></div>'+subButton(d.subscription,'team',tri)+'<div class="v2h">Статистика сезона</div>'+stat([['Матчи',fmt(s.games_played)],['В-П-ОТ',fmt(s.wins)+'-'+fmt(s.losses)+'-'+fmt(s.ot_losses)],['Очки',fmt(s.points)],['Голы',fmt(s.goals_for)],['Пропущено',fmt(s.goals_against)],['Разница',fmt(s.goal_diff)]])+'<div class="v2h">Ближайший матч</div>'+gameBlock(d.next_game)+'<div class="v2h">Основные рынки Winline</div>'+markets(d.markets)+'<div class="v2h">Тенденции последних матчей</div>'+trends(d.trends)+'<div class="v2h">Последние матчи</div>'+recent(d.recent,tri)+'<div class="v2h">Состав</div><div class="v2roster">'+(d.roster||[]).map(p=>'<div class="v2person" data-v2-player="'+p.player_id+'">'+img(p.photo,'v2player')+'<div><b>'+esc(p.full_name_ru||p.full_name_en)+'</b><div class="v2muted">'+esc(p.position_code||'')+(p.sweater_number?' · #'+p.sweater_number:'')+'</div></div></div>').join('')+'</div>')}catch(e){sheet('<button class="v2close" data-v2-close>×</button><div class="v2empty">'+esc(e.message)+'</div>')}}
async function openPlayer(id){sheet('<div class="v2empty">Загружаю профиль…</div>');try{const d=await api(API+'/players/'+id),p=d.player,s=d.season_stats||{};const goalie=String(p.position_code||'').toUpperCase()==='G';const stats=goalie?[['Матчи',fmt(s.games_played)],['Победы',fmt(s.wins)],['Поражения',fmt(s.losses)],['% сейвов',pct(s.save_pct)],['КН',fmt(s.gaa,2)],['Сухие',fmt(s.shutouts)]]:[['Матчи',fmt(s.games_played)],['Голы',fmt(s.goals)],['Передачи',fmt(s.assists)],['Очки',fmt(s.points)],['+/-',fmt(s.plus_minus)],['Броски',fmt(s.shots)],['Голы в большинстве',fmt(s.power_play_goals)],['Штраф',fmt(s.pim)]];sheet('<div class="v2head"><img class="v2hero player" src="'+esc(p.photo||'')+'"><div class="v2title"><h2>'+esc(p.full_name_ru||p.full_name_en)+'</h2><div class="v2muted">'+esc(p.current_team_tri||'NHL')+' · '+esc(p.position_code||'')+(p.sweater_number?' · #'+p.sweater_number:'')+'</div></div><button class="v2close" data-v2-close>×</button></div>'+subButton(d.subscription,'player',p.player_id)+'<div class="v2h">Статистика сезона</div>'+stat(stats)+'<div class="v2h">Следующий матч команды</div>'+gameBlock(d.next_game)+'<div class="v2h">Персональные рынки Winline</div>'+markets(d.markets)+'<div class="v2h">Последние матчи</div>'+recent(d.recent,p.current_team_tri))}catch(e){sheet('<button class="v2close" data-v2-close>×</button><div class="v2empty">'+esc(e.message)+'</div>')}}
function trends(a){if(!a||!a.length)return '<div class="v2empty">Недостаточно матчей для устойчивых тенденций</div>';return a.map(t=>'<div class="v2trend"><b>'+esc(t.text)+'</b><span>'+(t.market?'Winline: '+esc(t.market.outcome_name||t.market.market_type)+' · '+fmt(t.market.odds,2):'Подходящий рынок Winline пока не найден')+'</span></div>').join('')}
function recent(a,tri){if(!a||!a.length)return '<div class="v2empty">Нет подробной статистики матчей</div>';return '<div class="v2games">'+a.map(g=>{const opp=g.home_tri===tri?g.away_tri:g.home_tri,dt=new Date(g.scheduled_start_utc);return '<div class="v2game"><span>'+esc(dt.toLocaleDateString('ru-RU',{day:'2-digit',month:'short'}))+' · '+esc(opp)+(g.points!=null?' · '+g.points+' очк.':'')+'</span><b>'+esc(g.away_score+' : '+g.home_score)+'</b></div>'}).join('')+'</div>'}
async function toggle(btn){if(!initData){alert('Подписка доступна при открытии из Telegram');return}btn.disabled=true;try{const id=Number(btn.dataset.v2Subid||0);if(id){await api(API+'/subscriptions/'+id,{method:'DELETE'});btn.dataset.v2Subid='';btn.classList.remove('on');btn.textContent='＋ Подписаться'}else{const d=await api(API+'/subscriptions',{method:'POST',body:JSON.stringify({type:btn.dataset.v2Subtype,key:btn.dataset.v2Key})});btn.dataset.v2Subid=d.subscription.subscription_id;btn.classList.add('on');btn.textContent='✓ Вы подписаны'}}catch(e){alert('Ошибка подписки: '+e.message)}finally{btn.disabled=false}}
async function render(){const t=tab();if(t==='teams')return teams();if(t==='players')return players();if(t==='follows')return mine()}
document.addEventListener('click',e=>{const t=e.target.closest('.tab');if(t)setTimeout(render,50);const team=e.target.closest('[data-v2-team]');if(team&&!e.target.closest('[data-v2-unsub]'))openTeam(team.dataset.v2Team);const player=e.target.closest('[data-v2-player]');if(player&&!e.target.closest('[data-v2-unsub]'))openPlayer(Number(player.dataset.v2Player));const sub=e.target.closest('[data-v2-subtype]');if(sub){e.stopPropagation();toggle(sub)}const un=e.target.closest('[data-v2-unsub]');if(un){e.stopPropagation();api(API+'/subscriptions/'+un.dataset.v2Unsub,{method:'DELETE'}).then(mine).catch(x=>alert(x.message))}});
const teamSel=document.getElementById('teamSelect'),search=document.getElementById('playerSearch');if(teamSel)teamSel.addEventListener('change',()=>setTimeout(()=>tab()==='players'&&players(),30));if(search)search.addEventListener('input',()=>{clearTimeout(window.__v2q);window.__v2q=setTimeout(()=>tab()==='players'&&players(),250)});
css();setTimeout(render,80);
})();`;
