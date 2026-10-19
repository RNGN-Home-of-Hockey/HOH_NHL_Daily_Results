// Live Center v37: «Вопрос недели» (the owner, 2026-10-19: «Ваня, наш СММщик, спрашивает… куда обменяют Ларкина… напишите по одной
// команде… сделаем графику с прогнозов… было бы прикольно, если бы комментаторы подсвечивались бы отдельно… с иконкой комментатора»).
//   - an admin asks in the bot: /week Куда обменяют Ларкина? | команда | Останется   (or own variants: /week Вопрос? | Да; Нет)
//   - the fans answer in the app with one tap: a team of the NHL or one of the variants (no free text: nothing to moderate)
//   - the commentators of HOH (app_hosts) are marked 🎙 and shown first; an admin types in an answer a commentator gave in the chat:
//     /week_answer Протасов = Сан-Хосе
//   - the split is shown after one's own answer (and to everybody once the question is closed); an admin gets the picture for the
//     social networks drawn by the app
//   - /week_result Миннесота: the right answers get +30 XP (for the level) and count for the achievement «Инсайдер»
//   GET  /api/telegram-center-v37/week                    the question of the week
//   POST /api/telegram-center-v37/week                    {question_id, answer}
//   GET  /api/telegram-center-v37/logo/<TRI>.svg          the logo of a team from our address (the picture may draw it)
import { weekApp } from "./telegram-center-v37-week-ui.js";
import { telegramAuth, upsertTelegramUser } from "./telegram-center-v29-predictions.js";
import { SHORT_RU } from "./telegram-center-v7.js";

export const SCRIPT_PATH = "/telegram-app/v37-week.js";
const API = "/api/telegram-center-v37";
const LOGO = /^\/api\/telegram-center-v37\/logo\/([A-Z]{3})\.svg$/;
export const WEEK_XP = 30;
export const SHOW_DAYS = 21;
const TEXT_MIN = 5;
const TEXT_MAX = 200;
const LABEL_MAX = 40;
const EXTRA_MAX = 4;
const OPTIONS_MAX = 8;
const TEAMS = Object.keys(SHORT_RU).sort((a, b) => SHORT_RU[a].localeCompare(SHORT_RU[b], "ru"));
export const teamLogo = (tri) => `https://assets.nhle.com/logos/nhl/svg/${tri}_light.svg`;
const norm = (s) => String(s || "").toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/g, "");

// the variants of a question: {key, label, logo?}
export function optionsOf(q) {
  let extra = [];
  try { extra = JSON.parse(q?.options_json || "[]"); } catch { extra = []; }
  extra = (Array.isArray(extra) ? extra : []).map((x) => String(x || "").trim()).filter(Boolean);
  if (q?.kind === "team") return [...TEAMS.map((tri) => ({ key: tri, label: SHORT_RU[tri], logo: teamLogo(tri) })), ...extra.map((label, i) => ({ key: `x${i + 1}`, label }))];
  return extra.map((label, i) => ({ key: `o${i + 1}`, label }));
}

// «Сан-Хосе», «SJS», «сан хосе», «Да» → the key of the variant (null: no such variant)
export function matchAnswer(q, text) {
  const t = norm(text);
  if (!t) return null;
  const opts = optionsOf(q);
  const exact = opts.find((o) => norm(o.label) === t || norm(o.key) === t);
  if (exact) return exact.key;
  const part = opts.filter((o) => norm(o.label).startsWith(t) || (t.length >= 4 && t.includes(norm(o.label))));
  return part.length === 1 ? part[0].key : null;
}

// /week Текст? | команда | Останется; Другое   or   /week Текст? | Да; Нет; Не знаю
export function parseWeek(arg) {
  const parts = String(arg || "").split("|").map((x) => x.trim());
  const text = (parts[0] || "").replace(/\s+/g, " ");
  if (text.length < TEXT_MIN || text.length > TEXT_MAX || parts.length < 2) return null;
  const list = (s) => String(s || "").split(";").map((x) => x.trim().replace(/\s+/g, " ")).filter(Boolean);
  if (/^команд/i.test(parts[1])) {
    const extra = list(parts.slice(2).join(";"));
    if (extra.length > EXTRA_MAX || extra.some((x) => x.length > LABEL_MAX)) return null;
    return { text, kind: "team", options: extra };
  }
  const options = list(parts.slice(1).join(";"));
  if (options.length < 2 || options.length > OPTIONS_MAX || options.some((x) => x.length > LABEL_MAX)) return null;
  if (new Set(options.map(norm)).size !== options.length) return null;
  return { text, kind: "options", options };
}

