import { evaluateMarketLines } from "./market-line-evaluator.js";
import { buildPlayerMarketInsights } from "./player-market-insights.js";
import { BROADCAST_CARD_CSS } from "./broadcast-card-theme.js";
import { applyTeamGrammar, applyDisplayTeamGrammar } from "./team-russian-grammar.js";

const NHL_BASE = "https://api-web.nhle.com/v1";
const ALLOWED_STATUSES = new Set(["draft","preview","shown","hidden"]);
const OPERATOR_LEASE_SECONDS = 90;
const TEAM_META={
  ANA:{name:"АНАХАЙМ",color:"#FC4C02"},BOS:{name:"БОСТОН",color:"#FFB81C"},BUF:{name:"БАФФАЛО",color:"#003087"},
  CGY:{name:"КАЛГАРИ",color:"#D2001C"},CAR:{name:"КАРОЛИНА",color:"#CE1126"},CHI:{name:"ЧИКАГО",color:"#CF0A2C"},
  COL:{name:"КОЛОРАДО",color:"#6F263D"},CBJ:{name:"КОЛАМБУС",color:"#002654"},DAL:{name:"ДАЛЛАС",color:"#006847"},
  DET:{name:"ДЕТРОЙТ",color:"#CE1126"},EDM:{name:"ЭДМОНТОН",color:"#FF4C00"},FLA:{name:"ФЛОРИДА",color:"#041E42"},
  LAK:{name:"ЛОС-АНДЖЕЛЕС",color:"#A2AAAD"},MIN:{name:"МИННЕСОТА",color:"#154734"},MTL:{name:"МОНРЕАЛЬ",color:"#AF1E2D"},
  NSH:{name:"НЭШВИЛЛ",color:"#FFB81C"},NJD:{name:"НЬЮ-ДЖЕРСИ",color:"#CE1126"},NYI:{name:"АЙЛЕНДЕРС",color:"#00539B"},
  NYR:{name:"РЕЙНДЖЕРС",color:"#0038A8"},OTT:{name:"ОТТАВА",color:"#C52032"},PHI:{name:"ФИЛАДЕЛЬФИЯ",color:"#F74902"},
  PIT:{name:"ПИТТСБУРГ",color:"#FCB514"},SJS:{name:"САН-ХОСЕ",color:"#006D75"},SEA:{name:"СИЭТЛ",color:"#99D9D9"},
  STL:{name:"СЕНТ-ЛУИС",color:"#002F87"},TBL:{name:"ТАМПА-БЭЙ",color:"#002868"},TOR:{name:"ТОРОНТО",color:"#003E7E"},
  UTA:{name:"ЮТА",color:"#71AFE5"},VAN:{name:"ВАНКУВЕР",color:"#00843D"},VGK:{name:"ВЕГАС",color:"#B4975A"},
  WSH:{name:"ВАШИНГТОН",color:"#C8102E"},WPG:{name:"ВИННИПЕГ",color:"#041E42"}
};

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

  const renderedMatch=/^\/api\/broadcast\/rendered\/([^/]+)\.png$/.exec(path);
  if(renderedMatch){
    if(request.method!=="GET")return json({ok:false,error:"method_not_allowed"},405);
    return renderedCardRoute(env,decodeURIComponent(renderedMatch[1]));
  }

  if (!path.startsWith("/api/broadcast/operator/")) return null;
  if (path === "/api/broadcast/operator/status") {
    if (request.method !== "GET") return json({ok:false,error:"method_not_allowed"},405);
    return json({
      ok:true,
      operator_key_configured:Boolean(String(env.MANAGEMENT_API_SECRET||"").trim()),
      operator_key_required:String(env.BROADCAST_OPERATOR_OPEN||"")!=="1"
    });
  }
  if (!env.DB) return json({ok:false,error:"missing_d1_binding"},503);
  const openBroadcastOperator=String(env.BROADCAST_OPERATOR_OPEN||"")==="1";
  if (!openBroadcastOperator && !(await managementAuthorized(request,env))) return json({ok:false,error:"unauthorized"},401);

  if (path === "/api/broadcast/operator/actions") {
    if (request.method !== "GET") return json({ok:false,error:"method_not_allowed"},405);
    return listOperatorActions(request,env);
  }

  const leaseMatch = /^\/api\/broadcast\/operator\/leases\/(\d+)$/.exec(path);
  if (leaseMatch) {
    const gamePk=positiveInt(leaseMatch[1]);
    if(!gamePk)return json({ok:false,error:"invalid_game_pk"},400);
    if(request.method==="GET")return getOperatorLease(env,gamePk);
    if(request.method==="POST")return acquireOperatorLease(request,env,gamePk);
    if(request.method==="DELETE")return releaseOperatorLease(request,env,gamePk);
    return json({ok:false,error:"method_not_allowed"},405);
  }

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
  const lease=await compatibleOperatorLease(env.DB,gamePk,body.operator_id);
  if(!lease.ok)return json(lease,423);
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
  const lease=await compatibleOperatorLease(env.DB,gamePk,body.operator_id);
  if(!lease.ok)return json(lease,423);
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
  const lease=await compatibleOperatorLease(env.DB,gamePk,body.operator_id);
  if(!lease.ok)return json(lease,423);
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
    headline_ru:String(candidate.broadcast_title||candidate.title||candidate.value||candidate.eyebrow||"HOH INSIGHT").slice(0,180),
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
    ) VALUES(?,?,NULL,999,?,?,?,?,?,?,?,?,'draft',CURRENT_TIMESTAMP)
    ON CONFLICT(card_id) DO UPDATE SET
      headline_ru=excluded.headline_ru,stat_text_ru=excluded.stat_text_ru,source_note_ru=excluded.source_note_ru,
      suggested_market_type=excluded.suggested_market_type,suggested_market_subject=excluded.suggested_market_subject,
      manual_odds=excluded.manual_odds,odds_is_demo=excluded.odds_is_demo,payload_json=excluded.payload_json,
      status='draft',shown_at=NULL,render_hash=NULL,render_png_base64=NULL,render_bytes=NULL,rendered_at=NULL,updated_at=CURRENT_TIMESTAMP;
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
  const lease=await compatibleOperatorLease(env.DB,current.game_pk,body.operator_id);
  if(!lease.ok)return json(lease,423);
  const headline=textField(body.headline_ru,current.headline_ru,180);
  const stat=textField(body.stat_text_ru,current.stat_text_ru,240);
  const source=textField(body.source_note_ru,current.source_note_ru||"",500);
  const odds=body.manual_odds===null||body.manual_odds===""?null:Number(body.manual_odds);
  if(odds!==null&&(!Number.isFinite(odds)||odds<1.01||odds>100))return json({ok:false,error:"invalid_manual_odds"},400);
  await env.DB.prepare(`
    UPDATE broadcast_cards SET headline_ru=?,stat_text_ru=?,source_note_ru=?,manual_odds=?,odds_is_demo=?,
      render_hash=NULL,render_png_base64=NULL,render_bytes=NULL,rendered_at=NULL,updated_at=CURRENT_TIMESTAMP
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
  const lease=await compatibleOperatorLease(env.DB,current.game_pk,body.operator_id);
  if(!lease.ok)return json(lease,423);
  if(lease.lease&&body.operator_id)await renewOperatorLease(env.DB,current.game_pk,String(body.operator_id));

  let render=null;
  if(target==="shown"){
    const snapshot=body.card&&typeof body.card==="object"?body.card:null;
    if(snapshot){
      const synced=await syncCardSnapshotForShow(env.DB,current,snapshot);
      if(!synced.ok)return json(synced,synced.status||400);
    }
    try{render=await ensureRenderedCard(env,cardId)}catch(error){
      console.error("broadcast card render failed",error);
      return json({ok:false,error:"render_failed",message:String(error?.message||error)},502);
    }
    await env.DB.batch([
      env.DB.prepare(`UPDATE broadcast_cards SET status='hidden',shown_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE status='shown' AND game_pk=? AND card_id<>?;`).bind(current.game_pk,cardId),
      env.DB.prepare(`UPDATE broadcast_cards SET status='shown',shown_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE card_id=?;`).bind(cardId),
    ]);
  } else if(target==="preview"){
    await env.DB.batch([
      env.DB.prepare(`UPDATE broadcast_cards SET status='draft',updated_at=CURRENT_TIMESTAMP WHERE status='preview' AND game_pk=? AND card_id<>?;`).bind(current.game_pk,cardId),
      env.DB.prepare(`UPDATE broadcast_cards SET status='preview',shown_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE card_id=?;`).bind(cardId),
    ]);
  } else {
    await env.DB.prepare(`UPDATE broadcast_cards SET status=?,shown_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE card_id=?;`).bind(target,cardId).run();
  }
  if(target==="shown"||target==="hidden"){
    await recordOperatorAction(env.DB,{
      gamePk:current.game_pk,
      cardId,
      action:target,
      operatorId:normalizeOperatorId(body.operator_id)||"legacy",
      operatorName:normalizeOperatorName(body.operator_name,body.operator_id||"legacy"),
      headline:current.headline_ru,
      statText:current.stat_text_ru,
    });
  }
  return json({ok:true,action:"status_updated",render,card:await loadCard(env.DB,cardId)});
}

async function listOperatorActions(request,env){
  const url=new URL(request.url);
  const requested=Number(url.searchParams.get("limit")||30);
  const limit=Math.max(1,Math.min(50,Number.isFinite(requested)?Math.floor(requested):30));
  const gamePk=positiveInt(url.searchParams.get("game"));
  const sql=`
    SELECT a.id,a.game_pk,a.card_id,a.action,a.operator_id,a.operator_name,a.headline_ru,a.stat_text_ru,a.created_at,
           g.away_tri,g.home_tri
    FROM broadcast_operator_actions a
    LEFT JOIN games g ON g.game_pk=a.game_pk
    ${gamePk?"WHERE a.game_pk=?":""}
    ORDER BY a.id DESC
    LIMIT ?;
  `;
  const stmt=env.DB.prepare(sql);
  const result=gamePk?await stmt.bind(gamePk,limit).all():await stmt.bind(limit).all();
  return json({ok:true,actions:result.results||[],scope:{game_pk:gamePk||null},limit});
}

async function recordOperatorAction(db,{gamePk,cardId,action,operatorId,operatorName,headline,statText}){
  try{
    await db.prepare(`
      INSERT INTO broadcast_operator_actions(
        game_pk,card_id,action,operator_id,operator_name,headline_ru,stat_text_ru,created_at
      ) VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP);
    `).bind(
      gamePk,
      String(cardId||"").slice(0,180),
      String(action||"").slice(0,24),
      String(operatorId||"legacy").slice(0,96),
      String(operatorName||"Оператор").slice(0,48),
      String(headline||"").slice(0,240),
      String(statText||"").slice(0,240),
    ).run();
  }catch(error){
    // Action history must never block the live broadcast path.
    console.error("broadcast operator action log failed",error);
  }
}

async function syncCardSnapshotForShow(db,current,candidate){
  const market=candidate?.market&&typeof candidate.market==="object"?candidate.market:{};
  const odds=Number(market.odds);
  if(!Number.isFinite(odds)||odds<=1){
    return {ok:false,error:"invalid_visible_odds",status:409};
  }
  if(market.odds_is_demo!==false||String(market.odds_source||"")!=="provider_live"){
    return {ok:false,error:"winline_price_required",status:409};
  }
  const expectedId=safeId(`insight-${current.game_pk}-${String(candidate.id||candidate.insight_type||candidate.type||"insight")}`);
  if(expectedId!==String(current.card_id)){
    return {ok:false,error:"card_snapshot_mismatch",status:409};
  }
  const subject=String(market.subject||market.side||candidate.evidence?.team||candidate.team_tri||"").slice(0,120);
  const headline=String(candidate.broadcast_title||candidate.title||candidate.value||candidate.eyebrow||"HOH INSIGHT").slice(0,180);
  const stat=String(market.label||candidate.value||"").slice(0,240);
  const source=String(candidate.explanation||candidate.note||"HOH Data Core").slice(0,500);
  const payload=JSON.stringify(candidate).slice(0,50000);
  await db.prepare(`
    UPDATE broadcast_cards
    SET headline_ru=?,stat_text_ru=?,source_note_ru=?,
        suggested_market_type=?,suggested_market_subject=?,
        manual_odds=?,odds_is_demo=0,payload_json=?,
        render_hash=NULL,render_png_base64=NULL,render_bytes=NULL,rendered_at=NULL,
        updated_at=CURRENT_TIMESTAMP
    WHERE card_id=? AND game_pk=?;
  `).bind(
    headline,
    stat,
    source,
    String(market.type||candidate.insight_type||"insight").slice(0,80),
    subject,
    odds,
    payload,
    current.card_id,
    current.game_pk,
  ).run();
  return {ok:true,odds};
}

async function getOperatorLease(env,gamePk){
  const lease=await activeOperatorLease(env.DB,gamePk);
  return json({ok:true,game_pk:gamePk,lease});
}

async function acquireOperatorLease(request,env,gamePk){
  let body;
  try{body=await request.json()}catch{return json({ok:false,error:"invalid_json"},400)}
  const operatorId=normalizeOperatorId(body.operator_id);
  if(!operatorId)return json({ok:false,error:"invalid_operator_id"},400);
  const operatorName=normalizeOperatorName(body.operator_name,operatorId);
  await env.DB.prepare(`
    INSERT INTO broadcast_operator_leases(game_pk,operator_id,operator_name,acquired_at,expires_at,updated_at)
    VALUES(?,?,?,CURRENT_TIMESTAMP,datetime('now','+${OPERATOR_LEASE_SECONDS} seconds'),CURRENT_TIMESTAMP)
    ON CONFLICT(game_pk) DO UPDATE SET
      operator_id=excluded.operator_id,
      operator_name=excluded.operator_name,
      acquired_at=CASE WHEN broadcast_operator_leases.operator_id=excluded.operator_id THEN broadcast_operator_leases.acquired_at ELSE CURRENT_TIMESTAMP END,
      expires_at=excluded.expires_at,
      updated_at=CURRENT_TIMESTAMP
    WHERE broadcast_operator_leases.operator_id=excluded.operator_id
       OR datetime(broadcast_operator_leases.expires_at)<=datetime('now');
  `).bind(gamePk,operatorId,operatorName).run();
  const lease=await activeOperatorLease(env.DB,gamePk);
  if(!lease||String(lease.operator_id)!==operatorId){
    return json({ok:false,error:"game_locked",message:`Матч уже ведёт ${lease?.operator_name||"другой оператор"}`,game_pk:gamePk,lease},423);
  }
  return json({ok:true,acquired:true,game_pk:gamePk,lease});
}

async function releaseOperatorLease(request,env,gamePk){
  let body={};
  try{body=await request.json()}catch{}
  const operatorId=normalizeOperatorId(body.operator_id);
  if(!operatorId)return json({ok:false,error:"invalid_operator_id"},400);
  await env.DB.prepare(`DELETE FROM broadcast_operator_leases WHERE game_pk=? AND operator_id=?;`).bind(gamePk,operatorId).run();
  return json({ok:true,released:true,game_pk:gamePk,lease:await activeOperatorLease(env.DB,gamePk)});
}

async function activeOperatorLease(db,gamePk){
  const row=await db.prepare(`
    SELECT game_pk,operator_id,operator_name,acquired_at,expires_at,updated_at
    FROM broadcast_operator_leases
    WHERE game_pk=? AND datetime(expires_at)>datetime('now')
    LIMIT 1;
  `).bind(gamePk).first();
  return row||null;
}

async function compatibleOperatorLease(db,gamePk,rawOperatorId){
  const lease=await activeOperatorLease(db,gamePk);
  if(!lease)return {ok:true,lease:null};
  const operatorId=normalizeOperatorId(rawOperatorId);
  if(operatorId&&String(lease.operator_id)===operatorId)return {ok:true,lease};
  return {ok:false,error:"game_locked",message:`Матч уже ведёт ${lease.operator_name||"другой оператор"}`,game_pk:gamePk,lease};
}

async function renewOperatorLease(db,gamePk,operatorId){
  await db.prepare(`
    UPDATE broadcast_operator_leases
    SET expires_at=datetime('now','+${OPERATOR_LEASE_SECONDS} seconds'),updated_at=CURRENT_TIMESTAMP
    WHERE game_pk=? AND operator_id=?;
  `).bind(gamePk,operatorId).run();
}

function normalizeOperatorId(value){
  const s=String(value||"").trim();
  return /^[a-zA-Z0-9_.:-]{8,96}$/.test(s)?s:null;
}
function normalizeOperatorName(value,operatorId){
  const s=String(value||"").trim().replace(/\s+/g," ").slice(0,48);
  return s||("Оператор "+String(operatorId||"").slice(-4).toUpperCase());
}

async function renderedCardRoute(env,cardId){
  if(!env.DB)return json({ok:false,error:"missing_d1_binding"},503);
  const row=await env.DB.prepare(
    "SELECT card_id,render_hash,render_png_base64,render_bytes,rendered_at FROM broadcast_cards WHERE card_id=? LIMIT 1;"
  ).bind(cardId).first();
  if(!row||!row.render_png_base64)return json({ok:false,error:"render_not_found"},404);
  try{
    const raw=atob(String(row.render_png_base64));
    const bytes=new Uint8Array(raw.length);
    for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
    return new Response(bytes,{status:200,headers:{
      "Content-Type":"image/png",
      "Content-Length":String(bytes.length),
      "Cache-Control":"public, max-age=31536000, immutable",
      "ETag":"\""+String(row.render_hash||"")+"\"",
      "X-HOH-Render-Hash":String(row.render_hash||""),
      "X-Content-Type-Options":"nosniff"
    }});
  }catch(error){
    console.error("stored broadcast PNG decode failed",error);
    return json({ok:false,error:"render_decode_failed"},500);
  }
}

async function ensureRenderedCard(env,cardId){
  const row=await loadCardForRender(env.DB,cardId);
  if(!row)throw new Error("card_not_found");
  const payload=rendererPayloadFromRow(row);
  if(!Number.isFinite(Number(payload.odds))||Number(payload.odds)<=1)throw new Error("winline_price_required");
  const body=JSON.stringify(payload);
  const hash=await sha256Hex("renderer-v13-accent-cover-2026-09-21:"+body);
  if(String(row.render_hash||"")===hash&&row.render_png_base64){
    return {cached:true,hash,bytes:Number(row.render_bytes||0),rendered_at:row.rendered_at||null};
  }
  const base=String(env.BROADCAST_RENDERER_URL||"https://hoh-broadcast-renderer.vercel.app").replace(/\/+$/,"");
  const response=await fetch(base+"/api/render-card",{
    method:"POST",
    headers:{"Content-Type":"application/json","Accept":"image/png"},
    body,
    signal:AbortSignal.timeout(12000),
  });
  if(!response.ok){
    const message=await response.text().catch(()=>"");
    throw new Error("renderer_http_"+response.status+(message?": "+message.slice(0,240):""));
  }
  const type=String(response.headers.get("content-type")||"").toLowerCase();
  if(!type.includes("image/png"))throw new Error("renderer_invalid_content_type");
  const bytes=new Uint8Array(await response.arrayBuffer());
  if(bytes.length<100||bytes.length>2_000_000)throw new Error("renderer_invalid_png_size");
  const base64=bytesToBase64(bytes);
  await env.DB.prepare(`
    UPDATE broadcast_cards
    SET render_hash=?,render_png_base64=?,render_bytes=?,rendered_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
    WHERE card_id=?;
  `).bind(hash,base64,bytes.length,cardId).run();
  return {cached:false,hash,bytes:bytes.length,rendered_at:new Date().toISOString()};
}

async function loadCardForRender(db,cardId){
  return db.prepare(`
    SELECT bc.*,
           g.home_tri,g.away_tri,
           ht.name_ru AS home_name_ru,ht.name_en AS home_name,ht.logo_url AS home_logo,
           at.name_ru AS away_name_ru,at.name_en AS away_name,at.logo_url AS away_logo
    FROM broadcast_cards bc
    LEFT JOIN games g ON g.game_pk=bc.game_pk
    LEFT JOIN teams ht ON ht.tri_code=g.home_tri
    LEFT JOIN teams at ON at.tri_code=g.away_tri
    WHERE bc.card_id=? LIMIT 1;
  `).bind(cardId).first();
}

function rendererPayloadFromRow(row){
  const candidate=parsePayload(row.payload_json);
  const tri=renderTeamCode(row,candidate);
  const meta=TEAM_META[tri]||{name:tri||"КОМАНДА",color:"#00E6C3"};
  const logo=tri===String(row.home_tri||"").toUpperCase()?row.home_logo:row.away_logo;
  const market=candidate.market&&typeof candidate.market==="object"?candidate.market:{};
  const odds=Number(market.odds??row.manual_odds);
  return {
    team:tri,
    team_name:meta.name,
    team_color:meta.color,
    team_logo_url:logo||undefined,
    fact:renderFactText(candidate,row),
    market:renderMarketText(candidate,row,meta.name),
    odds:Number.isFinite(odds)&&odds>1?odds:null,
    stake:1000,
  };
}

function parsePayload(value){
  try{return value?JSON.parse(value):{}}catch{return{}}
}
function renderTeamCode(row,candidate){
  const away=String(row.away_tri||"").toUpperCase(),home=String(row.home_tri||"").toUpperCase();
  const market=candidate.market&&typeof candidate.market==="object"?candidate.market:{};
  const values=[market.subject,market.side,candidate.evidence?.team,candidate.team_tri,candidate.evidence?.subject_team,row.suggested_market_subject];
  for(const raw of values){const tri=String(raw||"").toUpperCase();if(tri===away||tri===home)return tri}
  const hay=[candidate.title,candidate.value,market.label,row.headline_ru,row.stat_text_ru].filter(Boolean).join(" ");
  if(away&&new RegExp("\\b"+away+"\\b","i").test(hay))return away;
  if(home&&new RegExp("\\b"+home+"\\b","i").test(hay))return home;
  for(const [tri,meta] of Object.entries(TEAM_META)){
    if((tri===away||tri===home)&&hay.toUpperCase().includes(meta.name))return tri;
  }
  return away||home||"";
}
function renderDisplayText(value){
  let s=String(value??"");
  for(const [tri,meta] of Object.entries(TEAM_META))s=s.replace(new RegExp("\\b"+tri+"\\b","gi"),meta.name);
  return s.replace(/([+-]?\d+)\.(\d+)/g,"$1,$2").toUpperCase();
}
function renderLineText(value){
  const n=Number(value);if(!Number.isFinite(n))return"";
  const abs=Math.abs(n).toString().replace(".",",");
  return (n>0?"+":n<0?"-":"")+abs;
}
function renderMarketText(candidate,row,teamName){
  const m=candidate.market&&typeof candidate.market==="object"?candidate.market:{};
  const type=String(m.type||row.suggested_market_type||"").toLowerCase();
  const side=String(m.side||"").toLowerCase();
  const line=Number(m.line);
  if(type==="handicap"){
    let value=Number.isFinite(line)?line:null;
    if(value===null){const found=String(m.label||row.stat_text_ru||"").match(/([+-]\d+(?:[.,]\d+)?)/);if(found)value=Number(found[1].replace(",","."))}
    return "ФОРА "+(value===null?"":renderLineText(value))+" ГОЛА";
  }
  if(type==="team_total")return (side==="under"?"ИТМ ":"ИТБ ")+(Number.isFinite(line)?String(Math.abs(line)).replace(".",","):"")+" ГОЛА";
  if(type==="game_total")return (side==="under"?"ТОТАЛ МЕНЬШЕ ":"ТОТАЛ БОЛЬШЕ ")+(Number.isFinite(line)?String(line).replace(".",","):"");
  if(type==="moneyline")return"ПОБЕДА";
  if(type==="next_goal_team")return"СЛЕДУЮЩИЙ ГОЛ";
  if(type==="period_2_result")return"2-Й ПЕРИОД · ПОБЕДА";
  const fallback=renderDisplayText(m.label||row.stat_text_ru||"СТАВКА WINLINE").replace(teamName,"").replace(/^\s*[·—-]+\s*/,"").trim();
  return fallback||"СТАВКА WINLINE";
}
function renderFactText(candidate,row){
  const m=candidate.market&&typeof candidate.market==="object"?candidate.market:{};
  const raw=applyTeamGrammar(candidate.title||row.headline_ru||candidate.value||row.stat_text_ru||"");
  let s=renderDisplayText(raw);
  for(const [tri,meta] of Object.entries(TEAM_META)) s=applyDisplayTeamGrammar(s,tri,meta.name);
  if(String(m.type||row.suggested_market_type||"").toLowerCase()==="handicap"&&!/ФОРУ[^А-ЯЁ]*[+-]?\d+(?:,\d+)?\s+ГОЛА/.test(s)){
    s=s.replace(/ФОРУ\s+([+-]?\d+(?:,\d+)?)/,"ФОРУ $1 ГОЛА");
  }
  return s;
}
async function sha256Hex(value){
  const data=new TextEncoder().encode(String(value));
  const digest=await crypto.subtle.digest("SHA-256",data);
  return [...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,"0")).join("");
}
function bytesToBase64(bytes){
  let out="";
  for(let i=0;i<bytes.length;i+=0x8000)out+=String.fromCharCode(...bytes.subarray(i,i+0x8000));
  return btoa(out);
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
  function render(){const g=matchup.game;$('#content').innerHTML=`<section class="hero"><div><div class="eyebrow">OPERATOR · MANUAL ONLY</div><h1>${esc(g.away_tri)} — ${esc(g.home_tri)}</h1><p>${esc(g.start_utc||'')}</p></div><div class="links"><a href="/matchup?game=${game}">Matchup Lab</a><a href="/broadcast?game=${game}">Broadcast</a><a href="/broadcast/overlay?game=${game}" target="_blank">Overlay этого матча</a></div></section><section class="grid"><article class="panel"><h3>Market Lab → draft</h3>${(matchup.top_markets||[]).map((m,i)=>`<div class="candidate"><span><b>${esc(m.label)}</b><small>${Math.round(Number(m.combined_rate)*100)}% · conf ${m.confidence}</small></span><button data-market="${i}">В черновик</button></div>`).join('')}</article><article class="panel"><h3>Player cards → draft</h3>${(matchup.player_markets||[]).map((c,i)=>`<div class="candidate"><span><b>${esc(c.market?.label||c.title)}</b><small>${esc(c.value||'')} · score ${Math.round(Number(c.score||0))}</small></span><button data-player="${i}">В черновик</button></div>`).join('')||'<div class="empty small">Нет player cards</div>'}</article></section><section class="panel"><h3>Persisted Broadcast cards</h3><div id="saved">${savedHtml()}</div></section>`;document.querySelectorAll('[data-market]').forEach(b=>b.onclick=()=>draftMarket(Number(b.dataset.market),b));document.querySelectorAll('[data-player]').forEach(b=>b.onclick=()=>draftPlayer(Number(b.dataset.player),b));bindSaved()}
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
/* HOME OF HOCKEY × WINLINE */
*{box-sizing:border-box}
html,body{margin:0;width:100%;height:100%;background:transparent!important;overflow:hidden}
.stage{position:fixed;inset:0;pointer-events:none}
#cardimg{position:absolute;left:64px;bottom:70px;width:574px;height:148px;object-fit:contain;opacity:0;transform:translateY(26px);transition:opacity .25s ease,transform .25s ease}
#cardimg.on{opacity:1;transform:none}
</style></head><body><div class="stage"><img id="cardimg" alt=""></div>
<script>
let current="";
const overlayGame=new URLSearchParams(location.search).get("game")||"";
const stateUrl="/api/broadcast/state"+(overlayGame?"?game="+encodeURIComponent(overlayGame):"");
async function tick(){
  const img=document.getElementById("cardimg");
  try{
    const r=await fetch(stateUrl,{cache:"no-store"});
    const d=await r.json();
    const c=d&&d.on_air;
    if(!c||!c.render_hash){
      current="";
      img.classList.remove("on");
      img.removeAttribute("src");
      return;
    }
    const key=String(c.card_id)+"@"+String(c.render_hash);
    if(key!==current){
      current=key;
      img.classList.remove("on");
      img.onload=()=>img.classList.add("on");
      img.onerror=()=>{img.classList.remove("on");current=""};
      img.src="/api/broadcast/rendered/"+encodeURIComponent(c.card_id)+".png?v="+encodeURIComponent(c.render_hash);
    }else{
      img.classList.add("on");
    }
  }catch(error){
    console.error(error);
    img.classList.remove("on");
  }
}
tick();
setInterval(tick,750);
</script></body></html>`;
