const NHL_BASE = "https://api-web.nhle.com/v1";
const FINAL_GAME_STATES = new Set(["FINAL", "OFF"]);
const RETRYABLE_NHL_STATUSES = new Set([429, 500, 502, 503, 504]);
const NHL_FETCH_MAX_ATTEMPTS = 4;
const NHL_FETCH_TIMEOUT_MS = 20_000;
const NHL_RETRY_BASE_DELAY_MS = 250;
const NHL_RETRY_MAX_DELAY_MS = 5_000;

const TEAM_UPSERT_SQL = `
  INSERT INTO teams (
    tri_code, nhl_team_id, franchise_id, name_en, location_en,
    active, logo_url, updated_at
  )
  SELECT
    json_extract(value, '$.tri_code'),
    json_extract(value, '$.nhl_team_id'),
    json_extract(value, '$.franchise_id'),
    json_extract(value, '$.name_en'),
    json_extract(value, '$.location_en'),
    json_extract(value, '$.active'),
    json_extract(value, '$.logo_url'),
    CURRENT_TIMESTAMP
  FROM json_each(?)
  WHERE true
  ON CONFLICT(tri_code) DO UPDATE SET
    nhl_team_id = COALESCE(excluded.nhl_team_id, teams.nhl_team_id),
    franchise_id = COALESCE(excluded.franchise_id, teams.franchise_id),
    name_en = excluded.name_en,
    location_en = COALESCE(excluded.location_en, teams.location_en),
    active = excluded.active,
    logo_url = COALESCE(excluded.logo_url, teams.logo_url),
    updated_at = CURRENT_TIMESTAMP;
`;

const PLAYER_UPSERT_SQL = `
  INSERT INTO players (
    player_id, first_name_en, last_name_en, full_name_en,
    current_team_tri, position_code, sweater_number, shoots_catches,
    active, last_seen_game_start_utc, last_seen_game_pk, updated_at
  )
  SELECT
    json_extract(value, '$.player_id'),
    json_extract(value, '$.first_name_en'),
    json_extract(value, '$.last_name_en'),
    json_extract(value, '$.full_name_en'),
    json_extract(value, '$.current_team_tri'),
    json_extract(value, '$.position_code'),
    json_extract(value, '$.sweater_number'),
    json_extract(value, '$.shoots_catches'),
    json_extract(value, '$.active'),
    json_extract(value, '$.last_seen_game_start_utc'),
    json_extract(value, '$.last_seen_game_pk'),
    CURRENT_TIMESTAMP
  FROM json_each(?)
  WHERE true
  ON CONFLICT(player_id) DO UPDATE SET
    first_name_en = COALESCE(excluded.first_name_en, players.first_name_en),
    last_name_en = COALESCE(excluded.last_name_en, players.last_name_en),
    full_name_en = excluded.full_name_en,
    current_team_tri = CASE
      WHEN players.last_seen_game_start_utc IS NULL
        OR excluded.last_seen_game_start_utc > players.last_seen_game_start_utc
        OR (
          excluded.last_seen_game_start_utc = players.last_seen_game_start_utc
          AND excluded.last_seen_game_pk > COALESCE(players.last_seen_game_pk, -1)
        )
      THEN COALESCE(excluded.current_team_tri, players.current_team_tri)
      ELSE players.current_team_tri
    END,
    position_code = CASE
      WHEN players.last_seen_game_start_utc IS NULL
        OR excluded.last_seen_game_start_utc > players.last_seen_game_start_utc
        OR (
          excluded.last_seen_game_start_utc = players.last_seen_game_start_utc
          AND excluded.last_seen_game_pk > COALESCE(players.last_seen_game_pk, -1)
        )
      THEN COALESCE(excluded.position_code, players.position_code)
      ELSE players.position_code
    END,
    sweater_number = CASE
      WHEN players.last_seen_game_start_utc IS NULL
        OR excluded.last_seen_game_start_utc > players.last_seen_game_start_utc
        OR (
          excluded.last_seen_game_start_utc = players.last_seen_game_start_utc
          AND excluded.last_seen_game_pk > COALESCE(players.last_seen_game_pk, -1)
        )
      THEN COALESCE(excluded.sweater_number, players.sweater_number)
      ELSE players.sweater_number
    END,
    shoots_catches = COALESCE(excluded.shoots_catches, players.shoots_catches),
    active = players.active,
    last_seen_game_start_utc = CASE
      WHEN players.last_seen_game_start_utc IS NULL
        OR excluded.last_seen_game_start_utc > players.last_seen_game_start_utc
        OR (
          excluded.last_seen_game_start_utc = players.last_seen_game_start_utc
          AND excluded.last_seen_game_pk > COALESCE(players.last_seen_game_pk, -1)
        )
      THEN excluded.last_seen_game_start_utc
      ELSE players.last_seen_game_start_utc
    END,
    last_seen_game_pk = CASE
      WHEN players.last_seen_game_start_utc IS NULL
        OR excluded.last_seen_game_start_utc > players.last_seen_game_start_utc
        OR (
          excluded.last_seen_game_start_utc = players.last_seen_game_start_utc
          AND excluded.last_seen_game_pk > COALESCE(players.last_seen_game_pk, -1)
        )
      THEN excluded.last_seen_game_pk
      ELSE players.last_seen_game_pk
    END,
    updated_at = CURRENT_TIMESTAMP;
`;

const GAME_UPSERT_SQL = `
  INSERT INTO games (
    game_pk, season_id, game_type, scheduled_start_utc, game_state,
    home_tri, away_tri, home_score, away_score, current_period,
    period_type, venue_name, last_synced_at
  )
  SELECT
    json_extract(value, '$.game_pk'),
    json_extract(value, '$.season_id'),
    json_extract(value, '$.game_type'),
    json_extract(value, '$.scheduled_start_utc'),
    json_extract(value, '$.game_state'),
    json_extract(value, '$.home_tri'),
    json_extract(value, '$.away_tri'),
    json_extract(value, '$.home_score'),
    json_extract(value, '$.away_score'),
    json_extract(value, '$.current_period'),
    json_extract(value, '$.period_type'),
    json_extract(value, '$.venue_name'),
    CURRENT_TIMESTAMP
  FROM json_each(?)
  WHERE true
  ON CONFLICT(game_pk) DO UPDATE SET
    season_id = excluded.season_id,
    game_type = excluded.game_type,
    scheduled_start_utc = excluded.scheduled_start_utc,
    game_state = excluded.game_state,
    home_tri = excluded.home_tri,
    away_tri = excluded.away_tri,
    home_score = excluded.home_score,
    away_score = excluded.away_score,
    current_period = excluded.current_period,
    period_type = excluded.period_type,
    venue_name = excluded.venue_name,
    last_synced_at = CURRENT_TIMESTAMP;
`;

