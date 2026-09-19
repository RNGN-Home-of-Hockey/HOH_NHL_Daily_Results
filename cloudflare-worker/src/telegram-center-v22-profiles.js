const API="/api/telegram-center-v22";

export async function handleTelegramCenterV22Profiles(request,env,path){
  if(!path.startsWith(API))return null;
  if(!env?.DB)return json({ok:false,error:"missing_d1_binding"},503);

  if(path===API+"/me"&&request.method==="GET")return getMe(request,env);
  if(path===API+"/me"&&request.method==="PUT")return putMe(request,env);

  const m=/^\/api\/telegram-center-v22\/avatars\/(\d+)$/.exec(path);
  if(m&&request.method==="GET")return avatar(env,Number(m[1]));
  return json({ok:false,error:"not_found"},404);
}

async function getMe(request,env){
  const auth=await telegramAuth(request,env,true);
  if(!auth.ok)return json({ok:false,error:auth.error},401);
  await upsertTelegramUser(env.DB,auth.user);
  const p=await env.DB.prepare(`
    SELECT telegram_user_id,display_username,profile_name,birth_date,city,hockey_since_year,
           favorite_team_tri,favorite_player,theme_mode,no_spoilers,
           CASE WHEN avatar_base64 IS NOT NULL AND avatar_base64<>'' THEN 1 ELSE 0 END has_avatar,
           avatar_bytes,username_changed_at,updated_at
    FROM app_user_profiles WHERE telegram_user_id=? LIMIT 1;
  `).bind(auth.user.id).first();
  return json({ok:true,user:auth.user,profile:decorateProfile(p,auth.user.id)});
}

