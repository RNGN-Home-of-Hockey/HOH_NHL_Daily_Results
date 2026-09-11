const NHL_BASE = "https://api-web.nhle.com/v1";
const MINI_APP_PATH = "/telegram-app";

const TEAMS = [
  ["ANA","Анахайм"],["BOS","Бостон"],["BUF","Баффало"],["CGY","Калгари"],
  ["CAR","Каролина"],["CHI","Чикаго"],["COL","Колорадо"],["CBJ","Коламбус"],
  ["DAL","Даллас"],["DET","Детройт"],["EDM","Эдмонтон"],["FLA","Флорида"],
  ["LAK","Лос-Анджелес"],["MIN","Миннесота"],["MTL","Монреаль"],["NSH","Нэшвилл"],
  ["NJD","Нью-Джерси"],["NYI","Айлендерс"],["NYR","Рейнджерс"],["OTT","Оттава"],
  ["PHI","Филадельфия"],["PIT","Питтсбург"],["SJS","Сан-Хосе"],["SEA","Сиэтл"],
  ["STL","Сент-Луис"],["TBL","Тампа-Бэй"],["TOR","Торонто"],["UTA","Юта"],
  ["VAN","Ванкувер"],["VGK","Вегас"],["WSH","Вашингтон"],["WPG","Виннипег"],
];

const TEAM_NAMES = new Map(TEAMS);

export async function handleTelegramMiniAppRequest(request, env, path) {
  if (path === MINI_APP_PATH) {
    if (request.method !== "GET") return json({ ok:false,error:"method_not_allowed" },405);
    return html(APP_HTML);
  }
  if (path === `${MINI_APP_PATH}/app.js`) {
    if (request.method !== "GET") return json({ ok:false,error:"method_not_allowed" },405);
    return js(`(${browserApp.toString()})();`);
  }
  if (path === "/api/telegram-app/bootstrap") {
    if (request.method !== "GET") return json({ ok:false,error:"method_not_allowed" },405);
    return bootstrapRoute(request,env);
  }
  if (path === "/api/telegram-app/schedule") {
    if (request.method !== "GET") return json({ ok:false,error:"method_not_allowed" },405);
    return scheduleRoute(request);
  }
  if (path === "/api/telegram-app/follows") {
    if (request.method === "GET") return followsRoute(request,env);
    if (request.method === "POST") return followWriteRoute(request,env,false);
    if (request.method === "DELETE") return followWriteRoute(request,env,true);
    return json({ ok:false,error:"method_not_allowed" },405);
  }
  if (path === "/api/telegram-app/players") {
    if (request.method !== "GET") return json({ ok:false,error:"method_not_allowed" },405);
    return playersRoute(request,env);
  }
  const playerMatch = /^\/api\/telegram-app\/players\/(\d+)$/.exec(path);
  if (playerMatch) {
    if (request.method !== "GET") return json({ ok:false,error:"method_not_allowed" },405);
    return playerRoute(request,env,Number(playerMatch[1]));
  }
  const gameMatch = /^\/api\/telegram-app\/games\/(\d+)$/.exec(path);
  if (gameMatch) {
    if (request.method !== "GET") return json({ ok:false,error:"method_not_allowed" },405);
    return gameRoute(Number(gameMatch[1]));
  }
  return null;
}

async function bootstrapRoute(request, env) {
  const auth = await telegramAuth(request,env,{ required:false });
  let follows=[];
  if (auth.ok && auth.user && env.DB) {
    await upsertTelegramUser(env.DB,auth.user);
    follows=await userFollows(env.DB,auth.user.id);
  }
  return json({
    ok:true,
    mode:auth.ok&&auth.user?"telegram":"guest",
    user:auth.ok?auth.user:null,
    follows,
    teams:TEAMS.map(([tri,name])=>({tri,name})),
    capabilities:{
      schedule:true,
      live:true,
      follows:Boolean(auth.ok&&auth.user&&env.DB),
      player_cards:Boolean(env.DB),
    },
  });
}

async function scheduleRoute(request) {
  const url=new URL(request.url);
  const date=validDate(url.searchParams.get("date"))||utcDate(new Date());
  try {
    const payload=await fetchNhl(`${NHL_BASE}/schedule/${date}`);
    const games=normalizeScheduleGames(payload,date);
    return json({ok:true,date,games},{cache:"public, max-age=45"});
  } catch (error) {
    console.error("telegram app schedule failed",error);
    return json({ok:false,error:"nhl_schedule_failed"},502);
  }
}

