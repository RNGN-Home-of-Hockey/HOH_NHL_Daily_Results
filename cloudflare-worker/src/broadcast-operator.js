import { evaluateMarketLines } from "./market-line-evaluator.js";
import { buildPlayerMarketInsights } from "./player-market-insights.js";

const NHL_BASE = "https://api-web.nhle.com/v1";
const ALLOWED_STATUSES = new Set(["draft","preview","shown","hidden"]);

export async function handleBroadcastOperatorRequest(request, env, path) {
  if (path === "/broadcast/operator") {
    if (request.method !== "GET") return json({ok:false,error:"method_not_allowed"},405);
    const url=new URL(request.url);
    const game=url.searchParams.get("game");
    const target="/broadcast"+(game?"?game="+encodeURIComponent(game):"");
    return html('<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HOH Broadcast Operator</title></head><body style="background:#080808;color:#fff;font-family:Arial,sans-serif"><div style="padding:24px">BROADCAST OPERATOR · переход в единый Control Room…</div><script>location.replace('+JSON.stringify(target)+')</script></body></html>',{cache:"no-store"});
  }
  if (path === "/broadcast/operator/app.js") {
    if (request.method !== "GET") return json({ok:false,error:"method_not_allowed"},405);
    return js(`const __name=(target,value)=>target;\n(${browserApp.toString()})();`);
  }
  if (path === "/broadcast/overlay") {
    if (request.method !== "GET") return json({ok:false,error:"method_not_allowed"},405);
    return html(OVERLAY_HTML,{cache:"no-store"});
  }

  if (!path.startsWith("/api/broadcast/operator/")) return null;
  if (path === "/api/broadcast/operator/status") {
    if (request.method !== "GET") return json({ok:false,error:"method_not_allowed"},405);
    return json({ok:true,operator_key_configured:Boolean(String(env.MANAGEMENT_API_SECRET||"").trim())});
  }
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
  if (path === "/api/broadcast/operator/drafts/from-insight") {
    if (request.method !== "POST") return json({ok:false,error:"method_not_allowed"},405);
    return createInsightDraft(request,env);
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
    payload_json:JSON.stringify({id:`market-${gamePk}`,title:`${game.away_tri} — ${game.home_tri}: ${candidate.label}`,value:`${pct(candidate.combined_rate)}`,market:{type:candidate.market_type,subject:candidate.subject,side:candidate.side,line:candidate.line,label:candidate.label,odds:null},evidence:candidate.evidence||{}}),
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
    payload_json:JSON.stringify(candidate),
  };
  return persistDraft(env.DB,card,{source:"player_market",candidate});
}

async function createInsightDraft(request,env){
  let body;
  try{body=await request.json()}catch{return json({ok:false,error:"invalid_json"},400)}
  const gamePk=positiveInt(body.game_pk);
  const candidate=body.card&&typeof body.card==="object"?body.card:null;
  if(!gamePk||!candidate)return json({ok:false,error:"invalid_request"},400);
  const game=await env.DB.prepare(`
    SELECT g.game_pk,g.home_tri,g.away_tri,g.scheduled_start_utc,g.game_state
    FROM games g WHERE g.game_pk=? LIMIT 1;
  `).bind(gamePk).first();
  if(!game)return json({ok:false,error:"game_not_found"},404);
  const market=candidate.market&&typeof candidate.market==="object"?candidate.market:{};
  const odds=Number(market.odds);
  const subject=String(market.subject||market.side||candidate.evidence?.team||candidate.team_tri||"").slice(0,120);
  const payload=JSON.stringify(candidate);
  const idBase=String(candidate.id||candidate.insight_type||candidate.type||"insight");
  const card={
    card_id:safeId(`insight-${gamePk}-${idBase}`),
    game_pk:gamePk,
    headline_ru:String(candidate.title||candidate.value||candidate.eyebrow||"HOH INSIGHT").slice(0,180),
    stat_text_ru:String(market.label||candidate.value||"").slice(0,240),
    source_note_ru:String(candidate.explanation||candidate.note||"HOH Data Core").slice(0,500),
    suggested_market_type:String(market.type||candidate.insight_type||"insight").slice(0,80),
    suggested_market_subject:subject,
    manual_odds:Number.isFinite(odds)?odds:null,
    odds_is_demo:market.odds_is_demo===true?1:0,
    payload_json:payload.slice(0,50000),
  };
  return persistDraft(env.DB,card,{source:"broadcast_dashboard",candidate});
}

