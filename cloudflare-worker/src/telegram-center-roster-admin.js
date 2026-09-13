const API="/api/telegram-center-admin/rosters";
const NHL="https://api-web.nhle.com/v1";
const TEAMS=["ANA","BOS","BUF","CGY","CAR","CHI","COL","CBJ","DAL","DET","EDM","FLA","LAK","MIN","MTL","NSH","NJD","NYI","NYR","OTT","PHI","PIT","SJS","SEA","STL","TBL","TOR","UTA","VAN","VGK","WSH","WPG"];

export async function handleTelegramCenterRosterAdmin(request,env,path){
  if(!path.startsWith(API))return null;
  if(!env.DB)return json({ok:false,error:"missing_d1_binding"},503);
  if(path===`${API}/status`&&request.method==="GET")return status(env);
  if(path===`${API}/sync`&&request.method==="POST"){
    if(!(await authorized(request,env)))return json({ok:false,error:"unauthorized"},401);
    return sync(request,env);
  }
  return json({ok:false,error:"not_found"},404);
}

async function status(env){try{const r=await env.DB.prepare(`SELECT current_team_tri,COUNT(*) players FROM players WHERE COALESCE(active,1)=1 GROUP BY current_team_tri ORDER BY current_team_tri;`).all();return json({ok:true,total:(r.results||[]).reduce((s,x)=>s+Number(x.players||0),0),teams:r.results||[]})}catch(error){return json({ok:false,error:"roster_status_failed",detail:errorText(error)},503)}}

async function sync(request,env){let body={};try{body=await request.json()}catch{}const wanted=Array.isArray(body.teams)&&body.teams.length?body.teams.map(x=>String(x).toUpperCase()).filter(x=>TEAMS.includes(x)):TEAMS;const payloads=await Promise.all(wanted.map(async tri=>{try{const r=await fetch(`${NHL}/roster/${tri}/current`,{headers:{Accept:"application/json"}});if(!r.ok)return {tri,players:[],error:`HTTP ${r.status}`};const d=await r.json(),players=[];for(const [section,pos] of [["forwards",null],["defensemen","D"],["goalies","G"]])for(const p of d?.[section]||[])players.push(normalizePlayer(p,tri,pos));return {tri,players:players.filter(Boolean),error:null}}catch(error){return {tri,players:[],error:errorText(error)}}}));const unique=new Map();for(const x of payloads)for(const p of x.players)unique.set(p.player_id,p);const statements=[];for(const p of unique.values())statements.push(env.DB.prepare(`
  INSERT INTO players (player_id,first_name_en,last_name_en,full_name_en,current_team_tri,position_code,sweater_number,shoots_catches,active,updated_at)
  VALUES (?,?,?,?,?,?,?,?,1,CURRENT_TIMESTAMP)
  ON CONFLICT(player_id) DO UPDATE SET first_name_en=excluded.first_name_en,last_name_en=excluded.last_name_en,full_name_en=excluded.full_name_en,current_team_tri=excluded.current_team_tri,position_code=excluded.position_code,sweater_number=excluded.sweater_number,shoots_catches=excluded.shoots_catches,active=1,updated_at=CURRENT_TIMESTAMP;
`).bind(p.player_id,p.first_name_en,p.last_name_en,p.full_name_en,p.current_team_tri,p.position_code,p.sweater_number,p.shoots_catches));let written=0;for(let i=0;i<statements.length;i+=75){const chunk=statements.slice(i,i+75);if(chunk.length){await env.DB.batch(chunk);written+=chunk.length}}return json({ok:true,teams_requested:wanted.length,players_found:unique.size,written,source_errors:payloads.filter(x=>x.error).map(x=>({team:x.tri,error:x.error}))})}

function normalizePlayer(p,tri,forced){const id=Number(p?.id),first=localized(p?.firstName),last=localized(p?.lastName);if(!Number.isSafeInteger(id)||id<=0||(!first&&!last))return null;let pos=forced||String(p?.positionCode||"").toUpperCase();if(!pos){const code=String(p?.position||"").toUpperCase();pos=code||null}return {player_id:id,first_name_en:first||null,last_name_en:last||null,full_name_en:[first,last].filter(Boolean).join(" "),current_team_tri:tri,position_code:pos,sweater_number:Number.isFinite(Number(p?.sweaterNumber))?Number(p.sweaterNumber):null,shoots_catches:String(p?.shootsCatches||"").trim()||null}}
function localized(v){if(!v)return"";if(typeof v==="string")return v;return v.default||v.en||Object.values(v)[0]||""}
async function authorized(request,env){const expected=String(env.MANAGEMENT_API_SECRET||"").trim(),auth=String(request.headers.get("authorization")||"").trim(),m=/^Bearer\s+(.+)$/i.exec(auth);return Boolean(expected&&m&&await secureEq(m[1],expected))}
async function secureEq(a,b){const e=new TextEncoder(),[x,y]=await Promise.all([crypto.subtle.digest("SHA-256",e.encode(String(a))),crypto.subtle.digest("SHA-256",e.encode(String(b)))]),aa=new Uint8Array(x),bb=new Uint8Array(y);let d=aa.length^bb.length;for(let i=0;i<Math.min(aa.length,bb.length);i++)d|=aa[i]^bb[i];return d===0}
function errorText(e){return String(e?.message||e||"unknown_error")}
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}})}
