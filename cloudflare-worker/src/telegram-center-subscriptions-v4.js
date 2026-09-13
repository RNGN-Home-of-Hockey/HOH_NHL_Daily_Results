const API = "/api/telegram-center-v4";
const SCRIPT_PATH = "/telegram-app/subscriptions-v4.js";

export async function handleTelegramCenterSubscriptionsV4(request, env, path) {
  if (path === SCRIPT_PATH) {
    if (request.method !== "GET") return json({ok:false,error:"method_not_allowed"},405);
    return new Response(SCRIPT,{headers:{"Content-Type":"application/javascript; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
  }
  if (!path.startsWith(API)) return null;
  if (!env.DB) return json({ok:false,error:"missing_d1_binding"},503);

  const pref=/^\/api\/telegram-center-v4\/subscriptions\/(\d+)\/preferences$/.exec(path);
  if(pref && request.method==="GET") return getPreferences(request,env,Number(pref[1]));
  if(pref && ["POST","PUT"].includes(request.method)) return putPreferences(request,env,Number(pref[1]));

  const group=/^\/api\/telegram-center-v4\/groups\/([A-Za-z0-9_-]+)\/subscribe$/.exec(path);
  if(group && request.method==="POST") return subscribeGroup(request,env,group[1]);

  const groupDelete=/^\/api\/telegram-center-v4\/groups\/([A-Za-z0-9_-]+)\/unsubscribe$/.exec(path);
  if(groupDelete && request.method==="POST") return unsubscribeGroup(request,env,groupDelete[1]);

  return json({ok:false,error:"not_found"},404);
}

async function subscribeGroup(request,env,key){
  const auth=await centerTelegramAuth(request,env,true);if(!auth.ok)return json({ok:false,error:auth.error},401);
  const group=await env.DB.prepare(`SELECT group_key,title_ru,description_ru,country_code FROM subscription_groups WHERE group_key=? AND active=1 LIMIT 1;`).bind(key).first();
  if(!group)return json({ok:false,error:"group_not_found"},404);
  await upsertUser(env.DB,auth.user);
  await env.DB.prepare(`
    INSERT INTO subscriptions (telegram_user_id,subject_type,subject_key,notify_pregame,notify_start,notify_goal,notify_assist,notify_period_end,notify_final)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(telegram_user_id,subject_type,subject_key) DO UPDATE SET subject_key=excluded.subject_key;
  `).bind(auth.user.id,"group",key,1,0,1,0,0,1).run();
  const sub=await env.DB.prepare(`SELECT subscription_id,subject_type,subject_key FROM subscriptions WHERE telegram_user_id=? AND subject_type='group' AND subject_key=? LIMIT 1;`).bind(auth.user.id,key).first();
  await ensurePreference(env.DB,sub.subscription_id,"group");
  return json({ok:true,group,subscription:sub});
}

async function unsubscribeGroup(request,env,key){
  const auth=await centerTelegramAuth(request,env,true);if(!auth.ok)return json({ok:false,error:auth.error},401);
  const row=await env.DB.prepare(`SELECT subscription_id FROM subscriptions WHERE telegram_user_id=? AND subject_type='group' AND subject_key=? LIMIT 1;`).bind(auth.user.id,key).first();
  if(row)await env.DB.prepare(`DELETE FROM subscriptions WHERE subscription_id=? AND telegram_user_id=?;`).bind(row.subscription_id,auth.user.id).run();
  return json({ok:true,deleted:row?.subscription_id||null});
}

async function getPreferences(request,env,id){
  const auth=await centerTelegramAuth(request,env,true);if(!auth.ok)return json({ok:false,error:auth.error},401);
  const sub=await ownedSubscription(env.DB,id,auth.user.id);if(!sub)return json({ok:false,error:"subscription_not_found"},404);
  await ensurePreference(env.DB,id,sub.subject_type);
  const p=await env.DB.prepare(`SELECT * FROM subscription_preferences WHERE subscription_id=? LIMIT 1;`).bind(id).first();
  return json({ok:true,subscription:sub,preferences:p||defaults(sub.subject_type)});
}

async function putPreferences(request,env,id){
  const auth=await centerTelegramAuth(request,env,true);if(!auth.ok)return json({ok:false,error:auth.error},401);
  const sub=await ownedSubscription(env.DB,id,auth.user.id);if(!sub)return json({ok:false,error:"subscription_not_found"},404);
  let body={};try{body=await request.json()}catch{return json({ok:false,error:"invalid_json"},400)}
  const p=sanitize(body,sub.subject_type);
  await env.DB.prepare(`
    INSERT INTO subscription_preferences (subscription_id,notify_pregame,notify_start,notify_goal,notify_assist,notify_point,notify_period_end,notify_final,notify_odds,notify_trends,notify_lineup,notify_injury,notify_daily_digest,quiet_hours_start,quiet_hours_end,max_pushes_per_day,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(subscription_id) DO UPDATE SET notify_pregame=excluded.notify_pregame,notify_start=excluded.notify_start,notify_goal=excluded.notify_goal,notify_assist=excluded.notify_assist,notify_point=excluded.notify_point,notify_period_end=excluded.notify_period_end,notify_final=excluded.notify_final,notify_odds=excluded.notify_odds,notify_trends=excluded.notify_trends,notify_lineup=excluded.notify_lineup,notify_injury=excluded.notify_injury,notify_daily_digest=excluded.notify_daily_digest,quiet_hours_start=excluded.quiet_hours_start,quiet_hours_end=excluded.quiet_hours_end,max_pushes_per_day=excluded.max_pushes_per_day,updated_at=CURRENT_TIMESTAMP;
  `).bind(id,p.notify_pregame,p.notify_start,p.notify_goal,p.notify_assist,p.notify_point,p.notify_period_end,p.notify_final,p.notify_odds,p.notify_trends,p.notify_lineup,p.notify_injury,p.notify_daily_digest,p.quiet_hours_start,p.quiet_hours_end,p.max_pushes_per_day).run();
  return json({ok:true,subscription:sub,preferences:p});
}

async function ensurePreference(db,id,type){const d=defaults(type);await db.prepare(`INSERT OR IGNORE INTO subscription_preferences (subscription_id,notify_pregame,notify_start,notify_goal,notify_assist,notify_point,notify_period_end,notify_final,notify_odds,notify_trends,notify_lineup,notify_injury,notify_daily_digest,max_pushes_per_day) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?);`).bind(id,d.notify_pregame,d.notify_start,d.notify_goal,d.notify_assist,d.notify_point,d.notify_period_end,d.notify_final,d.notify_odds,d.notify_trends,d.notify_lineup,d.notify_injury,d.notify_daily_digest,d.max_pushes_per_day).run()}
function defaults(type){const player=type==="player",group=type==="group";return {notify_pregame:1,notify_start:0,notify_goal:1,notify_assist:0,notify_point:player?1:0,notify_period_end:0,notify_final:1,notify_odds:0,notify_trends:0,notify_lineup:0,notify_injury:player?1:0,notify_daily_digest:group?1:0,quiet_hours_start:null,quiet_hours_end:null,max_pushes_per_day:group?6:12}}
function sanitize(b,type){const d=defaults(type),o={};for(const k of ["notify_pregame","notify_start","notify_goal","notify_assist","notify_point","notify_period_end","notify_final","notify_odds","notify_trends","notify_lineup","notify_injury","notify_daily_digest"])o[k]=b[k]===undefined?d[k]:(b[k]?1:0);o.quiet_hours_start=time(b.quiet_hours_start)?String(b.quiet_hours_start):null;o.quiet_hours_end=time(b.quiet_hours_end)?String(b.quiet_hours_end):null;o.max_pushes_per_day=Math.max(1,Math.min(50,Number(b.max_pushes_per_day)||d.max_pushes_per_day));return o}
function time(v){return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v||""))}
async function ownedSubscription(db,id,user){return db.prepare(`SELECT subscription_id,subject_type,subject_key FROM subscriptions WHERE subscription_id=? AND telegram_user_id=? LIMIT 1;`).bind(id,user).first()}
async function upsertUser(db,u){await db.prepare(`INSERT INTO telegram_users (telegram_user_id,username,first_name,last_name,language_code,notifications_enabled,updated_at) VALUES (?,?,?,?,?,1,CURRENT_TIMESTAMP) ON CONFLICT(telegram_user_id) DO UPDATE SET username=excluded.username,first_name=excluded.first_name,last_name=excluded.last_name,language_code=excluded.language_code,updated_at=CURRENT_TIMESTAMP;`).bind(u.id,u.username,u.first_name,u.last_name,u.language_code).run()}
async function centerTelegramAuth(request,env,required){const initData=String(request.headers.get("x-telegram-init-data")||"").trim();if(!initData)return required?{ok:false,error:"missing_telegram_init_data"}:{ok:false,error:"guest"};const token=String(env.TELEGRAM_CENTER_BOT_TOKEN||"").trim();if(!token)return {ok:false,error:"missing_telegram_center_token"};try{const p=new URLSearchParams(initData),provided=p.get("hash")||"",date=Number(p.get("auth_date")||0),userRaw=p.get("user")||"";p.delete("hash");if(!provided||!date||!userRaw)return {ok:false,error:"invalid_telegram_init_data"};if(Math.abs(Math.floor(Date.now()/1000)-date)>604800)return {ok:false,error:"telegram_init_data_expired"};const check=[...p.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join("\n"),enc=new TextEncoder();const k1=await crypto.subtle.importKey("raw",enc.encode("WebAppData"),{name:"HMAC",hash:"SHA-256"},false,["sign"]),secret=await crypto.subtle.sign("HMAC",k1,enc.encode(token)),k2=await crypto.subtle.importKey("raw",secret,{name:"HMAC",hash:"SHA-256"},false,["sign"]),digest=await crypto.subtle.sign("HMAC",k2,enc.encode(check)),calc=hex(new Uint8Array(digest));if(!(await secureEq(calc,provided.toLowerCase())))return {ok:false,error:"telegram_signature_invalid"};const u=JSON.parse(userRaw),id=Number(u.id);if(!Number.isSafeInteger(id)||id<=0)return {ok:false,error:"telegram_user_invalid"};return {ok:true,user:{id,username:u.username||null,first_name:u.first_name||null,last_name:u.last_name||null,language_code:u.language_code||null}}}catch{return {ok:false,error:"telegram_init_data_invalid"}}}
function hex(bytes){return [...bytes].map(x=>x.toString(16).padStart(2,"0")).join("")}
async function secureEq(a,b){const e=new TextEncoder(),[x,y]=await Promise.all([crypto.subtle.digest("SHA-256",e.encode(String(a))),crypto.subtle.digest("SHA-256",e.encode(String(b)))]),aa=new Uint8Array(x),bb=new Uint8Array(y);let d=aa.length^bb.length;for(let i=0;i<Math.min(aa.length,bb.length);i++)d|=aa[i]^bb[i];return d===0}
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}})}

