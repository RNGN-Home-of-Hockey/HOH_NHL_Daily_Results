const SCRIPT_PATH = "/telegram-app/interactive.js";
const API_PREFIX = "/api/telegram-center";

export async function handleTelegramCenterInteractiveRequest(request, env, path) {
  if (path === SCRIPT_PATH) {
    if (request.method !== "GET") return json({ ok:false,error:"method_not_allowed" },405);
    return new Response(INTERACTIVE_JS, { headers:{ "Content-Type":"application/javascript; charset=utf-8", "Cache-Control":"no-store", "X-Content-Type-Options":"nosniff" } });
  }

  if (!path.startsWith(API_PREFIX)) return null;
  if (!env.DB) return json({ ok:false,error:"missing_d1_binding" },503);

  if (path === `${API_PREFIX}/rankings/teams` && request.method === "GET") return teamRankings(request, env);
  if (path === `${API_PREFIX}/rankings/players` && request.method === "GET") return playerRankings(request, env);
  if (path === `${API_PREFIX}/subscriptions` && request.method === "GET") return subscriptionList(request, env);
  if (path === `${API_PREFIX}/subscriptions` && request.method === "POST") return subscriptionCreate(request, env);

  const deleteMatch = new RegExp(`^${API_PREFIX}/subscriptions/(\\d+)$`).exec(path);
  if (deleteMatch && request.method === "DELETE") return subscriptionDelete(request, env, Number(deleteMatch[1]));

  const teamMatch = new RegExp(`^${API_PREFIX}/teams/([A-Za-z]{3})$`).exec(path);
  if (teamMatch && request.method === "GET") return teamProfile(request, env, teamMatch[1].toUpperCase());

  const playerMatch = new RegExp(`^${API_PREFIX}/players/(\\d+)$`).exec(path);
  if (playerMatch && request.method === "GET") return playerProfile(request, env, Number(playerMatch[1]));

  return json({ ok:false,error:"not_found" },404);
}

async function teamRankings(request, env) {
  const url = new URL(request.url);
  const window = normalizeWindow(url.searchParams.get("window"));
  const metric = normalizeTeamMetric(url.searchParams.get("metric"));
  const order = metric === "ga_pg" ? "ASC" : "DESC";
  try {
    const result = await env.DB.prepare(`
      WITH recent AS (
        SELECT s.team_tri,s.game_pk,s.goals,s.shots,s.hits,s.blocked_shots,s.faceoff_pct,
               s.power_play_goals,s.power_play_opportunities,
               CASE WHEN g.home_tri=s.team_tri THEN g.away_score ELSE g.home_score END AS goals_against,
               g.scheduled_start_utc,
               ROW_NUMBER() OVER (PARTITION BY s.team_tri ORDER BY g.scheduled_start_utc DESC,g.game_pk DESC) rn
        FROM team_game_stats s JOIN games g ON g.game_pk=s.game_pk
        WHERE UPPER(COALESCE(g.game_state,'')) IN ('FINAL','OFF')
      ), agg AS (
        SELECT team_tri,COUNT(*) games,
               AVG(CAST(goals AS REAL)) gf_pg,
               AVG(CAST(goals_against AS REAL)) ga_pg,
               AVG(CAST(goals-goals_against AS REAL)) goal_diff_pg,
               AVG(CAST(COALESCE(shots,0) AS REAL)) shots_pg,
               AVG(CAST(COALESCE(hits,0) AS REAL)) hits_pg,
               AVG(CAST(COALESCE(blocked_shots,0) AS REAL)) blocked_pg,
               AVG(CAST(COALESCE(faceoff_pct,0) AS REAL)) faceoff_pct,
               CASE WHEN SUM(COALESCE(power_play_opportunities,0))>0
                    THEN 100.0*SUM(COALESCE(power_play_goals,0))/SUM(COALESCE(power_play_opportunities,0)) END pp_pct
        FROM recent WHERE rn<=? GROUP BY team_tri
      )
      SELECT a.*,t.name_en,t.name_ru,t.logo_url
      FROM agg a JOIN teams t ON t.tri_code=a.team_tri
      ORDER BY ${metric} ${order}, a.team_tri ASC;
    `).bind(window).all();
    return json({ ok:true,window,metric,metric_label:teamMetricLabel(metric),teams:result.results||[] });
  } catch (error) {
    console.error("telegram center interactive team rankings failed", error);
    return json({ ok:false,error:"team_rankings_failed",teams:[] },503);
  }
}

