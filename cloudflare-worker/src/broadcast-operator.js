import { evaluateMarketLines } from "./market-line-evaluator.js";
import { buildPlayerMarketInsights } from "./player-market-insights.js";

const NHL_BASE = "https://api-web.nhle.com/v1";
const ALLOWED_STATUSES = new Set(["draft","preview","shown","hidden"]);

export async function handleBroadcastOperatorRequest(request, env, path) {
  if (path === "/broadcast/operator") {
    if (request.method !== "GET") return json({ok:false,error:"method_not_allowed"},405);
    return html(OPERATOR_HTML);
  }
  if (path === "/broadcast/operator/app.js") {
    if (request.method !== "GET") return json({ok:false,error:"method_not_allowed"},405);
    return js(`(${browserApp.toString()})();`);
  }
  if (path === "/broadcast/overlay") {
    if (request.method !== "GET") return json({ok:false,error:"method_not_allowed"},405);
    return html(OVERLAY_HTML,{cache:"no-store"});
  }

  if (!path.startsWith("/api/broadcast/operator/")) return null;
  if (!env.DB) return json({ok:false,error:"missing_d1_binding"},503);
  if (!(await managementAuthorized(request,env))) return json({ok:false,error:"unauthorized"},401);

  if (path === "/api/broadcast/operator/drafts/from-market") {
    if (request.method !== "POST") return json({ok:false,error:"method_not_allowed"},405);
    return createMarketDraft(request,env);
  }
  if (path === "/api/broadcast/operator/drafts/from-player") {
    if (request.method !== "POST") return json({ok:false,error:"method_not_allowed"},405);
    return createPlayerDraft(request,env);
  }
  const cardMatch = /^\/api\/broadcast\/operator\/cards\/([^/]+)$/.exec(path);
  if (cardMatch) {
    if (request.method === "PATCH") return editCard(request,env,decodeURIComponent(cardMatch[1]));
    return json({ok:false,error:"method_not_allowed"},405);
  }
  const statusMatch = /^\/api\/broadcast\/operator\/cards\/([^/]+)\/status$/.exec(path);
  if (statusMatch) {
    if (request.method !== "POST") return json({ok:false,error:"method_not_allowed"},405);
    return setCardStatus(request,env,decodeURIComponent(statusMatch[1]));
  }
  return null;
}

async function createMarketDraft(request,env){
  let body;
  try{body=await request.json()}catch{return json({ok:false,error:"invalid_json"},400)}
  const gamePk=positiveInt(body.game_pk);
  const window=normalizeWindow(body.window);
  if(!gamePk)return json({ok:false,error:"invalid_game_pk"},400);
  const box=await fetchGame(gamePk);
  const game=normalizeGame(box,gamePk);
  const ensured=await ensureGameRow(env.DB,game);
  if(!ensured.ok)return json(ensured,ensured.status||400);
  const markets=await evaluateMarketLines(env.DB,game,{window,before:game.scheduled_start_utc});
  const wanted=normalizeMarketIdentity(body.market||body);
  const candidate=markets.find((m)=>sameMarket(m,wanted));
  if(!candidate)return json({ok:false,error:"market_candidate_not_found"},404);
  const componentText=Object.entries(candidate.evidence?.components||{}).map(([k,v])=>`${k}: ${pct(v)}`).join(" · ");
  const card={
    card_id:marketCardId(gamePk,candidate,window),
    game_pk:gamePk,
    headline_ru:`${game.away_tri} — ${game.home_tri}: ${candidate.label}`,
    stat_text_ru:`${pct(candidate.combined_rate)} по выбранному направлению`,
    source_note_ru:`HOH Market Lab · последние ${window} матчей · sample ${candidate.sample}${componentText?` · ${componentText}`:""}`,
    suggested_market_type:candidate.market_type,
    suggested_market_subject:candidate.subject||`${game.away_tri}-${game.home_tri}`,
    manual_odds:null,
    odds_is_demo:1,
  };
  return persistDraft(env.DB,card,{source:"market_lab",candidate});
}

