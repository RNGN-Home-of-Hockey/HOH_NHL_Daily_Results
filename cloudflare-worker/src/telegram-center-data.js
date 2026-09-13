const FINAL_STATES = ["FINAL", "OFF"];

export async function handleTelegramCenterDataRequest(request, env, path) {
  if (request.method !== "GET") return null;

  if (path === "/api/telegram-app/teams") {
    return centerTeams(request, env);
  }
  if (path === "/api/telegram-app/players") {
    return centerPlayers(request, env);
  }
  if (path === "/api/me/subscriptions") {
    return centerSubscriptions(request, env);
  }
  if (path === "/api/telegram-app/data-status") {
    return centerDataStatus(env);
  }

  return null;
}

async function centerTeams(request, env) {
  if (!env.DB) return json({ ok: false, error: "missing_d1_binding", teams: [] }, 503);
  const window = normalizeWindow(new URL(request.url).searchParams.get("window"));

  try {
    const snapshot = await env.DB.prepare(`
      SELECT s.*,t.name_en,t.name_ru,t.logo_url
      FROM team_current_snapshots s
      JOIN teams t ON t.tri_code=s.team_tri
      WHERE s.window_games=?
      ORDER BY s.rank_goal_diff ASC,s.rank_xgf_pct_5v5 ASC,s.team_tri ASC;
    `).bind(window).all();
    const teams = snapshot.results || [];
    if (teams.length) return json({ ok: true, window, source: "team_current_snapshots", teams });
  } catch (error) {
    console.log("telegram_center_team_snapshot_unavailable", { error: errorText(error) });
  }

  try {
    const fallback = await env.DB.prepare(`
      WITH recent AS (
        SELECT s.team_tri,s.game_pk,s.goals,
               CASE WHEN g.home_tri=s.team_tri THEN g.away_score ELSE g.home_score END AS goals_against,
               g.scheduled_start_utc,
               ROW_NUMBER() OVER (
                 PARTITION BY s.team_tri
                 ORDER BY g.scheduled_start_utc DESC,g.game_pk DESC
               ) AS rn
        FROM team_game_stats s
        JOIN games g ON g.game_pk=s.game_pk
        WHERE UPPER(COALESCE(g.game_state,'')) IN ('FINAL','OFF')
      ),
      agg AS (
        SELECT team_tri,
               COUNT(*) AS sample_size,
               AVG(CAST(goals AS REAL)) AS gf_pg,
               AVG(CAST(goals_against AS REAL)) AS ga_pg,
               AVG(CAST(goals-goals_against AS REAL)) AS goal_diff_pg
        FROM recent
        WHERE rn<=?
        GROUP BY team_tri
      ),
      ranked AS (
        SELECT a.*,
               RANK() OVER (ORDER BY goal_diff_pg DESC,gf_pg DESC,team_tri ASC) AS rank_goal_diff,
               RANK() OVER (ORDER BY gf_pg DESC,team_tri ASC) AS rank_gf,
               RANK() OVER (ORDER BY ga_pg ASC,team_tri ASC) AS rank_ga
        FROM agg a
      )
      SELECT r.team_tri,? AS window_games,
             r.sample_size,r.gf_pg,r.ga_pg,r.goal_diff_pg,
             r.rank_gf,r.rank_ga,r.rank_goal_diff,
             NULL AS xgf_pct_5v5,NULL AS rank_xgf_pct_5v5,
             t.name_en,t.name_ru,t.logo_url
      FROM ranked r
      JOIN teams t ON t.tri_code=r.team_tri
      ORDER BY r.rank_goal_diff ASC,r.team_tri ASC;
    `).bind(window, window).all();
    const teams = fallback.results || [];
    if (teams.length) return json({ ok: true, window, source: "historical_fallback", teams });
  } catch (error) {
    console.log("telegram_center_team_history_unavailable", { error: errorText(error) });
  }

  try {
    const directory = await env.DB.prepare(`
      SELECT tri_code AS team_tri,name_en,name_ru,logo_url
      FROM teams
      WHERE COALESCE(active,1)=1
      ORDER BY tri_code;
    `).all();
    return json({ ok: true, window, source: "team_directory", teams: (directory.results || []).map((row) => ({
      ...row,
      window_games: window,
      sample_size: 0,
      gf_pg: null,
      ga_pg: null,
      goal_diff_pg: null,
      rank_gf: null,
      rank_ga: null,
      rank_goal_diff: null,
      xgf_pct_5v5: null,
      rank_xgf_pct_5v5: null,
    })) });
  } catch (error) {
    console.error("telegram center team directory failed", error);
    return json({ ok: false, error: "team_directory_not_ready", teams: [] }, 503);
  }
}

