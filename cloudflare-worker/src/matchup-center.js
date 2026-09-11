import { evaluateMarketLines } from "./market-line-evaluator.js";
import { buildPlayerMarketInsights } from "./player-market-insights.js";

const NHL_BASE = "https://api-web.nhle.com/v1";

export async function handleMatchupCenterRequest(request, env, path) {
  if (path === "/matchup") {
    if (request.method !== "GET") return json({ok:false,error:"method_not_allowed"},405);
    return html(MATCHUP_HTML);
  }
  if (path === "/matchup/app.js") {
    if (request.method !== "GET") return json({ok:false,error:"method_not_allowed"},405);
    return js(`(${browserApp.toString()})();`);
  }
  const match=/^\/api\/matchup\/(\d+)$/.exec(path);
  if (!match) return null;
  if (request.method !== "GET") return json({ok:false,error:"method_not_allowed"},405);
  if (!env.DB) return json({ok:false,error:"missing_d1_binding"},503);
  const gamePk=Number(match[1]);
  if(!Number.isSafeInteger(gamePk)||gamePk<=0)return json({ok:false,error:"invalid_game_pk"},400);
  return matchupApi(request,env,gamePk);
}

async function matchupApi(request,env,gamePk){
  try{
    const box=await fetchNhl(`${NHL_BASE}/gamecenter/${gamePk}/boxscore`);
    const game=normalizeGame(box,gamePk);
    if(!game.home_tri||!game.away_tri)return json({ok:false,error:"game_teams_missing"},502);
    const window=normalizeWindow(new URL(request.url).searchParams.get("window"));

    const [markets,pregameR,currentR,playersR,playerMarkets] = await Promise.all([
      evaluateMarketLines(env.DB,game,{window,before:game.start_utc}),
      env.DB.prepare(`
        SELECT s.*,t.name_en,t.name_ru,t.logo_url
        FROM pregame_team_snapshots s JOIN teams t ON t.tri_code=s.team_tri
        WHERE s.game_pk=? AND s.team_tri IN (?,?)
        ORDER BY s.team_tri,s.window_games;
      `).bind(gamePk,game.home_tri,game.away_tri).all(),
      env.DB.prepare(`
        SELECT s.*,t.name_en,t.name_ru,t.logo_url
        FROM team_current_snapshots s JOIN teams t ON t.tri_code=s.team_tri
        WHERE s.team_tri IN (?,?)
        ORDER BY s.team_tri,s.window_games;
      `).bind(game.home_tri,game.away_tri).all(),
      env.DB.prepare(`
        SELECT p.player_id,p.full_name_en,p.full_name_ru,p.current_team_tri,p.position_code,p.sweater_number,
               r.games,r.goals,r.assists,r.points,r.shots,r.goals_pg,r.points_pg,r.shots_pg,r.games_with_goal,r.games_with_point
        FROM player_rolling_snapshots r JOIN players p ON p.player_id=r.player_id
        WHERE r.window_key='20' AND r.team_tri IN (?,?)
        ORDER BY r.team_tri,r.points_pg DESC,r.goals_pg DESC,r.shots_pg DESC;
      `).bind(game.home_tri,game.away_tri).all(),
      buildPlayerMarketInsights(env.DB,{
        game_pk:game.game_pk,
        scheduled_start_utc:game.start_utc,
        home_tri:game.home_tri,
        away_tri:game.away_tri,
      }),
    ]);

    const historicalRows=pregameR.results||[];
    const snapshotSource=historicalRows.length ? "pregame" : "current";
    const snapshotRows=historicalRows.length ? historicalRows : (currentR.results||[]);
    const snapshots=groupBy(snapshotRows,r=>r.team_tri);
    const players=snapshotSource==="current" ? groupBy(playersR.results||[],r=>r.current_team_tri) : {};
    const minConfidence=clampNumber(new URL(request.url).searchParams.get("min_confidence"),10,0,100);
    const filtered=markets.filter(m=>Number(m.confidence)>=minConfidence);

    return json({
      ok:true,game,window,snapshot_source:snapshotSource,
      teams:{
        [game.away_tri]:{snapshots:snapshots[game.away_tri]||[],leaders:(players[game.away_tri]||[]).slice(0,8)},
        [game.home_tri]:{snapshots:snapshots[game.home_tri]||[],leaders:(players[game.home_tri]||[]).slice(0,8)},
      },
      markets:filtered,
      top_markets:filtered.slice(0,12),
      player_markets:(playerMarkets||[]).slice(0,10),
      methodology:{
        window_games:window,
        exact_lines:{game_totals:[4.5,5.5,6.5,7.5],team_totals:[1.5,2.5,3.5,4.5],handicaps:[-2.5,-1.5,1.5,2.5]},
        combined_rate:"mean(team historical hit rate, opponent allowing/opposing environment hit rate)",
        confidence:"positive edge above 50% for the displayed direction; deterministic context, not a probability forecast",
        historical_guard:"all team windows are cut off before game start; historical games use exact pregame snapshots when available",
      },
      quota_profile:"two_team_window",
    });
  }catch(error){
    console.error("matchup center failed",gamePk,error);
    return json({ok:false,error:"matchup_failed"},502);
  }
}