async function playerRankings(request, env) {
  const url = new URL(request.url);
  const window = normalizeWindow(url.searchParams.get("window"));
  const metric = normalizePlayerMetric(url.searchParams.get("metric"));
  const team = String(url.searchParams.get("team")||"").trim().toUpperCase();
  const q = String(url.searchParams.get("q")||"").trim();
  const limit = clampInt(url.searchParams.get("limit"),40,1,80);
  try {
    const result = await env.DB.prepare(`
      WITH recent AS (
        SELECT s.player_id,s.goals,s.assists,s.points,s.shots,s.hits,s.blocked_shots,s.pim,s.plus_minus,
               g.scheduled_start_utc,
               ROW_NUMBER() OVER (PARTITION BY s.player_id ORDER BY g.scheduled_start_utc DESC,g.game_pk DESC) rn
        FROM player_game_stats s JOIN games g ON g.game_pk=s.game_pk
        WHERE UPPER(COALESCE(g.game_state,'')) IN ('FINAL','OFF')
      ), agg AS (
        SELECT player_id,COUNT(*) games,
               SUM(COALESCE(goals,0)) goals,SUM(COALESCE(assists,0)) assists,SUM(COALESCE(points,0)) points,
               SUM(COALESCE(shots,0)) shots,SUM(COALESCE(hits,0)) hits,SUM(COALESCE(blocked_shots,0)) blocked_shots,
               SUM(COALESCE(pim,0)) pim,SUM(COALESCE(plus_minus,0)) plus_minus,
               CAST(SUM(COALESCE(goals,0)) AS REAL)/COUNT(*) goals_pg,
               CAST(SUM(COALESCE(assists,0)) AS REAL)/COUNT(*) assists_pg,
               CAST(SUM(COALESCE(points,0)) AS REAL)/COUNT(*) points_pg,
               CAST(SUM(COALESCE(shots,0)) AS REAL)/COUNT(*) shots_pg,
               CAST(SUM(COALESCE(hits,0)) AS REAL)/COUNT(*) hits_pg,
               CAST(SUM(COALESCE(blocked_shots,0)) AS REAL)/COUNT(*) blocked_pg
        FROM recent WHERE rn<=? GROUP BY player_id
      )
      SELECT a.*,p.full_name_en,p.full_name_ru,p.current_team_tri,p.position_code,p.sweater_number
      FROM agg a JOIN players p ON p.player_id=a.player_id
      WHERE (?='' OR p.current_team_tri=?)
        AND (?='' OR p.full_name_en LIKE '%'||?||'%' OR COALESCE(p.full_name_ru,'') LIKE '%'||?||'%')
      ORDER BY ${metric} DESC,a.games DESC,p.full_name_en ASC LIMIT ?;
    `).bind(window,team,team,q,q,q,limit).all();
    return json({ ok:true,window,metric,metric_label:playerMetricLabel(metric),team:team||null,players:result.results||[] });
  } catch (error) {
    console.error("telegram center interactive player rankings failed", error);
    return json({ ok:false,error:"player_rankings_failed",players:[] },503);
  }
}

async function teamProfile(request, env, tri) {
  const window = normalizeWindow(new URL(request.url).searchParams.get("window"));
  try {
    const team = await env.DB.prepare(`SELECT tri_code,name_en,name_ru,logo_url FROM teams WHERE tri_code=? LIMIT 1;`).bind(tri).first();
    if (!team) return json({ ok:false,error:"team_not_found" },404);
    const [stats, recent, roster] = await Promise.all([
      env.DB.prepare(`
        WITH recent AS (
          SELECT s.game_pk,s.goals,s.shots,s.hits,s.blocked_shots,s.faceoff_pct,s.power_play_goals,s.power_play_opportunities,
                 CASE WHEN g.home_tri=? THEN g.away_score ELSE g.home_score END goals_against,
                 ROW_NUMBER() OVER (ORDER BY g.scheduled_start_utc DESC,g.game_pk DESC) rn
          FROM team_game_stats s JOIN games g ON g.game_pk=s.game_pk
          WHERE s.team_tri=? AND UPPER(COALESCE(g.game_state,'')) IN ('FINAL','OFF')
        )
        SELECT COUNT(*) games,AVG(CAST(goals AS REAL)) gf_pg,AVG(CAST(goals_against AS REAL)) ga_pg,
               AVG(CAST(goals-goals_against AS REAL)) goal_diff_pg,AVG(CAST(COALESCE(shots,0) AS REAL)) shots_pg,
               AVG(CAST(COALESCE(hits,0) AS REAL)) hits_pg,AVG(CAST(COALESCE(blocked_shots,0) AS REAL)) blocked_pg,
               AVG(CAST(COALESCE(faceoff_pct,0) AS REAL)) faceoff_pct,
               CASE WHEN SUM(COALESCE(power_play_opportunities,0))>0 THEN 100.0*SUM(COALESCE(power_play_goals,0))/SUM(COALESCE(power_play_opportunities,0)) END pp_pct
        FROM recent WHERE rn<=?;
      `).bind(tri,tri,window).first(),
      env.DB.prepare(`
        SELECT g.game_pk,g.scheduled_start_utc,g.home_tri,g.away_tri,g.home_score,g.away_score
        FROM games g WHERE (g.home_tri=? OR g.away_tri=?) AND UPPER(COALESCE(g.game_state,'')) IN ('FINAL','OFF')
        ORDER BY g.scheduled_start_utc DESC,g.game_pk DESC LIMIT 5;
      `).bind(tri,tri).all(),
      env.DB.prepare(`
        WITH recent AS (
          SELECT s.player_id,s.goals,s.assists,s.points,s.shots,g.scheduled_start_utc,
                 ROW_NUMBER() OVER (PARTITION BY s.player_id ORDER BY g.scheduled_start_utc DESC,g.game_pk DESC) rn
          FROM player_game_stats s JOIN games g ON g.game_pk=s.game_pk
          WHERE s.team_tri=? AND UPPER(COALESCE(g.game_state,'')) IN ('FINAL','OFF')
        ), agg AS (
          SELECT player_id,COUNT(*) games,SUM(COALESCE(points,0)) points,SUM(COALESCE(goals,0)) goals,SUM(COALESCE(assists,0)) assists,
                 CAST(SUM(COALESCE(points,0)) AS REAL)/COUNT(*) points_pg
          FROM recent WHERE rn<=? GROUP BY player_id
        )
        SELECT a.*,p.full_name_en,p.full_name_ru,p.position_code,p.sweater_number
        FROM agg a JOIN players p ON p.player_id=a.player_id
        ORDER BY a.points_pg DESC,a.points DESC,p.full_name_en ASC LIMIT 12;
      `).bind(tri,window).all(),
    ]);
    const subscription = await currentSubscription(request, env, "team", tri);
    return json({ ok:true,window,team,stats:stats||{},recent:recent.results||[],roster:roster.results||[],subscription });
  } catch (error) {
    console.error("telegram center interactive team profile failed", error);
    return json({ ok:false,error:"team_profile_failed" },503);
  }
}

