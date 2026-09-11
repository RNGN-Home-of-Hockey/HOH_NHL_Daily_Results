export async function loadTeamRankings(db, windowGames = 20) {
  const window = [5,10,20].includes(Number(windowGames)) ? Number(windowGames) : 20;
  const result = await db.prepare(`
    SELECT s.*,t.name_en,t.name_ru,t.logo_url
    FROM team_current_snapshots s
    JOIN teams t ON t.tri_code=s.team_tri
    WHERE s.window_games=?
    ORDER BY s.rank_goal_diff ASC,s.rank_xgf_pct_5v5 ASC,s.team_tri ASC;
  `).bind(window).all();
  return result.results || [];
}

export async function loadTeamDetail(db, teamTri) {
  const tri = String(teamTri || "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(tri)) return null;
  const [team, snapshotsR, skatersR, goaliesR] = await Promise.all([
    db.prepare(`SELECT tri_code,name_en,name_ru,logo_url FROM teams WHERE tri_code=? LIMIT 1;`).bind(tri).first(),
    db.prepare(`SELECT * FROM team_current_snapshots WHERE team_tri=? ORDER BY window_games;`).bind(tri).all(),
    db.prepare(`
      SELECT p.player_id,p.full_name_en,p.full_name_ru,p.position_code,p.sweater_number,
             r.games,r.goals,r.assists,r.points,r.shots,r.goals_pg,r.points_pg,r.shots_pg,
             r.games_with_goal,r.games_with_point,r.games_with_2plus_points,r.as_of_utc
      FROM player_rolling_snapshots r JOIN players p ON p.player_id=r.player_id
      WHERE r.team_tri=? AND r.window_key='20'
      ORDER BY r.points_pg DESC,r.goals_pg DESC,r.shots_pg DESC
      LIMIT 12;
    `).bind(tri).all(),
    db.prepare(`
      SELECT p.player_id,p.full_name_en,p.full_name_ru,p.sweater_number,
             r.games,r.starts,r.wins,r.losses,r.ot_losses,r.save_pct,r.goals_against_pg,r.shutouts,r.as_of_utc
      FROM goalie_rolling_snapshots r JOIN players p ON p.player_id=r.player_id
      WHERE r.team_tri=? AND r.window_key='20'
      ORDER BY r.starts DESC,r.games DESC,r.save_pct DESC
      LIMIT 4;
    `).bind(tri).all(),
  ]);
  if (!team) return null;
  return {
    team,
    snapshots: snapshotsR.results || [],
    skaters: skatersR.results || [],
    goalies: goaliesR.results || [],
  };
}
