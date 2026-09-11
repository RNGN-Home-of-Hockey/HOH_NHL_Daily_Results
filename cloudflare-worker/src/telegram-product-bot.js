export async function handleTelegramProductBotRequest(request, env, path) {
  if (path === "/api/telegram-app/setup") {
    return setupMiniAppButton(request, env);
  }

  if (!["/api/telegram/center", "/telegram/center", "/api/telegram", "/telegram"].includes(path) || request.method !== "POST") {
    return null;
  }

  const isCenter = path.includes("center");
  console.log("telegram_webhook_received", { path, isCenter });

  const expected = String(env.TELEGRAM_WEBHOOK_VERIFY_SECRET || "").trim();
  const provided = request.headers.get("x-telegram-bot-api-secret-token") || "";
  if (!expected) {
    console.log("telegram_webhook_missing_secret_config");
    return json({ ok:false, error:"telegram_webhook_missing_secret_config" }, 401);
  }
  if (!provided || !(await secureEqual(provided, expected))) {
    console.log("telegram_webhook_secret_mismatch");
    return json({ ok:false, error:"telegram_webhook_secret_mismatch" }, 401);
  }

  let update;
  try { update = await request.json(); } catch {
    console.log("telegram_webhook_invalid_json");
    return json({ ok:false, error:"telegram_webhook_invalid_json" }, 400);
  }

  const message = update.message || null;
  console.log("telegram_update", {
    has_message: Boolean(message),
    chat_type: message?.chat?.type || null,
    has_text: Boolean(message?.text),
  });

  if (!message || message.chat?.type !== "private") return json({ ok:true, skipped:"unsupported_update" });

  const command = commandName(message.text || "");
  console.log("telegram_command", { command, chat_id_present: Boolean(message.chat?.id) });

  if (!["/start", "/menu", "/help", "/app"].includes(command)) {
    return json({ ok: true, skipped: "private_command_not_handled" });
  }

  const chatId = message.chat?.id;
  if (!chatId) return json({ ok: true, skipped: "missing_chat" });

  const result = await telegramRequest(env, "sendMessage", {
    chat_id: chatId,
    text: "🏒 HOH NHL Center\n\nТвой персональный центр NHL:\n\n• игроки\n• команды\n• матчи\n• уведомления\n• статистика",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [[{ text: "🏒 Открыть HOH NHL Center", web_app: { url: miniAppUrl(request, env) } }]],
    },
  });

  console.log("telegram_send_result", {
    ok: result.ok,
    status_code: result.status_code,
    error: result.response?.description || result.error || null,
  });

  return json({ ok: result.ok, action: "center_menu" }, result.ok ? 200 : 502);
}

async function setupMiniAppButton(request, env) {
  if (request.method !== "POST") return json({ ok:false,error:"method_not_allowed" },405);
  if (!(await managementAuthorized(request, env))) return json({ ok:false,error:"unauthorized" },401);

  const menuButton = await telegramRequest(env, "setChatMenuButton", {
    menu_button: { type: "web_app", text: "HOH NHL Center", web_app: { url: miniAppUrl(request, env) } },
  });

  return json({ ok: menuButton.ok, menu_button: menuButton }, menuButton.ok ? 200 : 502);
}

function miniAppUrl(request, env) {
  const configured = String(env.TELEGRAM_MINI_APP_URL || "").trim();
  if (configured) return configured;
  const publicBase = String(env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  if (publicBase) return `${publicBase}/telegram-app`;
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}/telegram-app`;
}

async function telegramRequest(env, method, payload) {
  const token = String(env.TELEGRAM_CENTER_BOT_TOKEN || "").trim();
  if (!token) return { ok:false,error:"missing_telegram_center_token" };

  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify(payload),
  });

  const data = await response.json().catch(()=>({}));
  return { ok: response.ok && data.ok === true, status_code: response.status, response: data };
}

async function managementAuthorized(request, env) {
  const expected = String(env.MANAGEMENT_API_SECRET || "").trim();
  const auth = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(\S+)$/i.exec(auth.trim());
  return Boolean(expected && match && await secureEqual(match[1], expected));
}

async function secureEqual(a,b){const e=new TextEncoder();const [da,db]=await Promise.all([crypto.subtle.digest("SHA-256",e.encode(a)),crypto.subtle.digest("SHA-256",e.encode(b))]);const aa=new Uint8Array(da),bb=new Uint8Array(db);if(aa.length!==bb.length)return false;let d=0;for(let i=0;i<aa.length;i++)d|=aa[i]^bb[i];return d===0}
function commandName(text){return String(text||"").trim().split(/\s+/)[0].toLowerCase().split("@",1)[0]}
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}})}