async function playerProfile(request, env, playerId) {
  const window = normalizeWindow(new URL(request.url).searchParams.get("window"));
  if (!Number.isSafeInteger(playerId)||playerId<=0) return json({ ok:false,error:"invalid_player_id" },400);
  try {
    const player = await env.DB.prepare(`SELECT player_id,full_name_en,full_name_ru,current_team_tri,position_code,sweater_number,shoots_catches FROM players WHERE player_id=? LIMIT 1;`).bind(playerId).first();
    if (!player) return json({ ok:false,error:"player_not_found" },404);
    const [stats,recent] = await Promise.all([
      env.DB.prepare(`
        WITH recent AS (
          SELECT s.*,g.scheduled_start_utc,
                 ROW_NUMBER() OVER (ORDER BY g.scheduled_start_utc DESC,g.game_pk DESC) rn
          FROM player_game_stats s JOIN games g ON g.game_pk=s.game_pk
          WHERE s.player_id=? AND UPPER(COALESCE(g.game_state,'')) IN ('FINAL','OFF')
        )
        SELECT COUNT(*) games,SUM(COALESCE(goals,0)) goals,SUM(COALESCE(assists,0)) assists,SUM(COALESCE(points,0)) points,
               SUM(COALESCE(shots,0)) shots,SUM(COALESCE(hits,0)) hits,SUM(COALESCE(blocked_shots,0)) blocked_shots,
               SUM(COALESCE(pim,0)) pim,SUM(COALESCE(plus_minus,0)) plus_minus,
               CAST(SUM(COALESCE(goals,0)) AS REAL)/COUNT(*) goals_pg,
               CAST(SUM(COALESCE(assists,0)) AS REAL)/COUNT(*) assists_pg,
               CAST(SUM(COALESCE(points,0)) AS REAL)/COUNT(*) points_pg,
               CAST(SUM(COALESCE(shots,0)) AS REAL)/COUNT(*) shots_pg,
               CAST(SUM(COALESCE(hits,0)) AS REAL)/COUNT(*) hits_pg,
               CAST(SUM(COALESCE(blocked_shots,0)) AS REAL)/COUNT(*) blocked_pg
        FROM recent WHERE rn<=?;
      `).bind(playerId,window).first(),
      env.DB.prepare(`
        SELECT s.game_pk,s.team_tri,s.goals,s.assists,s.points,s.shots,s.hits,s.blocked_shots,s.plus_minus,
               g.scheduled_start_utc,g.home_tri,g.away_tri,g.home_score,g.away_score
        FROM player_game_stats s JOIN games g ON g.game_pk=s.game_pk
        WHERE s.player_id=? AND UPPER(COALESCE(g.game_state,'')) IN ('FINAL','OFF')
        ORDER BY g.scheduled_start_utc DESC,g.game_pk DESC LIMIT 8;
      `).bind(playerId).all(),
    ]);
    const subscription = await currentSubscription(request, env, "player", String(playerId));
    return json({ ok:true,window,player,stats:stats||{},recent:recent.results||[],subscription });
  } catch (error) {
    console.error("telegram center interactive player profile failed", error);
    return json({ ok:false,error:"player_profile_failed" },503);
  }
}