async function gameRoute(gamePk) {
  if (!Number.isSafeInteger(gamePk)||gamePk<=0) return json({ok:false,error:"invalid_game_pk"},400);
  try {
    const [box,pbp]=await Promise.all([
      fetchNhl(`${NHL_BASE}/gamecenter/${gamePk}/boxscore`),
      fetchNhl(`${NHL_BASE}/gamecenter/${gamePk}/play-by-play`),
    ]);
    return json({ok:true,game:normalizeGameDetail(box,pbp)},{cache:"public, max-age=20"});
  } catch (error) {
    console.error("telegram app game failed",error);
    return json({ok:false,error:"nhl_game_failed"},502);
  }
}

async function followsRoute(request,env) {
  if (!env.DB) return json({ok:false,error:"missing_d1_binding"},503);
  const auth=await telegramAuth(request,env,{required:true});
  if (!auth.ok) return json({ok:false,error:auth.error},401);
  await upsertTelegramUser(env.DB,auth.user);
  return json({ok:true,follows:await userFollows(env.DB,auth.user.id)});
}

async function followWriteRoute(request,env,remove) {
  if (!env.DB) return json({ok:false,error:"missing_d1_binding"},503);
  const auth=await telegramAuth(request,env,{required:true});
  if (!auth.ok) return json({ok:false,error:auth.error},401);
  let body={};
  try { body=await request.json(); } catch { return json({ok:false,error:"invalid_json"},400); }
  const subjectType=String(body.subject_type||"").trim().toLowerCase();
  const subjectKey=String(body.subject_key||"").trim().toUpperCase();
  if (!new Set(["team","player","game"]).has(subjectType)||!subjectKey) return json({ok:false,error:"invalid_subject"},400);
  if (!(await validSubject(env.DB,subjectType,subjectKey))) return json({ok:false,error:"subject_not_found"},404);
  await upsertTelegramUser(env.DB,auth.user);
  if (remove) {
    await env.DB.prepare("DELETE FROM subscriptions WHERE telegram_user_id=? AND subject_type=? AND subject_key=?;")
      .bind(auth.user.id,subjectType,subjectKey).run();
  } else {
    const flags=notificationFlags(body);
    await env.DB.prepare(`
      INSERT INTO subscriptions (
        telegram_user_id,subject_type,subject_key,notify_pregame,notify_start,
        notify_goal,notify_assist,notify_period_end,notify_final
      ) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(telegram_user_id,subject_type,subject_key) DO UPDATE SET
        notify_pregame=excluded.notify_pregame,notify_start=excluded.notify_start,
        notify_goal=excluded.notify_goal,notify_assist=excluded.notify_assist,
        notify_period_end=excluded.notify_period_end,notify_final=excluded.notify_final;
    `).bind(auth.user.id,subjectType,subjectKey,flags.pregame,flags.start,flags.goal,flags.assist,flags.period_end,flags.final).run();
  }
  return json({ok:true,removed:remove,follows:await userFollows(env.DB,auth.user.id)});
}

async function playersRoute(request,env) {
  if (!env.DB) return json({ok:false,error:"missing_d1_binding"},503);
  const url=new URL(request.url);
  const team=String(url.searchParams.get("team")||"").trim().toUpperCase();
  const q=String(url.searchParams.get("q")||"").trim();
  const limit=clampInt(url.searchParams.get("limit"),24,1,50);
  try {
    let statement;
    if (team) {
      statement=env.DB.prepare(`
        SELECT p.player_id,p.full_name_en,p.full_name_ru,p.position_code,p.sweater_number,p.current_team_tri,
               r.games,r.goals,r.assists,r.points,r.shots,r.games_with_goal,r.games_with_point,
               r.games_with_2plus_points,r.goals_pg,r.points_pg,r.shots_pg,r.as_of_utc
        FROM player_rolling_snapshots r
        JOIN players p ON p.player_id=r.player_id
        WHERE r.window_key='20' AND r.team_tri=?
          AND (?='' OR p.full_name_en LIKE '%'||?||'%' OR COALESCE(p.full_name_ru,'') LIKE '%'||?||'%')
        ORDER BY r.points_pg DESC,r.goals_pg DESC,r.shots_pg DESC
        LIMIT ?;
      `).bind(team,q,q,q,limit);
    } else {
      statement=env.DB.prepare(`
        SELECT p.player_id,p.full_name_en,p.full_name_ru,p.position_code,p.sweater_number,p.current_team_tri,
               r.games,r.goals,r.assists,r.points,r.shots,r.games_with_goal,r.games_with_point,
               r.games_with_2plus_points,r.goals_pg,r.points_pg,r.shots_pg,r.as_of_utc
        FROM player_rolling_snapshots r
        JOIN players p ON p.player_id=r.player_id
        WHERE r.window_key='20'
          AND (?='' OR p.full_name_en LIKE '%'||?||'%' OR COALESCE(p.full_name_ru,'') LIKE '%'||?||'%')
        ORDER BY r.points_pg DESC,r.goals_pg DESC,r.shots_pg DESC
        LIMIT ?;
      `).bind(q,q,q,limit);
    }
    const result=await statement.all();
    return json({ok:true,team:team||null,players:result.results||[]});
  } catch (error) {
    console.error("telegram app players failed",error);
    return json({ok:false,error:"player_layer_not_ready",players:[]},503);
  }
}

