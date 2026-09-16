import mediaCache from "../../state/hoh_youtube_media.json" with { type: "json" };

const JS_PATH = "/telegram-app/v12.js";
const API = "/api/telegram-center-v12";
const NHL = "https://api-web.nhle.com/v1";
const FALLBACK_SHORT_IDS = ["lE6HsW_lO3A","qpl6TBYZ6kk","PWS0j-pab8k","EdW_k6Yv60s","4Zqd87BfPk8","sgYGqUNa6Lc","OuZ48CZZe9M","4Z0U1rksbEA","dneld6G5cDc","C5vDDyYoQAw"];
const NEWS_ID = "mjDYO1uaw7E";

export async function handleTelegramCenterV12Polish(request,env,path){
  if(path===JS_PATH){
    if(request.method!=="GET")return json({ok:false,error:"method_not_allowed"},405);
    return new Response(V12_JS,{headers:{"Content-Type":"application/javascript; charset=utf-8","Cache-Control":"no-store, no-cache, must-revalidate","X-Content-Type-Options":"nosniff"}});
  }
  if(path===`${API}/media`&&request.method==="GET")return mediaResponse();
  const seasonsMatch=new RegExp(`^${API}/players/(\\d+)/seasons$`).exec(path);
  if(seasonsMatch&&request.method==="GET")return playerSeasons(Number(seasonsMatch[1]));
  const seasonMatch=new RegExp(`^${API}/players/(\\d+)/season/(20\\d{6})$`).exec(path);
  if(seasonMatch&&request.method==="GET")return playerSeasonDetail(Number(seasonMatch[1]),seasonMatch[2],env);
  return null;
}

function mediaResponse(){
  let shorts=Array.isArray(mediaCache?.shorts_top10)?mediaCache.shorts_top10.filter(validMedia):[];
  if(shorts.length<2)shorts=FALLBACK_SHORT_IDS.map(id=>({id,kind:"short",url:`https://www.youtube.com/shorts/${id}`,title:"HOME OF HOCKEY SHORTS",thumb:`https://i.ytimg.com/vi/${id}/hq720.jpg`}));
  const day=Math.floor(Date.now()/86400000),a=day%shorts.length,b=(day*7+3)%shorts.length;
  const picked=[shorts[a],shorts[b===a?(b+1)%shorts.length:b]];
  const news=validMedia(mediaCache?.news)?mediaCache.news:{id:NEWS_ID,kind:"news",url:`https://www.youtube.com/watch?v=${NEWS_ID}`,title:"HOME OF HOCKEY NEWS",thumb:`https://i.ytimg.com/vi/${NEWS_ID}/hq720.jpg`};
  return json({ok:true,configured:true,items:[...picked.map(x=>normalizeMedia(x,"short")),normalizeMedia(news,"news")],source:"repository_cache"});
}
function validMedia(x){return Boolean(x&&String(x.url||"").startsWith("https://www.youtube.com/")&&String(x.thumb||"").startsWith("https://"))}
function normalizeMedia(x,kind){return{kind,url:String(x.url||""),title:String(x.title|| (kind==="news"?"HOME OF HOCKEY NEWS":"HOME OF HOCKEY SHORTS")),thumb:String(x.thumb||"")}}

async function playerSeasons(playerId){
  if(!Number.isSafeInteger(playerId)||playerId<=0)return json({ok:false,error:"invalid_player_id"},400);
  try{
    const landing=await fetchNhl(`${NHL}/player/${playerId}/landing`);
    const totals=Array.isArray(landing?.seasonTotals)?landing.seasonTotals:[];
    const seasons=new Set();
    for(const row of totals){
      const season=String(row?.season||"").replace(/\D/g,"");
      const gameType=Number(row?.gameTypeId??row?.gameType??2);
      const league=String(row?.leagueAbbrev||row?.league||"NHL").toUpperCase();
      if(/^20\d{6}$/.test(season)&&gameType===2&&(!league||league==="NHL"))seasons.add(season);
    }
    seasons.add(currentSeasonId());
    const list=[...seasons].sort((a,b)=>Number(b)-Number(a)).map(season=>({season_id:season,label:seasonLabel(season),current:season===currentSeasonId()}));
    return json({ok:true,player_id:playerId,seasons:list});
  }catch(error){return json({ok:false,error:"player_seasons_failed",detail:errorText(error)},503)}
}

