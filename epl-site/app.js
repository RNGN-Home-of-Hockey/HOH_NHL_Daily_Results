// HOH Football operator console (light theme). Static page: reads data/site.json built by tools/epl_site_data.py.
// Nothing here talks to Winline or to the broadcast: it shows facts + real lines and lets the operator pick
// plates for the "Эфир" queue. Plate designs (Winline) replace the placeholder preview later.

const DATA_URL = 'data/site.json';
const QUEUE_KEY = 'hoh-epl-queue-v1';
const MSK = { timeZone: 'Europe/Moscow' };
const timeFmt = new Intl.DateTimeFormat('ru-RU', { ...MSK, hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('ru-RU', { ...MSK, weekday: 'short', day: 'numeric', month: 'long' });
const dayKeyFmt = new Intl.DateTimeFormat('en-CA', MSK);

const FAMILY = {
  match_result: 'Исход', double_chance: 'Двойной шанс', handicap: 'Фора', handicap_european: 'Европейский гандикап', total: 'Тоталы',
  btts: 'Обе забьют', goals_count: 'Количество голов', correct_score: 'Точный счёт', team_to_score: 'Какая команда забьёт',
  goal_sequence: 'Первый / следующий / последний гол', clean_sheet: 'Не пропустит', win_to_nil: 'Победа всухую',
  win_yes_no: 'Победа (да / нет)', halves: 'Таймы', odd_even: 'Чёт / нечёт', combo: 'Комбо', corners: 'Угловые', cards: 'Карточки',
  player_goal: 'Игроки', other: 'Прочее',
};
const FAMILY_ORDER = Object.keys(FAMILY);
const PERIOD_ORDER = { FT: 0, '1H': 1, '2H': 2 };
const RULE_GROUP = {
  h2h_win_rate: 'Личные встречи', h2h_unbeaten_run: 'Личные встречи', h2h_total: 'Личные встречи', h2h_btts: 'Личные встречи',
  team_scoring_form: 'Форма', form_unbeaten_run: 'Форма', chance_creation: 'Моменты', player_scorer_form: 'Игроки',
};
const RULE_FILTERS = ['Все', 'Личные встречи', 'Форма', 'Моменты', 'Игроки'];
const DETAIL_LABELS = {
  results_newest_first: 'Результаты (новые слева)', totals_newest_first: 'Голов в матче (новые слева)', goals_newest_first: 'Голы команды (новые слева)',
  values_vs_opponent_newest_first: 'Значения против этого соперника', mean_vs_opponent: 'В среднем против этого соперника',
  mean_vs_others: 'В среднем против остальных', metric: 'Показатель', goals_by_gameweek: 'Голы по матчам (новые справа)',
};
const STAT_ROWS = [
  ['goals_for', 'Голы забито'], ['goals_against', 'Голы пропущено'], ['shots', 'Удары'], ['shots_on_target', 'В створ'],
  ['shots_inside_box', 'Удары из штрафной'], ['touches_in_opp_box', 'Касания в штрафной соперника'], ['possession_pct', 'Владение, %'],
  ['corners_won', 'Угловые'], ['yellow_cards', 'Жёлтые карточки'], ['ppda', 'PPDA (чем меньше, тем жёстче прессинг)'],
  ['shots_against', 'Удары соперника'], ['shots_inside_box_against', 'Удары соперника из штрафной'],
];
const LOWER_IS_BETTER = new Set(['goals_against', 'ppda', 'shots_against', 'shots_inside_box_against']);

const state = { data: null, selected: null, tab: 'tips', rule: 'Все', minScore: 0, query: '', family: 'all', side: 'all', open: new Set(), queue: loadQueue() };

const $ = (selector, root = document) => root.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const odds = (value) => (value == null ? '—' : Number(value).toFixed(2));
const num = (value, digits = 1) => (value == null ? '—' : Number(value).toFixed(digits).replace('.', ','));
const line = (value) => String(value).replace('.', ',');
const signed = (value) => (value == null ? '' : value > 0 ? `+${line(value)}` : value < 0 ? `−${line(Math.abs(value))}` : '0');
const pct = (value) => (value == null ? '—' : `${Math.round(value * 100)}%`);
const lineKey = (mk) => mk.line ?? (Number.isFinite(Number(mk.param)) ? Number(mk.param) : 0);

function loadQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; }
}
function saveQueue() {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(state.queue)); } catch { /* storage may be blocked: the queue still works in memory */ }
}

