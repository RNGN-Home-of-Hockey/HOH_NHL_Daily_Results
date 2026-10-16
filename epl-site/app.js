// HOH Football operator console v2 (light theme). Static page: reads data/site.json built by tools/epl_site_data.py.
// Pages: Лента (every card of every match with filters), Матчи (one match in depth), Игроки (Winline player lines
// against our numbers), Команды (club profiles). Nothing here talks to Winline or to the broadcast: the operator
// picks cards for the "Эфир" queue. Plate designs (Winline) replace the placeholder preview later.

import { cropPlate, oddsText, renderPlate, toBlob } from './plate.js';

const DATA_URL = 'data/site.json';
const QUEUE_KEY = 'hoh-epl-queue-v1';
const UI_KEY = 'hoh-epl-ui-v2';
const AUTO_RELOAD_MS = 5 * 60 * 1000;
const FEED_PAGE = 60;
const MSK = { timeZone: 'Europe/Moscow' };
const timeFmt = new Intl.DateTimeFormat('ru-RU', { ...MSK, hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('ru-RU', { ...MSK, weekday: 'short', day: 'numeric', month: 'long' });
const shortDayFmt = new Intl.DateTimeFormat('ru-RU', { ...MSK, weekday: 'short', day: 'numeric', month: 'short' });
const dayKeyFmt = new Intl.DateTimeFormat('en-CA', MSK);

const TIER_ORDER = ['fire', 'strong', 'solid', 'background'];
const TIER_HINT = {
  fire: 'Огонь — сильнейшая история при хорошей цене, просится в эфир',
  strong: 'Сильная — убедительный факт, кэф заметно выше, чем говорит история',
  solid: 'Рабочая — нормальный факт для заполнения эфира',
  background: 'Фон — справочно, для подводок и контекста',
};
const POSITION = { G: 'Вратарь', D: 'Защитник', M: 'Полузащитник', F: 'Нападающий' };
const FAMILY = {
  match_result: 'Исход', double_chance: 'Двойной шанс', handicap: 'Фора', handicap_european: 'Европейский гандикап', total: 'Тоталы',
  btts: 'Обе забьют', goals_count: 'Количество голов', correct_score: 'Точный счёт', team_to_score: 'Какая команда забьёт',
  goal_sequence: 'Первый / следующий / последний гол', clean_sheet: 'Не пропустит', win_to_nil: 'Победа всухую',
  win_yes_no: 'Победа (да / нет)', halves: 'Таймы', odd_even: 'Чёт / нечёт', combo: 'Комбо', corners: 'Угловые', cards: 'Карточки',
  player_goal: 'Игроки', other: 'Прочее',
};
const FAMILY_ORDER = Object.keys(FAMILY);
const PERIOD_ORDER = { FT: 0, '1H': 1, '2H': 2 };
const DETAIL_LABELS = {
  results_newest_first: 'Результаты (новые слева)', totals_newest_first: 'Голов в матче (новые слева)', goals_newest_first: 'Голы команды (новые слева)',
  values_vs_opponent_newest_first: 'Значения против этого соперника', mean_vs_opponent: 'В среднем против этого соперника',
  mean_vs_others: 'В среднем против остальных', metric: 'Показатель', goals_by_gameweek: 'Голы по матчам (новые справа)',
  xg_per_90: 'xG за 90 минут (с поправкой)', expected_minutes: 'Ожидаемые минуты', goals: 'Голы по встречам (новые слева)',
};
const STAT_ROWS = [
  ['goals_for', 'Голы забито'], ['goals_against', 'Голы пропущено'], ['xg_proxy', 'xG (модель, без пенальти)'], ['shots', 'Удары'], ['shots_on_target', 'В створ'],
  ['shots_inside_box', 'Удары из штрафной'], ['touches_in_opp_box', 'Касания в штрафной соперника'], ['possession_pct', 'Владение, %'],
  ['corners_won', 'Угловые'], ['yellow_cards', 'Жёлтые карточки'], ['ppda', 'PPDA (чем меньше, тем жёстче прессинг)'],
  ['xg_proxy_against', 'xG соперника (модель)'], ['shots_against', 'Удары соперника'], ['shots_inside_box_against', 'Удары соперника из штрафной'],
];
const LOWER_IS_BETTER = new Set(['goals_against', 'ppda', 'shots_against', 'shots_inside_box_against', 'xg_proxy_against']);
const FEED_SORTS = [['score', 'Сначала самые крутые'], ['drop', 'Кэф упал сильнее всего'], ['kickoff', 'По времени матча'], ['odds_desc', 'Кэф: сначала высокие'], ['odds_asc', 'Кэф: сначала низкие'], ['sample', 'Самая большая выборка']];
const TEAM_COLUMNS = [
  ['name', 'Команда'], ['form', 'Форма'], ['points', 'В-Н-П'], ['unbeaten_run', 'Без пор.'],
  ['goals_for', 'Забито'], ['goals_against', 'Пропущено'], ['xg_for', 'xG'], ['xg_against', 'xG соп.'],
  ['over_2_5', 'ТБ 2,5'], ['btts', 'Обе'], ['clean_sheets', 'Сухие'], ['failed_to_score', 'Не забил'],
  ['first_half_goals', 'Голы 1 т.'], ['second_half_goals', 'Голы 2 т.'], ['scores_first', 'Открывает'],
  ['corners_for', 'Угл.'], ['cards', 'Карт.'], ['hot', 'Карточки'], ['next', 'Следующий матч'],
];
const PERCENT_KEYS = new Set(['over_2_5', 'btts', 'clean_sheets', 'failed_to_score', 'scores_first']);
const ASCENDING_FIRST = new Set(['anytime', 'first', 'last', 'kickoff', 'name', 'next', 'goals_against', 'xg_against', 'failed_to_score']);

const defaults = () => ({
  page: 'feed',
  feed: { tiers: ['fire', 'strong', 'solid'], category: 'all', basis: 'all', match: 'all', team: 'all', minOdds: '', maxOdds: '', query: '', sort: 'score' },
  players: { match: 'all', team: 'all', position: 'all', query: '', sort: 'score', dir: -1, withModel: false, withCard: false },
  teams: { sort: 'hot', dir: -1 },
});
const state = {
  data: null, cards: [], playerRows: [], selected: null, tab: 'tips', tipTier: 'all', tipCategory: 'all', query: '', family: 'all', side: 'all',
  feedLimit: FEED_PAGE, filtersOpen: false, plateIndex: 0, open: new Set(), queue: loadJson(QUEUE_KEY, []), ...mergeUi(loadJson(UI_KEY, {})),
};

const $ = (selector, root = document) => root.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const odds = (value) => (value == null ? '—' : Number(value).toFixed(2));
const num = (value, digits = 1) => (value == null ? '—' : Number(value).toFixed(digits).replace('.', ','));
const line = (value) => String(value).replace('.', ',');
const signed = (value) => (value == null ? '' : value > 0 ? `+${line(value)}` : value < 0 ? `−${line(Math.abs(value))}` : '0');
const pct = (value) => (value == null ? '—' : `${Math.round(value * 100)}%`);
const lineKey = (mk) => mk.line ?? (Number.isFinite(Number(mk.param)) ? Number(mk.param) : 0);
const starsText = (n) => '★'.repeat(n) + '☆'.repeat(Math.max(0, 5 - n));
const kickoff = (m) => `${shortDayFmt.format(new Date(m.starts_at))}, ${timeFmt.format(new Date(m.starts_at))}`;
const fullName = (club) => club.name_full || club.name_ru;
const pairName = (m) => `${fullName(m.home)} — ${fullName(m.away)}`;
const WEEK_MS = 7 * 24 * 3600 * 1000;
const tierLabel = (id) => state.data?.tiers.find((t) => t.id === id)?.label || id;
const MOVE_MIN = 0.03;  // a price change below 3% is noise
const moveOf = (now, was) => (was && now ? now / was - 1 : 0);
function moveBadge(now, was) {
  const change = moveOf(now, was);
  if (Math.abs(change) < MOVE_MIN) return '';
  const since = state.data?.move_since ? ` (${kickoff({ starts_at: state.data.move_since })} МСК)` : '';
  return `<span class="move ${change < 0 ? 'down' : 'up'}" title="Кэф Winline был ${odds(was)}${since}: ${change < 0 ? 'падает — в рынок заходят деньги' : 'растёт'}">${change < 0 ? '↓' : '↑'} было ${odds(was)}</span>`;
}
const resultPill = (c) => `<span class="fpill ${c}">${c === 'W' ? 'П' : c === 'D' ? 'Н' : 'Л'}</span>`;

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; }
}
function saveJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage may be blocked: everything still works in memory */ }
}
function mergeUi(saved) {
  const base = defaults();
  return { page: saved.page || base.page, feed: { ...base.feed, ...(saved.feed || {}) }, players: { ...base.players, ...(saved.players || {}) },
    teams: { ...base.teams, ...(saved.teams || {}) } };
}
const saveUi = () => saveJson(UI_KEY, { page: state.page, feed: state.feed, players: state.players, teams: state.teams });
const saveQueue = () => saveJson(QUEUE_KEY, state.queue);