const PERIOD_SCORE_UPSERT_SQL = `
  INSERT INTO period_scores (
    game_pk, period_number, period_type, home_goals, away_goals
  )
  SELECT
    json_extract(value, '$.game_pk'),
    json_extract(value, '$.period_number'),
    json_extract(value, '$.period_type'),
    json_extract(value, '$.home_goals'),
    json_extract(value, '$.away_goals')
  FROM json_each(?)
  WHERE true
  ON CONFLICT(game_pk, period_number, period_type) DO UPDATE SET
    home_goals = excluded.home_goals,
    away_goals = excluded.away_goals;
`;

const GAME_EVENT_UPSERT_SQL = `
  INSERT INTO game_events (
    event_key, game_pk, event_id, sort_order, event_type,
    period_number, period_type, time_in_period, time_remaining,
    team_tri, home_score, away_score, description, x_coord, y_coord,
    details_json, updated_at
  )
  SELECT
    json_extract(value, '$.event_key'),
    json_extract(value, '$.game_pk'),
    json_extract(value, '$.event_id'),
    json_extract(value, '$.sort_order'),
    json_extract(value, '$.event_type'),
    json_extract(value, '$.period_number'),
    json_extract(value, '$.period_type'),
    json_extract(value, '$.time_in_period'),
    json_extract(value, '$.time_remaining'),
    json_extract(value, '$.team_tri'),
    json_extract(value, '$.home_score'),
    json_extract(value, '$.away_score'),
    json_extract(value, '$.description'),
    json_extract(value, '$.x_coord'),
    json_extract(value, '$.y_coord'),
    json_extract(value, '$.details_json'),
    CURRENT_TIMESTAMP
  FROM json_each(?)
  WHERE true
  ON CONFLICT(event_key) DO UPDATE SET
    event_id = excluded.event_id,
    sort_order = excluded.sort_order,
    event_type = excluded.event_type,
    period_number = excluded.period_number,
    period_type = excluded.period_type,
    time_in_period = excluded.time_in_period,
    time_remaining = excluded.time_remaining,
    team_tri = excluded.team_tri,
    home_score = excluded.home_score,
    away_score = excluded.away_score,
    description = excluded.description,
    x_coord = excluded.x_coord,
    y_coord = excluded.y_coord,
    details_json = excluded.details_json,
    updated_at = CURRENT_TIMESTAMP;
`;

const EVENT_PLAYER_UPSERT_SQL = `
  INSERT INTO event_players (event_key, player_id, role, ordinal)
  SELECT
    json_extract(value, '$.event_key'),
    json_extract(value, '$.player_id'),
    json_extract(value, '$.role'),
    json_extract(value, '$.ordinal')
  FROM json_each(?)
  WHERE true
  ON CONFLICT(event_key, player_id, role, ordinal) DO NOTHING;
`;

const TEAM_GAME_STATS_UPSERT_SQL = `
  INSERT INTO team_game_stats (
    game_pk, team_tri, is_home, goals, shots, shot_attempts,
    blocked_shots, hits, pim, giveaways, takeaways, faceoff_pct,
    power_play_goals, power_play_opportunities, shorthanded_goals,
    updated_at
  )
  SELECT
    json_extract(value, '$.game_pk'),
    json_extract(value, '$.team_tri'),
    json_extract(value, '$.is_home'),
    json_extract(value, '$.goals'),
    json_extract(value, '$.shots'),
    json_extract(value, '$.shot_attempts'),
    json_extract(value, '$.blocked_shots'),
    json_extract(value, '$.hits'),
    json_extract(value, '$.pim'),
    json_extract(value, '$.giveaways'),
    json_extract(value, '$.takeaways'),
    json_extract(value, '$.faceoff_pct'),
    json_extract(value, '$.power_play_goals'),
    json_extract(value, '$.power_play_opportunities'),
    json_extract(value, '$.shorthanded_goals'),
    CURRENT_TIMESTAMP
  FROM json_each(?)
  WHERE true
  ON CONFLICT(game_pk, team_tri) DO UPDATE SET
    is_home = excluded.is_home,
    goals = excluded.goals,
    shots = excluded.shots,
    shot_attempts = excluded.shot_attempts,
    blocked_shots = excluded.blocked_shots,
    hits = excluded.hits,
    pim = excluded.pim,
    giveaways = excluded.giveaways,
    takeaways = excluded.takeaways,
    faceoff_pct = excluded.faceoff_pct,
    power_play_goals = excluded.power_play_goals,
    power_play_opportunities = excluded.power_play_opportunities,
    shorthanded_goals = excluded.shorthanded_goals,
    updated_at = CURRENT_TIMESTAMP;
`;

