import { getWinlineFeedMaintenanceStatus, runWinlineFeedMaintenance } from "./winline-feed-maintenance.js";
const IMPORT_PATH="/api/winline/center/import";
const STATUS_PATH="/api/winline/center/status";
const REFRESH_PATH="/api/winline/center/refresh";
const SNAPSHOT_INTERVAL_MS=15*60*1000;

export async function handleWinlineCenterIngest(request,env,path){
  if(path===STATUS_PATH&&request.method==="GET")return status(request,env);
  if(path===REFRESH_PATH){
    if(request.method!=="POST")return json({ok:false,error:"method_not_allowed"},405);
    if(!env.DB)return json({ok:false,error:"missing_d1_binding"},503);
    if(!(await authorized(request,env)))return json({ok:false,error:"unauthorized"},401);
    try{
      const result=await runWinlineFeedMaintenance(env,{force:true});
      return json(result,result?.ok===false?500:200);
    }catch(error){
      return json({ok:false,error:"winline_refresh_failed",detail:String(error?.message||error)},500);
    }
  }
  if(path!==IMPORT_PATH)return null;
  if(request.method!=="POST")return json({ok:false,error:"method_not_allowed"},405);
  if(!env.DB)return json({ok:false,error:"missing_d1_binding"},503);
  if(!(await authorized(request,env)))return json({ok:false,error:"unauthorized"},401);
  let body;try{body=await request.json()}catch{return json({ok:false,error:"invalid_json"},400)}
  const gamePk=Number(body?.game_pk),event=body?.event||{},markets=Array.isArray(body?.markets)?body.markets:[];
  if(!Number.isSafeInteger(gamePk)||gamePk<=0)return json({ok:false,error:"invalid_game_pk"},400);
  const game=await env.DB.prepare("SELECT game_pk,scheduled_start_utc FROM games WHERE game_pk=? LIMIT 1").bind(gamePk).first();
  if(!game)return json({ok:false,error:"game_not_found"},404);
  const eventId=clean(event.id||event.winline_event_id);if(!eventId)return json({ok:false,error:"missing_winline_event_id"},400);
  if(markets.length>500)return json({ok:false,error:"too_many_markets"},400);
  const normalized=[];for(let i=0;i<markets.length;i++){const m=normalizeMarket(markets[i]);if(!m.ok)return json({ok:false,error:m.error,index:i},400);normalized.push(m.value)}

  await env.DB.prepare(`
    INSERT INTO winline_events(winline_event_id,game_pk,status,starts_at,deeplink,raw_json,updated_at)
    VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(winline_event_id) DO UPDATE SET
      game_pk=excluded.game_pk,status=excluded.status,starts_at=excluded.starts_at,
      deeplink=excluded.deeplink,raw_json=excluded.raw_json,updated_at=CURRENT_TIMESTAMP
  `).bind(eventId,gamePk,clean(event.status)||"open",nullable(event.starts_at),nullable(event.deeplink),JSON.stringify(event.raw??event)).run();

  let snapshotRows=0;
  if(normalized.length){
    const stmts=normalized.map(m=>env.DB.prepare(`
      INSERT INTO winline_markets(winline_market_id,winline_event_id,market_type,subject_type,subject_key,outcome_name,odds,deeplink,is_live,active,raw_json,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(winline_market_id) DO UPDATE SET
        winline_event_id=excluded.winline_event_id,market_type=excluded.market_type,subject_type=excluded.subject_type,
        subject_key=excluded.subject_key,outcome_name=excluded.outcome_name,odds=excluded.odds,deeplink=excluded.deeplink,
        is_live=excluded.is_live,active=excluded.active,raw_json=excluded.raw_json,updated_at=CURRENT_TIMESTAMP
    `).bind(m.id,eventId,m.market_type,m.subject_type,m.subject_key,m.outcome_name,m.odds,m.deeplink,m.is_live,m.active,m.raw_json));
    await env.DB.batch(stmts);
    snapshotRows=await capturePregameSnapshot(env.DB,game,eventId,normalized);
  }
  return json({ok:true,game_pk:gamePk,winline_event_id:eventId,markets_upserted:normalized.length,pregame_snapshot_rows:snapshotRows});
}

async function capturePregameSnapshot(db,game,eventId,markets){
  const start=Date.parse(String(game?.scheduled_start_utc||""));
  if(!Number.isFinite(start)||Date.now()>=start)return 0;
  const candidates=markets.filter(m=>m.is_live===0&&m.active===1&&isPrimaryOutcomeMarket(m));
  if(!candidates.length)return 0;
  try{
    const last=await db.prepare(`SELECT MAX(captured_at) captured_at FROM winline_market_snapshots WHERE game_pk=?;`).bind(game.game_pk).first();
    const lastAt=Date.parse(String(last?.captured_at||"").replace(" ","T")+(String(last?.captured_at||"").includes("Z")?"":"Z"));
    if(Number.isFinite(lastAt)&&Date.now()-lastAt<SNAPSHOT_INTERVAL_MS)return 0;
    const capturedAt=new Date().toISOString();
    const stmts=candidates.map(m=>db.prepare(`
      INSERT INTO winline_market_snapshots(game_pk,winline_event_id,winline_market_id,market_type,subject_type,subject_key,outcome_name,odds,deeplink,is_live,captured_at,source_updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,0,?,CURRENT_TIMESTAMP)
    `).bind(game.game_pk,eventId,m.id,m.market_type,m.subject_type,m.subject_key,m.outcome_name,m.odds,m.deeplink,capturedAt));
    await db.batch(stmts);return stmts.length;
  }catch(error){
    if(/no such table:\s*winline_market_snapshots/i.test(String(error?.message||error)))return 0;
    throw error;
  }
}
function isPrimaryOutcomeMarket(m){
  const type=String(m.market_type||"").toLowerCase(),name=String(m.outcome_name||"").trim().toLowerCase();
  if(/1x2|3.?way|match.?result|regular|60|min|основ|исход/.test(type))return true;
  return /^(п1|п2|н|1|2|x|х|home|away|draw|ничья|хозяева|гости)$/i.test(name);
}