function mono(club) {
  const words = String(club.name_ru || club.name).split(/\s+/);
  const letters = (words.length > 1 ? words.map((w) => w[0]).join('') : words[0].slice(0, 2)).slice(0, 2).toUpperCase();
  const hue = (club.id * 47) % 360;
  return `<span class="mono" style="background:hsl(${hue} 70% 93%);color:hsl(${hue} 55% 30%)">${esc(letters)}</span>`;
}

const match = () => state.data?.matches.find((m) => m.event_id === state.selected) || null;
const cardId = (m, c) => `${m.event_id}|${c.rule}|${c.market.key}`;
function findCard(id) {
  const [eventId, rule, ...rest] = id.split('|');
  const key = rest.join('|');
  const m = state.data?.matches.find((x) => String(x.event_id) === eventId);
  const c = m?.insights.find((x) => x.rule === rule && x.market.key === key);
  return m && c ? { m, c } : null;
}

function chipRow(action, current, items) {
  return items.map(([value, label, count]) => `<button class="chip-btn" data-action="${action}" data-value="${esc(value)}" aria-pressed="${current === value}">${esc(label)}${count != null ? ` · ${count}` : ''}</button>`).join('');
}

// ---------- header ----------
function freshness() {
  const captured = state.data?.winline_captured_at;
  if (!captured) return { cls: 'bad', text: 'Линии Winline: нет данных', short: 'нет данных' };
  const minutes = Math.max(0, Math.round((Date.now() - new Date(captured).getTime()) / 60000));
  const when = timeFmt.format(new Date(captured));
  const ago = minutes < 60 ? `${minutes} мин назад` : minutes < 2880 ? `${Math.floor(minutes / 60)} ч ${minutes % 60} мин назад` : `${Math.floor(minutes / 1440)} дн назад`;
  const cls = minutes < 20 ? 'good' : minutes < 90 ? 'warn' : 'bad';
  return { cls, text: `Линии Winline: ${when} МСК · ${ago}`, short: `${when} МСК · ${ago}` };
}
const freshHtml = (f) => `<i></i><span class="wide-only">Линии Winline:&nbsp;</span>${esc(f.short || f.text)}`;

function renderHeader() {
  const f = freshness();
  const stats = state.data?.generated_at ? timeFmt.format(new Date(state.data.generated_at)) : '—';
  const nav = [['feed', 'Лента', state.cards.length], ['matches', 'Матчи', state.data?.matches.length], ['players', 'Игроки', state.playerRows.length],
    ['teams', 'Команды', state.data?.teams.length]];
  $('#top').innerHTML = `
    <div class="brand"><span class="brand-mark">HOH</span><div>Футбол · АПЛ<small>пульт оператора</small></div></div>
    <nav class="nav" aria-label="Разделы">${nav.map(([id, label, count]) =>
      `<button class="nav-btn" data-action="page" data-page="${id}" aria-current="${state.page === id}">${label}${count ? `<span class="count">${count}</span>` : ''}</button>`).join('')}</nav>
    <div class="status">
      <span class="pill ${f.cls}" id="fresh" title="${esc(f.text)}">${freshHtml(f)}</span>
      <span class="pill wide-only"><i></i>Данные: ${stats} МСК</span>
      <button class="btn phone-only" data-action="to-dock">Эфир · ${state.queue.length}</button>
      <button class="btn" data-action="reload">Обновить</button>
    </div>`;
}

// ---------- strip: the week's matches as buttons (feed and players filter, match page navigation on phones) ----------
function weekMatches() {
  const matches = state.data?.matches || [];
  const now = Date.now();
  const week = matches.filter((m) => { const t = new Date(m.starts_at).getTime(); return t >= now - 3 * 3600 * 1000 && t < now + WEEK_MS; });
  return week.length ? week : matches.slice(0, 10);
}

function renderStrip() {
  const strip = $('#strip');
  if (!state.data || state.page === 'teams') { strip.innerHTML = ''; return; }
  const current = state.page === 'feed' ? state.feed.match : state.page === 'players' ? state.players.match : String(state.selected);
  const count = (m) => (state.page === 'players' ? m.players.length : m.insights.length);
  const hot = (m) => m.insights.filter((c) => c.tier === 'fire' || c.tier === 'strong').length;
  const unit = state.page === 'players' ? 'игроков' : 'карточек';
  const all = state.page === 'matches' ? '' : `<button class="wk all" data-action="strip" data-value="all" aria-pressed="${current === 'all'}">
      <span class="wk-date">Все матчи</span><span class="wk-team">${state.page === 'players' ? state.playerRows.length : state.cards.length}</span><span class="wk-count">${unit}</span></button>`;
  strip.innerHTML = `<h4>Матчи недели</h4><div class="week">${all}${weekMatches().map((m) => `
    <button class="wk" data-action="strip" data-value="${m.event_id}" aria-pressed="${current === String(m.event_id)}" title="${esc(pairName(m))}">
      <span class="wk-date">${m.live ? '<span class="live-dot"></span>' : ''}${esc(kickoff(m))}</span>
      <span class="wk-team">${esc(fullName(m.home))}</span><span class="wk-team">${esc(fullName(m.away))}</span>
      <span class="wk-count">${count(m)} ${unit}${hot(m) ? ` · ${hot(m)}★` : ''}</span></button>`).join('')}</div>`;
}

// ---------- card (used by the feed and the match page) ----------
function tierBadge(c) {
  return `<div class="tierb" data-tier="${c.tier}" title="${esc(TIER_HINT[c.tier] || '')}. Оценка ${c.score} из 100 — редакционная ценность, не вероятность">
    <b class="num">${c.score}</b><span>${esc(c.tier_label)}</span><i aria-hidden="true">${starsText(c.stars)}</i></div>`;
}

function detailValue(key, value) {
  if (key === 'results_newest_first') return [...value].map(resultPill).join('');
  if (Array.isArray(value)) return value.join(' · ');
  return esc(typeof value === 'number' ? num(value, 2) : value);
}

function cardHtml(m, c, { showMatch = false } = {}) {
  const id = cardId(m, c);
  const queued = state.queue.some((q) => q.id === id);
  const e = c.evidence;
  const alts = (c.alternatives || []).map((a) => `<span>${esc(a.label)} · <b class="num">${odds(a.odds)}</b></span>`).join('');
  const details = Object.entries(c.details || {}).filter(([k]) => DETAIL_LABELS[k]).map(([k, v]) => `<dt>${esc(DETAIL_LABELS[k])}</dt><dd>${detailValue(k, v)}</dd>`).join('');
  return `<article class="tip" data-tier="${c.tier}">
    ${tierBadge(c)}
    <div class="tip-body">
      ${showMatch ? `<div class="tip-match"><button class="linkish" data-action="open-match" data-id="${m.event_id}">${mono(m.home)}${esc(fullName(m.home))} — ${esc(fullName(m.away))}${mono(m.away)}</button><span class="faint">${esc(kickoff(m))} МСК</span></div>` : ''}
      <div class="tip-meta"><span class="tag cat">${esc(c.category)}</span><span class="tag basis">${esc(c.basis)}</span>${(c.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
      <h3>${esc(c.title)}</h3>
      ${c.support?.length ? `<div class="support"><b>Ещё в пользу этой ставки:</b> ${c.support.map(esc).join(' · ')}</div>` : ''}
      <div class="evidence">История <b class="num">${e.hits} из ${e.sample}</b> (${pct(e.rate)}, осторожно ${pct(e.rate_conservative)}) · цена Winline подразумевает <b class="num">${pct(e.implied_by_price)}</b>${e.span ? ` · ${esc(e.span)}` : ''}</div>
      <div class="tip-market"><span class="label">${esc(c.market.label)}</span>${moveBadge(c.market.odds, c.market.was)}<span class="odds num">${odds(c.market.odds)}</span>${alts ? `<div class="alts">Ещё линии: ${alts}</div>` : ''}</div>
    </div>
    <div class="tip-actions">
      <button class="btn ${queued ? 'on' : 'primary'}" data-action="queue" data-card="${esc(id)}">${queued ? 'В эфире ✓' : 'В эфир'}</button>
      <button class="btn" data-action="copy-card" data-card="${esc(id)}">Копировать</button>
      <button class="btn ghost" data-action="details" data-card="${esc(id)}">${state.open.has(id) ? 'Скрыть' : 'Детали'}</button>
    </div>
    <div class="tip-details" ${state.open.has(id) ? '' : 'hidden'}><dl class="kv">${details}<dt>Окно данных</dt><dd>${esc(e.window)}</dd>
      <dt>Почему такой уровень</dt><dd>${esc((c.reasons || []).join(' · '))}</dd>
      <dt>Рынок Winline</dt><dd>№${c.market.market_id}${c.market.line != null ? ` · линия ${line(c.market.line)}` : ''}</dd></dl></div>
  </article>`;
}

// ---------- page: Лента ----------
function feedMatches({ m, c }) {
  const f = state.feed;
  if (!f.tiers.includes(c.tier)) return false;
  if (f.category !== 'all' && c.category !== f.category) return false;
  if (f.basis !== 'all' && c.basis !== f.basis) return false;
  if (f.match !== 'all' && String(m.event_id) !== f.match) return false;
  if (f.team !== 'all' && String(m.home.id) !== f.team && String(m.away.id) !== f.team) return false;
  const lo = parseFloat(String(f.minOdds).replace(',', '.')), hi = parseFloat(String(f.maxOdds).replace(',', '.'));
  if (Number.isFinite(lo) && c.market.odds < lo) return false;
  if (Number.isFinite(hi) && c.market.odds > hi) return false;
  const q = f.query.trim().toLowerCase();
  return !q || `${c.title} ${c.market.label} ${pairName(m)}`.toLowerCase().includes(q);
}