const PLAYER_GAME_STATS_UPSERT_SQL = `
  INSERT INTO player_game_stats (
    game_pk, player_id, team_tri, goals, assists, points, shots,
    shot_attempts, hits, blocked_shots, pim, plus_minus, faceoff_pct,
    toi_seconds, power_play_goals, power_play_points,
    shorthanded_goals, game_winning_goals, updated_at
  )
  SELECT
    json_extract(value, '$.game_pk'),
    json_extract(value, '$.player_id'),
    json_extract(value, '$.team_tri'),
    json_extract(value, '$.goals'),
    json_extract(value, '$.assists'),
    json_extract(value, '$.points'),
    json_extract(value, '$.shots'),
    json_extract(value, '$.shot_attempts'),
    json_extract(value, '$.hits'),
    json_extract(value, '$.blocked_shots'),
    json_extract(value, '$.pim'),
    json_extract(value, '$.plus_minus'),
    json_extract(value, '$.faceoff_pct'),
    json_extract(value, '$.toi_seconds'),
    json_extract(value, '$.power_play_goals'),
    json_extract(value, '$.power_play_points'),
    json_extract(value, '$.shorthanded_goals'),
    json_extract(value, '$.game_winning_goals'),
    CURRENT_TIMESTAMP
  FROM json_each(?)
  WHERE true
  ON CONFLICT(game_pk, player_id) DO UPDATE SET
    team_tri = excluded.team_tri,
    goals = excluded.goals,
    assists = excluded.assists,
    points = excluded.points,
    shots = excluded.shots,
    shot_attempts = excluded.shot_attempts,
    hits = excluded.hits,
    blocked_shots = excluded.blocked_shots,
    pim = excluded.pim,
    plus_minus = excluded.plus_minus,
    faceoff_pct = excluded.faceoff_pct,
    toi_seconds = excluded.toi_seconds,
    power_play_goals = excluded.power_play_goals,
    power_play_points = excluded.power_play_points,
    shorthanded_goals = excluded.shorthanded_goals,
    game_winning_goals = excluded.game_winning_goals,
    updated_at = CURRENT_TIMESTAMP;
`;

const GOALIE_GAME_STATS_UPSERT_SQL = `
  INSERT INTO goalie_game_stats (
    game_pk, player_id, team_tri, is_starter, decision, saves,
    shots_against, goals_against, save_pct, toi_seconds,
    even_strength_goals_against, power_play_goals_against,
    shorthanded_goals_against, updated_at
  )
  SELECT
    json_extract(value, '$.game_pk'),
    json_extract(value, '$.player_id'),
    json_extract(value, '$.team_tri'),
    json_extract(value, '$.is_starter'),
    json_extract(value, '$.decision'),
    json_extract(value, '$.saves'),
    json_extract(value, '$.shots_against'),
    json_extract(value, '$.goals_against'),
    json_extract(value, '$.save_pct'),
    json_extract(value, '$.toi_seconds'),
    json_extract(value, '$.even_strength_goals_against'),
    json_extract(value, '$.power_play_goals_against'),
    json_extract(value, '$.shorthanded_goals_against'),
    CURRENT_TIMESTAMP
  FROM json_each(?)
  WHERE true
  ON CONFLICT(game_pk, player_id) DO UPDATE SET
    team_tri = excluded.team_tri,
    is_starter = excluded.is_starter,
    decision = excluded.decision,
    saves = excluded.saves,
    shots_against = excluded.shots_against,
    goals_against = excluded.goals_against,
    save_pct = excluded.save_pct,
    toi_seconds = excluded.toi_seconds,
    even_strength_goals_against = excluded.even_strength_goals_against,
    power_play_goals_against = excluded.power_play_goals_against,
    shorthanded_goals_against = excluded.shorthanded_goals_against,
    updated_at = CURRENT_TIMESTAMP;
`;

const STALE_EVENT_PLAYERS_DELETE_SQL = `
  DELETE FROM event_players
  WHERE event_key LIKE ?
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(?) AS incoming
      WHERE json_extract(incoming.value, '$.event_key') = event_players.event_key
        AND json_extract(incoming.value, '$.player_id') = event_players.player_id
        AND json_extract(incoming.value, '$.role') = event_players.role
        AND json_extract(incoming.value, '$.ordinal') = event_players.ordinal
    );
`;

const STALE_GAME_EVENTS_DELETE_SQL = `
  DELETE FROM game_events
  WHERE game_pk = ?
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(?) AS incoming
      WHERE json_extract(incoming.value, '$.event_key') = game_events.event_key
    );
`;

const STALE_PERIOD_SCORES_DELETE_SQL = `
  DELETE FROM period_scores
  WHERE game_pk = ?
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(?) AS incoming
      WHERE json_extract(incoming.value, '$.period_number') = period_scores.period_number
        AND json_extract(incoming.value, '$.period_type') = period_scores.period_type
    );
`;

const STALE_TEAM_GAME_STATS_DELETE_SQL = `
  DELETE FROM team_game_stats
  WHERE game_pk = ?
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(?) AS incoming
      WHERE json_extract(incoming.value, '$.team_tri') = team_game_stats.team_tri
    );
`;

const STALE_PLAYER_GAME_STATS_DELETE_SQL = `
  DELETE FROM player_game_stats
  WHERE game_pk = ?
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(?) AS incoming
      WHERE json_extract(incoming.value, '$.player_id') = player_game_stats.player_id
    );
`;

const STALE_GOALIE_GAME_STATS_DELETE_SQL = `
  DELETE FROM goalie_game_stats
  WHERE game_pk = ?
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(?) AS incoming
      WHERE json_extract(incoming.value, '$.player_id') = goalie_game_stats.player_id
    );
`;

export async function importCurrentTeams(db, fetchImpl = fetch) {
  const sourceUrl = `${NHL_BASE}/standings/now`;
  const syncId = await startSyncRun(db, "teams", "current", { source_url: sourceUrl });

  try {
    const payload = await fetchNhlJson(fetchImpl, sourceUrl);
    const sourceRows = Array.isArray(payload.standings) ? payload.standings : [];
    if (!sourceRows.length) {
      throw new Error("NHL standings returned no teams");
    }

    const teamsByCode = new Map();
    for (const source of sourceRows) {
      const team = teamFromStandings(source);
      teamsByCode.set(team.tri_code, team);
    }
    const teams = [...teamsByCode.values()].sort((a, b) => a.tri_code.localeCompare(b.tri_code));
    const existing = await db
      .prepare("SELECT tri_code FROM teams WHERE tri_code IN (SELECT value FROM json_each(?));")
      .bind(JSON.stringify(teams.map((team) => team.tri_code)))
      .all();
    const existingCodes = new Set((existing.results || []).map((row) => String(row.tri_code)));
    const inserted = teams.filter((team) => !existingCodes.has(team.tri_code)).length;
    const updated = teams.length - inserted;

    await db.prepare(TEAM_UPSERT_SQL).bind(JSON.stringify(teams)).run();

    const records = { teams: teams.length };
    await finishSyncRun(db, syncId, {
      status: "success",
      inserted,
      updated,
      metadata: { source_url: sourceUrl, records },
    });
    return { ok: true, action: "import_teams", records, inserted, updated };
  } catch (error) {
    await recordSyncError(db, syncId, error, { source_url: sourceUrl });
    throw error;
  }
}

