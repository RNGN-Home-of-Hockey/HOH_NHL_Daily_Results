DELETE FROM team_h2h_snapshots
WHERE scope_key IN ('2Y_ALL','S_20242025','S_20252026','2Y_HOME','2Y_AWAY','2Y_REG','2Y_PO');

INSERT INTO team_h2h_snapshots (
  team_tri, opponent_tri, scope_key, games, wins, losses,
  goals_for, goals_against, goals_for_pg, goals_against_pg, total_goals_pg,
  shots_for, shots_against, shot_share_pct,
  corsi_for, corsi_against, corsi_for_pct,
  fenwick_for, fenwick_against, fenwick_for_pct,
  power_play_goals_for, power_play_goals_against,
  hits_for, hits_against, pim_for, pim_against,
  first_goal_pct, p1_goal_diff_pg, p2_goal_diff_pg, p3_goal_diff_pg,
  ot_games, so_games, last_game_utc, evidence_game_pks_json, computed_at
)
SELECT
  team_tri,
  opponent_tri,
  '2Y_ALL',
  COUNT(*),
  SUM(final_win),
  COUNT(*)-SUM(final_win),
  SUM(final_goals_for),
  SUM(final_goals_against),
  1.0*SUM(final_goals_for)/COUNT(*),
  1.0*SUM(final_goals_against)/COUNT(*),
  1.0*SUM(total_goals)/COUNT(*),
  SUM(shots_for),
  SUM(shots_against),
  CASE WHEN SUM(COALESCE(shots_for,0))+SUM(COALESCE(shots_against,0))>0
    THEN 100.0*SUM(COALESCE(shots_for,0))/(SUM(COALESCE(shots_for,0))+SUM(COALESCE(shots_against,0)))
    ELSE NULL END,
  SUM(corsi_for),
  SUM(corsi_against),
  CASE WHEN SUM(COALESCE(corsi_for,0))+SUM(COALESCE(corsi_against,0))>0
    THEN 100.0*SUM(COALESCE(corsi_for,0))/(SUM(COALESCE(corsi_for,0))+SUM(COALESCE(corsi_against,0)))
    ELSE NULL END,
  SUM(fenwick_for),
  SUM(fenwick_against),
  CASE WHEN SUM(COALESCE(fenwick_for,0))+SUM(COALESCE(fenwick_against,0))>0
    THEN 100.0*SUM(COALESCE(fenwick_for,0))/(SUM(COALESCE(fenwick_for,0))+SUM(COALESCE(fenwick_against,0)))
    ELSE NULL END,
  SUM(power_play_goals_for),
  SUM(power_play_goals_against),
  SUM(hits_for),
  SUM(hits_against),
  SUM(pim_for),
  SUM(pim_against),
  CASE WHEN COUNT(first_goal_for)>0 THEN 100.0*SUM(COALESCE(first_goal_for,0))/COUNT(first_goal_for) ELSE NULL END,
  1.0*SUM(p1_goals_for-p1_goals_against)/COUNT(*),
  1.0*SUM(p2_goals_for-p2_goals_against)/COUNT(*),
  1.0*SUM(p3_goals_for-p3_goals_against)/COUNT(*),
  SUM(went_ot),
  SUM(went_so),
  MAX(scheduled_start_utc),
  '['||GROUP_CONCAT(game_pk)||']',
  CURRENT_TIMESTAMP
FROM team_game_features
WHERE season_id IN ('20242025','20252026') AND game_type IN (2,3)
GROUP BY team_tri,opponent_tri
ON CONFLICT(team_tri,opponent_tri,scope_key) DO UPDATE SET
  games=excluded.games,wins=excluded.wins,losses=excluded.losses,
  goals_for=excluded.goals_for,goals_against=excluded.goals_against,
  goals_for_pg=excluded.goals_for_pg,goals_against_pg=excluded.goals_against_pg,total_goals_pg=excluded.total_goals_pg,
  shots_for=excluded.shots_for,shots_against=excluded.shots_against,shot_share_pct=excluded.shot_share_pct,
  corsi_for=excluded.corsi_for,corsi_against=excluded.corsi_against,corsi_for_pct=excluded.corsi_for_pct,
  fenwick_for=excluded.fenwick_for,fenwick_against=excluded.fenwick_against,fenwick_for_pct=excluded.fenwick_for_pct,
  power_play_goals_for=excluded.power_play_goals_for,power_play_goals_against=excluded.power_play_goals_against,
  hits_for=excluded.hits_for,hits_against=excluded.hits_against,pim_for=excluded.pim_for,pim_against=excluded.pim_against,
  first_goal_pct=excluded.first_goal_pct,p1_goal_diff_pg=excluded.p1_goal_diff_pg,
  p2_goal_diff_pg=excluded.p2_goal_diff_pg,p3_goal_diff_pg=excluded.p3_goal_diff_pg,
  ot_games=excluded.ot_games,so_games=excluded.so_games,last_game_utc=excluded.last_game_utc,
  evidence_game_pks_json=excluded.evidence_game_pks_json,computed_at=CURRENT_TIMESTAMP;

