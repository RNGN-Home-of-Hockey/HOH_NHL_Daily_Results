const CONTROL_PATH="/control";

export async function handleControlCenterRequest(request,env,path){
  if(path===CONTROL_PATH){if(request.method!=="GET")return json({ok:false,error:"method_not_allowed"},405);return html(CONTROL_HTML)}
  if(path===`${CONTROL_PATH}/app.js`){if(request.method!=="GET")return json({ok:false,error:"method_not_allowed"},405);return js(`(${browserApp.toString()})();`)}
  if(path==="/api/control/overview"){if(request.method!=="GET")return json({ok:false,error:"method_not_allowed"},405);return overviewRoute(env)}
  if(path==="/api/control/games"){if(request.method!=="GET")return json({ok:false,error:"method_not_allowed"},405);return gamesRoute(request,env)}
  if(path==="/api/control/players"){if(request.method!=="GET")return json({ok:false,error:"method_not_allowed"},405);return playersRoute(request,env)}
  const pm=/^\/api\/control\/players\/(\d+)$/.exec(path);if(pm){if(request.method!=="GET")return json({ok:false,error:"method_not_allowed"},405);return playerRoute(env,Number(pm[1]))}
  if(path==="/api/control/telegram"){if(request.method!=="GET")return json({ok:false,error:"method_not_allowed"},405);return telegramStatsRoute(env)}
  return null;
}

async function overviewRoute(env){
  if(!env.DB)return json({ok:false,error:"missing_d1_binding"},503);
  try{
    const [counts,gamesR,compact]=await Promise.all([
      env.DB.prepare(`SELECT (SELECT COUNT(*) FROM teams) teams,(SELECT COUNT(*) FROM players) players,(SELECT COUNT(*) FROM games WHERE game_type IN (2,3)) games;`).first(),
      env.DB.prepare(`
        SELECT g.game_pk,g.scheduled_start_utc,g.game_state,g.game_type,g.home_tri,g.away_tri,g.home_score,g.away_score,
               ht.name_ru home_name_ru,ht.name_en home_name,ht.logo_url home_logo,
               at.name_ru away_name_ru,at.name_en away_name,at.logo_url away_logo
        FROM games g LEFT JOIN teams ht ON ht.tri_code=g.home_tri LEFT JOIN teams at ON at.tri_code=g.away_tri
        WHERE g.game_type IN (2,3) ORDER BY g.scheduled_start_utc DESC LIMIT 12;
      `).all(),
      compactCounts(env.DB),
    ]);
    return json({ok:true,counts:{teams:Number(counts?.teams||0),players:Number(counts?.players||0),games:Number(counts?.games||0),...compact},games:gamesR.results||[]});
  }catch(error){console.error("control overview failed",error);return json({ok:false,error:"control_overview_failed"},500)}
}

async function compactCounts(db){
  try{
    const row=await db.prepare(`SELECT
      (SELECT COUNT(*) FROM player_rolling_snapshots WHERE window_key='20') player_windows,
      (SELECT COUNT(*) FROM player_opponent_splits WHERE scope_key='2Y') player_splits,
      (SELECT COUNT(*) FROM goalie_rolling_snapshots WHERE window_key='20') goalie_windows,
      (SELECT COUNT(*) FROM pregame_team_snapshots WHERE window_games=20) team_snapshots;`).first();
    return {player_windows:Number(row?.player_windows||0),player_splits:Number(row?.player_splits||0),goalie_windows:Number(row?.goalie_windows||0),team_snapshots:Number(row?.team_snapshots||0),compact_ready:true};
  }catch{return {player_windows:0,player_splits:0,goalie_windows:0,team_snapshots:0,compact_ready:false}}
}