function feedSorted(list) {
  const by = {
    score: (a, b) => b.c.score - a.c.score || b.c.evidence.sample - a.c.evidence.sample,
    drop: (a, b) => moveOf(a.c.market.odds, a.c.market.was) - moveOf(b.c.market.odds, b.c.market.was) || b.c.score - a.c.score,
    kickoff: (a, b) => a.m.starts_at.localeCompare(b.m.starts_at) || b.c.score - a.c.score,
    odds_desc: (a, b) => b.c.market.odds - a.c.market.odds || b.c.score - a.c.score,
    odds_asc: (a, b) => a.c.market.odds - b.c.market.odds || b.c.score - a.c.score,
    sample: (a, b) => b.c.evidence.sample - a.c.evidence.sample || b.c.score - a.c.score,
  }[state.feed.sort] || ((a, b) => b.c.score - a.c.score);
  return [...list].sort(by);
}

function renderFeedSide() {
  const f = state.feed;
  const all = state.cards;
  const count = (fn) => all.filter(fn).length;
  const tiers = TIER_ORDER.map((t) => `<button class="tier-chip" data-tier="${t}" data-action="feed-tier" data-value="${t}" aria-pressed="${f.tiers.includes(t)}" title="${esc(TIER_HINT[t])}">
      <span>${esc(tierLabel(t))}</span><b class="num">${count((x) => x.c.tier === t)}</b></button>`).join('');
  const cats = [['all', 'Все', all.length], ...(state.data?.categories || []).map((cat) => [cat, cat, count((x) => x.c.category === cat)])].filter(([, , n]) => n);
  const bases = [['all', 'Все', null], ...(state.data?.bases || []).map((b) => [b, b, count((x) => x.c.basis === b)])].filter(([, , n]) => n !== 0);
  const teamOptions = [...(state.data?.teams || [])].sort((a, b) => a.name_ru.localeCompare(b.name_ru, 'ru'))
    .map((t) => `<option value="${t.id}" ${f.team === String(t.id) ? 'selected' : ''}>${esc(t.name_ru)}</option>`).join('');
  const presets = [['', '', 'любой'], ['2', '', 'от 2,00'], ['3', '', 'от 3,00'], ['1.5', '2.5', '1,50–2,50']];
  $('#side').innerHTML = `
    <div class="side-head phone-only"><b>Фильтры</b><button class="btn primary" id="filters-done" data-action="toggle-filters">Показать</button></div>
    <div class="fgroup"><h4>Крутизна</h4><div class="tier-chips">${tiers}</div></div>
    <div class="fgroup"><h4>Рынок</h4><div class="chips">${chipRow('feed-category', f.category, cats)}</div></div>
    <div class="fgroup"><h4>Основание</h4><div class="chips">${chipRow('feed-basis', f.basis, bases)}</div></div>
    <div class="fgroup"><h4>Поиск</h4><input type="search" data-input="feed-query" placeholder="Игрок, рынок, слово" value="${esc(f.query)}" aria-label="Поиск по карточкам"></div>
    <div class="fgroup"><h4>Команда</h4><select data-input="feed-team" aria-label="Команда"><option value="all">Все команды</option>${teamOptions}</select></div>
    <div class="fgroup"><h4>Кэф Winline</h4><div class="range"><input type="text" inputmode="decimal" data-input="feed-min" placeholder="от" value="${esc(f.minOdds)}" aria-label="Кэф от">
      <span>—</span><input type="text" inputmode="decimal" data-input="feed-max" placeholder="до" value="${esc(f.maxOdds)}" aria-label="Кэф до"></div>
      <div class="chips">${presets.map(([lo, hi, label]) =>
        `<button class="chip-btn" data-action="feed-odds" data-lo="${lo}" data-hi="${hi}" aria-pressed="${f.minOdds === lo && f.maxOdds === hi}">${label}</button>`).join('')}</div></div>
    <div class="fgroup"><button class="btn ghost" data-action="feed-reset">Сбросить фильтры</button></div>`;
}

function renderFeedList() {
  const shown = feedSorted(state.cards.filter(feedMatches));
  const body = shown.slice(0, state.feedLimit).map(({ m, c }) => cardHtml(m, c, { showMatch: true })).join('');
  const rest = shown.length - state.feedLimit;
  const more = rest > 0 ? `<button class="btn more" data-action="feed-more">Показать ещё ${Math.min(FEED_PAGE, rest)} (осталось ${rest})</button>` : '';
  $('#feed-list').innerHTML = (body || '<div class="empty">Ничего не нашлось. Ослабьте фильтры: добавьте уровни «Рабочая» и «Фон» или расширьте диапазон кэфа.</div>') + more;
  $('#feed-count').textContent = `${shown.length} из ${state.cards.length}`;
  const f = state.feed, base = defaults().feed;
  const active = ['category', 'basis', 'team', 'minOdds', 'maxOdds', 'query'].filter((k) => f[k] !== base[k]).length + (f.tiers.join() !== base.tiers.join() ? 1 : 0);
  const button = $('#filters-btn');
  if (button) button.textContent = `Фильтры${active ? ` · ${active}` : ''}`;
  const done = $('#filters-done');
  if (done) done.textContent = `Показать ${shown.length}`;
}

function renderFeed() {
  renderFeedSide();
  const f = state.feed;
  $('#main').innerHTML = `<section class="card panel">
      <div class="toolbar"><button class="btn phone-only" id="filters-btn" data-action="toggle-filters">Фильтры</button>
        <select data-input="feed-sort" aria-label="Сортировка">${FEED_SORTS.map(([v, label]) => `<option value="${v}" ${f.sort === v ? 'selected' : ''}>${label}</option>`).join('')}</select>
        <span class="faint" id="feed-count"></span></div>
      <p class="plate-note wide-only">Каждая карточка — факт из нашей базы, привязанный к линии, которую Winline сейчас реально даёт на матч. Крутизна: Огонь ≥ 80, Сильная ≥ 65, Рабочая ≥ 50, Фон ≥ 35 (сила истории против цены, выборка, кэф, яркость факта). Сильная и Огонь — только если факт повторился хотя бы 4 раза. Кэф в карточках — не ниже 1,50. Стрелка ↓/↑ «было» — как кэф изменился примерно за сутки (от 3%).</p>
    </section><div class="list" id="feed-list"></div>`;
  renderFeedList();
}

// ---------- page: Матчи ----------
function renderRail() {
  const matches = state.data?.matches || [];
  if (!matches.length) { $('#side').innerHTML = '<div class="empty">Матчей нет</div>'; return; }
  let html = '';
  let lastDay = '';
  for (const m of matches) {
    const day = dayKeyFmt.format(new Date(m.starts_at));
    if (day !== lastDay) { html += `<div class="day">${esc(dayFmt.format(new Date(m.starts_at)))}</div>`; lastDay = day; }
    const top = m.insights[0];
    const hot = m.insights.filter((c) => c.tier === 'fire' || c.tier === 'strong').length;
    const x = m.quick.x12;
    html += `<button class="match" data-action="select" data-id="${m.event_id}" aria-current="${m.event_id === state.selected}">
      <div class="time num">${timeFmt.format(new Date(m.starts_at))}<small>МСК</small></div>
      <div class="teams"><div class="team">${mono(m.home)}<span>${esc(fullName(m.home))}</span></div><div class="team">${mono(m.away)}<span>${esc(fullName(m.away))}</span></div>
        ${x ? `<div class="mini-odds num"><b>${odds(x[0])}</b><b>${odds(x[1])}</b><b>${odds(x[2])}</b></div>` : ''}</div>
      <span class="badge" data-tier="${top?.tier || ''}" title="Лучшая оценка матча; карточек уровня «Сильная» и «Огонь»: ${hot}">${m.live ? '<span class="live-dot"></span>' : ''}${top ? `${top.score}${hot ? ` · ${hot}★` : ''}` : `${m.summary.market_lines} лин.`}</span>
    </button>`;
  }
  $('#side').innerHTML = html;
}

function quickGroups(m) {
  const q = m.quick;
  const group = (title, items) => `<div class="qgroup"><h4>${esc(title)}</h4><div class="qrow num">${items.map(([label, value]) => `<span class="odd"><small>${esc(label)}</small><b>${odds(value)}</b></span>`).join('')}</div></div>`;
  const groups = [];
  if (q.x12) groups.push(group('Исход 1X2', [['П1', q.x12[0]], ['Х', q.x12[1]], ['П2', q.x12[2]]]));
  if (q.dc) groups.push(group('Двойной шанс', [['1Х', q.dc[0]], ['12', q.dc[1]], ['Х2', q.dc[2]]]));
  if (q.total) groups.push(group(`Тотал ${line(q.total.line)}`, [['Больше', q.total.over], ['Меньше', q.total.under]]));
  if (q.btts) groups.push(group('Обе забьют', [['Да', q.btts[0]], ['Нет', q.btts[1]]]));
  return groups.join('');
}