function normalizeGame(box,gamePk){
  const home=box?.homeTeam||{},away=box?.awayTeam||{};
  return {
    game_pk:gamePk,
    game_state:String(box?.gameState||"").toUpperCase(),
    start_utc:box?.startTimeUTC||null,
    home_tri:String(home.abbrev||"").toUpperCase(),
    away_tri:String(away.abbrev||"").toUpperCase(),
    home_score:numberOrNull(home.score),away_score:numberOrNull(away.score),
    home_logo:home.logo||null,away_logo:away.logo||null,
  };
}
async function fetchNhl(url){const r=await fetch(url,{headers:{Accept:"application/json"}});if(!r.ok)throw new Error(`NHL HTTP ${r.status}`);return r.json()}
function groupBy(rows,key){const out={};for(const row of rows){const k=String(key(row)||"");if(!out[k])out[k]=[];out[k].push(row)}return out}
function normalizeWindow(v){const n=Number(v);return [5,10,20].includes(n)?n:20}
function numberOrNull(v){const n=Number(v);return Number.isFinite(n)?n:null}
function clampNumber(v,fallback,min,max){const n=Number(v);return Number.isFinite(n)&&n>=min&&n<=max?n:fallback}
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}})}
function html(body){return new Response(body,{headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"public, max-age=180","X-Content-Type-Options":"nosniff"}})}
function js(body){return new Response(body,{headers:{"Content-Type":"application/javascript; charset=utf-8","Cache-Control":"public, max-age=180","X-Content-Type-Options":"nosniff"}})}

