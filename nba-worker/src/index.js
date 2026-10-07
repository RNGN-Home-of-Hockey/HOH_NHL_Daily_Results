const DEFAULT_SEASON = '2025-26';
const ALLOWED_WINDOWS = new Set([5, 10, 20]);
const MIN_ODDS = 1.55;
const MAX_ODDS = 2.50;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'GET') return json({ ok:false, error:'method_not_allowed' },405);
    if (!env.DB) return json({ ok:false, error:'missing_d1_binding' },503);
    if (url.pathname === '/api/health') return health(env.DB);
    if (url.pathname === '/api/line-events') return lineEvents(env.DB);
    if (url.pathname === '/api/line-cards' || url.pathname === '/api/cards') return lineCards(request,env.DB);
    if (url.pathname === '/' || url.pathname === '/broadcast') return html(APP_HTML);
    return json({ ok:false, error:'not_found' },404);
  }
};

async function health(db) {
  const core = await db.prepare(`SELECT
    (SELECT COUNT(*) FROM nba_games) games,
    (SELECT COUNT(*) FROM nba_team_game_stats) team_rows,
    (SELECT COUNT(*) FROM nba_player_game_stats) player_rows,
    (SELECT MAX(game_date) FROM nba_games) last_game_date,
    (SELECT COUNT(DISTINCT season_year) FROM nba_games) seasons`).first();
  let line={events:0,markets:0,player_props:0,fetched_at:null,status:'not_initialized',note:null};
  try {
    const counts=await db.prepare(`SELECT
      (SELECT COUNT(*) FROM nba_winline_events) events,
      (SELECT COUNT(*) FROM nba_winline_markets) markets,
      (SELECT COALESCE(SUM(player_props_count),0) FROM nba_winline_events) player_props`).first();
    const sync=await db.prepare(`SELECT fetched_at,status,note FROM nba_winline_sync WHERE source='winline'`).first();
    line={...counts,...(sync||{})};
  } catch (e) { line.note=String(e.message||e); }
  return json({ok:true,service:'rngn-nba-broadcast',database:'hoh-data-core',namespace:'nba_*',...core,winline:line});
}

async function lineEvents(db) {
  const events=await db.prepare(`SELECT e.*,
      (SELECT COUNT(*) FROM nba_winline_markets m WHERE m.event_id=e.event_id) normalized_markets
    FROM nba_winline_events e ORDER BY starts_at,event_id`).all();
  const sync=await db.prepare(`SELECT * FROM nba_winline_sync WHERE source='winline'`).first();
  return json({ok:true,source:'winline',sync,events:events.results||[]});
}

