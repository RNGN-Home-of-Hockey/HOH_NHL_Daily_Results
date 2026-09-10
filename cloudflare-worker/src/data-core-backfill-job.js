import { runBackfillStep } from "./data-core-backfill.js";

const DEFAULT_DAILY_GAME_LIMIT = 20;
const DEFAULT_MAX_SCAN_DAYS = 14;
const MAX_DAILY_GAME_LIMIT = 10000;
const MAX_SCAN_DAYS = 31;
const LEASE_MS = 4 * 60 * 1000;

export async function runPersistentBackfillTick(db, options = {}, fetchImpl = fetch) {
  const config = normalizeConfig(options);
  const now = new Date();
  const nowIso = now.toISOString();
  const dayKey = nowIso.slice(0, 10);

  await ensureJob(db, config);
  let job = await getBackfillJob(db, config.job_id);
  assertJobMatchesConfig(job, config);

  if (job.status !== "running") {
    return resultForJob(job, `job_${job.status}`);
  }

  if (job.day_key !== dayKey) {
    await db
      .prepare(
        `UPDATE backfill_jobs
         SET day_key = ?, day_imported_games = 0, updated_at = CURRENT_TIMESTAMP
         WHERE job_id = ?;`,
      )
      .bind(dayKey, config.job_id)
      .run();
    job = await getBackfillJob(db, config.job_id);
  }

  if (Number(job.day_imported_games || 0) >= config.daily_game_limit) {
    return resultForJob(job, "daily_limit_reached", {
      daily_game_limit: config.daily_game_limit,
    });
  }

  const leaseToken = crypto.randomUUID();
  const leaseUntil = new Date(now.getTime() + LEASE_MS).toISOString();

  await db
    .prepare(
      `UPDATE backfill_jobs
       SET lease_token = ?, lease_until = ?, updated_at = CURRENT_TIMESTAMP
       WHERE job_id = ?
         AND status = 'running'
         AND (lease_until IS NULL OR lease_until < ?);`,
    )
    .bind(leaseToken, leaseUntil, config.job_id, nowIso)
    .run();

  job = await getBackfillJob(db, config.job_id);
  if (job.lease_token !== leaseToken) {
    return resultForJob(job, "busy");
  }

  try {
    const step = await runBackfillStep(
      db,
      {
        season: config.season,
        start_date: config.start_date,
        end_date: config.end_date,
        cursor: job.cursor || null,
        max_scan_days: config.max_scan_days,
        dry_run: false,
      },
      fetchImpl,
    );

    if (step.status === "imported") {
      const gamePk = Number(step.candidate?.game_pk || 0) || null;
      await db
        .prepare(
          `UPDATE backfill_jobs
           SET cursor = ?,
               imported_games = imported_games + 1,
               skipped_existing = skipped_existing + ?,
               day_key = ?,
               day_imported_games = day_imported_games + 1,
               last_game_pk = ?,
               last_error = NULL,
               lease_token = NULL,
               lease_until = NULL,
               updated_at = CURRENT_TIMESTAMP
           WHERE job_id = ? AND lease_token = ?;`,
        )
        .bind(
          step.next_cursor || null,
          Number(step.skipped_existing || 0),
          dayKey,
          gamePk,
          config.job_id,
          leaseToken,
        )
        .run();
    } else if (step.status === "continue") {
      await db
        .prepare(
          `UPDATE backfill_jobs
           SET cursor = ?,
               skipped_existing = skipped_existing + ?,
               last_error = NULL,
               lease_token = NULL,
               lease_until = NULL,
               updated_at = CURRENT_TIMESTAMP
           WHERE job_id = ? AND lease_token = ?;`,
        )
        .bind(
          step.next_cursor || null,
          Number(step.skipped_existing || 0),
          config.job_id,
          leaseToken,
        )
        .run();
    } else if (step.status === "done") {
      await db
        .prepare(
          `UPDATE backfill_jobs
           SET cursor = NULL,
               status = 'complete',
               skipped_existing = skipped_existing + ?,
               last_error = NULL,
               lease_token = NULL,
               lease_until = NULL,
               finished_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP
           WHERE job_id = ? AND lease_token = ?;`,
        )
        .bind(Number(step.skipped_existing || 0), config.job_id, leaseToken)
        .run();
    } else {
      throw new Error(`unexpected backfill step status: ${String(step.status)}`);
    }

    const updated = await getBackfillJob(db, config.job_id);
    return resultForJob(updated, step.status, {
      step,
      daily_game_limit: config.daily_game_limit,
    });
  } catch (error) {
    const message = String(error?.message || error || "backfill tick failed").slice(0, 1000);
    await db
      .prepare(
        `UPDATE backfill_jobs
         SET status = 'failed',
             error_count = error_count + 1,
             last_error = ?,
             lease_token = NULL,
             lease_until = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE job_id = ? AND lease_token = ?;`,
      )
      .bind(message, config.job_id, leaseToken)
      .run();
    throw error;
  }
}