async function playerSeasonDetail(playerId,season,env){
  if(!Number.isSafeInteger(playerId)||playerId<=0)return json({ok:false,error:"invalid_player_id"},400);
  if(!/^20\d{6}$/.test(String(season)))return json({ok:false,error:"invalid_season"},400);
  try{
    let dbPlayer=null;
    if(env?.DB){
      dbPlayer=await env.DB.prepare(`SELECT p.player_id,p.full_name_en,p.full_name_ru,p.current_team_tri,p.position_code,p.sweater_number,m.primary_country_code,m.birth_date FROM players p LEFT JOIN player_profile_meta m ON m.player_id=p.player_id WHERE p.player_id=? LIMIT 1;`).bind(playerId).first().catch(()=>null);
    }
    const [landing,gameLog]=await Promise.all([
      fetchNhl(`${NHL}/player/${playerId}/landing`).catch(()=>null),
      fetchNhl(`${NHL}/player/${playerId}/game-log/${season}/2`).catch(()=>null),
    ]);
    if(!landing&&!dbPlayer)return json({ok:false,error:"player_not_found"},404);
    const rows=Array.isArray(gameLog?.gameLog)?gameLog.gameLog:Array.isArray(gameLog?.games)?gameLog.games:[];
    const position=upper(dbPlayer?.position_code||landing?.position||"");
    const stats=aggregateSkater(rows);
    const historicalTeam=teamFromGameLog(rows)||upper(landing?.currentTeamAbbrev||dbPlayer?.current_team_tri||"");
    const [teamRanks,leagueRanks]=await Promise.all([
      skaterTeamRanks(playerId,historicalTeam,season).catch(()=>emptyRanks()),
      skaterLeagueRanks(playerId,season).catch(()=>emptyRanks()),
    ]);
    return json({
      ok:true,player_id:playerId,season,season_label:seasonLabel(season),team_tri:historicalTeam||null,position_code:position||null,
      stats,ranks:{team:teamRanks,league:leagueRanks},source:"nhl_web_api",updated_at:new Date().toISOString(),
    });
  }catch(error){return json({ok:false,error:"player_season_detail_failed",detail:errorText(error)},503)}
}