async function lineCards(request,db) {
  const url=new URL(request.url);
  const season=String(url.searchParams.get('season')||DEFAULT_SEASON).trim();
  const requested=Number(url.searchParams.get('window')||10);
  const window=ALLOWED_WINDOWS.has(requested)?requested:10;

  const marketResult=await db.prepare(`SELECT
      e.event_id,e.starts_at,e.team1_name,e.team2_name,e.team1_abbr,e.team2_abbr,e.source_url,
      e.player_props_count,e.fetched_at,
      m.market_key,m.market_id,m.market_type,m.entity_type,m.entity_name,m.entity_abbr,
      m.selection_side,m.line_value,m.odds,m.market_label,m.selection_label
    FROM nba_winline_events e
    JOIN nba_winline_markets m ON m.event_id=e.event_id
    WHERE julianday(e.starts_at) >= julianday('now','-18 hours')
    ORDER BY e.starts_at,e.event_id,m.market_type,m.entity_abbr,m.line_value,m.odds`).all();
  const markets=marketResult.results||[];
  const sync=await db.prepare(`SELECT * FROM nba_winline_sync WHERE source='winline'`).first();
  if (!markets.length) return json({ok:true,season,window,source:'winline',sync,cards:[],events:[],message:'No current Winline NBA preseason markets'});

  const eventMap=new Map();
  const teams=new Set();
  for (const m of markets) {
    teams.add(m.team1_abbr); teams.add(m.team2_abbr);
    if (!eventMap.has(m.event_id)) eventMap.set(m.event_id,{event_id:m.event_id,starts_at:m.starts_at,team1_name:m.team1_name,team2_name:m.team2_name,team1_abbr:m.team1_abbr,team2_abbr:m.team2_abbr,source_url:m.source_url,player_props_count:Number(m.player_props_count||0),fetched_at:m.fetched_at,market_count:0});
    eventMap.get(m.event_id).market_count++;
  }

  const teamList=[...teams].filter(Boolean);
  const placeholders=teamList.map(()=>'?').join(',');
  const statsSql=`WITH paired AS (
      SELECT s.game_id,s.game_date,s.season_year,s.season_type,s.team_abbr,
        COALESCE(s.pts,0) pts,COALESCE(o.pts,0) opp_pts,
        COALESCE(s.pts,0)+COALESCE(o.pts,0) game_total,
        COALESCE(s.pts,0)-COALESCE(o.pts,0) margin,
        ROW_NUMBER() OVER (PARTITION BY s.team_abbr ORDER BY s.game_date DESC,s.game_id DESC) rn
      FROM nba_team_game_stats s
      JOIN nba_team_game_stats o ON o.game_id=s.game_id AND o.team_id<>s.team_id
      WHERE s.season_year=? AND s.team_abbr IN (${placeholders})
    ) SELECT * FROM paired WHERE rn<=? ORDER BY team_abbr,rn`;
  const statsResult=await db.prepare(statsSql).bind(season,...teamList,window).all();
  const byTeam=new Map();
  for (const row of statsResult.results||[]) {
    if (!byTeam.has(row.team_abbr)) byTeam.set(row.team_abbr,[]);
    byTeam.get(row.team_abbr).push(row);
  }

  let evaluated=markets.map(m=>evaluateMarket(m,byTeam,window)).filter(Boolean);
  const makeCandidates=(minRate)=>evaluated.filter(c=>c.sample>=Math.min(5,window) && c.rate>=minRate && c.odds>=MIN_ODDS && c.odds<=MAX_ODDS);
  let candidates=makeCandidates(.60);
  if (candidates.length<6) candidates=makeCandidates(.50);

  for (const c of candidates) {
    const oddsFit=Math.max(0,1-Math.abs(c.odds-1.90)/0.60);
    const typeBonus={team_total:5,game_total:4,spread:2,moneyline:0}[c.market_type]||0;
    c.score=c.rate*100+oddsFit*5+typeBonus+(c.sample>=10?2:0);
  }
  candidates.sort((a,b)=>b.score-a.score || b.rate-a.rate || Math.abs(a.odds-1.9)-Math.abs(b.odds-1.9));

  const bestConcept=new Map();
  for (const c of candidates) {
    const concept=`${c.event_id}:${c.market_type}:${c.entity_abbr||'MATCH'}`;
    if (!bestConcept.has(concept)) bestConcept.set(concept,c);
  }
  const deduped=[...bestConcept.values()].sort((a,b)=>b.score-a.score);
  const perEvent=new Map(), selected=[];
  for (const c of deduped) {
    const n=perEvent.get(c.event_id)||0;
    if (n>=3) continue;
    perEvent.set(c.event_id,n+1); selected.push(c);
    if (selected.length>=12) break;
  }

  const typeCounts={};
  for (const m of markets) typeCounts[m.market_type]=(typeCounts[m.market_type]||0)+1;
  return json({
    ok:true,source:'winline',season,window,sync,
    current:{events:eventMap.size,markets:markets.length,player_props:[...eventMap.values()].reduce((s,e)=>s+e.player_props_count,0),market_types:typeCounts},
    events:[...eventMap.values()],cards:selected,
    methodology:{odds_range:[MIN_ODDS,MAX_ODDS],primary_min_hit_rate:60,fallback_min_hit_rate:50,team_sample:`L${window}`,game_total_sample:`L${window} каждой команды`,note:'Исторический hit rate по фактическим матчам 2025-26; это не прогноз.'}
  });
}

