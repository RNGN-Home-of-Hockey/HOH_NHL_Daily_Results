const DEFAULT_CENTER_WEBHOOK_URL = "https://hoh-nhl-daily-results.znamteam-903.workers.dev/telegram/center?v=20260921-1";
const CENTER_WEBHOOK_REFRESH_KEY = "telegram_center_webhook_refresh_v3";
const CENTER_WEBHOOK_REFRESH_MS = 6 * 60 * 60 * 1000;
const CENTER_POLL_OFFSET_KEY = "telegram_center_poll_offset_v1";
const CENTER_POLL_STATUS_KEY = "telegram_center_poll_status_v1";
const CENTER_POLL_SETUP_KEY = "telegram_center_poll_setup_v18";
const CENTER_MINI_APP_BUILD = "24.8.0";
const CENTER_CANONICAL_MINI_APP_PATH = "/telegram-app-v24";
const CENTER_DEFAULT_MINI_APP_URL = "https://hoh-nhl-daily-results.znamteam-903.workers.dev/telegram-app-v24?build=24.8.0";

function centerDeliveryMode(env) {
  return String(env.TELEGRAM_CENTER_DELIVERY_MODE || "webhook").trim().toLowerCase() === "polling"
    ? "polling"
    : "webhook";
}

export async function handleTelegramProductBotRequest(request, env, path) {
  if (path === "/api/telegram-app/setup") {
    return setupMiniAppButton(request, env);
  }

  if (path === "/api/telegram/center/status") {
    if (request.method !== "GET") {
      return json({ ok: false, error: "method_not_allowed" }, 405);
    }
    return centerStatus(request, env);
  }

  if (path === "/api/telegram/center/repair-webhook") {
    if (request.method !== "POST") {
      return json({ ok: false, error: "method_not_allowed" }, 405);
    }
    return repairCenterWebhook(request, env);
  }

  if (!["/api/telegram/center", "/telegram/center"].includes(path) || request.method !== "POST") {
    return null;
  }

  console.log("telegram_center_webhook_received", { path });

  const expected = await telegramWebhookSecret(env);
  const provided = request.headers.get("x-telegram-bot-api-secret-token") || "";
  if (!expected) {
    console.log("telegram_center_webhook_missing_secret_config");
    await recordCenterDiagnostic(env, {
      stage: "webhook_rejected",
      reason: "missing_secret_config",
    });
    return json({ ok: false, error: "telegram_webhook_missing_secret_config" }, 401);
  }
  if (!provided || !(await secureEqual(provided, expected))) {
    console.log("telegram_center_webhook_secret_mismatch");
    await recordCenterDiagnostic(env, {
      stage: "webhook_rejected",
      reason: "secret_mismatch",
    });
    return json({ ok: false, error: "telegram_webhook_secret_mismatch" }, 401);
  }

  let update;
  try {
    update = await request.json();
  } catch {
    console.log("telegram_center_webhook_invalid_json");
    await recordCenterDiagnostic(env, {
      stage: "webhook_rejected",
      reason: "invalid_json",
    });
    return json({ ok: false, error: "telegram_webhook_invalid_json" }, 400);
  }

  const message = update.message || null;
  console.log("telegram_center_update", {
    has_message: Boolean(message),
    chat_type: message?.chat?.type || null,
    has_text: Boolean(message?.text),
  });

  if (!message || message.chat?.type !== "private") {
    await recordCenterDiagnostic(env, {
      stage: "update_skipped",
      reason: "unsupported_update",
      has_message: Boolean(message),
      chat_type: message?.chat?.type || null,
    });
    return json({ ok: true, skipped: "unsupported_update" });
  }

  const command = commandName(message.text || "");
  console.log("telegram_center_command", {
    command,
    chat_id_present: Boolean(message.chat?.id),
  });

  if (!["/start", "/menu", "/help", "/app"].includes(command)) {
    await recordCenterDiagnostic(env, {
      stage: "update_skipped",
      reason: "private_command_not_handled",
      command,
    });
    return json({ ok: true, skipped: "private_command_not_handled" });
  }

  const chatId = message.chat?.id;
  if (!chatId) {
    await recordCenterDiagnostic(env, {
      stage: "update_skipped",
      reason: "missing_chat",
      command,
    });
    return json({ ok: true, skipped: "missing_chat" });
  }

  const centerText = "🏒 HOH NHL Center\n\nТвой персональный центр NHL:\n\n• игроки\n• команды\n• матчи\n• уведомления\n• статистика";
  const miniApp = miniAppUrl(request, env);

  const primary = await telegramRequest(env, "sendMessage", {
    chat_id: chatId,
    text: centerText,
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [[
        {
          text: "🏒 Открыть HOH NHL Center",
          web_app: { url: miniApp },
        },
      ]],
    },
  });

  console.log("telegram_center_send_result", {
    ok: primary.ok,
    status_code: primary.status_code || null,
    error: primary.response?.description || primary.error || null,
  });

  let fallback = null;
  if (!primary.ok) {
    fallback = await telegramRequest(env, "sendMessage", {
      chat_id: chatId,
      text: `${centerText}\n\nОткрыть приложение: ${miniApp}`,
      disable_web_page_preview: true,
    });
    console.log("telegram_center_fallback_send_result", {
      ok: fallback.ok,
      status_code: fallback.status_code || null,
      error: fallback.response?.description || fallback.error || null,
    });
  }

  const delivered = primary.ok || Boolean(fallback?.ok);
  const telegramError = delivered
    ? null
    : fallback?.response?.description ||
      fallback?.error ||
      primary.response?.description ||
      primary.error ||
      "telegram_send_failed";

  await recordCenterDiagnostic(env, {
    stage: "command_processed",
    command,
    primary_delivered: primary.ok,
    fallback_attempted: Boolean(fallback),
    fallback_delivered: Boolean(fallback?.ok),
    delivered,
    primary_error: primary.ok ? null : primary.response?.description || primary.error || "telegram_send_failed",
    telegram_error: telegramError,
  });

  return json({
    ok: true,
    action: "center_menu",
    delivered,
    fallback_used: Boolean(fallback),
    telegram_error: telegramError,
  });
}

