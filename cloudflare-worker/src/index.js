import { importCurrentTeams, importGame } from "./data-core-importer.js";

const DEFAULT_TARGET_CHAT = "-1003167239288";
const DEFAULT_REPOSITORY = "RNGN-Home-of-Hockey/HOH_NHL_Daily_Results";
const DEFAULT_GITHUB_REF = "main";
const NHL_BASE = "https://api-web.nhle.com/v1";

const DATA_CORE_TABLES = [
  "broadcast_cards",
  "event_players",
  "game_events",
  "games",
  "goalie_game_stats",
  "insights",
  "notification_log",
  "period_scores",
  "player_game_stats",
  "players",
  "standings_snapshots",
  "subscriptions",
  "sync_runs",
  "team_game_advanced_features",
  "team_game_features",
  "team_game_stats",
  "teams",
  "telegram_users",
  "winline_events",
  "winline_markets",
  "sports_news",
  "sports_news_players",
  "sports_news_comments",
  "sports_player_sources",
];

const TEAM_RU = {
  ANA: "Анахайм",
  ARI: "Аризона",
  BOS: "Бостон",
  BUF: "Баффало",
  CGY: "Калгари",
  CAR: "Каролина",
  CHI: "Чикаго",
  COL: "Колорадо",
  CBJ: "Коламбус",
  DAL: "Даллас",
  DET: "Детройт",
  EDM: "Эдмонтон",
  FLA: "Флорида",
  LAK: "Лос-Анджелес",
  MIN: "Миннесота",
  MTL: "Монреаль",
  NSH: "Нэшвилл",
  NJD: "Нью-Джерси",
  NYI: "Айлендерс",
  NYR: "Рейнджерс",
  OTT: "Оттава",
  PHI: "Филадельфия",
  PIT: "Питтсбург",
  SJS: "Сан-Хосе",
  SEA: "Сиэтл",
  STL: "Сент-Луис",
  TBL: "Тампа-Бэй",
  TOR: "Торонто",
  VAN: "Ванкувер",
  VGK: "Вегас",
  WSH: "Вашингтон",
  WPG: "Виннипег",
  UTA: "Юта",
};

const TEAM_EMOJI = {
  ANA: "🦆",
  ARI: "🦊",
  BOS: "🐻",
  BUF: "🦬",
  CGY: "🔥",
  CAR: "🌪️",
  CHI: "🦅",
  COL: "⛰️",
  CBJ: "💣",
  DAL: "⭐",
  DET: "🛡️",
  EDM: "🛢️",
  FLA: "🐆",
  LAK: "👑",
  MIN: "🌲",
  MTL: "🇨🇦",
  NSH: "🐯",
  NJD: "😈",
  NYI: "🏝️",
  NYR: "🗽",
  OTT: "🛡",
  PHI: "🛩",
  PIT: "🐧",
  SJS: "🦈",
  SEA: "🦑",
  STL: "🎵",
  TBL: "⚡",
  TOR: "🍁",
  VAN: "🐳",
  VGK: "🎰",
  WSH: "🦅",
  WPG: "✈️",
  UTA: "🧊",
};

const WEEKDAYS_RU = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },

  async scheduled(controller, env, ctx) {
    if (!envFlag(env.CLOUDFLARE_CRON_ENABLED, false)) {
      return;
    }

    ctx.waitUntil(
      triggerRepositoryDispatch(env, eventName(env, "GITHUB_DISPATCH_EVENT_POLL", "nhl_poll"), {
        source: "cloudflare_cron",
        scheduled_time: controller.scheduledTime,
      }),
    );
  },
};

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = stripTrailingSlash(url.pathname);

  if (path === "") {
    return jsonResponse({ ok: true, service: "hoh-nhl-daily-results", runtime: "cloudflare-workers" });
  }

  if (["/api/data-core/health", "/data-core/health"].includes(path)) {
    return dataCoreHealthRoute(env);
  }

  if (path === "/api/admin/health") {
    return adminHealthRoute(request, env);
  }

  if (path === "/api/data-core/import/teams") {
    return dataCoreImportTeamsRoute(request, env);
  }

  if (path === "/api/data-core/import/game") {
    return dataCoreImportGameRoute(request, env);
  }

  if (path === "/api/telegram/legacy/status") {
    if (request.method !== "GET") {
      return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
    }
    return legacyTelegramStatusRoute(env);
  }

  if (["/api/setup-webhook", "/setup-webhook"].includes(path)) {
    return setupWebhook(request, env);
  }

  if (["/api/menu", "/menu"].includes(path)) {
    return sendMenuRoute(request, env);
  }

  if (["/api/setup-commands", "/setup-commands"].includes(path)) {
    return setupCommandsRoute(request, env);
  }

  if (["/api/telegram", "/telegram"].includes(path)) {
    return telegramWebhook(request, env);
  }

  if (["/api/cron", "/cron"].includes(path)) {
    return cronRoute(request, env);
  }

  return jsonResponse({ ok: false, error: "not_found" }, 404);
}

