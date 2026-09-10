const FEATURE_VERSION = 1;

const UPSERT_GAME_FEATURES_SQL = `
WITH
target AS (
  SELECT * FROM games WHERE game_pk = ? AND game_type IN (2,3)
),
period_agg AS (
  SELECT
    ps.game_pk,
    SUM(CASE WHEN ps.period_number = 1 THEN ps.home_goals ELSE 0 END) AS p1_home,
    SUM(CASE WHEN ps.period_number = 1 THEN ps.away_goals ELSE 0 END) AS p1_away,
    SUM(CASE WHEN ps.period_number = 2 THEN ps.home_goals ELSE 0 END) AS p2_home,
    SUM(CASE WHEN ps.period_number = 2 THEN ps.away_goals ELSE 0 END) AS p2_away,
    SUM(CASE WHEN ps.period_number = 3 THEN ps.home_goals ELSE 0 END) AS p3_home,
    SUM(CASE WHEN ps.period_number = 3 THEN ps.away_goals ELSE 0 END) AS p3_away,
    MAX(CASE WHEN ps.period_type = 'OT' OR ps.period_number > 3 THEN 1 ELSE 0 END) AS went_ot,
    MAX(CASE WHEN ps.period_type = 'SO' THEN 1 ELSE 0 END) AS went_so
  FROM period_scores ps
  JOIN target t ON t.game_pk = ps.game_pk
  GROUP BY ps.game_pk
),
first_goal AS (
  SELECT game_pk, team_tri
  FROM (
    SELECT ge.game_pk, ge.team_tri,
           ROW_NUMBER() OVER (PARTITION BY ge.game_pk ORDER BY ge.sort_order) AS rn
    FROM game_events ge
    JOIN target t ON t.game_pk = ge.game_pk
    WHERE ge.event_type = 'goal' AND ge.team_tri IS NOT NULL
  ) ranked
  WHERE rn = 1
),
event_agg AS (
  SELECT
    t.game_pk,
    SUM(CASE WHEN ge.event_type IN ('goal','shot-on-goal','missed-shot') AND ge.team_tri = t.home_tri THEN 1
             WHEN ge.event_type = 'blocked-shot' AND ge.team_tri = t.away_tri THEN 1 ELSE 0 END) AS home_corsi,
    SUM(CASE WHEN ge.event_type IN ('goal','shot-on-goal','missed-shot') AND ge.team_tri = t.away_tri THEN 1
             WHEN ge.event_type = 'blocked-shot' AND ge.team_tri = t.home_tri THEN 1 ELSE 0 END) AS away_corsi,
    SUM(CASE WHEN ge.event_type IN ('goal','shot-on-goal','missed-shot') AND ge.team_tri = t.home_tri THEN 1 ELSE 0 END) AS home_fenwick,
    SUM(CASE WHEN ge.event_type IN ('goal','shot-on-goal','missed-shot') AND ge.team_tri = t.away_tri THEN 1 ELSE 0 END) AS away_fenwick,
    SUM(CASE WHEN ge.period_number = 1 AND ge.event_type IN ('goal','shot-on-goal') AND ge.team_tri = t.home_tri THEN 1 ELSE 0 END) AS p1_home_shots,
    SUM(CASE WHEN ge.period_number = 1 AND ge.event_type IN ('goal','shot-on-goal') AND ge.team_tri = t.away_tri THEN 1 ELSE 0 END) AS p1_away_shots,
    SUM(CASE WHEN ge.period_number = 2 AND ge.event_type IN ('goal','shot-on-goal') AND ge.team_tri = t.home_tri THEN 1 ELSE 0 END) AS p2_home_shots,
    SUM(CASE WHEN ge.period_number = 2 AND ge.event_type IN ('goal','shot-on-goal') AND ge.team_tri = t.away_tri THEN 1 ELSE 0 END) AS p2_away_shots,
    SUM(CASE WHEN ge.period_number = 3 AND ge.event_type IN ('goal','shot-on-goal') AND ge.team_tri = t.home_tri THEN 1 ELSE 0 END) AS p3_home_shots,
    SUM(CASE WHEN ge.period_number = 3 AND ge.event_type IN ('goal','shot-on-goal') AND ge.team_tri = t.away_tri THEN 1 ELSE 0 END) AS p3_away_shots
  FROM target t
  LEFT JOIN game_events ge ON ge.game_pk = t.game_pk
  GROUP BY t.game_pk
),
base AS (
  SELECT
    t.game_pk, t.home_tri AS team_tri, t.away_tri AS opponent_tri,
    t.season_id, t.game_type, t.scheduled_start_utc, 1 AS is_home,
    t.home_score AS final_goals_for, t.away_score AS final_goals_against,
    COALESCE(p.p1_home,0) AS p1_gf, COALESCE(p.p1_away,0) AS p1_ga,
    COALESCE(p.p2_home,0) AS p2_gf, COALESCE(p.p2_away,0) AS p2_ga,
    COALESCE(p.p3_home,0) AS p3_gf, COALESCE(p.p3_away,0) AS p3_ga,
    COALESCE(p.went_ot,0) AS went_ot, COALESCE(p.went_so,0) AS went_so,
    CASE WHEN fg.team_tri IS NULL THEN NULL WHEN fg.team_tri = t.home_tri THEN 1 ELSE 0 END AS first_goal_for,
    hs.shots AS shots_for, aws.shots AS shots_against,
    e.home_corsi AS corsi_for, e.away_corsi AS corsi_against,
    e.home_fenwick AS fenwick_for, e.away_fenwick AS fenwick_against,
    e.p1_home_shots AS p1_shots_for, e.p1_away_shots AS p1_shots_against,
    e.p2_home_shots AS p2_shots_for, e.p2_away_shots AS p2_shots_against,
    e.p3_home_shots AS p3_shots_for, e.p3_away_shots AS p3_shots_against,
    hs.power_play_goals AS power_play_goals_for, aws.power_play_goals AS power_play_goals_against,
    hs.hits AS hits_for, aws.hits AS hits_against, hs.pim AS pim_for, aws.pim AS pim_against
  FROM target t
  LEFT JOIN period_agg p ON p.game_pk = t.game_pk
  LEFT JOIN first_goal fg ON fg.game_pk = t.game_pk
  LEFT JOIN event_agg e ON e.game_pk = t.game_pk
  LEFT JOIN team_game_stats hs ON hs.game_pk = t.game_pk AND hs.team_tri = t.home_tri
  LEFT JOIN team_game_stats aws ON aws.game_pk = t.game_pk AND aws.team_tri = t.away_tri

  UNION ALL

  SELECT
    t.game_pk, t.away_tri AS team_tri, t.home_tri AS opponent_tri,
    t.season_id, t.game_type, t.scheduled_start_utc, 0 AS is_home,
    t.away_score AS final_goals_for, t.home_score AS final_goals_against,
    COALESCE(p.p1_away,0) AS p1_gf, COALESCE(p.p1_home,0) AS p1_ga,
    COALESCE(p.p2_away,0) AS p2_gf, COALESCE(p.p2_home,0) AS p2_ga,
    COALESCE(p.p3_away,0) AS p3_gf, COALESCE(p.p3_home,0) AS p3_ga,
    COALESCE(p.went_ot,0) AS went_ot, COALESCE(p.went_so,0) AS went_so,
    CASE WHEN fg.team_tri IS NULL THEN NULL WHEN fg.team_tri = t.away_tri THEN 1 ELSE 0 END AS first_goal_for,
    aws.shots AS shots_for, hs.shots AS shots_against,
    e.away_corsi AS corsi_for, e.home_corsi AS corsi_against,
    e.away_fenwick AS fenwick_for, e.home_fenwick AS fenwick_against,
    e.p1_away_shots AS p1_shots_for, e.p1_home_shots AS p1_shots_against,
    e.p2_away_shots AS p2_shots_for, e.p2_home_shots AS p2_shots_against,
    e.p3_away_shots AS p3_shots_for, e.p3_home_shots AS p3_shots_against,
    aws.power_play_goals AS power_play_goals_for, hs.power_play_goals AS power_play_goals_against,
    aws.hits AS hits_for, hs.hits AS hits_against, aws.pim AS pim_for, hs.pim AS pim_against
  FROM target t
  LEFT JOIN period_agg p ON p.game_pk = t.game_pk
  LEFT JOIN first_goal fg ON fg.game_pk = t.game_pk
  LEFT JOIN event_agg e ON e.game_pk = t.game_pk
  LEFT JOIN team_game_stats hs ON hs.game_pk = t.game_pk AND hs.team_tri = t.home_tri
  LEFT JOIN team_game_stats aws ON aws.game_pk = t.game_pk AND aws.team_tri = t.away_tri
),
with_prev AS (
  SELECT b.*,
         (SELECT MAX(g2.scheduled_start_utc)
          FROM games g2
          WHERE g2.game_type IN (2,3)
            AND g2.scheduled_start_utc < b.scheduled_start_utc
            AND (g2.home_tri = b.team_tri OR g2.away_tri = b.team_tri)) AS previous_game_utc
  FROM base b
)
INSERT INTO team_game_features (
  game_pk, team_tri, opponent_tri, season_id, game_type, scheduled_start_utc, is_home,
  final_goals_for, final_goals_against, total_goals, final_goal_diff, final_win,
  regulation_goals_for, regulation_goals_against, regulation_goal_diff, regulation_result,
  went_ot, went_so,
  p1_goals_for, p1_goals_against, p2_goals_for, p2_goals_against, p3_goals_for, p3_goals_against,
  score_after_p1_diff, score_after_p2_diff, first_goal_for,
  shots_for, shots_against, shot_share_pct,
  corsi_for, corsi_against, corsi_for_pct, fenwick_for, fenwick_against, fenwick_for_pct,
  p1_shots_for, p1_shots_against, p2_shots_for, p2_shots_against, p3_shots_for, p3_shots_against,
  power_play_goals_for, power_play_goals_against, hits_for, hits_against, pim_for, pim_against,
  previous_game_utc, rest_days, is_back_to_back, feature_version, updated_at
)
SELECT
  game_pk, team_tri, opponent_tri, season_id, game_type, scheduled_start_utc, is_home,
  final_goals_for, final_goals_against,
  final_goals_for + final_goals_against,
  final_goals_for - final_goals_against,
  CASE WHEN final_goals_for > final_goals_against THEN 1 ELSE 0 END,
  p1_gf + p2_gf + p3_gf,
  p1_ga + p2_ga + p3_ga,
  (p1_gf + p2_gf + p3_gf) - (p1_ga + p2_ga + p3_ga),
  CASE WHEN (p1_gf+p2_gf+p3_gf) > (p1_ga+p2_ga+p3_ga) THEN 'W'
       WHEN (p1_gf+p2_gf+p3_gf) < (p1_ga+p2_ga+p3_ga) THEN 'L' ELSE 'T' END,
  went_ot, went_so,
  p1_gf, p1_ga, p2_gf, p2_ga, p3_gf, p3_ga,
  p1_gf-p1_ga, (p1_gf+p2_gf)-(p1_ga+p2_ga), first_goal_for,
  shots_for, shots_against,
  CASE WHEN COALESCE(shots_for,0)+COALESCE(shots_against,0)>0
       THEN 100.0*shots_for/(shots_for+shots_against) ELSE NULL END,
  corsi_for, corsi_against,
  CASE WHEN COALESCE(corsi_for,0)+COALESCE(corsi_against,0)>0
       THEN 100.0*corsi_for/(corsi_for+corsi_against) ELSE NULL END,
  fenwick_for, fenwick_against,
  CASE WHEN COALESCE(fenwick_for,0)+COALESCE(fenwick_against,0)>0
       THEN 100.0*fenwick_for/(fenwick_for+fenwick_against) ELSE NULL END,
  p1_shots_for, p1_shots_against, p2_shots_for, p2_shots_against, p3_shots_for, p3_shots_against,
  power_play_goals_for, power_play_goals_against, hits_for, hits_against, pim_for, pim_against,
  previous_game_utc,
  CASE WHEN previous_game_utc IS NULL THEN NULL
       ELSE MAX(0, CAST(julianday(date(scheduled_start_utc))-julianday(date(previous_game_utc))-1 AS INTEGER)) END,
  CASE WHEN previous_game_utc IS NOT NULL
            AND julianday(date(scheduled_start_utc))-julianday(date(previous_game_utc)) = 1
       THEN 1 ELSE 0 END,
  ${FEATURE_VERSION}, CURRENT_TIMESTAMP
FROM with_prev
WHERE true
ON CONFLICT(game_pk, team_tri) DO UPDATE SET
  opponent_tri=excluded.opponent_tri,
  season_id=excluded.season_id,
  game_type=excluded.game_type,
  scheduled_start_utc=excluded.scheduled_start_utc,
  is_home=excluded.is_home,
  final_goals_for=excluded.final_goals_for,
  final_goals_against=excluded.final_goals_against,
  total_goals=excluded.total_goals,
  final_goal_diff=excluded.final_goal_diff,
  final_win=excluded.final_win,
  regulation_goals_for=excluded.regulation_goals_for,
  regulation_goals_against=excluded.regulation_goals_against,
  regulation_goal_diff=excluded.regulation_goal_diff,
  regulation_result=excluded.regulation_result,
  went_ot=excluded.went_ot,
  went_so=excluded.went_so,
  p1_goals_for=excluded.p1_goals_for,
  p1_goals_against=excluded.p1_goals_against,
  p2_goals_for=excluded.p2_goals_for,
  p2_goals_against=excluded.p2_goals_against,
  p3_goals_for=excluded.p3_goals_for,
  p3_goals_against=excluded.p3_goals_against,
  score_after_p1_diff=excluded.score_after_p1_diff,
  score_after_p2_diff=excluded.score_after_p2_diff,
  first_goal_for=excluded.first_goal_for,
  shots_for=excluded.shots_for,
  shots_against=excluded.shots_against,
  shot_share_pct=excluded.shot_share_pct,
  corsi_for=excluded.corsi_for,
  corsi_against=excluded.corsi_against,
  corsi_for_pct=excluded.corsi_for_pct,
  fenwick_for=excluded.fenwick_for,
  fenwick_against=excluded.fenwick_against,
  fenwick_for_pct=excluded.fenwick_for_pct,
  p1_shots_for=excluded.p1_shots_for,
  p1_shots_against=excluded.p1_shots_against,
  p2_shots_for=excluded.p2_shots_for,
  p2_shots_against=excluded.p2_shots_against,
  p3_shots_for=excluded.p3_shots_for,
  p3_shots_against=excluded.p3_shots_against,
  power_play_goals_for=excluded.power_play_goals_for,
  power_play_goals_against=excluded.power_play_goals_against,
  hits_for=excluded.hits_for,
  hits_against=excluded.hits_against,
  pim_for=excluded.pim_for,
  pim_against=excluded.pim_against,
  previous_game_utc=excluded.previous_game_utc,
  rest_days=excluded.rest_days,
  is_back_to_back=excluded.is_back_to_back,
  feature_version=excluded.feature_version,
  updated_at=CURRENT_TIMESTAMP;
`;

export async function refreshTeamGameFeatures(db, gamePk) {
  if (!db) throw new Error("D1 binding is required");
  if (!Number.isSafeInteger(gamePk) || gamePk <= 0) throw new Error("game_pk must be a positive integer");

  const result = await db.prepare(UPSERT_GAME_FEATURES_SQL).bind(gamePk).run();
  return {
    ok: true,
    action: "refresh_team_game_features",
    game_pk: gamePk,
    rows_written: Number(result?.meta?.changes || 0),
    feature_version: FEATURE_VERSION,
  };
}

export async function getTeamFeatureCoverage(db) {
  const row = await db.prepare(`
    SELECT
      COUNT(*) AS rows,
      COUNT(DISTINCT game_pk) AS games,
      COUNT(DISTINCT team_tri) AS teams,
      MIN(scheduled_start_utc) AS first_game_utc,
      MAX(scheduled_start_utc) AS last_game_utc
    FROM team_game_features;
  `).first();
  return {
    rows: Number(row?.rows || 0),
    games: Number(row?.games || 0),
    teams: Number(row?.teams || 0),
    first_game_utc: row?.first_game_utc || null,
    last_game_utc: row?.last_game_utc || null,
    feature_version: FEATURE_VERSION,
  };
}