const SCRIPT=String.raw`(function(){
'use strict';
const tg=window.Telegram&&window.Telegram.WebApp?window.Telegram.WebApp:null,initData=tg&&tg.initData?tg.initData:'';
const V2='/api/telegram-center-v2',V3='/api/telegram-center-v3',V4='/api/telegram-center-v4';
const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(u,o){o=o||{};const h=Object.assign({},o.headers||{});if(initData)h['X-Telegram-Init-Data']=initData;if(o.body)h['Content-Type']='application/json';const r=await fetch(u,Object.assign({},o,{headers:h,cache:'no-store'})),d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||('HTTP '+r.status));return d}
function css(){if(document.getElementById('centerSubV4Css'))return;const s=document.createElement('style');s.id='centerSubV4Css';s.textContent='.v4setup{position:fixed;inset:0;background:#08080af2;z-index:10050;overflow:auto;padding:14px}.v4card{max-width:620px;margin:auto;background:#0d0d0f;border:1px solid #303038;border-radius:18px;padding:14px}.v4top{display:flex;align-items:center;justify-content:space-between}.v4top h2{font-size:18px;margin:0}.v4preset{display:grid;grid-template-columns:1fr;gap:7px;margin:12px 0}.v4preset button{border:1px solid #33343c;background:#151517;color:#fff;border-radius:11px;padding:11px;text-align:left}.v4preset button b{display:block}.v4preset button small{color:#85858e}.v4prefs{display:grid;gap:6px}.v4pref{display:flex;justify-content:space-between;align-items:center;border:1px solid #29292f;background:#141416;border-radius:10px;padding:9px}.v4save{width:100%;margin-top:12px;background:#28170f;border:1px solid #71422d;color:#ff946c;border-radius:11px;padding:11px;font-weight:900}.v4suggest{border-top:1px solid #24242a;margin-top:15px;padding-top:10px}.v4suggest button{width:100%;margin:5px 0;border:1px solid #303038;background:#151517;color:#fff;border-radius:10px;padding:9px;text-align:left}.v4bundle{border-color:#6c5522!important;color:#e7bd55!important}' ;document.head.appendChild(s)}
const PREFS=[['notify_pregame','До матча'],['notify_start','Старт матча'],['notify_goal','Голы'],['notify_assist','Передачи'],['notify_point','Очки игрока'],['notify_final','Финальный счёт'],['notify_odds','Изменения коэффициентов'],['notify_trends','Тенденции / ставки'],['notify_lineup','Состав'],['notify_injury','Травмы / статус'],['notify_daily_digest','Один дайджест в день']];
const PRESETS={important:{notify_pregame:1,notify_start:0,notify_goal:1,notify_assist:0,notify_point:0,notify_final:1,notify_odds:0,notify_trends:0,notify_lineup:0,notify_injury:1,notify_daily_digest:0,max_pushes_per_day:5},match:{notify_pregame:1,notify_start:1,notify_goal:1,notify_assist:1,notify_point:1,notify_final:1,notify_odds:0,notify_trends:0,notify_lineup:0,notify_injury:1,notify_daily_digest:0,max_pushes_per_day:15},analytics:{notify_pregame:1,notify_start:0,notify_goal:0,notify_assist:0,notify_point:0,notify_final:1,notify_odds:1,notify_trends:1,notify_lineup:1,notify_injury:1,notify_daily_digest:0,max_pushes_per_day:6}};
let current=null;
function modal(html){document.getElementById('v4setup')?.remove();const d=document.createElement('div');d.id='v4setup';d.className='v4setup';d.innerHTML='<div class="v4card">'+html+'</div>';document.body.appendChild(d)}
function close(){document.getElementById('v4setup')?.remove();current=null}
function prefHtml(p){return PREFS.map(([k,l])=>'<label class="v4pref"><span>'+esc(l)+'</span><input type="checkbox" data-v4-pref="'+k+'" '+(p?.[k]?'checked':'')+'></label>').join('')+'<label class="v4pref"><span>Максимум пушей в день</span><input type="number" min="1" max="50" value="'+esc(p?.max_pushes_per_day||12)+'" data-v4-max style="width:56px"></label>'}
function applyPreset(name){const p=PRESETS[name];document.querySelectorAll('[data-v4-pref]').forEach(x=>x.checked=Boolean(p[x.dataset.v4Pref]));const m=document.querySelector('[data-v4-max]');if(m)m.value=p.max_pushes_per_day}
async function setup(sub,type,key,isNew){current={sub,type,key};const prefs=(await api(V4+'/subscriptions/'+sub.subscription_id+'/preferences')).preferences;modal('<div class="v4top"><h2>'+(isNew?'Подписка оформлена':'Настройки подписки')+'</h2><button class="v2close" data-v4-close>×</button></div><div class="v2muted">Выбери, что действительно нужно присылать. Для массовых подписок лучше «Только важное» или дайджест.</div><div class="v4preset"><button data-v4-preset="important"><b>Только важное</b><small>до матча · голы · итог · важный статус</small></button><button data-v4-preset="match"><b>Матч целиком</b><small>старт · голы · очки · итог</small></button><button data-v4-preset="analytics"><b>Аналитика и коэффициенты</b><small>линия · тенденции · состав · итог</small></button></div><div class="v4prefs">'+prefHtml(prefs)+'</div><button class="v4save" data-v4-save>Сохранить настройки</button><div class="v4suggest" id="v4suggest"></div>');if(isNew&&type==='player')loadSuggestions(key)}
async function loadSuggestions(key){try{const d=await api(V3+'/suggestions/player/'+encodeURIComponent(key)),box=document.getElementById('v4suggest');if(!box)return;let h='';if((d.related||[]).length)h+='<div class="v2h">Ещё можно добавить</div>'+d.related.map(p=>'<button data-v4-related="'+p.player_id+'"><b>'+esc(p.full_name_ru||p.full_name_en)+'</b><small>'+esc(p.current_team_tri||'NHL')+'</small></button>').join('');h+=(d.groups||[]).map(g=>'<button class="v4bundle" data-v4-group="'+esc(g.group_key)+'"><b>'+esc(g.title_ru)+'</b><small>'+esc(g.description_ru||'')+'</small></button>').join('');box.innerHTML=h}catch(_){}}
async function save(){if(!current)return;const body={};document.querySelectorAll('[data-v4-pref]').forEach(x=>body[x.dataset.v4Pref]=x.checked);body.max_pushes_per_day=Number(document.querySelector('[data-v4-max]')?.value||12);await api(V4+'/subscriptions/'+current.sub.subscription_id+'/preferences',{method:'PUT',body:JSON.stringify(body)});close()}
async function subscribeRelated(id){const d=await api(V2+'/subscriptions',{method:'POST',body:JSON.stringify({type:'player',key:String(id)})});alert('Игрок добавлен. Настройки можно изменить в «Мои».');return d}
async function subscribeGroup(key){const d=await api(V4+'/groups/'+encodeURIComponent(key)+'/subscribe',{method:'POST'});alert('Пакет «Все россияне в НХЛ» добавлен. По умолчанию включён компактный режим уведомлений.');return d}
async function intercept(btn){if(!initData){alert('Подписки доступны при открытии из Telegram-бота');return}const id=Number(btn.dataset.v2Subid||0),type=btn.dataset.v2Subtype,key=btn.dataset.v2Key;if(id){await setup({subscription_id:id},type,key,false);return}btn.disabled=true;try{const d=await api(V2+'/subscriptions',{method:'POST',body:JSON.stringify({type,key})});const sub=d.subscription;btn.dataset.v2Subid=sub.subscription_id;btn.classList.add('on');btn.textContent='✓ Вы подписаны';await setup(sub,type,key,true)}catch(e){alert('Ошибка подписки: '+e.message)}finally{btn.disabled=false}}
document.addEventListener('click',e=>{const btn=e.target.closest('[data-v2-subtype]');if(btn){e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();intercept(btn);return}const c=e.target.closest('[data-v4-close]');if(c){close();return}const p=e.target.closest('[data-v4-preset]');if(p){applyPreset(p.dataset.v4Preset);return}const s=e.target.closest('[data-v4-save]');if(s){s.disabled=true;save().catch(x=>{s.disabled=false;alert(x.message)});return}const r=e.target.closest('[data-v4-related]');if(r){r.disabled=true;subscribeRelated(Number(r.dataset.v4Related)).then(()=>r.textContent='✓ Добавлен').catch(x=>{r.disabled=false;alert(x.message)});return}const g=e.target.closest('[data-v4-group]');if(g){g.disabled=true;subscribeGroup(g.dataset.v4Group).then(()=>g.textContent='✓ Пакет добавлен').catch(x=>{g.disabled=false;alert(x.message)});return}},true);
css();
})();`;
