import assert from "node:assert/strict";
import { handleTelegramMiniAppRequest } from "../cloudflare-worker/src/telegram-mini-app.js";
import { handleTeamCurrentRequest } from "../cloudflare-worker/src/team-current-routes.js";

const botToken = "fixture-bot-token";
const telegramUser = {
  id: 123456,
  username: "fixture_user",
  first_name: "Fixture",
  last_name: "User",
  language_code: "ru",
};

async function hmac(keyBytes, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

function hex(bytes) {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function signedInitData(user = telegramUser) {
  const params = new URLSearchParams();
  params.set("auth_date", String(Math.floor(Date.now() / 1000)));
  params.set("query_id", "fixture-query");
  params.set("user", JSON.stringify(user));
  const dataCheck = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = await hmac(new TextEncoder().encode("WebAppData"), botToken);
  const signature = await hmac(secret, dataCheck);
  params.set("hash", hex(signature));
  return params.toString();
}

class FakeStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.args = [];
  }

  bind(...args) {
    this.args = args;
    return this;
  }

  async run() {
    if (this.sql.includes("INSERT INTO telegram_users")) {
      const [id, username, firstName, lastName, languageCode] = this.args;
      this.db.users.set(Number(id), {
        id: Number(id),
        username,
        first_name: firstName,
        last_name: lastName,
        language_code: languageCode,
      });
      return { meta: { changes: 1 } };
    }

    if (this.sql.includes("INSERT INTO subscriptions")) {
      const [userId, type, entityId, pregame, start, goal, assist, point, periodEnd, final] = this.args;
      const uniqueKey = `${userId}:${type}:${entityId}`;
      const existingId = this.db.subscriptionKeys.get(uniqueKey);
      const id = existingId || this.db.nextSubscriptionId++;
      this.db.subscriptionKeys.set(uniqueKey, id);
      this.db.subscriptions.set(id, {
        subscription_id: id,
        telegram_user_id: Number(userId),
        subject_type: String(type),
        subject_key: String(entityId),
        notify_pregame: pregame,
        notify_start: start,
        notify_goal: goal,
        notify_assist: assist,
        notify_point: point,
        notify_period_end: periodEnd,
        notify_final: final,
      });
      return { meta: { changes: 1 } };
    }

    if (this.sql.includes("DELETE FROM subscriptions WHERE subscription_id=")) {
      const [id, userId] = this.args.map(Number);
      const row = this.db.subscriptions.get(id);
      if (!row || row.telegram_user_id !== userId) return { meta: { changes: 0 } };
      this.db.subscriptions.delete(id);
      this.db.subscriptionKeys.delete(`${row.telegram_user_id}:${row.subject_type}:${row.subject_key}`);
      return { meta: { changes: 1 } };
    }

    throw new Error(`Unexpected run SQL: ${this.sql}`);
  }

  async all() {
    if (this.sql.includes("LEFT JOIN players") && this.sql.includes("FROM subscriptions s")) {
      const userId = Number(this.args[0]);
      return {
        results: [...this.db.subscriptions.values()]
          .filter((row) => row.telegram_user_id === userId)
          .map((row) => ({ ...row, name: this.db.entityName(row.subject_type, row.subject_key) })),
      };
    }
    throw new Error(`Unexpected all SQL: ${this.sql}`);
  }

  async first() {
    if (this.sql.includes("FROM players WHERE player_id=")) {
      return this.db.players.has(Number(this.args[0])) ? { 1: 1 } : null;
    }
    if (this.sql.includes("FROM teams WHERE tri_code=")) {
      return this.db.teams.has(String(this.args[0])) ? { 1: 1 } : null;
    }
    if (this.sql.includes("FROM games WHERE game_pk=")) {
      return this.db.games.has(Number(this.args[0])) ? { 1: 1 } : null;
    }
    if (this.sql.includes("FROM subscriptions WHERE telegram_user_id=")) {
      const [userId, entityId] = this.args;
      return [...this.db.subscriptions.values()].find(
        (row) => row.telegram_user_id === Number(userId)
          && row.subject_type === "game"
          && row.subject_key === String(entityId),
      ) || null;
    }
    throw new Error(`Unexpected first SQL: ${this.sql}`);
  }
}

class FakeDB {
  constructor() {
    this.users = new Map();
    this.subscriptions = new Map();
    this.subscriptionKeys = new Map();
    this.nextSubscriptionId = 1;
    this.players = new Map([[8478402, "Connor McDavid"]]);
    this.teams = new Map([["EDM", "Edmonton Oilers"]]);
    this.games = new Map();
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
  }