async function gamesRoute(request,env){
  if(!env.DB)return json({ok:false,error:"missing_d1_binding"},503);
  const url=new URL(request.url);const limit=clamp(url.searchParams.get("limit"),60,1,100);const team=String(url.searchParams.get("team")||"").trim().toUpperCase();
  try{
    const statement=team?env.DB.prepare(`
      SELECT g.game_pk,g.scheduled_start_utc,g.game_state,g.game_type,g.home_tri,g.away_tri,g.home_score,g.away_score,g.period_type,
             ht.name_ru home_name_ru,ht.name_en home_name,ht.logo_url home_logo,at.name_ru away_name_ru,at.name_en away_name,at.logo_url away_logo
      FROM games g LEFT JOIN teams ht ON ht.tri_code=g.home_tri LEFT JOIN teams at ON at.tri_code=g.away_tri
      WHERE g.game_type IN (2,3) AND (g.home_tri=? OR g.away_tri=?) ORDER BY g.scheduled_start_utc DESC LIMIT ?;
    `).bind(team,team,limit):env.DB.prepare(`
      SELECT g.game_pk,g.scheduled_start_utc,g.game_state,g.game_type,g.home_tri,g.away_tri,g.home_score,g.away_score,g.period_type,
             ht.name_ru home_name_ru,ht.name_en home_name,ht.logo_url home_logo,at.name_ru away_name_ru,at.name_en away_name,at.logo_url away_logo
      FROM games g LEFT JOIN teams ht ON ht.tri_code=g.home_tri LEFT JOIN teams at ON at.tri_code=g.away_tri
      WHERE g.game_type IN (2,3) ORDER BY g.scheduled_start_utc DESC LIMIT ?;
    `).bind(limit);
    const r=await statement.all();return json({ok:true,games:r.results||[]});
  }catch(error){console.error("control games failed",error);return json({ok:false,error:"control_games_failed"},500)}
}

async function playersRoute(request,env){
  if(!env.DB)return json({ok:false,error:"missing_d1_binding"},503);
  const url=new URL(request.url);const team=String(url.searchParams.get("team")||"").trim().toUpperCase();const q=String(url.searchParams.get("q")||"").trim();const limit=clamp(url.searchParams.get("limit"),80,1,100);
  try{
    const query=team?`
      SELECT p.player_id,p.full_name_en,p.full_name_ru,p.current_team_tri,p.position_code,p.sweater_number,
             r.games,r.goals,r.assists,r.points,r.shots,r.goals_pg,r.points_pg,r.shots_pg,r.games_with_goal,r.games_with_point,r.games_with_2plus_points,r.as_of_utc
      FROM player_rolling_snapshots r JOIN players p ON p.player_id=r.player_id
      WHERE r.window_key='20' AND r.team_tri=? AND (?='' OR p.full_name_en LIKE '%'||?||'%' OR COALESCE(p.full_name_ru,'') LIKE '%'||?||'%')
      ORDER BY r.points_pg DESC,r.goals_pg DESC,r.shots_pg DESC LIMIT ?;`:`
      SELECT p.player_id,p.full_name_en,p.full_name_ru,p.current_team_tri,p.position_code,p.sweater_number,
             r.games,r.goals,r.assists,r.points,r.shots,r.goals_pg,r.points_pg,r.shots_pg,r.games_with_goal,r.games_with_point,r.games_with_2plus_points,r.as_of_utc
      FROM player_rolling_snapshots r JOIN players p ON p.player_id=r.player_id
      WHERE r.window_key='20' AND (?='' OR p.full_name_en LIKE '%'||?||'%' OR COALESCE(p.full_name_ru,'') LIKE '%'||?||'%')
      ORDER BY r.points_pg DESC,r.goals_pg DESC,r.shots_pg DESC LIMIT ?;`;
    const st=team?env.DB.prepare(query).bind(team,q,q,q,limit):env.DB.prepare(query).bind(q,q,q,limit);const r=await st.all();return json({ok:true,players:r.results||[]});
  }catch(error){console.error("control players compact layer not ready",error);return json({ok:false,error:"compact_player_layer_not_ready",players:[]},503)}
}