async function subscriptionList(request, env) {
  const auth = await centerTelegramAuth(request, env, true);
  if (!auth.ok) return json({ ok:false,error:auth.error,subscriptions:[] },401);
  await upsertTelegramUser(env.DB,auth.user);
  try {
    const result = await env.DB.prepare(`
      SELECT s.subscription_id,s.subject_type,s.subject_key,s.notify_pregame,s.notify_start,s.notify_goal,s.notify_assist,s.notify_period_end,s.notify_final,
             CASE s.subject_type WHEN 'player' THEN COALESCE(p.full_name_ru,p.full_name_en,s.subject_key)
                  WHEN 'team' THEN COALESCE(t.name_ru,t.name_en,s.subject_key)
                  WHEN 'game' THEN COALESCE(g.away_tri||' — '||g.home_tri,'Game #'||s.subject_key) ELSE s.subject_key END name
      FROM subscriptions s
      LEFT JOIN players p ON s.subject_type='player' AND p.player_id=CAST(s.subject_key AS INTEGER)
      LEFT JOIN teams t ON s.subject_type='team' AND t.tri_code=s.subject_key
      LEFT JOIN games g ON s.subject_type='game' AND g.game_pk=CAST(s.subject_key AS INTEGER)
      WHERE s.telegram_user_id=? ORDER BY s.subscription_id DESC;
    `).bind(auth.user.id).all();
    return json({ ok:true,subscriptions:result.results||[] });
  } catch (error) {
    console.error("telegram center interactive subscription list failed", error);
    return json({ ok:false,error:"subscriptions_failed",subscriptions:[] },503);
  }
}

async function subscriptionCreate(request, env) {
  const auth = await centerTelegramAuth(request, env, true);
  if (!auth.ok) return json({ ok:false,error:auth.error },401);
  let body={}; try{body=await request.json()}catch{return json({ok:false,error:"invalid_json"},400)}
  const type=String(body.type||"").trim().toLowerCase();
  const key=String(body.key||"").trim().toUpperCase();
  if(!["team","player"].includes(type)||!key) return json({ok:false,error:"invalid_subject"},400);
  if(!(await subjectExists(env.DB,type,key))) return json({ok:false,error:"subject_not_found"},404);
  await upsertTelegramUser(env.DB,auth.user);
  try {
    await env.DB.prepare(`
      INSERT INTO subscriptions (telegram_user_id,subject_type,subject_key,notify_pregame,notify_start,notify_goal,notify_assist,notify_period_end,notify_final)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(telegram_user_id,subject_type,subject_key) DO UPDATE SET
        notify_pregame=excluded.notify_pregame,notify_start=excluded.notify_start,notify_goal=excluded.notify_goal,
        notify_assist=excluded.notify_assist,notify_period_end=excluded.notify_period_end,notify_final=excluded.notify_final;
    `).bind(auth.user.id,type,key,type==="team"?1:0,1,1,type==="player"?1:0,0,1).run();
    const row=await env.DB.prepare(`SELECT subscription_id,subject_type,subject_key FROM subscriptions WHERE telegram_user_id=? AND subject_type=? AND subject_key=? LIMIT 1;`).bind(auth.user.id,type,key).first();
    return json({ok:true,subscription:row});
  } catch (error) {
    console.error("telegram center interactive subscription create failed", error);
    return json({ok:false,error:"subscription_create_failed"},503);
  }
}

async function subscriptionDelete(request, env, id) {
  const auth = await centerTelegramAuth(request, env, true);
  if (!auth.ok) return json({ ok:false,error:auth.error },401);
  if(!Number.isSafeInteger(id)||id<=0) return json({ok:false,error:"invalid_subscription_id"},400);
  try {
    await env.DB.prepare(`DELETE FROM subscriptions WHERE subscription_id=? AND telegram_user_id=?;`).bind(id,auth.user.id).run();
    return json({ok:true,deleted:id});
  } catch (error) {
    console.error("telegram center interactive subscription delete failed", error);
    return json({ok:false,error:"subscription_delete_failed"},503);
  }
}

async function currentSubscription(request, env, type, key) {
  const auth=await centerTelegramAuth(request,env,false);
  if(!auth.ok) return null;
  try{return await env.DB.prepare(`SELECT subscription_id,subject_type,subject_key FROM subscriptions WHERE telegram_user_id=? AND subject_type=? AND subject_key=? LIMIT 1;`).bind(auth.user.id,type,key).first()}catch{return null}
}

async function subjectExists(db,type,key){
  if(type==="team") return Boolean(await db.prepare(`SELECT 1 ok FROM teams WHERE tri_code=? LIMIT 1;`).bind(key).first());
  const id=Number(key); if(!Number.isSafeInteger(id)||id<=0)return false;
  return Boolean(await db.prepare(`SELECT 1 ok FROM players WHERE player_id=? LIMIT 1;`).bind(id).first());
}

