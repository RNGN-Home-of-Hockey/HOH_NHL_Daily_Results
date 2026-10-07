const DEFAULT_SEASON = "2025-26";
const ALLOWED_WINDOWS = new Set([3, 5, 10]);
const METRICS = [
  { key: "pts25", field: "pts", threshold: 25, label: "25+ ОЧКОВ", weight: 3 },
  { key: "pts30", field: "pts", threshold: 30, label: "30+ ОЧКОВ", weight: 8 },
  { key: "reb10", field: "reb", threshold: 10, label: "10+ ПОДБОРОВ", weight: 6 },
  { key: "reb12", field: "reb", threshold: 12, label: "12+ ПОДБОРОВ", weight: 9 },
  { key: "ast7", field: "ast", threshold: 7, label: "7+ ПЕРЕДАЧ", weight: 6 },
  { key: "ast10", field: "ast", threshold: 10, label: "10+ ПЕРЕДАЧ", weight: 10 },
  { key: "fg3m3", field: "fg3m", threshold: 3, label: "3+ ТРЁХОЧКОВЫХ", weight: 7 },
  { key: "fg3m4", field: "fg3m", threshold: 4, label: "4+ ТРЁХОЧКОВЫХ", weight: 10 },
  { key: "blk2", field: "blk", threshold: 2, label: "2+ БЛОК-ШОТА", weight: 8 },
  { key: "blk3", field: "blk", threshold: 3, label: "3+ БЛОК-ШОТА", weight: 12 },
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);
    if (!env.DB) return json({ ok: false, error: "missing_d1_binding" }, 503);
    if (url.pathname === "/api/health") return health(env.DB);
    if (url.pathname === "/api/cards") return cards(request, env.DB);
    if (url.pathname === "/" || url.pathname === "/broadcast") return html(APP_HTML);
    return json({ ok: false, error: "not_found" }, 404);
  },
};