function mono(club) {
  const words = String(club.name_ru || club.name).split(/\s+/);
  const letters = (words.length > 1 ? words.map((w) => w[0]).join('') : words[0].slice(0, 2)).slice(0, 2).toUpperCase();
  const hue = (club.id * 47) % 360;
  return `<span class="mono" style="background:hsl(${hue} 70% 93%);color:hsl(${hue} 55% 30%)">${esc(letters)}</span>`;
}

const match = () => state.data?.matches.find((m) => m.event_id === state.selected) || null;

// ---------- header ----------
function freshness() {
  const captured = state.data?.winline_captured_at;
  if (!captured) return { cls: 'bad', text: 'Линии Winline: нет данных' };
  const minutes = Math.max(0, Math.round((Date.now() - new Date(captured).getTime()) / 60000));
  const when = timeFmt.format(new Date(captured));
  const ago = minutes < 60 ? `${minutes} мин назад` : `${Math.floor(minutes / 60)} ч ${minutes % 60} мин назад`;
  const cls = minutes < 20 ? 'good' : minutes < 90 ? 'warn' : 'bad';
  return { cls, text: `Линии Winline: ${when} МСК · ${ago}` };
}

function renderHeader() {
  const f = freshness();
  const stats = state.data?.generated_at ? timeFmt.format(new Date(state.data.generated_at)) : '—';
  $('#top').innerHTML = `
    <div class="brand"><span class="brand-mark">HOH</span><div>Футбол · АПЛ<small>пульт оператора</small></div></div>
    <div class="status">
      <span class="pill ${f.cls}" id="fresh"><i></i>${esc(f.text)}</span>
      <span class="pill"><i></i>Данные собраны: ${stats} МСК</span>
      <button class="btn" data-action="reload">Обновить</button>
    </div>`;
}

// ---------- rail ----------
function renderRail() {
  const matches = state.data?.matches || [];
  if (!matches.length) { $('#rail').innerHTML = '<div class="empty">Матчей нет</div>'; return; }
  let html = '';
  let lastDay = '';
  for (const m of matches) {
    const day = dayKeyFmt.format(new Date(m.starts_at));
    if (day !== lastDay) { html += `<div class="day">${esc(dayFmt.format(new Date(m.starts_at)))}</div>`; lastDay = day; }
    const top = m.insights[0]?.score;
    const x = m.quick.x12;
    html += `<button class="match" data-action="select" data-id="${m.event_id}" aria-current="${m.event_id === state.selected}">
      <div class="time num">${timeFmt.format(new Date(m.starts_at))}<small>МСК</small></div>
      <div class="teams"><div class="team">${mono(m.home)}<span>${esc(m.home.name_ru)}</span></div><div class="team">${mono(m.away)}<span>${esc(m.away.name_ru)}</span></div>
        ${x ? `<div class="mini-odds num"><b>${odds(x[0])}</b><b>${odds(x[1])}</b><b>${odds(x[2])}</b></div>` : ''}</div>
      <span class="badge ${top >= 60 ? 'hot' : ''}" title="Лучшая оценка рекомендаций">${m.live ? '<span class="live-dot"></span>' : ''}${top ? `★ ${top}` : `${m.summary.market_lines} лин.`}</span>
    </button>`;
  }
  $('#rail').innerHTML = html;
}

// ---------- match head ----------
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
  return `<section class="card head">
    <div class="head-top">
      <div class="versus">${mono(m.home)}<span>${esc(m.home.name_ru)}</span><span class="vs">—</span>${mono(m.away)}<span>${esc(m.away.name_ru)}</span></div>
      <div class="kick"><b class="num">${timeFmt.format(new Date(m.starts_at))} МСК</b>${esc(dayFmt.format(new Date(m.starts_at)))} · АПЛ</div>
    </div>
    <div class="quick">${quickGroups(m)}</div>
  </section>`;
}

// ---------- tabs ----------
function tabs(m) {
  const items = [
    ['tips', 'Рекомендации', m.insights.length], ['markets', 'Рынки Winline', m.summary.market_lines], ['players', 'Игроки', m.players.length],
    ['h2h', 'Личные встречи', m.h2h.played], ['form', 'Форма и статистика', null],
  ];
  return `<div class="card tabs" role="tablist">${items.map(([id, label, count], i) =>
    `<button class="tab" role="tab" data-action="tab" data-tab="${id}" aria-selected="${state.tab === id}" title="Клавиша ${i + 1}">${label}${count != null ? `<span class="count">${count}</span>` : ''}</button>`).join('')}</div>`;
}