async function centerPlayers(request, env) {
  if (!env.DB) return json({ ok: false, error: "missing_d1_binding", players: [] }, 503);
  const url = new URL(request.url);
  const team = String(url.searchParams.get("team") || "").trim().toUpperCase();
  const q = String(url.searchParams.get("q") || "").trim();
  const limit = clampInt(url.searchParams.get("limit"), 40, 1, 50);

  try {
    const statement = team
      ? env.DB.prepare(`
          SELECT p.player_id,p.full_name_en,p.full_name_ru,p.position_code,p.sweater_number,p.current_team_tri,
                 r.games,r.goals,r.assists,r.points,r.shots,r.games_with_goal,r.games_with_point,
                 r.games_with_2plus_points,r.goals_pg,r.points_pg,r.shots_pg,r.as_of_utc
          FROM player_rolling_snapshots r
          JOIN players p ON p.player_id=r.player_id
          WHERE r.window_key='20' AND r.team_tri=?
            AND (?='' OR p.full_name_en LIKE '%'||?||'%' OR COALESCE(p.full_name_ru,'') LIKE '%'||?||'%')
          ORDER BY r.points_pg DESC,r.goals_pg DESC,r.shots_pg DESC
          LIMIT ?;
        `).bind(team, q, q, q, limit)
      : env.DB.prepare(`
          SELECT p.player_id,p.full_name_en,p.full_name_ru,p.position_code,p.sweater_number,p.current_team_tri,
                 r.games,r.goals,r.assists,r.points,r.shots,r.games_with_goal,r.games_with_point,
                 r.games_with_2plus_points,r.goals_pg,r.points_pg,r.shots_pg,r.as_of_utc
          FROM player_rolling_snapshots r
          JOIN players p ON p.player_id=r.player_id
          WHERE r.window_key='20'
            AND (?='' OR p.full_name_en LIKE '%'||?||'%' OR COALESCE(p.full_name_ru,'') LIKE '%'||?||'%')
          ORDER BY r.points_pg DESC,r.goals_pg DESC,r.shots_pg DESC
          LIMIT ?;
        `).bind(q, q, q, limit);
    const snapshot = await statement.all();
    const players = snapshot.results || [];
    if (players.length) return json({ ok: true, team: team || null, source: "player_rolling_snapshots", players });
  } catch (error) {
    console.log("telegram_center_player_snapshot_unavailable", { error: errorText(error) });
  }

  try {
    const fallback = await env.DB.prepare(`
      WITH recent AS (
        SELECT s.player_id,s.team_tri,s.goals,s.assists,s.points,s.shots,
               g.scheduled_start_utc,
               ROW_NUMBER() OVER (
                 PARTITION BY s.player_id
                 ORDER BY g.scheduled_start_utc DESC,g.game_pk DESC
               ) AS rn
        FROM player_game_stats s
        JOIN games g ON g.game_pk=s.game_pk
        WHERE UPPER(COALESCE(g.game_state,'')) IN ('FINAL','OFF')
      ),
      agg AS (
        SELECT player_id,
               COUNT(*) AS games,
               SUM(COALESCE(goals,0)) AS goals,
               SUM(COALESCE(assists,0)) AS assists,
               SUM(COALESCE(points,0)) AS points,
               SUM(COALESCE(shots,0)) AS shots,
               SUM(CASE WHEN COALESCE(goals,0)>0 THEN 1 ELSE 0 END) AS games_with_goal,
               SUM(CASE WHEN COALESCE(points,0)>0 THEN 1 ELSE 0 END) AS games_with_point,
               SUM(CASE WHEN COALESCE(points,0)>=2 THEN 1 ELSE 0 END) AS games_with_2plus_points,
               MAX(scheduled_start_utc) AS as_of_utc
        FROM recent
        WHERE rn<=20
        GROUP BY player_id
      )
      SELECT p.player_id,p.full_name_en,p.full_name_ru,p.position_code,p.sweater_number,p.current_team_tri,
             a.games,a.goals,a.assists,a.points,a.shots,
             a.games_with_goal,a.games_with_point,a.games_with_2plus_points,
             CASE WHEN a.games>0 THEN CAST(a.goals AS REAL)/a.games END AS goals_pg,
             CASE WHEN a.games>0 THEN CAST(a.points AS REAL)/a.games END AS points_pg,
             CASE WHEN a.games>0 THEN CAST(a.shots AS REAL)/a.games END AS shots_pg,
             a.as_of_utc
      FROM agg a
      JOIN players p ON p.player_id=a.player_id
      WHERE (?='' OR p.current_team_tri=?)
        AND (?='' OR p.full_name_en LIKE '%'||?||'%' OR COALESCE(p.full_name_ru,'') LIKE '%'||?||'%')
      ORDER BY points_pg DESC,goals_pg DESC,shots_pg DESC,p.full_name_en ASC
      LIMIT ?;
    `).bind(team, team, q, q, q, limit).all();
    const players = fallback.results || [];
    if (players.length) return json({ ok: true, team: team || null, source: "historical_fallback", players });
  } catch (error) {
    console.log("telegram_center_player_history_unavailable", { error: errorText(error) });
  }

  try {
    const directory = await env.DB.prepare(`
      SELECT player_id,full_name_en,full_name_ru,position_code,sweater_number,current_team_tri,
             NULL AS games,NULL AS goals,NULL AS assists,NULL AS points,NULL AS shots,
             NULL AS games_with_goal,NULL AS games_with_point,NULL AS games_with_2plus_points,
             NULL AS goals_pg,NULL AS points_pg,NULL AS shots_pg,NULL AS as_of_utc
      FROM players
      WHERE COALESCE(active,1)=1
        AND (?='' OR current_team_tri=?)
        AND (?='' OR full_name_en LIKE '%'||?||'%' OR COALESCE(full_name_ru,'') LIKE '%'||?||'%')
      ORDER BY full_name_en ASC
      LIMIT ?;
    `).bind(team, team, q, q, q, limit).all();
    return json({ ok: true, team: team || null, source: "player_directory", players: directory.results || [] });
  } catch (error) {
    console.error("telegram center player directory failed", error);
    return json({ ok: false, error: "player_directory_not_ready", players: [] }, 503);
  }
}

