const BROADCAST_PATH = "/broadcast";

export async function handleBroadcastRequest(request, env, path) {
  if (path === BROADCAST_PATH) {
    if (request.method !== "GET") {
      return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
    }
    return htmlResponse(DASHBOARD_HTML);
  }

  if (path === "/api/broadcast/games") {
    if (request.method !== "GET") {
      return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
    }
    return broadcastGamesRoute(env);
  }

  const gameMatch = /^\/api\/broadcast\/games\/(\d+)$/.exec(path);
  if (gameMatch) {
    if (request.method !== "GET") {
      return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
    }
    return broadcastGameRoute(env, Number(gameMatch[1]));
  }

  return null;
}

async function broadcastGamesRoute(env) {
  if (!env.DB) {
    return jsonResponse({ ok: false, error: "missing_d1_binding" }, 503);
  }

  try {
    const [gamesResult, countsRow] = await Promise.all([
      env.DB.prepare(
        `SELECT
           g.game_pk,
           g.season_id,
           g.game_type,
           g.scheduled_start_utc,
           g.game_state,
           g.home_tri,
           g.away_tri,
           g.home_score,
           g.away_score,
           g.current_period,
           g.period_type,
           g.venue_name,
           ht.name_en AS home_name,
           ht.name_ru AS home_name_ru,
           ht.logo_url AS home_logo,
           at.name_en AS away_name,
           at.name_ru AS away_name_ru,
           at.logo_url AS away_logo
         FROM games g
         LEFT JOIN teams ht ON ht.tri_code = g.home_tri
         LEFT JOIN teams at ON at.tri_code = g.away_tri
         WHERE g.game_type IN (2, 3)
         ORDER BY g.scheduled_start_utc DESC
         LIMIT 80;`,
      ).all(),
      env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM games WHERE game_type IN (2, 3)) AS games,
           (SELECT COUNT(*) FROM players) AS players,
           (SELECT COUNT(*) FROM teams) AS teams;`,
      ).first(),
    ]);

    return jsonResponse({
      ok: true,
      counts: {
        games: Number(countsRow?.games || 0),
        players: Number(countsRow?.players || 0),
        teams: Number(countsRow?.teams || 0),
      },
      games: gamesResult.results || [],
    });
  } catch (error) {
    console.error("broadcast games failed", error);
    return jsonResponse({ ok: false, error: "broadcast_games_failed" }, 500);
  }
}

async function broadcastGameRoute(env, gamePk) {
  if (!env.DB) {
    return jsonResponse({ ok: false, error: "missing_d1_binding" }, 503);
  }
  if (!Number.isSafeInteger(gamePk) || gamePk <= 0) {
    return jsonResponse({ ok: false, error: "invalid_game_pk" }, 400);
  }

  try {
    const game = await env.DB.prepare(
      `SELECT
         g.*,
         ht.name_en AS home_name,
         ht.name_ru AS home_name_ru,
         ht.logo_url AS home_logo,
         at.name_en AS away_name,
         at.name_ru AS away_name_ru,
         at.logo_url AS away_logo
       FROM games g
       LEFT JOIN teams ht ON ht.tri_code = g.home_tri
       LEFT JOIN teams at ON at.tri_code = g.away_tri
       WHERE g.game_pk = ? AND g.game_type IN (2, 3)
       LIMIT 1;`,
    ).bind(gamePk).first();

    if (!game) {
      return jsonResponse({ ok: false, error: "game_not_found" }, 404);
    }

    const [periodsResult, teamStatsResult, playerStatsResult, eventsResult] = await env.DB.batch([
      env.DB.prepare(
        `SELECT period_number, period_type, home_goals, away_goals
         FROM period_scores
         WHERE game_pk = ?
         ORDER BY period_number, period_type;`,
      ).bind(gamePk),
      env.DB.prepare(
        `SELECT *
         FROM team_game_stats
         WHERE game_pk = ?
         ORDER BY is_home ASC;`,
      ).bind(gamePk),
      env.DB.prepare(
        `SELECT
           pgs.player_id,
           pgs.team_tri,
           pgs.goals,
           pgs.assists,
           pgs.points,
           pgs.shots,
           pgs.hits,
           pgs.blocked_shots,
           pgs.pim,
           pgs.plus_minus,
           pgs.toi_seconds,
           p.full_name_en,
           p.full_name_ru,
           p.position_code,
           p.sweater_number
         FROM player_game_stats pgs
         JOIN players p ON p.player_id = pgs.player_id
         WHERE pgs.game_pk = ?
         ORDER BY pgs.points DESC, pgs.goals DESC, pgs.shots DESC, pgs.toi_seconds DESC
         LIMIT 16;`,
      ).bind(gamePk),
      env.DB.prepare(
        `SELECT
           ge.event_key,
           ge.event_type,
           ge.period_number,
           ge.period_type,
           ge.time_in_period,
           ge.team_tri,
           ge.home_score,
           ge.away_score,
           ge.description,
           GROUP_CONCAT(
             COALESCE(p.full_name_ru, p.full_name_en) || '|' || ep.role,
             ';;'
           ) AS people
         FROM game_events ge
         LEFT JOIN event_players ep ON ep.event_key = ge.event_key
         LEFT JOIN players p ON p.player_id = ep.player_id
         WHERE ge.game_pk = ?
           AND ge.event_type IN ('goal', 'shootout-goal', 'penalty', 'period-end')
         GROUP BY ge.event_key
         ORDER BY ge.sort_order DESC
         LIMIT 40;`,
      ).bind(gamePk),
    ]);

    const periods = periodsResult.results || [];
    const teamStats = teamStatsResult.results || [];
    const playerStats = playerStatsResult.results || [];
    const events = eventsResult.results || [];

    return jsonResponse({
      ok: true,
      game,
      periods,
      team_stats: teamStats,
      top_players: playerStats,
      events,
      cards: buildQuickCards(game, teamStats, playerStats),
    });
  } catch (error) {
    console.error("broadcast game failed", error);
    return jsonResponse({ ok: false, error: "broadcast_game_failed" }, 500);
  }
}

function buildQuickCards(game, teamStats, playerStats) {
  const cards = [];
  const home = teamStats.find((row) => Number(row.is_home) === 1);
  const away = teamStats.find((row) => Number(row.is_home) === 0);

  if (home && away && home.shots !== null && away.shots !== null) {
    const homeShots = Number(home.shots || 0);
    const awayShots = Number(away.shots || 0);
    const leader = homeShots === awayShots ? null : homeShots > awayShots ? game.home_tri : game.away_tri;
    cards.push({
      type: "shots",
      eyebrow: "БРОСКИ В СТВОР",
      value: `${awayShots} — ${homeShots}`,
      title: leader ? `${leader} чаще попадал в створ` : "Равенство по броскам",
      note: `${game.away_tri} — ${game.home_tri}`,
    });
  }

  if (home && away && home.hits !== null && away.hits !== null) {
    const homeHits = Number(home.hits || 0);
    const awayHits = Number(away.hits || 0);
    cards.push({
      type: "hits",
      eyebrow: "СИЛОВАЯ ИГРА",
      value: `${awayHits} — ${homeHits}`,
      title: "Хиты за матч",
      note: `${game.away_tri} — ${game.home_tri}`,
    });
  }

  const leader = playerStats.find((row) => Number(row.points || 0) > 0);
  if (leader) {
    const name = leader.full_name_ru || leader.full_name_en;
    cards.push({
      type: "leader",
      eyebrow: "ЛИДЕР МАТЧА",
      value: `${Number(leader.points || 0)} ОЧК.`,
      title: name,
      note: `${Number(leader.goals || 0)}+${Number(leader.assists || 0)} · ${leader.team_tri}`,
    });
  }

  const goalDiff = Math.abs(Number(game.home_score || 0) - Number(game.away_score || 0));
  const winner = Number(game.home_score || 0) > Number(game.away_score || 0) ? game.home_tri : game.away_tri;
  cards.push({
    type: "score",
    eyebrow: "ФИНАЛЬНЫЙ СЧЁТ",
    value: `${game.away_score}:${game.home_score}`,
    title: goalDiff === 0 ? "Матч завершён вничью" : `${winner} победил${goalDiff >= 3 ? " крупно" : ""}`,
    note: game.period_type === "OT" ? "Овертайм" : game.period_type === "SO" ? "Буллиты" : "Матч завершён",
  });

  return cards.slice(0, 4);
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function htmlResponse(html) {
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>HOH Broadcast Stats</title>
  <style>
    :root {
      --bg:#080808;
      --panel:#111111;
      --panel-2:#171717;
      --line:#292929;
      --text:#f7f7f7;
      --muted:#8f8f95;
      --orange:#ff5b21;
      --lavender:#c8b8ff;
      --lavender-2:#7968b3;
      --good:#8ee6b5;
    }
    *{box-sizing:border-box}
    html,body{margin:0;min-height:100%;background:var(--bg);color:var(--text);font-family:Inter,Arial,sans-serif}
    body:before{content:"";position:fixed;inset:0;pointer-events:none;background:radial-gradient(circle at 90% -5%,rgba(200,184,255,.14),transparent 32%),radial-gradient(circle at 5% 105%,rgba(255,91,33,.11),transparent 35%)}
    button{font:inherit}
    .shell{position:relative;display:grid;grid-template-columns:330px minmax(0,1fr);min-height:100vh}
    .sidebar{border-right:1px solid var(--line);padding:24px 18px;display:flex;flex-direction:column;gap:24px;background:rgba(8,8,8,.88);backdrop-filter:blur(18px);position:sticky;top:0;height:100vh;overflow:auto}
    .brand{display:flex;align-items:center;justify-content:space-between;padding:0 6px}
    .brand-mark{display:flex;align-items:center;gap:10px;font-weight:900;letter-spacing:-.03em}.brand-dot{width:18px;height:18px;background:var(--orange);border-radius:4px;box-shadow:11px 0 0 var(--lavender)}
    .beta{font-size:10px;letter-spacing:.14em;color:var(--muted);border:1px solid var(--line);border-radius:99px;padding:5px 8px}
    .nav-label,.section-label{font-size:10px;font-weight:800;letter-spacing:.15em;color:#67676d;text-transform:uppercase}
    .nav{display:grid;gap:6px}.nav-item{display:flex;gap:12px;align-items:center;padding:12px;border-radius:12px;color:#999;text-decoration:none}.nav-item.active{background:#191919;color:white}.nav-icon{width:8px;height:8px;border-radius:50%;background:#555}.nav-item.active .nav-icon{background:var(--orange);box-shadow:0 0 0 5px rgba(255,91,33,.12)}
    .games-list{display:grid;gap:8px}.game-btn{width:100%;text-align:left;border:1px solid transparent;background:transparent;color:inherit;border-radius:14px;padding:12px;cursor:pointer;transition:.16s}.game-btn:hover{background:#141414}.game-btn.active{background:#171717;border-color:#333}.game-row{display:flex;align-items:center;justify-content:space-between;gap:10px}.teams-mini{font-weight:800;font-size:14px}.score-mini{font-size:20px;font-weight:900;letter-spacing:-.05em}.date-mini{margin-top:5px;color:#777;font-size:11px}.season-pill{font-size:9px;color:var(--lavender);background:rgba(200,184,255,.08);padding:4px 6px;border-radius:6px}
    .main{padding:28px 34px 60px;min-width:0}.topbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:34px}.title h1{margin:0;font-size:14px;text-transform:uppercase;letter-spacing:.16em}.title p{margin:6px 0 0;color:var(--muted);font-size:12px}.health{display:flex;align-items:center;gap:8px;color:#aaa;font-size:11px}.health:before{content:"";width:7px;height:7px;background:var(--good);border-radius:50%;box-shadow:0 0 12px rgba(142,230,181,.65)}
    .hero{border:1px solid var(--line);border-radius:24px;overflow:hidden;background:linear-gradient(135deg,#111 0%,#0d0d0d 58%,#17131f 100%);position:relative}.hero:after{content:"";position:absolute;right:-70px;top:-120px;width:320px;height:320px;border:70px solid rgba(200,184,255,.035);border-radius:50%}.hero-head{padding:22px 24px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;color:#777;font-size:11px}.matchup{padding:38px 42px;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:28px}.team{display:flex;align-items:center;gap:18px}.team.home{justify-content:flex-end;text-align:right}.logo{width:74px;height:74px;border-radius:20px;background:#181818;border:1px solid #2d2d2d;display:grid;place-items:center;overflow:hidden;flex:0 0 auto}.logo img{width:58px;height:58px;object-fit:contain}.fallback-logo{font-size:22px;font-weight:950;letter-spacing:-.06em}.team-code{font-size:34px;font-weight:950;letter-spacing:-.06em}.team-name{font-size:12px;color:#777;margin-top:3px}.score{font-size:72px;font-weight:950;letter-spacing:-.09em;white-space:nowrap}.score span{color:#48484e;margin:0 7px}.status-line{text-align:center;color:var(--lavender);font-weight:800;font-size:10px;letter-spacing:.12em;margin-top:-12px;padding-bottom:26px;text-transform:uppercase}
    .metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:14px 0 30px}.metric{border:1px solid var(--line);border-radius:15px;padding:14px 16px;background:#0e0e0e}.metric-value{font-weight:900;font-size:22px;letter-spacing:-.04em}.metric-name{font-size:10px;color:#6e6e74;text-transform:uppercase;letter-spacing:.1em;margin-top:5px}
    .grid{display:grid;grid-template-columns:minmax(0,1.28fr) minmax(300px,.72fr);gap:18px}.block{border:1px solid var(--line);background:rgba(15,15,15,.8);border-radius:20px;padding:20px}.block-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}.block-title{font-weight:900;font-size:13px;letter-spacing:.02em}.hint{font-size:10px;color:#666}
    .cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.card{min-height:160px;border-radius:16px;padding:17px;background:#181818;border:1px solid #272727;display:flex;flex-direction:column;justify-content:space-between;position:relative;overflow:hidden}.card:nth-child(2n){background:linear-gradient(145deg,#17141f,#151515)}.card:before{content:"";position:absolute;left:0;top:0;width:3px;height:46px;background:var(--orange)}.card:nth-child(2n):before{background:var(--lavender)}.eyebrow{font-size:9px;letter-spacing:.14em;color:#777;font-weight:900}.card-value{font-size:34px;font-weight:950;letter-spacing:-.06em;margin-top:12px}.card-title{font-size:13px;font-weight:800;margin-top:7px}.card-note{font-size:10px;color:#6e6e74;margin-top:4px}
    .players{display:grid;gap:1px}.player{display:grid;grid-template-columns:1fr 36px 36px 36px;align-items:center;gap:6px;padding:11px 8px;border-bottom:1px solid #202020}.player:last-child{border:0}.player-name{font-size:12px;font-weight:750}.player-meta{color:#666;font-size:10px;margin-top:3px}.num{text-align:center;font-weight:900;font-size:12px}.num-head{font-size:9px;color:#5f5f64;font-weight:700}
    .events{display:grid;gap:10px}.event{display:grid;grid-template-columns:52px 1fr;gap:12px;padding:10px 0;border-bottom:1px solid #202020}.event:last-child{border:0}.event-time{font-weight:900;font-size:12px}.event-period{font-size:9px;color:#666;margin-top:3px}.event-title{font-size:12px;font-weight:800}.event-sub{font-size:10px;color:#6f6f75;margin-top:4px;line-height:1.35}.goal-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--orange);margin-right:6px}.penalty-dot{background:var(--lavender)}
    .empty{border:1px dashed #303036;border-radius:18px;padding:50px 20px;text-align:center;color:#777}.empty strong{display:block;color:#bbb;margin-bottom:8px}.loading{opacity:.5;pointer-events:none}.error{padding:18px;border:1px solid #5a2929;background:#211111;border-radius:14px;color:#ffb5b5;margin-bottom:20px;display:none}
    @media(max-width:1050px){.shell{grid-template-columns:260px minmax(0,1fr)}.matchup{padding:30px 24px}.score{font-size:54px}.team-code{font-size:26px}.logo{width:58px;height:58px}.grid{grid-template-columns:1fr}.cards{grid-template-columns:repeat(2,1fr)}}
    @media(max-width:760px){.shell{display:block}.sidebar{position:relative;width:auto;height:auto;border-right:0;border-bottom:1px solid var(--line)}.nav{display:none}.games-list{display:flex;overflow:auto}.game-btn{min-width:180px}.main{padding:22px 16px}.matchup{grid-template-columns:1fr auto 1fr;gap:10px}.team{display:block}.team.home{display:flex;flex-direction:column-reverse;align-items:flex-end}.team.away{display:flex;flex-direction:column;align-items:flex-start}.logo{width:48px;height:48px}.logo img{width:38px;height:38px}.team-name{display:none}.team-code{font-size:21px}.score{font-size:42px}.metrics{grid-template-columns:repeat(3,1fr)}.cards{grid-template-columns:1fr}}
  </style>
</head>
<body>
<div class="shell">
  <aside class="sidebar">
    <div class="brand"><div class="brand-mark"><span class="brand-dot"></span><span>HOME OF HOCKEY</span></div><span class="beta">ALPHA</span></div>
    <div class="nav">
      <div class="nav-label">Broadcast control</div>
      <a class="nav-item active" href="#"><span class="nav-icon"></span>Матчи</a>
      <a class="nav-item" href="#"><span class="nav-icon"></span>Карточки <span style="margin-left:auto;color:#555">soon</span></a>
      <a class="nav-item" href="#"><span class="nav-icon"></span>Overlay <span style="margin-left:auto;color:#555">soon</span></a>
    </div>
    <div>
      <div class="section-label" style="padding:0 8px 9px">Матчи в Data Core</div>
      <div id="games" class="games-list"><div class="empty">Загрузка…</div></div>
    </div>
  </aside>

  <main class="main">
    <div class="topbar">
      <div class="title"><h1>Broadcast Stats / Control Room</h1><p>Данные NHL → HOH Data Core → эфир</p></div>
      <div class="health">DATA CORE ONLINE</div>
    </div>
    <div id="error" class="error"></div>
    <div id="content"><div class="empty"><strong>Выберите матч</strong>Здесь появятся реальные данные из D1</div></div>
  </main>
</div>
<script>
  const state = { games: [], selected: null };
  const gamesEl = document.getElementById('games');
  const contentEl = document.getElementById('content');
  const errorEl = document.getElementById('error');

  function esc(value){return String(value ?? '').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
  function dateText(value){if(!value)return '—';const d=new Date(value);return new Intl.DateTimeFormat('ru-RU',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(d)}
  function gameType(type){return Number(type)===3?'PLAYOFFS':'REGULAR'}
  function teamName(game, side){return game[side+'_name_ru']||game[side+'_name']||game[side+'_tri']}
  function logo(game, side){const url=game[side+'_logo'];const code=game[side+'_tri'];return '<div class="logo">'+(url?'<img src="'+esc(url)+'" alt="'+esc(code)+'" />':'<span class="fallback-logo">'+esc(code)+'</span>')+'</div>'}
  function metric(value,name){return '<div class="metric"><div class="metric-value">'+esc(value ?? '—')+'</div><div class="metric-name">'+esc(name)+'</div></div>'}

  async function loadGames(){
    try{
      const res=await fetch('/api/broadcast/games');
      const data=await res.json();
      if(!data.ok)throw new Error(data.error||'Ошибка загрузки матчей');
      state.games=data.games||[];
      renderGames(data.counts||{});
      if(state.games.length)selectGame(state.games[0].game_pk);
      else contentEl.innerHTML='<div class="empty"><strong>Матчей пока нет</strong>Backfill продолжит наполнять Data Core</div>';
    }catch(err){showError(err.message)}
  }

  function renderGames(counts){
    const header='<div style="padding:4px 8px 10px;color:#666;font-size:10px">'+esc(counts.games||0)+' игр · '+esc(counts.players||0)+' игроков · '+esc(counts.teams||0)+' команды</div>';
    gamesEl.innerHTML=header+state.games.map(g=>'<button class="game-btn '+(String(g.game_pk)===String(state.selected)?'active':'')+'" data-id="'+esc(g.game_pk)+'"><div class="game-row"><div><div class="teams-mini">'+esc(g.away_tri)+' · '+esc(g.home_tri)+'</div><div class="date-mini">'+esc(dateText(g.scheduled_start_utc))+'</div></div><div style="text-align:right"><div class="score-mini">'+esc(g.away_score)+':'+esc(g.home_score)+'</div><span class="season-pill">'+gameType(g.game_type)+'</span></div></div></button>').join('');
    gamesEl.querySelectorAll('.game-btn').forEach(btn=>btn.addEventListener('click',()=>selectGame(btn.dataset.id)));
  }

  async function selectGame(id){
    state.selected=String(id);
    document.querySelectorAll('.game-btn').forEach(btn=>btn.classList.toggle('active',btn.dataset.id===state.selected));
    contentEl.classList.add('loading');
    try{
      const res=await fetch('/api/broadcast/games/'+encodeURIComponent(id));
      const data=await res.json();
      if(!data.ok)throw new Error(data.error||'Ошибка матча');
      renderGame(data);
      hideError();
    }catch(err){showError(err.message)}finally{contentEl.classList.remove('loading')}
  }

  function renderGame(data){
    const g=data.game;
    const awayStats=(data.team_stats||[]).find(x=>Number(x.is_home)===0)||{};
    const homeStats=(data.team_stats||[]).find(x=>Number(x.is_home)===1)||{};
    const cards=(data.cards||[]).map(c=>'<div class="card"><div><div class="eyebrow">'+esc(c.eyebrow)+'</div><div class="card-value">'+esc(c.value)+'</div><div class="card-title">'+esc(c.title)+'</div></div><div class="card-note">'+esc(c.note)+'</div></div>').join('');
    const players=(data.top_players||[]).slice(0,10).map(p=>'<div class="player"><div><div class="player-name">'+esc(p.full_name_ru||p.full_name_en)+'</div><div class="player-meta">'+esc(p.team_tri)+' · '+esc(p.position_code||'')+(p.sweater_number?' · #'+esc(p.sweater_number):'')+'</div></div><div class="num">'+esc(p.goals)+'</div><div class="num">'+esc(p.assists)+'</div><div class="num">'+esc(p.points)+'</div></div>').join('');
    const events=(data.events||[]).slice().reverse().map(e=>{const penalty=e.event_type==='penalty';return '<div class="event"><div><div class="event-time">'+esc(e.time_in_period||'—')+'</div><div class="event-period">P'+esc(e.period_number||'')+'</div></div><div><div class="event-title"><span class="goal-dot '+(penalty?'penalty-dot':'')+'"></span>'+esc(eventTitle(e))+'</div><div class="event-sub">'+esc(eventPeople(e.people)||e.description||'')+'</div></div></div>'}).join('');
    const periods=(data.periods||[]).map(p=>'P'+p.period_number+' '+p.away_goals+':'+p.home_goals).join(' · ');

    contentEl.innerHTML='<section class="hero"><div class="hero-head"><span>'+esc(gameType(g.game_type))+' · '+esc(g.season_id)+'</span><span>'+esc(dateText(g.scheduled_start_utc))+' · '+esc(g.venue_name||'NHL')+'</span></div><div class="matchup"><div class="team away">'+logo(g,'away')+'<div><div class="team-code">'+esc(g.away_tri)+'</div><div class="team-name">'+esc(teamName(g,'away'))+'</div></div></div><div class="score">'+esc(g.away_score)+'<span>:</span>'+esc(g.home_score)+'</div><div class="team home"><div><div class="team-code">'+esc(g.home_tri)+'</div><div class="team-name">'+esc(teamName(g,'home'))+'</div></div>'+logo(g,'home')+'</div></div><div class="status-line">'+esc(g.game_state)+' · '+esc(periods||'FINAL')+'</div></section>'+
      '<div class="metrics">'+metric((awayStats.shots??'—')+' — '+(homeStats.shots??'—'),'Броски в створ')+metric((awayStats.hits??'—')+' — '+(homeStats.hits??'—'),'Хиты')+metric((awayStats.pim??'—')+' — '+(homeStats.pim??'—'),'Штрафные минуты')+'</div>'+
      '<div class="grid"><div><section class="block"><div class="block-head"><div class="block-title">Кандидаты для эфира</div><div class="hint">автоматически из матча · история позже</div></div><div class="cards">'+(cards||'<div class="empty">Нет карточек</div>')+'</div></section><section class="block" style="margin-top:18px"><div class="block-head"><div class="block-title">Ключевые события</div><div class="hint">голы · удаления · конец периода</div></div><div class="events">'+(events||'<div class="empty">Нет событий</div>')+'</div></section></div><section class="block"><div class="block-head"><div class="block-title">Игроки</div><div class="hint">топ по очкам</div></div><div class="player" style="padding-top:0"><div></div><div class="num-head">Г</div><div class="num-head">П</div><div class="num-head">О</div></div><div class="players">'+(players||'<div class="empty">Нет статистики</div>')+'</div></section></div>';
  }

  function eventTitle(e){if(e.event_type==='goal')return 'Гол · '+(e.team_tri||'');if(e.event_type==='shootout-goal')return 'Буллит · '+(e.team_tri||'');if(e.event_type==='penalty')return 'Удаление · '+(e.team_tri||'');if(e.event_type==='period-end')return 'Конец периода';return e.event_type}
  function eventPeople(raw){if(!raw)return '';return String(raw).split(';;').map(x=>{const [name,role]=x.split('|');return role?name+' ('+role+')':name}).join(', ')}
  function showError(message){errorEl.style.display='block';errorEl.textContent=message}
  function hideError(){errorEl.style.display='none';errorEl.textContent=''}
  loadGames();
</script>
</body>
</html>`;
