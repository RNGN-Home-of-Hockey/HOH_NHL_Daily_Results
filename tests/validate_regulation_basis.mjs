// Winline hockey totals, team totals, handicaps and "both teams to score" settle on regulation time:
// the overtime goal and the shootout "goal" never count. Only the plain Money Line includes overtime.
// Reported by commentators on 2026-10-09: "total under 4.5 was 2 times in the last four games, it was 3 - the
// overtime puck was counted".
import { strict as assert } from "node:assert";
import { regulationBasisRow, regulationBasisRows, regulationGoalsFromScoreboard } from "../cloudflare-worker/src/regulation-basis.js";
import { buildH2HBroadcastInsights } from "../cloudflare-worker/src/h2h-broadcast-insights.js";
import { evaluateProviderMarketHistoryRows } from "../cloudflare-worker/src/provider-market-history-insights.js";
import { evaluateVenueMarketSplits, evaluateH2HMarketSplits } from "../cloudflare-worker/src/market-split-insights.js";

// ---- 1) helper -------------------------------------------------------------------------------------------------
{
  const ot = { final_goals_for: 3, final_goals_against: 2, total_goals: 5, final_goal_diff: 1, final_win: 1, regulation_goals_for: 2, regulation_goals_against: 2 };
  const r = regulationBasisRow(ot);
  assert.equal(r.total_goals, 4, "overtime goal is not part of the total");
  assert.equal(r.final_goal_diff, 0, "a one-goal overtime win is a draw after 60 minutes");
  assert.equal(r.final_goals_for, 2);
  assert.equal(r.final_win, 1, "the outright winner (Money Line) keeps overtime");
  assert.equal(r.scoreboard_goals_for, 3, "scoreboard value is kept for reference");
  assert.equal(regulationBasisRow(r), r, "idempotent");
  const bare = { final_goals_for: 3, final_goals_against: 2, total_goals: 5, final_goal_diff: 1, final_win: 1 };
  assert.equal(regulationBasisRow(bare), bare, "rows without regulation numbers are left alone");
  const broken = { ...ot, regulation_goals_for: 0, regulation_goals_against: 0 };
  assert.equal(regulationBasisRow(broken), broken, "regulation numbers that cannot belong to this game are ignored");
  assert.deepEqual(regulationBasisRows([ot]).map((x) => x.total_goals), [4]);
  assert.deepEqual(regulationGoalsFromScoreboard(3, 2, "OT"), { gf: 2, ga: 2 });
  assert.deepEqual(regulationGoalsFromScoreboard(2, 3, "SO"), { gf: 2, ga: 2 });
  assert.deepEqual(regulationGoalsFromScoreboard(4, 1, "REG"), { gf: 4, ga: 1 });
}

// A game team A wins in overtime: `reg`-`reg` after 60 minutes (default 2-2), scoreboard reg+1 to reg.
function otRow(pk, team, i, { home, reg = 2 }) {
  const win = team === "A";
  const gf = win ? reg + 1 : reg, ga = win ? reg : reg + 1;
  // periods always add up to reg-reg: p1 1-0, p2 (reg-2)-(reg-1), p3 1-1 (swapped for the losing team)
  const winPeriods = [[1, 0], [reg - 2, reg - 1], [1, 1]];
  const p = win ? winPeriods : winPeriods.map(([f, a]) => [a, f]);
  const base = {
    game_pk: pk, season_id: "20252026", game_type: 2,
    scheduled_start_utc: new Date(Date.UTC(2026, 3, 30 - i)).toISOString(),
    team_tri: team === "A" ? "AAA" : "BBB", opponent_tri: team === "A" ? "BBB" : "AAA", is_home: home ? 1 : 0,
    raw_game_state: "FINAL", raw_game_period_type: "OT",
    raw_final_goals_for: gf, raw_final_goals_against: ga, event_final_goals_for: gf, event_final_goals_against: ga,
    final_goals_for: gf, final_goals_against: ga, total_goals: gf + ga, final_goal_diff: gf - ga, final_win: win ? 1 : 0,
    regulation_goals_for: reg, regulation_goals_against: reg, regulation_goal_diff: 0, regulation_result: "T",
    score_after_p1_diff: p[0][0] - p[0][1], first_goal_for: p[0][0] > 0 ? 1 : 0,
  };
  p.forEach(([f, a], k) => {
    base[`p${k + 1}_goals_for`] = f; base[`p${k + 1}_goals_against`] = a;
    base[`raw_p${k + 1}_goals_for`] = f; base[`raw_p${k + 1}_goals_against`] = a;
    base[`event_p${k + 1}_goals_for`] = f; base[`event_p${k + 1}_goals_against`] = a;
  });
  return base;
}

