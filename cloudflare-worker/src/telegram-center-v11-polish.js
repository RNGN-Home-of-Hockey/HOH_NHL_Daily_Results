import eliteAudio from "../../state/center_player_pronunciations_eliteprospects.json" with { type: "json" };

const JS_PATH = "/telegram-app/v11.js";
const API_PREFIX = "/api/telegram-center-v11/pronunciation/";

export function handleTelegramCenterV11Polish(request,path){
  if(path===JS_PATH){
    if(request.method!=="GET")return json({ok:false,error:"method_not_allowed"},405);
    return new Response(V11_JS,{headers:{"Content-Type":"application/javascript; charset=utf-8","Cache-Control":"no-store, no-cache, must-revalidate","X-Content-Type-Options":"nosniff"}});
  }
  if(path.startsWith(API_PREFIX)){
    if(request.method!=="GET")return json({ok:false,error:"method_not_allowed"},405);
    const id=String(path.slice(API_PREFIX.length)||"").replace(/\D/g,"");
    if(!id)return json({ok:false,error:"invalid_player_id"},400);
    const row=eliteAudio?.players?.[id]||null;
    return json({ok:true,player_id:Number(id),available:Boolean(row?.pronunciation_url),audio_url:row?.pronunciation_url||null,source:row?.pronunciation_source||"eliteprospects_player_audio"});
  }
  return null;
}

function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}})}

