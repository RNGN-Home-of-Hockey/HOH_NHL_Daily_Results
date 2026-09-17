const APP_ID=54776626;
const REDIRECT="https://hoh-nhl-daily-results.znamteam-903.workers.dev/vk-oauth/callback";
const ACCESS_KEY="hoh_vk_oauth_access_v1";
const REFRESH_KEY="hoh_vk_oauth_refresh_v1";
const EXPIRES_KEY="hoh_vk_oauth_expires_v1";

export async function resolveVkAccessToken(env,{force=false}={}){
  const access=String(env?.VK_ACCESS_TOKEN||"").trim();
  const bootstrapRefresh=String(env?.VK_REFRESH_TOKEN||"").trim();
  const deviceId=String(env?.VK_DEVICE_ID||"").trim();
  if(!force&&bootstrapRefresh&&env?.DB){
    const cached=await readCachedAccess(env.DB,bootstrapRefresh).catch(()=>null);
    if(cached)return cached;
  }
  if(!force&&access)return access;
  if(!bootstrapRefresh||!deviceId)throw new Error("missing_vk_refresh_credentials");
  const currentRefresh=env?.DB?await readCurrentRefresh(env.DB,bootstrapRefresh).catch(()=>bootstrapRefresh):bootstrapRefresh;
  const next=await refreshToken(currentRefresh,deviceId);
  if(!next?.access_token)throw new Error("vk_refresh_missing_access_token");
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
async function writeMeta(db,key,value){await db.prepare(`INSERT INTO data_core_meta(meta_key,meta_value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP`).bind(key,value).run()}
async function aesKey(secret){const raw=new TextEncoder().encode(`HOH-VK|${secret}`);const digest=await crypto.subtle.digest("SHA-256",raw);return crypto.subtle.importKey("raw",digest,{name:"AES-GCM"},false,["encrypt","decrypt"])}
async function encrypt(value,secret){const iv=crypto.getRandomValues(new Uint8Array(12));const key=await aesKey(secret);const ct=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv},key,new TextEncoder().encode(value)));return `${enc(iv)}.${enc(ct)}`}
async function decrypt(value,secret){const [a,b]=String(value).split(".");const key=await aesKey(secret);const pt=await crypto.subtle.decrypt({name:"AES-GCM",iv:dec(a)},key,dec(b));return new TextDecoder().decode(pt)}
function enc(bytes){let s="";for(const b of bytes)s+=String.fromCharCode(b);return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"")}
function dec(s){s=s.replace(/-/g,"+").replace(/_/g,"/");while(s.length%4)s+="=";const raw=atob(s),out=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);return out}