async function playerRoute(env,id){
  if(!env.DB)return json({ok:false,error:"missing_d1_binding"},503);if(!Number.isSafeInteger(id)||id<=0)return json({ok:false,error:"invalid_player_id"},400);
  try{
    const [p,r,o,g,go]=await Promise.all([
      env.DB.prepare(`SELECT player_id,full_name_en,full_name_ru,current_team_tri,position_code,sweater_number,shoots_catches FROM players WHERE player_id=?;`).bind(id).first(),
      env.DB.prepare(`SELECT * FROM player_rolling_snapshots WHERE player_id=? ORDER BY CASE window_key WHEN '5' THEN 1 WHEN '10' THEN 2 WHEN '20' THEN 3 ELSE 4 END;`).bind(id).all(),
      env.DB.prepare(`SELECT * FROM player_opponent_splits WHERE player_id=? AND scope_key='2Y' ORDER BY points_pg DESC,games DESC LIMIT 20;`).bind(id).all(),
      env.DB.prepare(`SELECT * FROM goalie_rolling_snapshots WHERE player_id=? ORDER BY CASE window_key WHEN '5' THEN 1 WHEN '10' THEN 2 WHEN '20' THEN 3 ELSE 4 END;`).bind(id).all(),
      env.DB.prepare(`SELECT * FROM goalie_opponent_splits WHERE player_id=? AND scope_key='2Y' ORDER BY save_pct DESC,games DESC LIMIT 20;`).bind(id).all(),
    ]);if(!p)return json({ok:false,error:"player_not_found"},404);return json({ok:true,player:p,rolling:r.results||[],opponents:o.results||[],goalie:g.results||[],goalie_opponents:go.results||[]});
  }catch(error){console.error("control player failed",error);return json({ok:false,error:"compact_player_layer_not_ready"},503)}
}

async function telegramStatsRoute(env){
  if(!env.DB)return json({ok:false,error:"missing_d1_binding"},503);
  try{const row=await env.DB.prepare(`SELECT (SELECT COUNT(*) FROM telegram_users) users,(SELECT COUNT(*) FROM subscriptions) subscriptions,(SELECT COUNT(*) FROM subscriptions WHERE subject_type='team') team_follows,(SELECT COUNT(*) FROM subscriptions WHERE subject_type='player') player_follows,(SELECT COUNT(*) FROM subscriptions WHERE subject_type='game') game_follows;`).first();return json({ok:true,stats:{users:Number(row?.users||0),subscriptions:Number(row?.subscriptions||0),team_follows:Number(row?.team_follows||0),player_follows:Number(row?.player_follows||0),game_follows:Number(row?.game_follows||0)}})}catch(error){console.error("control telegram stats failed",error);return json({ok:false,error:"telegram_stats_failed"},500)}
}

function clamp(v,f,min,max){const n=Number(v);return Number.isSafeInteger(n)&&n>=min&&n<=max?n:f}
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}})}
function html(body){return new Response(body,{headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"public, max-age=300","X-Content-Type-Options":"nosniff"}})}
function js(body){return new Response(body,{headers:{"Content-Type":"application/javascript; charset=utf-8","Cache-Control":"public, max-age=300","X-Content-Type-Options":"nosniff"}})}