function renderHead(m) {
  const tiers = TIER_ORDER.map((t) => [t, m.insights.filter((c) => c.tier === t).length]).filter(([, n]) => n);
  return `<section class="card head">
    <div class="head-top">
      <div class="versus">${mono(m.home)}<span>${esc(fullName(m.home))}</span><span class="vs">—</span>${mono(m.away)}<span>${esc(fullName(m.away))}</span></div>
      <div class="kick"><b class="num">${timeFmt.format(new Date(m.starts_at))} МСК</b>${esc(dayFmt.format(new Date(m.starts_at)))} · АПЛ</div>
    </div>
    <div class="quick">${quickGroups(m)}</div>
    ${tiers.length ? `<div class="tier-sum">${tiers.map(([t, n]) => `<span class="tier-dot" data-tier="${t}">${esc(tierLabel(t))} <b class="num">${n}</b></span>`).join('')}</div>` : ''}
  </section>`;
}

function tabs(m) {
  const items = [
    ['tips', 'Карточки', m.insights.length], ['markets', 'Рынки Winline', m.summary.market_lines], ['players', 'Игроки', m.players.length],
    ['h2h', 'Личные встречи', m.h2h.played], ['form', 'Форма и статистика', null],
  ];
  return `<div class="card tabs" role="tablist">${items.map(([id, label, count], i) =>
    `<button class="tab" role="tab" data-action="tab" data-tab="${id}" aria-selected="${state.tab === id}" title="Клавиша ${i + 1}">${label}${count != null ? `<span class="count">${count}</span>` : ''}</button>`).join('')}</div>`;
}

function renderTips(m) {
  const cats = [...new Set(m.insights.map((c) => c.category))];
  const tips = m.insights.filter((c) => (state.tipTier === 'all' || c.tier === state.tipTier) && (state.tipCategory === 'all' || c.category === state.tipCategory));
  const tierItems = [['all', 'Все уровни', m.insights.length], ...TIER_ORDER.map((t) => [t, tierLabel(t), m.insights.filter((c) => c.tier === t).length]).filter(([, , n]) => n)];
  const catItems = [['all', 'Все рынки', null], ...cats.map((cat) => [cat, cat, m.insights.filter((c) => c.category === cat).length])];
  const body = tips.length ? tips.map((c) => cardHtml(m, c)).join('') : '<div class="empty">Нет карточек по этим фильтрам. Карточка появляется, только если у Winline есть нужная линия и в данных есть убедительная выборка.</div>';
  return `<div class="toolbar">${chipRow('tip-tier', state.tipTier, tierItems)}</div><div class="toolbar">${chipRow('tip-category', state.tipCategory, catItems)}</div>${body}
    <p class="plate-note">Оценка — редакционная ценность факта (сила истории против цены, размер выборки, пригодность кэфа, яркость), а не вероятность и не совет делать ставку.</p>`;
}

function marketTitle(m, mk) {
  let text = mk.template || '';
  text = text.replace(/@1(?:HT|P)@/g, '1 тайм').replace(/@2(?:HT|P)@/g, '2 тайм').replace(/@\[a\]P@/g, `период ${mk.param ?? ''}`).replace(/@NP@/g, '');
  text = text.replace(/\s@1(?![A-Za-z0-9@])/g, ` · ${m.home.name_ru}`).replace(/\s@2(?![A-Za-z0-9@])/g, ` · ${m.away.name_ru}`);
  text = text.replace(/\[a\]/g, mk.favorite !== undefined ? '' : line(mk.param ?? ''));
  return text.replace(/\(\s*\)/g, '').replace(/\s+/g, ' ').trim();
}

function outcomeLabel(m, mk, o) {
  const [home, away] = [m.home.name_ru, m.away.name_ru];
  if (mk.family === 'match_result' || mk.family === 'handicap_european') return { 1: home, X: 'Ничья', 2: away }[o.label] ?? o.label;
  if (mk.family === 'double_chance') return { '1X': `${home} или ничья`, 12: `${home} или ${away}`, X2: `Ничья или ${away}` }[o.label] ?? o.label;
  if (o.line != null && mk.favorite !== undefined) return `${o.side === 'home' ? home : away} ${signed(o.line)}`;
  return o.label;
}

function renderMarkets(m) {
  const query = state.query.trim().toLowerCase();
  const all = m.markets.filter((mk) => mk.family !== 'player_goal');
  const counts = {};
  for (const mk of all) counts[mk.family] = (counts[mk.family] || 0) + 1;
  const chips = chipRow('family', state.family, [['all', 'Все', all.length], ...FAMILY_ORDER.filter((f) => counts[f]).map((f) => [f, FAMILY[f], counts[f]])]);
  const shown = all.filter((mk) => (state.family === 'all' || mk.family === state.family) &&
    (!query || (marketTitle(m, mk) + ' ' + mk.outcomes.map((o) => outcomeLabel(m, mk, o)).join(' ')).toLowerCase().includes(query)));
  let body = '';
  for (const family of FAMILY_ORDER) {
    const rows = shown.filter((mk) => mk.family === family)
      .sort((a, b) => (PERIOD_ORDER[a.period] ?? 9) - (PERIOD_ORDER[b.period] ?? 9) || a.scope.localeCompare(b.scope) || lineKey(a) - lineKey(b) || a.market_id - b.market_id);
    if (!rows.length) continue;
    body += `<section class="family"><h3>${esc(FAMILY[family])}<small>${rows.length}</small></h3>${rows.map((mk) => `
      <div class="mrow"><div class="mt">${esc(marketTitle(m, mk))}<small>№${mk.market_id}${mk.param ? ` · параметр ${esc(mk.param)}` : ''}</small></div>
      <div class="outs num">${mk.outcomes.map((o) => `<span class="out">${esc(outcomeLabel(m, mk, o))} <b>${odds(o.odds)}</b></span>`).join('')}</div></div>`).join('')}</section>`;
  }
  const note = m.summary.player_lines ? '<p class="plate-note">Линии на игроков — на вкладке «Игроки» и в разделе «Игроки».</p>' : '';
  return `<div class="toolbar"><input type="search" data-input="market-query" placeholder="Поиск по рынкам и командам" value="${esc(state.query)}" aria-label="Поиск по рынкам"></div>
    <div class="toolbar">${chips}</div>${body || '<div class="empty">Ничего не найдено</div>'}${note}`;
}

function renderMatchPlayers(m) {
  if (!m.players.length) return '<div class="empty">Линии Winline на игроков для этого матча пока не опубликованы. Обычно они появляются за 2–3 дня до игры.</div>';
  const rows = m.players.filter((p) => state.side === 'all' || p.team === state.side).map((p) => ({ m, p }));
  const toggle = chipRow('side', state.side, [['all', 'Все', null], ['home', m.home.name_ru, null], ['away', m.away.name_ru, null]]);
  return `<div class="toolbar">${toggle}</div>${playerTable(rows, { showMatch: false })}`;
}