async function centerStatus(request, env) {
  const deliveryMode = centerDeliveryMode(env);
  let deliverySetup = deliveryMode === "polling"
    ? await ensureTelegramCenterPolling(env)
    : await ensureTelegramCenterWebhook(env);
  const centerTokenConfigured = Boolean(String(env.TELEGRAM_CENTER_BOT_TOKEN || "").trim());
  const webhookSecretConfigured = Boolean(String(env.TELEGRAM_WEBHOOK_VERIFY_SECRET || "").trim());
  const expectedMiniApp = miniAppUrl(request, env);

  let bot = { ok: false, error: "missing_telegram_center_token" };
  let webhook = { ok: false, error: "missing_telegram_center_token" };
  let commands = { ok: false, error: "missing_telegram_center_token" };
  let menuButton = { ok: false, error: "missing_telegram_center_token" };

  async function readTelegramState() {
    const [getMe, getWebhookInfo, getCommands, getMenuButton] = await Promise.all([
      telegramRequest(env, "getMe", {}),
      telegramRequest(env, "getWebhookInfo", {}),
      telegramRequest(env, "getMyCommands", {}),
      telegramRequest(env, "getChatMenuButton", {}),
    ]);

    bot = getMe.ok
      ? {
          ok: true,
          id: getMe.response?.result?.id ?? null,
          username: getMe.response?.result?.username || null,
          first_name: getMe.response?.result?.first_name || null,
        }
      : {
          ok: false,
          status_code: getMe.status_code || null,
          error: getMe.response?.description || getMe.error || "telegram_get_me_failed",
        };

    commands = getCommands.ok
      ? { ok: true, items: getCommands.response?.result || [] }
      : { ok: false, status_code: getCommands.status_code || null, error: getCommands.response?.description || getCommands.error || "telegram_get_commands_failed" };

    menuButton = getMenuButton.ok
      ? { ok: true, value: getMenuButton.response?.result || null }
      : { ok: false, status_code: getMenuButton.status_code || null, error: getMenuButton.response?.description || getMenuButton.error || "telegram_get_menu_button_failed" };

    if (getWebhookInfo.ok) {
      const info = getWebhookInfo.response?.result || {};
      webhook = {
        ok: true,
        url: info.url || "",
        pending_update_count: Number(info.pending_update_count || 0),
        last_error_date: info.last_error_date || null,
        last_error_message: info.last_error_message || null,
        max_connections: info.max_connections || null,
        ip_address: info.ip_address || null,
        allowed_updates: Array.isArray(info.allowed_updates) ? info.allowed_updates : null,
        last_synchronization_error_date: info.last_synchronization_error_date || null,
        has_custom_certificate: Boolean(info.has_custom_certificate),
      };
    } else {
      webhook = {
        ok: false,
        status_code: getWebhookInfo.status_code || null,
        error: getWebhookInfo.response?.description || getWebhookInfo.error || "telegram_get_webhook_info_failed",
      };
    }
  }

  if (centerTokenConfigured) {
    await readTelegramState();
    let menuUrl = String(menuButton?.value?.web_app?.url || "");
    if (menuUrl !== expectedMiniApp) {
      deliverySetup = deliveryMode === "polling"
        ? await ensureTelegramCenterPolling(env, { force: true })
        : await ensureTelegramCenterWebhook(env, { force: true });
      await new Promise((resolve) => setTimeout(resolve, 900));
      await readTelegramState();
      menuUrl = String(menuButton?.value?.web_app?.url || "");
      if (menuUrl !== expectedMiniApp && deliveryMode === "polling") {
        deliverySetup = await ensureTelegramCenterPolling(env, { force: true });
        await new Promise((resolve) => setTimeout(resolve, 1400));
        await readTelegramState();
        menuUrl = String(menuButton?.value?.web_app?.url || "");
      }
    }
  }

  const menuButtonMatchesBuild = menuButton.ok
    && menuButton?.value?.type === "web_app"
    && String(menuButton?.value?.web_app?.url || "") === expectedMiniApp;
  const expectedWebhook = String(env.TELEGRAM_CENTER_WEBHOOK_URL || "").trim() || DEFAULT_CENTER_WEBHOOK_URL;
  const webhookMatchesExpected = webhook.ok && webhook.url === expectedWebhook;
  const pollingReady = webhook.ok && !webhook.url;
  const lastEvent = await readCenterDiagnostic(env);
  const polling = await readCenterPollingStatus(env);

  return json({
    ok: centerTokenConfigured && bot.ok && webhook.ok && menuButtonMatchesBuild
      && (deliveryMode === "polling" ? pollingReady && deliverySetup.ok : webhookSecretConfigured && webhookMatchesExpected && deliverySetup.ok),
    service: "hoh-nhl-center",
    runtime_marker: "telegram-center-2026-09-24-v24.2",
    center_token_configured: centerTokenConfigured,
    webhook_secret_configured: webhookSecretConfigured,
    webhook_secret_mode: "sha256_hex",
    delivery_mode: deliveryMode,
    mini_app_url: expectedMiniApp,
    expected_webhook_url: expectedWebhook,
    repair_webhook_url: `${new URL(request.url).origin}/api/telegram/center/repair-webhook`,
    bot,
    webhook,
    commands,
    menu_button: menuButton,
    menu_button_matches_build: menuButtonMatchesBuild,
    delivery_setup: deliverySetup,
    polling,
    last_event: lastEvent,
  });
}

