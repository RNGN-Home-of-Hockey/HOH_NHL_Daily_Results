import worker, { ensureLegacyTelegramWebhook } from "./index.js";
import { getBackfillStatus, runBackfillStep } from "./data-core-backfill.js";
import { getBackfillJob, runPersistentBackfillTick } from "./data-core-backfill-job.js";
import { handleBroadcastRequest } from "./broadcast-dashboard-v2.js";
import { buildLiveGameSnapshot } from "./live-betting-engine.js";
import { handleControlCenterRequest } from "./control-center.js";
import { handleTelegramMiniAppRequest } from "./telegram-mini-app.js";
import { handleTelegramProductBotRequest, pollTelegramCenterUpdates } from "./telegram-product-bot.js";
import { handleTeamCurrentRequest } from "./team-current-routes.js";
import { getCenterNotificationStatus, runCenterNotificationTick } from "./telegram-center-notification-engine.js";
import { runCenterScheduleMaintenance } from "./telegram-center-schedule-maintenance.js";
import { runCenterNameMaintenance } from "./telegram-center-name-maintenance.js";
import { runCenterRosterMaintenance } from "./telegram-center-roster-maintenance.js";
import { runSportsRuNewsMaintenance } from "./telegram-center-v20-news.js";
import { runWinlineFeedMaintenance } from "./winline-feed-maintenance.js";
import { runVkBroadcastMaintenance } from "./telegram-center-vk-maintenance-v2.js";
import { getVkArchiveDiscovery } from "./telegram-center-vk-discovery.js";
import { handleVkOauthHelper } from "./vk-oauth-helper.js";
import { getPostgameIngestionStatus, runPostgameFinalizer } from "./postgame-finalizer.js";

const CANARY_SEASON = "20242025";
const CANARY_START_DATE = "2024-10-04";
const CANARY_END_DATE = "2025-06-30";
const CANARY_TARGET_GAMES = 10;
const WINLINE_PARTNER_URL = "https://p.winline.ru/s/hSJPscomBm?statid=2558_&sub4=nhl&promocode=NHL";
const WINLINE_NHL_URL = "https://winline.ru/stavki/sport/xokkej/ssha/nhl";
const WINLINE_EVENT_WINDOW_MS = 45 * 24 * 60 * 60 * 1000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = stripTrailingSlash(url.pathname);

    const vkOauthResponse = handleVkOauthHelper(request, path);
    if (vkOauthResponse) return vkOauthResponse;

    if (path === "/go/winline") {
      return winlineClickRoute(request, env);
    }

    if (path === "/api/telegram-center-v18/vk/discovery") {
      if (request.method !== "GET") return jsonResponse({ok:false,error:"method_not_allowed"},405);
      return jsonResponse(await getVkArchiveDiscovery(env));
    }

    const telegramProductResponse = await handleTelegramProductBotRequest(request.clone(), env, path);
    if (telegramProductResponse) {
      return telegramProductResponse;
    }

    const teamCurrentResponse = await handleTeamCurrentRequest(request, env, path);
    if (teamCurrentResponse) {
      return teamCurrentResponse;
    }

    const miniAppResponse = await handleTelegramMiniAppRequest(request, env, path);
    if (miniAppResponse) {
      return miniAppResponse;
    }

    const controlResponse = await handleControlCenterRequest(request, env, path);
    if (controlResponse) {
      return controlResponse;
    }

    const liveMatch = /^\/api\/broadcast\/live\/(\d+)$/.exec(path);
    if (liveMatch) {
      return broadcastLiveRoute(request, Number(liveMatch[1]));
    }

    const broadcastResponse = await handleBroadcastRequest(request, env, path);
    if (broadcastResponse) {
      return broadcastResponse;
    }

    if (path === "/api/telegram-notifications/status") {
      return telegramNotificationStatusRoute(request, env);
    }
    if (path === "/api/telegram-notifications/tick") {
      return telegramNotificationTickRoute(request, env);
    }
    if (path === "/api/data-core/backfill/status") {
      return backfillStatusRoute(request, env);
    }
    if (path === "/api/data-core/backfill/step") {
      return backfillStepRoute(request, env);
    }
    if (path === "/api/data-core/backfill/job") {
      return persistentBackfillJobRoute(request, env);
    }
    if (path === "/api/data-core/postgame/status") {
      return postgameStatusRoute(request, env);
    }

    return worker.fetch(request, env);
  },

  async scheduled(controller, env, ctx) {
    const cron = String(controller?.cron || "");

    if (cron === "* * * * *") {
      ctx.waitUntil(
        pollTelegramCenterUpdates(env).catch((error) => {
          console.error("scheduled Telegram Center polling failed", error);
        }),
      );
      return;
    }

    if (cron === "*/5 * * * *") {
      ctx.waitUntil(
        ensureLegacyTelegramWebhook(env).catch((error) => {
          console.error("scheduled legacy Telegram webhook repair failed", error);
        }),
      );
    }

    if (cron === "*/2 * * * *") {
      if (env.DB) {
        ctx.waitUntil(
          runVkBroadcastMaintenance(env).catch((error) => {
            console.error("dedicated HOH VK broadcast maintenance failed", error);
          }),
        );
      }
      return;
    }

    const canaryEnabled = envFlag(env.BACKFILL_CANARY_ENABLED, false);
    const fullBackfillEnabled = envFlag(env.FULL_BACKFILL_ENABLED, false);
    const liveNotificationsEnabled = envFlag(env.TELEGRAM_LIVE_NOTIFICATIONS_ENABLED, false);

    if (canaryEnabled && fullBackfillEnabled) {
      console.error("Backfill safety stop: canary and full backfill cannot run together");
    } else if (canaryEnabled) {
      ctx.waitUntil(runScheduledCanary(env));
    } else if (fullBackfillEnabled && fullBackfillStartReached(env)) {
      ctx.waitUntil(runScheduledFullBackfill(env));
    }

    if (env.DB) {
      ctx.waitUntil((async () => {
        try {
          await runCenterScheduleMaintenance(env);
        } catch (error) {
          console.error("scheduled Telegram Center schedule maintenance failed", error);
        }
        try {
          await runPostgameFinalizer(env);
        } catch (error) {
          console.error("scheduled postgame finalizer failed", error);
        }
        if (envFlag(env.WINLINE_FEED_SYNC_ENABLED, false)) {
          try {
            await runWinlineFeedMaintenance(env);
          } catch (error) {
            console.error("scheduled Winline NHL feed maintenance failed", error);
          }
        }
      })());
      ctx.waitUntil(
        runCenterNameMaintenance(env).catch((error) => {
          console.error("scheduled Telegram Center Russian-name maintenance failed", error);
        }),
      );
      ctx.waitUntil(
        runCenterRosterMaintenance(env).catch((error) => {
          console.error("scheduled Telegram Center roster maintenance failed", error);
        }),
      );
      ctx.waitUntil(
        runSportsRuNewsMaintenance(env).catch((error) => {
          console.error("scheduled Sports.ru NHL news maintenance failed", error);
        }),
      );
    }

    if (liveNotificationsEnabled && env.DB) {
      ctx.waitUntil(
        runCenterNotificationTick(env, { dryRun:false }).catch((error) => {
          console.error("scheduled Telegram Center notification tick failed", error);
        }),
      );
    }

    if (typeof worker.scheduled === "function") {
      return worker.scheduled(controller, env, ctx);
    }
  },
};