export async function importGame(db, gamePk, fetchImpl = fetch) {
  if (!Number.isSafeInteger(gamePk) || gamePk <= 0) {
    throw new Error("game_pk must be a positive integer");
  }

  const boxscoreUrl = `${NHL_BASE}/gamecenter/${gamePk}/boxscore`;
  const playByPlayUrl = `${NHL_BASE}/gamecenter/${gamePk}/play-by-play`;
  const syncId = await startSyncRun(db, "game", String(gamePk), {
    source_urls: [boxscoreUrl, playByPlayUrl],
  });

  try {
    const [boxscore, playByPlay] = await Promise.all([
      fetchNhlJson(fetchImpl, boxscoreUrl),
      fetchNhlJson(fetchImpl, playByPlayUrl),
    ]);
    validateGamePayloads(gamePk, boxscore, playByPlay);

    const homeTeam = teamFromGame(boxscore.homeTeam);
    const awayTeam = teamFromGame(boxscore.awayTeam);
    const teams = [homeTeam, awayTeam];
    const teamById = new Map(teams.map((team) => [team.nhl_team_id, team.tri_code]));
    const game = gameFromPayload(boxscore);
    const players = playersFromRoster(playByPlay.rosterSpots, teamById, game);
    const rosterIds = new Set(players.map((player) => player.player_id));
    const events = eventsFromPlays(gamePk, playByPlay.plays, teamById);
    validateScoreReconciliation(game, playByPlay.plays, teamById);
    const eventPlayers = eventPlayersFromPlays(events, playByPlay.plays, rosterIds);
    const periodScores = periodScoresFromPlays(gamePk, playByPlay.plays, teamById, homeTeam, awayTeam);
    const playerGameStats = playerStatsFromBoxscore(gamePk, boxscore, rosterIds);
    const teamGameStats = teamStatsFromBoxscore(gamePk, boxscore, playByPlay.plays);
    const goalieGameStats = goalieStatsFromBoxscore(gamePk, boxscore, rosterIds);

    const records = {
      teams: teams.length,
      games: 1,
      players: players.length,
      events: events.length,
      event_players: eventPlayers.length,
      period_scores: periodScores.length,
      team_game_stats: teamGameStats.length,
      player_game_stats: playerGameStats.length,
      goalie_game_stats: goalieGameStats.length,
    };
    const existing = await existingGameRecordCounts(
      db,
      gamePk,
      teams.map((team) => team.tri_code),
      players.map((player) => player.player_id),
    );
    const { inserted, updated } = insertedAndUpdatedCounts(records, existing);

    const batchResults = await db.batch([
      jsonStatement(db, TEAM_UPSERT_SQL, teams),
      jsonStatement(db, PLAYER_UPSERT_SQL, players),
      jsonStatement(db, GAME_UPSERT_SQL, [game]),
      jsonStatement(db, PERIOD_SCORE_UPSERT_SQL, periodScores),
      jsonStatement(db, GAME_EVENT_UPSERT_SQL, events),
      jsonStatement(db, EVENT_PLAYER_UPSERT_SQL, eventPlayers),
      jsonStatement(db, TEAM_GAME_STATS_UPSERT_SQL, teamGameStats),
      jsonStatement(db, PLAYER_GAME_STATS_UPSERT_SQL, playerGameStats),
      jsonStatement(db, GOALIE_GAME_STATS_UPSERT_SQL, goalieGameStats),
      staleStatement(db, STALE_EVENT_PLAYERS_DELETE_SQL, `${gamePk}:%`, eventPlayers),
      staleStatement(db, STALE_GAME_EVENTS_DELETE_SQL, gamePk, events),
      staleStatement(db, STALE_PERIOD_SCORES_DELETE_SQL, gamePk, periodScores),
      staleStatement(db, STALE_TEAM_GAME_STATS_DELETE_SQL, gamePk, teamGameStats),
      staleStatement(db, STALE_PLAYER_GAME_STATS_DELETE_SQL, gamePk, playerGameStats),
      staleStatement(db, STALE_GOALIE_GAME_STATS_DELETE_SQL, gamePk, goalieGameStats),
    ]);

    const staleDeleted = {
      event_players: statementChanges(batchResults[9]),
      game_events: statementChanges(batchResults[10]),
      period_scores: statementChanges(batchResults[11]),
      team_game_stats: statementChanges(batchResults[12]),
      player_game_stats: statementChanges(batchResults[13]),
      goalie_game_stats: statementChanges(batchResults[14]),
    };
    const physicalWrites = batchResults.reduce((total, result) => total + statementChanges(result), 0);

    const metadata = {
      source_urls: [boxscoreUrl, playByPlayUrl],
      source_state: game.game_state,
      matchup: `${awayTeam.tri_code} @ ${homeTeam.tri_code}`,
      final_score: `${awayTeam.score}-${homeTeam.score}`,
      records,
      stale_deleted: staleDeleted,
      physical_writes: physicalWrites,
    };
    await finishSyncRun(db, syncId, { status: "success", inserted, updated, metadata });
    return {
      ok: true,
      action: "import_game",
      game_pk: gamePk,
      source_state: game.game_state,
      records,
      inserted,
      updated,
      stale_deleted: staleDeleted,
      physical_writes: physicalWrites,
    };
  } catch (error) {
    await recordSyncError(db, syncId, error, { source_urls: [boxscoreUrl, playByPlayUrl] });
    throw error;
  }
}

export async function fetchNhlJson(fetchImpl, url, options = {}) {
  const sleepImpl = options.sleepImpl || sleep;
  const timeoutMs = options.timeoutMs ?? NHL_FETCH_TIMEOUT_MS;

  for (let attempt = 1; attempt <= NHL_FETCH_MAX_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      if (attempt === NHL_FETCH_MAX_ATTEMPTS) {
        throw new Error(`NHL request failed after ${NHL_FETCH_MAX_ATTEMPTS} attempts (network_or_timeout)`);
      }
      await sleepImpl(retryDelayMs(null, attempt));
      continue;
    }

    if (response.ok) {
      try {
        return await response.json();
      } catch {
        throw new Error("NHL response contained invalid JSON");
      }
    }

    if (!RETRYABLE_NHL_STATUSES.has(response.status)) {
      throw new Error(`NHL request failed with HTTP ${response.status}`);
    }
    if (attempt === NHL_FETCH_MAX_ATTEMPTS) {
      throw new Error(
        `NHL request failed with HTTP ${response.status} after ${NHL_FETCH_MAX_ATTEMPTS} attempts`,
      );
    }
    await sleepImpl(retryDelayMs(response, attempt));
  }

  throw new Error("NHL request failed");
}

