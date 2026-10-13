// Winline football market catalogue: turns the lines of the site's own data store into normalized markets.
//
// One input row is one line of one market type, as `window.apiWlb.getEvents().byId(id).linesByIdTipMarkets`
// holds it:
//   { market_id, line_id, koef, V, R, favorite, template }
//   koef      line parameter as the site stores it: "2.5", "0:1", "1-10", "2@ Player Name/9" or ""
//   V         odds, one per selection (a player line carries only the "Да" price)
//   R         selection labels; "@1"/"@2" stand for the team names
//   favorite  0, 1 or 2: the team the site marks as favourite; it decides who gets the minus of a handicap
//   template  tipLine.freeTextR, e.g. "@1HT@ тотал [a] @2" (@NP@ full time, @1HT@/@1P@ first half,
//             @2HT@/@2P@ second half, trailing @1/@2 home/away team, [a] the line parameter)
//
// Output markets never invent anything: unknown templates stay family "other" with the site's own labels.

export const FAMILIES = [
  'match_result', 'double_chance', 'handicap', 'handicap_european', 'total', 'btts', 'goals_count', 'correct_score',
  'team_to_score', 'goal_sequence', 'clean_sheet', 'win_to_nil', 'win_yes_no', 'halves', 'odd_even', 'combo',
  'corners', 'cards', 'player_goal', 'other',
];

export function parseTemplate(template) {
  let text = String(template || '').trim();
  let period = 'FT';
  const token = text.match(/@(\d|\[a\])(HT|P)@/);
  if (token) {
    period = token[1] === '[a]' ? 'P[a]' : token[1] === '1' ? '1H' : token[1] === '2' ? '2H' : `P${token[1]}`;
    text = text.replace(token[0], ' ');
  }
  text = text.replace(/@NP@/g, ' ');
  let scope = 'match';
  const team = text.match(/\s@([12])(?![A-Za-z0-9@])/);
  if (team) {
    scope = team[1] === '1' ? 'home' : 'away';
    text = text.replace(team[0], ' ');
  }
  const hasLine = /\[a\]/.test(text);
  const base = text.replace(/\[a\]/g, ' ').replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return { base, period, scope, hasLine };
}

export function classify(base) {
  if (/выйдет и забьет первый гол/.test(base)) return ['player_goal', 'first'];
  if (/выйдет и забьет последний гол/.test(base)) return ['player_goal', 'last'];
  if (/выйдет и забьет гол/.test(base)) return ['player_goal', 'anytime'];
  if (/углов/.test(base)) return ['corners', cornerOrCardVariant(base)];
  if (/карточ|удален/.test(base)) return ['cards', /удален/.test(base) ? 'red_card' : cornerOrCardVariant(base)];
  if (/европейский гандикап/.test(base)) return ['handicap_european', null];
  if (/(двойной шанс|исход).*(обе забьют|тотал)|обе забьют.*тотал|\/матч|победа с разницей|гол и исход/.test(base)) return ['combo', null];
  if (/двойной шанс/.test(base)) return ['double_chance', null];
  if (/исход 1x2 в интервале/.test(base)) return ['match_result', 'interval'];
  if (/исход 1x2/.test(base)) return ['match_result', null];
  if (/обе забьют/.test(base)) return ['btts', null];
  if (/^фора/.test(base)) return ['handicap', null];
  if (/тотал/.test(base)) return ['total', null];
  if (/чет\/нечет/.test(base)) return ['odd_even', null];
  if (/точный счет|мультисчет/.test(base)) return ['correct_score', null];
  if (/кол-во голов/.test(base)) return ['goals_count', /мульти/.test(base) ? 'range' : /точное/.test(base) ? 'exact' : 'bucket'];
  if (/какая команда забьет/.test(base)) return ['team_to_score', null];
  if (/(следующий|первый|последний) гол/.test(base)) return ['goal_sequence', /интервал/.test(base) ? 'interval' : /последний/.test(base) ? 'last' : /следующий/.test(base) ? 'next' : 'first'];
  if (/не пропустит/.test(base)) return ['clean_sheet', null];
  if (/победит всухую/.test(base)) return ['win_to_nil', null];
  if (/оба тайма (больше|меньше)/.test(base)) return ['halves', 'both_halves_total'];
  if (/победит в (обоих|одном)|забьет в обоих|результативный тайм|в каком тайме/.test(base)) return ['halves', null];
  if (/^победа|любая команда победит/.test(base)) return ['win_yes_no', null];
  return ['other', null];
}

function cornerOrCardVariant(base) {
  if (/исход 1x2/.test(base)) return 'result';
  if (/фора/.test(base)) return 'handicap';
  if (/тотал/.test(base)) return 'total';
  if (/кол-во/.test(base)) return 'count';
  if (/чет\/нечет/.test(base)) return 'odd_even';
  if (/последн/.test(base)) return 'last';
  if (/подаст|-ая|карточка$/.test(base)) return 'nth';
  return 'other';
}

