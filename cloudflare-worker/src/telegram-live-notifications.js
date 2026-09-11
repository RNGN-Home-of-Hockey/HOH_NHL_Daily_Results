const NHL_BASE = "https://api-web.nhle.com/v1";

const LIVE_STATES = new Set(["LIVE", "CRIT", "INTERMISSION"]);
const FINAL_STATES = new Set(["FINAL", "OFF"]);

export async function runLiveNotificationTick(env, options = {}) {
  if (!env.DB) return { ok:false,error:"missing_d1_binding" };
  if (!env.TELEGRAM_BOT_TOKEN && !options.dryRun) return { ok:false,error:"missing_telegram_bot_token" };

  const dryRun = Boolean(options.dryRun);
  const now = options.now ? new Date(options.now) : new Date();
  if (!Number.isFinite(now.getTime())) return { ok:false,error:"invalid_now" };

  const subscriptions = await loadSubscriptions(env.DB);
  if (!subscriptions.length) {
    return { ok:true,dry_run:dryRun,subscriptions:0,relevant_games:0,planned:0,sent:0,failed:0 };
  }

  const playerTeams = await loadPlayerTeams(env.DB, subscriptions);
  const games = await loadScheduleWindow(now);
  const relevantGames = games.filter((game) => subscriptions.some((sub) => subscriptionTouchesGame(sub, game, playerTeams)));

  const summary = {
    ok:true,
    dry_run:dryRun,
    subscriptions:subscriptions.length,
    schedule_games:games.length,
    relevant_games:relevantGames.length,
    planned:0,
    sent:0,
    skipped_duplicate:0,
    failed:0,
    initialized_cursors:0,
    advanced_cursors:0,
    events:[],
  };

  for (const game of relevantGames) {
    try {
      await processGame(env, game, subscriptions, playerTeams, now, dryRun, summary);
    } catch (error) {
      summary.failed += 1;
      summary.events.push({ game_pk:game.game_pk,error:String(error?.message || error) });
      console.error("telegram live notification game failed", game.game_pk, error);
    }
  }
  summary.ok = summary.failed === 0;
  return summary;
}

