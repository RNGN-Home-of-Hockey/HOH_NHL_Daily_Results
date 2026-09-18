const PATH="/telegram-app/v21.js";

export function handleTelegramCenterV21SpoilersUi(request,path){
  if(path!==PATH)return null;
  if(request.method!=="GET")return new Response("method_not_allowed",{status:405});
  return new Response(V21_JS,{headers:{"Content-Type":"application/javascript; charset=utf-8","Cache-Control":"no-store, no-cache, must-revalidate","X-Content-Type-Options":"nosniff"}});
}

const V21_JS=String.raw`(function(){
'use strict';
const KEY='hoh-center-no-spoilers';
const tg=window.Telegram&&window.Telegram.WebApp?window.Telegram.WebApp:null;
const state={enabled:localStorage.getItem(KEY)==='1'};
window.HOHNoSpoilers=()=>Boolean(state.enabled);

function eyeSvg(){
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.3 12s3.5-6.2 9.7-6.2S21.7 12 21.7 12 18.2 18.2 12 18.2 2.3 12 2.3 12Z"/><circle cx="12" cy="12" r="2.7"/><path class="slash" d="M4 4l16 16"/></svg>';
}
function style(){
  if(document.getElementById('v21SpoilerCss'))return;
  const s=document.createElement('style');s.id='v21SpoilerCss';s.textContent=
  '.v21SpoilerToggle{position:fixed;right:14px;top:9px;z-index:9999;width:42px;height:42px;border:1px solid #383d4b;border-radius:13px;background:#141720eF;color:#d7dae5;display:grid;place-items:center;padding:0;box-shadow:0 4px 18px #0007;backdrop-filter:blur(10px)}'+
  '.v21SpoilerToggle svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.v21SpoilerToggle .slash{display:none}.v21SpoilerToggle.on{border-color:#a978ca;background:#2a2034;color:#ead8ff}.v21SpoilerToggle.on .slash{display:block}.v21SpoilerDot{position:absolute;right:-3px;top:-3px;min-width:15px;height:15px;border-radius:8px;background:#ff5a00;color:#fff;font:950 7px/15px Arial;text-align:center;padding:0 3px}.v21Toast{position:fixed;right:14px;top:58px;z-index:10000;padding:8px 10px;border:1px solid #454a58;border-radius:10px;background:#13161ecc;color:#fff;font:800 8px/1.15 Arial;box-shadow:0 5px 20px #0008;pointer-events:none;opacity:0;transform:translateY(-4px);transition:.16s}.v21Toast.show{opacity:1;transform:none}'+
  '.hohNoSpoilers .v19CardScore,.hohNoSpoilers .v19Score,.hohNoSpoilers .v19LastScore,.hohNoSpoilers .v15Game .score{font-size:0!important;color:transparent!important}'+
  '.hohNoSpoilers .v19CardScore:after,.hohNoSpoilers .v19LastScore:after,.hohNoSpoilers .v15Game .score:after{content:"•• : ••";font-size:12px!important;color:#a2a7b5!important;letter-spacing:1px}.hohNoSpoilers .v19Score:after{content:"•• : ••";font:950 22px/1 Arial;color:#a2a7b5!important;letter-spacing:2px}'+
  '.hohNoSpoilers .v19Market.won,.hohNoSpoilers .v19CardOdd.won{background:#13151e!important;border-color:#353847!important;color:inherit!important;box-shadow:none!important}.hohNoSpoilers .v19Market.won span,.hohNoSpoilers .v19Market.won strong,.hohNoSpoilers .v19CardOdd.won span,.hohNoSpoilers .v19CardOdd.won b{color:inherit!important}.hohNoSpoilers .v19Market.won i{display:none!important}'+
  '.v15Light .v21SpoilerToggle{background:#ffffffed;color:#242734;border-color:#d5d9e3;box-shadow:0 4px 14px #19243a22}.v15Light .v21SpoilerToggle.on{background:#efe6f6;color:#5d3d73;border-color:#a982c3}.v15Light.hohNoSpoilers .v19Market.won,.v15Light.hohNoSpoilers .v19CardOdd.won{background:#f6f7fa!important;border-color:#d8dce5!important;color:#171923!important}';
  document.head.appendChild(s);
}
function toast(){
  let x=document.getElementById('v21Toast');if(!x){x=document.createElement('div');x.id='v21Toast';x.className='v21Toast';document.body.appendChild(x)}
  x.textContent=state.enabled?'Без спойлеров · ВКЛ':'Без спойлеров · ВЫКЛ';x.classList.add('show');clearTimeout(window.__v21Toast);window.__v21Toast=setTimeout(()=>x.classList.remove('show'),1200);
}
function apply(showToast=false){
  document.documentElement.classList.toggle('hohNoSpoilers',state.enabled);
  const b=document.getElementById('v21SpoilerToggle');
  if(b){b.classList.toggle('on',state.enabled);b.setAttribute('aria-pressed',state.enabled?'true':'false');b.setAttribute('aria-label',state.enabled?'Выключить режим без спойлеров':'Включить режим без спойлеров');b.title=state.enabled?'Без спойлеров: включено':'Без спойлеров: выключено';b.innerHTML=eyeSvg()+(state.enabled?'<span class="v21SpoilerDot">ON</span>':'')}
  if(showToast)toast();
}
function save(){
  localStorage.setItem(KEY,state.enabled?'1':'0');
  try{tg?.CloudStorage?.setItem?.(KEY,state.enabled?'1':'0',()=>{})}catch{}
}
function toggle(){state.enabled=!state.enabled;save();apply(true)}
function install(){
  style();
  let b=document.getElementById('v21SpoilerToggle');
  if(!b){b=document.createElement('button');b.type='button';b.id='v21SpoilerToggle';b.className='v21SpoilerToggle';b.onclick=e=>{e.preventDefault();e.stopPropagation();toggle()};document.body.appendChild(b)}
  document.querySelectorAll('.v15Version,.v19Version').forEach(x=>x.textContent='V21');
  apply(false);
}
function hydrate(){
  try{
    tg?.CloudStorage?.getItem?.(KEY,(err,value)=>{
      if(err||value!=='1'&&value!=='0')return;
      state.enabled=value==='1';localStorage.setItem(KEY,value);apply(false);
    });
  }catch{}
}
install();hydrate();
const obs=new MutationObserver(()=>{if(!document.getElementById('v21SpoilerToggle'))install();document.querySelectorAll('.v15Version,.v19Version').forEach(x=>x.textContent='V21')});
obs.observe(document.documentElement,{childList:true,subtree:true});
})();`;
