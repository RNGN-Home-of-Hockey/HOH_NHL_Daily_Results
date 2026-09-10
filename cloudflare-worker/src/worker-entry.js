import worker from "./index.js";
import { getBackfillStatus, runBackfillStep } from "./data-core-backfill.js";

const CANARY_SEASON = "20242025";
const CANARY_START_DATE = "2024-10-04";
const CANARY_END_DATE = "2025-06-30";
const CANARY_TARGET_GAMES = 10;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = stripTrailingSlash(url.pathname);

    if (path === "/api/data-core/backfill/status") {
      return backfillStatusRoute(request, env);
    }
    if (path === "/api/data-core/backfill/step") {
      return backfillStepRoute(request, env);
    }

    return worker.fetch(request, env);
  },

  async scheduled(controller, env, ctx) {
    if (envFlag(env.BACKFILL_CANARY_ENABLED, false)) {
      ctx.waitUntil(runScheduledCanary(env));
    }
    if (typeof worker.scheduled === "function") {
      return worker.scheduled(controller, env, ctx);
    }
  },
};

async function backfillStatusRoute(request, env) {
  if (request.method !== "GET") {
    return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  }
  if (!(await isManagementAuthorized(request, env))) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }
  if (!env.DB) {
    return jsonResponse({ ok: false, error: "missing_d1_binding" }, 503);
  }

  const season = new URL(request.url).searchParams.get("season") || "";
  try {
    return jsonResponse(await getBackfillStatus(env.DB, { season }));
  } catch {
    return jsonResponse({ ok: false, error: "backfill_status_failed" }, 400);
  }
}

async function backfillStepRoute(request, env) {
  if (request.method !== "POST") {
    return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  }
  if (!(await isManagementAuthorized(request, env))) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }
  if (!env.DB) {
    return jsonResponse({ ok: false, error: "missing_d1_binding" }, 503);
  }

  const url = new URL(request.url);
  const options = {
    season: url.searchParams.get("season") || "",
    start_date: url.searchParams.get("start_date") || "",
    end_date: url.searchParams.get("end_date") || "",
    cursor: url.searchParams.get("cursor") || null,
    max_scan_days: url.searchParams.get("max_scan_days") || undefined,
    dry_run: queryBool(url, "dry_run", false),
  };

  try {
    return jsonResponse(await runBackfillStep(env.DB, options));
  } catch {
    return jsonResponse({ ok: false, action: "backfill_step", error: "backfill_step_failed" }, 500);
  }
}

async function runScheduledCanary(env) {
  if (!env.DB) {
    return;
  }

  const status = await getBackfillStatus(env.DB, { season: CANARY_SEASON });
  if (status.games >= CANARY_TARGET_GAMES) {
    return;
  }

  await runBackfillStep(env.DB, {
    season: CANARY_SEASON,
    start_date: CANARY_START_DATE,
    end_date: CANARY_END_DATE,
    max_scan_days: 14,
    dry_run: false,
  });
}

async function isManagementAuthorized(request, env) {
  const expected = String(env.MANAGEMENT_API_SECRET || "").trim();
  if (!expected) {
    return false;
  }
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.startsWith("Bearer ")) {
    return false;
  }
  const provided = authorization.slice("Bearer ".length).trim();
  if (!provided) {
    return false;
  }
  return secureEqual(provided, expected);
}

async function secureEqual(left, right) {
  const encoder = new TextEncoder();
  const leftDigest = await crypto.subtle.digest("SHA-256", encoder.encode(left));
  const rightDigest = await crypto.subtle.digest("SHA-256", encoder.encode(right));
  const a = new Uint8Array(leftDigest);
  const b = new Uint8Array(rightDigest);
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a[index] ^ b[index];
  }
  return mismatch === 0;
}

function queryBool(url, key, fallback) {
  const value = url.searchParams.get(key);
  if (value === null) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function envFlag(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function stripTrailingSlash(path) {
  if (path === "/") {
    return "";
  }
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
