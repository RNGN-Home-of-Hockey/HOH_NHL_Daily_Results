const BROADCAST_PATH = "/broadcast";

export async function handleBroadcastRequest(request, env, path) {
  if (path === BROADCAST_PATH) {
    if (request.method !== "GET") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
    return htmlResponse(DASHBOARD_HTML);
  }

  if (path === "/api/broadcast/games") {
    if (request.method !== "GET") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
    return broadcastGamesRoute(env);
  }

  if (path === "/api/broadcast/state") {
    if (request.method !== "GET") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
    return broadcastStateRoute(env);
  }

  const gameMatch = /^\/api\/broadcast\/games\/(\d+)$/.exec(path);
  if (gameMatch) {
    if (request.method !== "GET") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
    return broadcastGameRoute(env, Number(gameMatch[1]));
  }

  return null;
}

async function broadcastGamesRoute(env) {
  if (!env.DB) return jsonResponse({ ok: false, error: "missing_d1_binding" }, 503);
  try {
    const [gamesResult, countsRow] = await Promise.all([
      env.DB.prepare(`
        SELECT g.game_pk,g.season_id,g.game_type,g.scheduled_start_utc,g.game_state,
               g.home_tri,g.away_tri,g.home_score,g.away_score,g.current_period,g.period_type,g.venue_name,
               ht.name_en AS home_name,ht.name_ru AS home_name_ru,ht.logo_url AS home_logo,
               at.name_en AS away_name,at.name_ru AS away_name_ru,at.logo_url AS away_logo
        FROM games g
        LEFT JOIN teams ht ON ht.tri_code=g.home_tri
        LEFT JOIN teams at ON at.tri_code=g.away_tri
        WHERE g.game_type IN (2,3)
        ORDER BY g.scheduled_start_utc DESC
        LIMIT 100;
      `).all(),
      env.DB.prepare(`
        SELECT
          (SELECT COUNT(*) FROM games WHERE game_type IN (2,3)) AS games,
          (SELECT COUNT(*) FROM players) AS players,
          (SELECT COUNT(*) FROM teams) AS teams;
      `).first(),
    ]);
    return jsonResponse({
      ok:true,
      counts:{
        games:Number(countsRow?.games||0),
        players:Number(countsRow?.players||0),
        teams:Number(countsRow?.teams||0),
      },
      games:gamesResult.results||[],
    });
  } catch (error) {
    console.error("broadcast games failed", error);
    return jsonResponse({ ok:false, error:"broadcast_games_failed" }, 500);
  }
}

async function broadcastStateRoute(env) {
  if (!env.DB) return jsonResponse({ ok:false, error:"missing_d1_binding" },503);
  try {
    const shown = await env.DB.prepare(`
      SELECT card_id,game_pk,headline_ru,stat_text_ru,source_note_ru,shown_at,status
      FROM broadcast_cards
      WHERE status='shown'
      ORDER BY shown_at DESC,updated_at DESC
      LIMIT 1;
    `).first();
    return jsonResponse({ ok:true, on_air:shown||null });
  } catch (error) {
    console.error("broadcast state failed", error);
    return jsonResponse({ ok:false, error:"broadcast_state_failed" },500);
  }
}

