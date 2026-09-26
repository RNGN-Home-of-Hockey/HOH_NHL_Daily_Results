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
const TEAMS=[['ANA','Анахайм Дакс'],['BOS','Бостон Брюинз'],['BUF','Баффало Сэйбрз'],['CGY','Калгари Флэймз'],['CAR','Каролина Харрикейнз'],['CHI','Чикаго Блэкхокс'],['COL','Колорадо Эвеланш'],['CBJ','Коламбус Блю Джекетс'],['DAL','Даллас Старз'],['DET','Детройт Ред Уингз'],['EDM','Эдмонтон Ойлерз'],['FLA','Флорида Пантерз'],['LAK','Лос-Анджелес Кингз'],['MIN','Миннесота Уайлд'],['MTL','Монреаль Канадиенс'],['NSH','Нэшвилл Предаторз'],['NJD','Нью-Джерси Девилз'],['NYI','Нью-Йорк Айлендерс'],['NYR','Нью-Йорк Рейнджерс'],['OTT','Оттава Сенаторз'],['PHI','Филадельфия Флайерз'],['PIT','Питтсбург Пингвинз'],['SJS','Сан-Хосе Шаркс'],['SEA','Сиэтл Кракен'],['STL','Сент-Луис Блюз'],['TBL','Тампа-Бэй Лайтнинг'],['TOR','Торонто Мэйпл Лифс'],['UTA','Юта Маммот'],['VAN','Ванкувер Кэнакс'],['VGK','Вегас Голден Найтс'],['WSH','Вашингтон Кэпиталз'],['WPG','Виннипег Джетс']];
let lastProfile=null,placing=false;