function evaluateMarket(m,byTeam,window) {
  let rows=[];
  if (m.market_type==='game_total') rows=[...(byTeam.get(m.team1_abbr)||[]),...(byTeam.get(m.team2_abbr)||[])];
  else rows=byTeam.get(m.entity_abbr)||[];
  if (!rows.length) return null;
  const line=m.line_value==null?null:Number(m.line_value), odds=Number(m.odds);
  let hits=0,pushes=0,losses=0;
  const recent=[];
  for (const r of rows) {
    let value,delta;
    if (m.market_type==='moneyline') { value=Number(r.margin); delta=value; }
    else if (m.market_type==='spread') { value=Number(r.margin); delta=value+line; }
    else if (m.market_type==='team_total') { value=Number(r.pts); delta=m.selection_side==='OVER'?value-line:line-value; }
    else if (m.market_type==='game_total') { value=Number(r.game_total); delta=m.selection_side==='OVER'?value-line:line-value; }
    else return null;
    if (delta>0) hits++; else if (delta===0) pushes++; else losses++;
    recent.push({team:r.team_abbr,date:r.game_date,value,opponent_value:Number(r.opp_pts),result:delta>0?'hit':delta===0?'push':'miss'});
  }
  const decisions=hits+losses;
  const rate=decisions?hits/decisions:0;
  return {
    event_id:m.event_id,starts_at:m.starts_at,matchup:`${m.team1_name} — ${m.team2_name}`,
    team1_abbr:m.team1_abbr,team2_abbr:m.team2_abbr,source_url:m.source_url,fetched_at:m.fetched_at,
    market_key:m.market_key,market_id:m.market_id,market_type:m.market_type,market_label:m.market_label,
    entity_name:m.entity_name,entity_abbr:m.entity_abbr,selection_side:m.selection_side,
    selection_label:m.selection_label,line_value:line,odds,hits,losses,pushes,sample:decisions,
    rate,percent:Math.round(rate*100),recent:recent.slice(0,m.market_type==='game_total'?window*2:window)
  };
}