async function winlineClickRoute(request, env) {
  if (request.method !== "GET") return new Response("method_not_allowed",{status:405});
  if (!env?.DB) return redirect(WINLINE_PARTNER_URL);
  const url=new URL(request.url);
  const gamePk=Number(url.searchParams.get("game_pk")||0);
  const eventId=String(url.searchParams.get("event_id")||"").trim();
  let row=null;
  try{
    if(Number.isSafeInteger(gamePk)&&gamePk>0){
      row=await env.DB.prepare(`
        SELECT g.game_pk,g.game_state,g.scheduled_start_utc,we.winline_event_id,we.deeplink,we.starts_at
        FROM games g
        LEFT JOIN winline_events we ON we.game_pk=g.game_pk
        WHERE g.game_pk=? LIMIT 1;
      `).bind(gamePk).first();
    }else if(/^\d+$/.test(eventId)){
      row=await env.DB.prepare(`
        SELECT g.game_pk,g.game_state,g.scheduled_start_utc,we.winline_event_id,we.deeplink,we.starts_at
        FROM winline_events we
        LEFT JOIN games g ON g.game_pk=we.game_pk
        WHERE we.winline_event_id=? LIMIT 1;
      `).bind(eventId).first();
    }
  }catch{}
  const destination=isUpcomingWinlineRow(row)?row.deeplink:WINLINE_NHL_URL;
  const tracked=await trackedWinlineDestinationUrl(destination).catch(()=>null);
  return redirect(tracked||WINLINE_PARTNER_URL);
}

function isUpcomingWinlineRow(row){
  if(!row?.deeplink)return false;
  const state=String(row.game_state||"").toUpperCase();
  if(["FINAL","OFF"].includes(state))return false;
  const t=Date.parse(String(row.starts_at||row.scheduled_start_utc||""));
  if(!Number.isFinite(t))return false;
  const delta=t-Date.now();
  return delta>=-6*60*60*1000&&delta<=WINLINE_EVENT_WINDOW_MS;
}

async function trackedWinlineDestinationUrl(destinationUrl){
  const target=new URL(String(destinationUrl||""));
  if(!/(^|\.)winline\.ru$/i.test(target.hostname))return null;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);
  try{
    const partner=await fetch(WINLINE_PARTNER_URL,{
      redirect:"manual",
      signal:controller.signal,
      headers:{"user-agent":"HOH-NHL-Center/affiliate-router"}
    });
    const location=partner.headers.get("location");
    if(!location)return null;
    const affiliate=new URL(location);
    if(!/(^|\.)winline\.ru$/i.test(affiliate.hostname))return null;
    for(const [k,v] of affiliate.searchParams.entries())target.searchParams.set(k,v);
    target.searchParams.set("statid","2558_");
    target.searchParams.set("sub4","nhl");
    target.searchParams.set("promocode","NHL");
    if(!target.searchParams.get("utm_promo"))target.searchParams.set("utm_promo","NHL");
    return target.toString();
  }finally{clearTimeout(timer)}
}