async function repairCenterWebhook(request, env) {
  if (!(await managementAuthorized(request, env))) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  const result = await ensureTelegramCenterWebhook(env, { force: true });
  return json({
    ...result,
    action: "repair_webhook",
    secret_mode: "sha256_hex",
  }, result.ok ? 200 : 502);
}

export async function ensureTelegramCenterWebhook(env, { force = false } = {}) {
  const token = String(env.TELEGRAM_CENTER_BOT_TOKEN || "").trim();
  const secret = await telegramWebhookSecret(env);
  const expectedWebhook = String(env.TELEGRAM_CENTER_WEBHOOK_URL || "").trim() || DEFAULT_CENTER_WEBHOOK_URL;
  if (!token) return { ok: false, error: "missing_telegram_center_token", expected_webhook_url: expectedWebhook };
  if (!secret) return { ok: false, error: "missing_telegram_webhook_secret", expected_webhook_url: expectedWebhook };

  if (!force && env.DB && (await ensureDiagnosticTable(env))) {
    try {
      const row = await env.DB.prepare(
        "SELECT meta_value FROM data_core_meta WHERE meta_key=? LIMIT 1"
      ).bind(CENTER_WEBHOOK_REFRESH_KEY).first();
      const saved = row?.meta_value ? JSON.parse(String(row.meta_value)) : null;
      const refreshedAt = Date.parse(String(saved?.refreshed_at || ""));
      if (Number.isFinite(refreshedAt) && Date.now() - refreshedAt < CENTER_WEBHOOK_REFRESH_MS) {
        return {
          ok: true,
          skipped: "recently_refreshed",
          expected_webhook_url: expectedWebhook,
          refreshed_at: saved.refreshed_at,
        };
      }
    } catch (error) {
      console.log("telegram_center_webhook_refresh_state_read_failed", {
        error: String(error?.message || error || "unknown"),
      });
    }
  }

  const setWebhook = await telegramRequest(env, "setWebhook", {
    url: expectedWebhook,
    secret_token: secret,
    drop_pending_updates: false,
    allowed_updates: ["message"],
  });
  if (!setWebhook.ok) {
    const error = setWebhook.response?.description || setWebhook.error || "telegram_set_webhook_failed";
    console.log("telegram_center_webhook_refresh_failed", { error });
    return { ok: false, error, expected_webhook_url: expectedWebhook };
  }

  const miniApp = versionedMiniAppUrl(String(env.TELEGRAM_MINI_APP_URL || "").trim() || CENTER_DEFAULT_MINI_APP_URL);
  const [commandsResult, menuButtonResult, webhookInfo] = await Promise.all([
    telegramRequest(env, "setMyCommands", {
      commands: [
        { command: "menu", description: "Открыть меню HOH NHL Center" },
        { command: "app", description: "Открыть приложение HOH NHL Center" },
        { command: "help", description: "Помощь по HOH NHL Center" },
      ],
    }),
    telegramRequest(env, "setChatMenuButton", {
      menu_button: {
        type: "web_app",
        text: "HOH NHL Center",
        web_app: { url: miniApp },
      },
    }),
    telegramRequest(env, "getWebhookInfo", {}),
  ]);
  const info = webhookInfo.ok ? webhookInfo.response?.result || {} : {};
  const repaired = webhookInfo.ok && info.url === expectedWebhook;
  const payload = {
    refreshed_at: new Date().toISOString(),
    expected_webhook_url: expectedWebhook,
    actual_webhook_url: info.url || null,
    pending_update_count: Number(info.pending_update_count || 0),
    last_error_message: info.last_error_message || null,
    repaired,
    commands_ok: Boolean(commandsResult.ok),
    menu_button_ok: Boolean(menuButtonResult.ok),
  };

  if (env.DB && (await ensureDiagnosticTable(env))) {
    try {
      await env.DB.prepare(`
        INSERT INTO data_core_meta (meta_key, meta_value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(meta_key) DO UPDATE SET
          meta_value = excluded.meta_value,
          updated_at = CURRENT_TIMESTAMP
      `).bind(CENTER_WEBHOOK_REFRESH_KEY, JSON.stringify(payload)).run();
    } catch (error) {
      console.log("telegram_center_webhook_refresh_state_write_failed", {
        error: String(error?.message || error || "unknown"),
      });
    }
  }

  console.log("telegram_center_webhook_refreshed", payload);
  return {
    ok: repaired,
    expected_webhook_url: expectedWebhook,
    actual_webhook_url: info.url || null,
    pending_update_count: Number(info.pending_update_count || 0),
    last_error_message: info.last_error_message || null,
    refreshed_at: payload.refreshed_at,
    commands_ok: payload.commands_ok,
    menu_button_ok: payload.menu_button_ok,
  };
}