INSERT INTO team_h2h_snapshots (
  team_tri, opponent_tri, scope_key, games, wins, losses,
  goals_for, goals_against, goals_for_pg, goals_against_pg, total_goals_pg,
  shots_for, shots_against, shot_share_pct,
  corsi_for, corsi_against, corsi_for_pct,
  fenwick_for, fenwick_against, fenwick_for_pct,
  power_play_goals_for, power_play_goals_against,
  hits_for, hits_against, pim_for, pim_against,
  first_goal_pct, p1_goal_diff_pg, p2_goal_diff_pg, p3_goal_diff_pg,
  ot_games, so_games, last_game_utc, evidence_game_pks_json, computed_at
)
SELECT
  team_tri,
  opponent_tri,
  'S_20242025',
  COUNT(*),
  SUM(final_win),
  COUNT(*)-SUM(final_win),
  SUM(final_goals_for),
  SUM(final_goals_against),
  1.0*SUM(final_goals_for)/COUNT(*),
  1.0*SUM(final_goals_against)/COUNT(*),
  1.0*SUM(total_goals)/COUNT(*),
  SUM(shots_for),
  SUM(shots_against),
  CASE WHEN SUM(COALESCE(shots_for,0))+SUM(COALESCE(shots_against,0))>0
    THEN 100.0*SUM(COALESCE(shots_for,0))/(SUM(COALESCE(shots_for,0))+SUM(COALESCE(shots_against,0)))
    ELSE NULL END,
  SUM(corsi_for),
  SUM(corsi_against),
  CASE WHEN SUM(COALESCE(corsi_for,0))+SUM(COALESCE(corsi_against,0))>0
    THEN 100.0*SUM(COALESCE(corsi_for,0))/(SUM(COALESCE(corsi_for,0))+SUM(COALESCE(corsi_against,0)))
    ELSE NULL END,
  SUM(fenwick_for),
  SUM(fenwick_against),
  CASE WHEN SUM(COALESCE(fenwick_for,0))+SUM(COALESCE(fenwick_against,0))>0
    THEN 100.0*SUM(COALESCE(fenwick_for,0))/(SUM(COALESCE(fenwick_for,0))+SUM(COALESCE(fenwick_against,0)))
    ELSE NULL END,
  SUM(power_play_goals_for),
  SUM(power_play_goals_against),
  SUM(hits_for),
  SUM(hits_against),
  SUM(pim_for),
  SUM(pim_against),
  CASE WHEN COUNT(first_goal_for)>0 THEN 100.0*SUM(COALESCE(first_goal_for,0))/COUNT(first_goal_for) ELSE NULL END,
  1.0*SUM(p1_goals_for-p1_goals_against)/COUNT(*),
  1.0*SUM(p2_goals_for-p2_goals_against)/COUNT(*),
  1.0*SUM(p3_goals_for-p3_goals_against)/COUNT(*),
  SUM(went_ot),
  SUM(went_so),
  MAX(scheduled_start_utc),
  '['||GROUP_CONCAT(game_pk)||']',
  CURRENT_TIMESTAMP
