const EXPECTED_TABLES = [
  "backfill_jobs",
  "broadcast_cards",
  "data_core_meta",
  "event_players",
  "game_events",
  "games",
  "goalie_game_stats",
  "goalie_opponent_splits",
  "goalie_rolling_snapshots",
  "insights",
  "live_notification_cursors",
  "notification_log",
  "period_scores",
  "player_game_stats",
  "player_opponent_splits",
  "player_rolling_snapshots",
  "players",
  "pregame_team_snapshots",
  "standings_snapshots",
  "subscriptions",
  "sync_runs",
  "team_current_snapshots",
  "team_game_advanced_features",
  "team_game_features",
  "team_game_stats",
  "teams",
  "telegram_users",
  "winline_events",
  "winline_markets",
];

export async function handleDataCoreHealthV2(request, env, path) {
  if (!["/api/data-core/health", "/data-core/health"].includes(path)) return null;
  if (request.method !== "GET") return json({ok:false,error:"method_not_allowed"},405);
  if (!env.DB) return json({ok:false,service:"hoh-data-core",schema_ok:false,error:"missing_d1_binding"},503);

  try {
    const [tablesResult, metaResult] = await Promise.all([
      env.DB.prepare(`
        SELECT name FROM sqlite_schema
        WHERE type='table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name;
      `).all(),
      env.DB.prepare(`SELECT meta_key,meta_value,updated_at FROM data_core_meta ORDER BY meta_key;`).all().catch(() => ({results:[]})),
    ]);

    const available = new Set((tablesResult.results || []).map((row) => String(row.name)));
    const missing = EXPECTED_TABLES.filter((name) => !available.has(name));
    const meta = {};
    let metaUpdatedAt = null;
    for (const row of metaResult.results || []) {
      meta[String(row.meta_key)] = parseMetaValue(row.meta_value);
      if (row.updated_at && (!metaUpdatedAt || String(row.updated_at) > metaUpdatedAt)) metaUpdatedAt = String(row.updated_at);
    }

    const baseReady = Number(meta["warehouse.games"] || 0) === 2792
      && Number(meta["warehouse.team_game_features"] || 0) >= 5584;
    const compactReady = Number(meta["compact.pregame_team_snapshots"] || 0) >= 10000
      && Number(meta["compact.player_rolling_snapshots"] || 0) > 0
      && Number(meta["compact.team_current_snapshots"] || 0) >= 90;

    return json({
      ok:missing.length === 0 && baseReady && compactReady,
      service:"hoh-data-core",
      schema_ok:missing.length === 0,
      expected_table_count:EXPECTED_TABLES.length,
      present_table_count:EXPECTED_TABLES.length - missing.length,
      missing_tables:missing,
      layers:{
        historical:baseReady ? "ready" : "waiting",
        compact:compactReady ? "ready" : "waiting",
        telegram_live_notifications:envFlag(env.TELEGRAM_LIVE_NOTIFICATIONS_ENABLED,false) ? "enabled" : "disabled",
      },
      counts:{
        teams:Number(meta["warehouse.teams"] || 0),
        games:Number(meta["warehouse.games"] || 0),
        players:Number(meta["compact.players"] || 0),
        team_features:Number(meta["warehouse.team_game_features"] || 0),
        advanced_features:Number(meta["warehouse.team_game_advanced_features"] || 0),
        pregame_team_snapshots:Number(meta["compact.pregame_team_snapshots"] || 0),
        team_current_snapshots:Number(meta["compact.team_current_snapshots"] || 0),
        player_rolling_snapshots:Number(meta["compact.player_rolling_snapshots"] || 0),
        goalie_rolling_snapshots:Number(meta["compact.goalie_rolling_snapshots"] || 0),
      },
      build:{
        seasons:meta["build.seasons"] || null,
        rank_version:meta["build.rank_version"] || null,
        warehouse_created_at:meta["build.warehouse_created_at"] || null,
        compact_created_at:meta["build.compact_created_at"] || null,
        current_created_at:meta["build.current_created_at"] || null,
        meta_updated_at:metaUpdatedAt,
      },
      quota_profile:"low_read_meta",
    }, missing.length === 0 ? 200 : 503);
  } catch (error) {
    console.error("Data Core health v2 failed", error);
    return json({ok:false,service:"hoh-data-core",schema_ok:false,error:"health_query_failed"},500);
  }
}

function parseMetaValue(value) {
  const raw = String(value ?? "");
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}
function envFlag(value,fallback=false) { if (value===undefined || value===null || value==="") return fallback; return ["1","true","yes","on"].includes(String(value).trim().toLowerCase()); }
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}})}