// ---------- tips ----------
function detailValue(key, value) {
  if (key === 'results_newest_first') return [...value].map((c) => `<span class="fpill ${c}">${c === 'W' ? 'П' : c === 'D' ? 'Н' : 'Л'}</span>`).join('');
  if (Array.isArray(value)) return value.join(' · ');
  return esc(typeof value === 'number' ? num(value, 2) : value);
}

function tipCard(m, tip) {
  const id = `${m.event_id}|${tip.market.key}`;
  const queued = state.queue.some((q) => q.id === id);
  const e = tip.evidence;
  const level = tip.score >= 75 ? 'high' : tip.score >= 55 ? 'mid' : 'low';
  const alts = (tip.alternatives || []).map((a) => `<span>${esc(a.label)} · <b class="num">${odds(a.odds)}</b></span>`).join('');
  const details = Object.entries(tip.details || {}).filter(([k]) => DETAIL_LABELS[k]).map(([k, v]) => `<dt>${esc(DETAIL_LABELS[k])}</dt><dd>${detailValue(k, v)}</dd>`).join('');
  return `<article class="tip">
    <div class="tip-score" data-level="${level}" title="Оценка редакционной ценности, не вероятность"><b class="num">${tip.score}</b><span>оценка</span></div>
    <div>
      <div class="tip-meta"><span class="tag rule">${esc(RULE_GROUP[tip.rule] || tip.rule)}</span>${tip.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
      <h3>${esc(tip.title)}</h3>
      <div class="evidence">Выборка <b class="num">${e.sample}</b>${e.span ? ` · ${esc(e.span)}` : ''} · история <b class="num">${e.hits} из ${e.sample}</b> (консервативно ${pct(e.rate_conservative)}) · цена Winline подразумевает ${pct(e.implied_by_price)}</div>
      <div class="tip-market"><span class="label">${esc(tip.market.label)}</span><span class="odds num">${odds(tip.market.odds)}</span>${alts ? `<div class="alts">Ещё линии: ${alts}</div>` : ''}</div>
    </div>
    <div class="tip-actions">
      <button class="btn ${queued ? 'on' : 'primary'}" data-action="queue" data-id="${esc(id)}" data-tip="${esc(tip.market.key)}">${queued ? 'В эфире ✓' : 'В эфир'}</button>
      <button class="btn" data-action="copy-tip" data-tip="${esc(tip.market.key)}">Копировать</button>
      <button class="btn ghost" data-action="details" data-id="${esc(id)}">${state.open.has(id) ? 'Скрыть' : 'Детали'}</button>
    </div>
    <div class="tip-details" ${state.open.has(id) ? '' : 'hidden'}><dl class="kv">${details}<dt>Окно данных</dt><dd>${esc(e.window)}</dd><dt>Рынок Winline</dt><dd>№${tip.market.market_id}${tip.market.line != null ? ` · линия ${line(tip.market.line)}` : ''}</dd></dl></div>
  </article>`;
}

function renderTips(m) {
  const tips = m.insights.filter((t) => (state.rule === 'Все' || RULE_GROUP[t.rule] === state.rule) && t.score >= state.minScore);
  const filters = RULE_FILTERS.map((name) => `<button class="chip-btn" data-action="rule" data-rule="${name}" aria-pressed="${state.rule === name}">${name}</button>`).join('');
  const select = `<select data-action="min-score" aria-label="Минимальная оценка">${[0, 40, 55, 75].map((v) => `<option value="${v}" ${state.minScore === v ? 'selected' : ''}>${v ? `оценка от ${v}` : 'любая оценка'}</option>`).join('')}</select>`;
  const body = tips.length ? tips.map((t) => tipCard(m, t)).join('') : '<div class="empty">Нет рекомендаций по этим фильтрам. Рекомендация появляется только если у Winline есть нужная линия и в данных есть убедительная выборка.</div>';
  return `<div class="toolbar">${filters}<span style="margin-left:auto"></span>${select}</div>${body}
    <p class="plate-note">Оценка — редакционная ценность факта (сила истории против цены, размер выборки, пригодность кэфа), а не вероятность и не совет делать ставку.</p>`;
}

// ---------- markets ----------
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
  const chips = [`<button class="chip-btn" data-action="family" data-family="all" aria-pressed="${state.family === 'all'}">Все · ${all.length}</button>`]
    .concat(FAMILY_ORDER.filter((f) => counts[f]).map((f) => `<button class="chip-btn" data-action="family" data-family="${f}" aria-pressed="${state.family === f}">${esc(FAMILY[f])} · ${counts[f]}</button>`)).join('');
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
  const note = m.summary.player_lines ? '<p class="plate-note">Линии на игроков — на вкладке «Игроки».</p>' : '';
  return `<div class="toolbar"><input type="search" data-action="query" placeholder="Поиск по рынкам и командам" value="${esc(state.query)}" aria-label="Поиск по рынкам"></div>
    <div class="toolbar">${chips}</div>${body || '<div class="empty">Ничего не найдено</div>'}${note}`;
}

