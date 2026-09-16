const JS_PATH = "/telegram-app/v9-polish.js";

export function handleTelegramCenterV9Polish(request,path){
  if(path!==JS_PATH)return null;
  if(request.method!=="GET")return json({ok:false,error:"method_not_allowed"},405);
  return new Response(POLISH_JS,{headers:{"Content-Type":"application/javascript; charset=utf-8","Cache-Control":"no-store, no-cache, must-revalidate","X-Content-Type-Options":"nosniff"}});
}

function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}})}

const POLISH_JS=String.raw`(function(){
'use strict';
const V2='/api/telegram-center-v2',V9='/api/telegram-center-v9';
let ruNames=null,teamNames=null,busy=false;
const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function j(url){const r=await fetch(url,{cache:'no-store'});if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}
async function names(){if(ruNames)return ruNames;try{ruNames=(await j(V9+'/ru-names')).names||{}}catch{ruNames={}}return ruNames}
async function teams(){if(teamNames)return teamNames;try{const d=await j(V2+'/teams');teamNames=Object.fromEntries((d.teams||[]).map(t=>[String(t.tri_code||'').toUpperCase(),t.name_ru||t.name_en||t.tri_code]))}catch{teamNames={}}return teamNames}
function playerIdFromProfile(){const img=document.querySelector('.profileHead.player img');if(!img)return'';const m=String(img.src||'').match(/\/(\d+)\.(?:png|jpg|jpeg|webp)(?:\?|$)/i);return m?m[1]:''}
async function fixProfile(){const head=document.querySelector('.profileHead.player');if(!head)return;const id=playerIdFromProfile();if(!id)return;const map=await names(),ru=map[id];if(!ru)return;const title=head.querySelector('.profileInfo h1'),original=head.querySelector('.profileInfo .original');if(!title)return;const visible=title.textContent.trim().replace(/^[A-Z]{2}\s+/,'').trim();if(!title.dataset.ruDone){title.innerHTML='<span style="font-size:10px;color:#59dda1;font-weight:950">RU</span> '+esc(ru);title.dataset.ruDone='1'}if(original&&!original.textContent.trim()&&visible&&visible!==ru)original.textContent='('+visible+')'}
async function fixMine(){const [map,tm]=await Promise.all([names(),teams()]);document.querySelectorAll('.myRow').forEach(row=>{const type=row.dataset.type,key=String(row.dataset.key||''),b=row.querySelector('.rowText b');if(!b)return;if(type==='player'&&map[key]){b.textContent=map[key];b.dataset.ruDone='1'}if(type==='team'){const label=tm[key.toUpperCase()];if(label)b.textContent=label}})}
function markVersion(){const badge=document.querySelector('.v8');if(badge&&badge.textContent.trim()!=='V9'){badge.textContent='V9';badge.setAttribute('aria-label','Center V9')}}
async function run(){if(busy)return;busy=true;try{markVersion();await Promise.all([fixMine(),fixProfile()])}finally{busy=false}}
let t=null;const o=new MutationObserver(()=>{clearTimeout(t);t=setTimeout(run,45)});o.observe(document.documentElement,{subtree:true,childList:true});document.addEventListener('click',()=>setTimeout(run,90),true);run();
})();`;