export async function ensureTelegramCenterPolling(env, { force = false } = {}) {
  const token = String(env.TELEGRAM_CENTER_BOT_TOKEN || "").trim();
  if (!token) return { ok: false, mode: "polling", error: "missing_telegram_center_token" };

  const miniApp = versionedMiniAppUrl(String(env.TELEGRAM_MINI_APP_URL || "").trim() || CENTER_DEFAULT_MINI_APP_URL);

  if (!force && env.DB && (await ensureDiagnosticTable(env))) {
    try {
      const row = await env.DB.prepare(
        "SELECT meta_value FROM data_core_meta WHERE meta_key=? LIMIT 1"
      ).bind(CENTER_POLL_SETUP_KEY).first();
      const saved = row?.meta_value ? JSON.parse(String(row.meta_value)) : null;
      const setupAt = Date.parse(String(saved?.setup_at || ""));
      if (
        saved?.ok
        && saved?.mini_app_url === miniApp
        && saved?.menu_button_url === miniApp
        && Number.isFinite(setupAt)
        && Date.now() - setupAt < CENTER_WEBHOOK_REFRESH_MS
      ) {
        return { ...saved, skipped: "recently_configured" };
      }
    } catch (error) {
      console.log("telegram_center_poll_setup_read_failed", {
        error: String(error?.message || error || "unknown"),
      });
    }
  }

  const menuPayload = {
    menu_button: {
      type: "web_app",
      text: "HOH NHL Center",
      web_app: { url: miniApp },
    },
  };
  if (force) {
    await telegramRequest(env, "setChatMenuButton", { menu_button: { type: "commands" } });
    await new Promise((resolve) => setTimeout(resolve, 450));
  }
  const [deleteWebhook, commandsResult, menuButtonResult] = await Promise.all([
    telegramRequest(env, "deleteWebhook", { drop_pending_updates: false }),
    telegramRequest(env, "setMyCommands", {
      commands: [
        { command: "menu", description: "Открыть меню HOH NHL Center" },
        { command: "app", description: "Открыть приложение HOH NHL Center" },
        { command: "help", description: "Помощь по HOH NHL Center" },
      ],
    }),
    telegramRequest(env, "setChatMenuButton", menuPayload),
  ]);

  const webhookInfo = await telegramRequest(env, "getWebhookInfo", {});
  const webhookUrl = webhookInfo.ok ? String(webhookInfo.response?.result?.url || "") : "";

  let menuCheck = null;
  let menuButtonUrl = "";
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (attempt > 0) {
      await telegramRequest(env, "setChatMenuButton", menuPayload);
    }
    await new Promise((resolve) => setTimeout(resolve, 600 + attempt * 300));
    menuCheck = await telegramRequest(env, "getChatMenuButton", {});
    menuButtonUrl = menuCheck.ok ? String(menuCheck.response?.result?.web_app?.url || "") : "";
    if (menuButtonUrl === miniApp) break;
  }

  const menuButtonUrlOk = Boolean(menuCheck?.ok) && menuButtonUrl === miniApp;
  const ok = deleteWebhook.ok
    && commandsResult.ok
    && menuButtonResult.ok
    && webhookInfo.ok
    && !webhookUrl
    && menuButtonUrlOk;
  const payload = {
    ok,
    mode: "polling",
    setup_at: new Date().toISOString(),
    mini_app_url: miniApp,
    menu_button_url: menuButtonUrl || null,
    menu_button_url_ok: menuButtonUrlOk,
    webhook_disabled: !webhookUrl,
    commands_ok: Boolean(commandsResult.ok),
    menu_button_ok: Boolean(menuButtonResult.ok),
    error: ok
      ? null
      : !menuButtonUrlOk
        ? "telegram_menu_button_build_mismatch"
        : deleteWebhook.response?.description
          || deleteWebhook.error
          || commandsResult.response?.description
          || commandsResult.error
          || menuButtonResult.response?.description
          || menuButtonResult.error
          || webhookInfo.response?.description
          || webhookInfo.error
          || "telegram_polling_setup_failed",
  };

  if (env.DB && (await ensureDiagnosticTable(env))) {
    try {
      await env.DB.prepare(`
        INSERT INTO data_core_meta (meta_key, meta_value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(meta_key) DO UPDATE SET
          meta_value=excluded.meta_value,
          updated_at=CURRENT_TIMESTAMP
      `).bind(CENTER_POLL_SETUP_KEY, JSON.stringify(payload)).run();
    } catch (error) {
      console.log("telegram_center_poll_setup_write_failed", {
        error: String(error?.message || error || "unknown"),
      });
    }
  }
  console.log("telegram_center_polling_configured", payload);
  return payload;
}


