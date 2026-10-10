// Commentators (2026-10-09): "won 13 of the last 20, but 6 or 7 of the misses were in the last 8 games".
// A long sample must not hide a cold streak: the latest 8 games travel with the long number, show up in the
// commentator brief, and pull the AIR SCORE down when the recent form is clearly worse.
import { strict as assert } from "node:assert";
import { evaluateVenueMarketSplits } from "../cloudflare-worker/src/market-split-insights.js";
import { evaluateProviderMarketHistoryRows } from "../cloudflare-worker/src/provider-market-history-insights.js";
import { annotateAirUtility } from "../cloudflare-worker/src/betting-insight-engine.js";
import { buildCommentatorBrief } from "../cloudflare-worker/src/commentator-brief.js";

// AAA game i (0 = newest). It wins in regulation 3-2 or loses 2-3 in regulation; periods add up to the score.
function gameRow(pk, i, win, { home = false } = {}) {
  const gf = win ? 3 : 2, ga = win ? 2 : 3;
  const p = win ? [[1, 0], [1, 1], [1, 1]] : [[0, 1], [1, 1], [1, 1]];
  const base = {
    game_pk: pk, season_id: "20262027", game_type: 2,
    scheduled_start_utc: new Date(Date.UTC(2026, 9, 9 - i)).toISOString(),
    team_tri: "AAA", opponent_tri: "BBB", is_home: home ? 1 : 0,
    raw_game_state: "FINAL", raw_game_period_type: "REG",
    raw_final_goals_for: gf, raw_final_goals_against: ga, event_final_goals_for: gf, event_final_goals_against: ga,
    final_goals_for: gf, final_goals_against: ga, total_goals: 5, final_goal_diff: gf - ga, final_win: win ? 1 : 0,
    regulation_goals_for: gf, regulation_goals_against: ga, regulation_goal_diff: gf - ga, regulation_result: win ? "W" : "L",
    score_after_p1_diff: p[0][0] - p[0][1], first_goal_for: p[0][0] > 0 ? 1 : 0,
  };
  p.forEach(([f, a], k) => {
    base[`p${k + 1}_goals_for`] = f; base[`p${k + 1}_goals_against`] = a;
    base[`raw_p${k + 1}_goals_for`] = f; base[`raw_p${k + 1}_goals_against`] = a;
    base[`event_p${k + 1}_goals_for`] = f; base[`event_p${k + 1}_goals_against`] = a;
  });
  return base;
}
// 14 wins of 20, but only 2 of the latest 8 (games 0 and 1); games 2-7 lost, games 8-19 all won.
const wins = (i) => i <= 1 || i >= 8;
const coldRows = (home) => Array.from({ length: 20 }, (_, i) => gameRow(1000 + i, i, wins(i), { home }));
const bbbRows = Array.from({ length: 20 }, (_, i) => ({ ...gameRow(2000 + i, i, false, { home: true }), team_tri: "BBB", opponent_tri: "AAA", final_win: 0 }));

// ---- 1) venue splits carry the latest 8 ------------------------------------------------------------------------------
{
  const game = { game_pk: 1, away_tri: "AAA", home_tri: "BBB", away_name_ru: "Ааа", home_name_ru: "Ббб" };
  const cards = evaluateVenueMarketSplits(game, { AAA: coldRows(false), BBB: bbbRows });
  const ml = cards.find((c) => c.market?.type === "moneyline" && c.market?.subject === "AAA" && c.evidence?.window === 20);
  assert.ok(ml, "14/20 at home/away produces a Money Line card");
  assert.equal(ml.evidence.hits, 14);
  assert.deepEqual(ml.evidence.recent_form, { window: 8, hits: 2, decisions: 8 }, "the latest 8 games are 2 of 8");
}

// ---- 2) exact Winline lines carry it too ---------------------------------------------------------------------------
{
  const game = { game_pk: 2026020999, season_id: "20262027", away_tri: "AAA", home_tri: "BBB" };
  const m = { provider: "winline", market_type: "moneyline", period: "GAME", subject: "AAA", side: "AAA", line: null, odds: 1.8, status: "open", updated_at: "2026-10-10T00:00:00.000Z" };
  const cards = evaluateProviderMarketHistoryRows(game, { AAA: coldRows(false), BBB: bbbRows }, [m]);
  const card = cards.find((c) => c.evidence.window === 20);
  assert.ok(card, "exact Money Line history exists for the 20-game window");
  assert.deepEqual(card.evidence.recent_form, { window: 8, hits: 2, decisions: 8 });
}

// ---- 3) AIR SCORE and the commentator brief --------------------------------------------------------------------------
{
  const base = () => ({
    score: 80, title: "BOS выиграл 13 из последних 20 матчей дома",
    evidence: { sample: 20, hits: 13, hit_rate: 0.65, role: "дома", team: "BOS" },
    market: { type: "moneyline", subject: "BOS", side: "BOS", label: "Победа BOS", odds: 1.73, odds_is_demo: false, odds_source: "provider_live" },
  });
  const plain = annotateAirUtility(base());
  const cold = annotateAirUtility({ ...base(), evidence: { ...base().evidence, recent_form: { window: 8, hits: 1, decisions: 8 } } });
  const warm = annotateAirUtility({ ...base(), evidence: { ...base().evidence, recent_form: { window: 8, hits: 5, decisions: 8 } } });
  const hot = annotateAirUtility({ ...base(), evidence: { ...base().evidence, recent_form: { window: 8, hits: 8, decisions: 8 } } });
  assert.ok(cold.air_score < plain.air_score - 8, `a cold last 8 (1 of 8) must cost points: ${cold.air_score} vs ${plain.air_score}`);
  assert.equal(warm.air_score, plain.air_score, "a recent rate close to the long rate changes nothing");
  assert.ok(hot.air_score >= plain.air_score, "a hot last 8 never lowers the score");
  assert.deepEqual(cold.air_meta.recent_form, { window: 8, hits: 1, decisions: 8 });

  const brief = buildCommentatorBrief({ ...cold, broadcast_title: "БОСТОН ВЫИГРАЛ 13 ИЗ 20 МАТЧЕЙ ДОМА" }, {});
  const figure = brief.points.find((p) => p.label === "ЦИФРА");
  assert.ok(figure, "the brief has a figure line");
  assert.match(figure.text, /13 из 20/);
  assert.match(figure.text, /последние 8: 1 из 8/, "the commentator sees the cold streak next to the long number");
  const plainBrief = buildCommentatorBrief({ ...plain, broadcast_title: "БОСТОН ВЫИГРАЛ 13 ИЗ 20 МАТЧЕЙ ДОМА" }, {});
  assert.doesNotMatch(plainBrief.points.find((p) => p.label === "ЦИФРА").text, /последние 8/);
}

console.log("RECENT_FORM_OK");
