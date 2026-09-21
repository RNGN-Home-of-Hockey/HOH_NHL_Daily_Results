const DEFAULT_CENTER_WEBHOOK_URL = "https://hoh-nhl-daily-results.znamteam-903.workers.dev/telegram/center";
const CENTER_WEBHOOK_REFRESH_KEY = "telegram_center_webhook_refresh_v1";
const CENTER_WEBHOOK_REFRESH_MS = 6 * 60 * 60 * 1000;

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
  const centerTokenConfigured = Boolean(String(env.TELEGRAM_CENTER_BOT_TOKEN || "").trim());
  const webhookSecretConfigured = Boolean(String(env.TELEGRAM_WEBHOOK_VERIFY_SECRET || "").trim());

  let bot = { ok: false, error: "missing_telegram_center_token" };
  let webhook = { ok: false, error: "missing_telegram_center_token" };

  if (centerTokenConfigured) {
    const [getMe, getWebhookInfo] = await Promise.all([
      telegramRequest(env, "getMe", {}),
      telegramRequest(env, "getWebhookInfo", {}),
    ]);

    if (getMe.ok) {
      bot = {
        ok: true,
        id: getMe.response?.result?.id ?? null,
        username: getMe.response?.result?.username || null,
        first_name: getMe.response?.result?.first_name || null,
      };
    } else {
      bot = {
        ok: false,
        status_code: getMe.status_code || null,
        error: getMe.response?.description || getMe.error || "telegram_get_me_failed",
      };
    }

    if (getWebhookInfo.ok) {
      const info = getWebhookInfo.response?.result || {};
      webhook = {
        ok: true,
        url: info.url || "",
        pending_update_count: Number(info.pending_update_count || 0),
        last_error_date: info.last_error_date || null,
        last_error_message: info.last_error_message || null,
        max_connections: info.max_connections || null,
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

  const expectedWebhook = `${new URL(request.url).origin}/telegram/center`;
  const webhookMatchesExpected = webhook.ok && webhook.url === expectedWebhook;
  const lastEvent = await readCenterDiagnostic(env);

  return json({
    ok: centerTokenConfigured && webhookSecretConfigured && bot.ok && webhook.ok && webhookMatchesExpected,
    service: "hoh-nhl-center",
    runtime_marker: "telegram-center-2026-09-21-v7",
    center_token_configured: centerTokenConfigured,
    webhook_secret_configured: webhookSecretConfigured,
    webhook_secret_mode: "sha256_hex",
    mini_app_url: miniAppUrl(request, env),
    expected_webhook_url: expectedWebhook,
    repair_webhook_url: `${new URL(request.url).origin}/api/telegram/center/repair-webhook`,
    bot,
    webhook,
    webhook_matches_expected: webhookMatchesExpected,
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

  const webhookInfo = await telegramRequest(env, "getWebhookInfo", {});
  const info = webhookInfo.ok ? webhookInfo.response?.result || {} : {};
  const repaired = webhookInfo.ok && info.url === expectedWebhook;
  const payload = {
    refreshed_at: new Date().toISOString(),
    expected_webhook_url: expectedWebhook,
    actual_webhook_url: info.url || null,
    pending_update_count: Number(info.pending_update_count || 0),
    last_error_message: info.last_error_message || null,
    repaired,
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
  };
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

function miniAppUrl(request, env) {
  const configured = String(env.TELEGRAM_MINI_APP_URL || "").trim();
  if (configured) {
    return configured;
  }
  const publicBase = String(env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  if (publicBase) {
    return `${publicBase}/telegram-app`;
  }
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}/telegram-app`;
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