export async function getLiveNotificationStatus(env) {
  if (!env.DB) return { ok:false,error:"missing_d1_binding" };
  try {
    const row = await env.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM telegram_users WHERE notifications_enabled=1) AS enabled_users,
        (SELECT COUNT(*) FROM subscriptions) AS subscriptions,
        (SELECT COUNT(*) FROM notification_log WHERE sent_at >= datetime('now','-24 hours')) AS notifications_24h,
        (SELECT MAX(sent_at) FROM notification_log) AS last_notification_at,
        (SELECT COUNT(*) FROM live_notification_cursors) AS cursors;
    `).first();
    return {
      ok:true,
      enabled:Boolean(envFlag(env.TELEGRAM_LIVE_NOTIFICATIONS_ENABLED,false)),
      enabled_users:Number(row?.enabled_users || 0),
      subscriptions:Number(row?.subscriptions || 0),
      notifications_24h:Number(row?.notifications_24h || 0),
      last_notification_at:row?.last_notification_at || null,
      cursors:Number(row?.cursors || 0),
    };
  } catch (error) {
    console.error("telegram notification status failed", error);
    return { ok:false,error:"notification_status_failed" };
  }
}

async function processGame(env, game, subscriptions, playerTeams, now, dryRun, summary) {
  const state = String(game.state || "").toUpperCase();
  const relevant = subscriptions.filter((sub) => subscriptionTouchesGame(sub, game, playerTeams));
  if (!relevant.length) return;

  const start = game.start_utc ? new Date(game.start_utc) : null;
  const pregameMinutes = envInt(env.TELEGRAM_PREGAME_MINUTES,45,5,180);
  const minsToStart = start && Number.isFinite(start.getTime()) ? (start.getTime() - now.getTime()) / 60000 : null;

  if (!LIVE_STATES.has(state) && !FINAL_STATES.has(state) && minsToStart !== null && minsToStart >= 0 && minsToStart <= pregameMinutes) {
    await dispatchEvent(env, game, relevant, playerTeams, {
      key:`pregame:${game.game_pk}`,
      type:"pregame",
      flag:"notify_pregame",
      text:pregameText(game, minsToStart),
    }, dryRun, summary);
  }

  if (LIVE_STATES.has(state)) {
    await dispatchEvent(env, game, relevant, playerTeams, {
      key:`start:${game.game_pk}`,
      type:"start",
      flag:"notify_start",
      text:startText(game),
    }, dryRun, summary);
  }

  let liveEventFailures = 0;
  if (LIVE_STATES.has(state) || FINAL_STATES.has(state)) {
    const pbp = await fetchNhl(`${NHL_BASE}/gamecenter/${game.game_pk}/play-by-play`);
    const plays = Array.isArray(pbp?.plays) ? [...pbp.plays].sort((a,b) => playSort(a)-playSort(b)) : [];
    const maxSort = plays.reduce((m,p) => Math.max(m,playSort(p)),0);
    const cursor = await env.DB.prepare(`SELECT game_pk,last_sort_order,last_game_state,last_period FROM live_notification_cursors WHERE game_pk=?;`).bind(game.game_pk).first();

    if (!cursor) {
      summary.initialized_cursors += 1;
      if (!dryRun) {
        await env.DB.prepare(`
          INSERT INTO live_notification_cursors(game_pk,last_sort_order,last_game_state,last_period,updated_at)
          VALUES(?,?,?,?,CURRENT_TIMESTAMP)
          ON CONFLICT(game_pk) DO NOTHING;
        `).bind(game.game_pk,maxSort,state,currentPeriod(pbp)).run();
      }
    } else {
      const after = Number(cursor.last_sort_order || 0);
      const roster = rosterMap(pbp);
      const teamIds = teamIdMap(game, pbp);
      const newPlays = plays.filter((play) => playSort(play) > after);
      for (const play of newPlays) {
        const descriptor = eventFromPlay(game, play, roster, teamIds);
        if (!descriptor) continue;
        const beforeFailures = summary.failed;
        await dispatchEvent(env, game, relevant, playerTeams, descriptor, dryRun, summary);
        if (summary.failed > beforeFailures) liveEventFailures += summary.failed - beforeFailures;
      }

      if (!dryRun && maxSort > after && liveEventFailures === 0) {
        await env.DB.prepare(`
          UPDATE live_notification_cursors
          SET last_sort_order=?,last_game_state=?,last_period=?,updated_at=CURRENT_TIMESTAMP
          WHERE game_pk=?;
        `).bind(maxSort,state,currentPeriod(pbp),game.game_pk).run();
        summary.advanced_cursors += 1;
      }
    }
  }

  if (FINAL_STATES.has(state)) {
    await dispatchEvent(env, game, relevant, playerTeams, {
      key:`final:${game.game_pk}`,
      type:"final",
      flag:"notify_final",
      text:finalText(game),
    }, dryRun, summary);
  }
}

async function dispatchEvent(env, game, relevantSubscriptions, playerTeams, event, dryRun, summary) {
  const byUser = new Map();
  for (const sub of relevantSubscriptions) {
    if (!subscriptionMatchesEvent(sub, game, event, playerTeams)) continue;
    if (!byUser.has(sub.telegram_user_id)) byUser.set(sub.telegram_user_id, []);
    byUser.get(sub.telegram_user_id).push(sub);
  }

  for (const [userId, matches] of byUser) {
    summary.planned += 1;
    if (dryRun) {
      summary.events.push({ game_pk:game.game_pk,notification_key:event.key,user_id:userId,type:event.type,subscriptions:matches.map(minSubscription) });
      continue;
    }

    const payload = JSON.stringify({ game_pk:game.game_pk,type:event.type,key:event.key,subscriptions:matches.map(minSubscription) });
    const reserved = await reserveNotification(env.DB, event.key, userId, event.type, game.game_pk, payload);
    if (!reserved) {
      summary.skipped_duplicate += 1;
      continue;
    }

    try {
      await sendTelegram(env, userId, event.text);
      summary.sent += 1;
    } catch (error) {
      summary.failed += 1;
      await env.DB.prepare(`DELETE FROM notification_log WHERE notification_key=? AND telegram_user_id=?;`).bind(event.key,userId).run();
      summary.events.push({ game_pk:game.game_pk,notification_key:event.key,user_id:userId,type:event.type,error:String(error?.message || error) });
    }
  }
}

function subscriptionMatchesEvent(sub, game, event, playerTeams) {
  const type = String(sub.subject_type || "");
  const key = String(sub.subject_key || "").toUpperCase();
  const flag = event.flag;

  if (event.type === "goal") {
    if (type === "game") return key === String(game.game_pk) && truthy(sub.notify_goal);
    if (type === "team") return key === event.scoring_team_tri && truthy(sub.notify_goal);
    if (type === "player") {
      const playerId = String(sub.subject_key || "");
      if (String(event.scorer_id || "") === playerId) return truthy(sub.notify_goal);
      if ((event.assist_ids || []).map(String).includes(playerId)) return truthy(sub.notify_assist);
      return false;
    }
    return false;
  }

  if (event.type === "period_end") {
    if (!truthy(sub.notify_period_end)) return false;
  } else if (!truthy(sub[flag])) {
    return false;
  }

  if (type === "game") return key === String(game.game_pk);
  if (type === "team") return teamInGame(key, game);
  if (type === "player") {
    const team = playerTeams.get(String(sub.subject_key || ""));
    return Boolean(team && teamInGame(team, game));
  }
  return false;
}

function subscriptionTouchesGame(sub, game, playerTeams) {
  const type = String(sub.subject_type || "");
  const key = String(sub.subject_key || "").toUpperCase();
  if (type === "game") return key === String(game.game_pk);
  if (type === "team") return teamInGame(key, game);
  if (type === "player") {
    const team = playerTeams.get(String(sub.subject_key || ""));
    return Boolean(team && teamInGame(team, game));
  }
  return false;
}

function eventFromPlay(game, play, roster, teamIds) {
  const type = String(play?.typeDescKey || "").toLowerCase();
  const sort = playSort(play);
  if (!sort) return null;

  if (type === "goal") {
    const details = play?.details || {};
    const ownerId = Number(details.eventOwnerTeamId);
    const scoringTeam = teamIds.get(ownerId) || "";
    const scorerId = positiveInt(details.scoringPlayerId);
    const assistIds = [positiveInt(details.assist1PlayerId),positiveInt(details.assist2PlayerId)].filter(Boolean);
    const scorer = roster.get(scorerId)?.name || (scorerId ? `NHL ${scorerId}` : "");
    const assists = assistIds.map((id) => roster.get(id)?.name || `NHL ${id}`);
    const homeScore = finiteOrNull(details.homeScore);
    const awayScore = finiteOrNull(details.awayScore);
    return {
      key:`goal:${game.game_pk}:${sort}`,
      type:"goal",
      flag:"notify_goal",
      scoring_team_tri:scoringTeam,
      scorer_id:scorerId,
      assist_ids:assistIds,
      text:goalText(game,{ scoringTeam,scorer,assists,homeScore,awayScore }),
    };
  }

  if (type === "period-end") {
    const period = positiveInt(play?.periodDescriptor?.number) || 0;
    return {
      key:`period:${game.game_pk}:${period || sort}`,
      type:"period_end",
      flag:"notify_period_end",
      period,
      text:periodEndText(game, period),
    };
  }

  return null;
}

async function loadSubscriptions(db) {
  const result = await db.prepare(`
    SELECT s.subscription_id,s.telegram_user_id,s.subject_type,s.subject_key,
           s.notify_pregame,s.notify_start,s.notify_goal,s.notify_assist,s.notify_period_end,s.notify_final
    FROM subscriptions s
    JOIN telegram_users u ON u.telegram_user_id=s.telegram_user_id
    WHERE u.notifications_enabled=1
    ORDER BY s.telegram_user_id,s.subscription_id;
  `).all();
  return result.results || [];
}

async function loadPlayerTeams(db, subscriptions) {
  const ids = [...new Set(subscriptions.filter((s) => s.subject_type === "player" && /^\d+$/.test(String(s.subject_key || ""))).map((s) => Number(s.subject_key)))];
  const map = new Map();
  if (!ids.length) return map;
  const placeholders = ids.map(() => "?").join(",");
  const result = await db.prepare(`SELECT player_id,current_team_tri FROM players WHERE player_id IN (${placeholders});`).bind(...ids).all();
  for (const row of result.results || []) {
    if (row.current_team_tri) map.set(String(row.player_id),String(row.current_team_tri).toUpperCase());
  }
  return map;
}

async function loadScheduleWindow(now) {
  const dates = [-1,0,1].map((offset) => {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate()+offset);
    return d.toISOString().slice(0,10);
  });
  const payloads = await Promise.all(dates.map((date) => fetchNhl(`${NHL_BASE}/schedule/${date}`).catch((error) => {
    console.error("telegram notifier schedule fetch failed", date, error);
    return null;
  })));
  const byId = new Map();
  for (let i=0;i<payloads.length;i+=1) {
    for (const game of normalizeSchedule(payloads[i], dates[i])) byId.set(game.game_pk,game);
  }
  return [...byId.values()].sort((a,b) => String(a.start_utc || "").localeCompare(String(b.start_utc || "")));
}

function normalizeSchedule(payload, date) {
  if (!payload) return [];
  let games = Array.isArray(payload.games) ? payload.games : [];
  if (!games.length && Array.isArray(payload.gameWeek)) games = payload.gameWeek.flatMap((day) => day.games || []);
  return games.filter((game) => !game.gameDate || String(game.gameDate) === date).map((game) => {
    const home = game.homeTeam || {};
    const away = game.awayTeam || {};
    return {
      game_pk:Number(game.id || game.gameId || game.gamePk),
      start_utc:game.startTimeUTC || null,
      state:String(game.gameState || game.gameStatus || "").toUpperCase(),
      home:{ id:positiveInt(home.id),tri:String(home.abbrev || "").toUpperCase(),score:finiteOrNull(home.score) },
      away:{ id:positiveInt(away.id),tri:String(away.abbrev || "").toUpperCase(),score:finiteOrNull(away.score) },
    };
  }).filter((game) => Number.isSafeInteger(game.game_pk) && game.game_pk > 0 && game.home.tri && game.away.tri);
}

async function reserveNotification(db, key, userId, type, gamePk, payload) {
  const result = await db.prepare(`
    INSERT OR IGNORE INTO notification_log(
      notification_key,telegram_user_id,notification_type,subject_type,subject_key,game_pk,payload_json
    ) VALUES(?,?,?,?,?,?,?);
  `).bind(key,userId,type,"game",String(gamePk),gamePk,payload).run();
  return Number(result?.meta?.changes ?? result?.changes ?? 0) > 0;
}

async function sendTelegram(env, chatId, text) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body:JSON.stringify({ chat_id:chatId,text,disable_web_page_preview:true }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) throw new Error(`Telegram sendMessage failed: ${response.status}`);
  return payload;
}

async function fetchNhl(url) {
  const response = await fetch(url,{ headers:{ Accept:"application/json" } });
  if (!response.ok) throw new Error(`NHL HTTP ${response.status}`);
  return response.json();
}

function rosterMap(pbp) {
  const map = new Map();
  for (const spot of pbp?.rosterSpots || []) {
    const id = positiveInt(spot.playerId);
    if (!id) continue;
    const first = localized(spot.firstName);
    const last = localized(spot.lastName);
    map.set(id,{ name:[first,last].filter(Boolean).join(" ") || `NHL ${id}` });
  }
  return map;
}

function teamIdMap(game, pbp) {
  const map = new Map();
  if (game.home.id) map.set(game.home.id,game.home.tri);
  if (game.away.id) map.set(game.away.id,game.away.tri);
  const homeId = positiveInt(pbp?.homeTeam?.id);
  const awayId = positiveInt(pbp?.awayTeam?.id);
  if (homeId) map.set(homeId,game.home.tri);
  if (awayId) map.set(awayId,game.away.tri);
  return map;
}

function pregameText(game, mins) {
  const rounded = Math.max(1,Math.round(mins/5)*5);
  return `🏒 Скоро матч NHL\n${game.away.tri} — ${game.home.tri}\nДо начала ≈ ${rounded} мин.`;
}
function startText(game) { return `▶️ Матч начался\n${game.away.tri} — ${game.home.tri}`; }
function finalText(game) { return `✅ Матч завершён\n${game.away.tri} ${score(game.away.score)}:${score(game.home.score)} ${game.home.tri}`; }
function periodEndText(game, period) { return `⏸ Конец ${period || "—"}-го периода\n${game.away.tri} ${score(game.away.score)}:${score(game.home.score)} ${game.home.tri}`; }
function goalText(game, info) {
  const scoreLine = `${game.away.tri} ${score(info.awayScore ?? game.away.score)}:${score(info.homeScore ?? game.home.score)} ${game.home.tri}`;
  const scorer = info.scorer ? `\n${info.scorer}` : "";
  const assists = info.assists?.length ? `\nПередачи: ${info.assists.join(", ")}` : "";
  return `🚨 ГОЛ ${info.scoringTeam || "NHL"}\n${scoreLine}${scorer}${assists}`;
}

function teamInGame(tri, game) { return tri === game.home.tri || tri === game.away.tri; }
function playSort(play) { return positiveInt(play?.sortOrder) || positiveInt(play?.eventId) || 0; }
function currentPeriod(pbp) { return positiveInt(pbp?.periodDescriptor?.number) || positiveInt(pbp?.plays?.at?.(-1)?.periodDescriptor?.number) || null; }
function minSubscription(sub) { return { subscription_id:sub.subscription_id,subject_type:sub.subject_type,subject_key:sub.subject_key }; }
function truthy(value) { return Number(value) === 1 || value === true; }
function finiteOrNull(value) { const n=Number(value); return Number.isFinite(n) ? n : null; }
function positiveInt(value) { const n=Number(value); return Number.isSafeInteger(n) && n > 0 ? n : null; }
function score(value) { return value === null || value === undefined ? "—" : String(value); }
function localized(value) { if (!value) return ""; if (typeof value === "string") return value; return value.default || value.en || Object.values(value)[0] || ""; }
function envFlag(value,fallback=false) { if (value===undefined || value===null || value==="") return fallback; return ["1","true","yes","on"].includes(String(value).trim().toLowerCase()); }
function envInt(value,fallback,min,max) { const n=Number(value); return Number.isSafeInteger(n) && n>=min && n<=max ? n : fallback; }