// ---------- players ----------
function renderPlayers(m) {
  if (!m.players.length) return '<div class="empty">Линии Winline на игроков для этого матча пока не опубликованы. Обычно они появляются за 2–3 дня до игры.</div>';
  const rows = m.players.filter((p) => state.side === 'all' || p.team === state.side);
  const toggle = [['all', 'Все'], ['home', m.home.name_ru], ['away', m.away.name_ru]].map(([v, label]) => `<button class="chip-btn" data-action="side" data-side="${v}" aria-pressed="${state.side === v}">${esc(label)}</button>`).join('');
  const spark = (goals) => goals?.length ? `<span class="spark" title="Голы в последних матчах: ${goals.join(', ')}">${goals.map((g) => `<i class="${g > 0 ? 'g' : ''}" style="height:${g > 0 ? 8 + Math.min(g, 3) * 4 : 4}px"></i>`).join('')}</span>` : '<span class="faint">—</span>';
  return `<div class="toolbar">${toggle}</div><div class="scroll"><table class="table num"><thead><tr><th>Игрок</th><th>Команда</th><th class="r">Первый гол</th><th class="r">Забьёт</th><th class="r">Последний гол</th><th class="r">Сезон: голы / xG</th><th>Последние матчи</th></tr></thead><tbody>
    ${rows.map((p) => `<tr><td><b>${esc(p.name)}</b>${p.penalty_taker ? '<span class="pen">пенальти</span>' : ''}${p.news ? `<div class="faint" style="font-size:12px">${esc(p.news)}</div>` : ''}</td>
      <td>${esc(p.team === 'home' ? m.home.name_ru : m.away.name_ru)}</td><td class="r">${odds(p.first)}</td><td class="r"><b>${odds(p.anytime)}</b></td><td class="r">${odds(p.last)}</td>
      <td class="r">${p.goals_season != null ? `${p.goals_season} / ${num(p.xg_season, 1)}` : '—'}</td><td>${spark(p.last5_goals)}</td></tr>`).join('')}</tbody></table></div>`;
}

// ---------- h2h ----------
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