function aggregateSkater(rows){
  const out={games_played:Array.isArray(rows)?rows.length:0,goals:0,assists:0,points:0,shots:0};
  for(const g of rows||[]){out.goals+=num(g?.goals);out.assists+=num(g?.assists);out.points+=num(g?.points);out.shots+=num(g?.shots)}
  return out;
}
function teamFromGameLog(rows){for(const g of rows||[]){const tri=upper(localized(g?.teamAbbrev)||g?.teamAbbrev||g?.teamTri||"");if(/^[A-Z]{3}$/.test(tri))return tri}return""}
function emptyRanks(){return{goals_rank:null,assists_rank:null,points_rank:null,shots_rank:null,total:null}}
async function skaterTeamRanks(playerId,tri,season){
  if(!tri)return emptyRanks();
  const d=await fetchNhl(`${NHL}/club-stats/${tri}/${season}/2`),list=Array.isArray(d?.skaters)?d.skaters:[];
  const out={total:list.length};
  for(const metric of ["goals","assists","points","shots"]){
    const values=[...list].sort((a,b)=>num(b?.[metric])-num(a?.[metric]));
    const i=values.findIndex(x=>Number(x?.playerId)===playerId);
    out[`${metric}_rank`]=i<0?null:i+1;
  }
  return out;
}
async function skaterLeagueRanks(playerId,season){
  const out={};let total=0;
  await Promise.all(["goals","assists","points","shots"].map(async metric=>{
    try{
      const d=await fetchNhl(`${NHL}/skater-stats-leaders/${season}/2?categories=${metric}&limit=-1`);
      const list=Array.isArray(d?.[metric])?d[metric]:Array.isArray(d?.leaders)?d.leaders:[];
      total=Math.max(total,list.length);
      const i=list.findIndex(x=>Number(x?.id||x?.playerId)===playerId);
      out[`${metric}_rank`]=i<0?null:i+1;
    }catch{out[`${metric}_rank`]=null}
  }));
  out.total=total||null;return out;
}
function localized(v){return v&&typeof v==="object"?(v.default||v.en||v.ru||""):v}
function num(v){const n=Number(v);return Number.isFinite(n)?n:0}
function upper(v){return String(v||"").trim().toUpperCase()}
function currentSeasonId(){const d=new Date(),y=d.getUTCFullYear(),m=d.getUTCMonth()+1,s=m>=7?y:y-1;return`${s}${s+1}`}
function seasonLabel(s){s=String(s||"");return s.length===8?`${s.slice(0,4)}/${s.slice(6,8)}`:s}
function errorText(e){return String(e?.message||e||"unknown_error")}
async function fetchNhl(url){const r=await fetch(url,{headers:{Accept:"application/json","User-Agent":"HOH-NHL-Center/12"}});if(!r.ok)throw new Error(`NHL HTTP ${r.status}`);return r.json()}
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}})}

