const PATH = "/telegram-app";

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

export function handleTelegramCenterUi(request, path, env = {}) {
  if (path === PATH) {
    if (request.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);
    return new Response(APP_HTML, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate",
        Pragma: "no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  if (path === "/api/telegram-app/bootstrap") {
    if (request.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);
    return centerBootstrap(request, env);
  }
  if (path === "/api/me/subscriptions" && request.method === "GET") {
    return centerSubscriptions(request, env);
  }
  return null;
}

async function centerBootstrap(request, env) {
  const auth = await centerTelegramAuth(request, env, false);
  return json({
    ok: true,
    mode: auth.ok ? "telegram" : "guest",
    user: auth.ok ? auth.user : null,
    auth_error: auth.ok ? null : auth.error,
    teams: TEAMS.map(([tri, name]) => ({ tri, name })),
    capabilities: {
      schedule: true,
      live: true,
      follows: Boolean(auth.ok && env.DB),
      player_cards: Boolean(env.DB),
    },
  });
}

async function centerSubscriptions(request, env) {
  if (!env.DB) return json({ ok: false, error: "missing_d1_binding" }, 503);
  const auth = await centerTelegramAuth(request, env, true);
  if (!auth.ok) return json({ ok: false, error: auth.error }, 401);
  try {
    const result = await env.DB.prepare(`
      SELECT s.subscription_id,s.subject_type,s.subject_key,
             s.notify_pregame,s.notify_start,s.notify_goal,s.notify_assist,
             s.notify_point,s.notify_period_end,s.notify_final,
             CASE s.subject_type
               WHEN 'player' THEN COALESCE(p.full_name_ru,p.full_name_en,s.subject_key)
               WHEN 'team' THEN COALESCE(t.name_ru,t.name_en,s.subject_key)
               WHEN 'game' THEN COALESCE(g.away_tri||' — '||g.home_tri,'Game #'||s.subject_key)
               ELSE s.subject_key
             END AS name
      FROM subscriptions s
      LEFT JOIN players p ON s.subject_type='player' AND p.player_id=CAST(s.subject_key AS INTEGER)
      LEFT JOIN teams t ON s.subject_type='team' AND t.tri_code=s.subject_key
      LEFT JOIN games g ON s.subject_type='game' AND g.game_pk=CAST(s.subject_key AS INTEGER)
      WHERE s.telegram_user_id=?
      ORDER BY CASE s.subject_type WHEN 'player' THEN 1 WHEN 'team' THEN 2 ELSE 3 END,s.subject_key;
    `).bind(auth.user.id).all();
    return json({ subscriptions: (result.results || []).map(serializeSubscription) });
  } catch (error) {
    console.error("telegram center subscriptions failed", error);
    return json({ ok: false, error: "subscription_layer_not_ready", subscriptions: [] }, 503);
  }
}

async function centerTelegramAuth(request, env, required) {
  const initData = String(request.headers.get("x-telegram-init-data") || "").trim();
  if (!initData) return required ? { ok: false, error: "missing_telegram_init_data" } : { ok: false, error: "guest" };
  const token = String(env.TELEGRAM_CENTER_BOT_TOKEN || "").trim();
  if (!token) return { ok: false, error: "missing_telegram_center_token" };
  try {
    const params = new URLSearchParams(initData);
    const providedHash = params.get("hash") || "";
    const authDate = Number(params.get("auth_date") || 0);
    const userRaw = params.get("user") || "";
    params.delete("hash");
    if (!providedHash || !authDate || !userRaw) return { ok: false, error: "invalid_telegram_init_data" };
    const maxAgeRaw = Number(env.TELEGRAM_WEBAPP_MAX_AGE_SECONDS || 86400);
    const maxAge = Number.isFinite(maxAgeRaw) ? Math.min(604800, Math.max(300, Math.floor(maxAgeRaw))) : 86400;
    if (Math.abs(Math.floor(Date.now() / 1000) - authDate) > maxAge) return { ok: false, error: "telegram_init_data_expired" };
    const dataCheck = [...params.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join("\n");
    const encoder = new TextEncoder();
    const key1 = await crypto.subtle.importKey("raw", encoder.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const secret = await crypto.subtle.sign("HMAC", key1, encoder.encode(token));
    const key2 = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const digest = await crypto.subtle.sign("HMAC", key2, encoder.encode(dataCheck));
    const calculated = bytesToHex(new Uint8Array(digest));
    if (!(await safeTextEqual(calculated, providedHash.toLowerCase()))) return { ok: false, error: "telegram_signature_invalid" };
    const user = JSON.parse(userRaw);
    const id = Number(user.id);
    if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, error: "telegram_user_invalid" };
    return { ok: true, user: { id, username: user.username || null, first_name: user.first_name || null, last_name: user.last_name || null, language_code: user.language_code || null } };
  } catch (error) {
    console.error("telegram center init data validation failed", error);
    return { ok: false, error: "telegram_init_data_invalid" };
  }
}

function serializeSubscription(row) {
  const type = String(row.subject_type || "");
  const candidates = type === "player"
    ? [["goal","notify_goal"],["assist","notify_assist"],["point","notify_point"]]
    : type === "team"
      ? [["start","notify_start"],["goal","notify_goal"],["final","notify_final"]]
      : [["pregame","notify_pregame"],["start","notify_start"],["goal","notify_goal"],["period_end","notify_period_end"],["final","notify_final"]];
  return {
    id: Number(row.subscription_id),
    type,
    entity_id: String(row.subject_key || ""),
    name: String(row.name || row.subject_key || ""),
    events: candidates.filter(([,column]) => Number(row[column]) === 1).map(([event]) => event),
  };
}

async function safeTextEqual(a, b) {
  const encoder = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(String(a))),
    crypto.subtle.digest("SHA-256", encoder.encode(String(b))),
  ]);
  const aa = new Uint8Array(da);
  const bb = new Uint8Array(db);
  let diff = aa.length ^ bb.length;
  const length = Math.min(aa.length, bb.length);
  for (let index = 0; index < length; index += 1) diff |= aa[index] ^ bb[index];
  return diff === 0;
}