function browserApp(){
const $=s=>document.querySelector(s);const state={tab:'overview',players:[],games:[],selected:null};const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));async function api(u){const r=await fetch(u,{cache:'no-store'});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||('HTTP '+r.status));return d}function num(v,d=1){const n=Number(v);return Number.isFinite(n)?n.toFixed(d):'—'}function fmt(v){if(!v)return'—';return new Date(v).toLocaleString('ru-RU',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}).replace(',',' ·')}
async function overview(){busy('Загружаю Data Core…');try{const d=await api('/api/control/overview');state.games=d.games||[];$('#content').innerHTML=`<section class="kpis"><div><b>${d.counts.games}</b><span>матчей</span></div><div><b>${d.counts.players}</b><span>игроков</span></div><div><b>${d.counts.player_windows}</b><span>player windows</span></div><div><b>${d.counts.team_snapshots}</b><span>team snapshots</span></div></section><div class="ready ${d.counts.compact_ready?'yes':''}">${d.counts.compact_ready?'COMPACT LAYER READY':'COMPACT LAYER ЖДЁТ НОЧНОЙ SYNC'}</div><section class="panel"><div class="head"><b>Последние матчи</b><a href="/broadcast">Открыть Broadcast →</a></div>${gamesHtml(state.games)}</section>`}catch(e){fail(e)}}
function gamesHtml(games){return `<div class="games">${games.map(g=>`<a class="game" href="/broadcast?game=${g.game_pk}"><div><b>${esc(g.away_tri)} <i>${g.away_score}</i> — <i>${g.home_score}</i> ${esc(g.home_tri)}</b><span>${esc(g.away_name_ru||g.away_name||g.away_tri)} · ${esc(g.home_name_ru||g.home_name||g.home_tri)}</span></div><small>${fmt(g.scheduled_start_utc)}</small></a>`).join('')}</div>`}
async function players(){busy('Загружаю игроков…');try{const qs=new URLSearchParams();if($('#team')?.value)qs.set('team',$('#team').value);if($('#search')?.value)qs.set('q',$('#search').value);const d=await api('/api/control/players?'+qs);state.players=d.players||[];$('#content').innerHTML=`<section class="panel"><div class="head"><b>Игроки · последние 20</b><span>${state.players.length} строк</span></div><div class="pgrid">${state.players.map(p=>`<button class="pcard" data-p="${p.player_id}"><div class="meta">${esc(p.current_team_tri||'NHL')} · ${esc(p.position_code||'')} ${p.sweater_number?'· #'+p.sweater_number:''}</div><h3>${esc(p.full_name_ru||p.full_name_en)}</h3><div class="pnums"><span><b>${num(p.points_pg,2)}</b><small>очк/м</small></span><span><b>${num(p.goals_pg,2)}</b><small>гол/м</small></span><span><b>${num(p.shots_pg,1)}</b><small>бр/м</small></span></div><div class="hits">с очками ${p.games_with_point}/${p.games} · с голом ${p.games_with_goal}/${p.games}</div></button>`).join('')}</div></section>`;document.querySelectorAll('[data-p]').forEach(b=>b.onclick=()=>openPlayer(Number(b.dataset.p)))}catch(e){$('#content').innerHTML='<div class="empty">Player layer появится после ночного compact sync.</div>'}}
async function openPlayer(id){const back=$('#drawerback');back.classList.add('open');$('#drawer').innerHTML='<div class="empty">Загрузка…</div>';try{const d=await api('/api/control/players/'+id),p=d.player;const goalie=(d.goalie||[]).length>0;$('#drawer').innerHTML=`<button class="close" id="close">Закрыть</button><div class="eyebrow">${esc(p.current_team_tri||'NHL')} · ${esc(p.position_code||'')}</div><h2>${esc(p.full_name_ru||p.full_name_en)}</h2>${goalie?goalieHtml(d):skaterHtml(d)}`;$('#close').onclick=()=>back.classList.remove('open')}catch(e){$('#drawer').innerHTML='<div class="empty">'+esc(e.message)+'</div>'}}
function skaterHtml(d){return `<h4>Rolling</h4><div class="table">${(d.rolling||[]).filter(r=>['5','10','20'].includes(String(r.window_key))).map(r=>`<div><b>${r.window_key} матчей</b><span>${num(r.points_pg,2)} очк/м · ${num(r.goals_pg,2)} гол/м · ${num(r.shots_pg,1)} бр/м</span></div>`).join('')}</div><h4>Против соперников · 2 сезона</h4><div class="table">${(d.opponents||[]).map(r=>`<div><b>${esc(r.opponent_tri)} · ${r.games}</b><span>${num(r.points_pg,2)} очк/м · очки ${r.games_with_point}/${r.games}</span></div>`).join('')}</div>`}function goalieHtml(d){return `<h4>Rolling вратаря</h4><div class="table">${(d.goalie||[]).filter(r=>['5','10','20'].includes(String(r.window_key))).map(r=>`<div><b>${r.window_key} матчей</b><span>${num(Number(r.save_pct)*100,1)}% SV · ${num(r.goals_against_pg,2)} GA/м · ${r.wins}W</span></div>`).join('')}</div><h4>Против соперников</h4><div class="table">${(d.goalie_opponents||[]).map(r=>`<div><b>${esc(r.opponent_tri)} · ${r.games}</b><span>${num(Number(r.save_pct)*100,1)}% SV · ${r.wins}W</span></div>`).join('')}</div>`}
async function telegram(){busy('Загружаю Telegram…');try{const d=await api('/api/control/telegram'),s=d.stats;$('#content').innerHTML=`<section class="kpis"><div><b>${s.users}</b><span>пользователей</span></div><div><b>${s.subscriptions}</b><span>подписок</span></div><div><b>${s.player_follows}</b><span>на игроков</span></div><div><b>${s.team_follows}</b><span>на команды</span></div></section><section class="panel pitch"><div><span class="eyebrow">TELEGRAM LIVE CENTER</span><h2>Матчи · игроки · персональные подписки</h2><p>Mini App уже работает как отдельный продукт поверх того же HOH Data Core. Расписание и live идут напрямую из NHL и не тратят D1 reads.</p><a class="primary" href="/telegram-app">Открыть Mini App →</a></div></section>`}catch(e){fail(e)}}
function setTab(tab){state.tab=tab;document.querySelectorAll('.navbtn').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));$('#playerTools').style.display=tab==='players'?'flex':'none';if(tab==='overview')overview();if(tab==='players')players();if(tab==='telegram')telegram()}function busy(t){$('#content').innerHTML='<div class="empty">'+t+'</div>'}function fail(e){$('#content').innerHTML='<div class="empty">Ошибка: '+esc(e.message)+'</div>'}
document.querySelectorAll('.navbtn').forEach(b=>b.onclick=()=>setTab(b.dataset.tab));$('#search').oninput=()=>{if(state.tab==='players'){clearTimeout(window.__s);window.__s=setTimeout(players,250)}};$('#team').onchange=()=>state.tab==='players'&&players();$('#drawerback').onclick=e=>{if(e.target.id==='drawerback')e.currentTarget.classList.remove('open')};overview();
}

