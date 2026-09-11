const PATH = "/telegram-app";

export function handleTelegramMiniAppV2Ui(request, path) {
  if (path === PATH) {
    if (request.method !== "GET") return json({ok:false,error:"method_not_allowed"},405);
    return html(APP_HTML);
  }
  if (path === `${PATH}/app.js`) {
    if (request.method !== "GET") return json({ok:false,error:"method_not_allowed"},405);
    return js(`(${browserApp.toString()})();`);
  }
  return null;
}

function browserApp(){
  const tg=window.Telegram?.WebApp||null;
  if(tg){tg.ready();tg.expand();tg.setHeaderColor?.('#0a0a0c');tg.setBackgroundColor?.('#0a0a0c')}
  const initData=tg?.initData||'';
  const state={tab:'games',date:new Date().toISOString().slice(0,10),bootstrap:null,games:[],teams:[],players:[],teamWindow:20,playerTeam:'',playerQuery:''};
  const $=s=>document.querySelector(s);
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const num=(v,d=1)=>Number.isFinite(Number(v))?Number(v).toFixed(d):'—';
  const score=v=>v===null||v===undefined?'—':v;

  async function api(url,opts={}){
    const headers={...(opts.headers||{})};
    if(initData)headers['X-Telegram-Init-Data']=initData;
    if(opts.body&&!headers['Content-Type'])headers['Content-Type']='application/json';
    const response=await fetch(url,{...opts,headers,cache:'no-store'});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data.error||('HTTP '+response.status));
    return data;
  }

  async function boot(){
    try{
      state.bootstrap=await api('/api/telegram-app/bootstrap');
      $('#mode').textContent=state.bootstrap.mode==='telegram'?'TELEGRAM':'ГОСТЬ';
      fillTeamSelect();
      await loadGames();
    }catch(e){fail(e)}
  }

  function setTab(tab){
    state.tab=tab;
    document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
    $('#datebar').hidden=tab!=='games';
    $('#playerFilters').hidden=tab!=='players';
    $('#teamWindow').hidden=tab!=='teams';
    if(tab==='games')renderGames();
    if(tab==='teams')loadTeams();
    if(tab==='players')loadPlayers();
    if(tab==='follows')renderFollows();
  }

  async function loadGames(){
    busy('Загружаю матчи…');
    try{const d=await api('/api/telegram-app/schedule?date='+encodeURIComponent(state.date));state.games=d.games||[];renderGames()}catch(e){fail(e)}
  }
  function renderGames(){
    if(!state.games.length){$('#content').innerHTML='<div class="empty">В этот день матчей нет</div>';return}
    $('#content').innerHTML='<div class="stack">'+state.games.map(g=>`<button class="game card" data-game="${g.game_pk}"><div class="gameMeta"><span>${fmtTime(g.start_utc)}</span><i class="pill ${isLive(g.state)?'live':''}">${stateLabel(g.state)}</i></div>${gameTeam(g.away)}${gameTeam(g.home)}</button>`).join('')+'</div>';
    document.querySelectorAll('[data-game]').forEach(b=>b.onclick=()=>openGame(Number(b.dataset.game)));
  }
  function gameTeam(t){return `<div class="gameTeam"><span>${t.logo?`<img src="${esc(t.logo)}" alt="">`:`<i class="tri">${esc(t.tri)}</i>`}<b>${esc(t.name||t.tri)}</b></span><strong>${score(t.score)}</strong></div>`}
  async function openGame(id){
    openSheet('Загружаю матч…');
    try{const d=await api('/api/telegram-app/games/'+id),g=d.game;$('#sheet').innerHTML=`${closeButton()}<div class="eyebrow">${stateLabel(g.state)} · ${fmtDateTime(g.start_utc)}</div><h2>${esc(g.away.tri)} ${score(g.away.score)} — ${score(g.home.score)} ${esc(g.home.tri)}</h2><div class="metric2"><div><b>${score(g.away.shots)}</b><span>броски ${esc(g.away.tri)}</span></div><div><b>${score(g.home.shots)}</b><span>броски ${esc(g.home.tri)}</span></div></div><h4>Лидеры матча</h4><div class="rows">${(g.top_players||[]).map(p=>`<button class="row" data-player="${p.player_id}"><span>${esc(p.name)} <small>${esc(p.team_tri)}</small></span><b>${p.goals}+${p.assists} · ${p.points}</b></button>`).join('')||'<div class="empty small">Появятся после начала матча</div>'}</div>`;bindSheetClose();document.querySelectorAll('[data-player]').forEach(b=>b.onclick=()=>openPlayer(Number(b.dataset.player)))}catch(e){sheetError(e)}
  }

  async function loadTeams(){
    busy('Загружаю рейтинг команд…');
    try{const d=await api('/api/telegram-app/teams?window='+state.teamWindow);state.teams=d.teams||[];renderTeams()}catch(e){$('#content').innerHTML='<div class="empty">Рейтинг команд появится после ночного compact sync.</div>'}
  }
  function renderTeams(){
    $('#content').innerHTML='<div class="stack">'+state.teams.map(t=>`<button class="team card" data-team="${esc(t.team_tri)}"><div class="teamHead">${t.logo_url?`<img src="${esc(t.logo_url)}" alt="">`:`<i class="tri big">${esc(t.team_tri)}</i>`}<div><b>${esc(t.name_ru||t.name_en||t.team_tri)}</b><span>${esc(t.team_tri)} · ${state.teamWindow} матчей</span></div><strong>#${t.rank_goal_diff??'—'}</strong></div><div class="metric3"><span><b>${num(t.gf_pg,2)}</b><small>GF · #${t.rank_gf??'—'}</small></span><span><b>${num(t.ga_pg,2)}</b><small>GA · #${t.rank_ga??'—'}</small></span><span><b>${num(t.xgf_pct_5v5,1)}%</b><small>xGF · #${t.rank_xgf_pct_5v5??'—'}</small></span></div></button>`).join('')+'</div>';
    document.querySelectorAll('[data-team]').forEach(b=>b.onclick=()=>openTeam(b.dataset.team));
  }
  async function openTeam(tri){
    openSheet('Загружаю команду…');
    try{const d=await api('/api/telegram-app/teams/'+tri),t=d.team;const snap=(d.snapshots||[]).find(x=>Number(x.window_games)===state.teamWindow)||(d.snapshots||[]).slice(-1)[0]||{};const followed=isFollowed('team',tri);$('#sheet').innerHTML=`${closeButton()}<div class="teamTitle">${t.logo_url?`<img src="${esc(t.logo_url)}" alt="">`:''}<div><div class="eyebrow">${esc(tri)} · ${state.teamWindow} МАТЧЕЙ</div><h2>${esc(t.name_ru||t.name_en||tri)}</h2></div></div>${followButton('team',tri,followed)}<div class="metric4"><span><b>${num(snap.gf_pg,2)}</b><small>GF/м · #${snap.rank_gf??'—'}</small></span><span><b>${num(snap.ga_pg,2)}</b><small>GA/м · #${snap.rank_ga??'—'}</small></span><span><b>${num(snap.xgf_pct_5v5,1)}%</b><small>xGF · #${snap.rank_xgf_pct_5v5??'—'}</small></span><span><b>${num(snap.corsi_pct,1)}%</b><small>Corsi · #${snap.rank_corsi??'—'}</small></span></div><h4>Лидеры · 20 матчей</h4><div class="rows">${(d.skaters||[]).map(p=>`<button class="row" data-player="${p.player_id}"><span>${esc(p.full_name_ru||p.full_name_en)}</span><b>${num(p.points_pg,2)} очк/м</b></button>`).join('')||'<div class="empty small">После compact sync</div>'}</div><h4>Вратари</h4><div class="rows">${(d.goalies||[]).map(p=>`<div class="row static"><span>${esc(p.full_name_ru||p.full_name_en)}</span><b>${num(Number(p.save_pct)*100,1)}% SV · ${p.wins}W</b></div>`).join('')||'<div class="empty small">Нет данных</div>'}</div>`;bindSheetClose();bindFollow('team',tri,followed);document.querySelectorAll('[data-player]').forEach(b=>b.onclick=()=>openPlayer(Number(b.dataset.player)))}catch(e){sheetError(e)}
  }

  function fillTeamSelect(){const select=$('#teamSelect');select.innerHTML='<option value="">Все команды</option>'+((state.bootstrap?.teams)||[]).map(t=>`<option value="${t.tri}">${esc(t.name)} · ${t.tri}</option>`).join('')}
  async function loadPlayers(){
    busy('Загружаю игроков…');
    try{const qs=new URLSearchParams();if(state.playerTeam)qs.set('team',state.playerTeam);if(state.playerQuery)qs.set('q',state.playerQuery);qs.set('limit','40');const d=await api('/api/telegram-app/players?'+qs);state.players=d.players||[];renderPlayers()}catch(e){$('#content').innerHTML='<div class="empty">Player layer появится после ночного compact sync.</div>'}
  }
  function renderPlayers(){
    if(!state.players.length){$('#content').innerHTML='<div class="empty">Игроки не найдены</div>';return}
    $('#content').innerHTML='<div class="playersGrid">'+state.players.map(p=>`<button class="player card" data-player="${p.player_id}"><div class="eyebrow">${esc(p.current_team_tri||'NHL')} · ${esc(p.position_code||'')} ${p.sweater_number?'· #'+p.sweater_number:''}</div><h3>${esc(p.full_name_ru||p.full_name_en)}</h3><div class="metric3"><span><b>${num(p.points_pg,2)}</b><small>очк/м</small></span><span><b>${num(p.goals_pg,2)}</b><small>гол/м</small></span><span><b>${num(p.shots_pg,1)}</b><small>бр/м</small></span></div></button>`).join('')+'</div>';
    document.querySelectorAll('[data-player]').forEach(b=>b.onclick=()=>openPlayer(Number(b.dataset.player)));
  }
  async function openPlayer(id){
    openSheet('Загружаю игрока…');
    try{const d=await api('/api/telegram-app/players/'+id),p=d.player;const followed=isFollowed('player',String(id));$('#sheet').innerHTML=`${closeButton()}<div class="eyebrow">${esc(p.current_team_tri||'NHL')} · ${esc(p.position_code||'')} ${p.sweater_number?'· #'+p.sweater_number:''}</div><h2>${esc(p.full_name_ru||p.full_name_en)}</h2>${followButton('player',String(id),followed)}<h4>Форма</h4><div class="rows">${(d.rolling||[]).filter(r=>['5','10','20'].includes(String(r.window_key))).map(r=>`<div class="row static"><span>${r.window_key} матчей</span><b>${num(r.points_pg,2)} очк/м · ${num(r.goals_pg,2)} гол/м · ${num(r.shots_pg,1)} бр/м</b></div>`).join('')}</div><h4>Против соперников · 2 сезона</h4><div class="rows">${(d.opponents||[]).map(r=>`<div class="row static"><span>vs ${esc(r.opponent_tri)} · ${r.games}</span><b>${num(r.points_pg,2)} очк/м · ${r.games_with_point}/${r.games} с очками</b></div>`).join('')||'<div class="empty small">Недостаточно матчей</div>'}</div>`;bindSheetClose();bindFollow('player',String(id),followed)}catch(e){sheetError(e)}
  }

  function renderFollows(){
    const list=state.bootstrap?.follows||[];
    if(!list.length){$('#content').innerHTML='<div class="empty">Подпишитесь на команду или игрока — здесь появится ваш NHL.</div>';return}
    $('#content').innerHTML='<div class="stack">'+list.map(f=>`<button class="followCard card" data-ftype="${esc(f.subject_type)}" data-fkey="${esc(f.subject_key)}"><span><i>${followIcon(f.subject_type)}</i><b>${followLabel(f)}</b></span><small>голы ${f.notify_goal?'ON':'OFF'} · финал ${f.notify_final?'ON':'OFF'}</small></button>`).join('')+'</div>';
    document.querySelectorAll('[data-ftype]').forEach(b=>b.onclick=()=>{if(b.dataset.ftype==='team')openTeam(b.dataset.fkey);if(b.dataset.ftype==='player')openPlayer(Number(b.dataset.fkey))});
  }
  function followLabel(f){if(f.subject_type==='team'){const t=(state.bootstrap?.teams||[]).find(x=>x.tri===f.subject_key);return t?.name||f.subject_key}return f.subject_type==='player'?'Игрок #'+f.subject_key:'Матч '+f.subject_key}
  function followIcon(t){return t==='team'?'🏒':t==='player'?'⭐':'📺'}

  function isFollowed(type,key){return Boolean(state.bootstrap?.follows?.some(f=>f.subject_type===type&&String(f.subject_key)===String(key)))}
  function followButton(type,key,on){return `<button class="follow ${on?'on':''}" id="followAction">${on?'✓ Подписка активна':'＋ Подписаться'}</button>`}
  function bindFollow(type,key,on){const b=$('#followAction');if(b)b.onclick=()=>toggleFollow(type,key,on)}
  async function toggleFollow(type,key,remove){
    if(!initData){tg?.showAlert?.('Откройте приложение из Telegram-бота, чтобы подписываться.');return}
    try{const d=await api('/api/telegram-app/follows',{method:remove?'DELETE':'POST',body:JSON.stringify({subject_type:type,subject_key:key})});state.bootstrap.follows=d.follows||[];if(type==='team')openTeam(key);if(type==='player')openPlayer(Number(key))}catch(e){tg?.showAlert?.('Не удалось изменить подписку: '+e.message)}
  }

  function openSheet(text){$('#overlay').classList.add('open');$('#sheet').innerHTML='<div class="empty">'+text+'</div>'}
  function closeButton(){return '<button class="close" id="closeSheet">×</button>'}
  function bindSheetClose(){const b=$('#closeSheet');if(b)b.onclick=()=>$('#overlay').classList.remove('open')}
  function sheetError(e){$('#sheet').innerHTML=closeButton()+'<div class="empty">'+esc(e.message)+'</div>';bindSheetClose()}
  function busy(t){$('#content').innerHTML='<div class="empty">'+t+'</div>'}
  function fail(e){$('#content').innerHTML='<div class="empty">Ошибка: '+esc(e.message)+'</div>'}
  function isLive(s){return ['LIVE','CRIT','INTERMISSION'].includes(String(s||'').toUpperCase())}
  function stateLabel(s){return isLive(s)?'LIVE':['FINAL','OFF'].includes(String(s||'').toUpperCase())?'FINAL':'СКОРО'}
  function fmtTime(v){return v?new Date(v).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}):'—'}
  function fmtDateTime(v){return v?new Date(v).toLocaleString('ru-RU',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}):'—'}

  document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>setTab(b.dataset.tab));
  document.querySelectorAll('[data-window]').forEach(b=>b.onclick=()=>{state.teamWindow=Number(b.dataset.window);document.querySelectorAll('[data-window]').forEach(x=>x.classList.toggle('active',x===b));loadTeams()});
  $('#prev').onclick=()=>{const d=new Date(state.date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()-1);state.date=d.toISOString().slice(0,10);$('#date').textContent=state.date;loadGames()};
  $('#next').onclick=()=>{const d=new Date(state.date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+1);state.date=d.toISOString().slice(0,10);$('#date').textContent=state.date;loadGames()};
  $('#teamSelect').onchange=e=>{state.playerTeam=e.target.value;loadPlayers()};
  $('#playerSearch').oninput=e=>{state.playerQuery=e.target.value;clearTimeout(window.__search);window.__search=setTimeout(loadPlayers,250)};
  $('#overlay').onclick=e=>{if(e.target.id==='overlay')e.currentTarget.classList.remove('open')};
  $('#date').textContent=state.date;boot();
}