async function persistDraft(db,card,meta){
  const existing=await db.prepare(`SELECT card_id,status FROM broadcast_cards WHERE card_id=? LIMIT 1;`).bind(card.card_id).first();
  if(existing && ["shown","preview"].includes(String(existing.status))) {
    return json({ok:false,error:"card_locked_on_air",card_id:card.card_id,status:existing.status},409);
  }
  await db.prepare(`
    INSERT INTO broadcast_cards(
      card_id,game_pk,insight_id,display_order,headline_ru,stat_text_ru,source_note_ru,
      suggested_market_type,suggested_market_subject,manual_odds,odds_is_demo,payload_json,status,updated_at
    ) VALUES(?,?,NULL,999,?,?,?,?,?,?,?,?,?,'draft',CURRENT_TIMESTAMP)
    ON CONFLICT(card_id) DO UPDATE SET
      headline_ru=excluded.headline_ru,stat_text_ru=excluded.stat_text_ru,source_note_ru=excluded.source_note_ru,
      suggested_market_type=excluded.suggested_market_type,suggested_market_subject=excluded.suggested_market_subject,
      manual_odds=excluded.manual_odds,odds_is_demo=excluded.odds_is_demo,payload_json=excluded.payload_json,
      status='draft',shown_at=NULL,updated_at=CURRENT_TIMESTAMP;
  `).bind(
    card.card_id,card.game_pk,card.headline_ru,card.stat_text_ru,card.source_note_ru,
    card.suggested_market_type,card.suggested_market_subject,card.manual_odds,card.odds_is_demo,card.payload_json||null,
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
function js(body){return new Response(body,{headers:{"Content-Type":"application/javascript; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}})}

function browserApp(){
  const $=s=>document.querySelector(s);const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let token=sessionStorage.getItem('hohOperatorToken')||'';let game=new URLSearchParams(location.search).get('game')||'';let matchup=null;let persisted=[];
  async function api(url,opts={}){const headers={...(opts.headers||{})};if(token)headers.Authorization='Bearer '+token;if(opts.body&&!headers['Content-Type'])headers['Content-Type']='application/json';const r=await fetch(url,{...opts,headers,cache:'no-store'});const d=await r.json().catch(()=>({}));if(r.status===401)throw new Error('Нужен Operator key');if(!r.ok)throw new Error(d.error||('HTTP '+r.status));return d}
  function ensureToken(){if(token)return true;token=prompt('Operator key')||'';if(token)sessionStorage.setItem('hohOperatorToken',token);return Boolean(token)}
  async function load(){try{if(!/^\d+$/.test(game)){const list=await fetch('/api/broadcast/games',{cache:'no-store'}).then(r=>r.json());game=String(list.games?.[0]?.game_pk||'');if(!game){input();return}history.replaceState(null,'','/broadcast/operator?game='+encodeURIComponent(game))}$('#content').innerHTML='<div class="empty">Загрузка…</div>';const [m,b]=await Promise.all([fetch('/api/matchup/'+game+'?window=20&min_confidence=0',{cache:'no-store'}).then(async r=>{const d=await r.json();if(!r.ok)throw new Error(d.error||('matchup HTTP '+r.status));return d}),fetch('/api/broadcast/games/'+game,{cache:'no-store'}).then(async r=>{const d=await r.json();if(!r.ok)throw new Error(d.error||('broadcast HTTP '+r.status));return d})]);matchup=m;persisted=b.persisted_cards||[];render()}catch(e){$('#content').innerHTML='<div class="empty error">'+esc(e.message)+'</div>'}}
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

const OVERLAY_HTML=`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HOH Broadcast Overlay</title><style>
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;background:transparent!important;overflow:hidden;font-family:Arial,sans-serif}.stage{position:fixed;inset:0;pointer-events:none}.aircard{--team-color:#00e6c3;position:absolute;left:64px;bottom:70px;width:820px;height:196px;color:#fff;opacity:0;transform:translateY(26px);transition:opacity .25s ease,transform .25s ease}.aircard.on{opacity:1;transform:none}.factbar{position:absolute;left:0;right:0;top:0;height:58px;border:1px solid #5a5a60;border-radius:14px;background:linear-gradient(135deg,rgba(21,21,23,.98),rgba(8,8,10,.98));display:flex;align-items:center;padding:0 22px 0 36px;overflow:hidden;box-shadow:0 7px 24px rgba(0,0,0,.34)}.teamstripe{position:absolute;left:0;top:9px;bottom:9px;width:8px;border-radius:5px;background:var(--team-color);box-shadow:0 0 15px var(--team-color)}.facttext{font-size:18px;line-height:1;font-weight:900;letter-spacing:-.025em;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.facthot{color:#ff641e}.betpanel{position:absolute;left:0;right:0;top:66px;height:126px;border:1px solid #5a5a60;border-radius:15px;background:linear-gradient(135deg,rgba(16,17,19,.98),rgba(6,7,8,.98) 72%,rgba(15,16,18,.98));overflow:visible;box-shadow:0 9px 28px rgba(0,0,0,.38)}.teammark{position:absolute;left:0;top:0;width:126px;height:124px;border-right:1px solid #35353a;border-radius:14px 0 0 14px;background:linear-gradient(135deg,color-mix(in srgb,var(--team-color) 20%,#060708),#060708 70%);display:grid;place-items:center;overflow:hidden}.teammark img{width:92px;height:92px;object-fit:contain}.teammark span{font-size:24px;font-weight:900;color:#aaa}.betcopy{position:absolute;left:126px;top:0;width:276px;height:124px;padding:23px 20px;display:flex;flex-direction:column;justify-content:center;overflow:hidden}.betteam{font-size:30px;line-height:1;font-weight:900;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.betdesc{margin-top:10px;font-size:18px;line-height:1;font-weight:900;color:#d0d0d4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.winlinebrand{position:absolute;left:58%;top:24px;transform:translateX(-50%);width:174px;height:50px;display:grid;place-items:center}.winlinebrand svg{display:block;width:174px;height:auto}.oddsbox{position:absolute;right:0;top:-1px;width:148px;height:82px;background:linear-gradient(135deg,#176eff,#0b4df5);color:#fff;clip-path:polygon(12% 0,100% 0,92% 100%,0 100%);display:grid;place-items:center;padding:0 14px 0 25px;font-size:46px;line-height:1;font-weight:900;font-style:italic;letter-spacing:-.055em;border-radius:0 14px 0 0}.profitbox{position:absolute;right:-1px;bottom:-1px;width:58%;height:50px;border:1px solid #5b5b61;border-radius:14px;background:linear-gradient(135deg,rgba(25,25,28,.99),rgba(8,8,10,.99));display:flex;align-items:center;justify-content:center;gap:12px;padding:0 18px;white-space:nowrap;overflow:hidden}.profitbox strong{font-size:20px;color:#ff641e;font-weight:900}.profitbox span{font-size:12px;color:#c9c9ce;font-weight:850}
</style></head><body><!-- HOME OF HOCKEY × WINLINE --><div class="stage"><div class="aircard" id="card"><div class="factbar"><span class="teamstripe"></span><div class="facttext" id="fact"></div></div><div class="betpanel"><div class="teammark" id="teammark"></div><div class="betcopy"><div class="betteam" id="team"></div><div class="betdesc" id="market"></div></div><div class="winlinebrand"><svg viewBox="0 0 260 72" aria-label="Winline"><rect x="2" y="2" width="256" height="68" rx="34" fill="#090909" stroke="#ff641e" stroke-width="6"/><text x="24" y="49" fill="#fff" font-family="Arial Black,Arial,sans-serif" font-size="38" font-weight="900" font-style="italic" letter-spacing="-2">WINLINE</text><circle cx="226" cy="36" r="23" fill="#ff641e"/></svg></div><div class="oddsbox" id="odds"></div><div class="profitbox"><strong id="profit"></strong><span>(ПРИ СТАВКЕ 1000 РУБ.)</span></div></div></div></div><script>
const META={ANA:["АНАХАЙМ","#FC4C02"],BOS:["БОСТОН","#FFB81C"],BUF:["БАФФАЛО","#003087"],CGY:["КАЛГАРИ","#D2001C"],CAR:["КАРОЛИНА","#CE1126"],CHI:["ЧИКАГО","#CF0A2C"],COL:["КОЛОРАДО","#6F263D"],CBJ:["КОЛАМБУС","#002654"],DAL:["ДАЛЛАС","#006847"],DET:["ДЕТРОЙТ","#CE1126"],EDM:["ЭДМОНТОН","#FF4C00"],FLA:["ФЛОРИДА","#C8102E"],LAK:["ЛОС-АНДЖЕЛЕС","#A2AAAD"],MIN:["МИННЕСОТА","#154734"],MTL:["МОНРЕАЛЬ","#AF1E2D"],NSH:["НЭШВИЛЛ","#FFB81C"],NJD:["НЬЮ-ДЖЕРСИ","#CE1126"],NYI:["АЙЛЕНДЕРС","#00539B"],NYR:["РЕЙНДЖЕРС","#0038A8"],OTT:["ОТТАВА","#C52032"],PHI:["ФИЛАДЕЛЬФИЯ","#F74902"],PIT:["ПИТТСБУРГ","#FCB514"],SJS:["САН-ХОСЕ","#006D75"],SEA:["СИЭТЛ","#99D9D9"],STL:["СЕНТ-ЛУИС","#002F87"],TBL:["ТАМПА-БЭЙ","#002868"],TOR:["ТОРОНТО","#003E7E"],UTA:["ЮТА","#71AFE5"],VAN:["ВАНКУВЕР","#00843D"],VGK:["ВЕГАС","#B4975A"],WSH:["ВАШИНГТОН","#C8102E"],WPG:["ВИННИПЕГ","#AC162C"]};
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function payload(c){try{return c?.payload_json?JSON.parse(c.payload_json):{}}catch{return{}}}
function teamCode(c,p){const a=String(c.away_tri||"").toUpperCase(),h=String(c.home_tri||"").toUpperCase();for(const v of [p?.market?.subject,p?.market?.side,p?.evidence?.team,c.suggested_market_subject]){const x=String(v||"").toUpperCase();if(x===a||x===h)return x}const t=String(p?.title||c.headline_ru||"").toUpperCase();if(a&&t.includes(a))return a;if(h&&t.includes(h))return h;return a||h}
function displayText(v){let s=String(v??"");for(const [tri,m] of Object.entries(META))s=s.replace(new RegExp("\\b"+tri+"\\b","gi"),m[0]);return s.replace(/([+-]?\\d+)\\.(\\d+)/g,"$1,$2").toUpperCase()}
function marketText(c,p,teamName){const m=p?.market||{},type=String(m.type||c.suggested_market_type||"").toLowerCase(),side=String(m.side||"").toLowerCase(),line=Number(m.line);const n=Number.isFinite(line)?String(Math.abs(line)).replace(".",","):"";if(type==="handicap")return"ФОРА "+(line>0?"+":line<0?"-":"")+n+" ГОЛА";if(type==="team_total")return(side==="under"?"ИТМ ":"ИТБ ")+n+" ГОЛА";if(type==="game_total")return(side==="under"?"ТОТАЛ МЕНЬШЕ ":"ТОТАЛ БОЛЬШЕ ")+n;if(type==="moneyline")return"ПОБЕДА";if(type==="next_goal_team")return"СЛЕДУЮЩИЙ ГОЛ";return displayText(m.label||c.stat_text_ru||"СТАВКА WINLINE").replace(teamName,"").trim()}
function factHtml(c,p,teamName){let s=esc(displayText(p?.title||c.headline_ru||""));if(teamName)s=s.replace(esc(teamName),'<span class="facthot">'+esc(teamName)+'</span>');s=s.replace(/(\\d+\\s+ИЗ\\s+\\d+)/g,'<span class="facthot">$1</span>');return s}
function render(c){const p=payload(c),tri=teamCode(c,p),meta=META[tri]||[tri||"КОМАНДА","#00e6c3"],name=meta[0],color=meta[1],isHome=tri===String(c.home_tri||"").toUpperCase(),logo=isHome?c.home_logo:c.away_logo,od=Number(p?.market?.odds??c.manual_odds),profit=Number.isFinite(od)&&od>1?Math.round((od-1)*1000):null,el=document.getElementById("card");el.style.setProperty("--team-color",color);document.getElementById("fact").innerHTML=factHtml(c,p,name);document.getElementById("team").textContent=name;document.getElementById("market").textContent=marketText(c,p,name);document.getElementById("odds").textContent=Number.isFinite(od)?od.toFixed(2):"—";document.getElementById("profit").textContent=profit===null?"—":"+"+profit.toLocaleString("ru-RU")+" РУБ";document.getElementById("teammark").innerHTML=logo?'<img src="'+esc(logo)+'" alt="'+esc(name)+'">':'<span>'+esc(tri)+'</span>';el.classList.add("on")}
let current="";async function tick(){try{const r=await fetch("/api/broadcast/state",{cache:"no-store"}),d=await r.json(),c=d.on_air,el=document.getElementById("card");if(!c){current="";el.classList.remove("on");return}if(c.card_id!==current){current=c.card_id;render(c)}else el.classList.add("on")}catch(e){console.error(e)}}tick();setInterval(tick,750);
</script></body></html>`
