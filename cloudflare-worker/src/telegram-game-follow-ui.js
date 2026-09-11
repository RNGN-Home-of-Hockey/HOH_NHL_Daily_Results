export function handleTelegramGameFollowUi(request, path) {
  if (path !== "/telegram-app/game-follow.js") return null;
  if (request.method !== "GET") return json({ok:false,error:"method_not_allowed"},405);
  return js(`(${gameFollowEnhancer.toString()})();`);
}

function gameFollowEnhancer(){
  const tg=window.Telegram?.WebApp||null;
  const initData=tg?.initData||'';
  let follows=[];
  let selectedGame=null;
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  async function api(url,opts={}){
    const headers={...(opts.headers||{})};
    if(initData)headers['X-Telegram-Init-Data']=initData;
    if(opts.body&&!headers['Content-Type'])headers['Content-Type']='application/json';
    const response=await fetch(url,{...opts,headers,cache:'no-store'});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data.error||('HTTP '+response.status));
    return data;
  }

  async function refreshFollows(){
    try{const d=await api('/api/telegram-app/bootstrap');follows=d.follows||[]}catch{follows=[]}
  }
  function isFollowed(gamePk){return follows.some(f=>f.subject_type==='game'&&String(f.subject_key)===String(gamePk))}

  async function toggle(gamePk,button){
    if(!initData){tg?.showAlert?.('Откройте приложение из Telegram-бота, чтобы подписываться на матч.');return}
    const remove=isFollowed(gamePk);
    button.disabled=true;
    try{
      const d=await api('/api/telegram-app/follows',{method:remove?'DELETE':'POST',body:JSON.stringify({
        subject_type:'game',subject_key:String(gamePk),notify_pregame:true,notify_start:true,
        notify_goal:true,notify_assist:false,notify_period_end:true,notify_final:true,
      })});
      follows=d.follows||[];
      paint(button,gamePk);
    }catch(e){tg?.showAlert?.('Не удалось изменить подписку на матч: '+e.message)}finally{button.disabled=false}
  }

  function paint(button,gamePk){
    const on=isFollowed(gamePk);
    button.classList.toggle('on',on);
    button.textContent=on?'✓ Матч в «Моих»':'＋ Следить за матчем';
  }

  function injectButton(){
    const sheet=document.querySelector('#sheet');
    if(!sheet||!selectedGame||!sheet.querySelector('h2')||sheet.querySelector('#gameFollowAction'))return;
    const button=document.createElement('button');
    button.id='gameFollowAction';button.className='follow';button.style.margin='14px 0 4px';
    paint(button,selectedGame);
    button.onclick=()=>toggle(selectedGame,button);
    const h2=sheet.querySelector('h2');h2.insertAdjacentElement('afterend',button);
  }

  async function openFollowedGame(gamePk){
    const overlay=document.querySelector('#overlay'),sheet=document.querySelector('#sheet');
    if(!overlay||!sheet)return;
    selectedGame=Number(gamePk);overlay.classList.add('open');sheet.innerHTML='<div class="empty">Загружаю матч…</div>';
    try{
      const d=await api('/api/telegram-app/games/'+gamePk),g=d.game;
      sheet.innerHTML=`<button class="close" id="gfClose">×</button><div class="eyebrow">МАТЧ #${esc(gamePk)}</div><h2>${esc(g.away.tri)} ${score(g.away.score)} — ${score(g.home.score)} ${esc(g.home.tri)}</h2><p class="gfMeta">${esc(g.away.name||g.away.tri)} · ${esc(g.home.name||g.home.tri)}</p><button class="follow" id="gameFollowAction"></button><div class="metric2"><div><b>${score(g.away.shots)}</b><span>броски ${esc(g.away.tri)}</span></div><div><b>${score(g.home.shots)}</b><span>броски ${esc(g.home.tri)}</span></div></div>`;
      const b=sheet.querySelector('#gameFollowAction');paint(b,gamePk);b.onclick=()=>toggle(gamePk,b);
      sheet.querySelector('#gfClose').onclick=()=>overlay.classList.remove('open');
    }catch(e){sheet.innerHTML=`<button class="close" id="gfClose">×</button><div class="empty">${esc(e.message)}</div>`;sheet.querySelector('#gfClose').onclick=()=>overlay.classList.remove('open')}
  }
  function score(v){return v===null||v===undefined?'—':v}

  document.addEventListener('click',e=>{
    const game=e.target.closest?.('[data-game]');
    if(game){selectedGame=Number(game.dataset.game);setTimeout(injectButton,0)}
    const followed=e.target.closest?.('[data-ftype="game"]');
    if(followed){e.preventDefault();e.stopImmediatePropagation();openFollowedGame(followed.dataset.fkey)}
  },true);

  const observer=new MutationObserver(()=>injectButton());
  const sheet=document.querySelector('#sheet');if(sheet)observer.observe(sheet,{childList:true,subtree:true});
  const style=document.createElement('style');style.textContent='.gfMeta{font-size:10px;color:#777;margin:4px 0 12px}';document.head.appendChild(style);
  refreshFollows();
}

function js(body){return new Response(body,{headers:{"Content-Type":"application/javascript; charset=utf-8","Cache-Control":"public, max-age=120","X-Content-Type-Options":"nosniff"}})}
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}})}
