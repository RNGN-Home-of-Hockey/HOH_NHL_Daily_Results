const PATH="/telegram-app/v22.js";

export function handleTelegramCenterV22Ui(request,path){
  if(path!==PATH)return null;
  if(request.method!=="GET")return new Response("method_not_allowed",{status:405});
  return new Response(V22_JS,{headers:{"Content-Type":"application/javascript; charset=utf-8","Cache-Control":"no-store, no-cache, must-revalidate","X-Content-Type-Options":"nosniff"}});
}

const V22_JS=String.raw`(function(){
'use strict';
const H=window.HOHV15;if(!H)return;
const API='/api/telegram-center-v22';
let lastProfile=null,placing=false;

function esc(v){return H.esc?H.esc(v):String(v==null?'':v)}
function css(){
  if(document.getElementById('v22css'))return;
  const s=document.createElement('style');s.id='v22css';s.textContent=
  '.app{padding-top:8px!important}.v21SpoilerToggle{position:relative!important;right:auto!important;top:auto!important;z-index:auto!important;width:42px!important;height:42px!important;flex:0 0 42px!important;box-shadow:none!important}.v22NavRow,.v22BackRow{display:grid;grid-template-columns:minmax(0,1fr) 42px;gap:8px;align-items:center}.v22NavRow{margin-bottom:12px}.v22NavRow .tabs{margin:0!important}.v22BackRow{margin-bottom:2px}.v22BackRow .v15BackRow{min-width:0}.v22ProfileCard{border:1px solid #303441;border-radius:14px;background:#11131a;padding:11px;margin-bottom:9px}.v22ProfileCard h3{margin:0 0 4px;font-size:11px}.v22ProfileCard p{margin:0;color:#858b9c;font-size:7px;line-height:1.35}.v22ProfileCard button{margin-top:9px;width:100%;height:36px;border:1px solid #6f4e88;border-radius:10px;background:#261d30;color:#fff;font-weight:900}.v22Settings{display:grid;gap:9px}.v22SettingsHead{display:grid;grid-template-columns:72px minmax(0,1fr);gap:12px;align-items:center}.v22Avatar{width:72px;height:72px;border-radius:50%;object-fit:cover;background:#242834;border:1px solid #3c4150}.v22AvatarBtn{display:inline-flex;align-items:center;justify-content:center;height:32px;padding:0 10px;border:1px solid #3b4050;border-radius:9px;background:#171a23;color:#fff;font-size:8px;font-weight:900}.v22Form{display:grid;grid-template-columns:1fr 1fr;gap:8px}.v22Field{display:grid;gap:4px}.v22Field.wide{grid-column:1/-1}.v22Field label{font-size:7px;color:#9095a5}.v22Field input,.v22Field select{height:40px;border:1px solid #303441;border-radius:10px;background:#12141b;color:#fff;padding:0 10px;min-width:0}.v22Actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}.v22Actions button{height:40px;border-radius:10px;border:1px solid #454a59;background:#171a23;color:#fff;font-weight:900}.v22Actions .save{border-color:#7d5799;background:#2a2034}.v22Hint{font-size:7px;color:#777d8d;line-height:1.4}.v15Light .v22ProfileCard,.v15Light .v22Field input,.v15Light .v22Field select{background:#fff!important;color:#171923!important;border-color:#d8dce5!important}.v15Light .v22AvatarBtn,.v15Light .v22Actions button{background:#fff;color:#171923;border-color:#d8dce5}.v15Light .v22Actions .save{background:#eee7f7}.v19Portrait .v19Country{top:42px!important}.v19Info .v19PronText,.v15PronText,[data-pronunciation-text]{display:none!important}.v19Metrics{gap:8px!important}.v19Metric{padding:10px 8px!important;overflow:hidden}.v19Metric .v19Bar{margin:11px 0 8px!important;height:6px!important;background:#272b37!important}.v19Metric .v19Bar i{background:linear-gradient(90deg,#4f7cff 0%,#9c6cff 52%,#ff8a3d 100%)!important;border-radius:99px!important}.v19Metric span{position:static!important;display:block!important;transform:none!important;margin:0!important;min-height:14px!important;line-height:1.25!important}.v19Section{margin-top:14px!important;margin-bottom:8px!important}.v15Section{margin-top:14px!important;margin-bottom:8px!important}.v15GameRich{grid-template-columns:86px 34px minmax(0,1fr) auto!important;padding:11px!important;gap:9px!important}.v15GameRich .dt{display:grid;gap:4px}.v15GameRich .dt small{display:block;color:#a78bc2;font-size:6px;line-height:1.25}.v15GameRich .v19TeamVk{grid-column:1/-1;justify-self:start;margin-left:95px;text-decoration:none}.v19MetaSecond{color:#ffb178!important;margin-top:4px!important}.v15OddsMatch{display:grid;grid-template-columns:1fr auto 1fr;gap:7px;align-items:center;margin:0 0 9px;padding:8px;border:1px solid #35291f;border-radius:10px;background:#15131a}.v15OddsMatch>div{text-align:center;min-width:0}.v15OddsMatch img{display:block;width:34px;height:34px;object-fit:contain;margin:0 auto 4px}.v15OddsMatch span{display:block;font-size:6.5px;line-height:1.15}.v15OddsMatch>b{font-size:6.5px;color:#aaa;text-align:center;max-width:86px}.v15Light .v15OddsMatch{background:#fff!important;border-color:#e1c5ae!important;color:#171923!important}';
  document.head.appendChild(s);
}
function button(){return document.getElementById('v21SpoilerToggle')}
function unwrap(el){if(!el||!el.parentElement)return;const p=el.parentElement;if(!p.classList.contains('v22NavRow')&&!p.classList.contains('v22BackRow'))return;p.parentElement.insertBefore(el,p);p.remove()}
function placeEye(){
  if(placing)return;placing=true;
  try{
    const b=button();if(!b)return;
    const back=document.querySelector('.v15Profile .v15BackRow,.v19Profile .v15BackRow,.v20Detail .v15BackRow');
    const tabs=document.getElementById('tabs');
    if(back){
      if(b.parentElement?.classList.contains('v22BackRow')&&back.parentElement===b.parentElement)return;
      if(b.parentElement?.classList.contains('v22NavRow'))unwrap(tabs);
      let wrap=back.parentElement?.classList.contains('v22BackRow')?back.parentElement:null;
      if(!wrap){wrap=document.createElement('div');wrap.className='v22BackRow';back.parentElement.insertBefore(wrap,back);wrap.appendChild(back)}
      wrap.appendChild(b);return;
    }
    if(tabs){
      if(b.parentElement?.classList.contains('v22NavRow')&&tabs.parentElement===b.parentElement)return;
      let wrap=tabs.parentElement?.classList.contains('v22NavRow')?tabs.parentElement:null;
      if(!wrap){wrap=document.createElement('div');wrap.className='v22NavRow';tabs.parentElement.insertBefore(wrap,tabs);wrap.appendChild(tabs)}
      wrap.appendChild(b);
    }
  }finally{placing=false}
}
async function me(force=false){
  if(lastProfile&&!force)return lastProfile;
  try{lastProfile=await H.api(API+'/me');return lastProfile}catch{return null}
}
window.HOHEnsureCommentIdentity=async function(){
  const d=await me(true);if(!d)return false;
  if(d.profile?.display_username)return true;
  const raw=window.prompt('Выберите ник для комментариев (3–24 символа)');
  if(raw===null)return false;
  const name=String(raw).trim().replace(/^@/,'');
  if(!/^[A-Za-zА-Яа-яЁё0-9_]{3,24}$/u.test(name)){alert('Ник: 3–24 символа, буквы, цифры или _');return false}
  try{lastProfile=await H.api(API+'/me',{method:'PUT',body:JSON.stringify({display_username:name})});return true}catch(e){alert(e.message||e);return false}
};
async function imageData(file){
  if(!file)return null;if(file.size>10*1024*1024)throw new Error('Файл слишком большой: максимум 10 МБ до сжатия');
  const bmp=await createImageBitmap(file),side=Math.min(bmp.width,bmp.height),sx=(bmp.width-side)/2,sy=(bmp.height-side)/2;
  const canvas=document.createElement('canvas');canvas.width=256;canvas.height=256;const c=canvas.getContext('2d');c.drawImage(bmp,sx,sy,side,side,0,0,256,256);bmp.close?.();
  async function blob(q,w=256){if(canvas.width!==w){const old=document.createElement('canvas');old.width=canvas.width;old.height=canvas.height;old.getContext('2d').drawImage(canvas,0,0);canvas.width=w;canvas.height=w;canvas.getContext('2d').drawImage(old,0,0,w,w)}return new Promise(r=>canvas.toBlob(r,'image/webp',q))}
  let out=await blob(.82);if(out&&out.size>115000)out=await blob(.68);if(out&&out.size>115000)out=await blob(.62,192);if(!out||out.size>120000)throw new Error('Не удалось достаточно сжать аватар');
  return new Promise((resolve,reject)=>{const fr=new FileReader();fr.onload=()=>resolve(String(fr.result));fr.onerror=reject;fr.readAsDataURL(out)});
}
function profileCard(){
  return '<section class="v22ProfileCard" id="v22ProfileCard"><h3>Профиль и комментарии</h3><p>Ник, аватар, анкета и тема приложения. Ник можно менять не чаще одного раза в сутки.</p><button id="v22OpenProfile">Настроить профиль</button></section>';
}
function mountMine(){
  if(H.state.profile||!['mine','follows'].includes(H.currentTab())||!H.tabsVisible())return;
  const root=H.view();if(!root||root.querySelector('#v22ProfileCard'))return;
  const theme=root.querySelector('#v15Theme');if(theme)theme.insertAdjacentHTML('afterend',profileCard());else root.insertAdjacentHTML('afterbegin',profileCard());
  const b=document.getElementById('v22OpenProfile');if(b)b.onclick=()=>openSettings();
}
async function openSettings(){
  H.state.profile=true;const tabs=document.getElementById('tabs');if(tabs)tabs.style.display='none';const root=H.view();if(!root)return;root.innerHTML='<div class="v15Loading">Загрузка профиля…</div>';placeEye();
  const d=await me(true);if(!d){root.innerHTML=H.backRow('Настройки')+'<div class="v15Empty">Не удалось загрузить профиль.</div>';document.getElementById('v15Back').onclick=backSettings;placeEye();return}
  const p=d.profile||{},avatar=p.avatar_url||'',year=new Date().getFullYear();
  root.innerHTML='<div class="v15Profile v22Settings">'+H.backRow('Настройки')+
  '<section class="v22ProfileCard"><div class="v22SettingsHead"><img class="v22Avatar" id="v22AvatarPreview" src="'+esc(avatar)+'" alt=""><div><h3>Личный профиль</h3><p>Аватар автоматически приводится к 256×256 WebP и хранится в облегчённом виде.</p><label class="v22AvatarBtn">Выбрать фото<input id="v22AvatarFile" type="file" accept="image/*" hidden></label></div></div></section>'+
  '<div class="v22Form">'+
  field('Ник','display_username',p.display_username||'',24,true)+field('Имя','profile_name',p.profile_name||'',40)+
  field('Дата рождения','birth_date',p.birth_date||'',10,false,'date')+field('Город','city',p.city||'',60)+
  field('С какого года следите за хоккеем','hockey_since_year',p.hockey_since_year||'',4,false,'number','1900',String(year))+
  field('Любимая команда (код)','favorite_team_tri',p.favorite_team_tri||'',3)+
  field('Любимый игрок','favorite_player',p.favorite_player||'',80,true)+
  '<div class="v22Field wide"><label>Тема</label><select id="v22_theme_mode"><option value="dark" '+(p.theme_mode!=='light'?'selected':'')+'>Тёмная</option><option value="light" '+(p.theme_mode==='light'?'selected':'')+'>Светлая</option></select></div>'+
  '</div><div class="v22Hint">Ник закреплён за профилем и используется в комментариях. После смены следующая смена доступна через 24 часа.</div>'+
  '<div class="v22Actions"><button id="v22Cancel">Назад</button><button class="save" id="v22Save">Сохранить</button></div></div>';
  document.getElementById('v15Back').onclick=backSettings;document.getElementById('v22Cancel').onclick=backSettings;placeEye();
  let avatarData;
  const file=document.getElementById('v22AvatarFile');file.onchange=async()=>{try{avatarData=await imageData(file.files?.[0]);document.getElementById('v22AvatarPreview').src=avatarData}catch(e){alert(e.message||e)}};
  document.getElementById('v22Save').onclick=async()=>{const btn=document.getElementById('v22Save');btn.disabled=true;try{
    const body={};for(const k of ['display_username','profile_name','birth_date','city','hockey_since_year','favorite_team_tri','favorite_player','theme_mode']){const x=document.getElementById('v22_'+k);body[k]=x?.value||null}
    if(avatarData)body.avatar_data_url=avatarData;
    lastProfile=await H.api(API+'/me',{method:'PUT',body:JSON.stringify(body)});H.setTheme?.(body.theme_mode||'dark');alert('Профиль сохранён');
  }catch(e){alert(e.message||e)}finally{btn.disabled=false}};
}
function field(label,key,value,max,wide=false,type='text',min='',maxNum=''){return '<div class="v22Field '+(wide?'wide':'')+'"><label>'+esc(label)+'</label><input id="v22_'+key+'" type="'+type+'" value="'+esc(value)+'" maxlength="'+max+'" '+(min?'min="'+min+'"':'')+' '+(maxNum?'max="'+maxNum+'"':'')+'></div>'}
function backSettings(){H.state.profile=false;const tabs=document.getElementById('tabs');if(tabs)tabs.style.display='grid';const t=tabs?.querySelector('[data-tab="follows"]');if(t)t.click();setTimeout(()=>{mountMine();placeEye()},100)}
function normalizePlayers(){
  document.querySelectorAll('.v19PlayerProfile').forEach(profile=>{
    profile.querySelectorAll('.v19PronText,.v15PronText,[data-pronunciation-text]').forEach(x=>x.remove());
    const aud=[...profile.querySelectorAll('.v19Audio,.v15Audio')];aud.slice(1).forEach(x=>x.remove());
    const portraits=profile.querySelectorAll('.v19Portrait');portraits.forEach(p=>{const country=p.querySelector('.v19Country');if(country)country.style.top='42px'});
  });
}
function version(){document.querySelectorAll('.v15Version,.v19Version').forEach(x=>{if(x.textContent!=='V22')x.textContent='V22'})}

css();placeEye();mountMine();normalizePlayers();version();
me(true).then(d=>{const p=d?.profile;if(p?.exists&&p.theme_mode&&H.theme?.()!==p.theme_mode)H.setTheme?.(p.theme_mode)}).catch(()=>{});
const obs=new MutationObserver(()=>{requestAnimationFrame(()=>{placeEye();mountMine();normalizePlayers();version()})});
obs.observe(document.documentElement,{childList:true,subtree:true});
document.addEventListener('click',e=>{
  const wl=e.target.closest?.('a[href^="/go/winline"]');
  if(wl){
    e.preventDefault();e.stopPropagation();
    const url=new URL(wl.getAttribute('href'),location.origin).href;
    try{if(window.Telegram?.WebApp?.openLink)window.Telegram.WebApp.openLink(url,{try_instant_view:false});else window.location.href=url}catch{window.location.href=url}
    return;
  }
  if(e.target.closest?.('.tab,[id="v15Back"]'))setTimeout(()=>{placeEye();mountMine()},60)
},true);
})();`;
