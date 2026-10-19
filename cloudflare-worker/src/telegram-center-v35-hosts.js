// Live Center v35: the hosts of Home of Hockey and the questions to them (package 3 of the owner's list, 2026-10-15).
//   - the public profiles of the hosts: their picks, accuracy and points this season; «Сравнить со мной»; «Зрители против
//     ведущих» — the accuracy of the fans against the hosts this week (the owner: «я бы сделала ведущим первыми публичными
//     профилями… это проще, чем сразу создавать социальную сеть»);
//   - «Задай вопрос ведущим»: the questions of the fans, the higher the level of the asker the higher the question in the list of
//     the admin; the answers are given on air (the admin sets the date: /ama 20 октября, 19:00).
//   GET  /api/telegram-center-v35/hosts                 the hosts, their picks, the contest of the week
//   GET  /api/telegram-center-v35/hosts/<id>/compare    me against a host (signed in)
//   GET  /api/telegram-center-v35/questions             my questions and the date of the answers (signed in)
//   POST /api/telegram-center-v35/questions             {text}
// The bot (admins only): /host_add @ник Имя Фамилия · /hosts · /host_remove @ник · /questions · /q_pick N · /q_done N · /q_hide N · /ama текст
import { hostsApp } from "./telegram-center-v35-hosts-ui.js";
import { telegramAuth, upsertTelegramUser } from "./telegram-center-v29-predictions.js";
import { levelOf, nhlDateOf, seasonOf, periodRange, weekXpOf } from "./telegram-center-v29-predictions-data.js";

export const SCRIPT_PATH = "/telegram-app/v35-hosts.js";
const API = "/api/telegram-center-v35";
const COMPARE = /^\/api\/telegram-center-v35\/hosts\/(\d{1,15})\/compare$/;
export const QUESTION_MIN = 5;
export const QUESTION_MAX = 300;
export const QUESTIONS_PER_DAY = 3;
export const FAN_MIN_WEEK_PICKS = 3;
const AMA_KEY = "hoh_ama_next_v1";
const SETTLED = "p.settled_at IS NOT NULL AND p.result IN ('win','loss')";

const pct = (c, t) => (t > 0 ? Math.round((100 * c) / t) : null);

async function statsOf(db, ids, season) {
  if (!ids.length) return new Map();
  const q = ids.map(() => "?").join(",");
  const r = await db.prepare(`
    SELECT p.telegram_user_id id,COUNT(*) settled,SUM(CASE WHEN p.result='win' THEN 1 ELSE 0 END) correct,SUM(p.xp) xp
    FROM fan_predictions p WHERE ${SETTLED} AND p.season_id=? AND p.telegram_user_id IN (${q}) GROUP BY p.telegram_user_id;
  `).bind(season, ...ids).all();
  return new Map((r.results || []).map((x) => [Number(x.id), { settled: Number(x.settled) || 0, correct: Number(x.correct) || 0, xp: Number(x.xp) || 0 }]));
}

// the contest of the week: the share of right picks of the fans (3+ played picks) against the hosts (1+)
export function contestOf(rows, hostIds) {
  const hosts = new Set(hostIds.map(Number));
  const side = (list) => {
    const settled = list.reduce((s, x) => s + x.settled, 0);
    const correct = list.reduce((s, x) => s + x.correct, 0);
    return { accuracy: pct(correct, settled), players: list.length };
  };
  const all = rows.map((x) => ({ id: Number(x.id), settled: Number(x.settled) || 0, correct: Number(x.correct) || 0 }));
  const h = all.filter((x) => hosts.has(x.id) && x.settled >= 1);
  const f = all.filter((x) => !hosts.has(x.id) && x.settled >= FAN_MIN_WEEK_PICKS);
  if (!h.length || !f.length) return null;
  const fans = side(f), hostsSide = side(h);
  return { fans, hosts: hostsSide, leader: fans.accuracy === hostsSide.accuracy ? "draw" : fans.accuracy > hostsSide.accuracy ? "fans" : "hosts" };
}