async function dataCoreHealthRoute(env) {
  const responseBase = {
    service: "hoh-data-core",
    binding: "DB",
  };

  if (!env.DB) {
    return jsonResponse(
      {
        ok: false,
        ...responseBase,
        schema_ok: false,
        error: "missing_d1_binding",
      },
      503,
    );
  }

  try {
    const tablesResult = await env.DB.prepare(
      `SELECT name
       FROM sqlite_schema
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
       ORDER BY name;`,
    ).all();
    const availableTables = new Set((tablesResult.results || []).map((row) => String(row.name)));
    const presentTables = DATA_CORE_TABLES.filter((name) => availableTables.has(name));
    const missingTables = DATA_CORE_TABLES.filter((name) => !availableTables.has(name));
    const schemaOk = missingTables.length === 0;

    if (!schemaOk) {
      return jsonResponse(
        {
          ok: false,
          ...responseBase,
          schema_ok: false,
          expected_table_count: DATA_CORE_TABLES.length,
          present_table_count: presentTables.length,
          missing_tables: missingTables,
          present_tables: presentTables,
        },
        503,
      );
    }

    const counts = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM teams) AS teams,
         (SELECT COUNT(*) FROM players) AS players,
         (SELECT COUNT(*) FROM games) AS games;`,
    ).first();
    if (!counts) {
      throw new Error("missing_counts_row");
    }

    return jsonResponse({
      ok: true,
      ...responseBase,
      schema_ok: true,
      expected_table_count: DATA_CORE_TABLES.length,
      present_table_count: presentTables.length,
      missing_tables: [],
      present_tables: presentTables,
      counts: {
        teams: Number(counts.teams),
        players: Number(counts.players),
        games: Number(counts.games),
      },
    });
  } catch {
    return jsonResponse(
      {
        ok: false,
        ...responseBase,
        schema_ok: false,
        error: "d1_query_failed",
      },
      500,
    );
  }
}

async function dataCoreImportTeamsRoute(request, env) {
  if (request.method !== "POST") {
    return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  }
  if (!(await isManagementAuthorized(request, env))) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }
  if (!env.DB) {
    return jsonResponse({ ok: false, action: "import_teams", error: "missing_d1_binding" }, 503);
  }

  try {
    return jsonResponse(await importCurrentTeams(env.DB));
  } catch {
    return jsonResponse({ ok: false, action: "import_teams", error: "import_failed" }, 500);
  }
}

async function dataCoreImportGameRoute(request, env) {
  if (request.method !== "POST") {
    return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  }
  if (!(await isManagementAuthorized(request, env))) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }
  if (!env.DB) {
    return jsonResponse({ ok: false, action: "import_game", error: "missing_d1_binding" }, 503);
  }

  const rawGamePk = new URL(request.url).searchParams.get("game_pk") || "";
  if (!/^\d+$/.test(rawGamePk)) {
    return jsonResponse({ ok: false, action: "import_game", error: "invalid_game_pk" }, 400);
  }
  const gamePk = Number(rawGamePk);
  if (!Number.isSafeInteger(gamePk) || gamePk <= 0) {
    return jsonResponse({ ok: false, action: "import_game", error: "invalid_game_pk" }, 400);
  }

  try {
    return jsonResponse(await importGame(env.DB, gamePk));
  } catch {
    return jsonResponse({ ok: false, action: "import_game", game_pk: gamePk, error: "import_failed" }, 500);
  }
}

async function setupWebhook(request, env) {
  if (!(await isManagementAuthorized(request, env))) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }

  const verifySecret = await telegramWebhookDeliverySecret(env);
  if (!verifySecret) {
    return jsonResponse(
      { ok: false, error: "missing_telegram_webhook_verify_secret" },
      503,
    );
  }

  const url = new URL(request.url);
  const webhookUrl = `${publicBaseUrl(request, env)}/api/telegram`;
  const telegram = await telegramRequest(env, "setWebhook", {
    url: webhookUrl,
    secret_token: verifySecret,
    allowed_updates: ["message", "channel_post", "callback_query"],
  });
  const commands = await setBotCommands(env);

  let menu = null;
  if (queryBool(url, "send_menu", true) && telegram.ok) {
    menu = await sendMenu(env, menuChatId(env));
  }

  return jsonResponse(
    {
      ok: telegram.ok,
      webhook_url: webhookUrl,
      webhook_secret: "configured",
      telegram,
      commands,
      menu,
    },
    telegram.ok ? 200 : 500,
  );
}


function legacyWebhookUrl(env) {
  const base = String(env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  return `${base || "https://hoh-nhl-daily-results.znamteam-903.workers.dev"}/api/telegram`;
}

export async function ensureLegacyTelegramWebhook(env) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    return { ok: false, error: "missing_TELEGRAM_BOT_TOKEN" };
  }
  const verifySecret = await telegramWebhookDeliverySecret(env);
  if (!verifySecret) {
    return { ok: false, error: "missing_telegram_webhook_verify_secret" };
  }

  const expectedUrl = legacyWebhookUrl(env);
  const before = await telegramRequest(env, "getWebhookInfo", {});
  const beforeInfo = before.ok ? (before.response?.result || {}) : {};
  const needsRepair =
    !before.ok ||
    String(beforeInfo.url || "") !== expectedUrl ||
    Boolean(beforeInfo.last_error_message);

  let setWebhook = { ok: true, skipped: true };
  if (needsRepair) {
    setWebhook = await telegramRequest(env, "setWebhook", {
      url: expectedUrl,
      secret_token: verifySecret,
      allowed_updates: ["message", "channel_post", "callback_query"],
      drop_pending_updates: false,
    });
  }

  const commands = await setBotCommands(env);
  const after = await telegramRequest(env, "getWebhookInfo", {});
  const info = after.ok ? (after.response?.result || {}) : {};
  const ok =
    setWebhook.ok &&
    commands.ok &&
    after.ok &&
    String(info.url || "") === expectedUrl;

  const setWebhookError = setWebhook.ok
    ? null
    : setWebhook.response?.description || setWebhook.error || "telegram_set_webhook_failed";
  const result = {
    ok,
    repaired: needsRepair && Boolean(setWebhook.ok),
    set_webhook_ok: Boolean(setWebhook.ok),
    set_webhook_error: setWebhookError,
    expected_webhook_url: expectedUrl,
    actual_webhook_url: String(info.url || ""),
    pending_update_count: Number(info.pending_update_count || 0),
    last_error_date: info.last_error_date || null,
    last_error_message: info.last_error_message || null,
    commands_ok: Boolean(commands.ok),
  };
  console.log("legacy_telegram_webhook_health", result);
  return result;
}

async function legacyTelegramStatusRoute(env) {
  const repair = await ensureLegacyTelegramWebhook(env);
  const [me, webhook] = await Promise.all([
    telegramRequest(env, "getMe", {}),
    telegramRequest(env, "getWebhookInfo", {}),
  ]);
  const bot = me.ok ? (me.response?.result || {}) : {};
  const info = webhook.ok ? (webhook.response?.result || {}) : {};
  return jsonResponse({
    ok: Boolean(repair.ok && me.ok && webhook.ok),
    service: "hoh-nhl-daily-results-legacy-bot",
    bot: {
      ok: Boolean(me.ok),
      id: bot.id ?? null,
      username: bot.username || null,
      first_name: bot.first_name || null,
    },
    webhook: {
      ok: Boolean(webhook.ok),
      url: String(info.url || ""),
      pending_update_count: Number(info.pending_update_count || 0),
      last_error_date: info.last_error_date || null,
      last_error_message: info.last_error_message || null,
      allowed_updates: Array.isArray(info.allowed_updates) ? info.allowed_updates : null,
    },
    repair,
  }, repair.ok ? 200 : 502);
}


async function sendMenuRoute(request, env) {
  if (!(await isManagementAuthorized(request, env))) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }

  const url = new URL(request.url);
  const chatId = (url.searchParams.get("chat") || menuChatId(env)).trim();
  if (!chatId) {
    return jsonResponse({ ok: false, error: "missing_chat" }, 500);
  }

  const telegram = await sendMenu(env, chatId);
  return jsonResponse({ ok: telegram.ok, chat_id: chatId, telegram }, telegram.ok ? 200 : 500);
}

async function setupCommandsRoute(request, env) {
  if (!(await isManagementAuthorized(request, env))) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }

  const commands = await setBotCommands(env);
  return jsonResponse({ ok: commands.ok, commands }, commands.ok ? 200 : 500);
}

async function setBotCommands(env) {
  return telegramRequest(env, "setMyCommands", {
    commands: [
      { command: "menu", description: "Меню расписания и результатов НХЛ" },
      { command: "today", description: "Матчи сегодняшнего дня по Лос-Анджелесу" },
      { command: "yesterday", description: "Матчи предыдущего игрового дня" },
      { command: "schedule", description: "Расписание: /schedule 2026-09-21" },
      { command: "results", description: "Все завершённые матчи выбранного дня" },
      { command: "game", description: "Подробности матча по gamePk" },
      { command: "latest", description: "Последние завершённые матчи" },
      { command: "resend", description: "Повторить последний игровой день (служебное)" },
    ],
  });
}

async function telegramWebhook(request, env) {
  if (request.method !== "POST") {
    return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  }

  const expectedSecret = await telegramWebhookDeliverySecret(env);
  if (!expectedSecret) {
    return jsonResponse(
      { ok: false, error: "missing_telegram_webhook_verify_secret" },
      503,
    );
  }

  const providedSecret = request.headers.get("x-telegram-bot-api-secret-token") || "";
  if (!providedSecret || !(await secureEqual(providedSecret, expectedSecret))) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }

  const update = await request.json();
  const callback = update.callback_query || null;
  if (callback) {
    return handleCallback(callback, env);
  }

  const message = update.message || update.channel_post || {};
  const chatId = message.chat?.id;
  const chatType = String(message.chat?.type || "");
  const text = String(message.text || "");
  const command = commandName(text);
  const readOnlyCommand = ["/start", "/menu", "/help", "/today", "/yesterday", "/schedule", "/results", "/game", "/latest"].includes(command);
  const canRead = isAllowedChat(env, chatId) || chatType === "private";

  if (readOnlyCommand && !canRead) {
    return jsonResponse({ ok: true, skipped: "chat_not_allowed" });
  }
  if (!readOnlyCommand && !isAllowedChat(env, chatId)) {
    return jsonResponse({ ok: true, skipped: "chat_not_allowed" });
  }

  const threadId = firstInt(message.message_thread_id) || null;
  if (["/start", "/menu", "/help"].includes(command)) {
    await sendMenu(env, chatId, threadId);
  } else if (command === "/today") {
    await sendScheduleDay(env, chatId, currentCalendarDayPT(), threadId);
  } else if (command === "/yesterday") {
    await sendScheduleDay(env, chatId, addDays(currentCalendarDayPT(), -1), threadId);
  } else if (command === "/latest") {
    await sendLatestMatches(env, chatId, threadId);
  } else if (command === "/schedule") {
    const rawDay = commandArgument(text);
    const day = rawDay ? normalizeDay(rawDay) : currentCalendarDayPT();
    if (!day) {
      await sendText(env, chatId, "Формат: <code>/schedule YYYY-MM-DD</code>", null, threadId, "HTML");
    } else {
      await sendScheduleDay(env, chatId, day, threadId);
    }
  } else if (command === "/results") {
    const rawDay = commandArgument(text);
    const day = rawDay ? normalizeDay(rawDay) : addDays(currentCalendarDayPT(), -1);
    if (!day) {
      await sendText(env, chatId, "Формат: <code>/results YYYY-MM-DD</code>", null, threadId, "HTML");
    } else {
      await dispatchFullDay(env, chatId, day, threadId);
    }
  } else if (command === "/game") {
    const gamePk = firstInt(commandArgument(text));
    if (!gamePk) {
      await sendText(env, chatId, "Формат: <code>/game GAME_PK</code>", null, threadId, "HTML");
    } else {
      await dispatchGameResult(env, chatId, gamePk, threadId);
    }
  } else if (["/reload", "/resend"].includes(command)) {
    await resendLatestDay(env, chatId);
  }

  return jsonResponse({ ok: true });
}

async function cronRoute(request, env) {
  if (!(await isManagementAuthorized(request, env))) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }

  const result = await triggerRepositoryDispatch(env, eventName(env, "GITHUB_DISPATCH_EVENT_POLL", "nhl_poll"), {
    source: "cloudflare_http_cron",
  });
  return jsonResponse({ ok: true, dispatch: result });
}

async function handleCallback(callback, env) {
  const callbackId = callback.id;
  const data = String(callback.data || "");
  const message = callback.message || {};
  const chatId = message.chat?.id;
  const chatType = String(message.chat?.type || "");
  const threadId = firstInt(message.message_thread_id) || null;
  const readOnly =
    data === "menu" ||
    data === "latest_matches" ||
    data === "schedule_overview" ||
    data.startsWith("day:") ||
    data.startsWith("game:") ||
    data.startsWith("full:");
  const canRead = isAllowedChat(env, chatId) || chatType === "private";

  if (readOnly && !canRead) {
    await answerCallback(env, callbackId, "Меню доступно в личном чате с ботом или в группе HOH.");
    return jsonResponse({ ok: true, skipped: "chat_not_allowed" });
  }
  if (!readOnly && !isAllowedChat(env, chatId)) {
    await answerCallback(env, callbackId, "Эта служебная кнопка доступна только в группе HOH.");
    return jsonResponse({ ok: true, skipped: "chat_not_allowed" });
  }

  if (data === "menu") {
    await answerCallback(env, callbackId, "Меню");
    await sendMenu(env, chatId, threadId);
    return jsonResponse({ ok: true, action: data });
  }

  if (data === "latest_matches") {
    await answerCallback(env, callbackId, "Показываю последние матчи...");
    await sendLatestMatches(env, chatId, threadId);
    return jsonResponse({ ok: true, action: data });
  }

  if (data === "schedule_overview") {
    await answerCallback(env, callbackId, "Выбери игровой день");
    await sendScheduleOverview(env, chatId, threadId);
    return jsonResponse({ ok: true, action: data });
  }

  if (data.startsWith("day:")) {
    const day = normalizeDay(data.slice(4));
    if (!day) {
      await answerCallback(env, callbackId, "Некорректная дата");
      return jsonResponse({ ok: false, error: "invalid_day" }, 400);
    }
    await answerCallback(env, callbackId, "Загружаю расписание...");
    await sendScheduleDay(env, chatId, day, threadId);
    return jsonResponse({ ok: true, action: "day", day });
  }

  if (data.startsWith("game:")) {
    const parts = data.split(":");
    const gamePk = firstInt(parts[1]);
    if (!gamePk) {
      await answerCallback(env, callbackId, "Матч не найден");
      return jsonResponse({ ok: false, error: "invalid_game" }, 400);
    }
    await answerCallback(env, callbackId, "Собираю подробности матча...");
    const result = await dispatchGameResult(env, chatId, gamePk, threadId);
    return jsonResponse({ ok: result.ok, action: "game", game_pk: gamePk }, result.ok ? 200 : 500);
  }

  if (data.startsWith("full:")) {
    const day = normalizeDay(data.slice(5));
    if (!day) {
      await answerCallback(env, callbackId, "Некорректная дата");
      return jsonResponse({ ok: false, error: "invalid_day" }, 400);
    }
    await answerCallback(env, callbackId, "Собираю все результаты дня...");
    const result = await dispatchFullDay(env, chatId, day, threadId);
    return jsonResponse({ ok: result.ok, action: "full_day", day }, result.ok ? 200 : 500);
  }

  if (data === "resend_last_day") {
    await answerCallback(env, callbackId, "Запускаю повторную отправку...");
    const result = await resendLatestDay(env, chatId);
    return jsonResponse({ ok: result.ok, action: data, dispatch: result }, result.ok ? 200 : 500);
  }

  await answerCallback(env, callbackId, "Неизвестная команда");
  return jsonResponse({ ok: false, error: "unknown_callback" }, 400);
}

async function sendLatestMatches(env, chatId, threadId = null) {
  try {
    await sendText(env, chatId, await latestMatchesText(env), null, threadId);
    return { ok: true };
  } catch (error) {
    await sendText(env, chatId, `Не получилось загрузить последние матчи: ${error.message}`, null, threadId);
    return { ok: false, error: error.message };
  }
}

async function sendScheduleOverview(env, chatId, threadId = null) {
  try {
    const today = currentCalendarDayPT();
    const daysBack = envInt(env.MENU_SCHEDULE_DAYS_BACK, 2, 0, 7);
    const daysForward = envInt(env.MENU_SCHEDULE_DAYS_FORWARD, 7, 1, 21);
    const rows = [];
    const lines = [
      "🗓 <b>Расписание НХЛ</b>",
      "",
      "Игровой день считается по календарной дате Лос-Анджелеса (PT). Выбери день:",
    ];

    const buttons = [];
    for (const day of dateRange(today, -daysBack, daysForward)) {
      const metas = await metasForDay(day);
      const finals = metas.filter((m) => isFinalState(m.state)).length;
      const live = metas.filter((m) => isLiveishState(m.state)).length;
      const icon = day === today ? "•" : finals === metas.length && metas.length ? "✅" : live ? "🔴" : "🗓";
      buttons.push({
        text: `${icon} ${formatDay(day)} · ${metas.length}`,
        callback_data: `day:${day}`,
      });
    }
    for (let i = 0; i < buttons.length; i += 2) {
      rows.push(buttons.slice(i, i + 2));
    }
    rows.push([{ text: "🏠 Меню", callback_data: "menu" }]);

    await sendText(env, chatId, lines.join("\n"), { inline_keyboard: rows }, threadId, "HTML");
    return { ok: true };
  } catch (error) {
    await sendText(env, chatId, `Не получилось загрузить расписание: ${error.message}`, null, threadId);
    return { ok: false, error: error.message };
  }
}

async function sendScheduleDay(env, chatId, day, threadId = null) {
  try {
    const metas = await metasForDay(day);
    const total = metas.length;
    const finalCount = metas.filter((meta) => isFinalState(meta.state)).length;
    const liveCount = metas.filter((meta) => isLiveishState(meta.state)).length;
    const upcomingCount = Math.max(0, total - finalCount - liveCount);
    const competition = competitionTitle(metas);
    const lines = [
      `🗓 <b>${escapeHtml(competition)} • ${formatRuDay(day)} • ${total} ${pluralRu(total, "матч", "матча", "матчей")}</b>`,
      "",
      `Лос-Анджелес (PT) · завершено <b>${finalCount}</b> · в игре <b>${liveCount}</b> · впереди <b>${upcomingCount}</b>`,
    ];
    const keyboard = [];

    if (!metas.length) {
      lines.push("", "На этот игровой день матчей не найдено.");
    } else {
      lines.push("");
      metas.forEach((meta, index) => {
        const away = TEAM_RU[meta.awayTri] || meta.awayTri;
        const home = TEAM_RU[meta.homeTri] || meta.homeTri;
        const awayEmoji = TEAM_EMOJI[meta.awayTri] || "";
        const homeEmoji = TEAM_EMOJI[meta.homeTri] || "";
        let tail = formatTimePT(meta.gameDateUTC);
        let button = `🕒 ${tail} · ${meta.awayTri} — ${meta.homeTri}`;
        if (isFinalState(meta.state)) {
          tail = `<b>${meta.awayScore}:${meta.homeScore}</b> ✅`;
          button = `✅ ${meta.awayTri} ${meta.awayScore}:${meta.homeScore} ${meta.homeTri}`;
        } else if (isLiveishState(meta.state)) {
          tail = `<b>${meta.awayScore}:${meta.homeScore}</b> 🔴 LIVE`;
          button = `🔴 ${meta.awayTri} ${meta.awayScore}:${meta.homeScore} ${meta.homeTri}`;
        }
        lines.push(
          `${index + 1}. ${awayEmoji} «${escapeHtml(away)}» — ${homeEmoji} «${escapeHtml(home)}» · ${tail}`,
        );
        keyboard.push([{ text: button.slice(0, 64), callback_data: `game:${meta.gamePk}` }]);
      });
    }

    if (finalCount > 0) {
      keyboard.push([{
        text: finalCount === total ? "📋 Все результаты дня" : `📋 Завершённые матчи · ${finalCount}/${total}`,
        callback_data: `full:${day}`,
      }]);
    }
    keyboard.push([
      { text: "← День", callback_data: `day:${addDays(day, -1)}` },
      { text: "🏠 Меню", callback_data: "menu" },
      { text: "День →", callback_data: `day:${addDays(day, 1)}` },
    ]);

    await sendText(env, chatId, lines.join("\n"), { inline_keyboard: keyboard }, threadId, "HTML");
    return { ok: true, games: total };
  } catch (error) {
    await sendText(env, chatId, `Не получилось загрузить день: ${error.message}`, null, threadId);
    return { ok: false, error: error.message };
  }
}

async function dispatchGameResult(env, chatId, gamePk, threadId = null) {
  try {
    const result = await triggerRepositoryDispatch(env, eventName(env, "GITHUB_DISPATCH_EVENT_POLL", "nhl_poll"), {
      source: "telegram_menu_game",
      gamepk: String(gamePk),
      target_chat_id: String(chatId),
      target_thread_id: threadId ? String(threadId) : "",
    });
    return { ok: true, ...result };
  } catch (error) {
    await sendText(env, chatId, `Не получилось запустить карточку матча: ${error.message}`, null, threadId);
    return { ok: false, error: error.message };
  }
}

async function dispatchFullDay(env, chatId, day, threadId = null) {
  try {
    const result = await triggerRepositoryDispatch(env, eventName(env, "GITHUB_DISPATCH_EVENT_POLL", "nhl_poll"), {
      source: "telegram_menu_full_day",
      date: day,
      full_day: "true",
      target_chat_id: String(chatId),
      target_thread_id: threadId ? String(threadId) : "",
    });
    return { ok: true, ...result };
  } catch (error) {
    await sendText(env, chatId, `Не получилось собрать результаты дня: ${error.message}`, null, threadId);
    return { ok: false, error: error.message };
  }
}

async function resendLatestDay(env, chatId) {
  await sendText(env, chatId, "Запускаю повторную отправку последнего игрового дня.");

  try {
    const result = await triggerRepositoryDispatch(env, eventName(env, "GITHUB_DISPATCH_EVENT_RESEND", "resend_last_day"), {
      source: "telegram_menu",
      resend_last_day: "true",
      target_chat_id: menuChatId(env),
    });
    await sendText(env, chatId, "Готово: GitHub Actions запущен, последний игровой день будет отправлен повторно.");
    return { ok: true, ...result };
  } catch (error) {
    await sendText(env, chatId, `Не получилось запустить повторную отправку: ${error.message}`);
    return { ok: false, error: error.message };
  }
}

async function latestMatchesText(env) {
  const baseDay = currentHockeyDayPT();
  const daysBack = envInt(env.MENU_LATEST_DAYS_BACK, 6, 1, 14);
  const limit = envInt(env.MENU_LATEST_LIMIT, 12, 3, 25);

  const metas = [];
  for (const day of dateRange(baseDay, -daysBack, 1)) {
    metas.push(...(await metasForDay(day)));
  }

  const seen = new Set();
  const finals = metas
    .filter((meta) => {
      if (seen.has(meta.gamePk) || !isFinalState(meta.state)) {
        return false;
      }
      seen.add(meta.gamePk);
      return true;
    })
    .sort((a, b) => b.gameDateUTC.getTime() - a.gameDateUTC.getTime());

  if (!finals.length) {
    return "Последние завершённые матчи не найдены.";
  }

  return ["Последние завершённые матчи", "", ...finals.slice(0, limit).map(matchLine)].join("\n");
}

async function scheduleOverviewText(env) {
  const baseDay = currentHockeyDayPT();
  const daysBack = envInt(env.MENU_SCHEDULE_DAYS_BACK, 2, 0, 7);
  const daysForward = envInt(env.MENU_SCHEDULE_DAYS_FORWARD, 10, 1, 21);
  const lines = ["Расписание NHL по игровым дням", ""];

  for (const day of dateRange(baseDay, -daysBack, daysForward)) {
    const metas = await metasForDay(day);
    const total = metas.length;
    const finalCount = metas.filter((meta) => isFinalState(meta.state)).length;
    const liveCount = metas.filter((meta) => isLiveishState(meta.state)).length;
    const upcomingCount = Math.max(0, total - finalCount - liveCount);
    const weekday = WEEKDAYS_RU[weekdayIndex(day)];
    const status = `${finalCount} завершено, ${liveCount} в игре, ${upcomingCount} впереди`;
    lines.push(`${formatDay(day)} ${weekday} — ${total} ${pluralRu(total, "матч", "матча", "матчей")}: ${status}`);
  }

  return lines.join("\n");
}

async function metasForDay(day) {
  const apiDays = [addDays(day, -1), day, addDays(day, 1)];
  const all = [];
  for (const apiDay of apiDays) {
    all.push(...(await fetchGamesForDay(apiDay)));
  }
  const seen = new Set();
  return all
    .map(gameToMeta)
    .filter(Boolean)
    .filter((meta) => {
      if (seen.has(meta.gamePk) || toPTDate(meta.gameDateUTC) !== day) {
        return false;
      }
      seen.add(meta.gamePk);
      return true;
    })
    .sort((a, b) => a.gameDateUTC.getTime() - b.gameDateUTC.getTime());
}

async function fetchGamesForDay(day) {
  const response = await fetch(`${NHL_BASE}/schedule/${day}`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`NHL schedule failed: HTTP ${response.status}`);
  }

  const payload = await response.json();
  let games = payload.games || [];
  if (!games.length && Array.isArray(payload.gameWeek)) {
    games = payload.gameWeek.flatMap((weekDay) => weekDay.games || []);
  }

  if (games.some((game) => Object.prototype.hasOwnProperty.call(game, "gameDate"))) {
    games = games.filter((game) => String(game.gameDate || "") === day);
  }

  const seen = new Set();
  return games.filter((game) => {
    const id = firstInt(game.id, game.gameId, game.gamePk);
    if (!id || seen.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  });
}

function gameToMeta(game) {
  const gamePk = firstInt(game.id, game.gameId, game.gamePk);
  if (!gamePk) {
    return null;
  }

  const home = game.homeTeam || {};
  const away = game.awayTeam || {};
  const homeTri = upper(home.abbrev || home.triCode || home.teamAbbrev);
  const awayTri = upper(away.abbrev || away.triCode || away.teamAbbrev);
  const homeScore = firstInt(home.score);
  const awayScore = firstInt(away.score);
  const state = upper(game.gameState || game.gameStatus);
  const gameType = firstInt(game.gameType);
  const gameDateUTC = parseGameDate(game.startTimeUTC || game.gameDate);

  const series = game.seriesStatus || {};
  const seriesGame = firstInt(series.gameNumberOfSeries) || null;
  let homeSeriesWins = null;
  let awaySeriesWins = null;
  const top = upper(series.topSeedTeamAbbrev);
  const bottom = upper(series.bottomSeedTeamAbbrev);
  const topWins = firstInt(series.topSeedWins);
  const bottomWins = firstInt(series.bottomSeedWins);

  if (homeTri === top) {
    homeSeriesWins = topWins;
  } else if (homeTri === bottom) {
    homeSeriesWins = bottomWins;
  }
  if (awayTri === top) {
    awaySeriesWins = topWins;
  } else if (awayTri === bottom) {
    awaySeriesWins = bottomWins;
  }

  if (
    seriesGame &&
    isFinalState(state) &&
    homeSeriesWins !== null &&
    awaySeriesWins !== null &&
    homeScore !== awayScore &&
    homeSeriesWins + awaySeriesWins === seriesGame - 1
  ) {
    if (homeScore > awayScore) {
      homeSeriesWins += 1;
    } else {
      awaySeriesWins += 1;
    }
  }

  return {
    gamePk,
    gameDateUTC,
    state,
    homeTri,
    awayTri,
    homeScore,
    awayScore,
    gameType,
    seriesGame,
    homeSeriesWins,
    awaySeriesWins,
  };
}

function matchLine(meta) {
  const details = seriesText(meta);
  const suffix = details ? ` · ${details}` : "";
  return `${formatDay(toPTDate(meta.gameDateUTC))} · ${teamLabel(meta.homeTri)} ${meta.homeScore}:${meta.awayScore} ${teamLabel(meta.awayTri)}${suffix}`;
}

function seriesText(meta) {
  const pieces = [];
  if (meta.seriesGame) {
    pieces.push(`Матч №${meta.seriesGame}`);
  }
  if (meta.homeSeriesWins !== null && meta.awaySeriesWins !== null) {
    pieces.push(`серия ${meta.homeSeriesWins}-${meta.awaySeriesWins}`);
  }
  return pieces.join(", ");
}

async function sendMenu(env, chatId, threadId = null) {
  const today = currentCalendarDayPT();
  const text = [
    "🏒 <b>HOH · Результаты НХЛ</b>",
    "",
    "Расписание и результаты считаются по календарному дню Лос-Анджелеса (PT).",
    "Выбери день, затем конкретный матч или все завершённые матчи дня.",
    "",
    "Произвольная дата: <code>/schedule YYYY-MM-DD</code>",
  ].join("\n");
  return sendText(env, chatId, text, {
    inline_keyboard: [
      [
        { text: "🗓 Сегодня", callback_data: `day:${today}` },
        { text: "↩️ Вчера", callback_data: `day:${addDays(today, -1)}` },
      ],
      [{ text: "📅 Выбрать день", callback_data: "schedule_overview" }],
      [{ text: "✅ Последние матчи", callback_data: "latest_matches" }],
    ],
  }, threadId, "HTML");
}

async function sendText(env, chatId, text, replyMarkup = null, threadId = null, parseMode = null) {
  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };

  if (threadId) {
    payload.message_thread_id = Number(threadId);
  } else if (String(chatId) === menuChatId(env) && env.TELEGRAM_THREAD_ID) {
    payload.message_thread_id = Number(env.TELEGRAM_THREAD_ID);
  }
  if (replyMarkup) {
    payload.reply_markup = replyMarkup;
  }
  if (parseMode) {
    payload.parse_mode = parseMode;
  }

  return telegramRequest(env, "sendMessage", payload);
}

async function answerCallback(env, callbackId, text) {
  if (!callbackId) {
    return null;
  }
  return telegramRequest(env, "answerCallbackQuery", {
    callback_query_id: callbackId,
    text,
  });
}

async function telegramRequest(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    return { ok: false, error: "missing_TELEGRAM_BOT_TOKEN" };
  }

  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  return {
    ok: response.ok && data.ok === true,
    status_code: response.status,
    response: data,
  };
}

async function triggerRepositoryDispatch(env, eventType, clientPayload) {
  const token = env.GITHUB_DISPATCH_TOKEN || env.GITHUB_STATE_TOKEN || env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("missing_GITHUB_DISPATCH_TOKEN");
  }

  const repository = env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY;
  const payload = {
    event_type: eventType,
    client_payload: {
      ref: env.GITHUB_REF || DEFAULT_GITHUB_REF,
      ...clientPayload,
    },
  };

  const response = await fetch(`https://api.github.com/repos/${repository}/dispatches`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "hoh-nhl-cloudflare-worker",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify(payload),
  });

  if (response.status !== 204) {
    const body = await response.text();
    throw new Error(`GitHub dispatch failed: HTTP ${response.status} ${body.slice(0, 300)}`);
  }

  return { ok: true, status_code: response.status, event_type: eventType };
}