async function broadcastGameRoute(env, gamePk) {
  if (!env.DB) return jsonResponse({ ok:false, error:"missing_d1_binding" },503);
  if (!Number.isSafeInteger(gamePk) || gamePk<=0) return jsonResponse({ ok:false,error:"invalid_game_pk" },400);
  try {
    const game = await env.DB.prepare(`
      SELECT g.*,ht.name_en AS home_name,ht.name_ru AS home_name_ru,ht.logo_url AS home_logo,
             at.name_en AS away_name,at.name_ru AS away_name_ru,at.logo_url AS away_logo
      FROM games g
      LEFT JOIN teams ht ON ht.tri_code=g.home_tri
      LEFT JOIN teams at ON at.tri_code=g.away_tri
      WHERE g.game_pk=? AND g.game_type IN (2,3)
      LIMIT 1;
    `).bind(gamePk).first();
    if (!game) return jsonResponse({ ok:false,error:"game_not_found" },404);

    const [periodsResult,teamStatsResult,playerStatsResult,eventsResult,persistedCardsResult] = await env.DB.batch([
      env.DB.prepare(`SELECT period_number,period_type,home_goals,away_goals FROM period_scores WHERE game_pk=? ORDER BY period_number,period_type;`).bind(gamePk),
      env.DB.prepare(`SELECT * FROM team_game_stats WHERE game_pk=? ORDER BY is_home ASC;`).bind(gamePk),
      env.DB.prepare(`
        SELECT pgs.player_id,pgs.team_tri,pgs.goals,pgs.assists,pgs.points,pgs.shots,pgs.hits,pgs.blocked_shots,
               pgs.pim,pgs.plus_minus,pgs.toi_seconds,p.full_name_en,p.full_name_ru,p.position_code,p.sweater_number
        FROM player_game_stats pgs
        JOIN players p ON p.player_id=pgs.player_id
        WHERE pgs.game_pk=?
        ORDER BY pgs.points DESC,pgs.goals DESC,pgs.shots DESC,pgs.toi_seconds DESC
        LIMIT 20;
      `).bind(gamePk),
      env.DB.prepare(`
        SELECT ge.event_key,ge.event_type,ge.period_number,ge.period_type,ge.time_in_period,ge.team_tri,
               ge.home_score,ge.away_score,ge.description,
               GROUP_CONCAT(COALESCE(p.full_name_ru,p.full_name_en)||'|'||ep.role,';;') AS people
        FROM game_events ge
        LEFT JOIN event_players ep ON ep.event_key=ge.event_key
        LEFT JOIN players p ON p.player_id=ep.player_id
        WHERE ge.game_pk=? AND ge.event_type IN ('goal','shootout-goal','penalty','period-end')
        GROUP BY ge.event_key
        ORDER BY ge.sort_order DESC
        LIMIT 50;
      `).bind(gamePk),
      env.DB.prepare(`
        SELECT card_id,headline_ru,stat_text_ru,source_note_ru,status,shown_at,display_order
        FROM broadcast_cards
        WHERE game_pk=?
        ORDER BY CASE status WHEN 'shown' THEN 0 WHEN 'preview' THEN 1 ELSE 2 END,display_order,created_at;
      `).bind(gamePk),
    ]);

    const teamStats=teamStatsResult.results||[];
    const playerStats=playerStatsResult.results||[];
    return jsonResponse({
      ok:true,
      game,
      periods:periodsResult.results||[],
      team_stats:teamStats,
      top_players:playerStats,
      events:eventsResult.results||[],
      cards:buildQuickCards(game,teamStats,playerStats),
      persisted_cards:persistedCardsResult.results||[],
    });
  } catch (error) {
    console.error("broadcast game failed", error);
    return jsonResponse({ ok:false,error:"broadcast_game_failed" },500);
  }
}

function buildQuickCards(game, teamStats, playerStats) {
  const cards=[];
  const home=teamStats.find(r=>Number(r.is_home)===1);
  const away=teamStats.find(r=>Number(r.is_home)===0);
  if (home&&away&&home.shots!==null&&away.shots!==null) {
    const hs=Number(home.shots||0),as=Number(away.shots||0);
    const leader=hs===as?null:hs>as?game.home_tri:game.away_tri;
    cards.push({id:`${game.game_pk}:shots`,kind:"match",eyebrow:"БРОСКИ В СТВОР",value:`${as} — ${hs}`,title:leader?`${leader} чаще попадал в створ`:"Равенство по броскам",note:`${game.away_tri} — ${game.home_tri}`});
  }
  if (home&&away&&home.hits!==null&&away.hits!==null) {
    cards.push({id:`${game.game_pk}:hits`,kind:"match",eyebrow:"СИЛОВАЯ ИГРА",value:`${Number(away.hits||0)} — ${Number(home.hits||0)}`,title:"Хиты за матч",note:`${game.away_tri} — ${game.home_tri}`});
  }
  if (home&&away&&home.pim!==null&&away.pim!==null) {
    cards.push({id:`${game.game_pk}:pim`,kind:"match",eyebrow:"ШТРАФ",value:`${Number(away.pim||0)} — ${Number(home.pim||0)}`,title:"Штрафные минуты",note:`${game.away_tri} — ${game.home_tri}`});
  }
  const leader=playerStats.find(r=>Number(r.points||0)>0);
  if (leader) {
    const name=leader.full_name_ru||leader.full_name_en;
    cards.push({id:`${game.game_pk}:leader`,kind:"player",eyebrow:"ЛИДЕР МАТЧА",value:`${Number(leader.points||0)} ОЧК.`,title:name,note:`${Number(leader.goals||0)}+${Number(leader.assists||0)} · ${leader.team_tri}`});
  }
  const goalDiff=Math.abs(Number(game.home_score||0)-Number(game.away_score||0));
  const winner=Number(game.home_score||0)>Number(game.away_score||0)?game.home_tri:game.away_tri;
  cards.push({id:`${game.game_pk}:score`,kind:"match",eyebrow:"ФИНАЛЬНЫЙ СЧЁТ",value:`${game.away_score}:${game.home_score}`,title:goalDiff===0?"Матч завершён вничью":`${winner} победил${goalDiff>=3?" крупно":""}`,note:game.period_type==="OT"?"Овертайм":game.period_type==="SO"?"Буллиты":"Матч завершён"});
  return cards.slice(0,6);
}