const CONTROL_HTML=`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HOH Control Center</title><style>:root{--bg:#0b0b0d;--side:#0f0f11;--card:#141416;--line:#29292e;--orange:#ff5a1f;--lav:#c8b7ff;--green:#83e6b1;--text:#f6f5f3;--muted:#77777f}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,Arial,sans-serif}.layout{display:grid;grid-template-columns:250px minmax(0,1fr);min-height:100vh}.side{padding:24px 18px;border-right:1px solid var(--line);background:#0d0d0f}.brand{font-weight:950;letter-spacing:-.04em;margin-bottom:28px}.brand i{color:var(--orange);font-style:normal}.label{font-size:9px;color:#606068;letter-spacing:.12em;text-transform:uppercase;margin:18px 8px 7px}.nav{display:grid;gap:4px}.navbtn,.nav a{border:0;background:transparent;color:#898991;text-decoration:none;text-align:left;padding:11px 12px;border-radius:10px;font-size:12px;font-weight:850;cursor:pointer}.navbtn.active,.nav a:hover{background:#1b1b1e;color:#fff}.main{padding:28px 32px 60px;max-width:1500px;width:100%;margin:auto}.top{display:flex;justify-content:space-between;gap:16px;align-items:center;margin-bottom:22px}.top h1{font-size:18px;margin:0}.top p{font-size:10px;color:var(--muted);margin:5px 0 0}.tools{display:none;gap:7px}.tools select,.tools input{border:1px solid var(--line);background:#141416;color:#fff;border-radius:10px;padding:10px 11px}.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:12px}.kpis div{border:1px solid var(--line);background:#111113;border-radius:15px;padding:16px}.kpis b{display:block;font-size:27px;letter-spacing:-.06em}.kpis span{display:block;color:#717179;font-size:9px;text-transform:uppercase;letter-spacing:.1em;margin-top:5px}.ready{display:inline-flex;border:1px solid #5a382b;color:#ff8a5f;border-radius:99px;padding:6px 9px;font-size:9px;font-weight:900;margin-bottom:15px}.ready.yes{border-color:#315341;color:var(--green)}.panel{border:1px solid var(--line);background:#101012;border-radius:17px;overflow:hidden}.head{display:flex;justify-content:space-between;align-items:center;padding:14px 16px;border-bottom:1px solid var(--line);font-size:11px}.head a{color:var(--orange);text-decoration:none}.games{padding:7px 14px}.game{display:flex;justify-content:space-between;align-items:center;text-decoration:none;color:#fff;border-bottom:1px solid #25252a;padding:12px 2px}.game b{font-size:13px}.game i{font-size:17px;font-style:normal}.game span,.game small{display:block;color:#707078;font-size:9px;margin-top:4px}.pgrid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;padding:10px}.pcard{border:1px solid #2b2b30;background:#151517;color:#fff;border-radius:14px;padding:13px;text-align:left;cursor:pointer}.pcard:hover{border-color:#494950}.meta{font-size:8px;color:var(--lav);letter-spacing:.08em}.pcard h3{font-size:13px;min-height:30px;margin:10px 0}.pnums{display:grid;grid-template-columns:repeat(3,1fr)}.pnums b{display:block;font-size:17px}.pnums small{display:block;color:#6c6c73;font-size:7px}.hits{font-size:8px;color:#73737b;margin-top:12px}.empty{padding:40px;text-align:center;color:#74747c}.pitch{padding:35px;background:linear-gradient(135deg,#121214,#1a151f)}.pitch h2{font-size:32px;letter-spacing:-.05em;max-width:700px}.pitch p{max-width:700px;color:#85858d;line-height:1.55}.eyebrow{font-size:9px;color:var(--lav);letter-spacing:.12em}.primary{display:inline-block;background:var(--orange);color:#111;text-decoration:none;border-radius:10px;padding:11px 14px;font-weight:950;font-size:11px;margin-top:10px}.drawerback{position:fixed;inset:0;background:rgba(0,0,0,.68);display:none;z-index:30}.drawerback.open{display:block}.drawer{position:absolute;right:0;top:0;bottom:0;width:min(580px,95vw);overflow:auto;background:#111113;border-left:1px solid #303036;padding:25px}.close{float:right;border:1px solid #333;background:#171719;color:#aaa;border-radius:9px;padding:7px 10px}.drawer h2{font-size:30px;letter-spacing:-.05em;margin:12px 0 30px}.drawer h4{font-size:9px;color:var(--lav);letter-spacing:.1em;text-transform:uppercase;margin-top:25px}.table>div{display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid #25252a;padding:11px 0;font-size:10px}.table span{color:#777;text-align:right}@media(max-width:1000px){.layout{grid-template-columns:200px 1fr}.pgrid{grid-template-columns:repeat(2,1fr)}.kpis{grid-template-columns:repeat(2,1fr)}}@media(max-width:700px){.layout{display:block}.side{border-right:0;border-bottom:1px solid var(--line)}.main{padding:18px}.pgrid{grid-template-columns:1fr}.top{display:block}.tools{margin-top:12px}.kpis{grid-template-columns:1fr 1fr}}</style></head><body><div class="layout"><aside class="side"><div class="brand">HOME OF <i>HOCKEY</i></div><div class="label">Control Center</div><div class="nav"><button class="navbtn active" data-tab="overview">Обзор</button><a href="/broadcast">Broadcast Stats</a><button class="navbtn" data-tab="players">Игроки</button><button class="navbtn" data-tab="telegram">Telegram Live Center</button></div><div class="label">Products</div><div class="nav"><a href="/telegram-app">Mini App ↗</a><a href="/api/data-core/health">Data Core Health ↗</a></div></aside><main class="main"><div class="top"><div><h1>HOH NHL Data Platform</h1><p>Data Core → Betting Insight Engine → Broadcast + Telegram</p></div><div class="tools" id="playerTools"><select id="team"><option value="">Все команды</option><option>ANA</option><option>BOS</option><option>BUF</option><option>CGY</option><option>CAR</option><option>CHI</option><option>COL</option><option>CBJ</option><option>DAL</option><option>DET</option><option>EDM</option><option>FLA</option><option>LAK</option><option>MIN</option><option>MTL</option><option>NSH</option><option>NJD</option><option>NYI</option><option>NYR</option><option>OTT</option><option>PHI</option><option>PIT</option><option>SJS</option><option>SEA</option><option>STL</option><option>TBL</option><option>TOR</option><option>UTA</option><option>VAN</option><option>VGK</option><option>WSH</option><option>WPG</option></select><input id="search" placeholder="Поиск игрока"></div></div><div id="content"><div class="empty">Загрузка…</div></div></main></div><div class="drawerback" id="drawerback"><div class="drawer" id="drawer"></div></div><script src="/control/app.js"></script></body></html>`;