async function playerRoute(request,env,playerId) {
  if (!env.DB) return json({ok:false,error:"missing_d1_binding"},503);
  if (!Number.isSafeInteger(playerId)||playerId<=0) return json({ok:false,error:"invalid_player_id"},400);
  try {
    const [player,rollingR,opponentsR]=await Promise.all([
      env.DB.prepare(`SELECT player_id,full_name_en,full_name_ru,current_team_tri,position_code,sweater_number,shoots_catches FROM players WHERE player_id=? LIMIT 1;`).bind(playerId).first(),
      env.DB.prepare(`SELECT * FROM player_rolling_snapshots WHERE player_id=? ORDER BY CASE window_key WHEN '5' THEN 1 WHEN '10' THEN 2 WHEN '20' THEN 3 ELSE 4 END;`).bind(playerId).all(),
      env.DB.prepare(`SELECT * FROM player_opponent_splits WHERE player_id=? AND scope_key='2Y' AND games>=2 ORDER BY points_pg DESC,games DESC LIMIT 12;`).bind(playerId).all(),
    ]);
    if (!player) return json({ok:false,error:"player_not_found"},404);
    return json({ok:true,player,rolling:rollingR.results||[],opponents:opponentsR.results||[]});
  } catch (error) {
    console.error("telegram app player failed",error);
    return json({ok:false,error:"player_layer_not_ready"},503);
  }
}

