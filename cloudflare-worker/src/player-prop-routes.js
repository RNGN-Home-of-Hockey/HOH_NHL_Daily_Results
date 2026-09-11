import { buildPlayerPropMarketInsights } from "./player-prop-market-insights.js";

const NHL_BASE="https://api-web.nhle.com/v1";

export async function handlePlayerPropRequest(request,env,path){
  if(path==="/matchup/player-props.js"){
    if(request.method!=="GET")return json({ok:false,error:"method_not_allowed"},405);
    return js(`(${matchupPlayerPropsEnhancer.toString()})();`);
  }
  const match=/^\/api\/player-props\/(\d+)$/.exec(path);
  if(!match)return null;
  if(request.method!=="GET")return json({ok:false,error:"method_not_allowed"},405);
  if(!env.DB)return json({ok:false,error:"missing_d1_binding"},503);
  const gamePk=Number(match[1]);
  if(!Number.isSafeInteger(gamePk)||gamePk<=0)return json({ok:false,error:"invalid_game_pk"},400);
  try{
    const box=await fetchNhl(`${NHL_BASE}/gamecenter/${gamePk}/boxscore`);
    const game={
      game_pk:gamePk,
      scheduled_start_utc:box?.startTimeUTC||null,
      away_tri:String(box?.awayTeam?.abbrev||"").toUpperCase(),
      home_tri:String(box?.homeTeam?.abbrev||"").toUpperCase(),
    };
    if(!game.scheduled_start_utc||!game.away_tri||!game.home_tri)return json({ok:false,error:"game_context_missing"},502);
    const cards=await buildPlayerPropMarketInsights(env.DB,game);
    return json({ok:true,game,cards,quota_profile:"two_compact_player_queries",feature_layer:"player_market_snapshots_v1"});
  }catch(error){
    console.error("player prop route failed",gamePk,error);
    return json({ok:false,error:"player_prop_layer_not_ready",cards:[]},503);
  }
}

async function fetchNhl(url){const r=await fetch(url,{headers:{Accept:"application/json"}});if(!r.ok)throw new Error(`NHL HTTP ${r.status}`);return r.json()}

function matchupPlayerPropsEnhancer(){
  const game=new URLSearchParams(location.search).get('game')||'';
  if(!/^\d+$/.test(game))return;
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let loading=false,done=false;
  async function inject(){
    if(done||loading)return;
    const main=document.querySelector('#content');
    if(!main||!main.querySelector('.hero'))return;
    loading=true;
    try{
      const r=await fetch('/api/player-props/'+game,{cache:'no-store'}),d=await r.json().catch(()=>({}));
      if(!r.ok||!d.ok){loading=false;return}
      const cards=d.cards||[];
      const section=document.createElement('section');section.className='panel propPanel';
      section.innerHTML=`<h3>Player Props · ассисты / броски / хиты / блоки</h3><div class="propGrid">${cards.map(c=>`<div class="prop"><span><b>${esc(c.market?.label||c.title)}</b><small>${esc(c.eyebrow||'')} · ${esc(c.value||'')}</small></span><strong>${Math.round(Number(c.score||0))}</strong></div>`).join('')||'<div class="empty small">Сильных player-prop сигналов нет</div>'}</div>`;
      const all=[...main.querySelectorAll('.panel')];
      const anchor=all.length>1?all[all.length-1]:main.lastElementChild;
      if(anchor)main.insertBefore(section,anchor);else main.appendChild(section);
      done=true;
    }catch{}finally{loading=false}
  }
  const style=document.createElement('style');style.textContent='.propGrid{display:grid;grid-template-columns:repeat(2,1fr);gap:7px}.prop{border:1px solid #29292f;border-radius:10px;padding:10px;display:flex;justify-content:space-between;align-items:center;gap:10px}.prop span{display:flex;flex-direction:column}.prop b{font-size:10px}.prop small{font-size:7px;color:#72727b;margin-top:3px}.prop strong{color:#79dea9}@media(max-width:760px){.propGrid{grid-template-columns:1fr}}';document.head.appendChild(style);
  const observer=new MutationObserver(inject);observer.observe(document.body,{childList:true,subtree:true});inject();
}

function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}})}
function js(body){return new Response(body,{headers:{"Content-Type":"application/javascript; charset=utf-8","Cache-Control":"public, max-age=180","X-Content-Type-Options":"nosniff"}})}
