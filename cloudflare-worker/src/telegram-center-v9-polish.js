const JS_PATH = "/telegram-app/v9-polish.js";

export function handleTelegramCenterV9Polish(request,path){
  if(path!==JS_PATH)return null;
  if(request.method!=="GET")return json({ok:false,error:"method_not_allowed"},405);
  return new Response(POLISH_JS,{headers:{"Content-Type":"application/javascript; charset=utf-8","Cache-Control":"no-store, no-cache, must-revalidate","X-Content-Type-Options":"nosniff"}});
}

function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}})}

const POLISH_JS=String.raw`(function(){
'use strict';
const V2='/api/telegram-center-v2',V3='/api/telegram-center-v3',V7='/api/telegram-center-v7',V9='/api/telegram-center-v9';
let ruNames=null,teamNames=null,busy=false,lastPlayerQuery='',playerLabels={};
const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function j(url){const r=await fetch(url,{cache:'no-store'});if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}
async function names(){if(ruNames)return ruNames;try{ruNames=(await j(V9+'/ru-names')).names||{}}catch{ruNames={}}return ruNames}
async function teams(){if(teamNames)return teamNames;try{const d=await j(V2+'/teams');teamNames=Object.fromEntries((d.teams||[]).map(t=>[String(t.tri_code||'').toUpperCase(),t.name_ru||t.name_en||t.tri_code]))}catch{teamNames={}}return teamNames}
function country2(code){const c=String(code||'').toUpperCase();const map={RUS:'RU',FIN:'FI',SWE:'SE',CAN:'CA',USA:'US',CZE:'CZ',SVK:'SK',DEU:'DE',CHE:'CH',DNK:'DK',NOR:'NO',LVA:'LV',BLR:'BY',KAZ:'KZ',AUT:'AT',FRA:'FR',GBR:'GB',SVN:'SI'};return map[c]||c.slice(0,2)}
function currentSeason(){const d=new Date(),y=d.getUTCFullYear(),m=d.getUTCMonth()+1,s=m>=7?y:y-1;return ''+s+(s+1)}
async function loadVisiblePlayerLabels(){const team=document.getElementById('teamSel')?.value||'',q=document.getElementById('q')?.value||'';const key=team+'|'+q;if(lastPlayerQuery===key&&Object.keys(playerLabels).length)return playerLabels;try{const d=await j(V7+'/players?team='+encodeURIComponent(team)+'&q='+encodeURIComponent(q)+'&limit=160');playerLabels=Object.fromEntries((d.players||[]).map(p=>[String(p.player_id),p]));lastPlayerQuery=key}catch{}return playerLabels}
async function fixVisiblePlayers(){const [map,labels]=await Promise.all([names(),loadVisiblePlayerLabels()]);document.querySelectorAll('.playerRow[data-player]').forEach(row=>{const id=String(row.dataset.player||''),p=labels[id]||{},ru=map[id]||p.full_name_ru,b=row.querySelector('.rowText b');if(!b||!ru)return;const en=String(p.full_name_en||'').trim();const code=country2(p.primary_country_code);b.innerHTML=(code?'<span class="orangeText" style="font-size:10px">'+esc(code)+'</span> ':'')+esc(ru)+(en&&en!==ru?' <span style="color:#85899b;font-size:10px;font-weight:600">('+esc(en)+')</span>':'');b.dataset.ruDone='1'})}
function playerIdFromProfile(){const img=document.querySelector('.profileHead.player img');if(!img)return'';const m=String(img.src||'').match(/\/(\d+)\.(?:png|jpg|jpeg|webp)(?:\?|$)/i);return m?m[1]:''}
async function fixProfile(){const head=document.querySelector('.profileHead.player');if(!head)return;const id=playerIdFromProfile();if(!id)return;const map=await names(),ru=map[id];if(!ru)return;const title=head.querySelector('.profileInfo h1'),original=head.querySelector('.profileInfo .original');if(!title)return;let p={};try{p=(await j(V3+'/players/'+id+'?season='+currentSeason())).player||{}}catch{}const visible=String(p.full_name_en||title.textContent||'').replace(/^[A-Z]{2}\s+/,'').trim();const code=country2((p.countries&&p.countries[0])||p.birth_country||'');title.innerHTML=(code?'<span style="font-size:10px;color:#59dda1;font-weight:950">'+esc(code)+'</span> ':'')+esc(ru);title.dataset.ruDone='1';if(original&&visible&&visible!==ru)original.textContent='('+visible+')'}
async function fixMine(){const [map,tm]=await Promise.all([names(),teams()]);document.querySelectorAll('.myRow').forEach(row=>{const type=row.dataset.type,key=String(row.dataset.key||''),b=row.querySelector('.rowText b');if(!b)return;if(type==='player'&&map[key]){b.textContent=map[key];b.dataset.ruDone='1'}if(type==='team'){const label=tm[key.toUpperCase()];if(label)b.textContent=label}})}
function trendEmoji(text,index){const s=String(text||'').toLowerCase();if(s.includes('побед'))return'🏆';if(s.includes('забил')||s.includes('гол'))return index%2?'🔥':'🥅';if(s.includes('брос'))return'🏒';if(s.includes('очк'))return'⭐';if(s.includes('пропуст'))return'🛡️';if(s.includes('тотал'))return'📈';return ['⚡','📊','🎯','🔥'][index%4]}
function decorateTrends(){document.querySelectorAll('.trend').forEach((row,i)=>{const icon=row.querySelector('.trendIcon');if(icon)icon.textContent=trendEmoji(row.textContent,i)})}
function markVersion(){const badge=document.querySelector('.v8');if(badge&&badge.textContent.trim()!=='V9'){badge.textContent='V9';badge.setAttribute('aria-label','Center V9')}}
async function run(){if(busy)return;busy=true;try{markVersion();decorateTrends();await Promise.all([fixMine(),fixProfile(),fixVisiblePlayers()])}finally{busy=false}}
let t=null;const o=new MutationObserver(()=>{clearTimeout(t);t=setTimeout(run,45)});o.observe(document.documentElement,{subtree:true,childList:true});document.addEventListener('click',()=>setTimeout(run,90),true);run();
})();`;
