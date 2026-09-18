const PREFIX="/api/winline/feed-probe";
const FEEDS={
  prematch:"https://back.winline.ru/banners/prematch",
  live:"https://back.winline.ru/banners/live",
  prematcheng:"https://back.winline.ru/banners/prematcheng",
  liveeng:"https://back.winline.ru/banners/liveeng",
  prematch_mainsports:"https://back.winline.ru/banners/prematch_mainsports",
  live_mainsports:"https://back.winline.ru/banners/live_mainsports",
  prematch_mainsports_eng:"https://back.winline.ru/banners/prematch_mainsports_eng",
  live_mainsports_eng:"https://back.winline.ru/banners/live_mainsports_eng",
};
const HOCKEY_RE=/хокке|hockey|нхл|nhl/i;
const INTERESTING_KEY_RE=/(sport|league|tournament|champ|event|match|game|team|participant|opponent|home|away|name|title|id|odd|coef|price|line|start|time|date|market|outcome|factor|value)/i;

export async function handleWinlineFeedProbe(request,path){
  if(!path.startsWith(PREFIX))return null;
  if(request.method!=="GET")return json({ok:false,error:"method_not_allowed"},405);
  const url=new URL(request.url),feed=url.searchParams.get("feed")||"prematch_mainsports";
  if(feed==="all"){
    const out={};
    for(const key of Object.keys(FEEDS))out[key]=await probeOne(key);
    return json({ok:true,feeds:out});
  }
  if(!FEEDS[feed])return json({ok:false,error:"unknown_feed",allowed:Object.keys(FEEDS)},400);
  return json({ok:true,feed,probe:await probeOne(feed)});
}

async function probeOne(key){
  const target=FEEDS[key],controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  try{
    const r=await fetch(target,{signal:controller.signal,headers:{accept:"application/json,text/plain,*/*","user-agent":"HOH-NHL-Center/20 Winline feed probe"}});
    const text=await r.text(),result={
      url:target,status:r.status,ok:r.ok,content_type:r.headers.get("content-type")||null,
      bytes:new TextEncoder().encode(text).length,raw_head:text.slice(0,1800)
    };
    try{
      const data=JSON.parse(text);
      Object.assign(result,summarizeJson(data));
    }catch{result.json=false}
    return result;
  }catch(error){return {url:target,ok:false,error:String(error?.message||error)}}
  finally{clearTimeout(timer)}
}

function summarizeJson(root){
  const rootType=Array.isArray(root)?"array":root===null?"null":typeof root;
  const topKeys=root&&typeof root==="object"&&!Array.isArray(root)?Object.keys(root).slice(0,100):[];
  const summary={json:true,root_type:rootType,root_length:Array.isArray(root)?root.length:null,top_keys:topKeys,key_counts:{},hockey_hits:[],samples:[]};
  const stack=[{v:root,path:"$",context:[]}];let visited=0;
  while(stack.length&&visited<50000){
    const {v,path,context}=stack.pop();visited++;
    if(v===null||v===undefined)continue;
    if(typeof v==="string"){
      if(HOCKEY_RE.test(v)&&summary.hockey_hits.length<50)summary.hockey_hits.push({path,value:v.slice(0,240),context:context.slice(-6)});
      continue;
    }
    if(typeof v!=="object")continue;
    if(Array.isArray(v)){
      for(let i=Math.min(v.length,300)-1;i>=0;i--)stack.push({v:v[i],path:path+"["+i+"]",context});
      continue;
    }
    const shallow={};
    const nextContext=context.slice();
    for(const [k,val] of Object.entries(v)){
      summary.key_counts[k]=(summary.key_counts[k]||0)+1;
      if((typeof val==="string"||typeof val==="number"||typeof val==="boolean")&&INTERESTING_KEY_RE.test(k))shallow[k]=String(val).slice(0,300);
      if(typeof val==="string"&&(HOCKEY_RE.test(val)||INTERESTING_KEY_RE.test(k)))nextContext.push(k+"="+val.slice(0,160));
    }
    const shallowText=JSON.stringify(shallow);
    if(HOCKEY_RE.test(shallowText)&&summary.samples.length<20)summary.samples.push({path,fields:shallow});
    const entries=Object.entries(v);
    for(let i=entries.length-1;i>=0;i--){const [k,val]=entries[i];stack.push({v:val,path:path+"."+k,context:nextContext})}
  }
  summary.visited_nodes=visited;
  summary.key_counts=Object.fromEntries(Object.entries(summary.key_counts).sort((a,b)=>b[1]-a[1]).slice(0,120));
  return summary;
}
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}})}