async function hosts(request, env, now) {
  const db = env.DB;
  const today = nhlDateOf(new Date(now).toISOString());
  const season = seasonOf(today);
  const list = (await db.prepare(`SELECT telegram_user_id id,display_name name FROM app_hosts WHERE active=1 ORDER BY created_at,telegram_user_id;`).all()).results || [];
  const ids = list.map((h) => Number(h.id));
  const stats = await statsOf(db, ids, season);
  let open = [];
  if (ids.length) {
    const q = ids.map(() => "?").join(",");
    open = (await db.prepare(`
      SELECT p.telegram_user_id id,p.pick_tri,g.away_tri,g.home_tri,g.scheduled_start_utc start
      FROM fan_predictions p JOIN games g ON g.game_pk=p.game_pk
      WHERE p.telegram_user_id IN (${q}) AND p.settled_at IS NULL AND g.scheduled_start_utc>=?
      ORDER BY g.scheduled_start_utc ASC LIMIT 60;
    `).bind(...ids, new Date(now - 6 * 3600000).toISOString()).all()).results || [];
  }
  const week = periodRange("week", today);
  const weekRows = (await db.prepare(`
    SELECT p.telegram_user_id id,COUNT(*) settled,SUM(CASE WHEN p.result='win' THEN 1 ELSE 0 END) correct
    FROM fan_predictions p WHERE ${SETTLED} AND p.game_date BETWEEN ? AND ? GROUP BY p.telegram_user_id;
  `).bind(week.from, week.to).all()).results || [];
  return json({
    ok: true,
    // the whole chat of the commentators is in app_hosts: the list shows those who made picks, the most accurate first
    hosts: list.map((h) => {
      const s = stats.get(Number(h.id)) || { settled: 0, correct: 0, xp: 0 };
      const lv = levelOf(s.xp);
      return {
        id: Number(h.id), name: h.name, settled: s.settled, correct: s.correct, accuracy: pct(s.correct, s.settled), xp: s.xp, level: lv.n, level_note: lv.note,
        picks: open.filter((x) => Number(x.id) === Number(h.id)).slice(0, 4).map((x) => ({ tri: x.pick_tri, game: `${x.away_tri} — ${x.home_tri}`, start: x.start })),
      };
    }).filter((h) => h.settled > 0 || h.picks.length > 0).sort((a, b) => (b.settled > 0) - (a.settled > 0) || (b.accuracy ?? -1) - (a.accuracy ?? -1) || b.settled - a.settled),
    contest: contestOf(weekRows, ids),
    week: { from: week.from, to: week.to },
  }, 200, "public, max-age=60");
}

async function compare(request, env, now, hostId) {
  const auth = await telegramAuth(request, env, true);
  if (!auth.ok) return json({ ok: false, error: auth.error }, 401);
  const db = env.DB;
  const host = await db.prepare(`SELECT telegram_user_id id,display_name name FROM app_hosts WHERE telegram_user_id=? AND active=1 LIMIT 1;`).bind(hostId).first();
  if (!host) return json({ ok: false, error: "host_not_found" }, 404);
  const season = seasonOf(nhlDateOf(new Date(now).toISOString()));
  const me = auth.user.id;
  const stats = await statsOf(db, [me, hostId], season);
  const common = await db.prepare(`
    SELECT COUNT(*) n,SUM(CASE WHEN a.pick=b.pick THEN 1 ELSE 0 END) agree
    FROM fan_predictions a JOIN fan_predictions b ON b.game_pk=a.game_pk
    WHERE a.telegram_user_id=? AND b.telegram_user_id=? AND a.season_id=?;
  `).bind(me, hostId, season).first();
  const side = (id) => { const s = stats.get(id) || { settled: 0, correct: 0, xp: 0 }; return { settled: s.settled, correct: s.correct, accuracy: pct(s.correct, s.settled), xp: s.xp }; };
  return json({ ok: true, host: { id: Number(host.id), name: host.name, ...side(Number(hostId)) }, me: side(me), common: Number(common?.n) || 0, agree: Number(common?.agree) || 0 });
}

export function cleanQuestion(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (t.length < QUESTION_MIN || t.length > QUESTION_MAX) return null;
  return t;
}

async function questionsGet(request, env) {
  const auth = await telegramAuth(request, env, true);
  if (!auth.ok) return json({ ok: false, error: auth.error }, 401);
  const [mine, ama] = await Promise.all([
    env.DB.prepare(`SELECT question_id id,text,status,created_at FROM host_questions WHERE telegram_user_id=? AND status<>'hidden' ORDER BY created_at DESC,question_id DESC LIMIT 10;`).bind(auth.user.id).all(),
    env.DB.prepare(`SELECT meta_value FROM data_core_meta WHERE meta_key=? LIMIT 1;`).bind(AMA_KEY).first().catch(() => null),
  ]);
  return json({ ok: true, questions: (mine.results || []).map((q) => ({ id: Number(q.id), text: q.text, status: q.status, created_at: q.created_at })), ama: ama?.meta_value || null });
}

