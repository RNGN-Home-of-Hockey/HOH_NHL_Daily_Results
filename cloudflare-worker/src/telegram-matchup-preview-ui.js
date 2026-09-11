export function handleTelegramMatchupPreviewUi(request, path) {
  if (path !== "/telegram-app/matchup.js") return null;
  if (request.method !== "GET") return json({ok:false,error:"method_not_allowed"},405);
  return js(`(${telegramMatchupPreview.toString()})();`);
}

function telegramMatchupPreview(){
  let selectedGame=null;
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const pct=v=>Number.isFinite(Number(v))?Math.round(Number(v)*100)+'%':'—';

  async function api(url){
    const r=await fetch(url,{cache:'no-store'});
    const d=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(d.error||('HTTP '+r.status));
    return d;
  }

  function inject(){
    const sheet=document.querySelector('#sheet');
    if(!sheet||!selectedGame||!sheet.querySelector('h2')||sheet.querySelector('#matchupPreviewAction'))return;
    const button=document.createElement('button');
    button.id='matchupPreviewAction';button.className='matchupPreviewAction';button.textContent='📊 Аналитика матча';
    const anchor=sheet.querySelector('#notifyPrefs')||sheet.querySelector('#gameFollowAction')||sheet.querySelector('#followAction')||sheet.querySelector('h2');
    anchor.insertAdjacentElement('afterend',button);
    button.onclick=()=>loadPreview(sheet,button,selectedGame);
  }

  async function loadPreview(sheet,button,gamePk){
    button.disabled=true;button.textContent='Считаю…';
    let box=sheet.querySelector('#matchupPreviewBox');
    if(!box){box=document.createElement('div');box.id='matchupPreviewBox';box.className='matchupPreviewBox';button.insertAdjacentElement('afterend',box)}
    box.innerHTML='<div class="mpEmpty">Загружаю 20-матчевый контекст…</div>';
    try{
      const d=await api('/api/matchup/'+gamePk+'?window=20&min_confidence=20');
      const team=(d.top_markets||[]).slice(0,6);
      const players=(d.player_markets||[]).slice(0,5);
      box.innerHTML=`<div class="mpHead"><b>Market Lab · 20</b><span>${esc(String(d.snapshot_source||'').toUpperCase())}</span></div><div class="mpRows">${team.map(m=>`<div><span>${esc(m.label)}<small>${esc(m.market_type)}</small></span><b>${pct(m.combined_rate)}</b></div>`).join('')||'<div class="mpEmpty">Нет сигналов с confidence ≥20</div>'}</div>${players.length?`<div class="mpHead second"><b>Игроки</b></div><div class="mpRows">${players.map(c=>`<div><span>${esc(c.market?.label||c.title)}<small>${esc(c.value||'')}</small></span><b>${Math.round(Number(c.score||0))}</b></div>`).join('')}</div>`:''}<a class="mpFull" href="/matchup?game=${encodeURIComponent(gamePk)}">Открыть полный Matchup Lab →</a>`;
      button.textContent='📊 Аналитика матча';
    }catch(e){box.innerHTML='<div class="mpEmpty">Аналитика будет доступна после compact sync: '+esc(e.message)+'</div>';button.textContent='📊 Аналитика матча'}finally{button.disabled=false}
  }

  document.addEventListener('click',e=>{
    const g=e.target.closest?.('[data-game]');if(g){selectedGame=Number(g.dataset.game);setTimeout(inject,0)}
    const f=e.target.closest?.('[data-ftype="game"]');if(f){selectedGame=Number(f.dataset.fkey);setTimeout(inject,80)}
  },true);
  const observer=new MutationObserver(inject);
  const sheet=document.querySelector('#sheet');if(sheet)observer.observe(sheet,{childList:true,subtree:true});
  const style=document.createElement('style');
  style.textContent='.matchupPreviewAction{display:block;width:100%;margin:7px 0;border:1px solid #34343b;background:#17171a;color:#c8b7ff;border-radius:11px;padding:10px;font-weight:900;font-size:10px}.matchupPreviewBox{margin:8px 0 14px;border:1px solid #2d2d33;border-radius:12px;padding:10px;background:#101012}.mpHead{display:flex;justify-content:space-between;align-items:center;font-size:9px;color:#c8b7ff;letter-spacing:.06em;text-transform:uppercase;margin-bottom:5px}.mpHead.second{margin-top:12px}.mpRows>div{display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid #25252b;font-size:10px}.mpRows span{display:flex;flex-direction:column}.mpRows small{font-size:7px;color:#6d6d75;margin-top:2px}.mpRows b{color:#79dea9}.mpEmpty{padding:10px;color:#73737c;text-align:center;font-size:9px}.mpFull{display:block;margin-top:10px;color:#c8b7ff;text-decoration:none;font-size:9px;font-weight:800}';
  document.head.appendChild(style);
}

function js(body){return new Response(body,{headers:{"Content-Type":"application/javascript; charset=utf-8","Cache-Control":"public, max-age=120","X-Content-Type-Options":"nosniff"}})}
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}})}