function browserApp(){
  const $=s=>document.querySelector(s);const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot',"'":'&#39;'}[c]));const pct=v=>Number.isFinite(Number(v))?(Number(v)*100).toFixed(0)+'%':'—';const num=(v,d=1)=>Number.isFinite(Number(v))?Number(v).toFixed(d):'—';
  const qs=new URLSearchParams(location.search);let game=qs.get('game')||'';let windowGames=Number(qs.get('window')||20);if(![5,10,20].includes(windowGames))windowGames=20;
  async function api(u){const r=await fetch(u,{cache:'no-store'});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||('HTTP '+r.status));return d}
  async function load(){if(!/^\d+$/.test(game)){renderInput();return}$('#content').innerHTML='<div class="empty">Считаю линии…</div>';try{const d=await api('/api/matchup/'+game+'?window='+windowGames);render(d)}catch(e){$('#content').innerHTML='<div class="empty error">'+esc(e.message)+'</div>'}}
  function renderInput(){$('#content').innerHTML='<section class="empty"><h2>Введите NHL game ID</h2><div class="input"><input id="gameInput" inputmode="numeric" placeholder="2026020001"><button id="go">Открыть</button></div></section>';$('#go').onclick=()=>{game=$('#gameInput').value.trim();history.replaceState(null,'','/matchup?game='+encodeURIComponent(game));load()}}
  function render(d){const g=d.game;const away=d.teams[g.away_tri]||{},home=d.teams[g.home_tri]||{};$('#content').innerHTML=`<section class="hero"><div class="club">${g.away_logo?`<img src="${esc(g.away_logo)}">`:''}<b>${esc(g.away_tri)}</b></div><div><div class="eyebrow">MATCHUP · ${esc(g.game_state||'PREGAME')} · ${esc(String(d.snapshot_source||'').toUpperCase())}</div><h1>${esc(g.away_tri)} — ${esc(g.home_tri)}</h1><span>${esc(g.start_utc||'')}</span></div><div class="club right">${g.home_logo?`<img src="${esc(g.home_logo)}">`:''}<b>${esc(g.home_tri)}</b></div></section><div class="seg">${[5,10,20].map(w=>`<button data-w="${w}" class="${w===windowGames?'active':''}">${w}</button>`).join('')}</div><section class="grid"><article class="panel"><h3>Точные линии · top</h3><div class="markets">${(d.top_markets||[]).map(m=>`<div class="market"><span><b>${esc(m.label)}</b><small>${esc(m.market_type)} · sample ${m.sample}</small></span><strong>${pct(m.combined_rate)}</strong><i>${num(m.confidence,0)} conf</i></div>`).join('')||'<div class="empty small">Нет сильных сигналов</div>'}</div></article><article class="panel"><h3>${esc(g.away_tri)} · ${windowGames} матчей</h3>${teamBlock(away,g.away_tri)}<h3>${esc(g.home_tri)} · ${windowGames} матчей</h3>${teamBlock(home,g.home_tri)}</article></section><section class="panel"><h3>Игроки / вратари</h3><div class="playerMarkets">${(d.player_markets||[]).map(c=>`<div class="pmarket"><span><b>${esc(c.market?.label||c.title)}</b><small>${esc(c.eyebrow||'')} · ${esc(c.value||'')}</small></span><strong>${num(c.score,0)}</strong></div>`).join('')||'<div class="empty small">Для исторического матча current player snapshot не подмешивается. Для будущих матчей данные появятся после compact sync.</div>'}</div></section><section class="panel"><h3>Все рынки</h3><div class="allMarkets">${(d.markets||[]).map(m=>`<div><span>${esc(m.label)}</span><b>${pct(m.combined_rate)}</b><small>${Object.entries(m.evidence?.components||{}).map(([k,v])=>esc(k)+' '+pct(v)).join(' · ')}</small></div>`).join('')}</div></section>`;document.querySelectorAll('[data-w]').forEach(b=>b.onclick=()=>{windowGames=Number(b.dataset.w);load()})}
  function teamBlock(team,tri){const s=(team.snapshots||[]).find(x=>Number(x.window_games)===windowGames)||(team.snapshots||[]).slice(-1)[0]||{};return `<div class="metrics"><span><b>${num(s.gf_pg,2)}</b><small>GF · #${s.rank_gf??'—'}</small></span><span><b>${num(s.ga_pg,2)}</b><small>GA · #${s.rank_ga??'—'}</small></span><span><b>${num(s.xgf_pct_5v5,1)}%</b><small>xGF · #${s.rank_xgf_pct_5v5??'—'}</small></span></div><div class="leaders">${(team.leaders||[]).slice(0,5).map(p=>`<div><span>${esc(p.full_name_ru||p.full_name_en)}</span><b>${num(p.points_pg,2)} очк/м</b></div>`).join('')}</div>`}
  load();
}

