import { fetchNhlJson, importGame } from "./data-core-importer.js";

const NHL_BASE = "https://api-web.nhle.com/v1";
const FINAL_GAME_STATES = new Set(["FINAL", "OFF"]);
const DEFAULT_MAX_SCAN_DAYS = 14;
const MAX_SCAN_DAYS = 31;

export async function runBackfillStep(db, options = {}, fetchImpl = fetch) {
  const season = normalizeSeason(options.season);
  const startDate = normalizeDate(options.start_date, "start_date");
  const endDate = normalizeDate(options.end_date, "end_date");
  if (startDate > endDate) {
    throw new Error("start_date must be on or before end_date");
  }

  const maxScanDays = clampInteger(options.max_scan_days, DEFAULT_MAX_SCAN_DAYS, 1, MAX_SCAN_DAYS);
  const dryRun = options.dry_run === true;
  let { date, index } = parseCursor(options.cursor, startDate);

  if (date < startDate) {
    date = startDate;
    index = 0;
  }
  if (date > endDate) {
    return doneResult(season, startDate, endDate, options.cursor || null, 0, 0);
  }

  let scannedDays = 0;
  let scannedFinalGames = 0;
  let skippedExisting = 0;

  while (date <= endDate && scannedDays < maxScanDays) {
    const payload = await fetchNhlJson(fetchImpl, `${NHL_BASE}/schedule/${date}`);
    const games = gamesForDate(payload, date)
      .filter((game) => gameBelongsToSeason(game, season))
      .filter((game) => FINAL_GAME_STATES.has(upper(game.gameState || game.gameStatus)))
      .sort(compareGames);

    scannedDays += 1;

    for (let gameIndex = index; gameIndex < games.length; gameIndex += 1) {
      const game = games[gameIndex];
      const gamePk = integerOrNull(game.id ?? game.gameId ?? game.gamePk);
      if (gamePk === null) {
        continue;
      }

      scannedFinalGames += 1;
      const nextCursor = cursorForNextGame(date, gameIndex, games.length);
      if (await gameExists(db, gamePk)) {
        skippedExisting += 1;
        continue;
      }

      const candidate = {
        game_pk: gamePk,
        game_date: textOrNull(game.gameDate) || date,
        start_time_utc: textOrNull(game.startTimeUTC),
        away_tri: teamAbbrev(game.awayTeam),
        home_tri: teamAbbrev(game.homeTeam),
        source_state: upper(game.gameState || game.gameStatus),
      };

      if (dryRun) {
        return {
          ok: true,
          action: "backfill_step",
          status: "candidate",
          dry_run: true,
          season,
          start_date: startDate,
          end_date: endDate,
          candidate,
          cursor: formatCursor(date, gameIndex),
          next_cursor: nextCursor,
          scanned_days: scannedDays,
          scanned_final_games: scannedFinalGames,
          skipped_existing: skippedExisting,
        };
      }

      const importResult = await importGame(db, gamePk, fetchImpl);
      return {
        ok: true,
        action: "backfill_step",
        status: "imported",
        dry_run: false,
        season,
        start_date: startDate,
        end_date: endDate,
        candidate,
        cursor: formatCursor(date, gameIndex),
        next_cursor: nextCursor,
        scanned_days: scannedDays,
        scanned_final_games: scannedFinalGames,
        skipped_existing: skippedExisting,
        import_result: importResult,
      };
    }

    date = addDays(date, 1);
    index = 0;
  }

  if (date > endDate) {
    return doneResult(season, startDate, endDate, formatCursor(date, 0), scannedDays, scannedFinalGames, skippedExisting);
  }

  return {
    ok: true,
    action: "backfill_step",
    status: "continue",
    dry_run: dryRun,
    season,
    start_date: startDate,
    end_date: endDate,
    next_cursor: formatCursor(date, 0),
    scanned_days: scannedDays,
    scanned_final_games: scannedFinalGames,
    skipped_existing: skippedExisting,
    reason: "scan_window_exhausted",
  };
}

