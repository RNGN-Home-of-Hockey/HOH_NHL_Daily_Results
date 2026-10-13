import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, handicapLines, normalizeLine, normalizeStoreEvent, parseBucket, parsePlayerParam, parseTemplate } from '../catalogue.mjs';

const HOME = 'Ноттингем Форест';
const AWAY = 'Арсенал';
// Rows as seen on https://winline.ru/plus/16745863 (Nottingham Forest - Arsenal), 2026-10-13.
const row = (market_id, template, koef, V, R, favorite = 0) => ({ market_id, line_id: 1, template, koef, V, R, favorite });

test('template tokens: period, team scope, line slot', () => {
  assert.deepEqual(parseTemplate('Тотал [a] (@NP@) @1'), { base: 'тотал', period: 'FT', scope: 'home', hasLine: true });
  assert.deepEqual(parseTemplate('@2HT@ тотал [a] @2'), { base: 'тотал', period: '2H', scope: 'away', hasLine: true });
  assert.equal(parseTemplate('@1P@/Матч (@NP@)').period, '1H');
  assert.equal(parseTemplate('@[a]P@ точный счет').period, 'P[a]');
  assert.equal(parseTemplate('Победа @1 (@NP@)').scope, 'home');
});

test('classification covers the families seen on EPL pages', () => {
  const cases = {
    'Исход 1X2 (@NP@)': 'match_result', '@1HT@ двойной шанс': 'double_chance', 'Фора [a] (@NP@)': 'handicap',
    'Европейский гандикап [a] (@NP@)': 'handicap_european', 'Тотал [a] (@NP@) @2': 'total', 'Обе забьют (@NP@)': 'btts',
    'Кол-во голов (@NP@) @1': 'goals_count', 'Мультикол-во голов (@NP@)': 'goals_count', 'Точный счет (@NP@)': 'correct_score',
    'Какая команда забьет (@NP@)': 'team_to_score', 'Следующий гол [a]-й (@NP@)': 'goal_sequence', 'Не пропустит (@NP@) @1': 'clean_sheet',
    'Победит всухую @2 (@NP@)': 'win_to_nil', 'Победит в обоих таймах @1': 'halves', 'Чет/Нечет (@NP@)': 'odd_even',
    'Исход и обе забьют (@NP@)': 'combo', 'Тотал угловых [a] (@NP@)': 'corners', 'Тотал карточек [a] (@NP@)': 'cards',
    'Удаление (@NP@)': 'cards', 'Выйдет и забьет гол (@NP@)': 'player_goal', 'Победа @1 (@NP@)': 'win_yes_no', 'Что-то новое': 'other',
    'Оба тайма больше [a] голов': 'halves', '[a]-й гол и исход (@NP@)': 'combo',
  };
  for (const [template, family] of Object.entries(cases)) assert.equal(classify(parseTemplate(template).base)[0], family, template);
  assert.deepEqual(classify(parseTemplate('Выйдет и забьет первый гол (@NP@)').base), ['player_goal', 'first']);
  assert.deepEqual(classify(parseTemplate('Исход 1X2 в интервале с [a] минут').base), ['match_result', 'interval']);
});

test('1X2 and double chance sides', () => {
  const result = normalizeLine(row(490, 'Исход 1X2 (@NP@)', '', [5.8, 4.1, 1.58], ['1', 'X', '2']), HOME, AWAY);
  assert.deepEqual(result.outcomes.map((o) => [o.side, o.odds]), [['home', 5.8], ['draw', 4.1], ['away', 1.58]]);
  const dc = normalizeLine(row(114, 'Двойной шанс (@NP@)', '', [2.4, 1.24, 1.14], ['1X', '12', 'X2']), HOME, AWAY);
  assert.deepEqual(dc.outcomes.map((o) => o.side), ['home_draw', 'home_away', 'draw_away']);
});

test('handicap: the favourite gives the goals (favorite=2 means the away team)', () => {
  assert.deepEqual(handicapLines('1.5', 2), { home: 1.5, away: -1.5 });
  assert.deepEqual(handicapLines('1.5', 1), { home: -1.5, away: 1.5 });
  assert.deepEqual(handicapLines('0', 0), { home: 0, away: 0 });
  assert.deepEqual(handicapLines('1.5', 0), { home: null, away: null });
  const market = normalizeLine(row(1073, 'Фора [a] (@NP@)', '1.5', [1.48, 2.5], ['1', '2'], 2), HOME, AWAY);
  assert.equal(market.family, 'handicap');
  assert.deepEqual(market.outcomes.map((o) => [o.side, o.line, o.odds]), [['home', 1.5, 1.48], ['away', -1.5, 2.5]]);
});