async function putMe(request,env){
  const auth=await telegramAuth(request,env,true);
  if(!auth.ok)return json({ok:false,error:auth.error},401);
  await upsertTelegramUser(env.DB,auth.user);
  let body;try{body=await request.json()}catch{return json({ok:false,error:"invalid_json"},400)}

  const current=await env.DB.prepare("SELECT * FROM app_user_profiles WHERE telegram_user_id=? LIMIT 1").bind(auth.user.id).first();
  let username=cleanUsername(body?.display_username);
  if(body?.display_username!==undefined&&!username)return json({ok:false,error:"invalid_username",detail:"3–24 символа: буквы, цифры, _"},400);
  if(body?.display_username===undefined)username=current?.display_username||null;

  if(username&&usernameNorm(current?.display_username)!==usernameNorm(username)){
    const changed=Date.parse(String(current?.username_changed_at||"").replace(" ","T")+"Z");
    if(Number.isFinite(changed)&&Date.now()-changed<24*3600*1000){
      return json({ok:false,error:"username_change_cooldown",next_change_at:new Date(changed+24*3600*1000).toISOString()},409);
    }
    const wanted=usernameNorm(username);
    const exists=await env.DB.prepare("SELECT telegram_user_id FROM app_user_profiles WHERE display_username_norm=? AND telegram_user_id<>? LIMIT 1").bind(wanted,auth.user.id).first();
    if(exists)return json({ok:false,error:"username_taken"},409);
    // Compatibility with profiles created before display_username_norm existed.
    const legacy=await env.DB.prepare("SELECT telegram_user_id,display_username FROM app_user_profiles WHERE display_username_norm IS NULL AND telegram_user_id<>? AND display_username IS NOT NULL").bind(auth.user.id).all().catch(()=>({results:[]}));
    if((legacy.results||[]).some(x=>usernameNorm(x.display_username)===wanted))return json({ok:false,error:"username_taken"},409);
  }

  const profileName=body?.profile_name===undefined?(current?.profile_name||null):cleanText(body.profile_name,40);
  const city=body?.city===undefined?(current?.city||null):cleanText(body.city,60);
  const favoritePlayer=body?.favorite_player===undefined?(current?.favorite_player||null):cleanText(body.favorite_player,80);
  const birthDate=body?.birth_date===undefined?(current?.birth_date||null):cleanDate(body.birth_date);
  if(body?.birth_date!==undefined&&body.birth_date&&!birthDate)return json({ok:false,error:"invalid_birth_date"},400);
  let hockeySince=body?.hockey_since_year===undefined?numOrNull(current?.hockey_since_year):numOrNull(body.hockey_since_year);
  const year=new Date().getUTCFullYear();
  if(hockeySince!==null&&(hockeySince<1900||hockeySince>year))return json({ok:false,error:"invalid_hockey_since_year"},400);
  let favTeam=body?.favorite_team_tri===undefined?cleanTri(current?.favorite_team_tri):cleanTri(body.favorite_team_tri);
  if(favTeam){
    const t=await env.DB.prepare("SELECT tri_code FROM teams WHERE tri_code=? LIMIT 1").bind(favTeam).first();
    if(!t)return json({ok:false,error:"invalid_favorite_team"},400);
  }
  const theme=body?.theme_mode===undefined?(current?.theme_mode||"dark"):String(body.theme_mode||"").toLowerCase();
  if(!["dark","light"].includes(theme))return json({ok:false,error:"invalid_theme"},400);
  const noSpoilers=body?.no_spoilers===undefined?Boolean(Number(current?.no_spoilers||0)):Boolean(body.no_spoilers);

  let avatarMime=current?.avatar_mime||null,avatarBase64=current?.avatar_base64||null,avatarBytes=numOrNull(current?.avatar_bytes);
  if(body?.avatar_data_url===null){avatarMime=null;avatarBase64=null;avatarBytes=null}
  else if(typeof body?.avatar_data_url==="string"&&body.avatar_data_url){
    const a=parseAvatar(body.avatar_data_url);
    if(!a.ok)return json({ok:false,error:a.error,max_bytes:120000},400);
    avatarMime=a.mime;avatarBase64=a.base64;avatarBytes=a.bytes;
  }

  const usernameChanged=username&&usernameNorm(current?.display_username)!==usernameNorm(username)?new Date().toISOString().replace("T"," ").replace("Z",""):current?.username_changed_at||null;
  await env.DB.prepare(`
    INSERT INTO app_user_profiles
      (telegram_user_id,display_username,display_username_norm,profile_name,birth_date,city,hockey_since_year,favorite_team_tri,favorite_player,
       theme_mode,no_spoilers,avatar_mime,avatar_base64,avatar_bytes,username_changed_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_user_id) DO UPDATE SET
      display_username=excluded.display_username,display_username_norm=excluded.display_username_norm,profile_name=excluded.profile_name,birth_date=excluded.birth_date,
      city=excluded.city,hockey_since_year=excluded.hockey_since_year,favorite_team_tri=excluded.favorite_team_tri,
      favorite_player=excluded.favorite_player,theme_mode=excluded.theme_mode,no_spoilers=excluded.no_spoilers,avatar_mime=excluded.avatar_mime,
      avatar_base64=excluded.avatar_base64,avatar_bytes=excluded.avatar_bytes,
      username_changed_at=excluded.username_changed_at,updated_at=CURRENT_TIMESTAMP;
  `).bind(auth.user.id,username,usernameNorm(username),profileName,birthDate,city,hockeySince,favTeam,favoritePlayer,theme,noSpoilers?1:0,avatarMime,avatarBase64,avatarBytes,usernameChanged).run();

  const saved=await env.DB.prepare(`
    SELECT telegram_user_id,display_username,profile_name,birth_date,city,hockey_since_year,
           favorite_team_tri,favorite_player,theme_mode,no_spoilers,
           CASE WHEN avatar_base64 IS NOT NULL AND avatar_base64<>'' THEN 1 ELSE 0 END has_avatar,
           avatar_bytes,username_changed_at,updated_at
    FROM app_user_profiles WHERE telegram_user_id=? LIMIT 1;
  `).bind(auth.user.id).first();
  return json({ok:true,profile:decorateProfile(saved,auth.user.id)});
}

async function avatar(env,id){
  if(!Number.isSafeInteger(id)||id<=0)return new Response("not_found",{status:404});
  const p=await env.DB.prepare("SELECT avatar_mime,avatar_base64 FROM app_user_profiles WHERE telegram_user_id=? LIMIT 1").bind(id).first();
  if(!p?.avatar_base64)return new Response("not_found",{status:404});
  try{
    const raw=atob(String(p.avatar_base64)),bytes=new Uint8Array(raw.length);
    for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
    return new Response(bytes,{headers:{"Content-Type":p.avatar_mime||"image/webp","Cache-Control":"public, max-age=3600","X-Content-Type-Options":"nosniff"}});
  }catch{return new Response("not_found",{status:404})}
}