const MATCHUP_HTML=`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HOH Matchup Lab</title><style>:root{--bg:#09090b;--panel:#121216;--line:#29292f;--text:#f5f4f1;--muted:#73737c;--orange:#ff5a1f;--lav:#c8b7ff;--green:#79dea9}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,Arial,sans-serif}.wrap{max-width:1180px;margin:auto;padding:28px 18px 70px}.brand{font-weight:950;margin-bottom:22px}.brand i{font-style:normal;color:var(--orange)}.hero{display:grid;grid-template-columns:1fr 1.5fr 1fr;align-items:center;text-align:center;border:1px solid var(--line);background:#101013;border-radius:18px;padding:18px}.club{display:flex;align-items:center;gap:12px;font-size:25px}.club.right{justify-content:flex-end;flex-direction:row-reverse}.club img{width:70px;height:70px;object-fit:contain}.eyebrow{font-size:8px;color:var(--lav);letter-spacing:.1em}h1{font-size:38px;letter-spacing:-.05em;margin:6px}.hero span{font-size:9px;color:#666}.seg{display:flex;justify-content:center;gap:5px;margin:12px}.seg button{border:1px solid var(--line);background:#151519;color:#777;border-radius:8px;padding:8px 14px;font-weight:900}.seg button.active{background:#29262e;color:#fff}.grid{display:grid;grid-template-columns:1.25fr 1fr;gap:10px}.panel{border:1px solid var(--line);background:var(--panel);border-radius:15px;padding:14px;margin-top:10px}.panel h3{font-size:9px;color:var(--lav);letter-spacing:.1em;text-transform:uppercase}.market{display:grid;grid-template-columns:1fr 55px 55px;align-items:center;padding:9px 0;border-bottom:1px solid #24242a}.market span{display:flex;flex-direction:column}.market b{font-size:11px}.market small{font-size:7px;color:#666}.market strong{color:var(--green)}.market i{font-size:7px;color:#777;font-style:normal}.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:8px 0}.metrics span{border:1px solid #29292f;border-radius:9px;padding:9px;display:flex;flex-direction:column}.metrics b{font-size:17px}.metrics small{font-size:7px;color:#666}.leaders>div{display:flex;justify-content:space-between;border-bottom:1px solid #24242a;padding:7px 0;font-size:9px}.playerMarkets{display:grid;grid-template-columns:repeat(2,1fr);gap:7px}.pmarket{border:1px solid #27272d;border-radius:10px;padding:10px;display:flex;align-items:center;justify-content:space-between;gap:10px}.pmarket span{display:flex;flex-direction:column}.pmarket b{font-size:10px}.pmarket small{font-size:7px;color:#6f6f78;margin-top:3px}.pmarket strong{color:var(--lav)}.allMarkets{display:grid;grid-template-columns:repeat(2,1fr);gap:0 20px}.allMarkets>div{display:grid;grid-template-columns:1fr 45px;gap:4px;padding:8px 0;border-bottom:1px solid #24242a;font-size:9px}.allMarkets small{grid-column:1/3;color:#666;font-size:7px}.empty{text-align:center;padding:50px;color:#777}.empty.small{padding:18px}.empty.error{color:#dd746d}.input{display:flex;justify-content:center;gap:6px}.input input,.input button{border:1px solid var(--line);background:#151519;color:#fff;border-radius:9px;padding:10px}.input button{background:var(--orange);color:#111;font-weight:900}@media(max-width:760px){.grid{grid-template-columns:1fr}.hero{grid-template-columns:1fr 1fr}.hero>div:nth-child(2){grid-column:1/3;grid-row:1}.club{font-size:17px}.club img{width:45px;height:45px}.allMarkets,.playerMarkets{grid-template-columns:1fr}}</style></head><body><div class="wrap"><div class="brand">HOME OF <i>HOCKEY</i> · MATCHUP LAB</div><main id="content"><div class="empty">Загрузка…</div></main></div><script src="/matchup/app.js"></script></body></html>`;