// what the app shows: the split only after one's own answer or once the question is not open any more
export function weekPayload(q, counts, commentators, my, admin) {
  if (!q) return { ok: true, question: null, admin: Boolean(admin) };
  const opts = optionsOf(q);
  const byKey = new Map(opts.map((o) => [o.key, o]));
  const total = counts.reduce((s, c) => s + (Number(c.n) || 0), 0);
  const open = q.status === "open";
  const visible = Boolean(my) || !open;
  const people = commentators.filter((c) => byKey.has(c.answer)).map((c) => ({ id: Number(c.id), name: c.name, answer: c.answer, label: byKey.get(c.answer).label }));
  const results = visible ? counts.filter((c) => byKey.has(c.answer)).map((c) => {
    const o = byKey.get(c.answer);
    return { key: o.key, label: o.label, logo: o.logo || null, count: Number(c.n) || 0, pct: total ? Math.round((100 * (Number(c.n) || 0)) / total) : 0, commentators: people.filter((p) => p.answer === o.key).map((p) => ({ id: p.id, name: p.name })) };
  }).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "ru")) : null;
  return {
    ok: true,
    admin: Boolean(admin),
    question: {
      id: Number(q.question_id), text: q.text, kind: q.kind, status: q.status, created_at: q.created_at, total,
      answer: q.status === "settled" ? q.answer : null,
      answer_label: q.status === "settled" && byKey.has(q.answer) ? byKey.get(q.answer).label : null,
      options: opts,
      // before one's own answer only how many commentators answered: «их выбор — после вашего ответа»
      commentators_total: people.length,
      commentators: visible ? people : null,
      results,
      my: my || null,
      right: q.status === "settled" && my ? my === q.answer : null,
      xp: q.status === "settled" && my && my === q.answer ? WEEK_XP : null,
    },
  };
}

async function adminOf(db, id) {
  const row = await db.prepare(`SELECT 1 ok FROM app_admins WHERE telegram_user_id=? LIMIT 1;`).bind(id).first().catch(() => null);
  return Boolean(row?.ok);
}

// the open question, else the last one of the last three weeks; a hidden last question hides the card (an older one does not come back)
export async function currentQuestion(db) {
  const q = await db.prepare(`
    SELECT * FROM week_questions WHERE created_at>=datetime('now','-${SHOW_DAYS} days')
    ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END,created_at DESC,question_id DESC LIMIT 1;
  `).first();
  return q && q.status !== "hidden" ? q : null;
}

async function answersOf(db, q) {
  const [counts, people] = await Promise.all([
    db.prepare(`SELECT answer,COUNT(*) n FROM week_answers WHERE question_id=? GROUP BY answer;`).bind(q.question_id).all(),
    db.prepare(`SELECT a.telegram_user_id id,h.display_name name,a.answer FROM week_answers a JOIN app_hosts h ON h.telegram_user_id=a.telegram_user_id
      WHERE a.question_id=? AND h.active=1 ORDER BY h.display_name;`).bind(q.question_id).all().catch(() => ({ results: [] })),
  ]);
  return { counts: counts.results || [], people: people.results || [] };
}

async function weekGet(request, env) {
  const db = env.DB;
  const auth = await telegramAuth(request, env, false);
  const q = await currentQuestion(db);
  if (!q) return json({ ok: true, question: null, admin: auth.ok ? await adminOf(db, auth.user.id) : false });
  const [{ counts, people }, mine, admin] = await Promise.all([
    answersOf(db, q),
    auth.ok ? db.prepare(`SELECT answer FROM week_answers WHERE question_id=? AND telegram_user_id=? LIMIT 1;`).bind(q.question_id, auth.user.id).first() : null,
    auth.ok ? adminOf(db, auth.user.id) : false,
  ]);
  return json(weekPayload(q, counts, people, mine?.answer || null, admin));
}