FROM team_game_features
WHERE season_id='20242025' AND game_type IN (2,3)
GROUP BY team_tri,opponent_tri
ON CONFLICT(team_tri,opponent_tri,scope_key) DO UPDATE SET
  games=excluded.games,wins=excluded.wins,losses=excluded.losses,
  goals_for=excluded.goals_for,goals_against=excluded.goals_against,
  goals_for_pg=excluded.goals_for_pg,goals_against_pg=excluded.goals_against_pg,total_goals_pg=excluded.total_goals_pg,
  shots_for=excluded.shots_for,shots_against=excluded.shots_against,shot_share_pct=excluded.shot_share_pct,
  corsi_for=excluded.corsi_for,corsi_against=excluded.corsi_against,corsi_for_pct=excluded.corsi_for_pct,
  fenwick_for=excluded.fenwick_for,fenwick_against=excluded.fenwick_against,fenwick_for_pct=excluded.fenwick_for_pct,
  power_play_goals_for=excluded.power_play_goals_for,power_play_goals_against=excluded.power_play_goals_against,
  hits_for=excluded.hits_for,hits_against=excluded.hits_against,pim_for=excluded.pim_for,pim_against=excluded.pim_against,
  first_goal_pct=excluded.first_goal_pct,p1_goal_diff_pg=excluded.p1_goal_diff_pg,
  p2_goal_diff_pg=excluded.p2_goal_diff_pg,p3_goal_diff_pg=excluded.p3_goal_diff_pg,
  ot_games=excluded.ot_games,so_games=excluded.so_games,last_game_utc=excluded.last_game_utc,
  evidence_game_pks_json=excluded.evidence_game_pks_json,computed_at=CURRENT_TIMESTAMP;

INSERT INTO team_h2h_snapshots (
  team_tri, opponent_tri, scope_key, games, wins, losses,
  goals_for, goals_against, goals_for_pg, goals_against_pg, total_goals_pg,
  shots_for, shots_against, shot_share_pct,
  corsi_for, corsi_against, corsi_for_pct,
  fenwick_for, fenwick_against, fenwick_for_pct,
  power_play_goals_for, power_play_goals_against,
  hits_for, hits_against, pim_for, pim_against,
  first_goal_pct, p1_goal_diff_pg, p2_goal_diff_pg, p3_goal_diff_pg,
  ot_games, so_games, last_game_utc, evidence_game_pks_json, computed_at
)
SELECT
  team_tri,
  opponent_tri,
  'S_20252026',
  COUNT(*),
  SUM(final_win),
  COUNT(*)-SUM(final_win),
  SUM(final_goals_for),
  SUM(final_goals_against),
  1.0*SUM(final_goals_for)/COUNT(*),
  1.0*SUM(final_goals_against)/COUNT(*),
  1.0*SUM(total_goals)/COUNT(*),
  SUM(shots_for),
  SUM(shots_against),
  CASE WHEN SUM(COALESCE(shots_for,0))+SUM(COALESCE(shots_against,0))>0
    THEN 100.0*SUM(COALESCE(shots_for,0))/(SUM(COALESCE(shots_for,0))+SUM(COALESCE(shots_against,0)))
    ELSE NULL END,
  SUM(corsi_for),
  SUM(corsi_against),
  CASE WHEN SUM(COALESCE(corsi_for,0))+SUM(COALESCE(corsi_against,0))>0
    THEN 100.0*SUM(COALESCE(corsi_for,0))/(SUM(COALESCE(corsi_for,0))+SUM(COALESCE(corsi_against,0)))
    ELSE NULL END,
  SUM(fenwick_for),
  SUM(fenwick_against),
  CASE WHEN SUM(COALESCE(fenwick_for,0))+SUM(COALESCE(fenwick_against,0))>0
    THEN 100.0*SUM(COALESCE(fenwick_for,0))/(SUM(COALESCE(fenwick_for,0))+SUM(COALESCE(fenwick_against,0)))
    ELSE NULL END,
  SUM(power_play_goals_for),
  SUM(power_play_goals_against),
  SUM(hits_for),
  SUM(hits_against),
  SUM(pim_for),
  SUM(pim_against),
  CASE WHEN COUNT(first_goal_for)>0 THEN 100.0*SUM(COALESCE(first_goal_for,0))/COUNT(first_goal_for) ELSE NULL END,
  1.0*SUM(p1_goals_for-p1_goals_against)/COUNT(*),
  1.0*SUM(p2_goals_for-p2_goals_against)/COUNT(*),
  1.0*SUM(p3_goals_for-p3_goals_against)/COUNT(*),
  SUM(went_ot),
  SUM(went_so),
  MAX(scheduled_start_utc),
  '['||GROUP_CONCAT(game_pk)||']',
  CURRENT_TIMESTAMP