function redirect(location){
  return new Response(null,{status:302,headers:{
    "Location":location,
    "Cache-Control":"no-store, no-cache, must-revalidate",
    "Referrer-Policy":"no-referrer"
  }});
}

async function broadcastLiveRoute(request, gamePk) {
  if (request.method !== "GET") {
    return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  }
  if (!Number.isSafeInteger(gamePk) || gamePk <= 0) {
    return jsonResponse({ ok: false, error: "invalid_game_pk" }, 400);
  }
  try {
    return jsonResponse(await buildLiveGameSnapshot(gamePk));
  } catch (error) {
    console.error("broadcast live snapshot failed", error);
    return jsonResponse({ ok: false, error: "nhl_live_snapshot_failed" }, 502);
  }
}

async function telegramNotificationStatusRoute(request, env) {
  if (request.method !== "GET") {
    return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  }
  return jsonResponse(await getCenterNotificationStatus(env));
}

async function telegramNotificationTickRoute(request, env) {
  if (request.method !== "POST") {
    return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  }
  if (!(await isManagementAuthorized(request, env))) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }
  const url = new URL(request.url);
  const dryRun = queryBool(url, "dry_run", true);
  try {
    const result = await runCenterNotificationTick(env, { dryRun });
    return jsonResponse(result, result.ok ? 200 : 500);
  } catch (error) {
    console.error("manual Telegram Center notification tick failed", error);
    return jsonResponse({ ok: false, error: "notification_tick_failed" }, 500);
  }
}


async function postgameStatusRoute(request,env){
  if(request.method!=="GET")return jsonResponse({ok:false,error:"method_not_allowed"},405);
  if(!(await isManagementAuthorized(request,env)))return jsonResponse({ok:false,error:"unauthorized"},401);
  if(!env.DB)return jsonResponse({ok:false,error:"missing_d1_binding"},503);
  try{return jsonResponse(await getPostgameIngestionStatus(env.DB))}
  catch(error){console.error("postgame status failed",error);return jsonResponse({ok:false,error:"postgame_status_failed"},500)}
}

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
  if (!env.DB) return;
  const status = await getBackfillStatus(env.DB, { season: CANARY_SEASON });
  if (status.games >= CANARY_TARGET_GAMES) return;
  await runBackfillStep(env.DB, {season:CANARY_SEASON,start_date:CANARY_START_DATE,end_date:CANARY_END_DATE,max_scan_days:14,dry_run:false});
}

async function runScheduledFullBackfill(env) {
  if (!env.DB) return;
  await runPersistentBackfillTick(env.DB, {
    job_id: String(env.FULL_BACKFILL_JOB_ID || "").trim(),
    season: String(env.FULL_BACKFILL_SEASON || "").trim(),
    start_date: String(env.FULL_BACKFILL_START_DATE || "").trim(),
    end_date: String(env.FULL_BACKFILL_END_DATE || "").trim(),
    daily_game_limit: envInt(env.FULL_BACKFILL_DAILY_GAME_LIMIT, 20, 1, 10000),
    max_scan_days: envInt(env.FULL_BACKFILL_MAX_SCAN_DAYS, 14, 1, 31),
  });
}

function fullBackfillStartReached(env) {
  const raw = String(env.FULL_BACKFILL_NOT_BEFORE_UTC || "").trim();
  if (!raw) return true;
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) {
    console.error("Backfill safety stop: FULL_BACKFILL_NOT_BEFORE_UTC is invalid");
    return false;
  }
  return Date.now() >= timestamp;
}

async function isManagementAuthorized(request, env) {
  const expected = String(env.MANAGEMENT_API_SECRET || "").trim();
  if (!expected) return false;
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.startsWith("Bearer ")) return false;
  const provided = authorization.slice("Bearer ".length).trim();
  if (!provided) return false;
  return secureEqual(provided, expected);
}

async function secureEqual(left, right) {
  const encoder = new TextEncoder();
  const leftDigest = await crypto.subtle.digest("SHA-256", encoder.encode(left));
  const rightDigest = await crypto.subtle.digest("SHA-256", encoder.encode(right));
  const a = new Uint8Array(leftDigest);
  const b = new Uint8Array(rightDigest);
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) mismatch |= a[index] ^ b[index];
  return mismatch === 0;
}

function queryBool(url, key, fallback) {
  const value = url.searchParams.get(key);
  if (value === null) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function envFlag(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function envInt(value, fallback, min, max) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) return fallback;
  return number;
}

function stripTrailingSlash(path) {
  if (path === "/") return "";
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}});
}