function renderH2H(m) {
  const h = m.h2h;
  if (!h.played) return '<div class="empty">В АПЛ эти команды ещё не встречались.</div>';
  const part = (v) => `${(v / h.played * 100).toFixed(1)}%`;
  return `<div class="sect"><h3>${esc(m.home.name_ru)} · ${h.home_wins} — ничьих ${h.draws} — ${h.away_wins} · ${esc(m.away.name_ru)}</h3>
      <div class="bar" role="img" aria-label="Соотношение результатов"><i class="h" style="width:${part(h.home_wins)}"></i><i class="d" style="width:${part(h.draws)}"></i><i class="a" style="width:${part(h.away_wins)}"></i></div>
      <p class="muted" style="margin:8px 0 0">Всего встреч в АПЛ: <b class="num">${h.played}</b> · голы ${h.goals_home}:${h.goals_away} · без поражений подряд: ${esc(m.home.name_ru)} ${h.unbeaten_run.a}, ${esc(m.away.name_ru)} ${h.unbeaten_run.b}${h.first ? ` · первая встреча ${esc(h.first.date)} (${esc(h.first.score)})` : ''}</p></div>
    <div class="cols2"><div class="sect"><h3>Последние встречи</h3><div class="scroll"><table class="table num"><thead><tr><th>Дата</th><th>Матч</th><th class="r">Счёт</th></tr></thead><tbody>
      ${h.last.map((x) => `<tr><td>${esc(x.date)}</td><td>${esc(x.home)} — ${esc(x.away)}</td><td class="r"><b>${esc(x.score)}</b></td></tr>`).join('')}</tbody></table></div></div>
    <div class="sect"><h3>Лучшие бомбардиры встреч</h3>${h.top_scorers.length ? `<table class="table num"><tbody>${h.top_scorers.map((s) => `<tr><td><b>${esc(s.name)}</b></td><td class="muted">${esc(s.club || '')}</td><td class="r">${s.goals}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Нет данных</p>'}</div></div>`;
}

function formBlock(name, rows) {
  return `<div class="sect"><h3>${esc(name)}: последние 5 матчей АПЛ</h3>
    <div style="margin-bottom:8px">${rows.map((r) => resultPill(r.result)).join('')}</div>
    <table class="table num"><tbody>${rows.map((r) => `<tr><td>${esc(r.date)}</td><td>${r.venue === 'H' ? 'дома' : 'в гостях'} · ${esc(r.opponent)}</td><td class="r"><b>${esc(r.score)}</b></td></tr>`).join('')}</tbody></table></div>`;
}

function statCell(recent, base, key) {
  const a = recent?.[key], b = base?.[key];
  if (a == null) return '<td class="r">—</td><td class="r muted">—</td>';
  let style = '';
  if (b) {
    const change = (a - b) / b;
    if (Math.abs(change) >= 0.25) style = ` style="color:var(--${(change > 0) !== LOWER_IS_BETTER.has(key) ? 'good' : 'bad'})"`;
  }
  return `<td class="r"><b${style}>${num(a, 2)}</b></td><td class="r muted">${num(b, 2)}</td>`;
}

function renderForm(m) {
  const s = m.stats;
  const head = (side) => `${esc(m[side].name_ru)}<div class="faint" style="text-transform:none;letter-spacing:0">${s[side].recent.matches} посл. · ${s[side].baseline.matches} за 3 сезона</div>`;
  return `<div class="cols2">${formBlock(m.home.name_ru, m.form.home)}${formBlock(m.away.name_ru, m.form.away)}</div>
    <div class="sect"><h3>Статистика матчей: последние 6 и за три сезона</h3><div class="scroll"><table class="table num"><thead><tr><th>Показатель</th>
      <th class="r" colspan="2">${head('home')}</th><th class="r" colspan="2">${head('away')}</th></tr><tr><th></th><th class="r">6 матчей</th><th class="r">3 сезона</th><th class="r">6 матчей</th><th class="r">3 сезона</th></tr></thead><tbody>
      ${STAT_ROWS.map(([key, label]) => `<tr><td>${esc(label)}</td>${statCell(s.home.recent, s.home.baseline, key)}${statCell(s.away.recent, s.away.baseline, key)}</tr>`).join('')}</tbody></table></div>
      <p class="plate-note">Зелёный/красный — заметное (≥25%) отличие последних 6 матчей от обычного уровня команды. Расширенная статистика есть не во всех сезонах: пустая клетка значит «нет данных».</p></div>`;
}

function renderMatches() {
  renderRail();
  const m = match();
  if (!m) { $('#main').innerHTML = `<div class="empty card">${state.data ? 'Выберите матч слева' : 'Данные не найдены. Запустите tools/epl_site_data.py и обновите страницу.'}</div>`; return; }
  const body = { tips: renderTips, markets: renderMarkets, players: renderMatchPlayers, h2h: renderH2H, form: renderForm }[state.tab](m);
  $('#main').innerHTML = renderHead(m) + tabs(m) + `<section class="card panel" role="tabpanel">${body}</section>`;
}

// ---------- page: Игроки ----------
function spark(goals) {
  return goals?.length ? `<span class="spark" title="Голы в последних турах (старые слева): ${goals.join(', ')}">${goals.map((g) => `<i class="${g > 0 ? 'g' : ''}" style="height:${g > 0 ? 8 + Math.min(g, 3) * 4 : 4}px"></i>`).join('')}</span>` : '<span class="faint">—</span>';
}

function bestCardId(m, p) {
  const c = m.insights.find((x) => x.details?.player_id === p.pl_id && x.title === p.best_card);
  return c ? cardId(m, c) : null;
}

function valueCells(p) {
  if (p.model_prob == null) return '<td class="r faint empty-cell" data-label="Модель / цена">—</td><td class="r faint empty-cell" data-label="Ценность">—</td>';
  const cls = p.value >= 1.15 ? 'good' : p.value <= 0.8 ? 'bad' : '';
  return `<td class="r" data-label="Модель / цена">${pct(p.model_prob)} <span class="faint">/ ${pct(p.implied_prob)}</span></td><td class="r" data-label="Ценность"><b class="${cls}">×${num(p.value, 2)}</b></td>`;
}

function playerTable(rows, { showMatch = true } = {}) {
  if (!rows.length) return '<div class="empty">Нет игроков по этим фильтрам.</div>';
  const f = state.players;
  const th = (key, label, cls = 'r') => (showMatch
    ? `<th class="${cls}"><button class="th-btn" data-action="player-sort" data-value="${key}" aria-pressed="${f.sort === key}">${label}${f.sort === key ? (f.dir < 0 ? ' ↓' : ' ↑') : ''}</button></th>`
    : `<th class="${cls}">${label}</th>`);
  return `<div class="scroll"><table class="table num players"><thead><tr><th>Игрок</th>${showMatch ? th('kickoff', 'Матч', '') : ''}
      ${th('first', 'Первый гол')}${th('anytime', 'Забьёт')}${th('last', 'Последний')}${th('model', 'Модель / цена')}${th('value', 'Ценность')}
      ${th('goals', 'Голы / xG')}<th>Последние 5</th>${th('vs', 'Против соп.')}${th('score', 'Лучшая карточка', '')}</tr></thead><tbody>
    ${rows.map(({ m, p }) => {
      const id = p.best_card ? bestCardId(m, p) : null;
      const queued = id && state.queue.some((q) => q.id === id);
      const club = p.team === 'home' ? m.home : m.away;
      const opp = p.team === 'home' ? m.away : m.home;
      return `<tr><td class="lead"><div class="pname">${mono(club)}<div><b>${esc(p.name_ru || p.name)}</b>${p.penalty_taker ? '<span class="pen">пенальти</span>' : ''}${p.fit === 'out' ? '<span class="fit out">вне игры</span>' : p.fit === 'doubt' ? '<span class="fit doubt">под вопросом</span>' : ''}
          <div class="faint small">${esc(club.name_ru)}${p.position ? ` · ${esc(POSITION[p.position] || p.position)}` : ''}${p.minutes != null ? ` · ${p.minutes} мин` : ''}</div>
          ${p.news ? `<div class="news small">${esc(p.news)}</div>` : ''}</div></div></td>
        ${showMatch ? `<td data-label="Матч"><button class="linkish" data-action="open-match" data-id="${m.event_id}">vs ${esc(fullName(opp))}</button><div class="faint small">${esc(kickoff(m))}</div></td>` : ''}
        <td class="r" data-label="Первый гол">${odds(p.odds?.first)}</td><td class="r" data-label="Забьёт"><b>${odds(p.odds?.anytime)}</b>${moveBadge(p.odds?.anytime, p.odds_was?.anytime)}</td><td class="r" data-label="Последний">${odds(p.odds?.last)}</td>${valueCells(p)}
        <td class="r" data-label="Голы / xG">${p.goals != null ? `${p.goals} / ${num(p.xg, 1)}` : '—'}</td><td data-label="Последние 5">${spark(p.last5)}</td>
        <td class="r" data-label="Против соп.">${p.vs_opponent?.apps ? `${p.vs_opponent.scored_in} из ${p.vs_opponent.apps}` : '—'}</td>
        <td class="best" data-label="Лучшая карточка">${p.best_card ? `<span class="tier-dot" data-tier="${p.tier}">${esc(p.tier_label)} ${p.score}</span><div class="small">${esc(p.best_card)}</div>
          ${id ? `<button class="btn small ${queued ? 'on' : ''}" data-action="queue" data-card="${esc(id)}">${queued ? 'В эфире ✓' : 'В эфир'}</button>` : ''}` : '<span class="faint">—</span>'}</td></tr>`;
    }).join('')}</tbody></table></div>`;
}

function filteredPlayers() {
  const f = state.players;
  const q = f.query.trim().toLowerCase();
  const rows = state.playerRows.filter(({ m, p }) =>
    (f.match === 'all' || String(m.event_id) === f.match) &&
    (f.team === 'all' || String((p.team === 'home' ? m.home : m.away).id) === f.team) &&
    (f.position === 'all' || p.position === f.position) &&
    (!f.withModel || p.model_prob != null) && (!f.withCard || p.best_card) &&
    (!q || `${p.name} ${p.name_ru || ''} ${p.club}`.toLowerCase().includes(q)));
  const key = {
    score: ({ p }) => p.score ?? -1, anytime: ({ p }) => p.odds?.anytime ?? 999, first: ({ p }) => p.odds?.first ?? 999, last: ({ p }) => p.odds?.last ?? 999,
    model: ({ p }) => p.model_prob ?? -1, value: ({ p }) => p.value ?? -1, goals: ({ p }) => p.goals ?? -1,
    vs: ({ p }) => (p.vs_opponent?.apps ? p.vs_opponent.scored_in / p.vs_opponent.apps + p.vs_opponent.apps / 100 : -1), kickoff: ({ m }) => m.starts_at,
  }[f.sort] || (({ p }) => p.score ?? -1);
  return rows.sort((a, b) => {
    const x = key(a), y = key(b);
    const cmp = typeof x === 'string' ? x.localeCompare(y) : x - y;
    return cmp * f.dir || (b.p.score ?? -1) - (a.p.score ?? -1);
  });
}

function renderPlayersTable() {
  const rows = filteredPlayers();
  $('#pl-table').innerHTML = playerTable(rows);
  $('#pl-count').textContent = `${rows.length} игроков`;
}

function renderPlayersPage() {
  const f = state.players;
  const withLines = (state.data?.matches || []).filter((m) => m.players.length);
  const clubs = new Map();
  for (const m of withLines) { clubs.set(m.home.id, m.home.name_ru); clubs.set(m.away.id, m.away.name_ru); }
  const teamOptions = [...clubs].sort((a, b) => a[1].localeCompare(b[1], 'ru')).map(([id, name]) => `<option value="${id}" ${f.team === String(id) ? 'selected' : ''}>${esc(name)}</option>`).join('');
  const sorts = [['score', 'Сначала лучшие карточки'], ['value', 'Ценность: выше'], ['model', 'Шанс по модели: выше'], ['anytime', 'Кэф «забьёт»: ниже'],
    ['goals', 'Голы в сезоне'], ['vs', 'Против соперника'], ['kickoff', 'По времени матча']];
  $('#main').innerHTML = `<section class="card panel">
      <div class="toolbar"><input type="search" data-input="player-query" placeholder="Поиск игрока" value="${esc(f.query)}" aria-label="Поиск игрока">
        <select class="phone-only" data-input="player-sort" aria-label="Сортировка">${sorts.map(([v, label]) => `<option value="${v}" ${f.sort === v ? 'selected' : ''}>${label}</option>`).join('')}</select>
        <select data-input="player-team" aria-label="Команда"><option value="all">Все команды</option>${teamOptions}</select>
        <select data-input="player-position" aria-label="Амплуа"><option value="all">Все амплуа</option>${Object.entries(POSITION).map(([k, v]) => `<option value="${k}" ${f.position === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <label class="check"><input type="checkbox" data-input="player-model" ${f.withModel ? 'checked' : ''}> есть модель</label>
        <label class="check"><input type="checkbox" data-input="player-card" ${f.withCard ? 'checked' : ''}> есть карточка</label>
        <span class="faint" id="pl-count" style="margin-left:auto"></span></div>
      <p class="plate-note">«Модель / цена»: наш шанс, что игрок забьёт (xG Opta за 90 минут с поправкой на прошлый сезон × ожидаемые минуты), против шанса, заложенного в кэф Winline «Забьёт». «Ценность» ×1,15 и выше — кэф выше, чем говорит модель. Линии на игроков Winline публикует за 2–3 дня до матча.</p>
      <div id="pl-table"></div></section>`;
  renderPlayersTable();
}

// ---------- page: Команды ----------
function teamValue(t, key) {
  const p = t.profile || {};
  if (key === 'name') return t.name_ru;
  if (key === 'points') return (p.wins ?? 0) * 3 + (p.draws ?? 0);
  if (key === 'hot') { const c = t.cards_by_tier || {}; return (c.fire || 0) * 1000 + (c.strong || 0) * 100 + (c.solid || 0) * 10 + (c.background || 0) / 10; }
  if (key === 'next') return t.next?.starts_at || '9999';
  if (key === 'form') return p.form || '';
  return p[key] ?? -1;
}

function teamCell(t, key) {
  const p = t.profile || {};
  if (key === 'name') return `<td><button class="linkish strong" data-action="team-feed" data-id="${t.id}" title="Все карточки матчей команды">${mono(t)}${esc(t.name_ru)}</button></td>`;
  if (key === 'form') return `<td class="nowrap">${[...(p.form || '')].map(resultPill).join('')}</td>`;
  if (key === 'points') return `<td class="r">${p.wins ?? 0}-${p.draws ?? 0}-${p.losses ?? 0}</td>`;
  if (key === 'hot') {
    const c = t.cards_by_tier || {};
    return `<td class="r nowrap">${TIER_ORDER.filter((x) => c[x]).map((x) => `<span class="tier-dot" data-tier="${x}" title="${esc(tierLabel(x))}">${c[x]}</span>`).join('') || '—'}</td>`;
  }
  if (key === 'next') {
    return `<td>${t.next ? `<button class="linkish" data-action="open-match" data-id="${t.next.event_id}">${t.next.venue === 'H' ? 'дома' : 'в гостях'} · ${esc(t.next.opponent)}</button><div class="faint small">${esc(kickoff(t.next))}</div>` : '<span class="faint">нет линии</span>'}</td>`;
  }
  if (key === 'unbeaten_run') return `<td class="r">${p.unbeaten_run ?? '—'}</td>`;
  return `<td class="r">${PERCENT_KEYS.has(key) ? pct(p[key]) : num(p[key], 2)}</td>`;
}

function renderTeams() {
  const f = state.teams;
  const teams = [...(state.data?.teams || [])].sort((a, b) => {
    const x = teamValue(a, f.sort), y = teamValue(b, f.sort);
    return (typeof x === 'string' ? x.localeCompare(y, 'ru') : x - y) * f.dir;
  });
  const head = TEAM_COLUMNS.map(([key, label]) => `<th class="${['name', 'form', 'next'].includes(key) ? '' : 'r'}"><button class="th-btn" data-action="team-sort" data-value="${key}" aria-pressed="${f.sort === key}">${label}${f.sort === key ? (f.dir < 0 ? ' ↓' : ' ↑') : ''}</button></th>`).join('');
  const sorts = TEAM_COLUMNS.filter(([key]) => key !== 'form').map(([key, label]) => `<option value="${key}" ${f.sort === key ? 'selected' : ''}>${label}</option>`).join('');
  const labelled = (t, key, label) => teamCell(t, key).replace('<td', `<td data-label="${esc(label)}"${key === 'name' ? ' class="lead"' : ''}`);
  $('#main').innerHTML = `<section class="card panel">
      <div class="toolbar phone-only"><select data-input="team-sort" aria-label="Сортировка">${sorts}</select>
        <button class="btn" data-action="team-dir">${f.dir < 0 ? 'По убыванию ↓' : 'По возрастанию ↑'}</button></div>
      <p class="plate-note">Последние 8 матчей АПЛ каждой команды (не старше 14 месяцев). xG — наша модель без пенальти. «Карточки» — сколько карточек каждого уровня в ближайших матчах команды. Клик по команде открывает её карточки в Ленте, по сопернику — матч.</p>
      <div class="scroll"><table class="table num teams"><thead><tr>${head}</tr></thead><tbody>
      ${teams.map((t) => `<tr>${TEAM_COLUMNS.map(([key, label]) => labelled(t, key, label)).join('')}</tr>`).join('')}</tbody></table></div></section>`;
}

// ---------- dock: the "Эфир" queue and the Winline plate editor ----------
const mentions = (text, club) => [club.name_full, club.name_ru].filter(Boolean).some((name) => text.includes(name));
const goalsWord = (number) => {
  if (/[.,]/.test(number)) return 'гола';
  const n = Math.abs(parseInt(number, 10)) % 100, n10 = n % 10;
  return n10 === 1 && n !== 11 ? 'гол' : n10 >= 2 && n10 <= 4 && (n < 12 || n > 14) ? 'гола' : 'голов';
};

/** A short first line for the orange bar: the fact's first clause without the per-club breakdown. */
function plateHeadline(title) {
  let text = title.replace(/\s*\([^)]*\)/g, '');
  text = text.split(/,\s(?=[А-ЯЁ])/)[0];
  return text.replace(/ последних/g, '').replace(/ — в (\d+ из \d+)/, ' — $1').trim();
}

/** What the plate says by default for a card: whose bet it is (club, player or the match), the bet, the price. */
function plateDefaults(m, c) {
  const label = c.market.label || '';
  const player = c.details?.player_id != null ? m.players.find((p) => p.pl_id === c.details.player_id) : null;
  let side = player ? player.team : ['home', 'away'].includes(c.market.scope) ? c.market.scope : null;
  if (!side) {
    const home = mentions(label, m.home), away = mentions(label, m.away);
    side = home && !away ? 'home' : away && !home ? 'away' : 'match';
  }
  let team, bet = label;
  const playerBet = player && label.match(/^(.*?)\s(забь[её]т.*)$/);
  if (playerBet) {
    team = playerBet[1];
    bet = playerBet[2] === 'забьёт' || playerBet[2] === 'забьет' ? 'забьёт гол' : playerBet[2];
  } else if (side === 'match') {
    team = `${m.home.name_ru} – ${m.away.name_ru}`;
  } else {
    const club = side === 'home' ? m.home : m.away;
    team = club.name_ru;
    for (const name of [club.name_full, club.name_ru].filter(Boolean)) bet = bet.split(name).join(' ');
    bet = bet.replace(/\s*:\s*/g, ': ').replace(/^[\s:—–-]+|[\s:—–-]+$/g, '').replace(/\s{2,}/g, ' ').trim();
    if (/^или ничья$/i.test(bet)) bet = 'не проиграет';
    else if (/^победа$/i.test(bet)) bet = 'победа в матче';
    const handicap = bet.match(/^фора ([+−-]?\d+(?:[.,]\d+)?)$/i);
    if (handicap) bet = `фора ${handicap[1].replace('−', '-')} ${goalsWord(handicap[1])}`;
    if (!bet) bet = label;
  }
  return { headline: plateHeadline(c.title), team, bet, odds: c.market.odds, crest: side };
}

function plateOf(item) {
  if (!item.plate) {
    const found = findCard(item.id);
    item.plate = found ? plateDefaults(found.m, found.c) : { headline: item.title, team: item.match, bet: item.label, odds: item.odds, crest: 'none' };
    if (found) item.sides = { home: found.m.home.id, away: found.m.away.id, homeName: found.m.home.name_ru, awayName: found.m.away.name_ru };
  }
  return item.plate;
}

function plateData(item) {
  const p = plateOf(item);
  const sides = item.sides || {};
  const crests = { home: [sides.home], away: [sides.away], match: [sides.home, sides.away] }[p.crest] || [];
  return { headline: p.headline, team: p.team, bet: p.bet, odds: parseFloat(String(p.odds).replace(',', '.')) || null, crests: crests.filter((id) => id != null),
    crestWhole: p.crestSize === 'whole' };
}

function plateEditor(item) {
  const p = plateOf(item);
  const sides = item.sides || {};
  const crestOptions = [['home', sides.homeName || 'хозяева'], ['away', sides.awayName || 'гости'], ['match', 'обе команды'], ['none', 'без эмблемы']]
    .map(([value, label]) => `<option value="${value}" ${p.crest === value ? 'selected' : ''}>${esc(label)}</option>`).join('');
  return `<div class="plate-editor">
    <canvas id="plate-preview" class="plate-preview" width="920" height="240" aria-label="Плашка Winline" data-action="plate-zoom" title="Открыть крупно, в кадре 1920×1080"></canvas>
    <div class="plate-status faint" id="plate-status">Загружаю шрифты…</div>
    <label class="pf"><span>Верхняя строка</span><textarea rows="2" data-input="plate-headline">${esc(p.headline)}</textarea></label>
    <label class="pf"><span>Команда или игрок</span><input data-input="plate-team" value="${esc(p.team)}"></label>
    <label class="pf"><span>Ставка</span><input data-input="plate-bet" value="${esc(p.bet)}"></label>
    <div class="pf-row"><label class="pf"><span>Кэф</span><input data-input="plate-odds" inputmode="decimal" value="${esc(p.odds)}"></label>
      <label class="pf"><span>Эмблема</span><select data-input="plate-crest">${crestOptions}</select></label></div>
    <label class="pf"><span>Размер эмблемы</span><select data-input="plate-crest-size"><option value="big" ${p.crestSize !== 'whole' ? 'selected' : ''}>Крупно, как в макете (края срезаны)</option>
      <option value="whole" ${p.crestSize === 'whole' ? 'selected' : ''}>Целиком внутри плашки</option></select></label>
    <div class="plate-actions"><button class="btn primary" data-action="plate-png" data-mode="full" title="Кадр 1920×1080 с прозрачным фоном — как присланный шаблон">PNG 1920×1080</button>
      <button class="btn" data-action="plate-png" data-mode="crop" title="Только плашка, 920×240">PNG плашка</button>
      <button class="btn ghost" data-action="plate-copy">Копировать</button>
      <button class="btn ghost" data-action="plate-reset" title="Вернуть тексты из карточки">Сбросить</button></div>
  </div>`;
}

let previewToken = 0;
let previewTimer = null;
async function drawPreview(item) {
  const token = ++previewToken;
  try {
    const full = await renderPlate(document.createElement('canvas'), plateData(item));
    const target = $('#plate-preview');
    if (token !== previewToken || !target) return;
    cropPlate(full, target);
    const status = $('#plate-status');
    if (status) status.textContent = '';
  } catch (error) {
    const status = $('#plate-status');
    if (status) status.textContent = `Плашка недоступна: ${error.message}`;
  }
}

function schedulePreview(item) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => drawPreview(item), 120);
}

const plateName = (item, mode) => `АПЛ ${item.match} ${oddsText(plateData(item).odds || 0)}${mode === 'crop' ? ' плашка' : ''}.png`.replace(/[\\/:*?"<>|]/g, '');

async function plateBlob(item, mode) {
  const full = await renderPlate(document.createElement('canvas'), plateData(item));
  return toBlob(mode === 'crop' ? cropPlate(full) : full);
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function renderDock() {
  const q = state.queue;
  state.plateIndex = Math.min(Math.max(0, state.plateIndex || 0), Math.max(0, q.length - 1));
  const item = q[state.plateIndex];
  $('#dock').innerHTML = `<h2>Эфир <span class="pill">${q.length}</span></h2>
    ${item ? plateEditor(item) : '<div class="empty">Выберите карточки кнопкой «В эфир» — здесь появится плашка Winline</div>'}
    ${q.map((entry, index) => `<div class="qitem" data-selected="${index === state.plateIndex}">${entry.tier ? `<span class="tier-dot" data-tier="${entry.tier}">${esc(tierLabel(entry.tier))}</span>` : ''}
      <button class="linkish qtitle" data-action="plate-select" data-index="${index}">${esc(entry.title)}</button><div class="row"><span>${esc(entry.match)}</span><span class="odds num">${odds(entry.odds)}</span></div>
      <div class="row"><span>${esc(entry.label)}</span><span style="margin-left:auto"></span>
        <button class="btn small ghost" data-action="move" data-index="${index}" data-dir="-1" ${index === 0 ? 'disabled' : ''} aria-label="Выше">↑</button>
        <button class="btn small ghost" data-action="move" data-index="${index}" data-dir="1" ${index === q.length - 1 ? 'disabled' : ''} aria-label="Ниже">↓</button>
        <button class="btn small ghost" data-action="unqueue" data-index="${index}">Убрать</button></div></div>`).join('')}
    ${q.length ? '<div class="toolbar"><button class="btn" data-action="copy-queue">Копировать тексты</button><button class="btn ghost" data-action="clear-queue">Очистить</button></div>' : ''}`;
  if (item) {
    saveQueue();
    drawPreview(item);
  }
}

// ---------- render & routing ----------
function render() {
  $('#layout').dataset.page = state.page;
  $('#layout').dataset.filters = state.filtersOpen && state.page === 'feed' ? 'open' : 'closed';
  renderHeader();
  renderStrip();
  if (state.page === 'feed') renderFeed();
  else if (state.page === 'matches') renderMatches();
  else if (state.page === 'players') renderPlayersPage();
  else renderTeams();
  renderDock();
}

function setHash() {
  const hash = state.page === 'matches' && state.selected ? `#matches/${state.selected}` : `#${state.page}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);
}

function readHash() {
  const [page, id] = location.hash.replace(/^#/, '').split('/');
  if (['feed', 'matches', 'players', 'teams'].includes(page)) state.page = page;
  if (page === 'matches' && id) state.selected = Number(id);
}

function go(page, selected) {
  state.page = page;
  state.filtersOpen = false;
  document.body.classList.remove('locked');
  if (selected != null) { state.selected = selected; state.open.clear(); }
  saveUi(); setHash(); render();
  window.scrollTo({ top: 0 });
}

// ---------- actions ----------
function toast(message) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), 1600);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); } catch {
    const area = document.createElement('textarea');
    area.value = text; document.body.append(area); area.select(); document.execCommand('copy'); area.remove();
  }
  toast('Скопировано');
}