FROM team_game_features
WHERE season_id='20252026' AND game_type IN (2,3)
GROUP BY team_tri,opponent_tri
ON CONFLICT(team_tri,opponent_tri,scope_key) DO UPDATE SET
  games=excluded.games,wins=excluded.wins,losses=excluded.losses,
  goals_for=excluded.goals_for,goals_against=excluded.goals_against,
  goals_for_pg=excluded.goals_for_pg,goals_against_pg=excluded.goals_against_pg,total_goals_pg=excluded.total_goals_pg,
  shots_for=excluded.shots_for,shots_against=excluded.shots_against,shot_share_pct=excluded.shot_share_pct,
  corsi_for=excluded.corsi_for,corsi_against=excluded.corsi_against,corsi_for_pct=excluded.corsi_for_pct,
  fenwick_for=excluded.fenwick_for,fenwick_against=excluded.fenwick_against,fenwick_for_pct=excluded.fenwick_for_pct,
  power_play_goals_for=excluded.power_play_goals_for,power_play_goals_against=excluded.power_play_goals_against,
  hits_for=excluded.hits_for,hits_against=excluded.hits_against,pim_for=excluded.pim_for,pim_against=excluded.pim_against,
  first_goal_pct=excluded.first_goal_pct,p1_goal_diff_pg=excluded.p1_goal_diff_pg,
  p2_goal_diff_pg=excluded.p2_goal_diff_pg,p3_goal_diff_pg=excluded.p3_goal_diff_pg,
  ot_games=excluded.ot_games,so_games=excluded.so_games,last_game_utc=excluded.last_game_utc,
  evidence_game_pks_json=excluded.evidence_game_pks_json,computed_at=CURRENT_TIMESTAMP;

INSERT INTO team_h2h_snapshots (
  team_tri, opponent_tri, scope_key, games, wins, losses,
  goals_for, goals_against, goals_for_pg, goals_against_pg, total_goals_pg,
  shots_for, shots_against, shot_share_pct,
  corsi_for, corsi_against, corsi_for_pct,
  fenwick_for, fenwick_against, fenwick_for_pct,
  power_play_goals_for, power_play_goals_against,
  hits_for, hits_against, pim_for, pim_against,
  first_goal_pct, p1_goal_diff_pg, p2_goal_diff_pg, p3_goal_diff_pg,
  ot_games, so_games, last_game_utc, evidence_game_pks_json, computed_at
)
SELECT
  team_tri,
  opponent_tri,
  '2Y_HOME',
  COUNT(*),
  SUM(final_win),
  COUNT(*)-SUM(final_win),
  SUM(final_goals_for),
  SUM(final_goals_against),
  1.0*SUM(final_goals_for)/COUNT(*),
  1.0*SUM(final_goals_against)/COUNT(*),
  1.0*SUM(total_goals)/COUNT(*),
  SUM(shots_for),
  SUM(shots_against),
  CASE WHEN SUM(COALESCE(shots_for,0))+SUM(COALESCE(shots_against,0))>0
    THEN 100.0*SUM(COALESCE(shots_for,0))/(SUM(COALESCE(shots_for,0))+SUM(COALESCE(shots_against,0)))
    ELSE NULL END,
  SUM(corsi_for),
  SUM(corsi_against),
  CASE WHEN SUM(COALESCE(corsi_for,0))+SUM(COALESCE(corsi_against,0))>0
    THEN 100.0*SUM(COALESCE(corsi_for,0))/(SUM(COALESCE(corsi_for,0))+SUM(COALESCE(corsi_against,0)))
    ELSE NULL END,
  SUM(fenwick_for),
  SUM(fenwick_against),
  CASE WHEN SUM(COALESCE(fenwick_for,0))+SUM(COALESCE(fenwick_against,0))>0
    THEN 100.0*SUM(COALESCE(fenwick_for,0))/(SUM(COALESCE(fenwick_for,0))+SUM(COALESCE(fenwick_against,0)))
    ELSE NULL END,
  SUM(power_play_goals_for),
  SUM(power_play_goals_against),
  SUM(hits_for),
  SUM(hits_against),
  SUM(pim_for),
  SUM(pim_against),
  CASE WHEN COUNT(first_goal_for)>0 THEN 100.0*SUM(COALESCE(first_goal_for,0))/COUNT(first_goal_for) ELSE NULL END,
  1.0*SUM(p1_goals_for-p1_goals_against)/COUNT(*),
  1.0*SUM(p2_goals_for-p2_goals_against)/COUNT(*),
  1.0*SUM(p3_goals_for-p3_goals_against)/COUNT(*),
  SUM(went_ot),
  SUM(went_so),
  MAX(scheduled_start_utc),
  '['||GROUP_CONCAT(game_pk)||']',
  CURRENT_TIMESTAMP
