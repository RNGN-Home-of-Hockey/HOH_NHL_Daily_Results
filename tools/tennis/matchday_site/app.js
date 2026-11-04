"use strict";
// Matchday. Everything from the data goes in as text, never as HTML.
const API = "/matchday/api";
const RELOAD_MS = 120000;
const STALE_MS = 25 * 60 * 1000;
const TABS = [["plates", "Плашки"], ["markets", "Рынки Winline"], ["h2h", "Личные встречи"], ["form", "Форма"]];
const SURFACE = { hard: "хард", clay: "грунт", grass: "трава", carpet: "ковёр" };

const state = { list: null, detail: null, tab: "plates", circuit: "WTA", doubles: false, query: "", me: null, formCap: null, formSum: null, formSurface: false };
const rail = document.getElementById("rail");
const content = document.getElementById("content");
const fresh = document.getElementById("fresh");

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value !== null && value !== undefined && value !== false) node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child !== null && child !== undefined && child !== false) node.append(child);
  }
  return node;
}

const MSK = { timeZone: "Europe/Moscow" };
function timeOf(iso) {
  const when = new Date(iso);
  return isNaN(when) ? "" : when.toLocaleTimeString("ru-RU", { ...MSK, hour: "2-digit", minute: "2-digit" });
}
function dayKey(iso) {
  const when = new Date(iso);
  return isNaN(when) ? "" : when.toLocaleDateString("sv-SE", MSK);
}
function dayLabel(iso) {
  const when = new Date(iso);
  if (isNaN(when)) return "Без даты";
  const today = dayKey(new Date().toISOString());
  const tomorrow = dayKey(new Date(Date.now() + 86400000).toISOString());
  const key = dayKey(iso);
  const name = when.toLocaleDateString("ru-RU", { ...MSK, day: "numeric", month: "long", weekday: "short" });
  return key === today ? `Сегодня, ${name}` : key === tomorrow ? `Завтра, ${name}` : name;
}
function dateTime(iso) {
  const when = new Date(iso);
  return isNaN(when) ? "" : when.toLocaleString("ru-RU", { ...MSK, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
function price(value) {
  return value === null || value === undefined ? "—" : Number(value).toFixed(2);
}
function signed(value) {
  if (value === null || value === undefined) return "";
  return value > 0 ? `+${value}` : String(value);
}

async function getJson(path) {
  const response = await fetch(API + path, { cache: "no-store" });
  if (response.status === 401) {
    location.assign(`/matchday/login${location.hash}`);
    return new Promise(() => {});
  }
  if (!response.ok && response.status !== 404) throw new Error(`Сервер ответил ${response.status}`);
  return response.status === 404 ? null : response.json();
}

async function post(path, body) {
  const response = await fetch(API + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const answer = await response.json().catch(() => ({}));
  if (response.status === 401 && path !== "/password") {
    location.assign("/matchday/login");
    return new Promise(() => {});
  }
  if (!response.ok) throw new Error(answer.error || `Сервер ответил ${response.status}`);
  return answer;
}

function renderWho() {
  const who = document.getElementById("who");
  who.replaceChildren();
  if (!state.me) return;
  who.append(
    state.me.role === "admin" ? el("a", { class: "link", href: "#people" }, "Доступ") : null,
    el("a", { class: "link", href: "#account" }, state.me.name),
    el("button", { type: "button", class: "link", onclick: async () => {
      await post("/logout");
      location.assign("/matchday/login");
    } }, "Выйти"));
}

function field(label, props) {
  return el("label", { class: "field" }, label, el("input", props));
}

function formError() {
  return el("p", { class: "login-error", role: "alert" });
}

function renderAccount() {
  document.body.classList.add("has-match");
  const error = formError();
  const done = el("p", { class: "done", role: "status" });
  const form = el("form", { class: "panel-form", onsubmit: async (event) => {
    event.preventDefault();
    error.textContent = done.textContent = "";
    if (form.new.value !== form.again.value) {
      error.textContent = "Новые пароли не совпали";
      return;
    }
    try {
      await post("/password", { old: form.old.value, new: form.new.value });
      form.reset();
      done.textContent = "Пароль изменён. Другие устройства придётся войти заново";
    } catch (problem) {
      error.textContent = problem.message;
    }
  } },
    field("Старый пароль", { type: "password", name: "old", autocomplete: "current-password", required: true }),
    field("Новый пароль, от 8 знаков", { type: "password", name: "new", autocomplete: "new-password", required: true, minlength: "8", maxlength: "128" }),
    field("Новый пароль ещё раз", { type: "password", name: "again", autocomplete: "new-password", required: true }),
    error, done,
    el("button", { type: "submit", class: "button" }, "Сменить пароль"));
  content.replaceChildren(
    el("a", { class: "back", href: "#" }, "← Все матчи"),
    el("h1", { class: "page-title" }, "Личный кабинет"),
    el("p", { class: "eyebrow" }, `${state.me.name} · ${state.me.email} · ${state.me.role === "admin" ? "администратор" : "комментатор"}`),
    form);
}

async function renderPeople() {
  document.body.classList.add("has-match");
  if (state.me?.role !== "admin") {
    content.replaceChildren(el("div", { class: "welcome" }, el("h1", {}, "Только для администратора")));
    return;
  }
  const { users } = await getJson("/users");
  const error = formError();
  const done = el("p", { class: "done", role: "status" });
  const act = async (button, path, body, message) => {
    error.textContent = done.textContent = "";
    button.disabled = true;
    try {
      await post(path, body);
      await renderPeople();
      if (message) document.querySelector(".done").textContent = message;
    } catch (problem) {
      error.textContent = problem.message;
      button.disabled = false;
    }
  };
  const form = el("form", { class: "panel-form", onsubmit: (event) => {
    event.preventDefault();
    act(event.submitter, "/users/add", { name: form.name.value, email: form.email.value, role: form.role.value }, "Письмо с паролем отправлено");
  } },
    field("Имя и фамилия", { type: "text", name: "name", required: true, maxlength: "80" }),
    field("Почта", { type: "email", name: "email", required: true }),
    el("label", { class: "field" }, "Роль", el("select", { name: "role" },
      el("option", { value: "commentator" }, "Комментатор"), el("option", { value: "admin" }, "Администратор"))),
    el("button", { type: "submit", class: "button" }, "Дать доступ"));
  const rows = users.map((user) => el("tr", {},
    el("td", {}, user.name), el("td", {}, user.email),
    el("td", {}, user.role === "admin" ? "Администратор" : "Комментатор"),
    el("td", { class: user.active ? "won" : "lost" }, user.active ? "Есть доступ" : "Без доступа"),
    el("td", { class: "row-actions" },
      el("button", { type: "button", class: "ghost", onclick: (event) => act(event.currentTarget, "/users/reset", { email: user.email }, "Письмо с новым паролем отправлено") }, "Новый пароль"),
      user.email === state.me.email ? null : el("button", { type: "button", class: "ghost", onclick: (event) => act(event.currentTarget, "/users/access", { email: user.email, active: !user.active }) }, user.active ? "Забрать доступ" : "Вернуть доступ"))));
  content.replaceChildren(
    el("a", { class: "back", href: "#" }, "← Все матчи"),
    el("h1", { class: "page-title" }, "Доступ"),
    error, done,
    el("div", { class: "scroll" }, el("table", { class: "results" },
      el("thead", {}, el("tr", {}, el("th", {}, "Имя"), el("th", {}, "Почта"), el("th", {}, "Роль"), el("th", {}, "Доступ"), el("th", {}, ""))),
      el("tbody", {}, rows))),
    el("h2", { class: "page-subtitle" }, "Новый человек"),
    el("p", { class: "eyebrow" }, "Пароль придёт на эту почту"),
    form);
}

function circuits() {
  const seen = new Map();
  for (const match of state.list?.matches || []) {
    if (match.in_line) seen.set(match.circuit, (seen.get(match.circuit) || 0) + 1);
  }
  return [...seen.entries()].sort((a, b) => (a[0] === "WTA" ? -1 : b[0] === "WTA" ? 1 : b[1] - a[1]));
}

function visibleMatches() {
  const query = state.query.trim().toLowerCase();
  return (state.list?.matches || []).filter((match) => {
    if (state.circuit && match.circuit !== state.circuit) return false;
    if (!state.doubles && match.is_doubles) return false;
    if (query && !`${match.team1} ${match.team2} ${match.tournament}`.toLowerCase().includes(query)) return false;
    return true;
  });
}

function currentId() {
  const found = location.hash.match(/^#matches\/(\d+)$/);
  return found ? found[1] : null;
}

function matchRow(match) {
  const active = currentId() === match.id;
  return el("a", { class: `row${active ? " active" : ""}`, href: `#matches/${match.id}`, "aria-current": active ? "page" : null },
    el("span", { class: "row-time" }, timeOf(match.start_at)),
    el("span", { class: "row-names" }, el("span", {}, match.team1 || "—"), el("span", {}, match.team2 || "—")),
    el("span", { class: "row-odds" }, el("span", {}, price(match.odd1)), el("span", {}, price(match.odd2))),
    el("span", { class: "row-meta" }, match.tournament,
      match.plates ? el("span", { class: "badge" }, `плашек ${match.plates}`) : null));
}

function renderRail() {
  rail.replaceChildren();
  const search = el("input", { class: "search", type: "search", placeholder: "Игрок или турнир", "aria-label": "Поиск", value: state.query,
    oninput: (event) => { state.query = event.target.value; renderRailList(); } });
  const chips = el("div", { class: "chips" },
    circuits().map(([name, count]) => el("button", { type: "button", class: `chip${state.circuit === name ? " on" : ""}`,
      onclick: () => { state.circuit = name; renderRail(); } }, `${name} ${count}`)),
    el("label", { class: "toggle" }, el("input", { type: "checkbox", checked: state.doubles,
      onchange: (event) => { state.doubles = event.target.checked; renderRailList(); } }), "Пары"));
  rail.append(search, chips, el("div", { id: "rail-list" }));
  renderRailList();
}

function renderRailList() {
  const holder = document.getElementById("rail-list");
  if (!holder) return;
  holder.replaceChildren();
  if (!state.list) return;
  const matches = visibleMatches();
  if (!matches.length) {
    holder.append(el("p", { class: "empty" }, "Матчей нет"));
    return;
  }
  const live = matches.filter((m) => m.in_line);
  const gone = matches.filter((m) => !m.in_line).reverse();
  let day = null;
  for (const match of live) {
    const key = dayKey(match.start_at);
    if (key !== day) {
      day = key;
      holder.append(el("h3", { class: "day" }, dayLabel(match.start_at)));
    }
    holder.append(matchRow(match));
  }
  if (gone.length) {
    holder.append(el("h3", { class: "day" }, "Ушли из линии"));
    gone.forEach((match) => holder.append(matchRow(match)));
  }
}

function renderFresh() {
  const at = state.list?.fetch?.taken_at;
  if (!at) {
    fresh.textContent = "";
    return;
  }
  const stale = Date.now() - new Date(at).getTime() > STALE_MS;
  fresh.className = `fresh${stale ? " stale" : ""}`;
  fresh.textContent = `${stale ? "Линия устарела: " : "Линия: "}${dateTime(at)} МСК`;
}

async function copyText(button, text) {
  const label = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "Скопировано";
  } catch {
    button.textContent = "Не удалось скопировать";
  }
  setTimeout(() => { button.textContent = label; }, 1500);
}

function evidenceTable(matches) {
  return el("details", { class: "evidence" },
    el("summary", {}, `Какие матчи: ${matches.length}`),
    el("div", { class: "scroll" }, el("table", { class: "results" },
      el("thead", {}, el("tr", {}, el("th", {}, "Дата"), el("th", {}, "Игрок"), el("th", {}, "Соперник"), el("th", {}, "Счёт"), el("th", {}, "Итог"), el("th", {}, "Сыграло"))),
      el("tbody", {}, matches.map((match) => el("tr", {},
        el("td", {}, match.date), el("td", {}, match.player), el("td", {}, match.opponent || "—"),
        el("td", {}, match.score || "—"), el("td", {}, match.note),
        el("td", { class: match.hit ? "won" : "lost" }, match.hit ? "Да" : "Нет")))))));
}

function plateCard(card) {
  const priced = card.kind === "line";
  const text = priced ? `${card.text} (${card.hits} из ${card.n})` : card.text;
  return el("article", { class: `plate${priced ? " priced" : ""}` },
    el("p", { class: "plate-text" }, card.text),
    priced ? el("p", { class: "plate-count" }, `${card.hits} из ${card.n}`) : null,
    card.what ? el("p", { class: "plate-evidence" }, card.what) : null,
    card.why ? el("p", { class: "plate-evidence" }, card.why) : null,
    card.matches ? evidenceTable(card.matches) : null,
    el("button", { type: "button", class: "ghost", onclick: (event) => copyText(event.currentTarget, text) }, "Копировать"));
}

function platesTab(detail) {
  const parts = [];
  detail.notes.forEach((note) => parts.push(el("p", { class: "note" }, note)));
  if (detail.lines.length) {
    parts.push(el("h2", {}, "С линией"), el("div", { class: "plates" }, detail.lines.map(plateCard)));
  }
  if (detail.facts.length) {
    parts.push(el("h2", {}, "Факты"), el("div", { class: "plates" }, detail.facts.map(plateCard)));
  }
  if (!detail.lines.length && !detail.facts.length && !detail.notes.length) {
    parts.push(el("p", { class: "empty" }, "По этому матчу пока нечего показать"));
  }
  parts.push(el("p", { class: "caption" }, "Как читать: «15 из 20» значит, что из 20 последних подходящих матчей такой исход случился в 15. Осторожная оценка учитывает, что выборка маленькая: при 90 % уверенности доля не ниже этого числа. Проверка на 787 сыгранных матчах WTA не показала, что такие строки обгоняют рынок, поэтому это материал для редактора, а не совет. История: тур и WTA 125 с 2016 года, пока без ITF и Больших шлемов до 2025."));
  return parts;
}

function priceCell(odd, was) {
  return el("td", { class: "price" }, price(odd),
    was ? el("span", { class: odd < was ? "move down" : "move up" }, `${odd < was ? "↓" : "↑"} было ${price(was)}`) : null);
}

function marketsTab(detail) {
  if (!detail.markets.length) return [el("p", { class: "empty" }, "Winline не показал рынков по этому матчу")];
  return detail.markets.map((family) => el("section", { class: "family" },
    el("h2", {}, family.name),
    el("table", {},
      el("thead", {}, el("tr", {}, el("th", {}, "Линия"), el("th", {}, family.side1 || "1"), el("th", {}, family.side2 || "2"), el("th", {}, ""))),
      el("tbody", {}, family.rungs.map((rung) => el("tr", {},
        el("td", { class: "value" }, rung.value === null ? "—" : signed(rung.value)),
        priceCell(rung.odd1, rung.was1),
        priceCell(rung.odd2, rung.was2),
        el("td", { class: "history" }, rung.history.length > 1
          ? el("details", {}, el("summary", {}, `Движение: ${rung.history.length}`),
            el("ul", {}, rung.history.map((step) => el("li", {}, `${dateTime(step.at)}: ${price(step.odd1)} / ${price(step.odd2)}`))))
          : null)))))));
}

function resultRow(result, perspective) {
  const won = perspective ? result.winner_id === perspective : null;
  return el("tr", {},
    el("td", {}, result.played),
    el("td", {}, `${result.winner || "—"} — ${result.loser || "—"}`),
    el("td", {}, `${result.score || ""}${result.status === "retired" ? " (отказ)" : ""}`),
    el("td", {}, `${result.tournament || ""}${result.surface ? `, ${SURFACE[String(result.surface).toLowerCase()] || result.surface}` : ""}`),
    perspective ? el("td", { class: won ? "won" : "lost" }, won ? "Победа" : "Поражение") : null);
}

function resultsTable(results, perspective) {
  return el("div", { class: "scroll" }, el("table", { class: "results" },
    el("thead", {}, el("tr", {}, el("th", {}, "Дата"), el("th", {}, "Матч"), el("th", {}, "Счёт"), el("th", {}, "Турнир"), perspective ? el("th", {}, "") : null)),
    el("tbody", {}, results.map((result) => resultRow(result, perspective)))));
}

function h2hTab(detail) {
  if (detail.is_doubles || detail.circuit !== "WTA") return [el("p", { class: "note" }, "Пока только для одиночного разряда WTA")];
  if (!detail.h2h.length) return [el("p", { class: "empty" }, "Личных встреч в базе нет")];
  return [resultsTable(detail.h2h)];
}

// The rung with the most even prices is the main line of a ladder, the same choice BOLSHE makes.
function mainRung(family) {
  if (!family?.rungs.length) return null;
  return [...family.rungs].sort((a, b) => Math.abs(a.odd1 - a.odd2) - Math.abs(b.odd1 - b.odd2))[0];
}

function handicapResult(result, line) {
  if (result.margin === null || result.margin === undefined) return { text: "—", kind: "" };
  const after = result.margin + line;
  if (after === 0) return { text: "Возврат", kind: "" };
  return after > 0 ? { text: "Сыграла", kind: "won", hit: true } : { text: "Нет", kind: "lost", hit: false };
}

function totalResult(result, line) {
  if (result.total === null || result.total === undefined) return { text: "—", kind: "" };
  if (result.total === line) return { text: `${result.total}: возврат`, kind: "" };
  return result.total > line ? { text: `${result.total}: больше`, kind: "over", over: true } : { text: `${result.total}: меньше`, kind: "under", over: false };
}

function formSide(side, handicap, total, onlySurface, surface) {
  const results = onlySurface ? side.results.filter((r) => String(r.surface).toLowerCase() === surface) : side.results;
  const line = handicap === null ? null : side.side === 1 ? handicap : -handicap;
  const settled = results.map((result) => ({ result, cap: line === null ? null : handicapResult(result, line), sum: total === null ? null : totalResult(result, total) }));
  const capCount = settled.filter((row) => row.cap && row.cap.hit !== undefined);
  const sumCount = settled.filter((row) => row.sum && row.sum.over !== undefined);
  const wins = results.filter((r) => r.winner_id === side.player_id).length;
  const summary = [`${wins}-${results.length - wins}`];
  if (line !== null) summary.push(`фора ${signed(line)} сыграла в ${capCount.filter((row) => row.cap.hit).length} из ${capCount.length}`);
  if (total !== null) summary.push(`больше ${total} в ${sumCount.filter((row) => row.sum.over).length} из ${sumCount.length}, меньше в ${sumCount.filter((row) => !row.sum.over).length}`);
  return el("section", { class: "family" },
    el("h2", {}, side.name),
    el("p", { class: "form-summary" }, summary.join(" · ")),
    results.length ? el("div", { class: "scroll" }, el("table", { class: "results" },
      el("thead", {}, el("tr", {}, el("th", {}, "Дата"), el("th", {}, "Матч"), el("th", {}, "Счёт"), el("th", {}, "Турнир"), el("th", {}, "Итог"),
        line !== null ? el("th", {}, `Фора ${signed(line)}`) : null, total !== null ? el("th", {}, `Тотал ${total}`) : null)),
      el("tbody", {}, settled.map(({ result, cap, sum }) => el("tr", {},
        el("td", {}, result.played),
        el("td", {}, `${result.winner || "—"} — ${result.loser || "—"}`),
        el("td", {}, `${result.score || ""}${result.status === "retired" ? " (отказ)" : ""}`),
        el("td", {}, `${result.tournament || ""}${result.surface ? `, ${SURFACE[String(result.surface).toLowerCase()] || result.surface}` : ""}`),
        el("td", { class: result.winner_id === side.player_id ? "won" : "lost" }, result.winner_id === side.player_id ? "Победа" : "Поражение"),
        cap ? el("td", { class: cap.kind }, cap.text) : null,
        sum ? el("td", { class: sum.kind }, sum.text) : null)))))
      : el("p", { class: "empty" }, "В базе нет таких матчей"));
}

function formTab(detail) {
  if (!detail.form.length) return [el("p", { class: "note" }, detail.notes[0] || "Нет данных")];
  const capFamily = detail.markets.find((f) => f.name === "Фора по геймам");
  const sumFamily = detail.markets.find((f) => f.name === "Тотал геймов");
  state.formCap = capFamily?.rungs.some((r) => r.value === state.formCap?.value && state.formCap?.id === detail.id) ? state.formCap : { id: detail.id, value: mainRung(capFamily)?.value ?? null };
  state.formSum = sumFamily?.rungs.some((r) => r.value === state.formSum?.value && state.formSum?.id === detail.id) ? state.formSum : { id: detail.id, value: mainRung(sumFamily)?.value ?? null };
  const rerender = () => renderMatch();
  const picker = (label, family, current, describe, change) => family ? el("label", { class: "field inline" }, label,
    el("select", { onchange: (event) => { change(Number(event.target.value)); rerender(); } },
      family.rungs.map((rung) => el("option", { value: rung.value, selected: rung.value === current }, describe(rung))))) : null;
  const surfaceWord = SURFACE[detail.surface];
  return [
    el("div", { class: "form-controls" },
      picker(`Фора для ${detail.team1}`, capFamily, state.formCap.value, (r) => `${signed(r.value)} (${price(r.odd1)} / ${price(r.odd2)})`, (value) => { state.formCap = { id: detail.id, value }; }),
      picker("Тотал", sumFamily, state.formSum.value, (r) => `${r.value} (${price(r.odd1)} / ${price(r.odd2)})`, (value) => { state.formSum = { id: detail.id, value }; }),
      surfaceWord ? el("label", { class: "toggle" }, el("input", { type: "checkbox", checked: state.formSurface, onchange: (event) => { state.formSurface = event.target.checked; rerender(); } }), `Только ${surfaceWord}`) : null),
    el("p", { class: "caption" }, "Линии взяты из текущей лесенки этого матча и применены к прошлым матчам: так видно, как часто такая фора или тотал сыграли бы раньше. Старых цен на те матчи в базе нет. Матчи с отказом не считаются. Для соперницы фора показана с обратным знаком."),
    ...detail.form.map((side) => formSide(side, state.formCap.value, state.formSum.value, state.formSurface, detail.surface)),
  ];
}

function renderMatch() {
  const detail = state.detail;
  content.replaceChildren();
  document.body.classList.toggle("has-match", Boolean(detail));
  if (!detail) {
    content.append(el("div", { class: "welcome" }, el("h1", {}, "Выберите матч"), el("p", {}, "Коэффициенты Winline с движением, плашки, личные встречи и форма игроков.")));
    return;
  }
  const notInLine = detail.fetch?.taken_at && detail.last_seen !== detail.fetch.taken_at;
  content.append(
    el("a", { class: "back", href: "#" }, "← Все матчи"),
    el("header", { class: "match-head" },
      el("p", { class: "eyebrow" }, `${detail.circuit} · ${detail.tournament} · ${dateTime(detail.start_at)} МСК`),
      el("h1", {}, `${detail.team1} — ${detail.team2}`),
      notInLine ? el("p", { class: "note" }, `Матч ушёл из линии. Последние цены на ${dateTime(detail.last_seen)} МСК`) : null,
      el("div", { class: "actions" },
        detail.url ? el("a", { class: "button", href: detail.url, target: "_blank", rel: "noopener noreferrer" }, "Открыть в Winline") : null,
        el("button", { type: "button", class: "ghost", onclick: (event) => copyText(event.currentTarget, location.href) }, "Ссылка на матч"))),
    el("div", { class: "tabs", role: "tablist" }, TABS.map(([key, label]) => el("button", {
      type: "button", role: "tab", "aria-selected": state.tab === key ? "true" : "false", class: `tab${state.tab === key ? " on" : ""}`,
      onclick: () => { state.tab = key; renderMatch(); },
    }, label))),
    el("div", { class: "panel" }, { plates: platesTab, markets: marketsTab, h2h: h2hTab, form: formTab }[state.tab](detail)));
}

function showError(message) {
  content.replaceChildren(el("div", { class: "welcome" }, el("h1", {}, "Не удалось загрузить"), el("p", {}, message),
    el("button", { type: "button", class: "button", onclick: () => load() }, "Повторить")));
}

async function loadDetail() {
  if (location.hash === "#account") {
    renderAccount();
    return;
  }
  if (location.hash === "#people") {
    await renderPeople();
    return;
  }
  const id = currentId();
  if (!id) {
    state.detail = null;
    renderMatch();
    return;
  }
  const detail = await getJson(`/matches/${id}`);
  if (currentId() !== id) return;
  state.detail = detail;
  if (!detail) {
    content.replaceChildren(el("div", { class: "welcome" }, el("h1", {}, "Матч не найден"), el("a", { href: "#" }, "Все матчи")));
    return;
  }
  // A match opened by link shows its own tour in the list.
  if (detail.circuit !== state.circuit) {
    state.circuit = detail.circuit;
    renderRail();
  }
  renderMatch();
}

async function load() {
  try {
    if (!state.me) {
      state.me = (await getJson("/me"))?.user || null;
      renderWho();
    }
    state.list = await getJson("/matches");
    if (state.list && !circuits().some(([name]) => name === state.circuit) && circuits().length) state.circuit = circuits()[0][0];
    renderFresh();
    renderRail();
    await loadDetail();
  } catch (error) {
    showError(error.message);
  }
}

window.addEventListener("hashchange", () => {
  renderRailList();
  loadDetail().catch((error) => showError(error.message));
});
load();
setInterval(() => {
  // A refresh must not throw away what the search box, a form or an open "Движение" holds.
  if (document.activeElement?.classList?.contains("search") || content.querySelector("details[open], form")) return;
  load();
}, RELOAD_MS);