async function createPlayerDraft(request,env){
  let body;
  try{body=await request.json()}catch{return json({ok:false,error:"invalid_json"},400)}
  const gamePk=positiveInt(body.game_pk);
  const candidateId=String(body.candidate_id||"").trim();
  if(!gamePk||!candidateId)return json({ok:false,error:"invalid_request"},400);
  const box=await fetchGame(gamePk);
  const game=normalizeGame(box,gamePk);
  const ensured=await ensureGameRow(env.DB,game);
  if(!ensured.ok)return json(ensured,ensured.status||400);
  const candidates=await buildPlayerMarketInsights(env.DB,game);
  const candidate=candidates.find((c)=>String(c.id)===candidateId);
  if(!candidate)return json({ok:false,error:"player_candidate_not_found"},404);
  const card={
    card_id:safeId(`player-${candidate.id}`),
    game_pk:gamePk,
    headline_ru:String(candidate.title||candidate.market?.label||"Игрок NHL").slice(0,180),
    stat_text_ru:String(candidate.value||candidate.market?.label||"").slice(0,240),
    source_note_ru:String(candidate.explanation||`HOH Player Lab · ${candidate.eyebrow||""}`).slice(0,500),
    suggested_market_type:String(candidate.market?.type||"player").slice(0,80),
    suggested_market_subject:String(candidate.market?.subject||candidate.evidence?.player_id||"").slice(0,120),
    manual_odds:Number.isFinite(Number(candidate.market?.odds))?Number(candidate.market.odds):null,
    odds_is_demo:1,
  };
  return persistDraft(env.DB,card,{source:"player_market",candidate});
}

async function persistDraft(db,card,meta){
  const existing=await db.prepare(`SELECT card_id,status FROM broadcast_cards WHERE card_id=? LIMIT 1;`).bind(card.card_id).first();
  if(existing && ["shown","preview"].includes(String(existing.status))) {
    return json({ok:false,error:"card_locked_on_air",card_id:card.card_id,status:existing.status},409);
  }
  await db.prepare(`
    INSERT INTO broadcast_cards(
      card_id,game_pk,insight_id,display_order,headline_ru,stat_text_ru,source_note_ru,
      suggested_market_type,suggested_market_subject,manual_odds,odds_is_demo,status,updated_at
    ) VALUES(?,?,NULL,999,?,?,?,?,?,?,?,'draft',CURRENT_TIMESTAMP)
    ON CONFLICT(card_id) DO UPDATE SET
      headline_ru=excluded.headline_ru,stat_text_ru=excluded.stat_text_ru,source_note_ru=excluded.source_note_ru,
      suggested_market_type=excluded.suggested_market_type,suggested_market_subject=excluded.suggested_market_subject,
      manual_odds=excluded.manual_odds,odds_is_demo=excluded.odds_is_demo,status='draft',shown_at=NULL,updated_at=CURRENT_TIMESTAMP;
  `).bind(
    card.card_id,card.game_pk,card.headline_ru,card.stat_text_ru,card.source_note_ru,
    card.suggested_market_type,card.suggested_market_subject,card.manual_odds,card.odds_is_demo,
  ).run();
  const saved=await loadCard(db,card.card_id);
  return json({ok:true,action:"draft_saved",card:saved,source:meta.source,candidate:meta.candidate});
}

async function editCard(request,env,cardId){
  const current=await loadCard(env.DB,cardId);
  if(!current)return json({ok:false,error:"card_not_found"},404);
  if(String(current.status)==="shown")return json({ok:false,error:"cannot_edit_shown_card"},409);
  let body;
  try{body=await request.json()}catch{return json({ok:false,error:"invalid_json"},400)}
  const headline=textField(body.headline_ru,current.headline_ru,180);
  const stat=textField(body.stat_text_ru,current.stat_text_ru,240);
  const source=textField(body.source_note_ru,current.source_note_ru||"",500);
  const odds=body.manual_odds===null||body.manual_odds===""?null:Number(body.manual_odds);
  if(odds!==null&&(!Number.isFinite(odds)||odds<1.01||odds>100))return json({ok:false,error:"invalid_manual_odds"},400);
  await env.DB.prepare(`
    UPDATE broadcast_cards SET headline_ru=?,stat_text_ru=?,source_note_ru=?,manual_odds=?,odds_is_demo=?,updated_at=CURRENT_TIMESTAMP
    WHERE card_id=?;
  `).bind(headline,stat,source,odds,body.odds_is_demo===false?0:1,cardId).run();
  return json({ok:true,action:"card_updated",card:await loadCard(env.DB,cardId)});
}