export async function pollTelegramCenterUpdates(env) {
  const setup = await ensureTelegramCenterPolling(env);
  const pollStartedAt = new Date().toISOString();
  if (!setup.ok) {
    await writeCenterPollingStatus(env, {
      ok: false,
      polled_at: pollStartedAt,
      error: setup.error || "polling_setup_failed",
      updates_received: 0,
      updates_processed: 0,
    });
    return { ok: false, error: setup.error || "polling_setup_failed" };
  }

  let lastOffset = 0;
  if (env.DB && (await ensureDiagnosticTable(env))) {
    try {
      const row = await env.DB.prepare(
        "SELECT meta_value FROM data_core_meta WHERE meta_key=? LIMIT 1"
      ).bind(CENTER_POLL_OFFSET_KEY).first();
      lastOffset = Number(row?.meta_value || 0) || 0;
    } catch (error) {
      console.log("telegram_center_poll_offset_read_failed", {
        error: String(error?.message || error || "unknown"),
      });
    }
  }

  const payload = {
    timeout: 25,
    limit: 100,
    allowed_updates: ["message"],
  };
  if (lastOffset > 0) payload.offset = lastOffset + 1;

  const updatesResult = await telegramRequest(env, "getUpdates", payload);
  if (!updatesResult.ok) {
    const error = updatesResult.response?.description || updatesResult.error || "telegram_get_updates_failed";
    await writeCenterPollingStatus(env, {
      ok: false,
      polled_at: pollStartedAt,
      error,
      updates_received: 0,
      updates_processed: 0,
      last_offset: lastOffset,
    });
    console.log("telegram_center_poll_failed", { error });
    return { ok: false, error };
  }

  const updates = Array.isArray(updatesResult.response?.result) ? updatesResult.response.result : [];
  let processed = 0;
  let latestOffset = lastOffset;

  for (const update of updates) {
    const updateId = Number(update?.update_id || 0);
    if (!Number.isSafeInteger(updateId) || updateId <= latestOffset) continue;

    const outcome = await processPolledCenterUpdate(env, update);
    if (outcome.retry) break;

    latestOffset = updateId;
    processed += 1;
    await writeCenterPollingOffset(env, latestOffset);
  }

  const status = {
    ok: true,
    polled_at: pollStartedAt,
    updates_received: updates.length,
    updates_processed: processed,
    last_offset: latestOffset,
    error: null,
  };
  await writeCenterPollingStatus(env, status);
  console.log("telegram_center_poll_complete", status);
  return status;
}