async function adminHealthRoute(request, env) {
  if (!(await isManagementAuthorized(request, env))) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }
  if (request.method !== "GET") {
    return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  }
  return jsonResponse({ ok: true, service: "hoh-admin" });
}

async function isManagementAuthorized(request, env) {
  const expected = managementSecret(env);
  if (!expected) {
    return false;
  }

  const authorization = (request.headers.get("authorization") || "").trim();
  const match = /^Bearer\s+(\S+)$/i.exec(authorization);
  if (!match) {
    return false;
  }

  return secureEqual(match[1], expected);
}

async function secureEqual(provided, expected) {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

function isAllowedChat(env, chatId) {
  if (!chatId) {
    return false;
  }
  if (envFlag(env.TELEGRAM_ALLOW_ANY_CHAT, false)) {
    return true;
  }
  return String(chatId) === menuChatId(env);
}

function menuChatId(env) {
  return String(env.TELEGRAM_MENU_CHAT_ID || env.TELEGRAM_CHAT_ID || DEFAULT_TARGET_CHAT).trim();
}

function webhookSecret(env) {
  return String(env.TELEGRAM_WEBHOOK_VERIFY_SECRET || "").trim();
}

async function telegramWebhookDeliverySecret(env) {
  const raw = webhookSecret(env);
  if (!raw) {
    return "";
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function managementSecret(env) {
  return String(env.MANAGEMENT_API_SECRET || "").trim();
}

function publicBaseUrl(request, env) {
  const configured = String(env.PUBLIC_BASE_URL || "").trim();
  if (configured) {
    return configured.replace(/\/+$/, "");
  }
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

function commandName(text) {
  if (!text) {
    return "";
  }
  return text.trim().split(/\s+/)[0].toLowerCase().split("@", 1)[0];
}

function commandArgument(text) {
  const parts = String(text || "").trim().split(/\s+/, 2);
  return parts.length > 1 ? parts[1].trim() : "";
}

function normalizeDay(value) {
  const s = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return "";
  }
  const date = new Date(`${s}T12:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== s) {
    return "";
  }
  return s;
}

function currentCalendarDayPT(now = new Date()) {
  return partsInTimeZone(now, "America/Los_Angeles").date;
}

function competitionTitle(metas) {
  const counts = new Map();
  for (const meta of metas || []) {
    const gameType = Number(meta?.gameType || 0);
    if (gameType) {
      counts.set(gameType, (counts.get(gameType) || 0) + 1);
    }
  }
  let winner = 0;
  let best = -1;
  for (const [gameType, count] of counts) {
    if (count > best) {
      winner = gameType;
      best = count;
    }
  }
  return ({
    1: "Предсезонка НХЛ",
    2: "Регулярный чемпионат НХЛ",
    3: "Плей-офф НХЛ",
  })[winner] || "НХЛ";
}

function formatRuDay(day) {
  const months = [
    "", "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря",
  ];
  const [, month, dom] = String(day).split("-");
  return `${Number(dom)} ${months[Number(month)] || month}`;
}

function formatTimePT(date) {
  const parts = partsInTimeZone(date, "America/Los_Angeles");
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function currentHockeyDayPT(now = new Date()) {
  const pt = partsInTimeZone(now, "America/Los_Angeles");
  return pt.hour >= 6 ? pt.date : addDays(pt.date, -1);
}

function toPTDate(date) {
  return partsInTimeZone(date, "America/Los_Angeles").date;
}

function partsInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value || "";
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    hour: Number(value("hour")),
    minute: Number(value("minute")),
  };
}

function dateRange(baseDay, startOffset, endOffset) {
  const days = [];
  for (let offset = startOffset; offset <= endOffset; offset += 1) {
    days.push(addDays(baseDay, offset));
  }
  return days;
}

function addDays(day, offset) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function parseGameDate(value) {
  if (!value) {
    return new Date();
  }
  const raw = String(value);
  return new Date(raw.includes("T") ? raw : `${raw}T12:00:00Z`);
}

function formatDay(day) {
  const date = typeof day === "string" ? day : day.toISOString().slice(0, 10);
  const [, month, dom] = date.split("-");
  return `${dom}.${month}`;
}

function weekdayIndex(day) {
  const jsDay = new Date(`${day}T12:00:00Z`).getUTCDay();
  return (jsDay + 6) % 7;
}

function teamLabel(tricode) {
  return `${TEAM_EMOJI[tricode] || ""} ${TEAM_RU[tricode] || tricode}`.trim();
}

function isFinalState(state) {
  return ["FINAL", "OFF"].includes(upper(state));
}

function isLiveishState(state) {
  return ["LIVE", "CRIT"].includes(upper(state));
}

function firstInt(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.trunc(value);
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return 0;
}

function upper(value) {
  return String(value || "").trim().toUpperCase();
}

function pluralRu(n, one, few, many) {
  const abs = Math.abs(n);
  if (abs % 100 >= 11 && abs % 100 <= 14) {
    return many;
  }
  if (abs % 10 === 1) {
    return one;
  }
  if (abs % 10 >= 2 && abs % 10 <= 4) {
    return few;
  }
  return many;
}

function envInt(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(minimum, Math.min(maximum, parsed));
}

function envFlag(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return ["1", "true", "yes", "y", "on"].includes(String(value).trim().toLowerCase());
}

function eventName(env, key, fallback) {
  return String(env[key] || fallback).trim() || fallback;
}

function queryBool(url, name, fallback) {
  if (!url.searchParams.has(name)) {
    return fallback;
  }
  return envFlag(url.searchParams.get(name), fallback);
}

function stripTrailingSlash(path) {
  if (path === "/") {
    return "";
  }
  return path.replace(/\/+$/, "");
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