const cardText = (m, c) => `${pairName(m)}. ${c.title}. ${c.market.label}: ${odds(c.market.odds)} (Winline)`;

function toggleQueue(id) {
  const found = findCard(id);
  if (!found) return;
  const at = state.queue.findIndex((q) => q.id === id);
  if (at >= 0) state.queue.splice(at, 1);
  else {
    const { m, c } = found;
    state.queue.push({ id, match: pairName(m), title: c.title, label: c.market.label, odds: c.market.odds, tier: c.tier, text: cardText(m, c) });
    state.plateIndex = state.queue.length - 1;  // the plate editor opens on the card just added
  }
  saveQueue();
}

function refreshContent() {
  const y = window.scrollY;
  renderHeader();
  if (state.page === 'feed') renderFeedList();
  else if (state.page === 'players') renderPlayersTable();
  else if (state.page === 'matches') renderMatches();
  else renderTeams();
  renderDock();
  window.scrollTo({ top: y });
}

function onClick(event) {
  const target = event.target.closest('[data-action]');
  if (!target || target.disabled) return;
  const { action, value } = target.dataset;
  const f = state.feed;
  const feedChanged = () => { state.feedLimit = FEED_PAGE; saveUi(); renderFeedSide(); renderFeedList(); };
  if (action === 'page') { state.filtersOpen = false; go(target.dataset.page); }
  else if (action === 'strip') {
    if (state.page === 'matches') { go('matches', Number(value)); return; }
    const filter = state.page === 'players' ? state.players : f;
    filter.match = filter.match === value ? 'all' : value;
    state.feedLimit = FEED_PAGE; saveUi(); renderStrip();
    if (state.page === 'players') renderPlayersTable(); else { renderFeedSide(); renderFeedList(); }
  }
  else if (action === 'toggle-filters') {
    state.filtersOpen = !state.filtersOpen;
    $('#layout').dataset.filters = state.filtersOpen ? 'open' : 'closed';
    document.body.classList.toggle('locked', state.filtersOpen);
    if (!state.filtersOpen) $('#main').scrollIntoView({ block: 'start' });
  }
  else if (action === 'to-dock') $('#dock').scrollIntoView({ behavior: 'smooth', block: 'start' });
  else if (action === 'team-dir') { state.teams.dir = -state.teams.dir; saveUi(); renderTeams(); }
  else if (action === 'select' || action === 'open-match') { state.tab = 'tips'; go('matches', Number(target.dataset.id)); }
  else if (action === 'tab') { state.tab = target.dataset.tab; render(); }
  else if (action === 'tip-tier') { state.tipTier = value; refreshContent(); }
  else if (action === 'tip-category') { state.tipCategory = value; refreshContent(); }
  else if (action === 'family') { state.family = value; refreshContent(); }
  else if (action === 'side') { state.side = value; refreshContent(); }
  else if (action === 'feed-tier') { f.tiers = f.tiers.includes(value) ? f.tiers.filter((t) => t !== value) : [...f.tiers, value]; feedChanged(); }
  else if (action === 'feed-category') { f.category = value; feedChanged(); }
  else if (action === 'feed-basis') { f.basis = value; feedChanged(); }
  else if (action === 'feed-odds') { f.minOdds = target.dataset.lo; f.maxOdds = target.dataset.hi; state.feedLimit = FEED_PAGE; saveUi(); renderFeed(); }
  else if (action === 'feed-reset') { state.feed = defaults().feed; state.feedLimit = FEED_PAGE; saveUi(); renderFeed(); }
  else if (action === 'feed-more') { state.feedLimit += FEED_PAGE; refreshContent(); }
  else if (action === 'team-feed') { state.feed = { ...defaults().feed, team: target.dataset.id, tiers: [...TIER_ORDER] }; state.feedLimit = FEED_PAGE; go('feed'); }
  else if (action === 'player-sort') {
    const p = state.players;
    p.dir = p.sort === value ? -p.dir : (ASCENDING_FIRST.has(value) ? 1 : -1); p.sort = value; saveUi(); renderPlayersTable();
  }
  else if (action === 'team-sort') {
    const t = state.teams;
    t.dir = t.sort === value ? -t.dir : (ASCENDING_FIRST.has(value) ? 1 : -1); t.sort = value; saveUi(); renderTeams();
  }
  else if (action === 'details') { const id = target.dataset.card; state.open.has(id) ? state.open.delete(id) : state.open.add(id); refreshContent(); }
  else if (action === 'queue') { toggleQueue(target.dataset.card); refreshContent(); }
  else if (action === 'copy-card') { const found = findCard(target.dataset.card); if (found) copyText(cardText(found.m, found.c)); }
  else if (action === 'unqueue') {
    const i = Number(target.dataset.index);
    state.queue.splice(i, 1);
    if (i < state.plateIndex) state.plateIndex -= 1;
    saveQueue(); refreshContent();
  }
  else if (action === 'move') {
    const i = Number(target.dataset.index), j = i + Number(target.dataset.dir);
    [state.queue[i], state.queue[j]] = [state.queue[j], state.queue[i]];
    if (state.plateIndex === i) state.plateIndex = j; else if (state.plateIndex === j) state.plateIndex = i;
    saveQueue(); renderDock();
  }
  else if (action === 'plate-select') { state.plateIndex = Number(target.dataset.index); renderDock(); }
  else if (action === 'plate-png') {
    const item = state.queue[state.plateIndex];
    if (item) plateBlob(item, target.dataset.mode).then((blob) => saveBlob(blob, plateName(item, target.dataset.mode))).catch((error) => toast(`Не получилось: ${error.message}`));
  }
  else if (action === 'plate-copy') {
    const item = state.queue[state.plateIndex];
    if (!item) return;
    try {  // a promised blob keeps the click's permission to write to the clipboard
      navigator.clipboard.write([new ClipboardItem({ 'image/png': plateBlob(item, 'full') })]).then(() => toast('Картинка скопирована'), () => toast('Браузер не дал скопировать — скачайте PNG'));
    } catch { toast('Браузер не умеет копировать картинки — скачайте PNG'); }
  }
  else if (action === 'plate-zoom') {
    const item = state.queue[state.plateIndex];
    if (!item) return;
    renderPlate(document.createElement('canvas'), plateData(item)).then((full) => {
      const layer = document.createElement('div');
      layer.className = 'plate-zoom';
      layer.dataset.action = 'plate-zoom-close';
      layer.innerHTML = '<div class="plate-frame"></div><p>Кадр 1920×1080 · клик — закрыть</p>';
      full.className = 'plate-full';
      layer.querySelector('.plate-frame').append(full);
      document.body.append(layer);
    });
  }
  else if (action === 'plate-zoom-close') target.remove();
  else if (action === 'plate-reset') { const item = state.queue[state.plateIndex]; if (item) { delete item.plate; saveQueue(); renderDock(); } }
  else if (action === 'clear-queue') { state.queue = []; saveQueue(); refreshContent(); }
  else if (action === 'copy-queue') copyText(state.queue.map((q) => q.text).join('\n'));
  else if (action === 'reload') load(true);
}