async function processPolledCenterUpdate(env, update) {
  const message = update?.message || null;
  const updateId = Number(update?.update_id || 0) || null;
  if (!message || message.chat?.type !== "private") {
    await recordCenterDiagnostic(env, {
      stage: "poll_update_skipped",
      delivery_mode: "polling",
      update_id: updateId,
      reason: "unsupported_update",
      has_message: Boolean(message),
      chat_type: message?.chat?.type || null,
    });
    return { retry: false, handled: false };
  }

  const command = commandName(message.text || "");
  if (!["/start", "/menu", "/help", "/app"].includes(command)) {
    await recordCenterDiagnostic(env, {
      stage: "poll_update_skipped",
      delivery_mode: "polling",
      update_id: updateId,
      reason: "private_command_not_handled",
      command,
    });
    return { retry: false, handled: false };
  }

  const chatId = message.chat?.id;
  if (!chatId) return { retry: false, handled: false };

  const centerText = "🏒 HOH NHL Center\n\nТвой персональный центр NHL:\n\n• игроки\n• команды\n• матчи\n• уведомления\n• статистика";
  const miniApp = versionedMiniAppUrl(String(env.TELEGRAM_MINI_APP_URL || "").trim() || CENTER_DEFAULT_MINI_APP_URL);
  const primary = await telegramRequest(env, "sendMessage", {
    chat_id: chatId,
    text: centerText,
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [[
        {
          text: "🏒 Открыть HOH NHL Center",
          web_app: { url: miniApp },
        },
      ]],
    },
  });

  let fallback = null;
  if (!primary.ok) {
    fallback = await telegramRequest(env, "sendMessage", {
      chat_id: chatId,
      text: `${centerText}\n\nОткрыть приложение: ${miniApp}`,
      disable_web_page_preview: true,
    });
  }

  const delivered = primary.ok || Boolean(fallback?.ok);
  const error = delivered
    ? null
    : fallback?.response?.description
      || fallback?.error
      || primary.response?.description
      || primary.error
      || "telegram_send_failed";

  await recordCenterDiagnostic(env, {
    stage: "command_processed",
    delivery_mode: "polling",
    update_id: updateId,
    command,
    primary_delivered: primary.ok,
    fallback_attempted: Boolean(fallback),
    fallback_delivered: Boolean(fallback?.ok),
    delivered,
    telegram_error: error,
  });

  console.log("telegram_center_poll_command", {
    update_id: updateId,
    command,
    delivered,
    error,
  });
  return { retry: !delivered, handled: true, delivered, error };
}