async function centerSubscriptions(request, env) {
  if (!env.DB) return json({ ok: false, error: "missing_d1_binding", subscriptions: [] }, 503);
  const auth = await centerTelegramAuth(request, env, true);
  if (!auth.ok) return json({ ok: false, error: auth.error, subscriptions: [] }, 401);

  const sharedFrom = `
    FROM subscriptions s
    LEFT JOIN players p ON s.subject_type='player' AND p.player_id=CAST(s.subject_key AS INTEGER)
    LEFT JOIN teams t ON s.subject_type='team' AND t.tri_code=s.subject_key
    LEFT JOIN games g ON s.subject_type='game' AND g.game_pk=CAST(s.subject_key AS INTEGER)
    WHERE s.telegram_user_id=?
    ORDER BY CASE s.subject_type WHEN 'player' THEN 1 WHEN 'team' THEN 2 ELSE 3 END,s.subject_key;
  `;

  try {
    const result = await env.DB.prepare(`
      SELECT s.subscription_id,s.subject_type,s.subject_key,
             s.notify_pregame,s.notify_start,s.notify_goal,s.notify_assist,
             s.notify_point,s.notify_period_end,s.notify_final,
             CASE s.subject_type
               WHEN 'player' THEN COALESCE(p.full_name_ru,p.full_name_en,s.subject_key)
               WHEN 'team' THEN COALESCE(t.name_ru,t.name_en,s.subject_key)
               WHEN 'game' THEN COALESCE(g.away_tri||' — '||g.home_tri,'Game #'||s.subject_key)
               ELSE s.subject_key
             END AS name
      ${sharedFrom}
    `).bind(auth.user.id).all();
    return json({ ok: true, source: "subscriptions_v2", subscriptions: (result.results || []).map(serializeSubscription) });
  } catch (error) {
    console.log("telegram_center_subscription_v2_unavailable", { error: errorText(error) });
  }

  try {
    const legacy = await env.DB.prepare(`
      SELECT s.subscription_id,s.subject_type,s.subject_key,
             s.notify_pregame,s.notify_start,s.notify_goal,s.notify_assist,
             0 AS notify_point,s.notify_period_end,s.notify_final,
             CASE s.subject_type
               WHEN 'player' THEN COALESCE(p.full_name_ru,p.full_name_en,s.subject_key)
               WHEN 'team' THEN COALESCE(t.name_ru,t.name_en,s.subject_key)
               WHEN 'game' THEN COALESCE(g.away_tri||' — '||g.home_tri,'Game #'||s.subject_key)
               ELSE s.subject_key
             END AS name
      ${sharedFrom}
    `).bind(auth.user.id).all();
    return json({ ok: true, source: "subscriptions_legacy", degraded: true, subscriptions: (legacy.results || []).map(serializeSubscription) });
  } catch (error) {
    console.log("telegram_center_subscription_legacy_unavailable", { error: errorText(error) });
    return json({ ok: true, source: "subscriptions_unavailable", degraded: true, subscriptions: [] });
  }
}

