import { getCenterNotificationStatus, runCenterNotificationTick } from "./telegram-center-notification-engine.js";

const API="/api/telegram-center-notifications-v2";

export async function handleTelegramCenterNotificationRoutes(request,env,path){
  if(!path.startsWith(API))return null;
  if(path===`${API}/status`&&request.method==="GET")return json(await getCenterNotificationStatus(env));
  if(path===`${API}/me`&&["GET","PUT","POST"].includes(request.method))return notificationPreferences(request,env);
  if(path===`${API}/tick`&&request.method==="POST"){
    if(!(await authorized(request,env)))return json({ok:false,error:"unauthorized"},401);
    const url=new URL(request.url),dryRun=url.searchParams.get("dry_run")!=="0";
    try{const result=await runCenterNotificationTick(env,{dryRun});return json(result,result.ok?200:500)}catch(error){return json({ok:false,error:"center_notification_tick_failed",detail:String(error?.message||error)},500)}
  }
  return json({ok:false,error:"not_found"},404);
}


async function notificationPreferences(request,env){
  if(!env.DB)return json({ok:false,error:"missing_d1_binding"},503);
  const auth=await telegramAuth(request,env);
  if(!auth.ok)return json({ok:false,error:auth.error},401);
  await upsertTelegramUser(env.DB,auth.user);
  if(request.method!=="GET"){
    let body={};try{body=await request.json()}catch{return json({ok:false,error:"invalid_json"},400)}
    const timezone=body.timezone_name===undefined?undefined:validTimezone(body.timezone_name);
    if(body.timezone_name!==undefined&&!timezone)return json({ok:false,error:"invalid_timezone"},400);
    const digest=body.daily_player_digest===undefined?undefined:(body.daily_player_digest?1:0);
    const hour=body.daily_digest_hour===undefined?undefined:clampHour(body.daily_digest_hour);
    if(body.daily_digest_hour!==undefined&&hour===null)return json({ok:false,error:"invalid_digest_hour"},400);
    const postgame=body.player_postgame_reports===undefined?undefined:(body.player_postgame_reports?1:0);
    const current=await env.DB.prepare(`SELECT timezone_name,daily_player_digest,daily_digest_hour,player_postgame_reports FROM notification_user_preferences WHERE telegram_user_id=? LIMIT 1;`).bind(auth.user.id).first().catch(()=>null);
    const next={
      timezone_name:timezone===undefined?(current?.timezone_name||null):timezone,
      daily_player_digest:digest===undefined?Number(current?.daily_player_digest??1):digest,
      daily_digest_hour:hour===undefined?Number(current?.daily_digest_hour??20):hour,
      player_postgame_reports:postgame===undefined?Number(current?.player_postgame_reports??1):postgame,
    };
    await env.DB.prepare(`
      INSERT INTO notification_user_preferences(telegram_user_id,timezone_name,daily_player_digest,daily_digest_hour,player_postgame_reports,updated_at)
      VALUES(?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(telegram_user_id) DO UPDATE SET
        timezone_name=excluded.timezone_name,
        daily_player_digest=excluded.daily_player_digest,
        daily_digest_hour=excluded.daily_digest_hour,
        player_postgame_reports=excluded.player_postgame_reports,
        updated_at=CURRENT_TIMESTAMP;
    `).bind(auth.user.id,next.timezone_name,next.daily_player_digest,next.daily_digest_hour,next.player_postgame_reports).run();
  }
  const row=await env.DB.prepare(`
    SELECT timezone_name,daily_player_digest,daily_digest_hour,player_postgame_reports,updated_at
    FROM notification_user_preferences WHERE telegram_user_id=? LIMIT 1;
  `).bind(auth.user.id).first().catch(()=>null);
  return json({ok:true,preferences:{
    timezone_name:row?.timezone_name||null,
    daily_player_digest:Number(row?.daily_player_digest??1),
    daily_digest_hour:Number(row?.daily_digest_hour??20),
    player_postgame_reports:Number(row?.player_postgame_reports??1),
    updated_at:row?.updated_at||null,
  }});
}
async function telegramAuth(request,env){
  const initData=String(request.headers.get("x-telegram-init-data")||"").trim();
  if(!initData)return {ok:false,error:"missing_telegram_init_data"};
  const token=String(env.TELEGRAM_CENTER_BOT_TOKEN||"").trim();
  if(!token)return {ok:false,error:"missing_telegram_center_token"};
  try{
    const p=new URLSearchParams(initData),provided=p.get("hash")||"",date=Number(p.get("auth_date")||0),userRaw=p.get("user")||"";
    p.delete("hash");
    if(!provided||!date||!userRaw)return {ok:false,error:"invalid_telegram_init_data"};
    const maxAgeRaw=Number(env.TELEGRAM_WEBAPP_MAX_AGE_SECONDS||86400),maxAge=Number.isFinite(maxAgeRaw)?Math.min(604800,Math.max(300,Math.floor(maxAgeRaw))):86400;
    if(Math.abs(Math.floor(Date.now()/1000)-date)>maxAge)return {ok:false,error:"telegram_init_data_expired"};
    const check=[...p.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join("\n"),enc=new TextEncoder();
    const k1=await crypto.subtle.importKey("raw",enc.encode("WebAppData"),{name:"HMAC",hash:"SHA-256"},false,["sign"]),secret=await crypto.subtle.sign("HMAC",k1,enc.encode(token)),k2=await crypto.subtle.importKey("raw",secret,{name:"HMAC",hash:"SHA-256"},false,["sign"]),digest=await crypto.subtle.sign("HMAC",k2,enc.encode(check)),calc=hex(new Uint8Array(digest));
    if(!(await secureEq(calc,provided.toLowerCase())))return {ok:false,error:"telegram_signature_invalid"};
    const u=JSON.parse(userRaw),id=Number(u.id);if(!Number.isSafeInteger(id)||id<=0)return {ok:false,error:"telegram_user_invalid"};
    return {ok:true,user:{id,username:u.username||null,first_name:u.first_name||null,last_name:u.last_name||null,language_code:u.language_code||null}};
  }catch{return {ok:false,error:"telegram_init_data_invalid"}}
}
async function upsertTelegramUser(db,u){
  await db.prepare(`INSERT INTO telegram_users(telegram_user_id,username,first_name,last_name,language_code,notifications_enabled,updated_at)
    VALUES(?,?,?,?,?,1,CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_user_id) DO UPDATE SET username=excluded.username,first_name=excluded.first_name,last_name=excluded.last_name,language_code=excluded.language_code,updated_at=CURRENT_TIMESTAMP;`)
    .bind(u.id,u.username,u.first_name,u.last_name,u.language_code).run();
}
function validTimezone(v){const s=String(v||"").trim().slice(0,80);if(!s)return null;try{new Intl.DateTimeFormat("en-US",{timeZone:s}).format(new Date());return s}catch{return null}}
function clampHour(v){const n=Number(v);return Number.isSafeInteger(n)&&n>=0&&n<=23?n:null}
function hex(bytes){return [...bytes].map(x=>x.toString(16).padStart(2,"0")).join("")}

async function authorized(request,env){const expected=String(env.MANAGEMENT_API_SECRET||"").trim(),auth=String(request.headers.get("authorization")||"").trim(),m=/^Bearer\s+(.+)$/i.exec(auth);return Boolean(expected&&m&&await secureEq(m[1],expected))}
async function secureEq(a,b){const e=new TextEncoder(),[x,y]=await Promise.all([crypto.subtle.digest("SHA-256",e.encode(String(a))),crypto.subtle.digest("SHA-256",e.encode(String(b)))]),aa=new Uint8Array(x),bb=new Uint8Array(y);let d=aa.length^bb.length;for(let i=0;i<Math.min(aa.length,bb.length);i++)d|=aa[i]^bb[i];return d===0}
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}})}