FROM team_game_features
WHERE season_id IN ('20242025','20252026') AND game_type IN (2,3) AND is_home=1
GROUP BY team_tri,opponent_tri
ON CONFLICT(team_tri,opponent_tri,scope_key) DO UPDATE SET
  games=excluded.games,wins=excluded.wins,losses=excluded.losses,
  goals_for=excluded.goals_for,goals_against=excluded.goals_against,
  goals_for_pg=excluded.goals_for_pg,goals_against_pg=excluded.goals_against_pg,total_goals_pg=excluded.total_goals_pg,
  shots_for=excluded.shots_for,shots_against=excluded.shots_against,shot_share_pct=excluded.shot_share_pct,
  corsi_for=excluded.corsi_for,corsi_against=excluded.corsi_against,corsi_for_pct=excluded.corsi_for_pct,
  fenwick_for=excluded.fenwick_for,fenwick_against=excluded.fenwick_against,fenwick_for_pct=excluded.fenwick_for_pct,
  power_play_goals_for=excluded.power_play_goals_for,power_play_goals_against=excluded.power_play_goals_against,
  hits_for=excluded.hits_for,hits_against=excluded.hits_against,pim_for=excluded.pim_for,pim_against=excluded.pim_against,
  first_goal_pct=excluded.first_goal_pct,p1_goal_diff_pg=excluded.p1_goal_diff_pg,
  p2_goal_diff_pg=excluded.p2_goal_diff_pg,p3_goal_diff_pg=excluded.p3_goal_diff_pg,
  ot_games=excluded.ot_games,so_games=excluded.so_games,last_game_utc=excluded.last_game_utc,
  evidence_game_pks_json=excluded.evidence_game_pks_json,computed_at=CURRENT_TIMESTAMP;

INSERT INTO team_h2h_snapshots (
  team_tri, opponent_tri, scope_key, games, wins, losses,
  goals_for, goals_against, goals_for_pg, goals_against_pg, total_goals_pg,
  shots_for, shots_against, shot_share_pct,
  corsi_for, corsi_against, corsi_for_pct,
  fenwick_for, fenwick_against, fenwick_for_pct,
  power_play_goals_for, power_play_goals_against,
  hits_for, hits_against, pim_for, pim_against,
  first_goal_pct, p1_goal_diff_pg, p2_goal_diff_pg, p3_goal_diff_pg,
  ot_games, so_games, last_game_utc, evidence_game_pks_json, computed_at
)
SELECT
  team_tri,
  opponent_tri,
  '2Y_AWAY',
  COUNT(*),
  SUM(final_win),
  COUNT(*)-SUM(final_win),
  SUM(final_goals_for),
  SUM(final_goals_against),
  1.0*SUM(final_goals_for)/COUNT(*),
  1.0*SUM(final_goals_against)/COUNT(*),
  1.0*SUM(total_goals)/COUNT(*),
  SUM(shots_for),
  SUM(shots_against),
  CASE WHEN SUM(COALESCE(shots_for,0))+SUM(COALESCE(shots_against,0))>0
    THEN 100.0*SUM(COALESCE(shots_for,0))/(SUM(COALESCE(shots_for,0))+SUM(COALESCE(shots_against,0)))
    ELSE NULL END,
  SUM(corsi_for),
  SUM(corsi_against),
  CASE WHEN SUM(COALESCE(corsi_for,0))+SUM(COALESCE(corsi_against,0))>0
    THEN 100.0*SUM(COALESCE(corsi_for,0))/(SUM(COALESCE(corsi_for,0))+SUM(COALESCE(corsi_against,0)))
    ELSE NULL END,
  SUM(fenwick_for),
  SUM(fenwick_against),
  CASE WHEN SUM(COALESCE(fenwick_for,0))+SUM(COALESCE(fenwick_against,0))>0
    THEN 100.0*SUM(COALESCE(fenwick_for,0))/(SUM(COALESCE(fenwick_for,0))+SUM(COALESCE(fenwick_against,0)))
    ELSE NULL END,
  SUM(power_play_goals_for),
  SUM(power_play_goals_against),
  SUM(hits_for),
  SUM(hits_against),
  SUM(pim_for),
  SUM(pim_against),
  CASE WHEN COUNT(first_goal_for)>0 THEN 100.0*SUM(COALESCE(first_goal_for,0))/COUNT(first_goal_for) ELSE NULL END,
  1.0*SUM(p1_goals_for-p1_goals_against)/COUNT(*),
  1.0*SUM(p2_goals_for-p2_goals_against)/COUNT(*),
  1.0*SUM(p3_goals_for-p3_goals_against)/COUNT(*),
  SUM(went_ot),
  SUM(went_so),
  MAX(scheduled_start_utc),
  '['||GROUP_CONCAT(game_pk)||']',
  CURRENT_TIMESTAMP