function validateGamePayloads(gamePk, boxscore, playByPlay) {
  if (integerOrNull(boxscore.id) !== gamePk || integerOrNull(playByPlay.id) !== gamePk) {
    throw new Error("NHL payload game ID mismatch");
  }
  const state = upper(boxscore.gameState);
  if (!FINAL_GAME_STATES.has(state)) {
    throw new Error(`NHL game is not final: ${state || "unknown"}`);
  }
  if (upper(playByPlay.gameState) !== state) {
    throw new Error("NHL payload game state mismatch");
  }
  const boxscoreHome = requiredTeamIdentity(boxscore.homeTeam, "boxscore home team");
  const boxscoreAway = requiredTeamIdentity(boxscore.awayTeam, "boxscore away team");
  const playByPlayHome = requiredTeamIdentity(playByPlay.homeTeam, "play-by-play home team");
  const playByPlayAway = requiredTeamIdentity(playByPlay.awayTeam, "play-by-play away team");
  if (
    boxscoreHome.id !== playByPlayHome.id ||
    boxscoreHome.tri_code !== playByPlayHome.tri_code ||
    boxscoreAway.id !== playByPlayAway.id ||
    boxscoreAway.tri_code !== playByPlayAway.tri_code
  ) {
    throw new Error("NHL payload team identity mismatch");
  }
  if (
    boxscoreHome.id === boxscoreAway.id ||
    boxscoreHome.tri_code === boxscoreAway.tri_code
  ) {
    throw new Error("NHL payload has duplicate home and away teams");
  }
  const homeScore = requiredNonNegativeInteger(boxscore.homeTeam?.score, "home score");
  const awayScore = requiredNonNegativeInteger(boxscore.awayTeam?.score, "away score");
  if (
    integerOrNull(playByPlay.homeTeam?.score) !== homeScore ||
    integerOrNull(playByPlay.awayTeam?.score) !== awayScore
  ) {
    throw new Error("NHL payload final score mismatch");
  }
  if (!Array.isArray(playByPlay.plays) || !playByPlay.plays.length) {
    throw new Error("NHL play-by-play returned no plays");
  }
  if (!Array.isArray(playByPlay.rosterSpots) || !playByPlay.rosterSpots.length) {
    throw new Error("NHL play-by-play returned no roster");
  }
}

function requiredTeamIdentity(source, label) {
  const id = integerOrNull(source?.id);
  const triCode = upper(source?.abbrev);
  if (id === null || !triCode) {
    throw new Error(`NHL payload is missing ${label} ID or abbreviation`);
  }
  return { id, tri_code: triCode };
}

function teamFromStandings(source) {
  const triCode = upper(localized(source.teamAbbrev));
  const name = localized(source.teamName);
  if (!triCode || !name) {
    throw new Error("NHL standings team is missing abbreviation or name");
  }
  return {
    tri_code: triCode,
    nhl_team_id: null,
    franchise_id: null,
    name_en: name,
    location_en: localized(source.placeName) || null,
    active: 1,
    logo_url: textOrNull(source.teamLogo),
  };
}

function teamFromGame(source) {
  const triCode = upper(source?.abbrev);
  const location = localized(source?.placeName);
  const commonName = localized(source?.commonName);
  const name = [location, commonName].filter(Boolean).join(" ");
  const teamId = integerOrNull(source?.id);
  if (!triCode || !name || teamId === null) {
    throw new Error("NHL game team is missing an ID, abbreviation, or name");
  }
  return {
    tri_code: triCode,
    nhl_team_id: teamId,
    franchise_id: null,
    name_en: name,
    location_en: location || null,
    active: 1,
    logo_url: textOrNull(source.logo),
    score: requiredNonNegativeInteger(source.score, "team score"),
    shots: integerOrNull(source.sog),
  };
}

function playersFromRoster(rosterSpots, teamById, game) {
  const players = new Map();
  for (const source of rosterSpots) {
    const playerId = integerOrNull(source.playerId);
    const teamTri = teamById.get(integerOrNull(source.teamId));
    const firstName = localized(source.firstName);
    const lastName = localized(source.lastName);
    const fullName = [firstName, lastName].filter(Boolean).join(" ");
    if (playerId === null || !teamTri || !fullName) {
      throw new Error("NHL roster player is missing a reliable ID, team, or name");
    }
    players.set(playerId, {
      player_id: playerId,
      first_name_en: firstName || null,
      last_name_en: lastName || null,
      full_name_en: fullName,
      current_team_tri: teamTri,
      position_code: textOrNull(source.positionCode),
      sweater_number: integerOrNull(source.sweaterNumber),
      shoots_catches: null,
      active: 1,
      last_seen_game_start_utc: game.scheduled_start_utc,
      last_seen_game_pk: game.game_pk,
    });
  }
  return [...players.values()].sort((a, b) => a.player_id - b.player_id);
}

function gameFromPayload(boxscore) {
  const homeTeam = boxscore.homeTeam || {};
  const awayTeam = boxscore.awayTeam || {};
  const gamePk = requiredInteger(boxscore.id, "game ID");
  const scheduledStart = textOrNull(boxscore.startTimeUTC);
  const state = upper(boxscore.gameState);
  if (!scheduledStart) {
    throw new Error("NHL game is missing scheduled start time");
  }
  return {
    game_pk: gamePk,
    season_id: String(requiredInteger(boxscore.season, "season ID")),
    game_type: integerOrNull(boxscore.gameType),
    scheduled_start_utc: scheduledStart,
    game_state: state,
    home_tri: upper(homeTeam.abbrev),
    away_tri: upper(awayTeam.abbrev),
    home_score: requiredNonNegativeInteger(homeTeam.score, "home score"),
    away_score: requiredNonNegativeInteger(awayTeam.score, "away score"),
    current_period: integerOrNull(boxscore.periodDescriptor?.number),
    period_type: textOrNull(boxscore.periodDescriptor?.periodType),
    venue_name: localized(boxscore.venue) || null,
  };
}