function esc(v){return H.esc?H.esc(v):String(v==null?'':v)}
function css(){
  if(document.getElementById('v22css'))return;
  const s=document.createElement('style');s.id='v22css';s.textContent=
  '.app{padding-top:8px!important}.v21SpoilerToggle{position:static!important;right:auto!important;top:auto!important;z-index:auto!important;width:42px!important;height:42px!important;flex:0 0 42px!important;box-shadow:none!important}.v22NavRow,.v22BackRow{display:grid;grid-template-columns:minmax(0,1fr) 42px;gap:8px;align-items:center}.v22NavRow{margin-bottom:12px}.v22NavRow .tabs{margin:0!important}.v22NavRow{grid-template-columns:minmax(0,1fr) 42px 42px!important}.v22BackRow{grid-template-columns:minmax(0,1fr) 42px!important}.v22NavRow .tabs{grid-template-columns:repeat(4,minmax(0,1fr))!important}.v22NavRow .tab[data-tab="follows"],.v22NavRow .tab[data-tab="mine"]{display:none!important}.v22SettingsToggle{width:42px;height:42px;border:1px solid #383d4b;border-radius:13px;background:#141720ef;color:#d7dae5;display:grid;place-items:center;padding:0;font-size:19px;line-height:1;box-shadow:none;backdrop-filter:blur(10px)}.v22SettingsToggle.on{border-color:#a978ca;background:#2a2034;color:#ead8ff}.v15Light .v22SettingsToggle{background:#ffffffed;color:#242734;border-color:#d5d9e3}.v15Light .v22SettingsToggle.on{background:#efe6f6;color:#5d3d73;border-color:#a982c3}.v22BackRow{margin-bottom:2px;width:100%}.v22BackRow .v15BackRow,.v22BackRow .toolbar{min-width:0;margin:0!important}.v22ProfileCard{border:1px solid #303441;border-radius:14px;background:#11131a;padding:11px;margin-bottom:9px}.v22ProfileCard h3{margin:0 0 4px;font-size:11px}.v22ProfileCard p{margin:0;color:#858b9c;font-size:7px;line-height:1.35}.v22ProfileCard button{margin-top:9px;width:100%;height:36px;border:1px solid #6f4e88;border-radius:10px;background:#261d30;color:#fff;font-weight:900}.v22Settings{display:grid;gap:9px}.v22SettingsHead{display:grid;grid-template-columns:72px minmax(0,1fr);gap:12px;align-items:center}.v22Avatar{width:72px;height:72px;border-radius:50%;object-fit:cover;background:#242834;border:1px solid #3c4150}.v22AvatarBtn{display:inline-flex;align-items:center;justify-content:center;height:32px;padding:0 10px;border:1px solid #3b4050;border-radius:9px;background:#171a23;color:#fff;font-size:8px;font-weight:900}.v22Form{display:grid;grid-template-columns:1fr 1fr;gap:8px}.v22Field{display:grid;gap:4px}.v22Field.wide{grid-column:1/-1}.v22Field label{font-size:7px;color:#9095a5}.v22Field input,.v22Field select{height:40px;border:1px solid #303441;border-radius:10px;background:#12141b;color:#fff;padding:0 10px;min-width:0}.v22Actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}.v22Actions button{height:40px;border-radius:10px;border:1px solid #454a59;background:#171a23;color:#fff;font-weight:900}.v22Actions .save{border-color:#7d5799;background:#2a2034}.v22Hint{font-size:7px;color:#777d8d;line-height:1.4}.v15Light .v22ProfileCard,.v15Light .v22Field input,.v15Light .v22Field select{background:#fff!important;color:#171923!important;border-color:#d8dce5!important}.v15Light .v22AvatarBtn,.v15Light .v22Actions button{background:#fff;color:#171923;border-color:#d8dce5}.v15Light .v22Actions .save{background:#eee7f7}.v19Portrait .v19Country{top:4px!important;left:4px!important;display:flex!important;gap:1px!important;background:#0b0d13b8;border-radius:6px;padding:3px 4px}.v19Portrait .v19Country span{display:inline-block!important;height:auto!important;line-height:1!important}.v19Portrait .v19Ghost{opacity:.82!important;right:1px!important;top:9px!important;width:66px!important;height:66px!important}.v19Info .v19PronText,.v15PronText,[data-pronunciation-text]{display:none!important}.v19Metrics{grid-template-columns:repeat(4,minmax(0,1fr))!important;gap:6px!important}.v19Metric{padding:10px 8px!important;overflow:hidden}.v19Metric .v19Bar{margin:11px 0 8px!important;height:6px!important;background:#272b37!important}.v19Metric .v19Bar i{background:linear-gradient(90deg,#4f7cff 0%,#9c6cff 52%,#ff8a3d 100%)!important;border-radius:99px!important}.v19Metric span{position:static!important;display:block!important;transform:none!important;margin:0!important;min-height:14px!important;line-height:1.25!important}.v19Section{margin-top:14px!important;margin-bottom:8px!important}.v15Section{margin-top:14px!important;margin-bottom:8px!important}.v15GameRich{grid-template-columns:86px 34px minmax(0,1fr) auto!important;padding:11px!important;gap:9px!important}.v15GameRich .dt{display:grid;gap:4px}.v15GameRich .dt small{display:block;color:#a78bc2;font-size:6px;line-height:1.25}.v15GameRich .v19TeamVk{grid-column:1/-1;justify-self:start;margin-left:95px;text-decoration:none}.v19MetaSecond{color:#ffb178!important;margin-top:4px!important}.v15OddsMatch{display:grid;grid-template-columns:1fr auto 1fr;gap:7px;align-items:center;margin:0 0 9px;padding:8px;border:1px solid #35291f;border-radius:10px;background:#15131a}.v15OddsMatch>div{text-align:center;min-width:0}.v15OddsMatch img{display:block;width:34px;height:34px;object-fit:contain;margin:0 auto 4px}.v15OddsMatch span{display:block;font-size:6.5px;line-height:1.15}.v15OddsMatch>b{font-size:6.5px;color:#aaa;text-align:center;max-width:86px}.v15Light .v15OddsMatch{background:#fff!important;border-color:#e1c5ae!important;color:#171923!important}.v15PlayerBrowser .v16Country,.v15PlayerBrowser .v17Country,.v15PlayerRow .v16Country,.v15PlayerRow .v17Country{top:19px!important;left:1px!important;opacity:.9!important}.v15PlayerBrowser .v16Portrait.mini .teamGhost,.v15PlayerRow .v16Portrait.mini .teamGhost{top:5px!important;right:0!important}.v15PlayerBrowser .v16Portrait.mini .person,.v15PlayerRow .v16Portrait.mini .person{bottom:0!important}';
  document.head.appendChild(s);
}
function button(){return document.getElementById('v21SpoilerToggle')}
function unwrap(el){if(!el||!el.parentElement)return;const p=el.parentElement;if(!p.classList.contains('v22NavRow')&&!p.classList.contains('v22BackRow'))return;p.parentElement.insertBefore(el,p);p.remove()}
function settingsButton(){let g=document.getElementById('v22SettingsToggle');if(!g){g=document.createElement('button');g.type='button';g.id='v22SettingsToggle';g.className='v22SettingsToggle';g.setAttribute('aria-label','Мои и настройки');g.title='Мои и настройки';g.textContent='⚙';g.onclick=e=>{e.preventDefault();e.stopPropagation();H.state.profile=false;const tabs=document.getElementById('tabs');if(tabs)tabs.style.display='grid';const t=tabs?.querySelector('[data-tab="follows"],[data-tab="mine"]');if(t)t.click();setTimeout(()=>{mountMine();placeEye();syncSettingsButton()},80)}}return g}
function syncSettingsButton(){const g=document.getElementById('v22SettingsToggle');if(g)g.classList.toggle('on',['mine','follows'].includes(H.currentTab()))}
function placeEye(){
  if(placing)return;placing=true;
  try{
    const b=button();if(!b)return;
    let back=document.querySelector('.v15Profile .v15BackRow,.v19Profile .v15BackRow,.v20Detail .v15BackRow');
    if(!back){const legacy=[...document.querySelectorAll('#view .toolbar')].find(x=>x.querySelector('button.back,#back'));if(legacy)back=legacy}
    const tabs=document.getElementById('tabs');
    if(back){
      if(b.parentElement?.classList.contains('v22BackRow')&&back.parentElement===b.parentElement)return;
      if(b.parentElement?.classList.contains('v22NavRow'))unwrap(tabs);
      let wrap=back.parentElement?.classList.contains('v22BackRow')?back.parentElement:null;
      if(!wrap){wrap=document.createElement('div');wrap.className='v22BackRow';back.parentElement.insertBefore(wrap,back);wrap.appendChild(back)}
      wrap.appendChild(b);return;
    }
    if(tabs){
      let wrap=tabs.parentElement?.classList.contains('v22NavRow')?tabs.parentElement:null;
      if(!wrap){wrap=document.createElement('div');wrap.className='v22NavRow';tabs.parentElement.insertBefore(wrap,tabs);wrap.appendChild(tabs)}
      if(b.parentElement!==wrap)wrap.appendChild(b);
      const g=settingsButton();if(g.parentElement!==wrap)wrap.appendChild(g);syncSettingsButton();
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
  teamSelect(p.favorite_team_tri||'')+
  field('Любимый игрок','favorite_player',p.favorite_player||'',80,true)+
  '<div class="v22Field"><label>Тема</label><select id="v22_theme_mode"><option value="light" '+(p.theme_mode!=='dark'?'selected':'')+'>Светлая</option><option value="dark" '+(p.theme_mode==='dark'?'selected':'')+'>Тёмная</option></select></div>'+
  '<div class="v22Field"><label>Без спойлеров</label><select id="v22_no_spoilers"><option value="0" '+(!p.no_spoilers?'selected':'')+'>Выключено</option><option value="1" '+(p.no_spoilers?'selected':'')+'>Включено</option></select></div>'+
  '</div><div class="v22Hint">Ник закреплён за профилем и используется в комментариях. После смены следующая смена доступна через 24 часа.</div>'+
  '<div class="v22Actions"><button id="v22Cancel">Назад</button><button class="save" id="v22Save">Сохранить</button></div></div>';
  document.getElementById('v15Back').onclick=backSettings;document.getElementById('v22Cancel').onclick=backSettings;placeEye();
  let avatarData;
  const file=document.getElementById('v22AvatarFile');file.onchange=async()=>{try{avatarData=await imageData(file.files?.[0]);document.getElementById('v22AvatarPreview').src=avatarData}catch(e){alert(e.message||e)}};
  document.getElementById('v22Save').onclick=async()=>{const btn=document.getElementById('v22Save');btn.disabled=true;try{
    const body={};for(const k of ['display_username','profile_name','birth_date','city','hockey_since_year','favorite_team_tri','favorite_player','theme_mode']){const x=document.getElementById('v22_'+k);body[k]=x?.value||null}
    body.no_spoilers=document.getElementById('v22_no_spoilers')?.value==='1';
    if(avatarData)body.avatar_data_url=avatarData;
    lastProfile=await H.api(API+'/me',{method:'PUT',body:JSON.stringify(body)});H.setTheme?.(body.theme_mode||'light');window.HOHSetNoSpoilers?.(body.no_spoilers);alert('Профиль сохранён');
  }catch(e){alert(e.message||e)}finally{btn.disabled=false}};
}
function field(label,key,value,max,wide=false,type='text',min='',maxNum=''){return '<div class="v22Field '+(wide?'wide':'')+'"><label>'+esc(label)+'</label><input id="v22_'+key+'" type="'+type+'" value="'+esc(value)+'" maxlength="'+max+'" '+(min?'min="'+min+'"':'')+' '+(maxNum?'max="'+maxNum+'"':'')+'></div>'}
function teamSelect(value){return '<div class="v22Field"><label>Любимая команда</label><select id="v22_favorite_team_tri"><option value="">Не выбрана</option>'+TEAMS.map(([tri,name])=>'<option value="'+tri+'" '+(tri===value?'selected':'')+'>'+esc(name)+'</option>').join('')+'</select></div>'}
function backSettings(){H.state.profile=false;const tabs=document.getElementById('tabs');if(tabs)tabs.style.display='grid';const t=tabs?.querySelector('[data-tab="follows"]');if(t)t.click();setTimeout(()=>{mountMine();placeEye()},100)}
function normalizePlayers(){
  document.querySelectorAll('.v19PlayerProfile').forEach(profile=>{
    profile.querySelectorAll('.v19PronText,.v15PronText,[data-pronunciation-text]').forEach(x=>x.remove());
    const aud=[...profile.querySelectorAll('.v19Audio,.v15Audio')];aud.slice(1).forEach(x=>x.remove());
    const portraits=profile.querySelectorAll('.v19Portrait');portraits.forEach(p=>{const country=p.querySelector('.v19Country');if(country){country.style.top='4px';country.style.left='4px'}const ghost=p.querySelector('.v19Ghost');if(ghost)ghost.style.opacity='.82'});
  });
}
function version(){document.querySelectorAll('.v15Version,.v19Version').forEach(x=>{if(x.textContent!=='V22')x.textContent='V22'})}

css();placeEye();mountMine();normalizePlayers();version();H.decorateHomeOdds?.();
me(true).then(d=>{const p=d?.profile,stored=localStorage.getItem('hoh-center-theme');if(!stored)H.setTheme?.('light');if(p?.exists)window.HOHSetNoSpoilers?.(Boolean(p.no_spoilers));syncSettingsButton()}).catch(()=>{});
window.addEventListener('hoh-spoilers-change',async e=>{const enabled=Boolean(e.detail?.enabled);try{lastProfile=await H.api(API+'/me',{method:'PUT',body:JSON.stringify({no_spoilers:enabled})})}catch{}});
const obs=new MutationObserver(()=>{requestAnimationFrame(()=>{placeEye();mountMine();normalizePlayers();version();H.decorateHomeOdds?.();syncSettingsButton()})});
obs.observe(document.documentElement,{childList:true,subtree:true});
document.addEventListener('click',e=>{
  const player=e.target.closest?.('[data-v15-player],[data-player],[data-v2-player]');
  if(player&&!player.closest('.v19PlayerProfile')&&typeof H.openPlayer==='function'){
    const id=Number(player.dataset.v15Player||player.dataset.player||player.dataset.v2Player||0);
    if(id){e.preventDefault();e.stopImmediatePropagation();H.openPlayer(id);return}
  }
  const legacyGame=e.target.closest?.('.gameCard[data-game],.nextCard[data-game]');
  if(legacyGame&&!e.target.closest?.('a,button')&&typeof H.openGameV19==='function'){
    e.preventDefault();e.stopImmediatePropagation();
    H.openGameV19(Number(legacyGame.dataset.game),{returnTab:H.currentTab()||'games'});
    return;
  }
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