FROM team_game_features
WHERE season_id IN ('20242025','20252026') AND game_type IN (2,3) AND is_home=0
GROUP BY team_tri,opponent_tri
ON CONFLICT(team_tri,opponent_tri,scope_key) DO UPDATE SET
  games=excluded.games,wins=excluded.wins,losses=excluded.losses,
  goals_for=excluded.goals_for,goals_against=excluded.goals_against,
  goals_for_pg=excluded.goals_for_pg,goals_against_pg=excluded.goals_against_pg,total_goals_pg=excluded.total_goals_pg,
  shots_for=excluded.shots_for,shots_against=excluded.shots_against,shot_share_pct=excluded.shot_share_pct,
  corsi_for=excluded.corsi_for,corsi_against=excluded.corsi_against,corsi_for_pct=excluded.corsi_for_pct,
  fenwick_for=excluded.fenwick_for,fenwick_against=excluded.fenwick_against,fenwick_for_pct=excluded.fenwick_for_pct,
  power_play_goals_for=excluded.power_play_goals_for,power_play_goals_against=excluded.power_play_goals_against,
  hits_for=excluded.hits_for,hits_against=excluded.hits_against,pim_for=excluded.pim_for,pim_against=excluded.pim_against,
  first_goal_pct=excluded.first_goal_pct,p1_goal_diff_pg=excluded.p1_goal_diff_pg,
  p2_goal_diff_pg=excluded.p2_goal_diff_pg,p3_goal_diff_pg=excluded.p3_goal_diff_pg,
  ot_games=excluded.ot_games,so_games=excluded.so_games,last_game_utc=excluded.last_game_utc,
  evidence_game_pks_json=excluded.evidence_game_pks_json,computed_at=CURRENT_TIMESTAMP;

