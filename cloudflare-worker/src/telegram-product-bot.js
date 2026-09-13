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

  if (!["/api/telegram/center", "/telegram/center"].includes(path) || request.method !== "POST") {
    return null;
  }

  console.log("telegram_center_webhook_received", { path });

  const expected = String(env.TELEGRAM_WEBHOOK_VERIFY_SECRET || "").trim();
  const provided = request.headers.get("x-telegram-bot-api-secret-token") || "";
  if (!expected) {
    console.log("telegram_center_webhook_missing_secret_config");
    return json({ ok: false, error: "telegram_webhook_missing_secret_config" }, 401);
  }
  if (!provided || !(await secureEqual(provided, expected))) {
    console.log("telegram_center_webhook_secret_mismatch");
    return json({ ok: false, error: "telegram_webhook_secret_mismatch" }, 401);
  }

  let update;
  try {
    update = await request.json();
  } catch {
    console.log("telegram_center_webhook_invalid_json");
    return json({ ok: false, error: "telegram_webhook_invalid_json" }, 400);
  }

  const message = update.message || null;
  console.log("telegram_center_update", {
    has_message: Boolean(message),
    chat_type: message?.chat?.type || null,
    has_text: Boolean(message?.text),
  });

  if (!message || message.chat?.type !== "private") {
    return json({ ok: true, skipped: "unsupported_update" });
  }

  const command = commandName(message.text || "");
  console.log("telegram_center_command", {
    command,
    chat_id_present: Boolean(message.chat?.id),
  });

  if (!["/start", "/menu", "/help", "/app"].includes(command)) {
    return json({ ok: true, skipped: "private_command_not_handled" });
  }

  const chatId = message.chat?.id;
  if (!chatId) {
    return json({ ok: true, skipped: "missing_chat" });
  }

  const result = await telegramRequest(env, "sendMessage", {
    chat_id: chatId,
    text: "🏒 HOH NHL Center\n\nТвой персональный центр NHL:\n\n• игроки\n• команды\n• матчи\n• уведомления\n• статистика",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [[
        {
          text: "🏒 Открыть HOH NHL Center",
          web_app: { url: miniAppUrl(request, env) },
        },
      ]],
    },
  });

  console.log("telegram_center_send_result", {
    ok: result.ok,
    status_code: result.status_code || null,
    error: result.response?.description || result.error || null,
  });

  // Telegram only needs acknowledgement that the update was accepted.
  // Do not make Telegram retry the same /start update if sendMessage itself fails.
  return json({
    ok: true,
    action: "center_menu",
    delivered: result.ok,
    telegram_error: result.ok ? null : result.response?.description || result.error || "telegram_send_failed",
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

  return json({
    ok: centerTokenConfigured && webhookSecretConfigured && bot.ok && webhook.ok,
    service: "hoh-nhl-center",
    runtime_marker: "telegram-center-2026-09-13-v2",
    center_token_configured: centerTokenConfigured,
    webhook_secret_configured: webhookSecretConfigured,
    mini_app_url: miniAppUrl(request, env),
    expected_webhook_url: expectedWebhook,
    bot,
    webhook,
    webhook_matches_expected: webhook.ok ? webhook.url === expectedWebhook : false,
  });
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