async function questionsPost(request, env) {
  const auth = await telegramAuth(request, env, true);
  if (!auth.ok) return json({ ok: false, error: auth.error }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400); }
  const text = cleanQuestion(body?.text);
  if (!text) return json({ ok: false, error: "invalid_question" }, 400);
  const db = env.DB;
  const today = await db.prepare(`SELECT COUNT(*) n FROM host_questions WHERE telegram_user_id=? AND created_at>=datetime('now','-1 day');`).bind(auth.user.id).first();
  if (Number(today?.n) >= QUESTIONS_PER_DAY) return json({ ok: false, error: "too_many_questions" }, 429);
  await upsertTelegramUser(db, auth.user);
  const xp = await db.prepare(`SELECT COALESCE(SUM(xp),0) xp FROM fan_predictions WHERE telegram_user_id=? AND settled_at IS NOT NULL;`).bind(auth.user.id).first();
  const level = levelOf((Number(xp?.xp) || 0) + (await weekXpOf(db, auth.user.id))).n;
  await db.prepare(`INSERT INTO host_questions(telegram_user_id,text,level) VALUES(?,?,?);`).bind(auth.user.id, text, level).run();
  return json({ ok: true, level });
}

// ---- the bot (admins only) ----------------------------------------------------------------------------------------------------
export const HOST_COMMANDS = ["host_add", "hosts", "host_remove", "questions", "q_pick", "q_done", "q_hide", "ama"];
export const HOST_HELP = [
  "/host_add @ник Имя Фамилия — сделать комментатором HOH (его прогнозы и ответы видны всем со значком 🎙); /hosts — список; /host_remove @ник — убрать",
  "/questions — вопросы болельщиков (сначала от высоких уровней); /q_pick N — выбран для эфира; /q_done N — отвечен; /q_hide N — скрыть",
  "/ama текст — когда ответы в эфире (например: /ama 20 октября, 19:00); /ama - — убрать",
].join("\n");