export async function getBackfillStatus(db, options = {}) {
  const season = normalizeSeason(options.season);
  const row = await db
    .prepare(
      `SELECT
         COUNT(*) AS games,
         MIN(scheduled_start_utc) AS first_game_utc,
         MAX(scheduled_start_utc) AS last_game_utc
       FROM games
       WHERE season_id = ?;`,
    )
    .bind(season)
    .first();

  return {
    ok: true,
    action: "backfill_status",
    season,
    games: Number(row?.games || 0),
    first_game_utc: row?.first_game_utc || null,
    last_game_utc: row?.last_game_utc || null,
  };
}

function gamesForDate(payload, date) {
  const direct = Array.isArray(payload?.games) ? payload.games : [];
  const week = Array.isArray(payload?.gameWeek)
    ? payload.gameWeek.flatMap((entry) => (Array.isArray(entry?.games) ? entry.games : []))
    : [];
  const source = direct.length ? direct : week;

  return source.filter((game) => {
    const gameDate = textOrNull(game?.gameDate);
    return !gameDate || gameDate === date;
  });
}

function gameBelongsToSeason(game, season) {
  const sourceSeason = game?.season;
  if (sourceSeason === null || sourceSeason === undefined || sourceSeason === "") {
    return true;
  }
  return String(sourceSeason) === season;
}

async function gameExists(db, gamePk) {
  const row = await db
    .prepare("SELECT 1 AS found FROM games WHERE game_pk = ? LIMIT 1;")
    .bind(gamePk)
    .first();
  return Boolean(row?.found);
}

function compareGames(a, b) {
  const at = textOrNull(a?.startTimeUTC) || "";
  const bt = textOrNull(b?.startTimeUTC) || "";
  if (at !== bt) {
    return at.localeCompare(bt);
  }
  return (integerOrNull(a?.id ?? a?.gameId ?? a?.gamePk) || 0) -
    (integerOrNull(b?.id ?? b?.gameId ?? b?.gamePk) || 0);
}

function cursorForNextGame(date, gameIndex, gamesLength) {
  if (gameIndex + 1 < gamesLength) {
    return formatCursor(date, gameIndex + 1);
  }
  return formatCursor(addDays(date, 1), 0);
}

function parseCursor(cursor, fallbackDate) {
  if (!cursor) {
    return { date: fallbackDate, index: 0 };
  }
  const match = /^(\d{4}-\d{2}-\d{2}):(\d+)$/.exec(String(cursor).trim());
  if (!match) {
    throw new Error("cursor must use YYYY-MM-DD:index");
  }
  const date = normalizeDate(match[1], "cursor date");
  const index = Number(match[2]);
  if (!Number.isSafeInteger(index) || index < 0 || index > 100) {
    throw new Error("cursor index is invalid");
  }
  return { date, index };
}

function formatCursor(date, index) {
  return `${date}:${index}`;
}

function normalizeSeason(value) {
  const season = String(value || "").trim();
  if (!/^\d{8}$/.test(season)) {
    throw new Error("season must be an 8-digit NHL season ID");
  }
  const startYear = Number(season.slice(0, 4));
  const endYear = Number(season.slice(4));
  if (endYear !== startYear + 1) {
    throw new Error("season must be consecutive NHL years");
  }
  return season;
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

function addDays(date, amount) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function clampInteger(value, fallback, min, max) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`max_scan_days must be an integer between ${min} and ${max}`);
  }
  return number;
}

function teamAbbrev(team) {
  return upper(team?.abbrev || team?.triCode || team?.teamAbbrev) || null;
}

function textOrNull(value) {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  return text || null;
}

function integerOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function upper(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function doneResult(season, startDate, endDate, cursor, scannedDays, scannedFinalGames, skippedExisting = 0) {
  return {
    ok: true,
    action: "backfill_step",
    status: "done",
    dry_run: false,
    season,
    start_date: startDate,
    end_date: endDate,
    cursor,
    next_cursor: null,
    scanned_days: scannedDays,
    scanned_final_games: scannedFinalGames,
    skipped_existing: skippedExisting,
  };
}