async function telegramAuth(request,env,{required}) {
  const initData=String(request.headers.get("x-telegram-init-data")||"").trim();
  if (!initData) return required?{ok:false,error:"missing_telegram_init_data"}:{ok:false,error:"guest"};
  if (!env.TELEGRAM_BOT_TOKEN) return {ok:false,error:"missing_bot_token"};
  try {
    const params=new URLSearchParams(initData);
    const providedHash=params.get("hash")||"";
    const authDate=Number(params.get("auth_date")||0);
    const userRaw=params.get("user")||"";
    params.delete("hash");
    if (!providedHash||!authDate||!userRaw) return {ok:false,error:"invalid_telegram_init_data"};
    const maxAge=clampInt(env.TELEGRAM_WEBAPP_MAX_AGE_SECONDS,86400,300,604800);
    if (Math.abs(Math.floor(Date.now()/1000)-authDate)>maxAge) return {ok:false,error:"telegram_init_data_expired"};
    const dataCheck=[...params.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join("\n");
    const encoder=new TextEncoder();
    const key1=await crypto.subtle.importKey("raw",encoder.encode("WebAppData"),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
    const secret=await crypto.subtle.sign("HMAC",key1,encoder.encode(String(env.TELEGRAM_BOT_TOKEN)));
    const key2=await crypto.subtle.importKey("raw",secret,{name:"HMAC",hash:"SHA-256"},false,["sign"]);
    const digest=await crypto.subtle.sign("HMAC",key2,encoder.encode(dataCheck));
    const calculated=bytesToHex(new Uint8Array(digest));
    if (!(await safeTextEqual(calculated,providedHash.toLowerCase()))) return {ok:false,error:"telegram_signature_invalid"};
    const user=JSON.parse(userRaw);
    const id=Number(user.id);
    if (!Number.isSafeInteger(id)||id<=0) return {ok:false,error:"telegram_user_invalid"};
    return {ok:true,user:{id,username:user.username||null,first_name:user.first_name||null,last_name:user.last_name||null,language_code:user.language_code||null}};
  } catch (error) {
    console.error("telegram init data validation failed",error);
    return {ok:false,error:"telegram_init_data_invalid"};
  }
}

async function upsertTelegramUser(db,user) {
  await db.prepare(`
    INSERT INTO telegram_users (telegram_user_id,username,first_name,last_name,language_code,notifications_enabled,updated_at)
    VALUES (?,?,?,?,?,1,CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_user_id) DO UPDATE SET
      username=excluded.username,first_name=excluded.first_name,last_name=excluded.last_name,
      language_code=excluded.language_code,updated_at=CURRENT_TIMESTAMP;
  `).bind(user.id,user.username,user.first_name,user.last_name,user.language_code).run();
}

async function userFollows(db,userId) {
  const result=await db.prepare(`
    SELECT subscription_id,subject_type,subject_key,notify_pregame,notify_start,notify_goal,
           notify_assist,notify_period_end,notify_final,created_at
    FROM subscriptions WHERE telegram_user_id=? ORDER BY subject_type,subject_key;
  `).bind(userId).all();
  return result.results||[];
}

async function validSubject(db,type,key) {
  if (type==="team") return Boolean(await db.prepare("SELECT 1 FROM teams WHERE tri_code=? LIMIT 1;").bind(key).first());
  if (type==="player"&&!/^\d+$/.test(key)) return false;
  if (type==="game"&&!/^\d+$/.test(key)) return false;
  if (type==="player") return Boolean(await db.prepare("SELECT 1 FROM players WHERE player_id=? LIMIT 1;").bind(Number(key)).first());
  if (type==="game") return Boolean(await db.prepare("SELECT 1 FROM games WHERE game_pk=? LIMIT 1;").bind(Number(key)).first());
  return false;
}

function notificationFlags(body) {
  const b=(key,fallback)=>body[key]===undefined?fallback:Number(Boolean(body[key]));
  return {pregame:b("notify_pregame",1),start:b("notify_start",1),goal:b("notify_goal",1),assist:b("notify_assist",0),period_end:b("notify_period_end",0),final:b("notify_final",1)};
}

async function fetchNhl(url) {
  const response=await fetch(url,{headers:{Accept:"application/json"}});
  if (!response.ok) throw new Error(`NHL HTTP ${response.status}`);
  return response.json();
}

function normalizeScheduleGames(payload,date) {
  let games=Array.isArray(payload?.games)?payload.games:[];
  if (!games.length&&Array.isArray(payload?.gameWeek)) games=payload.gameWeek.flatMap(x=>x.games||[]);
  return games.filter(g=>!g.gameDate||String(g.gameDate)===date).map(g=>{
    const home=g.homeTeam||{},away=g.awayTeam||{};
    const homeTri=String(home.abbrev||"").toUpperCase(),awayTri=String(away.abbrev||"").toUpperCase();
    return {
      game_pk:Number(g.id||g.gameId||g.gamePk),
      start_utc:g.startTimeUTC||null,
      state:String(g.gameState||g.gameStatus||"").toUpperCase(),
      game_type:Number(g.gameType||2),
      home:{tri:homeTri,name:TEAM_NAMES.get(homeTri)||homeTri,score:numberOrNull(home.score),logo:home.logo||null},
      away:{tri:awayTri,name:TEAM_NAMES.get(awayTri)||awayTri,score:numberOrNull(away.score),logo:away.logo||null},
      period:g.periodDescriptor||null,
      clock:g.clock||null,
    };
  }).filter(g=>Number.isSafeInteger(g.game_pk));
}

function normalizeGameDetail(box,pbp) {
  const home=box?.homeTeam||pbp?.homeTeam||{},away=box?.awayTeam||pbp?.awayTeam||{};
  const top=[];
  for (const [side,team] of [["awayTeam",away],["homeTeam",home]]) {
    for (const group of ["forwards","defense","goalies"]) {
      for (const p of box?.playerByGameStats?.[side]?.[group]||[]) {
        const points=Number(p.points||0),goals=Number(p.goals||0),assists=Number(p.assists||0),sog=Number(p.sog||0);
        if (group!=="goalies"&&(points>0||goals>0||sog>0)) top.push({player_id:Number(p.playerId),team_tri:String(team.abbrev||"").toUpperCase(),name:[localized(p.firstName),localized(p.lastName)].filter(Boolean).join(" ")||String(p.playerId),goals,assists,points,shots:sog});
      }
    }
  }
  top.sort((a,b)=>b.points-a.points||b.goals-a.goals||b.shots-a.shots);
  const plays=(pbp?.plays||[]).filter(p=>["goal","penalty","period-end"].includes(p.typeDescKey)).slice(-20).reverse().map(p=>({
    type:p.typeDescKey,period:Number(p.periodDescriptor?.number||0),period_type:p.periodDescriptor?.periodType||null,time:p.timeInPeriod||null,
    team_id:numberOrNull(p.details?.eventOwnerTeamId),home_score:numberOrNull(p.details?.homeScore),away_score:numberOrNull(p.details?.awayScore),
  }));
  return {
    game_pk:Number(box?.id||pbp?.id),state:String(box?.gameState||pbp?.gameState||"").toUpperCase(),start_utc:box?.startTimeUTC||pbp?.startTimeUTC||null,
    home:{tri:String(home.abbrev||"").toUpperCase(),name:TEAM_NAMES.get(String(home.abbrev||"").toUpperCase())||String(home.abbrev||""),score:numberOrNull(home.score),shots:numberOrNull(home.sog),logo:home.logo||null},
    away:{tri:String(away.abbrev||"").toUpperCase(),name:TEAM_NAMES.get(String(away.abbrev||"").toUpperCase())||String(away.abbrev||""),score:numberOrNull(away.score),shots:numberOrNull(away.sog),logo:away.logo||null},
    period:box?.periodDescriptor||pbp?.periodDescriptor||null,clock:box?.clock||pbp?.clock||null,top_players:top.slice(0,8),events:plays,
  };
}

function localized(v){if(!v)return"";if(typeof v==="string")return v;return v.default||v.en||Object.values(v)[0]||""}
function numberOrNull(v){const n=Number(v);return Number.isFinite(n)?n:null}
function clampInt(v,fallback,min,max){const n=Number(v);return Number.isSafeInteger(n)&&n>=min&&n<=max?n:fallback}
function validDate(v){return /^\d{4}-\d{2}-\d{2}$/.test(String(v||""))?String(v):null}
function utcDate(d){return d.toISOString().slice(0,10)}
function bytesToHex(bytes){return [...bytes].map(x=>x.toString(16).padStart(2,"0")).join("")}
async function safeTextEqual(a,b){const e=new TextEncoder();const [da,db]=await Promise.all([crypto.subtle.digest("SHA-256",e.encode(a)),crypto.subtle.digest("SHA-256",e.encode(b))]);const aa=new Uint8Array(da),bb=new Uint8Array(db);let d=0;for(let i=0;i<aa.length;i++)d|=aa[i]^bb[i];return d===0}
function json(payload,statusOrOptions=200){let status=200,cache="no-store";if(typeof statusOrOptions==="number")status=statusOrOptions;else if(statusOrOptions){status=statusOrOptions.status||200;cache=statusOrOptions.cache||cache}return new Response(JSON.stringify(payload),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":cache,"X-Content-Type-Options":"nosniff"}})}
function html(body){return new Response(body,{headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"public, max-age=300","X-Content-Type-Options":"nosniff"}})}
function js(body){return new Response(body,{headers:{"Content-Type":"application/javascript; charset=utf-8","Cache-Control":"public, max-age=300","X-Content-Type-Options":"nosniff"}})}

function browserApp(){
  const tg=window.Telegram?.WebApp||null;
  if(tg){tg.ready();tg.expand();tg.setHeaderColor?.('#0b0b0d');tg.setBackgroundColor?.('#0b0b0d')}
  const initData=tg?.initData||'';
  const state={bootstrap:null,date:new Date().toISOString().slice(0,10),games:[],team:'',query:'',players:[],tab:'games'};
  const $=s=>document.querySelector(s);const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function api(url,opts={}){const headers={...(opts.headers||{})};if(initData)headers['X-Telegram-Init-Data']=initData;if(opts.body&&!headers['Content-Type'])headers['Content-Type']='application/json';const r=await fetch(url,{...opts,headers});const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.error||('HTTP '+r.status));return data}
  async function boot(){try{state.bootstrap=await api('/api/telegram-app/bootstrap');$('#mode').textContent=state.bootstrap.mode==='telegram'?'ПОДКЛЮЧЕНО':'ГОСТЕВОЙ РЕЖИМ';renderTeams();await loadSchedule();}catch(e){showError(e)}}
  function renderTeams(){const select=$('#team');select.innerHTML='<option value="">Все команды</option>'+state.bootstrap.teams.map(t=>`<option value="${t.tri}">${esc(t.name)} · ${t.tri}</option>`).join('')}
  async function loadSchedule(){setBusy('#content','Загружаю матчи…');try{const d=await api('/api/telegram-app/schedule?date='+encodeURIComponent(state.date));state.games=d.games||[];renderGames()}catch(e){showError(e)}}
  function renderGames(){const c=$('#content');if(!state.games.length){c.innerHTML='<div class="empty">В этот день матчей нет</div>';return}c.innerHTML=state.games.map(g=>`<button class="game" data-game="${g.game_pk}"><div class="gtime">${fmtTime(g.start_utc)} <span class="state ${live(g.state)?'live':''}">${stateLabel(g.state)}</span></div><div class="teamrow"><span>${teamLogo(g.away)} <b>${esc(g.away.name)}</b></span><strong>${score(g.away.score)}</strong></div><div class="teamrow"><span>${teamLogo(g.home)} <b>${esc(g.home.name)}</b></span><strong>${score(g.home.score)}</strong></div></button>`).join('');document.querySelectorAll('[data-game]').forEach(b=>b.onclick=()=>openGame(Number(b.dataset.game)))}
  async function openGame(id){const overlay=$('#overlay');overlay.classList.add('open');$('#detail').innerHTML='<div class="empty">Загружаю матч…</div>';try{const d=await api('/api/telegram-app/games/'+id);const g=d.game;$('#detail').innerHTML=`<div class="detailtop"><div><span class="state ${live(g.state)?'live':''}">${stateLabel(g.state)}</span><h2>${esc(g.away.tri)} ${score(g.away.score)} — ${score(g.home.score)} ${esc(g.home.tri)}</h2><p>${esc(g.away.name)} · ${esc(g.home.name)}</p></div><button class="x" id="close">×</button></div><div class="statline"><span>Броски</span><b>${score(g.away.shots)} — ${score(g.home.shots)}</b></div><h3>Лидеры</h3><div class="players">${(g.top_players||[]).map(p=>`<button class="playerline" data-player="${p.player_id}"><span>${esc(p.name)} <small>${esc(p.team_tri)}</small></span><b>${p.goals}+${p.assists} · ${p.points}</b></button>`).join('')||'<div class="empty">Статистика появится после начала матча</div>'}</div>`;$('#close').onclick=()=>overlay.classList.remove('open');document.querySelectorAll('[data-player]').forEach(b=>b.onclick=()=>openPlayer(Number(b.dataset.player)))}catch(e){$('#detail').innerHTML='<div class="empty">'+esc(e.message)+'</div>'}}
  async function loadPlayers(){setBusy('#content','Загружаю игроков…');try{const qs=new URLSearchParams();if(state.team)qs.set('team',state.team);if(state.query)qs.set('q',state.query);const d=await api('/api/telegram-app/players?'+qs.toString());state.players=d.players||[];renderPlayers()}catch(e){$('#content').innerHTML='<div class="empty">Слой игроков будет доступен после ночной загрузки compact-базы.</div>'}}
  function renderPlayers(){const c=$('#content');if(!state.players.length){c.innerHTML='<div class="empty">Игроки не найдены</div>';return}c.innerHTML='<div class="playergrid">'+state.players.map(p=>`<button class="pcard" data-player="${p.player_id}"><div class="phead"><span>${esc(p.current_team_tri||'NHL')} · ${esc(p.position_code||'')}</span><b>${p.sweater_number?'#'+p.sweater_number:''}</b></div><h3>${esc(p.full_name_ru||p.full_name_en)}</h3><div class="numbers"><span><b>${num(p.points_pg,2)}</b><small>очк/м</small></span><span><b>${num(p.goals_pg,2)}</b><small>гол/м</small></span><span><b>${num(p.shots_pg,1)}</b><small>бр/м</small></span></div></button>`).join('')+'</div>';document.querySelectorAll('[data-player]').forEach(b=>b.onclick=()=>openPlayer(Number(b.dataset.player)))}
  async function openPlayer(id){const overlay=$('#overlay');overlay.classList.add('open');$('#detail').innerHTML='<div class="empty">Загружаю игрока…</div>';try{const d=await api('/api/telegram-app/players/'+id);const p=d.player;const follow=state.bootstrap?.follows?.some(f=>f.subject_type==='player'&&String(f.subject_key)===String(id));$('#detail').innerHTML=`<div class="detailtop"><div><span class="state">${esc(p.current_team_tri||'NHL')} · ${esc(p.position_code||'')}</span><h2>${esc(p.full_name_ru||p.full_name_en)}</h2><p>${p.sweater_number?'#'+p.sweater_number+' · ':''}rolling + против соперников</p></div><button class="x" id="close">×</button></div><button class="follow ${follow?'on':''}" id="follow">${follow?'✓ Вы подписаны':'＋ Подписаться'}</button><h3>Форма</h3><div class="roll">${(d.rolling||[]).filter(r=>['5','10','20'].includes(String(r.window_key))).map(r=>`<div><b>${r.window_key} матчей</b><span>${num(r.points_pg,2)} очк/м · ${num(r.goals_pg,2)} гол/м · ${num(r.shots_pg,1)} броска</span></div>`).join('')}</div><h3>Лучшие splits против команд</h3><div class="roll">${(d.opponents||[]).map(r=>`<div><b>vs ${esc(r.opponent_tri)} · ${r.games} игр</b><span>${num(r.points_pg,2)} очк/м · ${r.games_with_point}/${r.games} с очками</span></div>`).join('')||'<div class="empty">Недостаточно матчей</div>'}</div>`;$('#close').onclick=()=>overlay.classList.remove('open');$('#follow').onclick=()=>toggleFollow('player',String(id),follow)}catch(e){$('#detail').innerHTML='<div class="empty">'+esc(e.message)+'</div>'}}
  async function toggleFollow(type,key,remove){if(!initData){tg?.showAlert?.('Откройте приложение из Telegram-бота, чтобы подписываться.');return}try{const d=await api('/api/telegram-app/follows',{method:remove?'DELETE':'POST',body:JSON.stringify({subject_type:type,subject_key:key})});state.bootstrap.follows=d.follows||[];if(type==='player')openPlayer(Number(key))}catch(e){tg?.showAlert?.('Не удалось изменить подписку: '+e.message)}}
  async function showFollows(){const list=state.bootstrap?.follows||[];const c=$('#content');if(!list.length){c.innerHTML='<div class="empty">Пока нет подписок. Откройте игрока и нажмите «Подписаться».</div>';return}c.innerHTML='<div class="followlist">'+list.map(f=>`<div><b>${esc(f.subject_type.toUpperCase())}</b><span>${esc(f.subject_key)}</span></div>`).join('')+'</div>'}
  function setTab(tab){state.tab=tab;document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));$('#filters').style.display=tab==='players'?'grid':'none';$('#datebar').style.display=tab==='games'?'flex':'none';if(tab==='games')renderGames();if(tab==='players')loadPlayers();if(tab==='follows')showFollows()}
  function showError(e){$('#content').innerHTML='<div class="empty">Ошибка: '+esc(e.message)+'</div>'}function setBusy(sel,t){$(sel).innerHTML='<div class="empty">'+t+'</div>'}function fmtTime(v){if(!v)return'—';return new Date(v).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})}function stateLabel(s){return live(s)?'LIVE':(['FINAL','OFF'].includes(s)?'FINAL':'СКОРО')}function live(s){return ['LIVE','CRIT','INTERMISSION'].includes(String(s||'').toUpperCase())}function score(v){return v===null||v===undefined?'—':v}function teamLogo(t){return t.logo?`<img class="miniLogo" src="${esc(t.logo)}" alt="">`:`<span class="tri">${esc(t.tri)}</span>`}function num(v,d){const n=Number(v);return Number.isFinite(n)?n.toFixed(d):'—'}
  document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>setTab(b.dataset.tab));$('#prev').onclick=()=>{const d=new Date(state.date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()-1);state.date=d.toISOString().slice(0,10);$('#date').textContent=state.date;loadSchedule()};$('#next').onclick=()=>{const d=new Date(state.date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+1);state.date=d.toISOString().slice(0,10);$('#date').textContent=state.date;loadSchedule()};$('#team').onchange=e=>{state.team=e.target.value;loadPlayers()};$('#q').oninput=e=>{state.query=e.target.value;clearTimeout(window.__q);window.__q=setTimeout(loadPlayers,250)};$('#overlay').onclick=e=>{if(e.target.id==='overlay')e.currentTarget.classList.remove('open')};$('#date').textContent=state.date;$('#filters').style.display='none';boot();
}

