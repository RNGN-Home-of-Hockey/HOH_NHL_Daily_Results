// Winline settles hockey game totals, team totals, handicaps, "both teams to score" and goal buckets on
// regulation time (60 minutes): a goal in overtime or a shootout "goal" never counts. Only the plain
// "Money Line" (outright winner) includes overtime and the shootout.
//
// team_game_features keeps both views: final_* (what the scoreboard says) and regulation_*. The evaluators were
// written against final_*, so every row they use for a goal-based market goes through regulationBasisRow() first:
// final_goals_for / final_goals_against / total_goals / final_goal_diff are replaced by the regulation numbers,
// while final_win stays the outright result (still right for the Money Line).
//
// Rows that carry no regulation numbers (old fixtures, partial loads) are returned unchanged on purpose.

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function regulationBasisRow(row) {
  if (!row || typeof row !== "object" || row.__goal_basis === "regulation") return row;
  const gf = num(row.regulation_goals_for);
  const ga = num(row.regulation_goals_against);
  if (gf === null || ga === null || gf < 0 || ga < 0) return row;
  // Sanity: regulation time can differ from the scoreboard only by the single overtime/shootout goal of the winner.
  const fgf = num(row.final_goals_for), fga = num(row.final_goals_against);
  if (fgf !== null && fga !== null) {
    const dFor = fgf - gf, dAgainst = fga - ga;
    if (dFor < 0 || dAgainst < 0 || dFor > 1 || dAgainst > 1 || dFor + dAgainst > 1) return row;
  }
  return {
    ...row,
    scoreboard_goals_for: row.final_goals_for,
    scoreboard_goals_against: row.final_goals_against,
    final_goals_for: gf,
    final_goals_against: ga,
    total_goals: gf + ga,
    final_goal_diff: gf - ga,
    __goal_basis: "regulation",
  };
}

export function regulationBasisRows(rows) {
  return Array.isArray(rows) ? rows.map(regulationBasisRow) : rows;
}

export function regulationBasisByTeam(rowsByTeam) {
  if (!rowsByTeam || typeof rowsByTeam !== "object") return rowsByTeam;
  const out = {};
  for (const [team, rows] of Object.entries(rowsByTeam)) out[team] = regulationBasisRows(rows);
  return out;
}

// Goals that settle a regulation-time market, from a row that only knows the scoreboard result.
// Used where the regulation columns are not loaded: the winner of an OT/SO game always scored exactly one
// goal (the overtime winner, or the shootout "goal") that does not count in 60 minutes.
export function regulationGoalsFromScoreboard(finalFor, finalAgainst, periodType) {
  const gf = num(finalFor), ga = num(finalAgainst);
  if (gf === null || ga === null) return null;
  const type = String(periodType || "").toUpperCase();
  if (type !== "OT" && type !== "SO") return { gf, ga };
  if (gf === ga) return null;
  return gf > ga ? { gf: gf - 1, ga } : { gf, ga: ga - 1 };
}
