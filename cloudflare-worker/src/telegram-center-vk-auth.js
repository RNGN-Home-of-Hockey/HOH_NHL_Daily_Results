const APP_ID=54776626;
const REDIRECT="https://hoh-nhl-daily-results.znamteam-903.workers.dev/vk-oauth/callback";
const ACCESS_KEY="hoh_vk_oauth_access_v1";
const REFRESH_KEY="hoh_vk_oauth_refresh_v1";
const EXPIRES_KEY="hoh_vk_oauth_expires_v1";
const DEVICE_KEY="hoh_vk_oauth_device_v1";
const SETUP_KEY="hoh_vk_oauth_setup_code_v1";
const HOH_OWNER_ID=-227682170;

export async function resolveVkAccessToken(env,{force=false}={}){
  const access=String(env?.VK_ACCESS_TOKEN||"").trim();
  const bootstrapRefresh=String(env?.VK_REFRESH_TOKEN||"").trim();
  // a new login through /vk-oauth brings its own device; the refresh key only works together with it
  const storedDevice=bootstrapRefresh&&env?.DB?await readStoredDevice(env.DB,bootstrapRefresh).catch(()=>null):null;
  const deviceId=storedDevice||String(env?.VK_DEVICE_ID||"").trim();
  if(!force&&bootstrapRefresh&&env?.DB){
    const cached=await readCachedAccess(env.DB,bootstrapRefresh).catch(()=>null);
    if(cached)return cached;
  }
  // A VK ID key lives one hour. With the refresh credentials the key is renewed here as soon as the cached one runs out; the fixed
  // VK_ACCESS_TOKEN is only the fallback (before, it was returned first, so the key was renewed only by the deploy's discovery call
  // and the sync of the channel stopped an hour after the last deploy).
  if(!force&&access&&!(bootstrapRefresh&&deviceId))return access;
  if(!bootstrapRefresh||!deviceId)throw new Error("missing_vk_refresh_credentials");
  const currentRefresh=env?.DB?await readCurrentRefresh(env.DB,bootstrapRefresh).catch(()=>bootstrapRefresh):bootstrapRefresh;
  let next;
  try{
    next=await refreshToken(currentRefresh,deviceId);
    if(!next?.access_token)throw new Error("vk_refresh_missing_access_token");
  }catch(error){
    if(!force&&access)return access;
    throw error;
  }
  if(env?.DB){
    const exp=new Date(Date.now()+Math.max(60,Number(next.expires_in||3600))*1000).toISOString();
    await writeMeta(env.DB,ACCESS_KEY,await encrypt(String(next.access_token),bootstrapRefresh));
    await writeMeta(env.DB,REFRESH_KEY,await encrypt(String(next.refresh_token||currentRefresh),bootstrapRefresh));
    await writeMeta(env.DB,EXPIRES_KEY,exp);
  }
  return String(next.access_token);
}