function onInput(event) {
  const target = event.target;
  const kind = target.dataset?.input;
  if (!kind) return;
  if (kind.startsWith('plate-')) {
    const item = state.queue[state.plateIndex];
    const field = { 'plate-headline': 'headline', 'plate-team': 'team', 'plate-bet': 'bet', 'plate-odds': 'odds', 'plate-crest': 'crest', 'plate-crest-size': 'crestSize' }[kind];
    if (item && field) { plateOf(item)[field] = target.value; saveQueue(); schedulePreview(item); }
    return;
  }
  const feed = (key, val) => { state.feed[key] = val; state.feedLimit = FEED_PAGE; saveUi(); renderFeedList(); };
  const players = (key, val) => { state.players[key] = val; saveUi(); renderPlayersTable(); };
  if (kind === 'feed-query') feed('query', target.value);
  else if (kind === 'feed-sort') feed('sort', target.value);
  else if (kind === 'feed-min') feed('minOdds', target.value);
  else if (kind === 'feed-max') feed('maxOdds', target.value);
  else if (kind === 'feed-match') feed('match', target.value);
  else if (kind === 'feed-team') feed('team', target.value);
  else if (kind === 'player-query') players('query', target.value);
  else if (kind === 'player-match') players('match', target.value);
  else if (kind === 'player-team') players('team', target.value);
  else if (kind === 'player-position') players('position', target.value);
  else if (kind === 'player-sort') { state.players.dir = ASCENDING_FIRST.has(target.value) ? 1 : -1; players('sort', target.value); }
  else if (kind === 'team-sort') { state.teams.sort = target.value; state.teams.dir = ASCENDING_FIRST.has(target.value) ? 1 : -1; saveUi(); renderTeams(); }
  else if (kind === 'player-model') players('withModel', target.checked);
  else if (kind === 'player-card') players('withCard', target.checked);
  else if (kind === 'market-query') {
    state.query = target.value;
    const caret = target.selectionStart;
    renderMatches();
    const input = $('input[data-input="market-query"]');
    if (input) { input.focus(); input.setSelectionRange(caret, caret); }
  }
}

