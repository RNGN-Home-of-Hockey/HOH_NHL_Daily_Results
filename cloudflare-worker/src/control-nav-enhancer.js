export function handleControlNavEnhancer(request,path){
  if(path!=="/control/nav.js")return null;
  if(request.method!=="GET")return json({ok:false,error:"method_not_allowed"},405);
  return js(`(${enhanceControlNav.toString()})();`);
}

function enhanceControlNav(){
  function inject(){
    const actions=document.querySelector('.heroActions');
    if(!actions||actions.querySelector('[data-hoh-extra]'))return;
    for(const [href,label] of [['/matchup','Matchup Lab'],['/broadcast/operator','Broadcast Operator'],['/broadcast/overlay','Overlay']]){
      const a=document.createElement('a');a.href=href;a.textContent=label;a.dataset.hohExtra='1';if(href==='/broadcast/overlay')a.target='_blank';actions.appendChild(a);
    }
  }
  function enhanceRows(){
    document.querySelectorAll('a.row[href^="/broadcast?game="]').forEach(row=>{
      if(row.dataset.hohMatchup)return;row.dataset.hohMatchup='1';
      const game=new URL(row.href,location.href).searchParams.get('game');if(!game)return;
      row.title='Открыть Broadcast. Matchup Lab доступен через меню сверху.';
    });
  }
  const observer=new MutationObserver(()=>{inject();enhanceRows()});
  observer.observe(document.body,{childList:true,subtree:true});
  inject();enhanceRows();
}

function js(body){return new Response(body,{headers:{"Content-Type":"application/javascript; charset=utf-8","Cache-Control":"public, max-age=300","X-Content-Type-Options":"nosniff"}})}
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}})}