function decorateProfile(p,id){
  if(!p)return {exists:false,telegram_user_id:id,display_username:null,profile_name:null,birth_date:null,city:null,hockey_since_year:null,favorite_team_tri:null,favorite_player:null,theme_mode:"dark",no_spoilers:false,has_avatar:false,avatar_url:null,username_changed_at:null};
  return {...p,exists:true,no_spoilers:Boolean(Number(p.no_spoilers)),has_avatar:Boolean(Number(p.has_avatar)),avatar_url:Number(p.has_avatar)?API+"/avatars/"+id:null};
}
function cleanUsername(v){const s=String(v||"").trim().replace(/^@/,"");return /^[A-Za-zА-Яа-яЁё0-9_]{3,24}$/u.test(s)?s:null}
function usernameNorm(v){return v?String(v).normalize("NFKC").toLocaleLowerCase("ru-RU"):null}
function cleanText(v,max){const s=String(v||"").trim().replace(/\s+/g," ");return s?s.slice(0,max):null}
function cleanDate(v){const s=String(v||"").trim();if(!s)return null;if(!/^\d{4}-\d{2}-\d{2}$/.test(s))return null;const d=new Date(s+"T00:00:00Z");return Number.isNaN(d.getTime())?null:s}
function cleanTri(v){const s=String(v||"").trim().toUpperCase();return /^[A-Z]{3}$/.test(s)?s:null}
function numOrNull(v){if(v===null||v===undefined||v==="")return null;const n=Number(v);return Number.isFinite(n)?Math.trunc(n):null}
function parseAvatar(v){
  const m=/^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(String(v||""));
  if(!m)return {ok:false,error:"invalid_avatar_format"};
  const base64=m[2],bytes=Math.floor(base64.length*3/4)-(base64.endsWith("==")?2:base64.endsWith("=")?1:0);
  if(bytes<100||bytes>120000)return {ok:false,error:"avatar_too_large"};
  return {ok:true,mime:m[1],base64,bytes};
}
async function upsertTelegramUser(db,user){
  await db.prepare(`INSERT INTO telegram_users(telegram_user_id,username,first_name,last_name,language_code,notifications_enabled,updated_at)
    VALUES(?,?,?,?,?,1,CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_user_id) DO UPDATE SET username=excluded.username,first_name=excluded.first_name,last_name=excluded.last_name,language_code=excluded.language_code,updated_at=CURRENT_TIMESTAMP`)
    .bind(user.id,user.username,user.first_name,user.last_name,user.language_code).run();
}
async function telegramAuth(request,env,required){
  const initData=String(request.headers.get("x-telegram-init-data")||"").trim();
  if(!initData)return required?{ok:false,error:"missing_telegram_init_data"}:{ok:false,error:"guest"};
  const token=String(env.TELEGRAM_CENTER_BOT_TOKEN||"").trim();
  if(!token)return {ok:false,error:"missing_telegram_center_token"};
  try{
    const params=new URLSearchParams(initData),provided=params.get("hash")||"",authDate=Number(params.get("auth_date")||0),userRaw=params.get("user")||"";params.delete("hash");
    if(!provided||!authDate||!userRaw)return {ok:false,error:"invalid_telegram_init_data"};
    const max=Number(env.TELEGRAM_WEBAPP_MAX_AGE_SECONDS||86400),age=Number.isFinite(max)?Math.min(604800,Math.max(300,Math.floor(max))):86400;
    if(Math.abs(Math.floor(Date.now()/1000)-authDate)>age)return {ok:false,error:"telegram_init_data_expired"};
    const check=[...params.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join("\n"),e=new TextEncoder();
    const k1=await crypto.subtle.importKey("raw",e.encode("WebAppData"),{name:"HMAC",hash:"SHA-256"},false,["sign"]),secret=await crypto.subtle.sign("HMAC",k1,e.encode(token));
    const k2=await crypto.subtle.importKey("raw",secret,{name:"HMAC",hash:"SHA-256"},false,["sign"]),digest=await crypto.subtle.sign("HMAC",k2,e.encode(check)),calc=hex(new Uint8Array(digest));
    if(!(await secureEqual(calc,provided.toLowerCase())))return {ok:false,error:"telegram_signature_invalid"};
    const raw=JSON.parse(userRaw),id=Number(raw.id);if(!Number.isSafeInteger(id)||id<=0)return {ok:false,error:"telegram_user_invalid"};
    return {ok:true,user:{id,username:raw.username||null,first_name:raw.first_name||null,last_name:raw.last_name||null,language_code:raw.language_code||null}};
  }catch{return {ok:false,error:"telegram_init_data_invalid"}}
}
async function secureEqual(a,b){const e=new TextEncoder(),[x,y]=await Promise.all([crypto.subtle.digest("SHA-256",e.encode(String(a))),crypto.subtle.digest("SHA-256",e.encode(String(b)))]),aa=new Uint8Array(x),bb=new Uint8Array(y);let d=aa.length^bb.length;for(let i=0;i<Math.min(aa.length,bb.length);i++)d|=aa[i]^bb[i];return d===0}
function hex(bytes){return [...bytes].map(x=>x.toString(16).padStart(2,"0")).join("")}
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}})}
