const NHL_BASE = "https://api-web.nhle.com/v1";

export async function handleTelegramGameSubscriptionRequest(request, env, path) {
  if (path !== "/api/telegram-app/follows" || !["POST","DELETE"].includes(request.method)) return null;

  let body;
  try { body = await request.clone().json(); } catch { return null; }
  if (String(body?.subject_type || "").trim().toLowerCase() !== "game") return null;

  if (!env.DB) return json({ok:false,error:"missing_d1_binding"},503);
  const key = String(body?.subject_key || "").trim();
  if (!/^\d+$/.test(key)) return json({ok:false,error:"invalid_subject"},400);
  const gamePk = Number(key);
  if (!Number.isSafeInteger(gamePk) || gamePk <= 0) return json({ok:false,error:"invalid_subject"},400);

  const auth = await telegramAuth(request, env);
  if (!auth.ok) return json({ok:false,error:auth.error},401);

  if (request.method === "POST") {
    const validGame = await nhlGameExists(gamePk);
    if (!validGame) return json({ok:false,error:"subject_not_found"},404);
  }

  await upsertTelegramUser(env.DB, auth.user);
  if (request.method === "DELETE") {
    await env.DB.prepare(`DELETE FROM subscriptions WHERE telegram_user_id=? AND subject_type='game' AND subject_key=?;`)
      .bind(auth.user.id,key).run();
  } else {
    const flags = notificationFlags(body);
    await env.DB.prepare(`
      INSERT INTO subscriptions(
        telegram_user_id,subject_type,subject_key,notify_pregame,notify_start,
        notify_goal,notify_assist,notify_period_end,notify_final
      ) VALUES(?,'game',?,?,?,?,?,?,?)
      ON CONFLICT(telegram_user_id,subject_type,subject_key) DO UPDATE SET
        notify_pregame=excluded.notify_pregame,
        notify_start=excluded.notify_start,
        notify_goal=excluded.notify_goal,
        notify_assist=excluded.notify_assist,
        notify_period_end=excluded.notify_period_end,
        notify_final=excluded.notify_final;
    `).bind(auth.user.id,key,flags.pregame,flags.start,flags.goal,flags.assist,flags.periodEnd,flags.final).run();
  }

  const follows = await env.DB.prepare(`
    SELECT subscription_id,subject_type,subject_key,notify_pregame,notify_start,notify_goal,
           notify_assist,notify_period_end,notify_final,created_at
    FROM subscriptions WHERE telegram_user_id=? ORDER BY subject_type,subject_key;
  `).bind(auth.user.id).all();
  return json({ok:true,removed:request.method==="DELETE",follows:follows.results||[]});
}

async function nhlGameExists(gamePk) {
  try {
    const response = await fetch(`${NHL_BASE}/gamecenter/${gamePk}/boxscore`,{headers:{Accept:"application/json"}});
    return response.ok;
  } catch {
    return false;
  }
}

async function telegramAuth(request,env) {
  const initData=String(request.headers.get("x-telegram-init-data")||"").trim();
  if (!initData) return {ok:false,error:"missing_telegram_init_data"};
  if (!env.TELEGRAM_BOT_TOKEN) return {ok:false,error:"missing_bot_token"};
  try {
    const params=new URLSearchParams(initData);
    const providedHash=params.get("hash")||"";
    const authDate=Number(params.get("auth_date")||0);
    const userRaw=params.get("user")||"";
    params.delete("hash");
    if (!providedHash||!authDate||!userRaw) return {ok:false,error:"invalid_telegram_init_data"};
    const maxAge=envInt(env.TELEGRAM_WEBAPP_MAX_AGE_SECONDS,86400,300,604800);
    if (Math.abs(Math.floor(Date.now()/1000)-authDate)>maxAge) return {ok:false,error:"telegram_init_data_expired"};
    const dataCheck=[...params.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join("\n");
    const encoder=new TextEncoder();
    const key1=await crypto.subtle.importKey("raw",encoder.encode("WebAppData"),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
    const secret=await crypto.subtle.sign("HMAC",key1,encoder.encode(String(env.TELEGRAM_BOT_TOKEN)));
    const key2=await crypto.subtle.importKey("raw",secret,{name:"HMAC",hash:"SHA-256"},false,["sign"]);
    const digest=await crypto.subtle.sign("HMAC",key2,encoder.encode(dataCheck));
    const calculated=bytesToHex(new Uint8Array(digest));
    if (!(await safeTextEqual(calculated,providedHash.toLowerCase()))) return {ok:false,error:"telegram_signature_invalid"};
    const raw=JSON.parse(userRaw);const id=Number(raw.id);
    if(!Number.isSafeInteger(id)||id<=0)return {ok:false,error:"telegram_user_invalid"};
    return {ok:true,user:{id,username:raw.username||null,first_name:raw.first_name||null,last_name:raw.last_name||null,language_code:raw.language_code||null}};
  } catch {
    return {ok:false,error:"telegram_init_data_invalid"};
  }
}

async function upsertTelegramUser(db,user) {
  await db.prepare(`
    INSERT INTO telegram_users(telegram_user_id,username,first_name,last_name,language_code,notifications_enabled,updated_at)
    VALUES(?,?,?,?,?,1,CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_user_id) DO UPDATE SET username=excluded.username,first_name=excluded.first_name,
      last_name=excluded.last_name,language_code=excluded.language_code,updated_at=CURRENT_TIMESTAMP;
  `).bind(user.id,user.username,user.first_name,user.last_name,user.language_code).run();
}

function notificationFlags(body){const b=(key,fallback)=>body[key]===undefined?fallback:Number(Boolean(body[key]));return {pregame:b("notify_pregame",1),start:b("notify_start",1),goal:b("notify_goal",1),assist:b("notify_assist",0),periodEnd:b("notify_period_end",1),final:b("notify_final",1)}}
function envInt(value,fallback,min,max){const n=Number(value);return Number.isSafeInteger(n)&&n>=min&&n<=max?n:fallback}
function bytesToHex(bytes){return [...bytes].map(x=>x.toString(16).padStart(2,"0")).join("")}
async function safeTextEqual(a,b){const e=new TextEncoder();const [da,db]=await Promise.all([crypto.subtle.digest("SHA-256",e.encode(a)),crypto.subtle.digest("SHA-256",e.encode(b))]);const aa=new Uint8Array(da),bb=new Uint8Array(db);let d=0;for(let i=0;i<aa.length;i++)d|=aa[i]^bb[i];return d===0}
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}})}