async function weekPost(request, env) {
  const db = env.DB;
  const auth = await telegramAuth(request, env, true);
  if (!auth.ok) return json({ ok: false, error: auth.error }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400); }
  const id = Number(body?.question_id);
  const answer = String(body?.answer || "");
  const q = Number.isSafeInteger(id) && id > 0 ? await db.prepare(`SELECT * FROM week_questions WHERE question_id=? LIMIT 1;`).bind(id).first() : null;
  if (!q || q.status === "hidden") return json({ ok: false, error: "question_not_found" }, 404);
  if (q.status !== "open") return json({ ok: false, error: "question_closed" }, 409);
  if (!optionsOf(q).some((o) => o.key === answer)) return json({ ok: false, error: "invalid_answer" }, 400);
  await upsertTelegramUser(db, auth.user);
  await db.prepare(`INSERT INTO week_answers(question_id,telegram_user_id,answer) VALUES(?,?,?)
    ON CONFLICT(question_id,telegram_user_id) DO UPDATE SET answer=excluded.answer,entered_by=NULL,updated_at=CURRENT_TIMESTAMP;`).bind(q.question_id, auth.user.id, answer).run();
  const [{ counts, people }, admin] = await Promise.all([answersOf(db, q), adminOf(db, auth.user.id)]);
  return json(weekPayload(q, counts, people, answer, admin));
}

