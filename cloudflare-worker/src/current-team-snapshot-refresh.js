const SNAPSHOT_REFRESH_SQL=`
WITH
windows(window_games) AS (VALUES (5),(10),(20)),
base_ranked AS (
  SELECT f.*,
         ROW_NUMBER() OVER (
           PARTITION BY f.team_tri
           ORDER BY f.scheduled_start_utc DESC,f.game_pk DESC
         ) rn
  FROM team_game_features f
  WHERE f.game_type IN (2,3)
),
base_summary AS (
  SELECT b.team_tri,w.window_games,MAX(b.scheduled_start_utc) as_of_utc,COUNT(*) sample_size,
         AVG(b.final_goals_for) gf_pg,AVG(b.final_goals_against) ga_pg,
         AVG(b.final_goal_diff) goal_diff_pg,AVG(b.total_goals) total_pg,
         AVG(b.corsi_for_pct) corsi_pct,AVG(b.fenwick_for_pct) fenwick_pct,
         AVG(COALESCE(b.p2_goals_for,0)-COALESCE(b.p2_goals_against,0)) p2_diff_pg
  FROM base_ranked b JOIN windows w ON b.rn<=w.window_games
  GROUP BY b.team_tri,w.window_games
  HAVING COUNT(*)=w.window_games
),
base_scored AS (
  SELECT b.*,
         COUNT(*) OVER (PARTITION BY b.window_games) league_teams,
         ROW_NUMBER() OVER (PARTITION BY b.window_games ORDER BY b.gf_pg DESC,b.team_tri) rank_gf,
         ROW_NUMBER() OVER (PARTITION BY b.window_games ORDER BY b.ga_pg ASC,b.team_tri) rank_ga,
         ROW_NUMBER() OVER (PARTITION BY b.window_games ORDER BY b.goal_diff_pg DESC,b.team_tri) rank_goal_diff,
         ROW_NUMBER() OVER (PARTITION BY b.window_games ORDER BY b.total_pg DESC,b.team_tri) rank_total,
         ROW_NUMBER() OVER (PARTITION BY b.window_games ORDER BY b.corsi_pct DESC,b.team_tri) rank_corsi,
         ROW_NUMBER() OVER (PARTITION BY b.window_games ORDER BY b.fenwick_pct DESC,b.team_tri) rank_fenwick,
         ROW_NUMBER() OVER (PARTITION BY b.window_games ORDER BY b.p2_diff_pg DESC,b.team_tri) rank_p2_diff
  FROM base_summary b
),
advanced_ranked AS (
  SELECT a.*,g.scheduled_start_utc,
         ROW_NUMBER() OVER (
           PARTITION BY a.team_tri
           ORDER BY g.scheduled_start_utc DESC,a.game_pk DESC
         ) rn
  FROM team_game_advanced_features a
  JOIN games g ON g.game_pk=a.game_pk
  WHERE g.game_type IN (2,3)
),
advanced_summary AS (
  SELECT a.team_tri,w.window_games,COUNT(*) advanced_sample_size,
         AVG(a.xgf_pct_5v5) xgf_pct_5v5,
         60.0*SUM(CASE WHEN COALESCE(a.toi_5v5_minutes,0)>0 THEN COALESCE(a.xgf_5v5,0) ELSE 0 END)
           /NULLIF(SUM(CASE WHEN COALESCE(a.toi_5v5_minutes,0)>0 THEN a.toi_5v5_minutes ELSE 0 END),0) xgf60_5v5,
         60.0*SUM(CASE WHEN COALESCE(a.toi_5v5_minutes,0)>0 THEN COALESCE(a.xga_5v5,0) ELSE 0 END)
           /NULLIF(SUM(CASE WHEN COALESCE(a.toi_5v5_minutes,0)>0 THEN a.toi_5v5_minutes ELSE 0 END),0) xga60_5v5,
         AVG(a.corsi_for_pct_5v5) corsi_pct_5v5,
         AVG(a.fenwick_for_pct_5v5) fenwick_pct_5v5,
         CASE WHEN COUNT(a.pdo_5v5)*2>=w.window_games THEN AVG(a.pdo_5v5) END pdo_5v5,
         CASE WHEN COUNT(a.goals_saved_above_expected)*2>=w.window_games THEN AVG(a.goals_saved_above_expected) END gsax_5v5
  FROM advanced_ranked a JOIN windows w ON a.rn<=w.window_games
  GROUP BY a.team_tri,w.window_games
  HAVING COUNT(*)=w.window_games
     AND SUM(CASE WHEN COALESCE(a.toi_5v5_minutes,0)>0 THEN 1 ELSE 0 END)*5>=w.window_games*4
),
advanced_scored AS (
  SELECT a.*,
         COUNT(*) OVER (PARTITION BY a.window_games) advanced_league_teams,
         ROW_NUMBER() OVER (PARTITION BY a.window_games ORDER BY a.xgf_pct_5v5 DESC,a.team_tri) rank_xgf_pct_5v5,
         ROW_NUMBER() OVER (PARTITION BY a.window_games ORDER BY a.xgf60_5v5 DESC,a.team_tri) rank_xgf60_5v5,
         ROW_NUMBER() OVER (PARTITION BY a.window_games ORDER BY a.xga60_5v5 ASC,a.team_tri) rank_xga60_5v5,
         ROW_NUMBER() OVER (PARTITION BY a.window_games ORDER BY a.corsi_pct_5v5 DESC,a.team_tri) rank_corsi_pct_5v5,
         ROW_NUMBER() OVER (PARTITION BY a.window_games ORDER BY a.fenwick_pct_5v5 DESC,a.team_tri) rank_fenwick_pct_5v5
  FROM advanced_summary a
)
INSERT OR REPLACE INTO team_current_snapshots(
  team_tri,window_games,as_of_utc,sample_size,league_teams,
  gf_pg,ga_pg,goal_diff_pg,total_pg,corsi_pct,fenwick_pct,p2_diff_pg,
  rank_gf,rank_ga,rank_goal_diff,rank_total,rank_corsi,rank_fenwick,rank_p2_diff,
  advanced_sample_size,advanced_league_teams,xgf_pct_5v5,xgf60_5v5,xga60_5v5,
  corsi_pct_5v5,fenwick_pct_5v5,pdo_5v5,gsax_5v5,
  rank_xgf_pct_5v5,rank_xgf60_5v5,rank_xga60_5v5,rank_corsi_pct_5v5,rank_fenwick_pct_5v5,
  computed_at
)
SELECT
  b.team_tri,b.window_games,b.as_of_utc,b.sample_size,b.league_teams,
  b.gf_pg,b.ga_pg,b.goal_diff_pg,b.total_pg,b.corsi_pct,b.fenwick_pct,b.p2_diff_pg,
  b.rank_gf,b.rank_ga,b.rank_goal_diff,b.rank_total,b.rank_corsi,b.rank_fenwick,b.rank_p2_diff,
  COALESCE(a.advanced_sample_size,0),a.advanced_league_teams,a.xgf_pct_5v5,a.xgf60_5v5,a.xga60_5v5,
  a.corsi_pct_5v5,a.fenwick_pct_5v5,a.pdo_5v5,a.gsax_5v5,
  a.rank_xgf_pct_5v5,a.rank_xgf60_5v5,a.rank_xga60_5v5,a.rank_corsi_pct_5v5,a.rank_fenwick_pct_5v5,
  CURRENT_TIMESTAMP
FROM base_scored b
LEFT JOIN advanced_scored a ON a.team_tri=b.team_tri AND a.window_games=b.window_games;
`;

export async function refreshCurrentTeamSnapshotsRuntime(db){
  if(!db)return {ok:false,error:"missing_db"};
  await db.prepare(SNAPSHOT_REFRESH_SQL).run();
  const row=await db.prepare(`
    SELECT COUNT(*) rows,COUNT(DISTINCT team_tri) teams,MAX(computed_at) computed_at
    FROM team_current_snapshots;
  `).first();
  await db.batch([
    db.prepare(`
      INSERT INTO data_core_meta(meta_key,meta_value,updated_at)
      VALUES('compact.team_current_snapshots',?,CURRENT_TIMESTAMP)
      ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP;
    `).bind(String(Number(row?.rows||0))),
    db.prepare(`
      INSERT INTO data_core_meta(meta_key,meta_value,updated_at)
      VALUES('build.current_created_at',?,CURRENT_TIMESTAMP)
      ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP;
    `).bind(new Date().toISOString()),
  ]);
  return {ok:true,rows:Number(row?.rows||0),teams:Number(row?.teams||0),computed_at:row?.computed_at||null};
}