// ---------- form & stats ----------
function formBlock(name, rows) {
  return `<div class="sect"><h3>${esc(name)}: последние 5 матчей АПЛ</h3>
    <div style="margin-bottom:8px">${rows.map((r) => `<span class="fpill ${r.result}">${r.result === 'W' ? 'П' : r.result === 'D' ? 'Н' : 'Л'}</span>`).join('')}</div>
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

function renderPanel(m) {
  const body = { tips: renderTips, markets: renderMarkets, players: renderPlayers, h2h: renderH2H, form: renderForm }[state.tab](m);
  return `<section class="card panel" role="tabpanel">${body}</section>`;
}

function renderMain() {
  const m = match();
  if (!m) { $('#main').innerHTML = `<div class="empty card">${state.data ? 'Выберите матч слева' : 'Данные не найдены. Запустите tools/epl_site_data.py и обновите страницу.'}</div>`; return; }
  $('#main').innerHTML = renderHead(m) + tabs(m) + renderPanel(m);
}

// ---------- dock (queue) ----------
function plate(item) {
  return `<div class="plate" aria-label="Макет плашки"><div><div class="fact">${esc(item.title)}</div><div class="mk">${esc(item.label)}</div></div><div class="big num">${odds(item.odds)}</div></div>`;
}

function renderDock() {
  const q = state.queue;
  $('#dock').innerHTML = `<h2>Эфир <span class="pill">${q.length}</span></h2>
    ${q.length ? plate(q[0]) : '<div class="empty">Выберите рекомендации кнопкой «В эфир»</div>'}
    <p class="plate-note">Макет. Плашки Winline подставим, когда будут готовы.</p>
    ${q.map((item, index) => `<div class="qitem"><b>${esc(item.title)}</b><div class="row"><span>${esc(item.match)}</span><span class="odds num">${odds(item.odds)}</span></div>
      <div class="row"><span>${esc(item.label)}</span><span style="margin-left:auto"></span><button class="btn small ghost" data-action="unqueue" data-index="${index}">Убрать</button></div></div>`).join('')}
    ${q.length ? '<div class="toolbar"><button class="btn" data-action="copy-queue">Копировать всё</button><button class="btn ghost" data-action="clear-queue">Очистить</button></div>' : ''}`;
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

const tipText = (m, tip) => `${m.home.name_ru} — ${m.away.name_ru}. ${tip.title}. ${tip.market.label}: ${odds(tip.market.odds)} (Winline)`;
const findTip = (key) => match()?.insights.find((t) => t.market.key === key);

function select(id) {
  state.selected = id;
  state.open.clear();
  renderRail(); renderMain();
}

function onClick(event) {
  const target = event.target.closest('[data-action]');
  if (!target || target.tagName === 'SELECT' || target.tagName === 'INPUT') return;
  const { action } = target.dataset;
  const m = match();
  if (action === 'select') select(Number(target.dataset.id));
  else if (action === 'tab') { state.tab = target.dataset.tab; renderMain(); }
  else if (action === 'rule') { state.rule = target.dataset.rule; renderMain(); }
  else if (action === 'family') { state.family = target.dataset.family; renderMain(); }
  else if (action === 'side') { state.side = target.dataset.side; renderMain(); }
  else if (action === 'details') { const id = target.dataset.id; state.open.has(id) ? state.open.delete(id) : state.open.add(id); renderMain(); }
  else if (action === 'queue') {
    const tip = findTip(target.dataset.tip);
    if (!tip || !m) return;
    const id = target.dataset.id;
    const at = state.queue.findIndex((q) => q.id === id);
    if (at >= 0) state.queue.splice(at, 1);
    else state.queue.push({ id, match: `${m.home.name_ru} — ${m.away.name_ru}`, title: tip.title, label: tip.market.label, odds: tip.market.odds, text: tipText(m, tip) });
    saveQueue(); renderMain(); renderDock();
  }
  else if (action === 'unqueue') { state.queue.splice(Number(target.dataset.index), 1); saveQueue(); renderMain(); renderDock(); }
  else if (action === 'clear-queue') { state.queue = []; saveQueue(); renderMain(); renderDock(); }
  else if (action === 'copy-tip') { const tip = findTip(target.dataset.tip); if (tip && m) copyText(tipText(m, tip)); }
  else if (action === 'copy-queue') copyText(state.queue.map((q) => q.text).join('\n'));
  else if (action === 'reload') load(true);
}

function onInput(event) {
  const target = event.target;
  if (target.dataset?.action === 'query') {
    state.query = target.value;
    const caret = target.selectionStart;
    renderMain();
    const input = $('input[data-action="query"]');
    if (input) { input.focus(); input.setSelectionRange(caret, caret); }
  } else if (target.dataset?.action === 'min-score') { state.minScore = Number(target.value); renderMain(); }
}

function onKey(event) {
  if (/INPUT|SELECT|TEXTAREA/.test(event.target.tagName) || event.metaKey || event.ctrlKey || event.altKey) return;
  const matches = state.data?.matches || [];
  const index = matches.findIndex((m) => m.event_id === state.selected);
  if (event.key === 'ArrowDown' || event.key === 'j') { event.preventDefault(); if (index < matches.length - 1) select(matches[index + 1].event_id); }
  else if (event.key === 'ArrowUp' || event.key === 'k') { event.preventDefault(); if (index > 0) select(matches[index - 1].event_id); }
  else if (/^[1-5]$/.test(event.key)) { state.tab = ['tips', 'markets', 'players', 'h2h', 'form'][Number(event.key) - 1]; renderMain(); }
}

// ---------- boot ----------
function shell() {
  $('#app').innerHTML = `<div class="shell"><header class="topbar" id="top"></header>
    <div class="layout"><aside class="card rail" id="rail" aria-label="Матчи"></aside><main class="main" id="main"></main><aside class="card dock" id="dock" aria-label="Эфир"></aside></div></div>`;
}

async function load(keepSelection = false) {
  let data = null;
  try {
    const response = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (response.ok) data = await response.json();
  } catch { /* shown as an empty state below */ }
  state.data = data;
  const matches = data?.matches || [];
  if (!keepSelection || !matches.some((m) => m.event_id === state.selected)) state.selected = (matches.find((m) => m.insights.length) || matches[0])?.event_id ?? null;
  renderHeader(); renderRail(); renderMain(); renderDock();
}

shell();
document.addEventListener('click', onClick);
document.addEventListener('input', onInput);
document.addEventListener('change', onInput);
document.addEventListener('keydown', onKey);
setInterval(() => { const el = $('#fresh'); if (el && state.data) { const f = freshness(); el.className = `pill ${f.cls}`; el.innerHTML = `<i></i>${esc(f.text)}`; } }, 30000);
load();