function eventsFromPlays(gamePk, plays, teamById) {
  const events = [];
  const sortOrders = new Set();
  for (const play of plays) {
    const eventId = integerOrNull(play.eventId);
    const sortOrder = integerOrNull(play.sortOrder) ?? eventId;
    if (sortOrder === null || sortOrders.has(sortOrder)) {
      throw new Error("NHL play is missing a unique stable sort order");
    }
    sortOrders.add(sortOrder);
    const details = play.details || {};
    const periodType = textOrNull(play.periodDescriptor?.periodType);
    const sourceEventType = textOrNull(play.typeDescKey) || String(play.typeCode);
    const ownerTeamId = integerOrNull(details.eventOwnerTeamId);
    const teamTri = ownerTeamId === null ? null : teamById.get(ownerTeamId);
    if (ownerTeamId !== null && !teamTri) {
      throw new Error("NHL play references an unknown event owner team");
    }
    events.push({
      event_key: `${gamePk}:${sortOrder}`,
      game_pk: gamePk,
      event_id: eventId,
      sort_order: sortOrder,
      event_type: periodType === "SO" && sourceEventType === "goal" ? "shootout-goal" : sourceEventType,
      period_number: integerOrNull(play.periodDescriptor?.number),
      period_type: periodType,
      time_in_period: textOrNull(play.timeInPeriod),
      time_remaining: textOrNull(play.timeRemaining),
      team_tri: teamTri || null,
      home_score: integerOrNull(details.homeScore),
      away_score: integerOrNull(details.awayScore),
      description: null,
      x_coord: numberOrNull(details.xCoord),
      y_coord: numberOrNull(details.yCoord),
      details_json: JSON.stringify(details),
    });
  }
  return events;
}

function validateScoreReconciliation(game, plays, teamById) {
  const nonShootoutGoals = new Map([
    [game.home_tri, 0],
    [game.away_tri, 0],
  ]);
  let hasShootoutPlays = false;

  for (const play of plays) {
    const periodType = textOrNull(play.periodDescriptor?.periodType);
    if (periodType === "SO") {
      hasShootoutPlays = true;
    }
    if (play.typeDescKey !== "goal" || periodType === "SO") {
      continue;
    }
    const teamTri = teamById.get(integerOrNull(play.details?.eventOwnerTeamId));
    if (!nonShootoutGoals.has(teamTri)) {
      throw new Error("NHL goal references an unknown scoring team");
    }
    nonShootoutGoals.set(teamTri, nonShootoutGoals.get(teamTri) + 1);
  }

  const homeGoals = nonShootoutGoals.get(game.home_tri);
  const awayGoals = nonShootoutGoals.get(game.away_tri);
  if (["REG", "OT"].includes(game.period_type)) {
    if (homeGoals !== game.home_score || awayGoals !== game.away_score) {
      throw new Error("NHL goal plays do not reconcile with the final score");
    }
    return;
  }

  if (game.period_type !== "SO") {
    throw new Error(`NHL final game has unsupported period type: ${game.period_type || "unknown"}`);
  }
  const homeWon = game.home_score === game.away_score + 1;
  const awayWon = game.away_score === game.home_score + 1;
  const winnerBonusMatches = homeWon
    ? game.home_score === homeGoals + 1 && game.away_score === awayGoals
    : awayWon && game.away_score === awayGoals + 1 && game.home_score === homeGoals;
  if (!hasShootoutPlays || homeGoals !== awayGoals || !winnerBonusMatches) {
    throw new Error("NHL shootout goals do not reconcile with final winner-bonus semantics");
  }
}

function eventPlayersFromPlays(events, plays, rosterIds) {
  const links = new Map();
  const fixedMappings = [
    ["scoringPlayerId", "scorer", 1],
    ["assist1PlayerId", "assist", 1],
    ["assist2PlayerId", "assist", 2],
    ["assist3PlayerId", "assist", 3],
    ["shootingPlayerId", "shooter", 1],
    ["goalieInNetId", "goalie", 1],
    ["hittingPlayerId", "hitter", 1],
    ["hitteePlayerId", "hittee", 1],
    ["blockingPlayerId", "blocker", 1],
    ["committingPlayerId", "penalty_committed", 1],
    ["committedByPlayerId", "penalty_committed", 1],
    ["drawnByPlayerId", "penalty_drawn", 1],
    ["servedByPlayerId", "penalty_served", 1],
    ["winningPlayerId", "faceoff_winner", 1],
    ["losingPlayerId", "faceoff_loser", 1],
  ];

  const addLink = (eventKey, playerIdValue, role, ordinal) => {
    const playerId = integerOrNull(playerIdValue);
    if (playerId === null || !rosterIds.has(playerId)) {
      return;
    }
    const key = `${eventKey}:${playerId}:${role}:${ordinal}`;
    links.set(key, { event_key: eventKey, player_id: playerId, role, ordinal });
  };

  for (let index = 0; index < plays.length; index += 1) {
    const eventKey = events[index].event_key;
    const play = plays[index];
    const details = play.details || {};
    for (const [field, role, ordinal] of fixedMappings) {
      addLink(eventKey, details[field], role, ordinal);
    }
    if (play.typeDescKey === "giveaway") {
      addLink(eventKey, details.playerId, "giveaway", 1);
    } else if (play.typeDescKey === "takeaway") {
      addLink(eventKey, details.playerId, "takeaway", 1);
    }
  }
  return [...links.values()];
}

