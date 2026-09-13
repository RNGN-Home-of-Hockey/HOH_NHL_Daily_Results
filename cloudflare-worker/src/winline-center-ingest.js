const IMPORT_PATH="/api/winline/center/import";
const STATUS_PATH="/api/winline/center/status";

export async function handleWinlineCenterIngest(request,env,path){
  if(path===STATUS_PATH&&request.method==="GET")return status(request,env);
  if(path!==IMPORT_PATH)return null;
  if(request.method!=="POST")return json({ok:false,error:"method_not_allowed"},405);
  if(!env.DB)return json({ok:false,error:"missing_d1_binding"},503);
  if(!(await authorized(request,env)))return json({ok:false,error:"unauthorized"},401);
  let body;try{body=await request.json()}catch{return json({ok:false,error:"invalid_json"},400)}
  const gamePk=Number(body?.game_pk),event=body?.event||{},markets=Array.isArray(body?.markets)?body.markets:[];
  if(!Number.isSafeInteger(gamePk)||gamePk<=0)return json({ok:false,error:"invalid_game_pk"},400);
  if(!await env.DB.prepare("SELECT 1 FROM games WHERE game_pk=? LIMIT 1").bind(gamePk).first())return json({ok:false,error:"game_not_found"},404);
  const eventId=clean(event.id||event.winline_event_id);if(!eventId)return json({ok:false,error:"missing_winline_event_id"},400);
  if(markets.length>500)return json({ok:false,error:"too_many_markets"},400);
  const normalized=[];for(let i=0;i<markets.length;i++){const m=normalizeMarket(markets[i]);if(!m.ok)return json({ok:false,error:m.error,index:i},400);normalized.push(m.value)}
  await env.DB.prepare(`INSERT INTO winline_events(winline_event_id,game_pk,status,starts_at,deeplink,raw_json,updated_at) VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(winline_event_id) DO UPDATE SET game_pk=excluded.game_pk,status=excluded.status,starts_at=excluded.starts_at,deeplink=excluded.deeplink,raw_json=excluded.raw_json,updated_at=CURRENT_TIMESTAMP`).bind(eventId,gamePk,clean(event.status)||"open",nullable(event.starts_at),nullable(event.deeplink),JSON.stringify(event.raw??event)).run();
  if(normalized.length){const stmts=normalized.map(m=>env.DB.prepare(`INSERT INTO winline_markets(winline_market_id,winline_event_id,market_type,subject_type,subject_key,outcome_name,odds,deeplink,is_live,active,raw_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(winline_market_id) DO UPDATE SET winline_event_id=excluded.winline_event_id,market_type=excluded.market_type,subject_type=excluded.subject_type,subject_key=excluded.subject_key,outcome_name=excluded.outcome_name,odds=excluded.odds,deeplink=excluded.deeplink,is_live=excluded.is_live,active=excluded.active,raw_json=excluded.raw_json,updated_at=CURRENT_TIMESTAMP`).bind(m.id,eventId,m.market_type,m.subject_type,m.subject_key,m.outcome_name,m.odds,m.deeplink,m.is_live,m.active,m.raw_json));await env.DB.batch(stmts)}
  return json({ok:true,game_pk:gamePk,winline_event_id:eventId,markets_upserted:normalized.length});
}

async function status(request,env){
  if(!env.DB)return json({ok:false,error:"missing_d1_binding"},503);
  try{const gamePk=Number(new URL(request.url).searchParams.get("game_pk"));if(Number.isSafeInteger(gamePk)&&gamePk>0){const e=await env.DB.prepare(`SELECT e.winline_event_id,e.game_pk,e.status,e.starts_at,e.deeplink,e.updated_at,COUNT(m.winline_market_id) market_count,SUM(CASE WHEN m.active=1 THEN 1 ELSE 0 END) active_market_count,MAX(m.updated_at) markets_updated_at FROM winline_events e LEFT JOIN winline_markets m ON m.winline_event_id=e.winline_event_id WHERE e.game_pk=? GROUP BY e.winline_event_id LIMIT 1`).bind(gamePk).first();return json({ok:true,game_pk:gamePk,event:e||null})}const [e,m,u]=await Promise.all([env.DB.prepare("SELECT COUNT(*) count FROM winline_events").first(),env.DB.prepare("SELECT COUNT(*) count,SUM(CASE WHEN active=1 THEN 1 ELSE 0 END) active FROM winline_markets").first(),env.DB.prepare("SELECT MAX(updated_at) updated_at FROM winline_markets").first()]);return json({ok:true,events:Number(e?.count||0),markets:Number(m?.count||0),active_markets:Number(m?.active||0),latest_market_update:u?.updated_at||null})}catch(error){return json({ok:false,error:"winline_schema_not_ready",detail:String(error?.message||error)},503)}}

function normalizeMarket(raw){if(!raw||typeof raw!=="object")return{ok:false,error:"invalid_market"};const id=clean(raw.id||raw.winline_market_id||raw.market_id),type=clean(raw.market_type||raw.type),odds=Number(raw.odds);if(!id)return{ok:false,error:"missing_market_id"};if(!type)return{ok:false,error:"missing_market_type"};if(!Number.isFinite(odds)||odds<=1)return{ok:false,error:"invalid_odds"};return{ok:true,value:{id,market_type:type,subject_type:lowerOrNull(raw.subject_type),subject_key:nullable(raw.subject_key),outcome_name:nullable(raw.outcome_name||raw.outcome||raw.name),odds,deeplink:nullable(raw.deeplink||raw.url),is_live:truthy(raw.is_live)?1:0,active:raw.active===false||raw.active===0?0:1,raw_json:JSON.stringify(raw.raw??raw)}}}
async function authorized(request,env){const expected=clean(env.MANAGEMENT_API_SECRET),m=/^Bearer\s+(\S+)$/i.exec(clean(request.headers.get("authorization")));return Boolean(expected&&m&&await secureEqual(m[1],expected))}
async function secureEqual(a,b){const e=new TextEncoder(),[x,y]=await Promise.all([crypto.subtle.digest("SHA-256",e.encode(a)),crypto.subtle.digest("SHA-256",e.encode(b))]),aa=new Uint8Array(x),bb=new Uint8Array(y);let d=aa.length^bb.length;for(let i=0;i<Math.min(aa.length,bb.length);i++)d|=aa[i]^bb[i];return d===0}
function clean(v){return String(v??"").trim()}function nullable(v){const x=clean(v);return x||null}function lowerOrNull(v){const x=clean(v).toLowerCase();return x||null}function truthy(v){return v===true||v===1||String(v).toLowerCase()==="true"}function json(p,s=200){return new Response(JSON.stringify(p),{status:s,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}})}
