import { resolveVkAccessToken } from "./telegram-center-vk-auth.js";

const API_BASE="https://api.vk.com/method/";
const VERSION="5.199";
const OWNER=-227682170;

export async function getVkArchiveDiscovery(env){
  if(!env?.DB)return {ok:false,error:"missing_d1_binding"};
  try{
    const token=await resolveVkAccessToken(env);
    return await discoverWithToken(token);
  }catch(error){
    const first=String(error?.message||error||"vk_discovery_failed");
    if(/authorization failed|VK .* 5:|access token/i.test(first)){
      try{
        const token=await resolveVkAccessToken(env,{force:true});
        return await discoverWithToken(token);
      }catch(second){
        return {ok:false,error:String(second?.message||second||"vk_refresh_failed")};
      }
    }
    return {ok:false,error:first};
  }
}

async function discoverWithToken(token){
  const root=await call("video.get",token,{owner_id:OWNER,count:1,offset:0,extended:0});
  const albumsResp=await call("video.getAlbums",token,{owner_id:OWNER,count:100,offset:0,extended:1,need_system:1});
  const albums=Array.isArray(albumsResp?.items)?albumsResp.items:[];
  const rows=[];
  for(const album of albums){
    const id=Number(album?.id);
    if(!Number.isFinite(id))continue;
    try{
      const page=await call("video.get",token,{owner_id:OWNER,album_id:id,count:1,offset:0,extended:0});
      rows.push({id,title:String(album?.title||album?.name||""),count:Number(page?.count||0),updated_time:album?.updated_time||null});
    }catch(error){
      rows.push({id,title:String(album?.title||album?.name||""),count:null,error:String(error?.message||error)});
    }
  }
  rows.sort((a,b)=>(Number(b.count||-1)-Number(a.count||-1))||a.id-b.id);
  return {
    ok:true,
    owner_id:OWNER,
    root_count:Number(root?.count||0),
    album_count:Number(albumsResp?.count||albums.length),
    albums:rows,
    generated_at:new Date().toISOString(),
  };
}

async function call(method,token,params){
  const url=new URL(API_BASE+method);
  for(const [key,value] of Object.entries(params||{}))url.searchParams.set(key,String(value));
  url.searchParams.set("access_token",token);
  url.searchParams.set("v",VERSION);
  const response=await fetch(url.toString(),{headers:{Accept:"application/json","User-Agent":"HOH-NHL-Center/18 VK discovery"}});
  const body=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(`VK ${method} HTTP ${response.status}`);
  if(body?.error)throw new Error(`VK ${method} ${body.error.error_code||"error"}: ${body.error.error_msg||"unknown"}`);
  return body?.response||{};
}