const V12_JS=String.raw`(function(){
'use strict';
const V12='/api/telegram-center-v12',V11='/api/telegram-center-v11/pronunciation/';
const TEAM_COLORS={ANA:['#FC4C02','#B9975B'],BOS:['#FFB81C','#000000'],BUF:['#003087','#FFB81C'],CGY:['#D2001C','#FAAF19'],CAR:['#CC0000','#000000'],CHI:['#CF0A2C','#000000'],COL:['#6F263D','#236192'],CBJ:['#002654','#CE1126'],DAL:['#006847','#8F8F8C'],DET:['#CE1126','#FFFFFF'],EDM:['#041E42','#FF4C00'],FLA:['#041E42','#C8102E'],LAK:['#111111','#A2AAAD'],MIN:['#154734','#A6192E'],MTL:['#AF1E2D','#192168'],NSH:['#FFB81C','#041E42'],NJD:['#CE1126','#000000'],NYI:['#00539B','#F47D30'],NYR:['#0038A8','#CE1126'],OTT:['#C52032','#C69214'],PHI:['#F74902','#000000'],PIT:['#FCB514','#000000'],SJS:['#006D75','#EA7200'],SEA:['#001628','#99D9D9'],STL:['#002F87','#FCB514'],TBL:['#002868','#FFFFFF'],TOR:['#003E7E','#FFFFFF'],UTA:['#69B3E7','#010101'],VAN:['#00205B','#00843D'],VGK:['#B4975A','#333F42'],WSH:['#041E42','#C8102E'],WPG:['#041E42','#004C97']};
const COUNTRY_COLORS={RUS:['#ffffff','#0039A6','#D52B1E'],CAN:['#D80621','#ffffff','#D80621'],USA:['#B31942','#ffffff','#0A3161'],SWE:['#006AA7','#FECC02','#006AA7'],FIN:['#ffffff','#003580','#ffffff'],CZE:['#ffffff','#D7141A','#11457E'],SVK:['#ffffff','#0B4EA2','#EE1C25'],CHE:['#D52B1E','#ffffff','#D52B1E'],DEU:['#000000','#DD0000','#FFCE00'],LVA:['#9E3039','#ffffff','#9E3039'],NOR:['#BA0C2F','#ffffff','#00205B'],DNK:['#C60C30','#ffffff','#C60C30'],AUT:['#ED2939','#ffffff','#ED2939'],BLR:['#C8313E','#ffffff','#4AA657'],KAZ:['#00AFCA','#FEC50C','#00AFCA'],SVN:['#ffffff','#005DA4','#ED1C24'],FRA:['#0055A4','#ffffff','#EF4135'],GBR:['#012169','#ffffff','#C8102E']};
const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(u){const r=await fetch(u,{cache:'no-store'}),d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.detail||d.error||('HTTP '+r.status));return d}
function installCss(){if(document.getElementById('centerV12Css'))return;const s=document.createElement('style');s.id='centerV12Css';s.textContent='.profileHead.player{gap:10px!important}.profileHead.player>.v12PhotoWrap{position:relative;width:78px;height:78px;flex:0 0 78px}.profileHead.player>.v12PhotoWrap>img{width:78px!important;height:78px!important;margin:0!important}.v12PhotoBadge{position:absolute;top:7px;z-index:4;font-size:9px;font-weight:1000;line-height:1;letter-spacing:-.15px;text-shadow:0 1px 4px #000,0 0 8px #000;pointer-events:none}.v12PhotoBadge.country{left:2px}.v12PhotoBadge.team{right:2px}.profileHead.player .profileInfo{min-width:0;flex:1}.profileHead.player .profileInfo h1{display:flex!important;align-items:center!important;flex-wrap:nowrap!important;white-space:nowrap!important;gap:4px!important;font-size:12px!important;line-height:1.15!important;letter-spacing:-.05px!important;overflow:visible!important}.profileHead.player .profileInfo h1 .countryStable{display:none!important}.v12Audio{display:inline-grid;place-items:center;flex:0 0 21px;width:21px!important;height:21px!important;min-width:21px!important;margin:0!important;padding:0!important;border-radius:6px!important;font-size:11px!important}.v12Audio.inactive{opacity:.26!important;filter:grayscale(1);cursor:default!important;box-shadow:none!important}.profileHead.player .follow{width:48px!important;height:48px!important}.profileHead.player .followWrap{flex:0 0 58px}.profileHead.player .meta{white-space:normal}.rankTxt:empty{display:none!important}.metric.noRank .rankTxt{display:none!important}.v12SeasonLoading{opacity:.62}.mediaShelf.v12Media{margin:2px 0 15px!important}.v12MediaHead{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;margin:0 2px 1px;font-size:10px;color:#9fa3b2}.v12MediaHead b{color:#d5b7ff;font-size:11px;letter-spacing:.5px;text-transform:uppercase}.v12SeasonNote{font-size:9px;color:#85899b;margin:-4px 2px 1px}.v12PhotoBadge span{display:block}';document.head.appendChild(s)}
function gradient(colors){return 'linear-gradient(90deg,'+colors.map((c,i)=>c+' '+Math.round(i*100/Math.max(1,colors.length-1))+'%').join(',')+')'}
function badgeStyle(colors){return'background:'+gradient(colors)+';-webkit-background-clip:text;background-clip:text;color:transparent'}
function currentTab(){return document.querySelector('.tab.active')?.dataset.tab||''}
async function injectMedia(){if(currentTab()!=='games')return;const view=document.getElementById('view');if(!view||view.querySelector('.v12Media'))return;try{const d=await api(V12+'/media');if(!Array.isArray(d.items)||d.items.length<3)return;view.querySelectorAll('.mediaShelf').forEach(x=>x.remove());const shelf=document.createElement('section');shelf.className='mediaShelf v12Media';shelf.innerHTML='<div class="v12MediaHead"><b>HOME OF HOCKEY</b><span>YouTube</span></div>'+d.items.slice(0,3).map(x=>'<a class="mediaCard '+(x.kind==='news'?'news':'')+'" href="'+esc(x.url)+'" target="_blank" rel="noopener"><img src="'+esc(x.thumb||'')+'" alt=""><span class="mediaPlay">▶</span><div class="mediaMeta"><div class="mediaType">'+(x.kind==='news'?'HOH NEWS':'SHORTS')+'</div><div class="mediaTitle">'+esc(x.title||'HOME OF HOCKEY')+'</div></div></a>').join('');const toolbar=view.querySelector('.toolbar');if(toolbar)view.insertBefore(shelf,toolbar);else view.prepend(shelf)}catch{}}
function playerId(){const img=document.querySelector('.profileHead.player img');const m=String(img?.getAttribute('src')||'').match(/\/(\d{6,})\.(?:png|jpe?g|webp)(?:\?|$)/i);return m?m[1]:''}
function triFromMeta(meta){const m=String(meta?.textContent||'').trim().match(/^([A-Z]{3})\s*·/);return m?m[1]:''}
function countryFromHead(head){const s=head?.querySelector('.countryStable');return String(s?.textContent||'').trim().toUpperCase().replace(/[^A-Z]/g,'').slice(0,3)}
function decoratePhotoAndHeader(){const head=document.querySelector('.profileHead.player');if(!head)return;const img=head.querySelector(':scope > img, :scope > .v12PhotoWrap > img'),info=head.querySelector('.profileInfo'),title=info?.querySelector('h1'),meta=info?.querySelector('.meta');if(!img||!info||!title||!meta)return;const country=countryFromHead(head)||head.dataset.v12Country||'',team=triFromMeta(meta)||head.dataset.v12Team||'';if(country)head.dataset.v12Country=country;if(team)head.dataset.v12Team=team;if(img.parentElement?.classList.contains('v12PhotoWrap')===false){const wrap=document.createElement('div');wrap.className='v12PhotoWrap';img.parentNode.insertBefore(wrap,img);wrap.appendChild(img)}const wrap=img.parentElement;if(!wrap.querySelector('.v12PhotoBadge.country')){const b=document.createElement('span');b.className='v12PhotoBadge country';b.textContent=country||'NHL';b.style.cssText=badgeStyle(COUNTRY_COLORS[country]||['#9ea3b3','#ffffff']);wrap.appendChild(b)}if(!wrap.querySelector('.v12PhotoBadge.team')){const b=document.createElement('span');b.className='v12PhotoBadge team';b.textContent=team||'NHL';b.style.cssText=badgeStyle(TEAM_COLORS[team]||['#a96cff','#ff6b24']);wrap.appendChild(b)}const cs=title.querySelector('.countryStable');if(cs)cs.remove();if(team){const txt=String(meta.textContent||'').replace(new RegExp('^'+team+'\\s*·\\s*'),'');if(txt!==meta.textContent){const salary=meta.querySelector('.v11Salary');const salaryText=salary?String(salary.textContent||''):'';meta.textContent=txt;if(salary&&salaryText&&!txt.includes(salaryText)){/* V11 will restore salary if needed on next mutation */}}}ensureAudio(title,playerId())}
async function ensureAudio(title,id){if(!title||!id)return;if(title.dataset.v12Audio==='loading'||title.dataset.v12Audio==='done')return;title.dataset.v12Audio='loading';title.dataset.v11Audio='done';let b=title.querySelector('.v11Audio,.v12Audio');if(!b){b=document.createElement('button');b.type='button';b.textContent='🔊';title.appendChild(b)}b.classList.add('v12Audio');b.removeAttribute('title');b.setAttribute('aria-label','Произношение имени');try{const d=await api(V11+id);if(d.available&&d.audio_url){b.classList.remove('inactive');b.disabled=false;b.onclick=e=>{e.preventDefault();e.stopPropagation();const a=new Audio(d.audio_url);a.play().catch(()=>{})}}else{b.classList.add('inactive');b.disabled=true;b.onclick=null}}catch{b.classList.add('inactive');b.disabled=true;b.onclick=null}title.dataset.v12Audio='done'}
function removeEmptyRankCopy(){document.querySelectorAll('.rankTxt').forEach(x=>{if(/место\s+обновится\s+после\s+матч/i.test(String(x.textContent||''))){x.textContent='';x.closest('.metric')?.classList.add('noRank')}})}
function metricKey(card){const t=String(card.querySelector('.label')?.textContent||'').toLowerCase();if(t.includes('гол'))return'goals';if(t.includes('передач'))return'assists';if(t.includes('очк'))return'points';if(t.includes('брос'))return'shots';return''}
function rankLine(ranks,key,team){const t=ranks?.team?.[key+'_rank'],l=ranks?.league?.[key+'_rank'],a=[];if(t)a.push(t===1?'🥇 №1 в '+team:'#'+t+' в '+team);if(l)a.push(l===1?'🥇 №1 в НХЛ':'#'+l+' в НХЛ');return a.join(' · ')}
function pctFor(key,value){value=Number(value||0);return key==='goals'?Math.min(100,value*3):key==='assists'?Math.min(100,value*2):key==='points'?Math.min(100,value*1.4):Math.min(100,value/3)}
function updateMetrics(data){document.querySelectorAll('.metrics .metric').forEach(card=>{const key=metricKey(card);if(!key)return;const value=Number(data?.stats?.[key]||0),v=card.querySelector('.value'),rank=card.querySelector('.rankTxt'),fill=card.querySelector('.fill');if(v)v.textContent=String(value);if(fill)fill.style.width=Math.max(value?4:0,pctFor(key,value))+'%';if(rank){rank.textContent=rankLine(data?.ranks,key,data?.team_tri||'команде');card.classList.toggle('noRank',!rank.textContent)}})}
function updateTeamBadge(tri){const head=document.querySelector('.profileHead.player'),b=head?.querySelector('.v12PhotoBadge.team');if(!b||!tri)return;b.textContent=tri;b.style.cssText=badgeStyle(TEAM_COLORS[tri]||['#a96cff','#ff6b24']);head.dataset.v12Team=tri}
async function installSeasons(){const head=document.querySelector('.profileHead.player'),id=playerId(),sel=document.querySelector('#view select.season');if(!head||!id||!sel||sel.dataset.v12Ready==='1')return;sel.dataset.v12Ready='1';try{const d=await api(V12+'/players/'+id+'/seasons'),current=String(sel.value||sel.options[0]?.textContent||'').replace(/\D/g,'');const currentId=current.length===6?current.slice(0,4)+'20'+current.slice(4):'';sel.innerHTML=(d.seasons||[]).map((s,i)=>'<option value="'+esc(s.season_id)+'" '+((currentId&&s.season_id===currentId)||(!currentId&&i===0)?'selected':'')+'>'+esc(s.label)+'</option>').join('');const note=document.createElement('div');note.className='v12SeasonNote';note.textContent='Можно выбрать любой сезон игрока в НХЛ';sel.insertAdjacentElement('afterend',note);sel.onchange=()=>loadSeason(id,sel.value,sel);const selected=sel.value;if(selected)await loadSeason(id,selected,sel)}catch{sel.dataset.v12Ready='0'}}
async function loadSeason(id,season,sel){sel?.classList.add('v12SeasonLoading');try{const d=await api(V12+'/players/'+id+'/season/'+season);updateMetrics(d);if(d.team_tri)updateTeamBadge(d.team_tri)}catch{}finally{sel?.classList.remove('v12SeasonLoading')}}
function run(){installCss();injectMedia();decoratePhotoAndHeader();removeEmptyRankCopy();installSeasons()}
let timer=null;const obs=new MutationObserver(()=>{clearTimeout(timer);timer=setTimeout(run,35)});obs.observe(document.documentElement,{subtree:true,childList:true});document.addEventListener('click',()=>setTimeout(run,90),true);run();
})();`;