export async function getBackfillJob(db, jobId) {
  const id = String(jobId || "").trim();
  if (!id) {
    throw new Error("job_id is required");
  }

  const row = await db
    .prepare(
      `SELECT
         job_id,
         season_id,
         start_date,
         end_date,
         cursor,
         status,
         imported_games,
         skipped_existing,
         error_count,
         day_key,
         day_imported_games,
         last_game_pk,
         last_error,
         lease_until,
         created_at,
         updated_at,
         finished_at
       FROM backfill_jobs
       WHERE job_id = ?;`,
    )
    .bind(id)
    .first();

  return row || null;
}

async function ensureJob(db, config) {
  await db
    .prepare(
      `INSERT OR IGNORE INTO backfill_jobs (
         job_id,
         season_id,
         start_date,
         end_date,
         cursor,
         status,
         day_key,
         day_imported_games
       ) VALUES (?, ?, ?, ?, ?, 'running', ?, 0);`,
    )
    .bind(
      config.job_id,
      config.season,
      config.start_date,
      config.end_date,
      `${config.start_date}:0`,
      new Date().toISOString().slice(0, 10),
    )
    .run();
}

function normalizeConfig(options) {
  const jobId = String(options.job_id || "").trim();
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(jobId)) {
    throw new Error("job_id must be 1-120 safe characters");
  }

  const season = String(options.season || "").trim();
  if (!/^\d{8}$/.test(season)) {
    throw new Error("season must be an 8-digit NHL season ID");
  }

  const startDate = normalizeDate(options.start_date, "start_date");
  const endDate = normalizeDate(options.end_date, "end_date");
  if (startDate > endDate) {
    throw new Error("start_date must be on or before end_date");
  }

  return {
    job_id: jobId,
    season,
    start_date: startDate,
    end_date: endDate,
    daily_game_limit: clampInteger(
      options.daily_game_limit,
      DEFAULT_DAILY_GAME_LIMIT,
      1,
      MAX_DAILY_GAME_LIMIT,
      "daily_game_limit",
    ),
    max_scan_days: clampInteger(
      options.max_scan_days,
      DEFAULT_MAX_SCAN_DAYS,
      1,
      MAX_SCAN_DAYS,
      "max_scan_days",
    ),
  };
}

function assertJobMatchesConfig(job, config) {
  if (!job) {
    throw new Error("backfill job could not be created");
  }
  if (
    String(job.season_id) !== config.season ||
    String(job.start_date) !== config.start_date ||
    String(job.end_date) !== config.end_date
  ) {
    throw new Error("existing backfill job configuration does not match requested configuration");
  }
}

function resultForJob(job, status, extra = {}) {
  return {
    ok: true,
    action: "persistent_backfill_tick",
    status,
    job,
    ...extra,
  };
}

function normalizeDate(value, fieldName) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new Error(`${fieldName} must use YYYY-MM-DD`);
  }
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw new Error(`${fieldName} is not a valid calendar date`);
  }
  return text;
}

function clampInteger(value, fallback, min, max, fieldName) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${fieldName} must be an integer between ${min} and ${max}`);
  }
  return number;
}