function bytesToHex(bytes) {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

const APP_HTML = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>HOH NHL Center</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
:root{--bg:#09090b;--card:#141416;--line:#2a2a30;--text:#f8f7f4;--muted:#85858e;--orange:#ff5a1f;--lav:#c7b7ff;--green:#7ee0ad}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,Arial,sans-serif;min-height:100vh}.app{max-width:720px;margin:auto;padding:16px 12px calc(90px + env(safe-area-inset-bottom))}.brand{display:flex;justify-content:space-between;align-items:center;margin:2px 2px 16px}.brand b{font-size:18px;letter-spacing:-.04em}.brand i{font-style:normal;color:var(--orange)}.mode{font-size:9px;color:var(--lav);border:1px solid #36333f;border-radius:99px;padding:5px 8px}.tabs{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;padding:4px;background:#111113;border:1px solid var(--line);border-radius:14px;position:sticky;top:6px;z-index:4}.tab{border:0;background:transparent;color:#777780;border-radius:10px;padding:10px 2px;font-size:10px;font-weight:900}.tab.active{background:#2a252d;color:#fff}.toolbar{display:flex;align-items:center;justify-content:space-between;margin:12px 0 8px}.toolbar button{height:34px;min-width:38px;border:1px solid var(--line);border-radius:10px;background:#151517;color:#fff}.toolbar strong{font-size:11px;letter-spacing:.05em}.content{display:grid;gap:8px}.card{border:1px solid var(--line);background:linear-gradient(135deg,#151517,#111113);border-radius:15px;padding:13px}.empty{color:var(--muted);text-align:center;padding:36px 12px;font-size:11px}.error{color:#f09a9a}.gameHead,.row{display:flex;align-items:center;justify-content:space-between;gap:10px}.gameHead{color:var(--muted);font-size:9px;margin-bottom:7px}.team{display:flex;align-items:center;justify-content:space-between;padding:6px 0}.team span{display:flex;align-items:center;gap:9px}.team img{width:30px;height:30px;object-fit:contain}.tri{display:grid;place-items:center;width:30px;height:30px;background:#25252a;border-radius:8px;font-size:8px}.team b{font-size:12px}.team strong{font-size:19px}.pill{font-size:8px;border:1px solid #36363d;border-radius:6px;padding:3px 6px}.pill.live{background:#b63d32;border-color:#b63d32}.list{display:grid;gap:7px}.row.card{width:100%;color:#fff;text-align:left}.row small{color:var(--muted);display:block;margin-top:3px}.row strong{color:var(--lav)}.filters{display:flex;gap:7px;margin:12px 0}.filters input,.filters select{min-width:0;flex:1;background:#141416;border:1px solid var(--line);color:#fff;border-radius:10px;padding:10px}.status{font-size:9px;color:var(--muted);margin:10px 2px}.status.ok{color:var(--green)}.retry{border:1px solid #543727;background:#211510;color:#ff956e;border-radius:10px;padding:9px 12px;font-weight:800}.hidden{display:none!important}@media(max-width:420px){.brand b{font-size:16px}.tab{font-size:9px}}
</style>
</head>
<body>
<div class="app">
  <div class="brand"><b>HOME OF <i>HOCKEY</i> · NHL CENTER</b><span class="mode" id="mode">START</span></div>
  <nav class="tabs">
    <button class="tab active" data-tab="games">Матчи</button>
    <button class="tab" data-tab="teams">Команды</button>
    <button class="tab" data-tab="players">Игроки</button>
    <button class="tab" data-tab="follows">Мои</button>
  </nav>
  <div class="toolbar" id="datebar"><button id="prev">‹</button><strong id="date"></strong><button id="next">›</button></div>
  <div class="filters hidden" id="playerFilters"><select id="teamSelect"><option value="">Все команды</option></select><input id="playerSearch" placeholder="Поиск игрока"></div>
  <div class="status" id="status">Запуск приложения…</div>
  <main class="content" id="content"><div class="empty">Загрузка…</div></main>
</div>
<script>
(function(){
  'use strict';
  const tg=window.Telegram&&window.Telegram.WebApp?window.Telegram.WebApp:null;
  try{if(tg){tg.ready();tg.expand();if(tg.setHeaderColor)tg.setHeaderColor('#09090b');if(tg.setBackgroundColor)tg.setBackgroundColor('#09090b')}}catch(_e){}
  const initData=tg&&tg.initData?tg.initData:'';
  const state={tab:'games',date:localDate(),bootstrap:null,games:[],teams:[],players:[],playerTeam:'',playerQuery:''};
  const el=id=>document.getElementById(id);
  const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function localDate(){const d=new Date();const off=d.getTimezoneOffset()*60000;return new Date(d.getTime()-off).toISOString().slice(0,10)}
  function setStatus(text,ok){el('status').textContent=text;el('status').className='status'+(ok?' ok':'')}
  function showError(e){el('content').innerHTML='<div class="empty error">Ошибка загрузки: '+esc(e&&e.message?e.message:e)+'<br><br><button class="retry" id="retry">Повторить</button></div>';const b=el('retry');if(b)b.onclick=()=>loadCurrent()}
  async function api(url,opts){opts=opts||{};const headers=Object.assign({},opts.headers||{});if(initData)headers['X-Telegram-Init-Data']=initData;if(opts.body&&!headers['Content-Type'])headers['Content-Type']='application/json';const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),12000);try{const r=await fetch(url,Object.assign({},opts,{headers:headers,cache:'no-store',signal:controller.signal}));const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.error||('HTTP '+r.status));return data}finally{clearTimeout(timer)}}
  function setTab(tab){state.tab=tab;document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));el('datebar').classList.toggle('hidden',tab!=='games');el('playerFilters').classList.toggle('hidden',tab!=='players');loadCurrent()}
  async function loadCurrent(){if(state.tab==='games')return loadGames();if(state.tab==='teams')return loadTeams();if(state.tab==='players')return loadPlayers();return loadMine()}
  async function bootstrap(){
    el('date').textContent=state.date;
    setStatus('Подключение к HOH NHL Center…');
    try{
      const b=await api('/api/telegram-app/bootstrap');state.bootstrap=b;
      el('mode').textContent=b.mode==='telegram'?'TELEGRAM':'ГОСТЬ';
      if(Array.isArray(b.teams)){el('teamSelect').innerHTML='<option value="">Все команды</option>'+b.teams.map(t=>'<option value="'+esc(t.tri)+'">'+esc(t.name)+' · '+esc(t.tri)+'</option>').join('')}
      setStatus('Center подключён',true);
      await loadGames();
    }catch(e){setStatus('Backend недоступен');showError(e)}
  }
  async function loadGames(){el('content').innerHTML='<div class="empty">Загружаю матчи…</div>';try{const d=await api('/api/telegram-app/schedule?date='+encodeURIComponent(state.date));state.games=d.games||[];if(!state.games.length){el('content').innerHTML='<div class="empty">На этот день матчей нет</div>';return}el('content').innerHTML=state.games.map(gameCard).join('')}catch(e){showError(e)}}
  function gameCard(g){const live=['LIVE','CRIT','INTERMISSION'].includes(String(g.state||'').toUpperCase());const label=live?'LIVE':['FINAL','OFF'].includes(String(g.state||'').toUpperCase())?'FINAL':'СКОРО';return '<section class="card"><div class="gameHead"><span>'+fmtTime(g.start_utc)+'</span><span class="pill '+(live?'live':'')+'">'+label+'</span></div>'+teamLine(g.away)+teamLine(g.home)+'</section>'}
  function teamLine(t){t=t||{};return '<div class="team"><span>'+(t.logo?'<img src="'+esc(t.logo)+'" alt="">':'<i class="tri">'+esc(t.tri||'NHL')+'</i>')+'<b>'+esc(t.name||t.tri||'NHL')+'</b></span><strong>'+(t.score==null?'—':esc(t.score))+'</strong></div>'}
  async function loadTeams(){el('content').innerHTML='<div class="empty">Загружаю команды…</div>';try{const d=await api('/api/telegram-app/teams?window=20');state.teams=d.teams||[];if(!state.teams.length){el('content').innerHTML='<div class="empty">Данные команд пока не загружены</div>';return}el('content').innerHTML='<div class="list">'+state.teams.map(t=>'<div class="row card"><div><b>'+esc(t.name_ru||t.name_en||t.team_tri)+'</b><small>'+esc(t.team_tri)+' · последние 20 матчей</small></div><strong>#'+esc(t.rank_goal_diff==null?'—':t.rank_goal_diff)+'</strong></div>').join('')+'</div>'}catch(e){showError(e)}}
  async function loadPlayers(){el('content').innerHTML='<div class="empty">Загружаю игроков…</div>';try{const q=new URLSearchParams();if(state.playerTeam)q.set('team',state.playerTeam);if(state.playerQuery)q.set('q',state.playerQuery);q.set('limit','40');const d=await api('/api/telegram-app/players?'+q.toString());state.players=d.players||[];if(!state.players.length){el('content').innerHTML='<div class="empty">Игроки не найдены</div>';return}el('content').innerHTML='<div class="list">'+state.players.map(p=>'<div class="row card"><div><b>'+esc(p.full_name_ru||p.full_name_en)+'</b><small>'+esc(p.current_team_tri||'NHL')+' · '+esc(p.position_code||'')+(p.sweater_number?' · #'+esc(p.sweater_number):'')+'</small></div><strong>'+formatNumber(p.points_pg)+'</strong></div>').join('')+'</div>'}catch(e){showError(e)}}
  async function loadMine(){if(!initData){el('content').innerHTML='<div class="empty">Откройте Center из Telegram-бота, чтобы увидеть подписки.</div>';return}el('content').innerHTML='<div class="empty">Загружаю подписки…</div>';try{const d=await api('/api/me/subscriptions');const list=d.subscriptions||[];if(!list.length){el('content').innerHTML='<div class="empty">Подписок пока нет</div>';return}el('content').innerHTML='<div class="list">'+list.map(s=>'<div class="row card"><div><b>'+esc(s.name||s.entity_id||s.subject_key)+'</b><small>'+esc(s.type||s.subject_type||'')+'</small></div><strong>✓</strong></div>').join('')+'</div>'}catch(e){showError(e)}}
  function formatNumber(v){const n=Number(v);return Number.isFinite(n)?n.toFixed(2):'—'}
  function fmtTime(v){if(!v)return '—';try{return new Date(v).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})}catch(_e){return '—'}}
  document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>setTab(b.dataset.tab));
  el('prev').onclick=()=>{const d=new Date(state.date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()-1);state.date=d.toISOString().slice(0,10);el('date').textContent=state.date;loadGames()};
  el('next').onclick=()=>{const d=new Date(state.date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+1);state.date=d.toISOString().slice(0,10);el('date').textContent=state.date;loadGames()};
  el('teamSelect').onchange=e=>{state.playerTeam=e.target.value;loadPlayers()};
  el('playerSearch').oninput=e=>{state.playerQuery=e.target.value;clearTimeout(window.__hohSearch);window.__hohSearch=setTimeout(loadPlayers,300)};
  window.addEventListener('error',e=>{setStatus('Ошибка интерфейса');if(el('content')&&el('content').textContent.indexOf('Загрузка')>=0)showError(e.error||e.message||'JavaScript error')});
  bootstrap();
})();
</script>
</body>
</html>`;

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