// ---- 2) H2H cards (the card the commentator looked at) ------------------------------------------------------------
{
  const game = { game_pk: 1, scheduled_start_utc: "2026-10-10T00:00:00Z", away_tri: "AAA", home_tri: "BBB", away_name_ru: "Ааа", home_name_ru: "Ббб" };
  // from BBB's point of view (the table is read for team=AAA vs BBB): AAA lost 2-3 after overtime every time
  const rows = Array.from({ length: 6 }, (_, i) => ({ ...otRow(100 + i, "B", i, { home: false }), team_tri: "AAA", opponent_tri: "BBB" }));
  const db = { prepare() { return { bind() { return { all: async () => ({ results: rows }) }; } }; } };
  const real = { provider: "winline", status: "open", updated_at: "2026-10-10T00:00:00Z", event_id: "e", is_live: false };
  const markets = [
    { ...real, market_type: "game_total", period: "GAME", subject: null, side: "under", line: 4.5, odds: 2.8 },
    { ...real, market_type: "handicap", period: "GAME", subject: "AAA", side: "AAA", line: 0.5, odds: 1.4 },
    { ...real, market_type: "moneyline", period: "GAME", subject: "BBB", side: "BBB", line: null, odds: 1.7 },
  ];
  const cards = await buildH2HBroadcastInsights(db, game, markets);
  const total = cards.find((c) => c.market.type === "game_total");
  assert.ok(total, "total card exists");
  assert.equal(total.evidence.hits, 6, "regulation total is 4 in all 6 games, so under 4.5 hit 6 of 6 (scoreboard would say 0)");
  const hcp = cards.find((c) => c.market.type === "handicap");
  assert.ok(hcp, "handicap card exists");
  assert.equal(hcp.evidence.hits, 6, "AAA +0.5: level after 60 minutes covers +0.5 in all 6 games");
  const ml = cards.find((c) => c.market.type === "moneyline");
  assert.ok(ml, "money line card exists");
  assert.equal(ml.evidence.hits, 6, "BBB won all 6 including overtime: Money Line keeps the scoreboard result");
}

// ---- 3) provider-market history (exact Winline lines) ---------------------------------------------------------------
{
  const game = { game_pk: 2026020999, season_id: "20262027", away_tri: "AAA", home_tri: "BBB" };
  const now = "2026-10-10T00:00:00.000Z";
  const rowsByTeam = {
    AAA: Array.from({ length: 10 }, (_, i) => otRow(100 + i, "A", i, { home: false })),
    BBB: Array.from({ length: 10 }, (_, i) => otRow(200 + i, "B", i, { home: true })),
  };
  const m = (market_type, period, subject, side, line, odds) => ({ provider: "winline", market_type, period, subject, side, line, odds, status: "open", updated_at: now });
  const cards = evaluateProviderMarketHistoryRows(game, rowsByTeam, [
    m("game_total", "GAME", null, "under", 4.5, 2.8),
    m("handicap", "GAME", "AAA", "AAA", -0.5, 2.1),
    m("moneyline", "GAME", "AAA", "AAA", null, 1.9),
    m("both_teams_score", "GAME", null, "yes", null, 1.5),
  ]);
  const total = cards.find((c) => c.market.type === "game_total" && c.evidence.window === 10);
  assert.ok(total, "total under 4.5 is evaluated");
  assert.equal(total.evidence.hits, 20, "all 20 team-games finished 2-2 in regulation: total 4 < 4.5 (scoreboard total 5 would give 0)");
  const hcp = cards.find((c) => c.market.type === "handicap" && c.evidence.window === 10);
  assert.ok(!hcp || hcp.evidence.hits === 0, "AAA -0.5 never covered after 60 minutes (level)");
  const ml = cards.find((c) => c.market.type === "moneyline" && c.evidence.window === 10);
  assert.ok(ml, "Money Line is still evaluated on the scoreboard result");
  assert.equal(ml.evidence.hits, 10, "AAA won all 10 games in overtime: Money Line hit");
}

// ---- 4) venue / H2H market splits --------------------------------------------------------------------------------
{
  const game = { game_pk: 3, away_tri: "AAA", home_tri: "BBB", away_name_ru: "Ааа", home_name_ru: "Ббб" };
  // AAA wins every game 3-2 in overtime: it scored 2 in regulation and 3 on the scoreboard.
  // Team total over 2.5 is true only on the scoreboard; under 2.5 is true after 60 minutes.
  const rowsByTeam = {
    AAA: Array.from({ length: 20 }, (_, i) => otRow(300 + i, "A", i, { home: false })),
    BBB: Array.from({ length: 20 }, (_, i) => otRow(400 + i, "B", i, { home: true })),
  };
  const venue = evaluateVenueMarketSplits(game, rowsByTeam);
  const aaaTotals = venue.filter((c) => c.market?.type === "team_total" && c.market?.subject === "AAA");
  assert.ok(aaaTotals.some((c) => c.market.side === "under" && Number(c.market.line) === 2.5), "AAA scored 2 in regulation every game: under 2.5");
  assert.equal(aaaTotals.some((c) => c.market.side === "over" && Number(c.market.line) === 2.5), false, "the overtime goal must not make it over 2.5");
  const h2hRows = Array.from({ length: 6 }, (_, i) => ({ ...otRow(500 + i, "A", i, { home: false }) }));
  const h2h = evaluateH2HMarketSplits(game, h2hRows);
  const h2hAaa = h2h.filter((c) => c.market?.type === "team_total" && c.market?.subject === "AAA");
  assert.ok(h2hAaa.some((c) => c.market.side === "under" && Number(c.market.line) === 2.5), "H2H team total under 2.5 uses regulation goals");
  assert.equal(h2hAaa.some((c) => c.market.side === "over" && Number(c.market.line) === 2.5), false);
}