function periodScoresFromPlays(gamePk, plays, teamById, homeTeam, awayTeam) {
  const periods = new Map();
  for (const play of plays) {
    const periodNumber = integerOrNull(play.periodDescriptor?.number);
    const periodType = textOrNull(play.periodDescriptor?.periodType);
    if (periodNumber === null || !periodType) {
      continue;
    }
    const key = `${periodNumber}:${periodType}`;
    if (!periods.has(key)) {
      periods.set(key, {
        game_pk: gamePk,
        period_number: periodNumber,
        period_type: periodType,
        home_goals: 0,
        away_goals: 0,
      });
    }
    if (play.typeDescKey !== "goal" || periodType === "SO") {
      continue;
    }
    const scoringTeam = teamById.get(integerOrNull(play.details?.eventOwnerTeamId));
    if (scoringTeam === homeTeam.tri_code) {
      periods.get(key).home_goals += 1;
    } else if (scoringTeam === awayTeam.tri_code) {
      periods.get(key).away_goals += 1;
    } else {
      throw new Error("NHL goal references an unknown scoring team");
    }
  }
  return [...periods.values()].sort(
    (a, b) => a.period_number - b.period_number || a.period_type.localeCompare(b.period_type),
  );
}

function playerStatsFromBoxscore(gamePk, boxscore, rosterIds) {
  const rows = [];
  for (const [side, team] of [
    ["awayTeam", boxscore.awayTeam],
    ["homeTeam", boxscore.homeTeam],
  ]) {
    const teamTri = upper(team?.abbrev);
    for (const group of ["forwards", "defense", "goalies"]) {
      for (const source of boxscore.playerByGameStats?.[side]?.[group] || []) {
        const playerId = integerOrNull(source.playerId);
        if (playerId === null || !rosterIds.has(playerId)) {
          throw new Error("NHL boxscore player is missing from the official roster");
        }
        const isGoalie = group === "goalies";
        rows.push({
          game_pk: gamePk,
          player_id: playerId,
          team_tri: teamTri,
          goals: integerOrNull(source.goals) ?? 0,
          assists: integerOrNull(source.assists) ?? 0,
          points: integerOrNull(source.points) ?? 0,
          shots: isGoalie ? null : integerOrNull(source.sog),
          shot_attempts: null,
          hits: isGoalie ? null : integerOrNull(source.hits),
          blocked_shots: isGoalie ? null : integerOrNull(source.blockedShots),
          pim: integerOrNull(source.pim),
          plus_minus: isGoalie ? null : integerOrNull(source.plusMinus),
          faceoff_pct: isGoalie ? null : numberOrNull(source.faceoffWinningPctg),
          toi_seconds: toiSeconds(source.toi),
          power_play_goals: isGoalie ? null : integerOrNull(source.powerPlayGoals),
          power_play_points: null,
          shorthanded_goals: null,
          game_winning_goals: null,
        });
      }
    }
  }
  return rows.sort((a, b) => a.player_id - b.player_id);
}

function goalieStatsFromBoxscore(gamePk, boxscore, rosterIds) {
  const rows = new Map();
  for (const [side, team] of [
    ["awayTeam", boxscore.awayTeam],
    ["homeTeam", boxscore.homeTeam],
  ]) {
    const teamTri = upper(team?.abbrev);
    for (const source of boxscore.playerByGameStats?.[side]?.goalies || []) {
      const playerId = integerOrNull(source.playerId);
      if (playerId === null || !rosterIds.has(playerId)) {
        throw new Error("NHL goalie is missing from the official roster");
      }
      if (rows.has(playerId)) {
        throw new Error("NHL boxscore contains a duplicate goalie");
      }
      const parsedSaveShots = parseSaveShotsAgainst(source.saveShotsAgainst);
      const saves = nonNegativeIntegerOrNull(source.saves, "goalie saves") ?? parsedSaveShots?.saves ?? null;
      const shotsAgainst =
        nonNegativeIntegerOrNull(source.shotsAgainst, "goalie shots against") ?? parsedSaveShots?.shots_against ?? null;
      const savePct = numberOrNull(source.savePctg);
      if (savePct !== null && (savePct < 0 || savePct > 1)) {
        throw new Error("NHL goalie save percentage is outside 0..1");
      }
      rows.set(playerId, {
        game_pk: gamePk,
        player_id: playerId,
        team_tri: teamTri,
        is_starter: typeof source.starter === "boolean" ? Number(source.starter) : null,
        decision: textOrNull(source.decision),
        saves,
        shots_against: shotsAgainst,
        goals_against: nonNegativeIntegerOrNull(source.goalsAgainst, "goalie goals against"),
        save_pct: savePct,
        toi_seconds: toiSeconds(source.toi),
        even_strength_goals_against: nonNegativeIntegerOrNull(
          source.evenStrengthGoalsAgainst,
          "goalie even-strength goals against",
        ),
        power_play_goals_against: nonNegativeIntegerOrNull(
          source.powerPlayGoalsAgainst,
          "goalie power-play goals against",
        ),
        shorthanded_goals_against: nonNegativeIntegerOrNull(
          source.shorthandedGoalsAgainst,
          "goalie shorthanded goals against",
        ),
      });
    }
  }
  return [...rows.values()].sort((a, b) => a.player_id - b.player_id);
}

function parseSaveShotsAgainst(value) {
  if (typeof value !== "string") {
    return null;
  }
  const match = /^(\d+)\/(\d+)$/.exec(value.trim());
  if (!match) {
    return null;
  }
  const saves = Number(match[1]);
  const shotsAgainst = Number(match[2]);
  if (saves > shotsAgainst) {
    throw new Error("NHL goalie saves exceed shots against");
  }
  return { saves, shots_against: shotsAgainst };
}

function teamStatsFromBoxscore(gamePk, boxscore, plays) {
  const faceoffs = (plays || []).filter((play) => play.typeDescKey === "faceoff");
  const winsByTeamId = new Map();
  for (const play of faceoffs) {
    const teamId = integerOrNull(play.details?.eventOwnerTeamId);
    if (teamId !== null) {
      winsByTeamId.set(teamId, (winsByTeamId.get(teamId) || 0) + 1);
    }
  }

  return [
    ["awayTeam", boxscore.awayTeam, 0],
    ["homeTeam", boxscore.homeTeam, 1],
  ].map(([side, team, isHome]) => {
    const playerRows = ["forwards", "defense", "goalies"].flatMap(
      (group) => boxscore.playerByGameStats?.[side]?.[group] || [],
    );
    const faceoffPct = faceoffs.length
      ? (winsByTeamId.get(requiredInteger(team.id, "team ID")) || 0) / faceoffs.length
      : null;
    return {
      game_pk: gamePk,
      team_tri: upper(team.abbrev),
      is_home: isHome,
      goals: requiredInteger(team.score, "team score"),
      shots: integerOrNull(team.sog),
      shot_attempts: null,
      blocked_shots: sumAvailable(playerRows, "blockedShots"),
      hits: sumAvailable(playerRows, "hits"),
      pim: sumAvailable(playerRows, "pim"),
      giveaways: sumAvailable(playerRows, "giveaways"),
      takeaways: sumAvailable(playerRows, "takeaways"),
      faceoff_pct: faceoffPct,
      power_play_goals: sumAvailable(playerRows, "powerPlayGoals"),
      power_play_opportunities: null,
      shorthanded_goals: null,
    };
  });
}