INSERT INTO team_h2h_snapshots (
  team_tri, opponent_tri, scope_key, games, wins, losses,
  goals_for, goals_against, goals_for_pg, goals_against_pg, total_goals_pg,
  shots_for, shots_against, shot_share_pct,
  corsi_for, corsi_against, corsi_for_pct,
  fenwick_for, fenwick_against, fenwick_for_pct,
  power_play_goals_for, power_play_goals_against,
  hits_for, hits_against, pim_for, pim_against,
  first_goal_pct, p1_goal_diff_pg, p2_goal_diff_pg, p3_goal_diff_pg,
  ot_games, so_games, last_game_utc, evidence_game_pks_json, computed_at
)
SELECT
  team_tri,
  opponent_tri,
  '2Y_REG',
  COUNT(*),
  SUM(final_win),
  COUNT(*)-SUM(final_win),
  SUM(final_goals_for),
  SUM(final_goals_against),
  1.0*SUM(final_goals_for)/COUNT(*),
  1.0*SUM(final_goals_against)/COUNT(*),
  1.0*SUM(total_goals)/COUNT(*),
  SUM(shots_for),
  SUM(shots_against),
  CASE WHEN SUM(COALESCE(shots_for,0))+SUM(COALESCE(shots_against,0))>0
    THEN 100.0*SUM(COALESCE(shots_for,0))/(SUM(COALESCE(shots_for,0))+SUM(COALESCE(shots_against,0)))
    ELSE NULL END,
  SUM(corsi_for),
  SUM(corsi_against),
  CASE WHEN SUM(COALESCE(corsi_for,0))+SUM(COALESCE(corsi_against,0))>0
    THEN 100.0*SUM(COALESCE(corsi_for,0))/(SUM(COALESCE(corsi_for,0))+SUM(COALESCE(corsi_against,0)))
    ELSE NULL END,
  SUM(fenwick_for),
  SUM(fenwick_against),
  CASE WHEN SUM(COALESCE(fenwick_for,0))+SUM(COALESCE(fenwick_against,0))>0
    THEN 100.0*SUM(COALESCE(fenwick_for,0))/(SUM(COALESCE(fenwick_for,0))+SUM(COALESCE(fenwick_against,0)))
    ELSE NULL END,
  SUM(power_play_goals_for),
  SUM(power_play_goals_against),
  SUM(hits_for),
  SUM(hits_against),
  SUM(pim_for),
  SUM(pim_against),
  CASE WHEN COUNT(first_goal_for)>0 THEN 100.0*SUM(COALESCE(first_goal_for,0))/COUNT(first_goal_for) ELSE NULL END,
  1.0*SUM(p1_goals_for-p1_goals_against)/COUNT(*),
  1.0*SUM(p2_goals_for-p2_goals_against)/COUNT(*),
  1.0*SUM(p3_goals_for-p3_goals_against)/COUNT(*),
  SUM(went_ot),
  SUM(went_so),
  MAX(scheduled_start_utc),
  '['||GROUP_CONCAT(game_pk)||']',
  CURRENT_TIMESTAMP
FROM team_game_features
WHERE season_id IN ('20242025','20252026') AND game_type=2
GROUP BY team_tri,opponent_tri
ON CONFLICT(team_tri,opponent_tri,scope_key) DO UPDATE SET
  games=excluded.games,wins=excluded.wins,losses=excluded.losses,
  goals_for=excluded.goals_for,goals_against=excluded.goals_against,
  goals_for_pg=excluded.goals_for_pg,goals_against_pg=excluded.goals_against_pg,total_goals_pg=excluded.total_goals_pg,
  shots_for=excluded.shots_for,shots_against=excluded.shots_against,shot_share_pct=excluded.shot_share_pct,
  corsi_for=excluded.corsi_for,corsi_against=excluded.corsi_against,corsi_for_pct=excluded.corsi_for_pct,
  fenwick_for=excluded.fenwick_for,fenwick_against=excluded.fenwick_against,fenwick_for_pct=excluded.fenwick_for_pct,
  power_play_goals_for=excluded.power_play_goals_for,power_play_goals_against=excluded.power_play_goals_against,
  hits_for=excluded.hits_for,hits_against=excluded.hits_against,pim_for=excluded.pim_for,pim_against=excluded.pim_against,
  first_goal_pct=excluded.first_goal_pct,p1_goal_diff_pg=excluded.p1_goal_diff_pg,
  p2_goal_diff_pg=excluded.p2_goal_diff_pg,p3_goal_diff_pg=excluded.p3_goal_diff_pg,
  ot_games=excluded.ot_games,so_games=excluded.so_games,last_game_utc=excluded.last_game_utc,
  evidence_game_pks_json=excluded.evidence_game_pks_json,computed_at=CURRENT_TIMESTAMP;