test('totals: match, team and half, with the exact line', () => {
  const match = normalizeLine(row(1049, 'Тотал [a] (@NP@)', '2.5', [1.9, 1.9], ['Больше', 'Меньше']), HOME, AWAY);
  assert.deepEqual([match.family, match.scope, match.period, match.line], ['total', 'match', 'FT', 2.5]);
  assert.deepEqual(match.outcomes.map((o) => o.side), ['over', 'under']);
  const team = normalizeLine(row(1050, 'Тотал [a] (@NP@) @1', '1.5', [4.1, 1.19], ['Больше', 'Меньше']), HOME, AWAY);
  assert.deepEqual([team.scope, team.line, team.outcomes[0].odds], ['home', 1.5, 4.1]);
  const half = normalizeLine(row(960, '@2HT@ тотал [a]', '0.5', [1.23, 3.6], ['Больше', 'Меньше']), HOME, AWAY);
  assert.deepEqual([half.period, half.scope, half.line], ['2H', 'match', 0.5]);
  const corners = normalizeLine(row(1070, 'Тотал угловых [a] (@NP@)', '8.5', [1.8, 1.95], ['Больше', 'Меньше']), HOME, AWAY);
  assert.deepEqual([corners.family, corners.variant, corners.line], ['corners', 'total', 8.5]);
});

test('team goal buckets and team-to-score fill the team names', () => {
  const buckets = normalizeLine(row(56, 'Кол-во голов (@NP@) @1', '', [2.12, 2.55, 6, 17], ['0 голов', '1 гол', '2 гола', '3 гола и более']), HOME, AWAY);
  assert.deepEqual(buckets.outcomes.map((o) => o.bucket), [{ min: 0, max: 0 }, { min: 1, max: 1 }, { min: 2, max: 2 }, { min: 3, max: null }]);
  assert.deepEqual(parseBucket('1-2'), { min: 1, max: 2 });
  const who = normalizeLine(row(166, 'Какая команда забьет (@NP@)', '', [12, 10, 2.5, 1.96], ['Нет гола', 'Только @1', 'Только @2', 'Обе  ']), HOME, AWAY);
  assert.deepEqual(who.outcomes.map((o) => o.label), ['Нет гола', 'Только Ноттингем Форест', 'Только Арсенал', 'Обе']);
});

test('player goal lines carry the player and one price', () => {
  assert.deepEqual(parsePlayerParam('2@ Жюльен Тео/1'), { team: 'away', name: 'Жюльен Тео', number: 1 });
  assert.deepEqual(parsePlayerParam('1@ Макс Доумен'), { team: 'home', name: 'Макс Доумен', number: null });
  assert.equal(parsePlayerParam('2.5'), null);
  const market = normalizeLine(row(197, 'Выйдет и забьет гол (@NP@)', '2@ Макс Доумен', [4.2], ['Да', 'Нет']), HOME, AWAY);
  assert.deepEqual([market.family, market.variant, market.scope, market.subject.name], ['player_goal', 'anytime', 'player', 'Макс Доумен']);
  assert.deepEqual(market.outcomes, [{ index: 0, label: 'Да', odds: 4.2, side: 'yes' }]);
});

test('european handicap keeps its starting score', () => {
  const market = normalizeLine(row(1080, 'Европейский гандикап [a] (@NP@)', '0:1', [15, 6.6, 1.13], ['1', 'X', '2']), HOME, AWAY);
  assert.deepEqual([market.family, market.start_score], ['handicap_european', [0, 1]]);
});

test('event normalization drops rows without usable odds and counts families', () => {
  const event = normalizeStoreEvent({
    event_id: 16745863, members: [HOME, AWAY], start_time: '2026-10-18T15:30:00Z', championship_id: 1,
    rows: [
      row(490, 'Исход 1X2 (@NP@)', '', [5.8, 4.1, 1.58], ['1', 'X', '2']),
      row(1049, 'Тотал [a] (@NP@)', '2.5', [1.9, 1.9], ['Больше', 'Меньше']),
      row(197, 'Выйдет и забьет гол (@NP@)', '2@ Тео', [6.4], ['Да', 'Нет']),
      row(58, 'Обе забьют (@NP@)', '', [], ['Да', 'Нет']),
      row(58, 'Обе забьют (@NP@)', '', [1, 1.5], ['Да', 'Нет']),
    ],
  });
  assert.equal(event.markets.length, 3);
  assert.deepEqual(event.summary, { market_lines: 3, market_types: 3, player_lines: 1, by_family: { match_result: 1, total: 1, player_goal: 1 } });
});