async function writeCenterPollingOffset(env, offset) {
  if (!env.DB || !(await ensureDiagnosticTable(env))) return;
  await env.DB.prepare(`
    INSERT INTO data_core_meta (meta_key, meta_value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(meta_key) DO UPDATE SET
      meta_value=excluded.meta_value,
      updated_at=CURRENT_TIMESTAMP
  `).bind(CENTER_POLL_OFFSET_KEY, String(offset)).run();
}


async function writeCenterPollingStatus(env, value) {
  if (!env.DB || !(await ensureDiagnosticTable(env))) return;
  await env.DB.prepare(`
    INSERT INTO data_core_meta (meta_key, meta_value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(meta_key) DO UPDATE SET
      meta_value=excluded.meta_value,
      updated_at=CURRENT_TIMESTAMP
  `).bind(CENTER_POLL_STATUS_KEY, JSON.stringify(value)).run();
}


async function readCenterPollingStatus(env) {
  if (!env.DB || !(await ensureDiagnosticTable(env))) return null;
  try {
    const [statusRow, offsetRow] = await Promise.all([
      env.DB.prepare("SELECT meta_value, updated_at FROM data_core_meta WHERE meta_key=? LIMIT 1").bind(CENTER_POLL_STATUS_KEY).first(),
      env.DB.prepare("SELECT meta_value, updated_at FROM data_core_meta WHERE meta_key=? LIMIT 1").bind(CENTER_POLL_OFFSET_KEY).first(),
    ]);
    let status = null;
    try {
      status = statusRow?.meta_value ? JSON.parse(String(statusRow.meta_value)) : null;
    } catch {
      status = { raw: String(statusRow?.meta_value || "") };
    }
    return {
      ...(status || {}),
      last_offset: Number(offsetRow?.meta_value || status?.last_offset || 0) || 0,
      persisted_at: statusRow?.updated_at || null,
    };
  } catch (error) {
    return { ok: false, error: String(error?.message || error || "polling_status_read_failed") };
  }
}


async function setupMiniAppButton(request, env) {
  if (request.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }
  if (!(await managementAuthorized(request, env))) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const menuButton = await telegramRequest(env, "setChatMenuButton", {
    menu_button: {
      type: "web_app",
      text: "HOH NHL Center",
      web_app: { url: miniAppUrl(request, env) },
    },
  });

  return json(
    { ok: menuButton.ok, menu_button: menuButton },
    menuButton.ok ? 200 : 502,
  );
}