const V11_JS=String.raw`(function(){
'use strict';
const API='/api/telegram-center-v11/pronunciation/';
const STORE='hoh-center-v11-expanded-subscriptions';
const TWO_TO_THREE={RU:'RUS',FI:'FIN',SE:'SWE',CA:'CAN',US:'USA',CZ:'CZE',SK:'SVK',CH:'CHE',DE:'DEU',LV:'LVA',NO:'NOR',DK:'DNK',AT:'AUT',BY:'BLR',KZ:'KAZ',SI:'SVN',FR:'FRA',GB:'GBR'};
let expanded=new Set();
try{expanded=new Set(JSON.parse(sessionStorage.getItem(STORE)||'[]'))}catch{expanded=new Set()}
function saveExpanded(){try{sessionStorage.setItem(STORE,JSON.stringify([...expanded]))}catch{}}
function markVersion(){const b=document.querySelector('.v8');if(b&&!b.dataset.centerVersionLock){b.textContent='V11';b.setAttribute('aria-label','Center V11')}}
function installCss(){if(document.getElementById('centerV11Css'))return;const s=document.createElement('style');s.id='centerV11Css';s.textContent='.v11Country{font-size:10px;color:#59dda1;font-weight:950;white-space:nowrap;letter-spacing:.25px}.v11Audio{display:inline-grid;place-items:center;width:30px;height:30px;margin-left:7px;padding:0;border-radius:9px;border:1px solid #5b456e;background:linear-gradient(135deg,#21172a,#151722);color:#e2ccff;font-size:15px;vertical-align:middle;cursor:pointer}.v11Audio:active{transform:scale(.96)}.v11Audio.playing{border-color:#ff7840;color:#ff9b6c;box-shadow:0 0 16px #ff6b3033}.profileInfo .meta .v11Salary{color:#ff965f;font-weight:900;white-space:nowrap}.profileInfo h1{display:flex;align-items:center;flex-wrap:wrap;gap:0}.pronounceBtn,.profileSalary{display:none!important}';document.head.appendChild(s)}
function country3(el){if(!el||el.dataset.v11Country==='1')return;const raw=String(el.textContent||'').toUpperCase();let code='';for(const two of Object.keys(TWO_TO_THREE)){if(new RegExp('(^|\\s)'+two+'($|\\s)').test(raw)){code=TWO_TO_THREE[two];break}}if(!code){const m=raw.match(/\b[A-Z]{3}\b/);if(m)code=m[0]}if(code){el.textContent=code;el.classList.add('v11Country');el.dataset.v11Country='1'}else{el.remove()}}
function cleanCountries(){document.querySelectorAll('.countryStable').forEach(country3)}
function inlineSalary(){const head=document.querySelector('.profileHead.player'),salary=document.querySelector('.profileSalary');if(!head||!salary)return;const meta=head.querySelector('.profileInfo .meta');if(!meta||meta.querySelector('.v11Salary')){salary.remove();return}let text=String(salary.textContent||'').replace(/^\s*💰\s*/,'').replace(/^AAV\s*/i,'').trim();if(text){const span=document.createElement('span');span.className='v11Salary';span.textContent='💰 '+text;meta.appendChild(document.createTextNode(' · '));meta.appendChild(span)}salary.remove()}
function playerIdFromProfile(){const img=document.querySelector('.profileHead.player img');const src=String(img?.getAttribute('src')||'');const m=src.match(/\/(\d{6,})\.(?:png|jpe?g|webp)(?:\?|$)/i);return m?m[1]:''}
async function installAudio(){const head=document.querySelector('.profileHead.player');if(!head)return;const title=head.querySelector('.profileInfo h1');if(!title||title.dataset.v11Audio==='loading'||title.dataset.v11Audio==='done')return;document.querySelectorAll('.pronounceBtn').forEach(x=>x.remove());const id=playerIdFromProfile();if(!id){title.dataset.v11Audio='done';return}title.dataset.v11Audio='loading';try{const r=await fetch(API+encodeURIComponent(id),{cache:'no-store'}),d=await r.json().catch(()=>({}));if(!r.ok||!d.available||!d.audio_url){title.dataset.v11Audio='done';return}const b=document.createElement('button');b.type='button';b.className='v11Audio';b.setAttribute('aria-label','Произношение имени');b.title='Произношение имени';b.textContent='🔊';b.dataset.audio=d.audio_url;b.onclick=e=>{e.preventDefault();e.stopPropagation();const a=new Audio(b.dataset.audio);b.classList.add('playing');const stop=()=>b.classList.remove('playing');a.addEventListener('ended',stop,{once:true});a.addEventListener('error',stop,{once:true});a.play().catch(stop)};title.appendChild(b);title.dataset.v11Audio='done'}catch{title.dataset.v11Audio='done'}}
function rememberSection(section){const b=section?.querySelector('[data-expand-subs]');if(!b)return;const kind=b.dataset.expandSubs;if(!kind)return;const box=document.getElementById('more-'+kind),isOpen=(b.dataset.open==='1')||(box&&getComputedStyle(box).display!=='none');if(isOpen)expanded.add(kind);else expanded.delete(kind);saveExpanded()}
function restoreSections(){document.querySelectorAll('[data-expand-subs]').forEach(b=>{const kind=b.dataset.expandSubs,box=document.getElementById('more-'+kind);if(!kind||!box)return;if(expanded.has(kind)){box.style.display='grid';b.dataset.open='1';b.textContent='Свернуть'}else if(b.dataset.open!=='1'){box.style.display='none'}})}
function stripLegacyPronunciation(){document.querySelectorAll('.pronounceBtn').forEach(x=>x.remove());document.querySelectorAll('.pronunciationText,.pronunciationSource').forEach(x=>x.remove())}
function run(){markVersion();installCss();cleanCountries();inlineSalary();restoreSections();stripLegacyPronunciation();installAudio()}
let timer=null;const obs=new MutationObserver(()=>{clearTimeout(timer);timer=setTimeout(run,25)});obs.observe(document.documentElement,{subtree:true,childList:true});
document.addEventListener('click',e=>{const old=e.target.closest&&e.target.closest('.pronounceBtn');if(old){e.preventDefault();e.stopImmediatePropagation();return}},true);
document.addEventListener('click',e=>{const expand=e.target.closest&&e.target.closest('[data-expand-subs]');if(expand){setTimeout(()=>rememberSection(expand.closest('.subSection')),0);return}const action=e.target.closest&&e.target.closest('[data-v10-del],[data-v10-settings]');if(action){const section=action.closest('.subSection');if(section)rememberSection(section)}},false);
run();
})();`;
