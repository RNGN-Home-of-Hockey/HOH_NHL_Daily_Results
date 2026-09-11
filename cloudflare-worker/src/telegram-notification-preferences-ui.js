export function handleTelegramNotificationPreferencesUi(request, path) {
  if (path !== "/telegram-app/preferences.js") return null;
  if (request.method !== "GET") return json({ok:false,error:"method_not_allowed"},405);
  return js(`(${notificationPreferencesEnhancer.toString()})();`);
}

function notificationPreferencesEnhancer(){
  const tg=window.Telegram?.WebApp||null;
  const initData=tg?.initData||'';
  let subject=null;
  const labels=[
    ['notify_pregame','До матча'],['notify_start','Старт матча'],['notify_goal','Голы'],
    ['notify_assist','Передачи игрока'],['notify_period_end','Конец периода'],['notify_final','Финал'],
  ];

  async function api(url,opts={}){
    const headers={...(opts.headers||{})};
    if(initData)headers['X-Telegram-Init-Data']=initData;
    if(opts.body&&!headers['Content-Type'])headers['Content-Type']='application/json';
    const response=await fetch(url,{...opts,headers,cache:'no-store'});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data.error||('HTTP '+response.status));
    return data;
  }

  function captureSubject(target){
    const f=target.closest?.('[data-ftype]');
    if(f){subject={type:String(f.dataset.ftype||''),key:String(f.dataset.fkey||'')};return}
    const g=target.closest?.('[data-game]');
    if(g){subject={type:'game',key:String(g.dataset.game||'')};return}
    const t=target.closest?.('[data-team]');
    if(t){subject={type:'team',key:String(t.dataset.team||'')};return}
    const p=target.closest?.('[data-player]');
    if(p){subject={type:'player',key:String(p.dataset.player||'')};}
  }

  function enhanceSheet(){
    if(!subject||!initData)return;
    const sheet=document.querySelector('#sheet');
    if(!sheet||sheet.querySelector('#notifyPrefs'))return;
    const active=sheet.querySelector('#followAction.on,#gameFollowAction.on');
    if(!active)return;
    const button=document.createElement('button');
    button.id='notifyPrefs';button.className='notifyPrefs';button.textContent='⚙ Настроить уведомления';
    button.onclick=()=>openPreferences();
    active.insertAdjacentElement('afterend',button);
  }

  async function openPreferences(){
    if(!subject||!initData)return;
    try{
      const d=await api('/api/telegram-app/follows');
      const follow=(d.follows||[]).find(f=>f.subject_type===subject.type&&String(f.subject_key)===String(subject.key));
      if(!follow){tg?.showAlert?.('Сначала включите подписку.');return}
      const wrap=document.createElement('div');
      wrap.id='notifyPrefOverlay';wrap.className='notifyPrefOverlay';
      const rows=labels.filter(([key])=>subject.type==='player'||key!=='notify_assist').map(([key,label])=>`<label><span>${label}</span><input type="checkbox" data-flag="${key}" ${Number(follow[key])===1?'checked':''}></label>`).join('');
      wrap.innerHTML=`<div class="notifyPrefCard"><button class="notifyPrefClose" id="notifyPrefClose">×</button><div class="notifyPrefEyebrow">${subject.type.toUpperCase()} · ${escapeHtml(subject.key)}</div><h3>Уведомления</h3><div class="notifyPrefRows">${rows}</div><button class="notifyPrefSave" id="notifyPrefSave">Сохранить</button></div>`;
      document.body.appendChild(wrap);
      wrap.onclick=e=>{if(e.target===wrap)wrap.remove()};
      wrap.querySelector('#notifyPrefClose').onclick=()=>wrap.remove();
      wrap.querySelector('#notifyPrefSave').onclick=()=>savePreferences(wrap,follow);
    }catch(e){tg?.showAlert?.('Не удалось загрузить настройки: '+e.message)}
  }

  async function savePreferences(wrap,follow){
    const body={subject_type:subject.type,subject_key:subject.key};
    for(const [key] of labels){
      const input=wrap.querySelector(`[data-flag="${key}"]`);
      body[key]=input?input.checked:Boolean(Number(follow[key]||0));
    }
    const button=wrap.querySelector('#notifyPrefSave');button.disabled=true;button.textContent='Сохраняю…';
    try{
      await api('/api/telegram-app/follows',{method:'POST',body:JSON.stringify(body)});
      tg?.HapticFeedback?.notificationOccurred?.('success');
      wrap.remove();
    }catch(e){button.disabled=false;button.textContent='Сохранить';tg?.showAlert?.('Не удалось сохранить: '+e.message)}
  }

  function escapeHtml(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}

  document.addEventListener('click',e=>{captureSubject(e.target);setTimeout(enhanceSheet,0)},true);
  const observer=new MutationObserver(enhanceSheet);
  observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});
  const style=document.createElement('style');
  style.textContent='.notifyPrefs{display:block;width:100%;margin:7px 0 14px;border:1px solid #34343b;background:#151518;color:#aaa;border-radius:11px;padding:10px;font-weight:800;font-size:10px}.notifyPrefOverlay{position:fixed;inset:0;background:rgba(0,0,0,.78);z-index:90;display:grid;align-items:end}.notifyPrefCard{background:#111114;border:1px solid #303038;border-radius:20px 20px 0 0;padding:20px 16px calc(22px + env(safe-area-inset-bottom));max-width:720px;width:100%;margin:0 auto}.notifyPrefClose{float:right;border:1px solid #34343b;background:#19191d;color:#aaa;border-radius:9px;width:34px;height:34px}.notifyPrefEyebrow{font-size:8px;color:#c8b7ff;letter-spacing:.1em}.notifyPrefCard h3{font-size:22px;margin:7px 0 16px}.notifyPrefRows label{display:flex;align-items:center;justify-content:space-between;padding:12px 2px;border-bottom:1px solid #29292f;font-size:12px}.notifyPrefRows input{width:20px;height:20px;accent-color:#ff5a1f}.notifyPrefSave{width:100%;margin-top:17px;border:0;background:#ff5a1f;color:#111;border-radius:12px;padding:13px;font-weight:950}';
  document.head.appendChild(style);
}

function js(body){return new Response(body,{headers:{"Content-Type":"application/javascript; charset=utf-8","Cache-Control":"public, max-age=120","X-Content-Type-Options":"nosniff"}})}
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}})}