function onKey(event) {
  if (/INPUT|SELECT|TEXTAREA/.test(event.target.tagName) || event.metaKey || event.ctrlKey || event.altKey) return;
  if (state.page !== 'matches') return;
  const matches = state.data?.matches || [];
  const index = matches.findIndex((m) => m.event_id === state.selected);
  if (event.key === 'ArrowDown' || event.key === 'j') { event.preventDefault(); if (index < matches.length - 1) go('matches', matches[index + 1].event_id); }
  else if (event.key === 'ArrowUp' || event.key === 'k') { event.preventDefault(); if (index > 0) go('matches', matches[index - 1].event_id); }
  else if (/^[1-5]$/.test(event.key)) { state.tab = ['tips', 'markets', 'players', 'h2h', 'form'][Number(event.key) - 1]; render(); }
}

// ---------- boot ----------
function shell() {
  $('#app').innerHTML = `<div class="shell"><header class="topbar" id="top"></header>
    <div class="layout" id="layout"><section class="card strip" id="strip" aria-label="Матчи недели"></section><aside class="card side" id="side" aria-label="Фильтры и матчи"></aside><main class="main" id="main"></main><aside class="card dock" id="dock" aria-label="Эфир"></aside></div></div>`;
}

async function load(manual = false) {
  let data = null;
  try {
    const response = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (response.ok) data = await response.json();
  } catch { /* shown as an empty state below */ }
  if (!data && state.data) { if (manual) toast('Не удалось обновить данные'); return; }
  state.data = data;
  const matches = data?.matches || [];
  state.cards = matches.flatMap((m) => m.insights.map((c) => ({ m, c })));
  state.playerRows = matches.flatMap((m) => m.players.map((p) => ({ m, p })));
  if (!matches.some((m) => m.event_id === state.selected)) state.selected = (matches.find((m) => m.insights.length) || matches[0])?.event_id ?? null;
  const known = new Set(matches.map((m) => String(m.event_id)));
  if (state.feed.match !== 'all' && !known.has(state.feed.match)) state.feed.match = 'all';
  if (state.players.match !== 'all' && !known.has(state.players.match)) state.players.match = 'all';
  const y = window.scrollY;
  setHash(); render();
  window.scrollTo({ top: y });
  if (manual) toast('Данные обновлены');
}

shell();
readHash();
document.addEventListener('click', onClick);
document.addEventListener('input', onInput);
document.addEventListener('keydown', onKey);
window.addEventListener('hashchange', () => { readHash(); render(); });
setInterval(() => { const el = $('#fresh'); if (el && state.data) { const f = freshness(); el.className = `pill ${f.cls}`; el.innerHTML = freshHtml(f); } }, 30000);
setInterval(() => { if (!/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || '')) load(false); }, AUTO_RELOAD_MS);
load();