function json(data,status=200){return new Response(JSON.stringify(data,null,2),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*'}});}
function html(body){return new Response(body,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});}

const APP_HTML=String.raw`<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RNGN NBA · Winline Line Scanner</title>
<style>
:root{--bg:#070707;--panel:#111;--line:#2b2b2b;--text:#f5f5f5;--muted:#8e8e8e;--orange:#ff5b24;--green:#66e08a;--red:#ff6b6b}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 80% -10%,#35190c 0,#0a0a0a 34%,#050505 70%);color:var(--text);font-family:Inter,Arial,sans-serif;min-height:100vh}.wrap{max-width:1500px;margin:auto;padding:28px 28px 60px}.header{display:flex;justify-content:space-between;gap:24px;align-items:flex-end;padding-bottom:22px;border-bottom:1px solid var(--line)}.eyebrow{font-size:12px;letter-spacing:.18em;font-weight:900;color:#ff8151}.title{font-size:44px;font-weight:1000;letter-spacing:-.05em;line-height:.95;margin-top:8px}.sub{font-size:14px;color:#aaa;margin-top:10px}.status{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}.pill{background:#0d0d0d;border:1px solid #303030;border-radius:999px;padding:9px 12px;font-size:12px;color:#aaa}.pill b{color:#fff}.pill.orange{border-color:#6b321d;color:#ff9a73}.controls{display:flex;gap:9px;align-items:center;margin:22px 0;flex-wrap:wrap}.controls button,.controls select{border:1px solid #333;background:#111;color:#ddd;border-radius:9px;padding:10px 13px;font-weight:800;cursor:pointer}.controls button.active{background:#fff;color:#000;border-color:#fff}.sync{margin-left:auto;color:#777;font-size:12px}.notice{border:1px solid #52301f;background:#1b100b;border-radius:12px;padding:12px 15px;color:#e5b49f;font-size:13px;margin-bottom:18px;display:none}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:17px}.card{position:relative;background:linear-gradient(145deg,#151515,#0b0b0b);border:1px solid #292929;border-radius:17px;padding:20px;min-height:315px;overflow:hidden;display:flex;flex-direction:column;justify-content:space-between}.card:after{content:'';position:absolute;inset:0;background:linear-gradient(135deg,transparent 48%,rgba(255,91,36,.11));pointer-events:none}.topline{display:flex;justify-content:space-between;gap:10px;align-items:center}.match{font-weight:900;font-size:13px;letter-spacing:.01em}.time{font-size:11px;color:#777}.source{display:inline-flex;align-items:center;gap:6px;color:#ff7b48;font-size:11px;font-weight:900;letter-spacing:.08em;margin-top:15px}.source:before{content:'';width:7px;height:7px;background:var(--orange);border-radius:50%;box-shadow:0 0 12px #ff5b24}.market{font-size:13px;color:#9f9f9f;margin-top:11px}.selection{font-size:30px;font-weight:1000;letter-spacing:-.035em;margin-top:4px}.odds{color:#ff7b48}.numbers{display:flex;gap:22px;align-items:flex-end;margin-top:22px}.percent{font-size:67px;line-height:.8;font-weight:1000;letter-spacing:-.07em}.percent span{font-size:19px;letter-spacing:0;color:#aaa}.record{font-size:17px;font-weight:900}.record small{display:block;font-size:10px;letter-spacing:.12em;color:#777;margin-bottom:4px}.recent{display:flex;gap:5px;flex-wrap:wrap;margin-top:17px}.v{min-width:31px;padding:5px 6px;text-align:center;border-radius:6px;background:#151515;border:1px solid #2a2a2a;font-size:10px;color:#999}.v.hit{border-color:#275437;color:#8fe0a7}.v.miss{border-color:#4f2929;color:#d39393}.footer{border-top:1px solid #272727;margin-top:17px;padding-top:12px;display:flex;justify-content:space-between;gap:10px;color:#6f6f6f;font-size:10px}.empty{grid-column:1/-1;padding:60px;border:1px dashed #333;border-radius:15px;text-align:center;color:#888}.method{margin-top:22px;color:#666;font-size:11px}.section{font-size:13px;font-weight:900;letter-spacing:.12em;margin:8px 0 15px;color:#aaa}@media(max-width:1050px){.grid{grid-template-columns:repeat(2,1fr)}}@media(max-width:700px){.wrap{padding:18px 13px 40px}.header{display:block}.status{justify-content:flex-start;margin-top:18px}.title{font-size:34px}.grid{grid-template-columns:1fr}.sync{width:100%;margin-left:0}}
</style></head><body><div class="wrap">
<div class="header"><div><div class="eyebrow">RNGN · NBA DATA CORE × WINLINE</div><div class="title">NBA LINE SCANNER</div><div class="sub">Реальная линия Winline → фактическая статистика NBA → готовые эфирные тезисы</div></div><div class="status" id="status"><span class="pill">загрузка…</span></div></div>
<div class="controls"><select id="season"><option value="2025-26">2025/26</option><option value="2024-25">2024/25</option></select><button data-w="5">L5</button><button data-w="10" class="active">L10</button><button data-w="20">L20</button><select id="type"><option value="all">Все рынки</option><option value="team_total">Тоталы команд</option><option value="game_total">Тоталы матчей</option><option value="spread">Форы</option><option value="moneyline">Исходы</option></select><div class="sync" id="sync">—</div></div>
<div class="notice" id="notice"></div><div class="section" id="section">ЛУЧШИЕ СТАТИСТИЧЕСКИЕ СОВПАДЕНИЯ С ТЕКУЩЕЙ ЛИНИЕЙ</div><div class="grid" id="grid"><div class="empty">Считаю текущую линию…</div></div><div class="method" id="method"></div>
</div><script>
var grid=document.getElementById('grid'),statusEl=document.getElementById('status'),syncEl=document.getElementById('sync'),seasonEl=document.getElementById('season'),typeEl=document.getElementById('type'),notice=document.getElementById('notice'),method=document.getElementById('method');var windowSize=10,lastData=null;
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(m){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]})}
function fmtTime(s){try{return new Date(s).toLocaleString('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})+' МСК'}catch(e){return s}}
function marketName(t){return {team_total:'Индивидуальный тотал команды',game_total:'Тотал матча',spread:'Фора',moneyline:'Исход'}[t]||t}
function render(){if(!lastData)return;var f=typeEl.value;var cards=(lastData.cards||[]).filter(function(c){return f==='all'||c.market_type===f});if(!cards.length){grid.innerHTML='<div class="empty">Для этого фильтра нет сильных совпадений в текущей линии Winline.</div>';return}grid.innerHTML=cards.map(function(c){var vals=(c.recent||[]).slice(0,10).map(function(r){return '<span class="v '+esc(r.result)+'" title="'+esc(r.date)+'">'+esc(r.value)+'</span>'}).join('');return '<article class="card"><div><div class="topline"><div class="match">'+esc(c.matchup)+'</div><div class="time">'+esc(fmtTime(c.starts_at))+'</div></div><div class="source">WINLINE · АКТУАЛЬНАЯ ЛИНИЯ</div><div class="market">'+esc(marketName(c.market_type))+'</div><div class="selection">'+esc(c.selection_label)+' <span class="odds">@ '+Number(c.odds).toFixed(2)+'</span></div><div class="numbers"><div class="percent">'+esc(c.percent)+'<span>%</span></div><div class="record"><small>HIT RATE</small>'+esc(c.hits)+' / '+esc(c.sample)+(c.pushes?' · '+esc(c.pushes)+' push':'')+'</div></div><div class="recent">'+vals+'</div></div><div class="footer"><span>'+esc(lastData.season)+' · L'+esc(lastData.window)+'</span><a href="'+esc(c.source_url)+'" target="_blank" style="color:#888">открыть Winline ↗</a></div></article>'}).join('')}
async function load(){grid.innerHTML='<div class="empty">Пересчитываю рынки Winline…</div>';try{var d=await fetch('/api/line-cards?season='+encodeURIComponent(seasonEl.value)+'&window='+windowSize,{cache:'no-store'}).then(function(r){return r.json()});if(!d.ok)throw new Error(d.error||'api_error');lastData=d;var cur=d.current||{};statusEl.innerHTML='<span class="pill"><b>'+esc(cur.events||0)+'</b> матчей</span><span class="pill"><b>'+esc(cur.markets||0)+'</b> рынков</span><span class="pill orange">PLAYER PROPS <b>'+esc(cur.player_props||0)+'</b></span>';var fa=d.sync&&d.sync.fetched_at;syncEl.textContent='линия: '+(fa?new Date(fa).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'}):'—');if(Number(cur.player_props||0)===0){notice.style.display='block';notice.innerHTML='<b>По игрокам сейчас рынков нет.</b> Winline на этих предсезонных матчах пока отдаёт командную линию: тоталы, индивидуальные тоталы команд, форы и исходы. Сканер показывает только реально существующие selection’ы.'}else{notice.style.display='block';notice.innerHTML='<b>Player props появились:</b> '+esc(cur.player_props)+' строк в текущем snapshot Winline.'}method.textContent=(d.methodology&&d.methodology.note?d.methodology.note:'')+' В подбор попадают только реальные коэффициенты Winline '+(d.methodology?d.methodology.odds_range.join('–'):'')+'.';render()}catch(e){grid.innerHTML='<div class="empty">Ошибка: '+esc(e.message)+'</div>'}}
document.querySelectorAll('[data-w]').forEach(function(b){b.onclick=function(){document.querySelectorAll('[data-w]').forEach(function(x){x.classList.remove('active')});b.classList.add('active');windowSize=Number(b.dataset.w);load()}});seasonEl.onchange=load;typeEl.onchange=render;load();
</script></body></html>`;