  entityName(type, entityId) {
    if (type === "player") return this.players.get(Number(entityId)) || String(entityId);
    if (type === "team") return this.teams.get(String(entityId)) || String(entityId);
    return `Game #${entityId}`;
  }
}

function apiRequest(path, initData, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (initData) headers["X-Telegram-Init-Data"] = initData;
  if (options.body) headers["Content-Type"] = "application/json";
  return new Request(`https://example.test${path}`, { ...options, headers });
}

const db = new FakeDB();
const env = { DB: db, TELEGRAM_BOT_TOKEN: botToken };
const auth = await signedInitData();

let request = apiRequest("/api/me/subscriptions", "");
let response = await handleTelegramMiniAppRequest(request, env, "/api/me/subscriptions");
assert.equal(response.status, 401, "subscriptions require Telegram InitData");

request = apiRequest("/api/me/subscriptions", auth, {
  method: "POST",
  body: JSON.stringify({
    type: "player",
    entity_id: "8478402",
    events: ["goal", "assist", "point"],
  }),
});
response = await handleTelegramMiniAppRequest(request, env, "/api/me/subscriptions");
assert.equal(response.status, 200, "player subscription is created");
let payload = await response.json();
assert.equal(payload.subscriptions.length, 1);
assert.deepEqual(payload.subscriptions[0], {
  id: 1,
  type: "player",
  entity_id: "8478402",
  name: "Connor McDavid",
  events: ["goal", "assist", "point"],
});
assert.equal(db.users.get(telegramUser.id).username, telegramUser.username, "signed Telegram user is mapped");

request = apiRequest("/api/me/subscriptions", auth, {
  method: "POST",
  body: JSON.stringify({ type: "player", entity_id: "8478402", events: ["goal"] }),
});
response = await handleTelegramMiniAppRequest(request, env, "/api/me/subscriptions");
payload = await response.json();
assert.equal(response.status, 200, "duplicate subscription is updated");
assert.equal(payload.subscriptions.length, 1, "duplicate subscription does not create a second row");
assert.equal(payload.subscriptions[0].id, 1, "upsert preserves the subscription id");
assert.deepEqual(payload.subscriptions[0].events, ["goal"]);

request = apiRequest("/api/me/subscriptions", auth);
response = await handleTelegramMiniAppRequest(request, env, "/api/me/subscriptions");
payload = await response.json();
assert.equal(response.status, 200);
assert.equal(payload.subscriptions[0].name, "Connor McDavid");

request = apiRequest("/api/me/subscriptions/1", auth, { method: "DELETE" });
response = await handleTelegramMiniAppRequest(request, env, "/api/me/subscriptions/1");
payload = await response.json();
assert.equal(response.status, 200, "subscription is deleted");
assert.deepEqual(payload.subscriptions, []);

const sentMessages = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  assert.match(String(url), /api\.telegram\.org\/botfixture-bot-token\/sendMessage$/);
  sentMessages.push(JSON.parse(options.body));
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
};

try {
  request = apiRequest("/api/test-notification", auth, {
    method: "POST",
    body: JSON.stringify({ user_id: 999999, type: "goal", text: "Forbidden" }),
  });
  response = await handleTelegramMiniAppRequest(request, env, "/api/test-notification");
  assert.equal(response.status, 403, "test endpoint cannot send to another Telegram user");

  request = apiRequest("/api/test-notification", auth, {
    method: "POST",
    body: JSON.stringify({ user_id: telegramUser.id, type: "goal", text: "McDavid забил" }),
  });
  response = await handleTelegramMiniAppRequest(request, env, "/api/test-notification");
  payload = await response.json();
  assert.equal(response.status, 200, "test notification is sent through the existing bot");
  assert.deepEqual(payload, { ok: true, user_id: telegramUser.id, type: "goal" });
  assert.deepEqual(sentMessages, [{ chat_id: telegramUser.id, text: "McDavid забил" }]);
} finally {
  globalThis.fetch = realFetch;
}

request = new Request("https://example.test/telegram-app");
response = await handleTeamCurrentRequest(request, {}, "/telegram-app");
assert.equal(response.status, 200);
assert.ok((await response.text()).includes('data-tab="follows">Мои</button>'));

request = new Request("https://example.test/telegram-app/app.js");
response = await handleTeamCurrentRequest(request, {}, "/telegram-app/app.js");
const ui = await response.text();
for (const expected of [
  "Мои подписки",
  "/api/me/subscriptions",
  "🔔 Следить",
  "✅ Вы подписаны",
  "Удалить",
]) {
  assert.ok(ui.includes(expected), `Mini App bundle contains ${expected}`);
}

console.log("MINI_APP_SUBSCRIPTIONS_MVP_OK");