// ---- 5) a hit rate stays with the market it was measured on ---------------------------------------------------------
{
  const { buildMarketCombinationInsights } = await import("../cloudflare-worker/src/market-combination-engine.js");
  const game = { game_pk: 7, away_tri: "PHI", home_tri: "BOS" };
  const now = Date.parse("2026-10-10T06:20:00Z");
  const provider = { provider: "winline", market_type: "game_total", period: "GAME", subject: null, side: "under", line: 4.5, odds: 2.8, status: "open", updated_at: new Date(now).toISOString(), event_id: "e", market_id: "e:totals:4.5:2" };
  const teamTotalFact = {
    id: "7:venue_split:venue_team_total_BOS_under_4_5_w20", category: "venue_split", insight_type: "venue_team_total_BOS_under_4_5_w20", score: 99,
    title: "BOS дома: ТОТАЛ КОМАНДЫ МЕНЬШЕ 4.5 — 15/20", value: "15/20",
    market: { type: "team_total", period: "GAME", subject: "BOS", side: "under", line: 4.5 },
    evidence: { hit_rate: 0.75, hits: 15, sample: 20, window: 20, team: "BOS" },
  };
  assert.deepEqual(buildMarketCombinationInsights([teamTotalFact], [provider], game, { now }), [], "BOS team-total rate must not become the history of the GAME total");
  const gameTotalFact = {
    id: "7:h2h:game_total_under_4_5", category: "h2h_broadcast", insight_type: "h2h_current_line", score: 90,
    title: "ОБЩИЙ ТОТАЛ МЕНЬШЕ 4,5 ПРОТИВ БОСТОНА — 4 ИЗ 6", value: "4/6",
    market: { type: "game_total", period: "GAME", subject: null, side: "under", line: 4.5 },
    evidence: { hit_rate: 4 / 6, hits: 4, sample: 6, window: 6, decisions: 6, team: "PHI", opponent: "BOS" },
  };
  const exact = buildMarketCombinationInsights([gameTotalFact], [provider], game, { now });
  assert.ok(exact.length >= 1, "a fact measured on this exact market is still used");
  assert.equal(exact[0].market.label, "ОБЩИЙ ТОТАЛ МЕНЬШЕ 4,5", "totals are not signed");
  assert.ok(!/\+4,5/.test(exact[0].explanation), "no '+' in a total line inside the explanation");
  assert.equal(exact[0].evidence.target_market_frequency_verified, true);
}

// ---- 6) streak wording -------------------------------------------------------------------------------------------------
{
  const { buildBroadcastAngles } = await import("../cloudflare-worker/src/broadcast-angle-engine.js");
  const card = {
    title: "x",
    evidence: { team: "BOS", opponent: "PHI", hits: 18, decisions: 20, hit_rate: 0.9, window: 20, current_streak: 5, streak_verified: true, streak_cross_season: true },
    market: { type: "game_total", period: "GAME", side: "under", line: 4.5, label: "ОБЩИЙ ТОТАЛ МЕНЬШЕ 4,5", odds: 2.8, odds_is_demo: false },
  };
  const angles = buildBroadcastAngles(card, { team: "BOS", opponent: "PHI" });
  const streak = angles.find((a) => a.family === "streak");
  assert.ok(streak, "a verified streak produces a streak angle");
  assert.match(streak.title, /5 МАТЧЕЙ ПОДРЯД/, "5 matches, not '5 МАТЧА'");
  assert.match(String(streak.subtitle), /ПРОШЛОГО СЕЗОНА/, "a run that crosses the season boundary says so");
  const same = buildBroadcastAngles({ ...card, evidence: { ...card.evidence, current_streak: 3, streak_cross_season: false } }, { team: "BOS", opponent: "PHI" }).find((a) => a.family === "streak");
  assert.match(same.title, /3 МАТЧА ПОДРЯД/);
  assert.doesNotMatch(String(same.subtitle), /ПРОШЛОГО/);
}

console.log("REGULATION_BASIS_OK");