async function existingGameRecordCounts(db, gamePk, teamCodes, playerIds) {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM teams WHERE tri_code IN (SELECT value FROM json_each(?))) AS teams,
         (SELECT COUNT(*) FROM players WHERE player_id IN (SELECT value FROM json_each(?))) AS players,
         (SELECT COUNT(*) FROM games WHERE game_pk = ?) AS games,
         (SELECT COUNT(*) FROM period_scores WHERE game_pk = ?) AS period_scores,
         (SELECT COUNT(*) FROM game_events WHERE game_pk = ?) AS events,
         (SELECT COUNT(*) FROM event_players WHERE event_key LIKE ?) AS event_players,
         (SELECT COUNT(*) FROM team_game_stats WHERE game_pk = ?) AS team_game_stats,
         (SELECT COUNT(*) FROM player_game_stats WHERE game_pk = ?) AS player_game_stats,
         (SELECT COUNT(*) FROM goalie_game_stats WHERE game_pk = ?) AS goalie_game_stats;`,
    )
    .bind(
      JSON.stringify(teamCodes),
      JSON.stringify(playerIds),
      gamePk,
      gamePk,
      gamePk,
      `${gamePk}:%`,
      gamePk,
      gamePk,
      gamePk,
    )
    .first();
  if (!row) {
    throw new Error("Could not read existing game record counts");
  }
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));
}

function insertedAndUpdatedCounts(records, existing) {
  let inserted = 0;
  let updated = 0;
  for (const [key, count] of Object.entries(records)) {
    const existingCount = Math.min(Number(existing[key] || 0), count);
    inserted += Math.max(0, count - existingCount);
    updated += existingCount;
  }
  return { inserted, updated };
}

function jsonStatement(db, sql, rows) {
  return db.prepare(sql).bind(JSON.stringify(rows));
}

function staleStatement(db, sql, gameScope, rows) {
  return db.prepare(sql).bind(gameScope, JSON.stringify(rows));
}

function statementChanges(result) {
  return Number(result?.meta?.changes ?? result?.changes ?? 0);
}

async function startSyncRun(db, syncType, scopeKey, metadata) {
  const row = await db
    .prepare(
      `INSERT INTO sync_runs (sync_type, scope_key, status, metadata_json)
       VALUES (?, ?, 'running', ?)
       RETURNING sync_id;`,
    )
    .bind(syncType, scopeKey, JSON.stringify(metadata))
    .first();
  if (!row?.sync_id) {
    throw new Error("Could not create sync audit row");
  }
  return Number(row.sync_id);
}

async function finishSyncRun(db, syncId, result) {
  await db
    .prepare(
      `UPDATE sync_runs
       SET finished_at = CURRENT_TIMESTAMP,
           status = ?,
           inserted_count = ?,
           updated_count = ?,
           error_count = ?,
           error_text = ?,
           metadata_json = ?
       WHERE sync_id = ?;`,
    )
    .bind(
      result.status,
      Number(result.inserted || 0),
      Number(result.updated || 0),
      result.status === "error" ? 1 : 0,
      result.error_text || null,
      JSON.stringify(result.metadata || {}),
      syncId,
    )
    .run();
}

async function recordSyncError(db, syncId, error, metadata) {
  try {
    await finishSyncRun(db, syncId, {
      status: "error",
      inserted: 0,
      updated: 0,
      error_text: safeError(error),
      metadata,
    });
  } catch {
    // Preserve the original importer error when audit finalization also fails.
  }
}

function localized(value) {
  if (typeof value === "string") {
    return value.trim();
  }
  return typeof value?.default === "string" ? value.default.trim() : "";
}

function textOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function upper(value) {
  return String(value || "").trim().toUpperCase();
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function integerOrNull(value) {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function requiredInteger(value, label) {
  const parsed = integerOrNull(value);
  if (parsed === null) {
    throw new Error(`NHL payload is missing ${label}`);
  }
  return parsed;
}

function nonNegativeIntegerOrNull(value, label) {
  const parsed = integerOrNull(value);
  if (parsed !== null && parsed < 0) {
    throw new Error(`NHL payload has a negative ${label}`);
  }
  return parsed;
}

function requiredNonNegativeInteger(value, label) {
  const parsed = requiredInteger(value, label);
  if (parsed < 0) {
    throw new Error(`NHL payload has a negative ${label}`);
  }
  return parsed;
}

function toiSeconds(value) {
  if (typeof value !== "string" || !/^\d+:\d{2}$/.test(value)) {
    return null;
  }
  const [minutes, seconds] = value.split(":").map(Number);
  if (seconds > 59) {
    return null;
  }
  return minutes * 60 + seconds;
}

function sumAvailable(rows, key) {
  const values = rows.map((row) => numberOrNull(row[key])).filter((value) => value !== null);
  return values.length ? values.reduce((total, value) => total + value, 0) : null;
}

function safeError(error) {
  return String(error?.message || "import_failed").replace(/[\r\n]+/g, " ").slice(0, 500);
}

function retryDelayMs(response, attempt) {
  const backoff = Math.min(NHL_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), NHL_RETRY_MAX_DELAY_MS);
  const retryAfter = parseRetryAfterMs(response?.headers?.get("Retry-After"));
  return Math.min(Math.max(backoff, retryAfter ?? 0), NHL_RETRY_MAX_DELAY_MS);
}

function parseRetryAfterMs(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1_000;
  }
  const retryAt = Date.parse(trimmed);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : null;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