function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{"Content-Type":"application/json; charset=utf-8"}})}
function html(body){return new Response(body,{headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"public, max-age=120","X-Content-Type-Options":"nosniff"}})}
function js(body){return new Response(body,{headers:{"Content-Type":"application/javascript; charset=utf-8","Cache-Control":"public, max-age=120","X-Content-Type-Options":"nosniff"}})}

const APP_HTML=`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>HOH NHL Live</title><script src="https://telegram.org/js/telegram-web-app.js"></script><style>
:root{--bg:#0a0a0c;--card:#141416;--line:#29292e;--text:#f7f6f3;--muted:#74747d;--orange:#ff5a1f;--lav:#c8b7ff;--green:#7ee0ad}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,Arial,sans-serif;min-height:100vh}.app{max-width:720px;margin:auto;padding:14px 12px calc(90px + env(safe-area-inset-bottom))}.brand{display:flex;align-items:center;justify-content:space-between;margin:3px 3px 16px}.brand b{font-weight:950;letter-spacing:-.04em}.brand b i{font-style:normal;color:var(--orange)}.mode{font-size:8px;color:var(--lav);border:1px solid #35323d;border-radius:99px;padding:5px 7px}.tabs{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;padding:4px;background:#101012;border:1px solid var(--line);border-radius:14px;position:sticky;top:5px;z-index:5}.tab{border:0;background:transparent;color:#707078;border-radius:10px;padding:10px 3px;font-weight:900;font-size:10px}.tab.active{background:#28242b;color:#fff}.toolbar{display:flex;align-items:center;justify-content:space-between;margin:12px 0 9px}.toolbar[hidden]{display:none}.toolbar button{border:1px solid var(--line);background:#151517;color:#fff;border-radius:9px;height:34px;min-width:36px}.toolbar strong{font-size:10px;letter-spacing:.08em}.segments{justify-content:flex-start;gap:5px}.segments button{padding:0 12px;color:#777;font-size:9px;font-weight:900}.segments button.active{background:#2c2830;color:#fff}.filters{display:grid;grid-template-columns:125px 1fr;gap:7px}.filters select,.filters input{width:100%;border:1px solid var(--line);background:#141416;color:#fff;border-radius:10px;padding:10px;font-size:11px;outline:none}.stack{display:grid;gap:7px}.card{width:100%;border:1px solid var(--line);background:linear-gradient(135deg,#151517,#101012);color:#fff;border-radius:15px;padding:12px;text-align:left}.gameMeta{display:flex;justify-content:space-between;color:#74747d;font-size:9px;margin-bottom:7px}.pill{font-style:normal;border:1px solid #34343a;border-radius:5px;padding:2px 5px;font-size:7px;font-weight:950}.pill.live{background:#d84a3e;border-color:#d84a3e;color:#fff}.gameTeam{display:flex;align-items:center;justify-content:space-between;padding:5px 0}.gameTeam span{display:flex;align-items:center;gap:8px}.gameTeam img{width:27px;height:27px;object-fit:contain}.gameTeam b{font-size:12px}.gameTeam strong{font-size:20px}.tri{display:grid;place-items:center;width:27px;height:27px;border-radius:7px;background:#242429;font-size:7px;font-style:normal}.tri.big{width:36px;height:36px}.teamHead{display:flex;align-items:center;gap:9px}.teamHead img{width:36px;height:36px;object-fit:contain}.teamHead div{display:flex;flex-direction:column;gap:2px}.teamHead b{font-size:12px}.teamHead span{font-size:8px;color:#74747d}.teamHead strong{margin-left:auto;color:var(--lav);font-size:16px}.metric2,.metric3,.metric4{display:grid;gap:6px;margin:12px 0}.metric2{grid-template-columns:1fr 1fr}.metric3{grid-template-columns:repeat(3,1fr)}.metric4{grid-template-columns:1fr 1fr}.metric2 div,.metric4 span{border:1px solid var(--line);border-radius:10px;padding:10px}.metric3 span{display:flex;flex-direction:column;border-top:1px solid #242429;padding-top:8px}.metric2 b,.metric3 b,.metric4 b{display:block;font-size:15px}.metric2 span,.metric3 small,.metric4 small{display:block;color:#6f6f77;font-size:7px;margin-top:3px}.playersGrid{display:grid;grid-template-columns:1fr 1fr;gap:7px}.player h3{font-size:12px;min-height:30px;margin:9px 0}.eyebrow{font-size:8px;color:var(--lav);letter-spacing:.08em}.followCard{display:flex;align-items:center;justify-content:space-between}.followCard span{display:flex;align-items:center;gap:8px}.followCard i{font-style:normal}.followCard b{font-size:11px}.followCard small{font-size:7px;color:#777}.empty{padding:32px 12px;text-align:center;color:#777;font-size:11px}.empty.small{padding:14px}.overlay{position:fixed;inset:0;background:rgba(0,0,0,.72);display:none;z-index:20}.overlay.open{display:block}.sheet{position:absolute;left:0;right:0;bottom:0;max-height:90vh;overflow:auto;background:#111113;border-top:1px solid #34343a;border-radius:22px 22px 0 0;padding:20px 16px calc(24px + env(safe-area-inset-bottom))}.close{float:right;border:1px solid #34343a;background:#171719;color:#aaa;width:36px;height:34px;border-radius:9px;font-size:18px}.sheet h2{font-size:25px;letter-spacing:-.05em;margin:9px 0 16px}.sheet h4{font-size:8px;color:var(--lav);letter-spacing:.1em;text-transform:uppercase;margin:22px 0 7px}.teamTitle{display:flex;align-items:center;gap:14px;margin-top:16px}.teamTitle img{width:58px;height:58px;object-fit:contain}.teamTitle h2{margin:6px 0}.rows{display:grid}.row{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;border:0;border-bottom:1px solid #25252a;background:transparent;color:#fff;padding:10px 0;text-align:left;font-size:10px}.row span small{color:#777}.row b{color:#aaa;text-align:right}.row.static{cursor:default}.follow{width:100%;border:1px solid #543727;background:rgba(255,90,31,.09);color:#ff8458;border-radius:11px;padding:11px;font-weight:900;font-size:10px;margin:10px 0}.follow.on{border-color:#315442;background:rgba(126,224,173,.08);color:var(--green)}@media(max-width:420px){.playersGrid{grid-template-columns:1fr}.tabs{gap:2px}.tab{font-size:9px}}
</style></head><body><div class="app"><div class="brand"><b>HOME OF <i>HOCKEY</i> · NHL LIVE</b><span class="mode" id="mode">…</span></div><nav class="tabs"><button class="tab active" data-tab="games">Матчи</button><button class="tab" data-tab="teams">Команды</button><button class="tab" data-tab="players">Игроки</button><button class="tab" data-tab="follows">Мои</button></nav><div class="toolbar" id="datebar"><button id="prev">‹</button><strong id="date"></strong><button id="next">›</button></div><div class="toolbar segments" id="teamWindow" hidden><button data-window="5">5</button><button data-window="10">10</button><button class="active" data-window="20">20 матчей</button></div><div class="toolbar filters" id="playerFilters" hidden><select id="teamSelect"></select><input id="playerSearch" placeholder="Поиск игрока"></div><main id="content"><div class="empty">Загрузка…</div></main></div><div class="overlay" id="overlay"><div class="sheet" id="sheet"></div></div><script src="/telegram-app/app.js"></script></body></html>`;