const fillTeams = (label, home, away) => String(label ?? '').replace(/@1/g, home).replace(/@2/g, away).replace(/\s+/g, ' ').trim();

export function parsePlayerParam(koef) {
  const match = String(koef ?? '').match(/^(\d)@\s*(.+?)(?:\/(\d+))?\s*$/);
  if (!match) return null;
  return { team: match[1] === '1' ? 'home' : 'away', name: match[2].trim(), number: match[3] ? Number(match[3]) : null };
}

export function parseBucket(label) {
  const text = String(label || '');
  const range = text.match(/^(\d+)\s*-\s*(\d+)/);
  if (range) return { min: Number(range[1]), max: Number(range[2]) };
  const open = text.match(/^(\d+)\s*(\+|гол[а-я]*\s+и более|и более)/);
  if (open) return { min: Number(open[1]), max: null };
  const one = text.match(/^(\d+)/);
  return one ? { min: Number(one[1]), max: Number(one[1]) } : null;
}

// Handicap side signs: the site stores the absolute size; the team it marks as favourite gives the goals.
export function handicapLines(koef, favorite) {
  const size = Number(koef);
  if (!Number.isFinite(size)) return { home: null, away: null };
  if (size === 0) return { home: 0, away: 0 };
  if (Number(favorite) === 1) return { home: -size, away: size };
  if (Number(favorite) === 2) return { home: size, away: -size };
  return { home: null, away: null };
}

const SIDES = {
  match_result: ['home', 'draw', 'away'],
  handicap_european: ['home', 'draw', 'away'],
  double_chance: ['home_draw', 'home_away', 'draw_away'],
  btts: ['yes', 'no'],
  total: ['over', 'under'],
};

export function normalizeLine(row, home, away) {
  const parsed = parseTemplate(row.template);
  const [family, variant] = classify(parsed.base);
  const odds = Array.isArray(row.V) ? row.V : [];
  const labels = (row.R || []).filter((label) => label !== '' && label != null);
  const koef = String(row.koef ?? '');
  const market = {
    key: `${row.market_id}:${koef}`, market_id: Number(row.market_id), line_id: row.line_id ?? null,
    family, variant, period: parsed.period, scope: parsed.scope, param: koef || null, line: null,
    template: row.template || '', outcomes: [],
  };
  const isTotal = family === 'total' || (family === 'corners' || family === 'cards') && variant === 'total';
  const isHandicap = family === 'handicap' || family === 'corners' && variant === 'handicap';
  if (family === 'player_goal') {
    market.subject = parsePlayerParam(koef);
    market.scope = 'player';
    market.outcomes = odds.length ? [{ index: 0, label: 'Да', odds: Number(odds[0]), side: 'yes' }] : [];
    return market;
  }
  if (isHandicap) {
    const lines = handicapLines(koef, row.favorite);
    market.favorite = Number(row.favorite) || 0;
    market.outcomes = odds.map((price, index) => ({
      index, label: fillTeams(labels[index], home, away), odds: Number(price),
      side: index === 0 ? 'home' : 'away', line: index === 0 ? lines.home : lines.away,
    }));
    return market;
  }
  if (family === 'handicap_european') {
    const start = koef.match(/^(\d+):(\d+)$/);
    market.start_score = start ? [Number(start[1]), Number(start[2])] : null;
  }
  const numericLine = Number(koef);
  if (koef !== '' && Number.isFinite(numericLine) && parsed.hasLine && (isTotal || family === 'odd_even')) market.line = numericLine;
  const sides = isTotal ? SIDES.total : SIDES[family] || null;
  market.outcomes = odds.map((price, index) => {
    const label = fillTeams(labels[index], home, away);
    const outcome = { index, label, odds: Number(price), side: sides ? sides[index] ?? null : null };
    if (family === 'goals_count') outcome.bucket = parseBucket(label);
    if (market.line !== null) outcome.line = market.line;
    return outcome;
  });
  return market;
}

export function normalizeStoreEvent(raw) {
  const [home, away] = raw.members || [];
  const markets = (raw.rows || [])
    .filter((row) => Array.isArray(row.V) && row.V.length > 0)
    .map((row) => normalizeLine(row, home, away))
    .filter((market) => market.outcomes.length && market.outcomes.every((o) => Number.isFinite(o.odds) && o.odds > 1));
  const byFamily = {};
  for (const market of markets) byFamily[market.family] = (byFamily[market.family] || 0) + 1;
  return {
    event_id: raw.event_id, home, away, starts_at: raw.start_time || null,
    championship_id: raw.championship_id ?? null, markets,
    summary: {
      market_lines: markets.length, market_types: new Set(markets.map((m) => m.market_id)).size,
      player_lines: markets.filter((m) => m.family === 'player_goal').length, by_family: byFamily,
    },
  };
}