async function refreshToken(refreshToken,deviceId){
  const state=crypto.randomUUID();
  const u=new URL("https://id.vk.com/oauth2/auth");
  u.searchParams.set("grant_type","refresh_token");
  u.searchParams.set("redirect_uri",REDIRECT);
  u.searchParams.set("client_id",String(APP_ID));
  u.searchParams.set("device_id",deviceId);
  u.searchParams.set("state",state);
  const r=await fetch(u.toString(),{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded",Accept:"application/json"},body:new URLSearchParams({refresh_token:refreshToken})});
  const d=await r.json().catch(()=>({}));
  if(!r.ok||d?.error)throw new Error(`VK ID refresh ${d?.error||r.status}: ${d?.error_description||"unknown"}`);
  if(d?.state&&d.state!==state)throw new Error("vk_refresh_state_mismatch");
  return d;
}
async function readCachedAccess(db,secret){
  const rows=await db.prepare(`SELECT meta_key,meta_value FROM data_core_meta WHERE meta_key IN (?,?)`).bind(ACCESS_KEY,EXPIRES_KEY).all();
  const m=Object.fromEntries((rows.results||[]).map(x=>[x.meta_key,x.meta_value]));
  const exp=Date.parse(m[EXPIRES_KEY]||"");
  if(!m[ACCESS_KEY]||!Number.isFinite(exp)||exp<Date.now()+120000)return null;
  return decrypt(m[ACCESS_KEY],secret);
}
async function readCurrentRefresh(db,secret){
  const row=await db.prepare(`SELECT meta_value FROM data_core_meta WHERE meta_key=?`).bind(REFRESH_KEY).first();
  return row?.meta_value?decrypt(row.meta_value,secret):secret;
}
async function readStoredDevice(db,secret){
  const row=await db.prepare(`SELECT meta_value FROM data_core_meta WHERE meta_key=?`).bind(DEVICE_KEY).first();
  return row?.meta_value?decrypt(row.meta_value,secret):null;
}

// A new VK login from /vk-oauth?code=… (the owner taps "Войти через VK" on a link with a one-time code). The keys never pass
// through anybody's hands: the page gives them to the Worker, the Worker checks that they really open the Home of Hockey videos
// and keeps them encrypted next to the old chain. The code works once and only until its time runs out.
export async function storeVkLogin(env,body){
  const secret=String(env?.VK_REFRESH_TOKEN||"").trim();
  if(!env?.DB||!secret)return {ok:false,status:503,error:"vk_store_unavailable"};
  const code=cleanValue(body?.code,200),access=cleanValue(body?.access_token),refresh=cleanValue(body?.refresh_token),device=cleanValue(body?.device_id,200);
  if(!code||!access||!refresh||!device)return {ok:false,status:400,error:"bad_request"};
  if(!await checkSetupCode(env.DB,code))return {ok:false,status:403,error:"link_expired_or_used"};
  let videos;
  try{
    videos=await countHohVideos(access);
  }catch(error){
    return {ok:false,status:403,error:"vk_access_denied",detail:String(error?.message||error).slice(0,120)};
  }
  const exp=new Date(Date.now()+Math.max(60,Math.min(86400,Number(body?.expires_in)||3600))*1000).toISOString();
  await writeMeta(env.DB,ACCESS_KEY,await encrypt(access,secret));
  await writeMeta(env.DB,REFRESH_KEY,await encrypt(refresh,secret));
  await writeMeta(env.DB,DEVICE_KEY,await encrypt(device,secret));
  await writeMeta(env.DB,EXPIRES_KEY,exp);
  await env.DB.prepare(`DELETE FROM data_core_meta WHERE meta_key=?`).bind(SETUP_KEY).run();
  return {ok:true,videos};
}
export async function checkSetupCode(db,code){
  const row=await db.prepare(`SELECT meta_value FROM data_core_meta WHERE meta_key=?`).bind(SETUP_KEY).first().catch(()=>null);
  if(!row?.meta_value||!code)return false;
  let saved;
  try{saved=JSON.parse(row.meta_value)}catch{return false}
  if(!saved?.hash||!(Date.parse(saved.exp||"")>Date.now()))return false;
  return (await sha256Hex(String(code)))===String(saved.hash).toLowerCase();
}
function cleanValue(v,max=4096){const s=String(v??"").trim();return s.length>=6&&s.length<=max&&/^[\x21-\x7e]+$/.test(s)?s:""}
async function sha256Hex(s){const d=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s));return [...new Uint8Array(d)].map(b=>b.toString(16).padStart(2,"0")).join("")}
async function countHohVideos(token){
  const u=new URL("https://api.vk.com/method/video.get");
  u.searchParams.set("owner_id",String(HOH_OWNER_ID));
  u.searchParams.set("count","1");
  u.searchParams.set("access_token",token);
  u.searchParams.set("v","5.199");
  const r=await fetch(u.toString(),{headers:{Accept:"application/json"}});
  const d=await r.json().catch(()=>({}));
  if(!r.ok||d?.error)throw new Error(`VK video.get ${d?.error?.error_code||r.status}`);
  const n=Number(d?.response?.count||0);
  if(!(n>0))throw new Error("no_hoh_videos");
  return n;
}
async function writeMeta(db,key,value){await db.prepare(`INSERT INTO data_core_meta(meta_key,meta_value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP`).bind(key,value).run()}
async function aesKey(secret){const raw=new TextEncoder().encode(`HOH-VK|${secret}`);const digest=await crypto.subtle.digest("SHA-256",raw);return crypto.subtle.importKey("raw",digest,{name:"AES-GCM"},false,["encrypt","decrypt"])}
async function encrypt(value,secret){const iv=crypto.getRandomValues(new Uint8Array(12));const key=await aesKey(secret);const ct=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv},key,new TextEncoder().encode(value)));return `${enc(iv)}.${enc(ct)}`}
async function decrypt(value,secret){const [a,b]=String(value).split(".");const key=await aesKey(secret);const pt=await crypto.subtle.decrypt({name:"AES-GCM",iv:dec(a)},key,dec(b));return new TextDecoder().decode(pt)}
function enc(bytes){let s="";for(const b of bytes)s+=String.fromCharCode(b);return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"")}
function dec(s){s=s.replace(/-/g,"+").replace(/_/g,"/");while(s.length%4)s+="=";const raw=atob(s),out=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);return out}