// the logo of a team from our own address: a picture drawn by the app may use only pictures of its own site
async function logo(tri) {
  if (!SHORT_RU[tri]) return new Response("not_found", { status: 404 });
  const r = await fetch(teamLogo(tri), { cf: { cacheTtl: 86400, cacheEverything: true } }).catch(() => null);
  if (!r || !r.ok) return new Response("logo_unavailable", { status: 502 });
  return new Response(await r.arrayBuffer(), { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff" } });
}

// ---- the bot (admins only) ----------------------------------------------------------------------------------------------------
export const WEEK_COMMANDS = ["week", "week_close", "week_answer", "week_result", "week_hide", "week_stats"];
export const WEEK_HELP = [
  "«Вопрос недели» в приложении:",
  "/week Куда обменяют Ларкина? | команда | Останется — ответ: любая команда НХЛ (+ свои варианты через ;)",
  "/week Вопрос? | Да; Нет; Не знаю — свои варианты (2–8)",
  "/week_answer Протасов = Сан-Хосе — ответ комментатора из чата · /week_stats — как отвечают",
  "/week_close — закрыть ответы · /week_result Миннесота — правильный ответ (+30 XP угадавшим) · /week_hide — убрать",
].join("\n");

async function latest(db, statuses) {
  const q = statuses.map(() => "?").join(",");
  return db.prepare(`SELECT * FROM week_questions WHERE status IN (${q}) ORDER BY created_at DESC,question_id DESC LIMIT 1;`).bind(...statuses).first();
}

export async function handleWeekCommand(env, cmd, adminId, reply) {
  const db = env.DB;
  if (cmd.name === "week") {
    const w = parseWeek(cmd.arg);
    if (!w) { await reply(`Напишите так:\n${WEEK_HELP}`); return true; }
    await db.prepare(`UPDATE week_questions SET status='closed',closed_at=CURRENT_TIMESTAMP WHERE status='open';`).run();
    const r = await db.prepare(`INSERT INTO week_questions(text,kind,options_json,created_by) VALUES(?,?,?,?) RETURNING question_id;`).bind(w.text, w.kind, JSON.stringify(w.options), adminId).first();
    const what = w.kind === "team" ? `любая команда НХЛ${w.options.length ? ` или: ${w.options.join(", ")}` : ""}` : w.options.join(" / ");
    await reply(`Вопрос недели #${r?.question_id} в приложении ✅\n«${w.text}»\nОтвет: ${what}\n\nКомментаторы отвечают в приложении сами, или впишите их ответ: /week_answer Протасов = Сан-Хосе`);
    return true;
  }
  if (cmd.name === "week_close") {
    const q = await latest(db, ["open"]);
    if (!q) { await reply("Открытого вопроса нет."); return true; }
    await db.prepare(`UPDATE week_questions SET status='closed',closed_at=CURRENT_TIMESTAMP WHERE question_id=?;`).bind(q.question_id).run();
    await reply(`Ответы на «${q.text}» закрыты. Когда станет известен ответ: /week_result …`);
    return true;
  }
  if (cmd.name === "week_hide") {
    const q = await latest(db, ["open", "closed", "settled"]);
    if (!q) { await reply("Вопросов нет."); return true; }
    await db.prepare(`UPDATE week_questions SET status='hidden' WHERE question_id=?;`).bind(q.question_id).run();
    await reply(`«${q.text}» убран из приложения.`);
    return true;
  }
  if (cmd.name === "week_answer") {
    const m = /^(.{2,60}?)\s*=\s*(.{1,60})$/.exec(cmd.arg);
    if (!m) { await reply("Напишите так: /week_answer Протасов = Сан-Хосе"); return true; }
    const q = await latest(db, ["open", "closed"]);
    if (!q) { await reply("Нет вопроса, на который можно ответить."); return true; }
    const hosts = (await db.prepare(`SELECT telegram_user_id id,display_name name FROM app_hosts WHERE active=1;`).all()).results || [];
    const who = norm(m[1]);
    const found = hosts.filter((h) => norm(h.name) === who || norm(h.name).includes(who));
    if (found.length !== 1) { await reply(found.length ? `Под «${m[1]}» подходят: ${found.map((h) => h.name).join(", ")}. Напишите точнее.` : `Комментатора «${m[1]}» нет в списке. /hosts — список.`); return true; }
    const key = matchAnswer(q, m[2]);
    if (!key) { await reply(`Не понял ответ «${m[2]}». ${q.kind === "team" ? "Напишите город или трёхбуквенный код команды (MIN)." : `Варианты: ${optionsOf(q).map((o) => o.label).join(", ")}`}`); return true; }
    await db.prepare(`INSERT INTO week_answers(question_id,telegram_user_id,answer,entered_by) VALUES(?,?,?,?)
      ON CONFLICT(question_id,telegram_user_id) DO UPDATE SET answer=excluded.answer,entered_by=excluded.entered_by,updated_at=CURRENT_TIMESTAMP;`).bind(q.question_id, found[0].id, key, adminId).run();
    await reply(`🎙 ${found[0].name} — ${optionsOf(q).find((o) => o.key === key).label} ✅`);
    return true;
  }
  if (cmd.name === "week_result") {
    const q = await latest(db, ["open", "closed"]);
    if (!q) { await reply("Нет вопроса без ответа."); return true; }
    const key = matchAnswer(q, cmd.arg);
    if (!key) { await reply(`Не понял ответ «${cmd.arg}». Напишите так: /week_result Миннесота`); return true; }
    await db.prepare(`UPDATE week_questions SET status='settled',answer=?,settled_at=CURRENT_TIMESTAMP,closed_at=COALESCE(closed_at,CURRENT_TIMESTAMP) WHERE question_id=?;`).bind(key, q.question_id).run();
    await db.prepare(`UPDATE week_answers SET xp=CASE WHEN answer=? THEN ${WEEK_XP} ELSE 0 END WHERE question_id=?;`).bind(key, q.question_id).run();
    const r = await db.prepare(`SELECT COUNT(*) n,SUM(CASE WHEN answer=? THEN 1 ELSE 0 END) hits FROM week_answers WHERE question_id=?;`).bind(key, q.question_id).first();
    await reply(`Ответ: ${optionsOf(q).find((o) => o.key === key).label} ✅ Угадали ${Number(r?.hits) || 0} из ${Number(r?.n) || 0}, им +${WEEK_XP} XP.`);
    return true;
  }
  if (cmd.name === "week_stats") {
    const q = await latest(db, ["open", "closed", "settled"]);
    if (!q) { await reply("Вопросов нет."); return true; }
    const { counts, people } = await answersOf(db, q);
    const p = weekPayload({ ...q, status: "closed" }, counts, people, null, true).question;
    const lines = p.results.slice(0, 8).map((x) => `${x.label} — ${x.count} (${x.pct}%)${x.commentators.length ? ` · 🎙 ${x.commentators.map((c) => c.name).join(", ")}` : ""}`);
    await reply(`«${q.text}» (${q.status === "open" ? "идут ответы" : q.status === "closed" ? "ответы закрыты" : "есть ответ"})\nОтветов: ${p.total}\n${lines.join("\n") || "пока никто не ответил"}`);
    return true;
  }
  return false;
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

export async function handleTelegramCenterV37(request, env, path) {
  if (path === SCRIPT_PATH) {
    if (request.method !== "GET") return new Response("method_not_allowed", { status: 405 });
    const body = `(function(){const __name=(target,value)=>target;(${weekApp.toString()})();})();`;
    return new Response(body, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store, no-cache, must-revalidate", "X-Content-Type-Options": "nosniff" } });
  }
  if (path !== API && !path.startsWith(`${API}/`)) return null;
  const l = LOGO.exec(path);
  if (l && request.method === "GET") return logo(l[1]);
  if (!env?.DB) return json({ ok: false, error: "missing_d1_binding" }, 503);
  try {
    if (path === `${API}/week` && request.method === "GET") return await weekGet(request, env);
    if (path === `${API}/week` && request.method === "POST") return await weekPost(request, env);
  } catch (error) {
    console.error("v37 week failed", path, error);
    return json({ ok: false, error: "week_failed" }, 503);
  }
  return json({ ok: false, error: path === `${API}/week` ? "method_not_allowed" : "not_found" }, path === `${API}/week` ? 405 : 404);
}