async function upsertTelegramUser(db,user){
  await db.prepare(`INSERT INTO telegram_users (telegram_user_id,username,first_name,last_name,language_code,notifications_enabled,updated_at)
    VALUES (?,?,?,?,?,1,CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_user_id) DO UPDATE SET username=excluded.username,first_name=excluded.first_name,last_name=excluded.last_name,language_code=excluded.language_code,updated_at=CURRENT_TIMESTAMP;`)
    .bind(user.id,user.username,user.first_name,user.last_name,user.language_code).run();
}

async function centerTelegramAuth(request,env,required){
  const initData=String(request.headers.get("x-telegram-init-data")||"").trim();
  if(!initData)return required?{ok:false,error:"missing_telegram_init_data"}:{ok:false,error:"guest"};
  const token=String(env.TELEGRAM_CENTER_BOT_TOKEN||"").trim();
  if(!token)return {ok:false,error:"missing_telegram_center_token"};
  try{
    const params=new URLSearchParams(initData),providedHash=params.get("hash")||"",authDate=Number(params.get("auth_date")||0),userRaw=params.get("user")||"";params.delete("hash");
    if(!providedHash||!authDate||!userRaw)return {ok:false,error:"invalid_telegram_init_data"};
    const maxAgeRaw=Number(env.TELEGRAM_WEBAPP_MAX_AGE_SECONDS||86400),maxAge=Number.isFinite(maxAgeRaw)?Math.min(604800,Math.max(300,Math.floor(maxAgeRaw))):86400;
    if(Math.abs(Math.floor(Date.now()/1000)-authDate)>maxAge)return {ok:false,error:"telegram_init_data_expired"};
    const dataCheck=[...params.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join("\n"),encoder=new TextEncoder();
    const key1=await crypto.subtle.importKey("raw",encoder.encode("WebAppData"),{name:"HMAC",hash:"SHA-256"},false,["sign"]),secret=await crypto.subtle.sign("HMAC",key1,encoder.encode(token));
    const key2=await crypto.subtle.importKey("raw",secret,{name:"HMAC",hash:"SHA-256"},false,["sign"]),digest=await crypto.subtle.sign("HMAC",key2,encoder.encode(dataCheck)),calculated=bytesToHex(new Uint8Array(digest));
    if(!(await safeTextEqual(calculated,providedHash.toLowerCase())))return {ok:false,error:"telegram_signature_invalid"};
    const user=JSON.parse(userRaw),id=Number(user.id);if(!Number.isSafeInteger(id)||id<=0)return {ok:false,error:"telegram_user_invalid"};
    return {ok:true,user:{id,username:user.username||null,first_name:user.first_name||null,last_name:user.last_name||null,language_code:user.language_code||null}};
  }catch(error){console.error("telegram center interactive auth failed",error);return {ok:false,error:"telegram_init_data_invalid"}}
}

function normalizeWindow(v){return [5,10,20].includes(Number(v))?Number(v):20}
function normalizeTeamMetric(v){return ["goal_diff_pg","gf_pg","ga_pg","shots_pg","hits_pg","blocked_pg","faceoff_pct","pp_pct"].includes(String(v))?String(v):"goal_diff_pg"}
function normalizePlayerMetric(v){return ["points_pg","goals_pg","assists_pg","shots_pg","hits_pg","blocked_pg"].includes(String(v))?String(v):"points_pg"}
function teamMetricLabel(v){return ({goal_diff_pg:"Разница голов / матч",gf_pg:"Голы / матч",ga_pg:"Пропущено / матч",shots_pg:"Броски / матч",hits_pg:"Хиты / матч",blocked_pg:"Блоки / матч",faceoff_pct:"Вбрасывания %",pp_pct:"Большинство %"})[v]||v}
function playerMetricLabel(v){return ({points_pg:"Очки / матч",goals_pg:"Голы / матч",assists_pg:"Передачи / матч",shots_pg:"Броски / матч",hits_pg:"Хиты / матч",blocked_pg:"Блоки / матч"})[v]||v}
function clampInt(v,fallback,min,max){const n=Number(v);return Number.isFinite(n)?Math.min(max,Math.max(min,Math.floor(n))):fallback}
function bytesToHex(bytes){return [...bytes].map(v=>v.toString(16).padStart(2,"0")).join("")}
async function safeTextEqual(a,b){const e=new TextEncoder(),[da,db]=await Promise.all([crypto.subtle.digest("SHA-256",e.encode(String(a))),crypto.subtle.digest("SHA-256",e.encode(String(b)))]),aa=new Uint8Array(da),bb=new Uint8Array(db);let d=aa.length^bb.length;for(let i=0;i<Math.min(aa.length,bb.length);i++)d|=aa[i]^bb[i];return d===0}
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}})}