const APP_HTML=`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>HOH NHL Live</title><script src="https://telegram.org/js/telegram-web-app.js"></script><style>
:root{--bg:#0b0b0d;--card:#141416;--line:#27272c;--text:#f6f5f3;--muted:#797980;--orange:#ff5a1f;--lav:#c8b7ff;--green:#78dfab}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,Arial,sans-serif;min-height:100vh}.wrap{max-width:720px;margin:auto;padding:16px 14px 90px}.brand{display:flex;align-items:center;justify-content:space-between;margin:4px 2px 18px}.logoText{font-weight:950;letter-spacing:-.03em}.logoText i{color:var(--orange);font-style:normal}.mode{font-size:9px;letter-spacing:.1em;color:var(--lav);border:1px solid #34313b;border-radius:99px;padding:5px 8px}.tabs{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;background:#101012;border:1px solid var(--line);padding:5px;border-radius:14px;position:sticky;top:6px;z-index:5}.tab{border:0;border-radius:10px;background:transparent;color:#777;padding:10px 5px;font-weight:900;font-size:11px}.tab.active{background:#242126;color:#fff}.datebar{display:flex;align-items:center;justify-content:space-between;margin:14px 0 10px}.datebar button,.x{border:1px solid var(--line);background:#151517;color:#fff;border-radius:10px;width:38px;height:34px}.date{font-size:11px;font-weight:900;letter-spacing:.08em}.filters{grid-template-columns:120px 1fr;gap:8px;margin:14px 0 10px}.filters select,.filters input{width:100%;border:1px solid var(--line);background:#141416;color:#fff;border-radius:11px;padding:11px;font-size:12px;outline:none}.game{width:100%;text-align:left;border:1px solid var(--line);background:linear-gradient(135deg,#151517,#101012);border-radius:16px;color:#fff;padding:13px 14px;margin:0 0 8px}.gtime{font-size:10px;color:var(--muted);margin-bottom:9px}.state{font-size:8px;font-weight:950;letter-spacing:.08em;border:1px solid #34343a;border-radius:5px;padding:3px 5px;color:#999}.state.live{color:#fff;background:#d43f34;border-color:#d43f34}.teamrow{display:flex;align-items:center;justify-content:space-between;font-size:13px;padding:5px 0}.teamrow span{display:flex;align-items:center;gap:8px}.teamrow strong{font-size:21px}.miniLogo{width:25px;height:25px;object-fit:contain}.tri{display:grid;place-items:center;width:25px;height:25px;background:#242429;border-radius:7px;font-size:8px}.empty{padding:28px 14px;text-align:center;color:#75757d;font-size:12px}.playergrid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.pcard{border:1px solid var(--line);background:#141416;color:#fff;border-radius:15px;padding:12px;text-align:left}.phead{display:flex;justify-content:space-between;color:#777;font-size:9px}.pcard h3{font-size:13px;margin:10px 0 14px;line-height:1.15}.numbers{display:grid;grid-template-columns:repeat(3,1fr);gap:4px}.numbers span{display:flex;flex-direction:column}.numbers b{font-size:15px}.numbers small{font-size:7px;color:#696970;margin-top:3px}.overlay{position:fixed;inset:0;background:rgba(0,0,0,.72);display:none;z-index:20}.overlay.open{display:block}.sheet{position:absolute;left:0;right:0;bottom:0;max-height:88vh;overflow:auto;background:#111113;border-top:1px solid #34343a;border-radius:22px 22px 0 0;padding:18px 16px calc(20px + env(safe-area-inset-bottom))}.detailtop{display:flex;justify-content:space-between;gap:10px}.detailtop h2{font-size:24px;letter-spacing:-.04em;margin:10px 0 4px}.detailtop p{font-size:10px;color:#777;margin:0}.statline{display:flex;justify-content:space-between;border:1px solid var(--line);border-radius:12px;padding:11px 12px;margin:18px 0;font-size:12px}.sheet h3{font-size:10px;color:var(--lav);letter-spacing:.1em;text-transform:uppercase;margin:20px 0 8px}.playerline{display:flex;width:100%;justify-content:space-between;border:0;border-bottom:1px solid #25252a;background:transparent;color:#fff;padding:10px 0;text-align:left}.playerline small{color:#777}.roll>div,.followlist>div{display:flex;justify-content:space-between;gap:10px;padding:10px 0;border-bottom:1px solid #242429;font-size:10px}.roll span,.followlist span{color:#777;text-align:right}.follow{width:100%;border:1px solid #45372f;background:rgba(255,90,31,.1);color:#ff7b4c;border-radius:12px;padding:12px;font-weight:900;margin:16px 0}.follow.on{border-color:#28513c;background:rgba(120,223,171,.08);color:var(--green)}@media(max-width:420px){.playergrid{grid-template-columns:1fr}}
</style></head><body><div class="wrap"><div class="brand"><div class="logoText">HOME OF <i>HOCKEY</i> · NHL LIVE</div><div class="mode" id="mode">…</div></div><div class="tabs"><button class="tab active" data-tab="games">Матчи</button><button class="tab" data-tab="players">Игроки</button><button class="tab" data-tab="follows">Подписки</button></div><div class="datebar" id="datebar"><button id="prev">‹</button><div class="date" id="date"></div><button id="next">›</button></div><div class="filters" id="filters"><select id="team"></select><input id="q" placeholder="Поиск игрока"></div><main id="content"><div class="empty">Загрузка…</div></main></div><div class="overlay" id="overlay"><div class="sheet" id="detail"></div></div><script src="/telegram-app/app.js"></script></body></html>`;
