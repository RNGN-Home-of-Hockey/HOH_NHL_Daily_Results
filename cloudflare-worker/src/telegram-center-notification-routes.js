import { getCenterNotificationStatus, runCenterNotificationTick } from "./telegram-center-notification-engine.js";

const API="/api/telegram-center-notifications-v2";

export async function handleTelegramCenterNotificationRoutes(request,env,path){
  if(!path.startsWith(API))return null;
  if(path===`${API}/status`&&request.method==="GET")return json(await getCenterNotificationStatus(env));
  if(path===`${API}/tick`&&request.method==="POST"){
    if(!(await authorized(request,env)))return json({ok:false,error:"unauthorized"},401);
    const url=new URL(request.url),dryRun=url.searchParams.get("dry_run")!=="0";
    try{const result=await runCenterNotificationTick(env,{dryRun});return json(result,result.ok?200:500)}catch(error){return json({ok:false,error:"center_notification_tick_failed",detail:String(error?.message||error)},500)}
  }
  return json({ok:false,error:"not_found"},404);
}

async function authorized(request,env){const expected=String(env.MANAGEMENT_API_SECRET||"").trim(),auth=String(request.headers.get("authorization")||"").trim(),m=/^Bearer\s+(.+)$/i.exec(auth);return Boolean(expected&&m&&await secureEq(m[1],expected))}
async function secureEq(a,b){const e=new TextEncoder(),[x,y]=await Promise.all([crypto.subtle.digest("SHA-256",e.encode(String(a))),crypto.subtle.digest("SHA-256",e.encode(String(b)))]),aa=new Uint8Array(x),bb=new Uint8Array(y);let d=aa.length^bb.length;for(let i=0;i<Math.min(aa.length,bb.length);i++)d|=aa[i]^bb[i];return d===0}
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}})}
