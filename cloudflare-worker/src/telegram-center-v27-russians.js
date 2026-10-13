// Russians of the NHL on the home page: who of them plays on the day the page looks at, and how they played (from the NHL box score).
// Pure functions; the route in telegram-center-v27-home.js does the loading.

export const MAX_RUSSIANS = 30;

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function minutes(toi) {
  const m = /^(\d{1,3}):(\d{2})$/.exec(String(toi || "").trim());
  return m ? Number(m[1]) + Number(m[2]) / 60 : 0;
}

function headshot(id, tri, season) {
  return id && tri && season ? `https://assets.nhle.com/mugs/nhl/${season}/${tri}/${id}.png` : null;
}

// One player of the box score of a team (forwards, defense, goalies), or null when he was not in the line-up.
function findInBox(box, side, playerId) {
  const team = box && box.playerByGameStats && box.playerByGameStats[side === "home" ? "homeTeam" : "awayTeam"];
  if (!team) return undefined;
  for (const group of ["forwards", "defense", "goalies"]) {
    const row = (team[group] || []).find((p) => num(p.playerId) === playerId);
    if (row) return { row, goalie: group === "goalies" };
  }
  return null;
}

// What the player did. Skaters: goals, assists, time on ice. Goalies: saves and shots.
// A player who is in the box score without ice time did not play.
export function statLine(found) {
  if (!found) return null;
  const { row, goalie } = found;
  if (minutes(row.toi) <= 0) return null;
  if (goalie) {
    return { kind: "g", saves: num(row.saves) ?? 0, shots: num(row.shotsAgainst) ?? 0, goals_against: num(row.goalsAgainst) ?? 0, toi: String(row.toi || "") };
  }
  return { kind: "s", goals: num(row.goals) ?? 0, assists: num(row.assists) ?? 0, points: num(row.points) ?? 0, toi: String(row.toi || "") };
}

function rankOf(line) {
  if (!line) return 0;
  if (line.kind === "g") return 50 + line.saves / 10;
  return 100 + line.points * 100 + line.goals * 10 + minutes(line.toi) / 100;
}

// games: the games of the day (objects of gameFromRow), players: Russians of the teams that play, boxes: game_pk -> NHL box score.
export function buildRussians({ games, players, boxes = {}, season = null }) {
  const items = [];
  const byTeam = new Map();
  for (const p of players || []) {
    const tri = String(p.current_team_tri || "").toUpperCase();
    if (!tri) continue;
    if (!byTeam.has(tri)) byTeam.set(tri, []);
    byTeam.get(tri).push(p);
  }
  for (const game of games || []) {
    if (game.phase === "postponed") continue;
    const box = boxes instanceof Map ? boxes.get(game.game_pk) : boxes[game.game_pk];
    for (const side of ["away", "home"]) {
      const team = game[side];
      const opp = game[side === "away" ? "home" : "away"];
      for (const p of byTeam.get(String(team.tri || "").toUpperCase()) || []) {
        const id = num(p.player_id);
        let line = null;
        if (box && (game.phase === "live" || game.phase === "final")) {
          line = statLine(findInBox(box, side, id));
          if (!line) continue; // not dressed for this game, or dressed and did not play
        }
        items.push({
          player_id: id,
          name_ru: p.full_name_ru ? String(p.full_name_ru).trim() : null,
          name_en: p.full_name_en ? String(p.full_name_en).trim() : null,
          position: p.position_code || null,
          number: num(p.sweater_number),
          team: team.tri,
          opp: opp.tri,
          home: side === "home",
          game_pk: game.game_pk,
          phase: game.phase,
          start: game.start,
          line,
          photo: headshot(id, team.tri, season),
          rank: rankOf(line),
          start_ms: game.start_ms,
        });
      }
    }
  }
  items.sort((a, b) => b.rank - a.rank || a.start_ms - b.start_ms || String(a.name_ru || a.name_en).localeCompare(String(b.name_ru || b.name_en), "ru"));
  return items.slice(0, MAX_RUSSIANS).map(({ rank, start_ms, ...item }) => item);
}