function jsonResponse(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}})}
function htmlResponse(html){return new Response(html,{status:200,headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}})}

const DASHBOARD_HTML=String.raw`<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HOH Broadcast Control</title>
<style>
:root{--bg:#080808;--side:#0b0b0c;--panel:#111113;--panel2:#17171a;--line:#2a2a2f;--text:#f8f8f6;--muted:#85858d;--orange:#ff5a1f;--lav:#c8b7ff;--lav2:#7869a7;--green:#83e6b1;--red:#ff6161}
*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:var(--bg);color:var(--text);font-family:Inter,Arial,sans-serif}body{overflow-x:hidden}button{font:inherit}
.app{display:grid;grid-template-columns:290px minmax(0,1fr);min-height:100vh}.side{position:sticky;top:0;height:100vh;overflow:auto;border-right:1px solid var(--line);background:var(--side);padding:20px 16px}.brand{display:flex;align-items:center;justify-content:space-between;margin-bottom:26px}.brandname{display:flex;align-items:center;gap:10px;font-size:15px;font-weight:950}.mark{width:18px;height:18px;border-radius:4px;background:var(--orange);box-shadow:10px 0 0 var(--lav)}.alpha{font-size:9px;letter-spacing:.15em;color:#777;border:1px solid #29292e;padding:5px 8px;border-radius:99px}.label{font-size:9px;font-weight:900;letter-spacing:.16em;color:#67676f;text-transform:uppercase;margin:18px 6px 8px}.nav{display:grid;gap:4px}.navitem{padding:11px 12px;border-radius:11px;color:#9a9aa1;display:flex;align-items:center;gap:10px}.navitem.active{background:#1a1a1d;color:#fff}.dot{width:7px;height:7px;border-radius:50%;background:#53535a}.active .dot{background:var(--orange);box-shadow:0 0 0 5px rgba(255,90,31,.1)}.soon{margin-left:auto;font-size:10px;color:#555}.sidecount{font-size:10px;color:#6f6f76;margin:0 6px 10px}.games{display:grid;gap:5px}.game{border:1px solid transparent;border-radius:12px;background:transparent;color:inherit;padding:10px 11px;text-align:left;cursor:pointer}.game:hover{background:#141416}.game.active{background:#19191c;border-color:#35353b}.gline{display:flex;justify-content:space-between;gap:8px;align-items:center}.gteams{font-size:13px;font-weight:900}.gscore{font-size:18px;font-weight:950}.gmeta{display:flex;justify-content:space-between;gap:8px;margin-top:5px;color:#74747b;font-size:10px}.pill{font-size:8px;color:var(--lav);padding:3px 5px;background:rgba(200,183,255,.08);border-radius:5px;text-transform:uppercase}
.main{padding:22px 26px 40px;min-width:0;background:radial-gradient(circle at 88% -8%,rgba(200,183,255,.10),transparent 26%),radial-gradient(circle at 25% 110%,rgba(255,90,31,.07),transparent 34%)}.top{display:grid;grid-template-columns:1fr 360px;gap:14px;margin-bottom:16px}.heading{padding:5px 2px}.heading h1{font-size:13px;letter-spacing:.17em;margin:0;text-transform:uppercase}.heading p{margin:6px 0 0;color:#777;font-size:11px}.air{border:1px solid var(--line);background:#0f0f11;border-radius:14px;padding:12px 14px;display:flex;align-items:center;justify-content:space-between;gap:12px}.airtag{display:flex;align-items:center;gap:8px;font-size:10px;font-weight:900;letter-spacing:.12em}.airdot{width:8px;height:8px;border-radius:50%;background:#45454c}.air.live .airdot{background:var(--red);box-shadow:0 0 12px rgba(255,97,97,.7)}.airtext{font-size:11px;color:#8c8c94;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px}
.hero{border:1px solid var(--line);border-radius:20px;background:linear-gradient(135deg,#111113,#0f0f11 65%,#18141f);overflow:hidden}.herohead{display:flex;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--line);font-size:10px;color:#777}.match{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;padding:22px 26px;gap:20px}.team{display:flex;align-items:center;gap:14px}.team.home{justify-content:flex-end;text-align:right}.logo{width:58px;height:58px;border-radius:16px;border:1px solid #303036;background:#18181a;display:grid;place-items:center;overflow:hidden}.logo img{width:46px;height:46px;object-fit:contain}.fallback{font-size:18px;font-weight:950}.code{font-size:27px;font-weight:950;letter-spacing:-.05em}.name{margin-top:3px;color:#777;font-size:10px}.score{font-size:56px;font-weight:950;letter-spacing:-.08em}.score span{color:#46464d;margin:0 5px}.periods{text-align:center;color:var(--lav);font-size:9px;font-weight:900;letter-spacing:.09em;padding:0 18px 15px;text-transform:uppercase}
.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:10px 0 14px}.metric{border:1px solid var(--line);background:#101012;border-radius:14px;padding:13px 14px}.mval{font-size:22px;font-weight:950;letter-spacing:-.05em}.mlabel{font-size:9px;color:#696970;letter-spacing:.12em;text-transform:uppercase;margin-top:4px}
.work{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(330px,.65fr);gap:14px}.panel{border:1px solid var(--line);background:#0f0f11;border-radius:18px;overflow:hidden}.phead{padding:14px 16px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:10px}.ptitle{font-size:12px;font-weight:900}.psub{font-size:9px;color:#666}.cards{padding:12px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.card{border:1px solid #303036;border-radius:15px;background:#171719;overflow:hidden;position:relative}.card:before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--orange)}.card.lav:before{background:var(--lav)}.cardbody{padding:14px 15px 11px}.eyebrow{font-size:9px;color:#7c7c85;font-weight:900;letter-spacing:.13em}.cvalue{font-size:29px;font-weight:950;letter-spacing:-.06em;margin-top:12px}.ctitle{font-size:12px;font-weight:850;margin-top:8px}.cnote{font-size:9px;color:#73737b;margin-top:6px}.actions{display:grid;grid-template-columns:1fr 1.2fr;border-top:1px solid #29292e}.act{border:0;background:transparent;color:#aaa;padding:10px 8px;font-size:9px;font-weight:900;letter-spacing:.08em;cursor:pointer}.act:hover{background:#202024;color:#fff}.show{color:#111;background:var(--orange)}.show:hover{background:#ff6b36}.show[disabled]{background:#26262a;color:#64646b;cursor:not-allowed}.kind{position:absolute;right:10px;top:9px;font-size:8px;color:#65656d;text-transform:uppercase}
.rightcol{display:grid;gap:14px;align-content:start}.players{padding:4px 14px 12px}.prow{display:grid;grid-template-columns:minmax(0,1fr) 28px 28px 28px 34px;gap:5px;align-items:center;padding:10px 0;border-bottom:1px solid #252529}.prow.head{padding:8px 0;color:#666;font-size:8px;text-transform:uppercase}.pname{font-size:10px;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pmeta{font-size:8px;color:#6f6f76;margin-top:2px}.num{text-align:center;font-size:10px;font-weight:850}.events{padding:4px 14px 12px;max-height:310px;overflow:auto}.event{display:grid;grid-template-columns:44px 1fr auto;gap:8px;padding:9px 0;border-bottom:1px solid #242428}.etime{font-size:9px;color:var(--lav);font-weight:900}.etype{font-size:9px;font-weight:900}.edesc{font-size:8px;color:#73737b;margin-top:2px;line-height:1.35}.escore{font-size:11px;font-weight:950}.empty{padding:18px;color:#666;font-size:10px}
.drawerback{position:fixed;inset:0;background:rgba(0,0,0,.66);display:none;z-index:20}.drawerback.open{display:block}.drawer{position:absolute;right:0;top:0;bottom:0;width:min(520px,92vw);background:#101012;border-left:1px solid #303036;padding:24px;display:flex;flex-direction:column}.dtop{display:flex;justify-content:space-between;align-items:center}.dtitle{font-size:10px;letter-spacing:.16em;font-weight:900;color:#777}.close{border:1px solid #333;background:#171719;color:#aaa;border-radius:9px;padding:7px 10px;cursor:pointer}.preview{margin:auto 0;border-radius:24px;background:linear-gradient(135deg,#151517,#201a27);border:1px solid #37333f;padding:30px}.pvbrand{font-size:10px;letter-spacing:.16em;font-weight:950}.pveyebrow{margin-top:34px;color:var(--lav);font-size:10px;font-weight:900;letter-spacing:.12em}.pvvalue{font-size:58px;font-weight:950;letter-spacing:-.08em;margin-top:10px}.pvtitle{font-size:20px;font-weight:900;margin-top:10px;line-height:1.15}.pvnote{font-size:11px;color:#83838c;margin-top:12px}.dfoot{font-size:10px;color:#74747c;line-height:1.5;padding-top:20px}.legend{display:flex;gap:8px;align-items:center}.safe{display:inline-flex;align-items:center;gap:6px;color:#8d8d94}.safe:before{content:"";width:6px;height:6px;border-radius:50%;background:var(--green)}
@media(max-width:1100px){.app{grid-template-columns:240px 1fr}.work{grid-template-columns:1fr}.rightcol{grid-template-columns:1fr 1fr}.top{grid-template-columns:1fr}.air{max-width:none}.metrics{grid-template-columns:repeat(2,1fr)}}
@media(max-width:760px){.app{display:block}.side{position:relative;height:auto}.main{padding:16px}.match{grid-template-columns:1fr auto 1fr;padding:18px 12px}.logo{display:none}.score{font-size:42px}.code{font-size:22px}.cards{grid-template-columns:1fr}.rightcol{grid-template-columns:1fr}.metrics{grid-template-columns:1fr 1fr}}
</style></head><body>
<div class="app">
<aside class="side">
  <div class="brand"><div class="brandname"><span class="mark"></span>HOME OF HOCKEY</div><span class="alpha">ALPHA</span></div>
  <div class="label">Broadcast control</div>
  <div class="nav"><div class="navitem active"><span class="dot"></span>Матчи</div><div class="navitem"><span class="dot"></span>Карточки<span class="soon">soon</span></div><div class="navitem"><span class="dot"></span>Overlay<span class="soon">soon</span></div></div>
  <div class="label">Матчи в Data Core</div><div class="sidecount" id="counts">загрузка...</div><div class="games" id="games"></div>
</aside>
<main class="main">
  <div class="top"><div class="heading"><h1>Broadcast Stats / Control Room</h1><p>Реальные данные NHL → HOH Data Core → эфир</p></div><div class="air" id="air"><div class="airtag"><span class="airdot"></span><span>ON AIR</span></div><div class="airtext" id="airtext">Сейчас ничего не показано</div></div></div>
  <section class="hero" id="hero"><div class="empty">Выбираю матч...</div></section>
  <section class="metrics" id="metrics"></section>
  <section class="work">
    <div class="panel"><div class="phead"><div><div class="ptitle">Очередь карточек</div><div class="psub">Сейчас — факты из матча. Исторические инсайты добавятся следующим слоем.</div></div><div class="safe">ручной показ</div></div><div class="cards" id="cards"></div></div>
    <div class="rightcol">
      <div class="panel"><div class="phead"><div class="ptitle">Игроки</div><div class="psub">топ по очкам</div></div><div class="players" id="players"></div></div>
      <div class="panel"><div class="phead"><div class="ptitle">События</div><div class="psub">голы / удаления</div></div><div class="events" id="events"></div></div>
    </div>
  </section>
</main></div>
<div class="drawerback" id="drawer"><div class="drawer"><div class="dtop"><div class="dtitle">ПРЕДПРОСМОТР КАРТОЧКИ</div><button class="close" id="close">Закрыть</button></div><div class="preview"><div class="pvbrand">HOME OF HOCKEY × BROADCAST</div><div class="pveyebrow" id="pveyebrow"></div><div class="pvvalue" id="pvvalue"></div><div class="pvtitle" id="pvtitle"></div><div class="pvnote" id="pvnote"></div></div><div class="dfoot">PREVIEW уже работает локально. Кнопка «ПОКАЗАТЬ» намеренно пока заблокирована: в следующем шаге подключим защищённое состояние эфира и прозрачный overlay для vMix/OBS, чтобы интерфейс не притворялся рабочим раньше времени.</div></div></div>
<script>
const $=s=>document.querySelector(s);let games=[],selected=null,currentCards=[];
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function fmtDate(v){if(!v)return'';const d=new Date(v);return d.toLocaleString('ru-RU',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}).replace(',',' ·')}
function typeLabel(t){return Number(t)===3?'Плей-офф':'Регулярка'}
async function api(url){const r=await fetch(url,{cache:'no-store'});if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}
async function load(){try{const [g,s]=await Promise.all([api('/api/broadcast/games'),api('/api/broadcast/state')]);games=g.games||[];$('#counts').textContent=`${g.counts.games} игр · ${g.counts.players} игроков · ${g.counts.teams} команды`;renderGames();renderAir(s.on_air);if(games.length)await selectGame(games[0].game_pk)}catch(e){$('#hero').innerHTML='<div class="empty">Не удалось загрузить Data Core</div>'}}
function renderAir(card){const air=$('#air'),text=$('#airtext');if(card){air.classList.add('live');text.textContent=`${card.headline_ru}: ${card.stat_text_ru}`}else{air.classList.remove('live');text.textContent='Сейчас ничего не показано'}}
function renderGames(){$('#games').innerHTML=games.map(g=>`<button class="game ${Number(g.game_pk)===Number(selected)?'active':''}" data-id="${g.game_pk}"><div class="gline"><span class="gteams">${esc(g.away_tri)} · ${esc(g.home_tri)}</span><span class="gscore">${g.away_score}:${g.home_score}</span></div><div class="gmeta"><span>${esc(fmtDate(g.scheduled_start_utc))}</span><span class="pill">${typeLabel(g.game_type)}</span></div></button>`).join('');document.querySelectorAll('.game').forEach(b=>b.onclick=()=>selectGame(Number(b.dataset.id)))}
async function selectGame(id){selected=id;renderGames();$('#hero').innerHTML='<div class="empty">Загружаю матч...</div>';const d=await api('/api/broadcast/games/'+id);renderGame(d)}
function teamHtml(g,side){const tri=g[side+'_tri'],name=g[side+'_name_ru']||g[side+'_name']||tri,logo=g[side+'_logo'];return `<div class="team ${side==='home'?'home':''}">${side==='home'?`<div><div class="code">${esc(tri)}</div><div class="name">${esc(name)}</div></div>`:''}<div class="logo">${logo?`<img src="${esc(logo)}" alt="">`:`<span class="fallback">${esc(tri)}</span>`}</div>${side==='away'?`<div><div class="code">${esc(tri)}</div><div class="name">${esc(name)}</div></div>`:''}</div>`}
function renderGame(d){const g=d.game,periods=d.periods||[];$('#hero').innerHTML=`<div class="herohead"><span>${typeLabel(g.game_type)} · ${esc(g.season_id)}</span><span>${esc(fmtDate(g.scheduled_start_utc))}${g.venue_name?' · '+esc(g.venue_name):''}</span></div><div class="match">${teamHtml(g,'away')}<div class="score">${g.away_score}<span>:</span>${g.home_score}</div>${teamHtml(g,'home')}</div><div class="periods">${esc(g.game_state)} · ${periods.map(p=>'P'+p.period_number+' '+p.away_goals+':'+p.home_goals).join(' · ')}</div>`;renderMetrics(d);renderCards(d.cards||[]);renderPlayers(d.top_players||[]);renderEvents(d.events||[])}
function renderMetrics(d){const a=(d.team_stats||[]).find(x=>Number(x.is_home)===0)||{},h=(d.team_stats||[]).find(x=>Number(x.is_home)===1)||{},g=d.game;const rows=[['Броски в створ',a.shots,h.shots],['Хиты',a.hits,h.hits],['Штрафные минуты',a.pim,h.pim],['Вбрасывания',a.faceoff_pct===null?null:Math.round(Number(a.faceoff_pct)*100)+'%',h.faceoff_pct===null?null:Math.round(Number(h.faceoff_pct)*100)+'%']];$('#metrics').innerHTML=rows.map(r=>`<div class="metric"><div class="mval">${esc(r[1]??'—')} — ${esc(r[2]??'—')}</div><div class="mlabel">${esc(r[0])} · ${esc(g.away_tri)} / ${esc(g.home_tri)}</div></div>`).join('')}
function renderCards(cards){currentCards=cards;$('#cards').innerHTML=cards.length?cards.map((c,i)=>`<article class="card ${i%2?'lav':''}"><span class="kind">${c.kind==='player'?'игрок':'матч'}</span><div class="cardbody"><div class="eyebrow">${esc(c.eyebrow)}</div><div class="cvalue">${esc(c.value)}</div><div class="ctitle">${esc(c.title)}</div><div class="cnote">${esc(c.note)}</div></div><div class="actions"><button class="act previewbtn" data-i="${i}">PREVIEW</button><button class="act show" disabled title="Подключим защищённый эфир следующим шагом">ПОКАЗАТЬ</button></div></article>`).join(''):'<div class="empty">Пока нет карточек</div>';document.querySelectorAll('.previewbtn').forEach(b=>b.onclick=()=>previewCard(Number(b.dataset.i)))}
function previewCard(i){const c=currentCards[i];if(!c)return;$('#pveyebrow').textContent=c.eyebrow;$('#pvvalue').textContent=c.value;$('#pvtitle').textContent=c.title;$('#pvnote').textContent=c.note;$('#drawer').classList.add('open')}
function renderPlayers(rows){$('#players').innerHTML=`<div class="prow head"><div>Игрок</div><div class="num">Г</div><div class="num">П</div><div class="num">О</div><div class="num">Бр</div></div>`+(rows.length?rows.slice(0,10).map(p=>`<div class="prow"><div><div class="pname">${esc(p.full_name_ru||p.full_name_en)}</div><div class="pmeta">${esc(p.team_tri)} · ${esc(p.position_code||'—')} · #${esc(p.sweater_number??'—')}</div></div><div class="num">${p.goals??0}</div><div class="num">${p.assists??0}</div><div class="num">${p.points??0}</div><div class="num">${p.shots??'—'}</div></div>`).join(''):'<div class="empty">Нет статистики</div>')}
function renderEvents(rows){$('#events').innerHTML=rows.length?rows.slice(0,18).map(e=>`<div class="event"><div class="etime">P${esc(e.period_number??'—')} ${esc(e.time_in_period||'')}</div><div><div class="etype">${e.event_type==='goal'||e.event_type==='shootout-goal'?'ГОЛ':e.event_type==='penalty'?'УДАЛЕНИЕ':'КОНЕЦ ПЕРИОДА'}${e.team_tri?' · '+esc(e.team_tri):''}</div><div class="edesc">${esc(e.description||peopleText(e.people)||'')}</div></div><div class="escore">${e.away_score??''}${e.away_score!==null&&e.away_score!==undefined?':':''}${e.home_score??''}</div></div>`).join(''):'<div class="empty">Нет ключевых событий</div>'}
function peopleText(v){return String(v||'').split(';;').map(x=>x.split('|')[0]).filter(Boolean).join(', ')}
$('#close').onclick=()=>$('#drawer').classList.remove('open');$('#drawer').onclick=e=>{if(e.target===$('#drawer'))$('#drawer').classList.remove('open')};load();
</script></body></html>`;