const INTERACTIVE_JS = String.raw`(function(){
'use strict';
const tg=window.Telegram&&window.Telegram.WebApp?window.Telegram.WebApp:null;
const initData=tg&&tg.initData?tg.initData:'';
const API='/api/telegram-center';
const metricLabels={goal_diff_pg:'Разница голов / матч',gf_pg:'Голы / матч',ga_pg:'Пропущено / матч',shots_pg:'Броски / матч',hits_pg:'Хиты / матч',blocked_pg:'Блоки / матч',faceoff_pct:'Вбрасывания %',pp_pct:'Большинство %',points_pg:'Очки / матч',goals_pg:'Голы / матч',assists_pg:'Передачи / матч'};
let teamWindow=20,teamMetric='goal_diff_pg',playerWindow=20,playerMetric='points_pg',serial=0;
const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num=(v,d=2)=>Number.isFinite(Number(v))?Number(v).toFixed(d):'—';
async function api(url,opts){opts=opts||{};const headers=Object.assign({},opts.headers||{});if(initData)headers['X-Telegram-Init-Data']=initData;if(opts.body&&!headers['Content-Type'])headers['Content-Type']='application/json';const r=await fetch(url,Object.assign({},opts,{headers,cache:'no-store'}));const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||('HTTP '+r.status));return d}
function activeTab(){const b=document.querySelector('.tab.active');return b&&b.dataset.tab}
function ensureCss(){if(document.getElementById('hohInteractiveCss'))return;const s=document.createElement('style');s.id='hohInteractiveCss';s.textContent='.hoh-tools{display:flex;gap:7px;margin:8px 0 10px}.hoh-tools select{flex:1;min-width:0;background:#141416;border:1px solid #2a2a30;color:#fff;border-radius:10px;padding:9px;font-size:10px}.hoh-click{cursor:pointer}.hoh-click:active{transform:scale(.99)}.hoh-sheet{position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:9998;display:flex;align-items:flex-end}.hoh-panel{background:#0d0d0f;border:1px solid #2d2d33;border-radius:20px 20px 0 0;width:100%;max-height:88vh;overflow:auto;padding:14px 14px calc(24px + env(safe-area-inset-bottom));box-shadow:0 -20px 50px #0008}.hoh-panel-head{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;position:sticky;top:0;background:#0d0d0f;padding:2px 0 10px;z-index:2}.hoh-panel h2{font-size:20px;margin:0}.hoh-panel h3{font-size:12px;margin:18px 0 7px;color:#c7b7ff}.hoh-close,.hoh-sub{border:1px solid #3a3a42;background:#17171a;color:#fff;border-radius:10px;padding:9px 12px}.hoh-sub.on{background:#26160f;border-color:#7b422a;color:#ff956e}.hoh-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:7px}.hoh-stat{background:#151517;border:1px solid #29292f;border-radius:12px;padding:10px}.hoh-stat small{display:block;color:#85858e;font-size:8px}.hoh-stat b{font-size:16px}.hoh-game{display:flex;justify-content:space-between;gap:8px;border-bottom:1px solid #222;padding:8px 0;font-size:10px}.hoh-manage{display:flex;gap:6px}.hoh-manage button{border:1px solid #38383f;background:#17171a;color:#fff;border-radius:8px;padding:7px 9px;font-size:9px}.hoh-manage .danger{color:#ff8c78}.hoh-metric-label{color:#85858e;font-size:8px;display:block;margin-top:3px}';document.head.appendChild(s)}
function toolsHtml(kind){const isTeam=kind==='teams',w=isTeam?teamWindow:playerWindow,m=isTeam?teamMetric:playerMetric;const opts=isTeam?[['goal_diff_pg','Разница голов'],['gf_pg','Голы / матч'],['ga_pg','Пропущено / матч'],['shots_pg','Броски / матч'],['hits_pg','Хиты / матч'],['blocked_pg','Блоки / матч'],['faceoff_pct','Вбрасывания %'],['pp_pct','Большинство %']]:[['points_pg','Очки / матч'],['goals_pg','Голы / матч'],['assists_pg','Передачи / матч'],['shots_pg','Броски / матч'],['hits_pg','Хиты / матч'],['blocked_pg','Блоки / матч']];return '<div class="hoh-tools" id="hohTools"><select id="hohWindow">'+[5,10,20].map(x=>'<option value="'+x+'" '+(x===w?'selected':'')+'>'+x+' матчей</option>').join('')+'</select><select id="hohMetric">'+opts.map(x=>'<option value="'+x[0]+'" '+(x[0]===m?'selected':'')+'>'+x[1]+'</option>').join('')+'</select></div>'}
function installTools(kind){document.getElementById('hohTools')?.remove();const status=document.getElementById('status');if(!status)return;status.insertAdjacentHTML('afterend',toolsHtml(kind));document.getElementById('hohWindow').onchange=e=>{if(kind==='teams')teamWindow=Number(e.target.value);else playerWindow=Number(e.target.value);refresh(kind)};document.getElementById('hohMetric').onchange=e=>{if(kind==='teams')teamMetric=e.target.value;else playerMetric=e.target.value;refresh(kind)}}
async function refresh(kind){const mine=++serial;if(kind==='teams'){installTools('teams');const content=document.getElementById('content');content.innerHTML='<div class="empty">Загружаю рейтинг…</div>';try{const d=await api(API+'/rankings/teams?window='+teamWindow+'&metric='+encodeURIComponent(teamMetric));if(mine!==serial||activeTab()!=='teams')return;content.innerHTML=d.teams.length?'<div class="list">'+d.teams.map((t,i)=>'<div class="row card hoh-click" data-team="'+esc(t.team_tri)+'"><div><b>'+esc(t.name_ru||t.name_en||t.team_tri)+'</b><small>'+esc(t.team_tri)+' · '+esc(t.games)+' игр</small><span class="hoh-metric-label">'+esc(d.metric_label)+'</span></div><strong>'+num(t[d.metric])+'</strong></div>').join('')+'</div>':'<div class="empty">Нет данных</div>'}catch(e){content.innerHTML='<div class="empty error">'+esc(e.message)+'</div>'}}else if(kind==='players'){installTools('players');const team=document.getElementById('teamSelect')?.value||'',q=document.getElementById('playerSearch')?.value||'',content=document.getElementById('content');content.innerHTML='<div class="empty">Загружаю игроков…</div>';try{const u=new URLSearchParams({window:String(playerWindow),metric:playerMetric,limit:'60'});if(team)u.set('team',team);if(q)u.set('q',q);const d=await api(API+'/rankings/players?'+u);if(mine!==serial||activeTab()!=='players')return;content.innerHTML=d.players.length?'<div class="list">'+d.players.map(p=>'<div class="row card hoh-click" data-player="'+p.player_id+'"><div><b>'+esc(p.full_name_ru||p.full_name_en)+'</b><small>'+esc(p.current_team_tri||'NHL')+' · '+esc(p.position_code||'')+(p.sweater_number?' · #'+p.sweater_number:'')+' · '+p.games+' игр</small><span class="hoh-metric-label">'+esc(d.metric_label)+'</span></div><strong>'+num(p[d.metric])+'</strong></div>').join('')+'</div>':'<div class="empty">Игроки не найдены</div>'}catch(e){content.innerHTML='<div class="empty error">'+esc(e.message)+'</div>'}}else if(kind==='follows'){document.getElementById('hohTools')?.remove();await renderMine()}}
function sheet(body){document.getElementById('hohSheet')?.remove();const d=document.createElement('div');d.id='hohSheet';d.className='hoh-sheet';d.innerHTML='<div class="hoh-panel">'+body+'</div>';d.onclick=e=>{if(e.target===d||e.target.closest('[data-close]'))d.remove()};document.body.appendChild(d)}
function statGrid(items){return '<div class="hoh-stats">'+items.map(x=>'<div class="hoh-stat"><small>'+esc(x[0])+'</small><b>'+esc(x[1])+'</b></div>').join('')+'</div>'}
async function openTeam(tri){sheet('<div class="empty">Загружаю команду…</div>');try{const d=await api(API+'/teams/'+encodeURIComponent(tri)+'?window='+teamWindow);const s=d.stats||{},sub=d.subscription;sheet('<div class="hoh-panel-head"><div><h2>'+esc(d.team.name_ru||d.team.name_en||tri)+'</h2><small>'+esc(tri)+' · последние '+d.window+' матчей</small></div><button class="hoh-close" data-close>×</button></div>'+statGrid([['Голы / матч',num(s.gf_pg)],['Пропущено / матч',num(s.ga_pg)],['Разница',num(s.goal_diff_pg)],['Броски / матч',num(s.shots_pg)],['Хиты / матч',num(s.hits_pg)],['Большинство',num(s.pp_pct,1)+'%']])+'<button class="hoh-sub '+(sub?'on':'')+'" data-subtype="team" data-subkey="'+esc(tri)+'" data-subid="'+(sub?.subscription_id||'')+'">'+(sub?'✓ Подписка включена':'＋ Подписаться на команду')+'</button><h3>Последние матчи</h3>'+recentGames(d.recent,tri)+'<h3>Лидеры команды</h3><div class="list">'+(d.roster||[]).map(p=>'<div class="row card hoh-click" data-player="'+p.player_id+'"><div><b>'+esc(p.full_name_ru||p.full_name_en)+'</b><small>'+esc(p.position_code||'')+(p.sweater_number?' · #'+p.sweater_number:'')+' · '+p.games+' игр</small></div><strong>'+num(p.points_pg)+'</strong></div>').join('')+'</div>');}catch(e){sheet('<div class="hoh-panel-head"><h2>Команда</h2><button class="hoh-close" data-close>×</button></div><div class="empty error">'+esc(e.message)+'</div>')}}
async function openPlayer(id){sheet('<div class="empty">Загружаю игрока…</div>');try{const d=await api(API+'/players/'+id+'?window='+playerWindow),p=d.player,s=d.stats||{},sub=d.subscription;sheet('<div class="hoh-panel-head"><div><h2>'+esc(p.full_name_ru||p.full_name_en)+'</h2><small>'+esc(p.current_team_tri||'NHL')+' · '+esc(p.position_code||'')+(p.sweater_number?' · #'+p.sweater_number:'')+' · '+d.window+' матчей</small></div><button class="hoh-close" data-close>×</button></div>'+statGrid([['Очки / матч',num(s.points_pg)],['Голы / матч',num(s.goals_pg)],['Передачи / матч',num(s.assists_pg)],['Броски / матч',num(s.shots_pg)],['Хиты / матч',num(s.hits_pg)],['Блоки / матч',num(s.blocked_pg)]])+'<button class="hoh-sub '+(sub?'on':'')+'" data-subtype="player" data-subkey="'+p.player_id+'" data-subid="'+(sub?.subscription_id||'')+'">'+(sub?'✓ Подписка включена':'＋ Подписаться на игрока')+'</button><h3>Последние матчи</h3>'+recentGames(d.recent,p.current_team_tri));}catch(e){sheet('<div class="hoh-panel-head"><h2>Игрок</h2><button class="hoh-close" data-close>×</button></div><div class="empty error">'+esc(e.message)+'</div>')}}
function recentGames(rows,subjectTri){if(!rows||!rows.length)return '<div class="empty">Нет матчей в базе</div>';return rows.map(g=>{const opp=g.home_tri===subjectTri?g.away_tri:g.home_tri;const score=g.away_score+' : '+g.home_score;const extra=g.points!=null?' · '+g.points+' очк.':'';return '<div class="hoh-game"><span>'+esc((g.scheduled_start_utc||'').slice(0,10))+' · '+esc(opp)+extra+'</span><b>'+esc(score)+'</b></div>'}).join('')}
async function toggleSubscription(btn){if(!initData){alert('Подписки доступны при открытии из Telegram-бота');return}btn.disabled=true;try{const id=Number(btn.dataset.subid||0);if(id){await api(API+'/subscriptions/'+id,{method:'DELETE'});btn.dataset.subid='';btn.classList.remove('on');btn.textContent='＋ Подписаться'}else{const d=await api(API+'/subscriptions',{method:'POST',body:JSON.stringify({type:btn.dataset.subtype,key:btn.dataset.subkey})});btn.dataset.subid=d.subscription.subscription_id;btn.classList.add('on');btn.textContent='✓ Подписка включена'}if(activeTab()==='follows')renderMine()}catch(e){alert('Ошибка подписки: '+e.message)}finally{btn.disabled=false}}
async function renderMine(){const content=document.getElementById('content');if(!initData){content.innerHTML='<div class="empty">Откройте Center из Telegram-бота, чтобы управлять подписками.</div>';return}content.innerHTML='<div class="empty">Загружаю подписки…</div>';try{const d=await api(API+'/subscriptions');const a=d.subscriptions||[];content.innerHTML=a.length?'<div class="list">'+a.map(s=>'<div class="row card"><div class="hoh-click" data-'+(s.subject_type==='team'?'team':'player')+'="'+esc(s.subject_key)+'"><b>'+esc(s.name||s.subject_key)+'</b><small>'+esc(s.subject_type==='team'?'Команда':'Игрок')+'</small></div><div class="hoh-manage"><button class="danger" data-unsub="'+s.subscription_id+'">Удалить</button></div></div>').join('')+'</div>':'<div class="empty">Подписок пока нет. Открой профиль команды или игрока и нажми «Подписаться».</div>'}catch(e){content.innerHTML='<div class="empty error">'+esc(e.message)+'</div>'}}
async function removeSubscription(id){try{await api(API+'/subscriptions/'+id,{method:'DELETE'});renderMine()}catch(e){alert('Ошибка: '+e.message)}}
document.addEventListener('click',e=>{const tab=e.target.closest('.tab');if(tab)setTimeout(()=>{const t=activeTab();if(['teams','players','follows'].includes(t))refresh(t);else document.getElementById('hohTools')?.remove()},30);const team=e.target.closest('[data-team]');if(team)openTeam(team.dataset.team);const player=e.target.closest('[data-player]');if(player)openPlayer(Number(player.dataset.player));const sub=e.target.closest('[data-subtype]');if(sub)toggleSubscription(sub);const un=e.target.closest('[data-unsub]');if(un){e.stopPropagation();removeSubscription(Number(un.dataset.unsub))}});
const teamSelect=document.getElementById('teamSelect'),playerSearch=document.getElementById('playerSearch');if(teamSelect)teamSelect.addEventListener('change',()=>setTimeout(()=>activeTab()==='players'&&refresh('players'),40));if(playerSearch)playerSearch.addEventListener('input',()=>{clearTimeout(window.__hohInteractiveSearch);window.__hohInteractiveSearch=setTimeout(()=>activeTab()==='players'&&refresh('players'),350)});
ensureCss();
})();`;
