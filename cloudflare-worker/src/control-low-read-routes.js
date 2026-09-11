import { getLiveNotificationStatus } from "./telegram-live-notifications.js";

export async function handleControlLowReadRequest(request, env, path) {
  if (path === "/api/control/overview") {
    if (request.method !== "GET") return json({ok:false,error:"method_not_allowed"},405);
    return overview(env);
  }
  if (path === "/api/control/telegram") {
    if (request.method !== "GET") return json({ok:false,error:"method_not_allowed"},405);
    return telegramOverview(env);
  }
  return null;
}

async function overview(env) {
  if (!env.DB) return json({ok:false,error:"missing_d1_binding"},503);
  try {
    const [metaResult,gamesResult] = await Promise.all([
      env.DB.prepare(`SELECT meta_key,meta_value FROM data_core_meta ORDER BY meta_key;`).all().catch(() => ({results:[]})),
      env.DB.prepare(`
        SELECT g.game_pk,g.scheduled_start_utc,g.game_state,g.game_type,g.home_tri,g.away_tri,g.home_score,g.away_score,
               ht.name_ru home_name_ru,ht.name_en home_name,ht.logo_url home_logo,
               at.name_ru away_name_ru,at.name_en away_name,at.logo_url away_logo
        FROM games g
        LEFT JOIN teams ht ON ht.tri_code=g.home_tri
        LEFT JOIN teams at ON at.tri_code=g.away_tri
        WHERE g.game_type IN (2,3)
        ORDER BY g.scheduled_start_utc DESC
        LIMIT 12;
      `).all(),
    ]);
    const meta = toMeta(metaResult.results || []);
    const compactReady = Number(meta["compact.pregame_team_snapshots"] || 0) >= 10000
      && Number(meta["compact.player_rolling_snapshots"] || 0) > 0
      && Number(meta["compact.team_current_snapshots"] || 0) >= 90;
    return json({
      ok:true,
      counts:{
        teams:Number(meta["warehouse.teams"] || 0),
        players:Number(meta["compact.players"] || 0),
        games:Number(meta["warehouse.games"] || 0),
        player_windows:Number(meta["compact.player_rolling_snapshots"] || 0),
        player_splits:Number(meta["compact.player_opponent_splits"] || 0),
        goalie_windows:Number(meta["compact.goalie_rolling_snapshots"] || 0),
        team_snapshots:Number(meta["compact.pregame_team_snapshots"] || 0),
        team_current:Number(meta["compact.team_current_snapshots"] || 0),
        compact_ready:compactReady,
      },
      games:gamesResult.results || [],
      quota_profile:"low_read_meta",
    });
  } catch (error) {
    console.error("low-read control overview failed",error);
    return json({ok:false,error:"control_overview_failed"},500);
  }
}

async function telegramOverview(env) {
  if (!env.DB) return json({ok:false,error:"missing_d1_binding"},503);
  try {
    const [row,status] = await Promise.all([
      env.DB.prepare(`
        SELECT
          (SELECT COUNT(*) FROM telegram_users) users,
          (SELECT COUNT(*) FROM subscriptions) subscriptions,
          (SELECT COUNT(*) FROM subscriptions WHERE subject_type='team') team_follows,
          (SELECT COUNT(*) FROM subscriptions WHERE subject_type='player') player_follows,
          (SELECT COUNT(*) FROM subscriptions WHERE subject_type='game') game_follows;
      `).first(),
      getLiveNotificationStatus(env),
    ]);
    return json({
      ok:true,
      stats:{
        users:Number(row?.users || 0),
        subscriptions:Number(row?.subscriptions || 0),
        team_follows:Number(row?.team_follows || 0),
        player_follows:Number(row?.player_follows || 0),
        game_follows:Number(row?.game_follows || 0),
        notifications_enabled:Boolean(status?.enabled),
        notifications_24h:Number(status?.notifications_24h || 0),
        last_notification_at:status?.last_notification_at || null,
      },
    });
  } catch (error) {
    console.error("low-read control Telegram overview failed",error);
    return json({ok:false,error:"telegram_stats_failed"},500);
  }
}

function toMeta(rows) {
  const out = {};
  for (const row of rows) {
    const raw = String(row.meta_value ?? "");
    out[String(row.meta_key)] = /^-?\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : raw;
  }
  return out;
}
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}})}