async function status(request,env){
  if(!env.DB)return json({ok:false,error:"missing_d1_binding"},503);
  try{
    const gamePk=Number(new URL(request.url).searchParams.get("game_pk"));
    if(Number.isSafeInteger(gamePk)&&gamePk>0){
      const [e,s]=await Promise.all([
        env.DB.prepare(`SELECT e.winline_event_id,e.game_pk,e.status,e.starts_at,e.deeplink,e.updated_at,COUNT(m.winline_market_id) market_count,SUM(CASE WHEN m.active=1 THEN 1 ELSE 0 END) active_market_count,MAX(m.updated_at) markets_updated_at FROM winline_events e LEFT JOIN winline_markets m ON m.winline_event_id=e.winline_event_id WHERE e.game_pk=? GROUP BY e.winline_event_id LIMIT 1`).bind(gamePk).first(),
        env.DB.prepare(`SELECT COUNT(*) snapshot_count,MAX(captured_at) latest_snapshot_at FROM winline_market_snapshots WHERE game_pk=?`).bind(gamePk).first().catch(()=>({snapshot_count:0,latest_snapshot_at:null}))
      ]);
      return json({ok:true,game_pk:gamePk,event:e||null,snapshots:Number(s?.snapshot_count||0),latest_snapshot_at:s?.latest_snapshot_at||null});
    }
    const [e,m,u,s]=await Promise.all([
      env.DB.prepare("SELECT COUNT(*) count FROM winline_events").first(),
      env.DB.prepare("SELECT COUNT(*) count,SUM(CASE WHEN active=1 THEN 1 ELSE 0 END) active FROM winline_markets").first(),
      env.DB.prepare("SELECT MAX(updated_at) updated_at FROM winline_markets").first(),
      env.DB.prepare("SELECT COUNT(*) count,COUNT(DISTINCT game_pk) games,MAX(captured_at) latest FROM winline_market_snapshots").first().catch(()=>({count:0,games:0,latest:null}))
    ]);
    const feed_sync=await getWinlineFeedMaintenanceStatus(env).catch(()=>null);
    return json({ok:true,events:Number(e?.count||0),markets:Number(m?.count||0),active_markets:Number(m?.active||0),latest_market_update:u?.updated_at||null,snapshots:Number(s?.count||0),snapshot_games:Number(s?.games||0),latest_snapshot_at:s?.latest||null,feed_sync});
  }catch(error){return json({ok:false,error:"winline_schema_not_ready",detail:String(error?.message||error)},503)}
}

function normalizeMarket(raw){if(!raw||typeof raw!=="object")return{ok:false,error:"invalid_market"};const id=clean(raw.id||raw.winline_market_id||raw.market_id),type=clean(raw.market_type||raw.type),odds=Number(raw.odds);if(!id)return{ok:false,error:"missing_market_id"};if(!type)return{ok:false,error:"missing_market_type"};if(!Number.isFinite(odds)||odds<=1)return{ok:false,error:"invalid_odds"};return{ok:true,value:{id,market_type:type,subject_type:lowerOrNull(raw.subject_type),subject_key:nullable(raw.subject_key),outcome_name:nullable(raw.outcome_name||raw.outcome||raw.name),odds,deeplink:nullable(raw.deeplink||raw.url),is_live:truthy(raw.is_live)?1:0,active:raw.active===false||raw.active===0?0:1,raw_json:JSON.stringify(raw.raw??raw)}}}
async function authorized(request,env){const expected=clean(env.MANAGEMENT_API_SECRET),m=/^Bearer\s+(\S+)$/i.exec(clean(request.headers.get("authorization")));return Boolean(expected&&m&&await secureEqual(m[1],expected))}
async function secureEqual(a,b){const e=new TextEncoder(),[x,y]=await Promise.all([crypto.subtle.digest("SHA-256",e.encode(a)),crypto.subtle.digest("SHA-256",e.encode(b))]),aa=new Uint8Array(x),bb=new Uint8Array(y);let d=aa.length^bb.length;for(let i=0;i<Math.min(aa.length,bb.length);i++)d|=aa[i]^bb[i];return d===0}
function clean(v){return String(v??"").trim()}function nullable(v){const x=clean(v);return x||null}function lowerOrNull(v){const x=clean(v).toLowerCase();return x||null}function truthy(v){return v===true||v===1||String(v).toLowerCase()==="true"}function json(p,s=200){return new Response(JSON.stringify(p),{status:s,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}})}