INSERT INTO team_h2h_snapshots (
  team_tri, opponent_tri, scope_key, games, wins, losses,
  goals_for, goals_against, goals_for_pg, goals_against_pg, total_goals_pg,
  shots_for, shots_against, shot_share_pct,
  corsi_for, corsi_against, corsi_for_pct,
  fenwick_for, fenwick_against, fenwick_for_pct,
  power_play_goals_for, power_play_goals_against,
  hits_for, hits_against, pim_for, pim_against,
  first_goal_pct, p1_goal_diff_pg, p2_goal_diff_pg, p3_goal_diff_pg,
  ot_games, so_games, last_game_utc, evidence_game_pks_json, computed_at
)
SELECT
  team_tri,
  opponent_tri,
  '2Y_PO',
  COUNT(*),
  SUM(final_win),
  COUNT(*)-SUM(final_win),
  SUM(final_goals_for),
  SUM(final_goals_against),
  1.0*SUM(final_goals_for)/COUNT(*),
  1.0*SUM(final_goals_against)/COUNT(*),
  1.0*SUM(total_goals)/COUNT(*),
  SUM(shots_for),
  SUM(shots_against),
  CASE WHEN SUM(COALESCE(shots_for,0))+SUM(COALESCE(shots_against,0))>0
    THEN 100.0*SUM(COALESCE(shots_for,0))/(SUM(COALESCE(shots_for,0))+SUM(COALESCE(shots_against,0)))
    ELSE NULL END,
  SUM(corsi_for),
  SUM(corsi_against),
  CASE WHEN SUM(COALESCE(corsi_for,0))+SUM(COALESCE(corsi_against,0))>0
    THEN 100.0*SUM(COALESCE(corsi_for,0))/(SUM(COALESCE(corsi_for,0))+SUM(COALESCE(corsi_against,0)))
    ELSE NULL END,
  SUM(fenwick_for),
  SUM(fenwick_against),
  CASE WHEN SUM(COALESCE(fenwick_for,0))+SUM(COALESCE(fenwick_against,0))>0
    THEN 100.0*SUM(COALESCE(fenwick_for,0))/(SUM(COALESCE(fenwick_for,0))+SUM(COALESCE(fenwick_against,0)))
    ELSE NULL END,
  SUM(power_play_goals_for),
  SUM(power_play_goals_against),
  SUM(hits_for),
  SUM(hits_against),
  SUM(pim_for),
  SUM(pim_against),
  CASE WHEN COUNT(first_goal_for)>0 THEN 100.0*SUM(COALESCE(first_goal_for,0))/COUNT(first_goal_for) ELSE NULL END,
  1.0*SUM(p1_goals_for-p1_goals_against)/COUNT(*),
  1.0*SUM(p2_goals_for-p2_goals_against)/COUNT(*),
  1.0*SUM(p3_goals_for-p3_goals_against)/COUNT(*),
  SUM(went_ot),
  SUM(went_so),
  MAX(scheduled_start_utc),
  '['||GROUP_CONCAT(game_pk)||']',
  CURRENT_TIMESTAMP
FROM team_game_features
WHERE season_id IN ('20242025','20252026') AND game_type=3
GROUP BY team_tri,opponent_tri
ON CONFLICT(team_tri,opponent_tri,scope_key) DO UPDATE SET
  games=excluded.games,wins=excluded.wins,losses=excluded.losses,
  goals_for=excluded.goals_for,goals_against=excluded.goals_against,
  goals_for_pg=excluded.goals_for_pg,goals_against_pg=excluded.goals_against_pg,total_goals_pg=excluded.total_goals_pg,
  shots_for=excluded.shots_for,shots_against=excluded.shots_against,shot_share_pct=excluded.shot_share_pct,
  corsi_for=excluded.corsi_for,corsi_against=excluded.corsi_against,corsi_for_pct=excluded.corsi_for_pct,
  fenwick_for=excluded.fenwick_for,fenwick_against=excluded.fenwick_against,fenwick_for_pct=excluded.fenwick_for_pct,
  power_play_goals_for=excluded.power_play_goals_for,power_play_goals_against=excluded.power_play_goals_against,
  hits_for=excluded.hits_for,hits_against=excluded.hits_against,pim_for=excluded.pim_for,pim_against=excluded.pim_against,
  first_goal_pct=excluded.first_goal_pct,p1_goal_diff_pg=excluded.p1_goal_diff_pg,
  p2_goal_diff_pg=excluded.p2_goal_diff_pg,p3_goal_diff_pg=excluded.p3_goal_diff_pg,
  ot_games=excluded.ot_games,so_games=excluded.so_games,last_game_utc=excluded.last_game_utc,
  evidence_game_pks_json=excluded.evidence_game_pks_json,computed_at=CURRENT_TIMESTAMP;

INSERT INTO data_core_meta(meta_key,meta_value,updated_at)
SELECT 'h2h.snapshot_rows',CAST(COUNT(*) AS TEXT),CURRENT_TIMESTAMP
FROM team_h2h_snapshots
WHERE true
ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP;
