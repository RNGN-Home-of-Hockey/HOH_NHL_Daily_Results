import worker from "./index.js";
import { getBackfillStatus, runBackfillStep } from "./data-core-backfill.js";
import { getBackfillJob, runPersistentBackfillTick } from "./data-core-backfill-job.js";

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
    if (path === "/api/data-core/backfill/job") {
      return persistentBackfillJobRoute(request, env);
    }

    return worker.fetch(request, env);
  },

  async scheduled(controller, env, ctx) {
    const canaryEnabled = envFlag(env.BACKFILL_CANARY_ENABLED, false);
    const fullBackfillEnabled = envFlag(env.FULL_BACKFILL_ENABLED, false);

    if (canaryEnabled && fullBackfillEnabled) {
      console.error("Backfill safety stop: canary and full backfill cannot run together");
    } else if (canaryEnabled) {
      ctx.waitUntil(runScheduledCanary(env));
    } else if (fullBackfillEnabled) {
      ctx.waitUntil(runScheduledFullBackfill(env));
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

async function persistentBackfillJobRoute(request, env) {
  if (request.method !== "GET") {
    return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  }
  if (!(await isManagementAuthorized(request, env))) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }
  if (!env.DB) {
    return jsonResponse({ ok: false, error: "missing_d1_binding" }, 503);
  }

  const jobId = new URL(request.url).searchParams.get("job_id") || "";
  try {
    const job = await getBackfillJob(env.DB, jobId);
    if (!job) {
      return jsonResponse({ ok: false, error: "backfill_job_not_found" }, 404);
    }
    return jsonResponse({ ok: true, action: "backfill_job_status", job });
  } catch {
    return jsonResponse({ ok: false, error: "backfill_job_status_failed" }, 400);
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

async function runScheduledFullBackfill(env) {
  if (!env.DB) {
    return;
  }

  await runPersistentBackfillTick(env.DB, {
    job_id: String(env.FULL_BACKFILL_JOB_ID || "").trim(),
    season: String(env.FULL_BACKFILL_SEASON || "").trim(),
    start_date: String(env.FULL_BACKFILL_START_DATE || "").trim(),
    end_date: String(env.FULL_BACKFILL_END_DATE || "").trim(),
    daily_game_limit: envInt(env.FULL_BACKFILL_DAILY_GAME_LIMIT, 20, 1, 10000),
    max_scan_days: envInt(env.FULL_BACKFILL_MAX_SCAN_DAYS, 14, 1, 31),
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

function envInt(value, fallback, min, max) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    return fallback;
  }
  return number;
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