async function health(db) {
  const row = await db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM nba_games) AS games,
      (SELECT COUNT(*) FROM nba_player_game_stats) AS player_rows,
      (SELECT COUNT(*) FROM nba_team_game_stats) AS team_rows,
      (SELECT MAX(game_date) FROM nba_games) AS last_game_date,
      (SELECT COUNT(DISTINCT season_year) FROM nba_games) AS seasons
  `).first();
  return json({ ok: true, service: "rngn-nba-broadcast", database: "hoh-data-core", namespace: "nba_*", ...row });
}

async function cards(request, db) {
  const url = new URL(request.url);
  const season = String(url.searchParams.get("season") || DEFAULT_SEASON).trim();
  const requestedWindow = Number(url.searchParams.get("window") || 10);
  const window = ALLOWED_WINDOWS.has(requestedWindow) ? requestedWindow : 10;

  const query = `
    WITH ranked AS (
      SELECT
        game_id, player_id, player_name, team_abbr, game_date,
        COALESCE(pts,0) pts, COALESCE(reb,0) reb, COALESCE(ast,0) ast,
        COALESCE(fg3m,0) fg3m, COALESCE(blk,0) blk,
        ROW_NUMBER() OVER (PARTITION BY player_id ORDER BY game_date DESC, game_id DESC) rn
      FROM nba_player_game_stats
      WHERE season_year = ? AND COALESCE(minutes,0) >= 10
    ), agg AS (
      SELECT
        player_id,
        MAX(player_name) player_name,
        MAX(CASE WHEN rn=1 THEN team_abbr END) team_abbr,
        COUNT(*) sample,
        ROUND(AVG(pts),1) avg_pts,
        MAX(CASE WHEN rn=1 THEN game_date END) latest_game_date,
        SUM(CASE WHEN pts>=25 THEN 1 ELSE 0 END) pts25,
        SUM(CASE WHEN pts>=30 THEN 1 ELSE 0 END) pts30,
        SUM(CASE WHEN reb>=10 THEN 1 ELSE 0 END) reb10,
        SUM(CASE WHEN reb>=12 THEN 1 ELSE 0 END) reb12,
        SUM(CASE WHEN ast>=7 THEN 1 ELSE 0 END) ast7,
        SUM(CASE WHEN ast>=10 THEN 1 ELSE 0 END) ast10,
        SUM(CASE WHEN fg3m>=3 THEN 1 ELSE 0 END) fg3m3,
        SUM(CASE WHEN fg3m>=4 THEN 1 ELSE 0 END) fg3m4,
        SUM(CASE WHEN blk>=2 THEN 1 ELSE 0 END) blk2,
        SUM(CASE WHEN blk>=3 THEN 1 ELSE 0 END) blk3
      FROM ranked
      WHERE rn <= ?
      GROUP BY player_id
      HAVING COUNT(*) = ?
    )
    SELECT * FROM agg
    WHERE avg_pts >= 18
    ORDER BY avg_pts DESC
    LIMIT 100
  `;

  const result = await db.prepare(query).bind(season, window, window).all();
  const rows = result.results || [];
  const candidates = [];
  for (const row of rows) {
    for (const metric of METRICS) {
      const hits = Number(row[metric.key] || 0);
      const rate = hits / window;
      if (hits < Math.max(2, Math.ceil(window * 0.5))) continue;
      const score = rate * 100 + metric.weight + Number(row.avg_pts || 0) * 0.65;
      candidates.push({
        player_id: row.player_id,
        player_name: row.player_name,
        team_abbr: row.team_abbr,
        season,
        window,
        sample: window,
        hits,
        rate,
        percent: Math.round(rate * 100),
        market: metric.label,
        stat: metric.field,
        threshold: metric.threshold,
        avg_pts: Number(row.avg_pts || 0),
        latest_game_date: row.latest_game_date,
        score,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score || b.avg_pts - a.avg_pts);
  const seenPlayers = new Set();
  const selected = [];
  for (const candidate of candidates) {
    if (seenPlayers.has(candidate.player_id)) continue;
    seenPlayers.add(candidate.player_id);
    selected.push(candidate);
    if (selected.length >= 12) break;
  }

  const overview = await db.prepare(`
    SELECT COUNT(*) games, MIN(game_date) first_game_date, MAX(game_date) last_game_date
    FROM nba_games WHERE season_year=?
  `).bind(season).first();

  return json({ ok: true, service: "rngn-nba-broadcast", season, window, overview, cards: selected });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

function html(body) {
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

const APP_HTML = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>RNGN NBA Broadcast Lab</title>
<style>
:root{--bg:#070707;--panel:#111;--line:#2a2a2a;--text:#f5f5f5;--muted:#9c9c9c;--accent:#ff5a1f;--accent2:#ff8a00}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 75% 0,#23110a 0,#090909 32%,#050505 72%);color:var(--text);font-family:Inter,Arial,sans-serif;min-height:100vh}.wrap{max-width:1440px;margin:0 auto;padding:28px 28px 60px}.top{display:flex;justify-content:space-between;gap:20px;align-items:flex-end;border-bottom:1px solid var(--line);padding-bottom:22px}.eyebrow{font-size:12px;letter-spacing:.2em;color:#ff7a3b;font-weight:800}.title{font-size:42px;line-height:.95;font-weight:950;letter-spacing:-.045em;margin:9px 0 0}.sub{color:var(--muted);margin-top:10px;font-size:14px}.status{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}.pill{padding:9px 12px;border:1px solid var(--line);border-radius:999px;background:#0b0b0b;font-size:12px;color:#c8c8c8}.pill b{color:#fff}.controls{display:flex;gap:10px;align-items:center;margin:22px 0}.controls select,.controls button{background:#111;color:#fff;border:1px solid #333;border-radius:9px;padding:10px 13px;font-weight:700;cursor:pointer}.controls button.active{background:#fff;color:#000;border-color:#fff}.meta{margin-left:auto;color:#777;font-size:12px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}.card{position:relative;min-height:300px;border:1px solid #2b2b2b;border-radius:18px;overflow:hidden;background:linear-gradient(145deg,#151515,#0a0a0a 72%);padding:22px;display:flex;flex-direction:column;justify-content:space-between;box-shadow:0 16px 38px rgba(0,0,0,.22)}.card:before{content:"";position:absolute;inset:0;background:linear-gradient(125deg,transparent 0 52%,rgba(255,90,31,.16) 100%);pointer-events:none}.team{display:inline-flex;align-items:center;gap:8px;font-size:12px;font-weight:900;letter-spacing:.1em;color:#f0f0f0}.dot{width:9px;height:9px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent2));box-shadow:0 0 18px rgba(255,90,31,.6)}.player{font-size:25px;font-weight:950;letter-spacing:-.03em;margin-top:14px;max-width:85%}.market{font-size:13px;font-weight:850;letter-spacing:.08em;color:#ff8d56;margin-top:6px}.big{font-size:68px;line-height:.84;font-weight:1000;letter-spacing:-.07em;margin-top:24px}.big small{font-size:20px;letter-spacing:0;margin-left:5px;color:#bbb}.hit{font-size:16px;font-weight:800;margin-top:9px}.foot{display:flex;justify-content:space-between;gap:12px;color:#8d8d8d;font-size:11px;border-top:1px solid #262626;padding-top:14px;margin-top:20px}.empty{grid-column:1/-1;border:1px dashed #333;padding:50px;text-align:center;color:#999;border-radius:16px}.footer{margin-top:24px;color:#686868;font-size:11px}.skeleton{opacity:.4;animation:pulse 1s infinite alternate}@keyframes pulse{to{opacity:.8}}@media(max-width:1000px){.grid{grid-template-columns:repeat(2,1fr)}}@media(max-width:680px){.wrap{padding:20px 14px 40px}.top{display:block}.status{justify-content:flex-start;margin-top:18px}.title{font-size:34px}.grid{grid-template-columns:1fr}.meta{display:none}}
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <div><div class="eyebrow">RNGN · NBA DATA CORE</div><div class="title">NBA BROADCAST LAB</div><div class="sub">Отдельный NBA-сервис. Плашки считаются напрямую из NBA-базы.</div></div>
    <div class="status" id="status"><span class="pill">загрузка базы…</span></div>
  </div>
  <div class="controls">
    <select id="season"><option>2025-26</option><option>2024-25</option><option>2023-24</option><option>2022-23</option><option>2021-22</option></select>
    <button data-w="3">L3</button><button data-w="5">L5</button><button data-w="10" class="active">L10</button>
    <div class="meta" id="meta">—</div>
  </div>
  <div class="grid" id="grid"><div class="empty skeleton">Собираю реальные NBA-плашки…</div></div>
  <div class="footer">RNGN NBA Broadcast Lab · read-only preview · NBA Data Core</div>
</div>
<script>
const grid=document.getElementById('grid'),statusEl=document.getElementById('status'),meta=document.getElementById('meta'),season=document.getElementById('season');
let windowSize=10;
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
async function health(){try{const r=await fetch('/api/health',{cache:'no-store'}).then(r=>r.json());statusEl.innerHTML='<span class="pill"><b>'+Number(r.games||0).toLocaleString('ru-RU')+'</b> игр</span><span class="pill"><b>'+Number(r.player_rows||0).toLocaleString('ru-RU')+'</b> player rows</span><span class="pill">последняя игра <b>'+esc(r.last_game_date||'—')+'</b></span>'}catch(e){statusEl.innerHTML='<span class="pill">health error</span>'}}
async function load(){grid.innerHTML='<div class="empty skeleton">Пересчитываю выборку…</div>';const s=season.value;try{const d=await fetch('/api/cards?season='+encodeURIComponent(s)+'&window='+windowSize,{cache:'no-store'}).then(r=>r.json());if(!d.ok)throw new Error(d.error||'api_error');meta.textContent=(d.overview?.games||0)+' игр · '+(d.overview?.first_game_date||'—')+' → '+(d.overview?.last_game_date||'—');if(!d.cards?.length){grid.innerHTML='<div class="empty">Нет подходящих карточек</div>';return}grid.innerHTML=d.cards.map(c=>'<article class="card"><div><div class="team"><span class="dot"></span>'+esc(c.team_abbr)+'</div><div class="player">'+esc(c.player_name)+'</div><div class="market">'+esc(c.market)+'</div><div class="big">'+esc(c.percent)+'<small>%</small></div><div class="hit">'+esc(c.hits)+' из '+esc(c.sample)+' последних матчей</div></div><div class="foot"><span>'+esc(c.season)+' · L'+esc(c.window)+'</span><span>последняя: '+esc(c.latest_game_date||'—')+'</span></div></article>').join('')}catch(e){grid.innerHTML='<div class="empty">Ошибка API: '+esc(e.message)+'</div>'}}
document.querySelectorAll('[data-w]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-w]').forEach(x=>x.classList.remove('active'));b.classList.add('active');windowSize=Number(b.dataset.w);load()});season.onchange=load;health();load();
</script>
</body></html>`;