async function setCardStatus(request,env,cardId){
  const current=await loadCard(env.DB,cardId);
  if(!current)return json({ok:false,error:"card_not_found"},404);
  let body;
  try{body=await request.json()}catch{return json({ok:false,error:"invalid_json"},400)}
  const target=String(body.status||"").trim().toLowerCase();
  if(!ALLOWED_STATUSES.has(target))return json({ok:false,error:"invalid_status"},400);
  if(target==="shown"&&String(current.status)!=="preview") {
    return json({ok:false,error:"preview_required_before_show",current_status:current.status},409);
  }
  if(target==="preview") {
    await env.DB.batch([
      env.DB.prepare(`UPDATE broadcast_cards SET status='draft',updated_at=CURRENT_TIMESTAMP WHERE status='preview' AND card_id<>?;`).bind(cardId),
      env.DB.prepare(`UPDATE broadcast_cards SET status='preview',shown_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE card_id=?;`).bind(cardId),
    ]);
  } else if(target==="shown") {
    await env.DB.batch([
      env.DB.prepare(`UPDATE broadcast_cards SET status='hidden',updated_at=CURRENT_TIMESTAMP WHERE status='shown' AND card_id<>?;`).bind(cardId),
      env.DB.prepare(`UPDATE broadcast_cards SET status='shown',shown_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE card_id=? AND status='preview';`).bind(cardId),
    ]);
  } else {
    await env.DB.prepare(`UPDATE broadcast_cards SET status=?,shown_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE card_id=?;`).bind(target,cardId).run();
  }
  return json({ok:true,action:"status_updated",card:await loadCard(env.DB,cardId)});
}

async function ensureGameRow(db,game){
  const exists=await db.prepare(`SELECT game_pk FROM games WHERE game_pk=? LIMIT 1;`).bind(game.game_pk).first();
  if(exists)return {ok:true,existing:true};
  const teams=await db.prepare(`SELECT tri_code FROM teams WHERE tri_code IN (?,?);`).bind(game.home_tri,game.away_tri).all();
  const found=new Set((teams.results||[]).map((r)=>String(r.tri_code)));
  if(!found.has(game.home_tri)||!found.has(game.away_tri))return {ok:false,error:"game_teams_not_in_data_core",status:409};
  await db.prepare(`
    INSERT INTO games(game_pk,season_id,game_type,scheduled_start_utc,game_state,home_tri,away_tri,home_score,away_score,current_period,period_type,venue_name,last_synced_at)
    VALUES(?,?,?,?,?,?,?,?,?,NULL,NULL,?,CURRENT_TIMESTAMP);
  `).bind(game.game_pk,game.season_id,game.game_type,game.scheduled_start_utc,game.game_state,game.home_tri,game.away_tri,game.home_score,game.away_score,game.venue_name).run();
  return {ok:true,existing:false};
}

async function fetchGame(gamePk){
  const response=await fetch(`${NHL_BASE}/gamecenter/${gamePk}/boxscore`,{headers:{Accept:"application/json"}});
  if(!response.ok)throw new Error(`NHL HTTP ${response.status}`);
  return response.json();
}
function normalizeGame(box,gamePk){
  const home=box?.homeTeam||{},away=box?.awayTeam||{};
  return {
    game_pk:gamePk,
    season_id:String(box?.season||inferSeason(gamePk)),
    game_type:positiveInt(box?.gameType)||2,
    scheduled_start_utc:String(box?.startTimeUTC||new Date().toISOString()),
    game_state:String(box?.gameState||"FUT").toUpperCase(),
    home_tri:String(home.abbrev||"").toUpperCase(),away_tri:String(away.abbrev||"").toUpperCase(),
    home_score:finiteNumber(home.score,0),away_score:finiteNumber(away.score,0),
    venue_name:localized(box?.venue)||null,
  };
}
function normalizeMarketIdentity(value){return {market_type:String(value.market_type||value.type||""),subject:value.subject===null||value.subject===undefined?null:String(value.subject),line:Number(value.line),side:String(value.side||"")}}
function sameMarket(a,b){return String(a.market_type)===b.market_type&&String(a.subject??"")===String(b.subject??"")&&Number(a.line)===Number(b.line)&&String(a.side)===b.side}
function marketCardId(gamePk,m,w){return safeId(`market-${gamePk}-${m.market_type}-${m.subject||"game"}-${m.side}-${m.line}-w${w}`)}
function safeId(value){return String(value).replace(/[^a-zA-Z0-9_.:-]+/g,"-").slice(0,180)}
function inferSeason(gamePk){const s=String(gamePk).slice(0,4);const y=Number(s);return Number.isSafeInteger(y)?`${y}${y+1}`:"unknown"}
async function loadCard(db,id){return db.prepare(`SELECT * FROM broadcast_cards WHERE card_id=? LIMIT 1;`).bind(id).first()}
function normalizeWindow(v){const n=Number(v);return [5,10,20].includes(n)?n:20}
function positiveInt(v){const n=Number(v);return Number.isSafeInteger(n)&&n>0?n:null}
function finiteNumber(v,f){const n=Number(v);return Number.isFinite(n)?n:f}
function localized(v){if(!v)return"";if(typeof v==="string")return v;return v.default||v.en||Object.values(v)[0]||""}
function pct(v){return `${Math.round(Number(v||0)*100)}%`}
function textField(v,fallback,max){return String(v===undefined?fallback:v||"").trim().slice(0,max)}

