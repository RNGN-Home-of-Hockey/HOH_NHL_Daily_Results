import { resolveVkAccessToken } from "./telegram-center-vk-auth.js";

const OWNER_ID=-227682170;
const VERSION="5.199";

export async function handleVkArchiveProbe(request,env,path){
  if(path!=="/api/telegram-center-v18/vk/probe")return null;
  if(request.method!=="GET")return json({ok:false,error:"method_not_allowed"},405);
  try{
    const token=await resolveVkAccessToken(env);
    const [root,albums]=await Promise.all([
      callVk("video.get",token,{owner_id:OWNER_ID,count:1,offset:0,extended:0}),
      callVk("video.getAlbums",token,{owner_id:OWNER_ID,count:100,offset:0,extended:1,need_system:1}),
    ]);
    const items=Array.isArray(albums?.items)?albums.items:[];
    return json({
      ok:true,
      owner_id:OWNER_ID,
      root_video_count:Number(root?.count||0),
      album_count:Number(albums?.count||items.length),
      albums:items.map(a=>({id:a.id,title:a.title||a.name||null,count:num(a.count),updated_time:a.updated_time||null,privacy:a.privacy||null})),
    });
  }catch(error){
    return json({ok:false,error:String(error?.message||error||"vk_probe_failed")},503);
  }
}

async function callVk(method,token,params){
  const u=new URL(`https://api.vk.com/method/${method}`);
  for(const [k,v] of Object.entries(params))u.searchParams.set(k,String(v));
  u.searchParams.set("access_token",token);
  u.searchParams.set("v",VERSION);
  const r=await fetch(u.toString(),{headers:{Accept:"application/json","User-Agent":"HOH-NHL-Center/18 VK probe"}});
  const d=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(`${method} HTTP ${r.status}`);
  if(d?.error)throw new Error(`${method} ${d.error.error_code||"error"}: ${d.error.error_msg||"unknown"}`);
  return d?.response||{};
}
function num(v){const n=Number(v);return Number.isFinite(n)?n:null}
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}})}