async function centerDataStatus(env) {
  if (!env.DB) return json({ ok: false, error: "missing_d1_binding" }, 503);
  const tables = ["teams","players","games","team_game_stats","player_game_stats","team_current_snapshots","player_rolling_snapshots","subscriptions"];
  const result = {};
  for (const table of tables) {
    try {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table};`).first();
      result[table] = { ok: true, count: Number(row?.count || 0) };
    } catch (error) {
      result[table] = { ok: false, error: errorText(error) };
    }
  }
  let notifyPoint = false;
  try {
    const columns = await env.DB.prepare("PRAGMA table_info(subscriptions);").all();
    notifyPoint = (columns.results || []).some((row) => String(row.name) === "notify_point");
  } catch {}
  return json({ ok: true, service: "telegram-center-data", tables: result, subscriptions_notify_point: notifyPoint });
}

async function centerTelegramAuth(request, env, required) {
  const initData = String(request.headers.get("x-telegram-init-data") || "").trim();
  if (!initData) return required ? { ok: false, error: "missing_telegram_init_data" } : { ok: false, error: "guest" };
  const token = String(env.TELEGRAM_CENTER_BOT_TOKEN || "").trim();
  if (!token) return { ok: false, error: "missing_telegram_center_token" };
  try {
    const params = new URLSearchParams(initData);
    const providedHash = params.get("hash") || "";
    const authDate = Number(params.get("auth_date") || 0);
    const userRaw = params.get("user") || "";
    params.delete("hash");
    if (!providedHash || !authDate || !userRaw) return { ok: false, error: "invalid_telegram_init_data" };
    const maxAgeRaw = Number(env.TELEGRAM_WEBAPP_MAX_AGE_SECONDS || 86400);
    const maxAge = Number.isFinite(maxAgeRaw) ? Math.min(604800, Math.max(300, Math.floor(maxAgeRaw))) : 86400;
    if (Math.abs(Math.floor(Date.now() / 1000) - authDate) > maxAge) return { ok: false, error: "telegram_init_data_expired" };
    const dataCheck = [...params.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join("\n");
    const encoder = new TextEncoder();
    const key1 = await crypto.subtle.importKey("raw", encoder.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const secret = await crypto.subtle.sign("HMAC", key1, encoder.encode(token));
    const key2 = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const digest = await crypto.subtle.sign("HMAC", key2, encoder.encode(dataCheck));
    const calculated = bytesToHex(new Uint8Array(digest));
    if (!(await safeTextEqual(calculated, providedHash.toLowerCase()))) return { ok: false, error: "telegram_signature_invalid" };
    const user = JSON.parse(userRaw);
    const id = Number(user.id);
    if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, error: "telegram_user_invalid" };
    return { ok: true, user: { id, username: user.username || null, first_name: user.first_name || null, last_name: user.last_name || null, language_code: user.language_code || null } };
  } catch (error) {
    console.error("telegram center init data validation failed", error);
    return { ok: false, error: "telegram_init_data_invalid" };
  }
}

function serializeSubscription(row) {
  const type = String(row.subject_type || "");
  const candidates = type === "player"
    ? [["goal","notify_goal"],["assist","notify_assist"],["point","notify_point"]]
    : type === "team"
      ? [["start","notify_start"],["goal","notify_goal"],["final","notify_final"]]
      : [["pregame","notify_pregame"],["start","notify_start"],["goal","notify_goal"],["period_end","notify_period_end"],["final","notify_final"]];
  return {
    id: Number(row.subscription_id),
    type,
    entity_id: String(row.subject_key || ""),
    name: String(row.name || row.subject_key || ""),
    events: candidates.filter(([,column]) => Number(row[column]) === 1).map(([event]) => event),
  };
}

function normalizeWindow(value) {
  const n = Number(value);
  return [5, 10, 20].includes(n) ? n : 20;
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
}

function errorText(error) {
  return String(error?.message || error || "unknown").slice(0, 300);
}

async function safeTextEqual(a, b) {
  const encoder = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(String(a))),
    crypto.subtle.digest("SHA-256", encoder.encode(String(b))),
  ]);
  const aa = new Uint8Array(da);
  const bb = new Uint8Array(db);
  let diff = aa.length ^ bb.length;
  const length = Math.min(aa.length, bb.length);
  for (let index = 0; index < length; index += 1) diff |= aa[index] ^ bb[index];
  return diff === 0;
}

function bytesToHex(bytes) {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