async function managementAuthorized(request,env){
  const expected=String(env.MANAGEMENT_API_SECRET||"").trim();
  const auth=request.headers.get("authorization")||"";
  const match=/^Bearer\s+(.+)$/i.exec(auth.trim());
  return Boolean(expected&&match&&await secureEqual(match[1].trim(),expected));
}
async function secureEqual(a,b){const e=new TextEncoder();const [da,db]=await Promise.all([crypto.subtle.digest("SHA-256",e.encode(a)),crypto.subtle.digest("SHA-256",e.encode(b))]);const aa=new Uint8Array(da),bb=new Uint8Array(db);if(aa.length!==bb.length)return false;let d=0;for(let i=0;i<aa.length;i++)d|=aa[i]^bb[i];return d===0}
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}})}
function html(body,{cache="public, max-age=180"}={}){return new Response(body,{headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":cache,"X-Content-Type-Options":"nosniff"}})}
function js(body){return new Response(body,{headers:{"Content-Type":"application/javascript; charset=utf-8","Cache-Control":"public, max-age=120","X-Content-Type-Options":"nosniff"}})}

function browserApp(){
  const $=s=>document.querySelector(s);const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let token=sessionStorage.getItem('hohOperatorToken')||'';let game=new URLSearchParams(location.search).get('game')||'';let matchup=null;let persisted=[];
  async function api(url,opts={}){const headers={...(opts.headers||{})};if(token)headers.Authorization='Bearer '+token;if(opts.body&&!headers['Content-Type'])headers['Content-Type']='application/json';const r=await fetch(url,{...opts,headers,cache:'no-store'});const d=await r.json().catch(()=>({}));if(r.status===401)throw new Error('Нужен Operator key');if(!r.ok)throw new Error(d.error||('HTTP '+r.status));return d}
  function ensureToken(){if(token)return true;token=prompt('Operator key')||'';if(token)sessionStorage.setItem('hohOperatorToken',token);return Boolean(token)}
  async function load(){if(!/^\d+$/.test(game)){input();return}$('#content').innerHTML='<div class="empty">Загрузка…</div>';try{const [m,b]=await Promise.all([fetch('/api/matchup/'+game+'?window=20&min_confidence=0',{cache:'no-store'}).then(r=>r.json()),fetch('/api/broadcast/games/'+game,{cache:'no-store'}).then(r=>r.json())]);matchup=m;persisted=b.persisted_cards||[];render()}catch(e){$('#content').innerHTML='<div class="empty error">'+esc(e.message)+'</div>'}}
  function input(){$('#content').innerHTML='<div class="empty"><h2>Game ID</h2><input id="game"><button id="go">Открыть</button></div>';$('#go').onclick=()=>{game=$('#game').value.trim();location.href='/broadcast/operator?game='+encodeURIComponent(game)}}
  function render(){const g=matchup.game;$('#content').innerHTML=`<section class="hero"><div><div class="eyebrow">OPERATOR · MANUAL ONLY</div><h1>${esc(g.away_tri)} — ${esc(g.home_tri)}</h1><p>${esc(g.start_utc||'')}</p></div><div class="links"><a href="/matchup?game=${game}">Matchup Lab</a><a href="/broadcast?game=${game}">Broadcast</a><a href="/broadcast/overlay" target="_blank">Overlay</a></div></section><section class="grid"><article class="panel"><h3>Market Lab → draft</h3>${(matchup.top_markets||[]).map((m,i)=>`<div class="candidate"><span><b>${esc(m.label)}</b><small>${Math.round(Number(m.combined_rate)*100)}% · conf ${m.confidence}</small></span><button data-market="${i}">В черновик</button></div>`).join('')}</article><article class="panel"><h3>Player cards → draft</h3>${(matchup.player_markets||[]).map((c,i)=>`<div class="candidate"><span><b>${esc(c.market?.label||c.title)}</b><small>${esc(c.value||'')} · score ${Math.round(Number(c.score||0))}</small></span><button data-player="${i}">В черновик</button></div>`).join('')||'<div class="empty small">Нет player cards</div>'}</article></section><section class="panel"><h3>Persisted Broadcast cards</h3><div id="saved">${savedHtml()}</div></section>`;document.querySelectorAll('[data-market]').forEach(b=>b.onclick=()=>draftMarket(Number(b.dataset.market),b));document.querySelectorAll('[data-player]').forEach(b=>b.onclick=()=>draftPlayer(Number(b.dataset.player),b));bindSaved()}
  function savedHtml(){return persisted.map(c=>`<div class="saved"><div><b>${esc(c.headline_ru)}</b><small>${esc(c.stat_text_ru)} · ${esc(c.status)}</small></div><div class="actions">${c.status!=='shown'?`<button data-edit="${esc(c.card_id)}">Edit</button>`:''}${c.status==='draft'||c.status==='hidden'?`<button data-status="preview" data-card="${esc(c.card_id)}">PREVIEW</button>`:''}${c.status==='preview'?`<button class="show" data-status="shown" data-card="${esc(c.card_id)}">SHOW</button><button data-status="draft" data-card="${esc(c.card_id)}">BACK</button>`:''}${c.status==='shown'?`<button class="hide" data-status="hidden" data-card="${esc(c.card_id)}">HIDE</button>`:''}</div></div>`).join('')||'<div class="empty small">Черновиков пока нет</div>'}
  function bindSaved(){document.querySelectorAll('[data-status]').forEach(b=>b.onclick=()=>status(b.dataset.card,b.dataset.status,b));document.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>edit(b.dataset.edit))}
  async function draftMarket(i,b){if(!ensureToken())return;const m=matchup.top_markets[i];b.disabled=true;try{await api('/api/broadcast/operator/drafts/from-market',{method:'POST',body:JSON.stringify({game_pk:Number(game),window:20,market:m})});await reloadBroadcast()}catch(e){alert(e.message)}finally{b.disabled=false}}
  async function draftPlayer(i,b){if(!ensureToken())return;const c=matchup.player_markets[i];b.disabled=true;try{await api('/api/broadcast/operator/drafts/from-player',{method:'POST',body:JSON.stringify({game_pk:Number(game),candidate_id:c.id})});await reloadBroadcast()}catch(e){alert(e.message)}finally{b.disabled=false}}
  async function status(id,s,b){if(!ensureToken())return;if(s==='shown'&&!confirm('Показать эту карточку в эфир?'))return;b.disabled=true;try{await api('/api/broadcast/operator/cards/'+encodeURIComponent(id)+'/status',{method:'POST',body:JSON.stringify({status:s})});await reloadBroadcast()}catch(e){alert(e.message)}finally{b.disabled=false}}
  async function edit(id){if(!ensureToken())return;const c=persisted.find(x=>x.card_id===id);if(!c)return;const headline=prompt('Заголовок',c.headline_ru);if(headline===null)return;const stat=prompt('Статистика',c.stat_text_ru);if(stat===null)return;const source=prompt('Источник / пояснение',c.source_note_ru||'');if(source===null)return;const odds=prompt('Коэффициент (пусто = нет)',c.manual_odds??'');if(odds===null)return;try{await api('/api/broadcast/operator/cards/'+encodeURIComponent(id),{method:'PATCH',body:JSON.stringify({headline_ru:headline,stat_text_ru:stat,source_note_ru:source,manual_odds:odds})});await reloadBroadcast()}catch(e){alert(e.message)}}
  async function reloadBroadcast(){const b=await fetch('/api/broadcast/games/'+game,{cache:'no-store'}).then(r=>r.json());persisted=b.persisted_cards||[];$('#saved').innerHTML=savedHtml();bindSaved()}
  load();
}

const OPERATOR_HTML=`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HOH Broadcast Operator</title><style>:root{--bg:#09090b;--panel:#121216;--line:#2b2b31;--text:#f5f4f1;--muted:#73737c;--orange:#ff5a1f;--lav:#c8b7ff;--green:#79dea9;--red:#df7169}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,Arial,sans-serif}.wrap{max-width:1180px;margin:auto;padding:28px 18px 80px}.brand{font-weight:950}.brand i{font-style:normal;color:var(--orange)}.hero{display:flex;align-items:end;justify-content:space-between;border-bottom:1px solid var(--line);padding:28px 0 18px}.eyebrow{font-size:8px;color:var(--lav);letter-spacing:.1em}.hero h1{font-size:36px;margin:5px 0}.hero p{font-size:9px;color:#777}.links{display:flex;gap:6px}.links a{color:#aaa;text-decoration:none;border:1px solid var(--line);padding:8px 10px;border-radius:9px;font-size:9px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.panel{margin-top:10px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px}.panel h3{font-size:9px;color:var(--lav);letter-spacing:.1em;text-transform:uppercase}.candidate,.saved{display:flex;justify-content:space-between;align-items:center;gap:12px;border-bottom:1px solid #26262c;padding:10px 0}.candidate span,.saved>div:first-child{display:flex;flex-direction:column}.candidate b,.saved b{font-size:10px}.candidate small,.saved small{font-size:7px;color:#777;margin-top:3px}button,input{border:1px solid var(--line);background:#18181c;color:#fff;border-radius:8px;padding:8px 10px}button{font-weight:850;font-size:8px;cursor:pointer}.actions{display:flex;gap:5px}.show{background:var(--orange);color:#111;border-color:var(--orange)}.hide{border-color:#73413e;color:#e58a84}.empty{text-align:center;padding:45px;color:#777}.empty.small{padding:16px}.empty.error{color:var(--red)}@media(max-width:750px){.grid{grid-template-columns:1fr}.hero{display:block}.links{margin-top:10px;flex-wrap:wrap}.saved{align-items:flex-start;flex-direction:column}}</style></head><body><div class="wrap"><div class="brand">HOME OF <i>HOCKEY</i> · BROADCAST OPERATOR</div><main id="content"><div class="empty">Загрузка…</div></main></div><script src="/broadcast/operator/app.js"></script></body></html>`;

const OVERLAY_HTML=`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HOH Broadcast Overlay</title><style>html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden;font-family:Arial,sans-serif}.card{position:absolute;left:5vw;bottom:7vh;width:min(760px,88vw);background:#0b0b0e;color:#fff;border-left:8px solid #ff5a1f;border-radius:12px;padding:20px 24px;box-shadow:0 8px 40px rgba(0,0,0,.4);opacity:0;transform:translateY(30px);transition:.28s}.card.on{opacity:1;transform:none}.brand{font-size:13px;font-weight:900;color:#ff5a1f;letter-spacing:.08em}.headline{font-size:32px;font-weight:900;line-height:1.05;margin-top:7px}.stat{font-size:22px;font-weight:800;color:#c8b7ff;margin-top:9px}.source{font-size:12px;color:#92929b;margin-top:8px}</style></head><body><div class="card" id="card"><div class="brand">HOME OF HOCKEY × WINLINE</div><div class="headline" id="headline"></div><div class="stat" id="stat"></div><div class="source" id="source"></div></div><script>let current='';async function tick(){try{const r=await fetch('/api/broadcast/state',{cache:'no-store'}),d=await r.json(),c=d.on_air,el=document.getElementById('card');if(!c){current='';el.classList.remove('on');return}if(c.card_id!==current){current=c.card_id;document.getElementById('headline').textContent=c.headline_ru||'';document.getElementById('stat').textContent=c.stat_text_ru||'';document.getElementById('source').textContent=c.source_note_ru||''}el.classList.add('on')}catch{}}tick();setInterval(tick,1000);</script></body></html>`;
