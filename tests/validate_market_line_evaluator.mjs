import { evaluateMarketLines } from '../cloudflare-worker/src/market-line-evaluator.js';

const HOME = [
  row(1,'2026-01-05T00:00:00Z',4,3),
  row(2,'2026-01-04T00:00:00Z',3,3),
  row(3,'2026-01-03T00:00:00Z',2,3),
  row(4,'2026-01-02T00:00:00Z',1,3),
  row(5,'2026-01-01T00:00:00Z',5,3),
];
const AWAY = [
  row(6,'2026-01-05T00:00:00Z',2,4),
  row(7,'2026-01-04T00:00:00Z',4,3),
  row(8,'2026-01-03T00:00:00Z',3,5),
  row(9,'2026-01-02T00:00:00Z',2,3),
  row(10,'2026-01-01T00:00:00Z',1,3),
];

const calls = [];
const db = {
  prepare(sql) {
    return {
      bind(...args) {
        calls.push({ sql, args });
        return {
          async all() {
            const team = args[0];
            const before = args.length === 3 ? args[1] : null;
            const limit = args[args.length - 1];
            const source = team === 'HOM' ? HOME : team === 'AWY' ? AWAY : [];
            const filtered = before ? source.filter(r => r.scheduled_start_utc < before) : source;
            return { results: filtered.slice(0, limit) };
          },
        };
      },
    };
  },
};

const game = {
  game_pk: 2026020001,
  home_tri: 'HOM',
  away_tri: 'AWY',
  start_utc: '2026-02-01T00:00:00Z',
};

const markets = await evaluateMarketLines(db, game, { window: 5 });
assert(markets.length === 20, `expected 20 markets, got ${markets.length}`);
assert(calls.length === 2, `expected two team queries, got ${calls.length}`);
assert(calls.every(c => c.args.length === 3), 'historical cutoff must be bound into both queries');
assert(calls.every(c => c.args[1] === game.start_utc), 'query cutoff must equal game start time');

const total55 = find('game_total', null, 5.5);
assert(total55.side === 'over', '5.5 game total should select over');
assertClose(total55.combined_rate, 0.6, 'game total 5.5 combined rate');
assertClose(total55.confidence, 20, 'game total 5.5 confidence');

const total75 = find('game_total', null, 7.5);
assert(total75.side === 'under', '7.5 game total should select under');
assertClose(total75.combined_rate, 0.8, 'game total 7.5 chosen under rate');
assertClose(total75.confidence, 60, 'game total 7.5 confidence');

const homeTeam25 = find('team_total', 'HOM', 2.5);
assert(homeTeam25.side === 'over', 'HOM 2.5 should select over');
assertClose(homeTeam25.combined_rate, 0.8, 'HOM 2.5 combined rate');
assertClose(homeTeam25.confidence, 60, 'HOM 2.5 confidence');

const homeMinus15 = find('handicap', 'HOM', -1.5);
assertClose(homeMinus15.combined_rate, 0.4, 'HOM -1.5 combined hit rate');
assertClose(homeMinus15.confidence, 0, 'sub-50 handicap must never receive positive confidence');

const awayPlus15 = find('handicap', 'AWY', 1.5);
assert(awayPlus15.combined_rate >= 0.5, 'opposite handicap should carry the directional evidence');
assert(awayPlus15.confidence >= 0, 'confidence must be non-negative');

assert(markets.every(m => m.confidence >= 0 && m.confidence <= 100), 'confidence outside 0..100');
assert(markets.every(m => m.sample === 10), 'sample should equal both five-game windows');

console.log('MARKET_LINE_EVALUATOR_OK');

function find(type, subject, line) {
  const item = markets.find(m => m.market_type === type && m.subject === subject && Number(m.line) === Number(line));
  if (!item) throw new Error(`market not found: ${type} ${subject} ${line}`);
  return item;
}
function row(game_pk, scheduled_start_utc, gf, ga) {
  return {
    game_pk,
    scheduled_start_utc,
    opponent_tri:'ZZZ',
    is_home:1,
    final_goals_for:gf,
    final_goals_against:ga,
    total_goals:gf+ga,
    final_goal_diff:gf-ga,
    final_win:gf>ga?1:0,
  };
}
function assert(value, message) { if (!value) throw new Error(message); }
function assertClose(actual, expected, label) {
  if (Math.abs(Number(actual)-Number(expected)) > 1e-9) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}
