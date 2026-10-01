const VK_COVER_PATH="/api/telegram-center-media/vk-cover";
const ALLOWED_HOSTS=[
  "vkvideo.ru","vk.com","vk.ru","userapi.com","vkuser.net","vk-cdn.net",
];

export async function handleTelegramCenterMediaProxy(request,path){
  if(path!==VK_COVER_PATH)return null;
  if(request.method!=="GET")return json({ok:false,error:"method_not_allowed"},405);
  const raw=new URL(request.url).searchParams.get("url")||"";
  let source;
  try{source=new URL(raw)}catch{return json({ok:false,error:"invalid_url"},400)}
  if(source.protocol!=="https:"||!allowedHost(source.hostname))return json({ok:false,error:"source_not_allowed"},400);
  try{
    const upstream=await fetch(source.toString(),{
      method:"GET",
      headers:{
        "Accept":"image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "User-Agent":"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
        "Referer":"https://vkvideo.ru/",
      },
      redirect:"follow",
      cf:{cacheEverything:true,cacheTtl:21600},
    });
    let finalUrl;
    try{finalUrl=new URL(upstream.url||source.toString())}catch{finalUrl=source}
    if(finalUrl.protocol!=="https:"||!allowedHost(finalUrl.hostname))return json({ok:false,error:"redirect_not_allowed"},502);
    if(!upstream.ok)return json({ok:false,error:"upstream_image_failed",status:upstream.status},upstream.status===404?404:502);
    const type=String(upstream.headers.get("content-type")||"").toLowerCase();
    if(!type.startsWith("image/"))return json({ok:false,error:"upstream_not_image"},502);
    const headers=new Headers();
    headers.set("Content-Type",type.split(";")[0]||"image/jpeg");
    headers.set("Cache-Control","public, max-age=21600, stale-while-revalidate=86400");
    headers.set("X-Content-Type-Options","nosniff");
    headers.set("Access-Control-Allow-Origin","*");
    const len=upstream.headers.get("content-length");if(len)headers.set("Content-Length",len);
    return new Response(upstream.body,{status:200,headers});
  }catch(error){
    console.error("vk cover relay failed",error);
    return json({ok:false,error:"cover_proxy_failed"},502);
  }
}

function allowedHost(hostname){
  const h=String(hostname||"").toLowerCase().replace(/\.$/,"");
  return ALLOWED_HOSTS.some(root=>h===root||h.endsWith("."+root));
}
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}})}