export async function handleHostCommand(env, cmd, adminId, reply) {
  const db = env.DB;
  const userByNick = async (nick) => db.prepare(`SELECT telegram_user_id,username FROM telegram_users WHERE lower(username)=lower(?) LIMIT 1;`).bind(nick).first().catch(() => null);
  if (cmd.name === "host_add") {
    const m = /^@?([A-Za-z0-9_]{3,32})\s+(.{2,60})$/.exec(cmd.arg);
    if (!m) { await reply("Напишите так: /host_add @ник Имя Фамилия"); return true; }
    const user = await userByNick(m[1]);
    if (!user) { await reply(`@${m[1]} ещё не запускал бота. Попросите его нажать /start в этом боте и повторите.`); return true; }
    await db.prepare(`INSERT INTO app_hosts(telegram_user_id,display_name,active,added_by) VALUES(?,?,1,?)
      ON CONFLICT(telegram_user_id) DO UPDATE SET display_name=excluded.display_name,active=1;`).bind(user.telegram_user_id, m[2].trim(), adminId).run();
    await reply(`${m[2].trim()} (@${user.username}) теперь комментатор HOH 🎙 Его прогнозы видны всем в приложении.`);
    return true;
  }
  if (cmd.name === "hosts") {
    const rows = (await db.prepare(`SELECT h.display_name,u.username,h.active FROM app_hosts h LEFT JOIN telegram_users u ON u.telegram_user_id=h.telegram_user_id ORDER BY h.created_at;`).all()).results || [];
    await reply(rows.length ? `Комментаторы HOH:\n${rows.map((r) => `• ${r.display_name}${r.username ? ` (@${r.username})` : ""}${Number(r.active) ? "" : " — скрыт"}`).join("\n")}` : "Комментаторов пока нет. /host_add @ник Имя Фамилия");
    return true;
  }
  if (cmd.name === "host_remove") {
    const user = await userByNick(cmd.arg.replace(/^@/, "").trim());
    if (!user) { await reply("Напишите так: /host_remove @ник"); return true; }
    await db.prepare(`UPDATE app_hosts SET active=0 WHERE telegram_user_id=?;`).bind(user.telegram_user_id).run();
    await reply(`@${user.username} больше не показывается как комментатор.`);
    return true;
  }
  if (cmd.name === "questions") {
    const rows = (await db.prepare(`SELECT q.question_id id,q.text,q.level,q.status,u.username FROM host_questions q LEFT JOIN telegram_users u ON u.telegram_user_id=q.telegram_user_id
      WHERE q.status IN ('new','picked') ORDER BY CASE q.status WHEN 'picked' THEN 0 ELSE 1 END,q.level DESC,q.created_at ASC,q.question_id ASC LIMIT 15;`).all()).results || [];
    if (!rows.length) { await reply("Новых вопросов нет."); return true; }
    await reply(`Вопросы болельщиков (сначала выбранные, потом по уровню):\n\n${rows.map((r) => `#${r.id} · ур. ${r.level}${r.status === "picked" ? " · ✅ выбран" : ""}${r.username ? ` · @${r.username}` : ""}\n${r.text}`).join("\n\n")}\n\n/q_pick N — выбрать для эфира · /q_done N — отвечен · /q_hide N — скрыть`);
    return true;
  }
  if (["q_pick", "q_done", "q_hide"].includes(cmd.name)) {
    const id = Number(String(cmd.arg).replace(/^#/, ""));
    if (!Number.isSafeInteger(id) || id <= 0) { await reply(`Напишите номер вопроса: /${cmd.name} 12`); return true; }
    const status = cmd.name === "q_pick" ? "picked" : cmd.name === "q_done" ? "answered" : "hidden";
    const found = await db.prepare(`SELECT question_id FROM host_questions WHERE question_id=? LIMIT 1;`).bind(id).first();
    if (!found) { await reply(`Вопроса #${id} нет.`); return true; }
    await db.prepare(`UPDATE host_questions SET status=?,updated_at=CURRENT_TIMESTAMP WHERE question_id=?;`).bind(status, id).run();
    await reply(`Вопрос #${id}: ${status === "picked" ? "выбран для эфира ✅" : status === "answered" ? "отмечен как отвеченный ✅" : "скрыт"}`);
    return true;
  }
  if (cmd.name === "ama") {
    const value = String(cmd.arg || "").trim();
    if (!value) { await reply("Напишите так: /ama 20 октября, 19:00 — эфир с ответами (или /ama - чтобы убрать)"); return true; }
    if (value === "-") await db.prepare(`DELETE FROM data_core_meta WHERE meta_key=?;`).bind(AMA_KEY).run();
    else await db.prepare(`INSERT INTO data_core_meta(meta_key,meta_value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP;`).bind(AMA_KEY, value.slice(0, 120)).run();
    await reply(value === "-" ? "Дата ответов убрана." : `В приложении: «Ответы в эфире: ${value.slice(0, 120)}» ✅`);
    return true;
  }
  return false;
}

function json(payload, status = 200, cache = "no-store") {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache, "X-Content-Type-Options": "nosniff" } });
}

export async function handleTelegramCenterV35(request, env, path) {
  if (path === SCRIPT_PATH) {
    if (request.method !== "GET") return new Response("method_not_allowed", { status: 405 });
    const body = `(function(){const __name=(target,value)=>target;(${hostsApp.toString()})();})();`;
    return new Response(body, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store, no-cache, must-revalidate", "X-Content-Type-Options": "nosniff" } });
  }
  if (path !== API && !path.startsWith(`${API}/`)) return null;
  if (!env?.DB) return json({ ok: false, error: "missing_d1_binding" }, 503);
  const now = Date.now();
  try {
    if (path === `${API}/hosts` && request.method === "GET") return await hosts(request, env, now);
    const c = COMPARE.exec(path);
    if (c && request.method === "GET") return await compare(request, env, now, Number(c[1]));
    if (path === `${API}/questions` && request.method === "GET") return await questionsGet(request, env);
    if (path === `${API}/questions` && request.method === "POST") return await questionsPost(request, env);
  } catch (error) {
    console.error("v35 hosts failed", path, error);
    return json({ ok: false, error: "hosts_failed" }, 503);
  }
  const known = [`${API}/hosts`, `${API}/questions`].includes(path) || COMPARE.test(path);
  return json({ ok: false, error: known ? "method_not_allowed" : "not_found" }, known ? 405 : 404);
}
