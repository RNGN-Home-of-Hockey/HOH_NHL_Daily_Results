// Advanced Matchup Engine v2
// Composite pre-game context layer. This intentionally produces explainable
// features; probability calibration is handled later after settled samples.

const clamp = (v, min = 0, max = 100) => Math.max(min, Math.min(max, Number(v) || 0));
const pct = (a, b) => (Number(b) ? (Number(a) / Number(b)) : 0);

export function buildAdvancedMatchupEngine(game = {}, snapshots = {}) {
  const season = snapshots.season || {};
  const recent = snapshots.recent || {};
  const venue = snapshots.venue || {};
  const opponent = snapshots.opponent || {};

  const components = {
    season: clamp(scoreTeamBlock(season)),
    recent: clamp(scoreTeamBlock(recent)),
    homeAway: clamp(scoreTeamBlock(venue)),
    opponent: clamp(scoreTeamBlock(opponent)),
  };

  const score = Math.round(
    components.season * 0.40 +
    components.recent * 0.25 +
    components.homeAway * 0.20 +
    components.opponent * 0.15
  );

  return {
    air_score_context: score,
    model: "advanced_matchup_v2",
    weights: {
      season: 0.40,
      recent: 0.25,
      homeAway: 0.20,
      opponent: 0.15,
    },
    components,
    signals: buildSignals(components),
    game_pk: game.game_pk || null,
  };
}

function scoreTeamBlock(block) {
  if (!block) return 50;

  const winRate = pct(block.wins, Number(block.wins) + Number(block.losses));
  const goalDiff = Number(block.goals_for || 0) - Number(block.goals_against || 0);
  const shotShare = Number(block.shot_share || 0.5);

  return clamp(
    50 +
    (winRate - 0.5) * 80 +
    goalDiff * 2 +
    (shotShare - 0.5) * 50
  );
}

function buildSignals(c) {
  const out = [];
  if (c.recent >= 65) out.push("strong_recent_form");
  if (c.homeAway >= 65) out.push("venue_advantage");
  if (c.opponent >= 65) out.push("favorable_opponent_profile");
  if (c.season >= 65) out.push("season_strength");
  return out;
}