function versionedMiniAppUrl(value) {
  try {
    const url = new URL(String(value || CENTER_DEFAULT_MINI_APP_URL));
    url.pathname = CENTER_CANONICAL_MINI_APP_PATH;
    url.search = "";
    url.hash = "";
    url.searchParams.set("build", CENTER_MINI_APP_BUILD);
    return url.toString();
  } catch {
    return CENTER_DEFAULT_MINI_APP_URL;
  }
}

function miniAppUrl(request, env) {
  const configured = String(env.TELEGRAM_MINI_APP_URL || "").trim();
  if (configured) return versionedMiniAppUrl(configured);
  const publicBase = String(env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  if (publicBase) return versionedMiniAppUrl(`${publicBase}/telegram-app`);
  const url = new URL(request.url);
  return versionedMiniAppUrl(`${url.protocol}//${url.host}/telegram-app`);
}

async function telegramRequest(env, method, payload) {
  const token = String(env.TELEGRAM_CENTER_BOT_TOKEN || "").trim();
  if (!token) {
    return { ok: false, error: "missing_telegram_center_token" };
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
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
  } catch (error) {
    return {
      ok: false,
      error: `telegram_fetch_failed:${String(error?.message || error || "unknown")}`,
    };
  }
}

async function telegramWebhookSecret(env) {
  const raw = String(env.TELEGRAM_WEBHOOK_VERIFY_SECRET || "").trim();
  if (!raw) {
    return "";
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function ensureDiagnosticTable(env) {
  if (!env.DB) {
    return false;
  }
  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS data_core_meta (
        meta_key TEXT PRIMARY KEY,
        meta_value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `).run();
    return true;
  } catch (error) {
    console.log("telegram_center_diagnostic_table_failed", {
      error: String(error?.message || error || "unknown"),
    });
    return false;
  }
}

async function recordCenterDiagnostic(env, payload) {
  if (!env.DB || !(await ensureDiagnosticTable(env))) {
    return;
  }
  const safePayload = {
    at: new Date().toISOString(),
    ...payload,
  };
  try {
    await env.DB.prepare(`
      INSERT INTO data_core_meta (meta_key, meta_value, updated_at)
      VALUES ('telegram_center_last_event', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(meta_key) DO UPDATE SET
        meta_value = excluded.meta_value,
        updated_at = CURRENT_TIMESTAMP;
    `).bind(JSON.stringify(safePayload)).run();
  } catch (error) {
    console.log("telegram_center_diagnostic_write_failed", {
      error: String(error?.message || error || "unknown"),
    });
  }
}

async function readCenterDiagnostic(env) {
  if (!env.DB) {
    return null;
  }
  if (!(await ensureDiagnosticTable(env))) {
    return { stage: "diagnostic_table_unavailable" };
  }
  try {
    const row = await env.DB.prepare(
      "SELECT meta_value, updated_at FROM data_core_meta WHERE meta_key='telegram_center_last_event' LIMIT 1;",
    ).first();
    if (!row) {
      return null;
    }
    let value = null;
    try {
      value = JSON.parse(String(row.meta_value || "null"));
    } catch {
      value = { raw: String(row.meta_value || "") };
    }
    return {
      ...value,
      persisted_at: row.updated_at || null,
    };
  } catch (error) {
    return {
      stage: "diagnostic_read_failed",
      error: String(error?.message || error || "unknown"),
    };
  }
}

async function managementAuthorized(request, env) {
  const expected = String(env.MANAGEMENT_API_SECRET || "").trim();
  const auth = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(\S+)$/i.exec(auth.trim());
  return Boolean(expected && match && (await secureEqual(match[1], expected)));
}

async function secureEqual(a, b) {
  const encoder = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const aa = new Uint8Array(da);
  const bb = new Uint8Array(db);
  if (aa.length !== bb.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < aa.length; i += 1) {
    diff |= aa[i] ^ bb[i];
  }
  return diff === 0;
}

function commandName(text) {
  return String(text || "")
    .trim()
    .split(/\s+/)[0]
    .toLowerCase()
    .split("@", 1)[0];
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
