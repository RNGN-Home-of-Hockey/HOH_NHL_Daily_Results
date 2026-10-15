// Admin commands of the Center bot (private chat, only for the Telegram accounts in app_admins):
//   /name <part of the name>   — find a player by his English or Russian name, then ✏️ fix the Russian name or ↩️ return the Sports.ru one
//   /names                     — players on the current rosters whose Russian name is a transliteration (Sports.ru does not know them)
//   /admins, /admin_add @nick  — who may do this; a new admin must have pressed /start in the bot once
//   /cancel                    — stop the current edit
// A correction is kept in player_name_overrides and wins over Sports.ru everywhere in the app (see telegram-center-player-names.js).
import { sportsRuName, transliterateName } from "./telegram-center-player-names.js";
import { HOST_COMMANDS, HOST_HELP, handleHostCommand } from "./telegram-center-v35-hosts.js";

const NAME_RE = /^[А-ЯЁа-яё][А-ЯЁа-яё'’ .\-]{0,58}[А-ЯЁа-яё.]$/;
const MAX_RESULTS = 8;

export async function isAdmin(db, userId) {
  const id = Number(userId);
  if (!db || !Number.isSafeInteger(id) || id <= 0) return false;
  const row = await db.prepare(`SELECT 1 ok FROM app_admins WHERE telegram_user_id=? LIMIT 1;`).bind(id).first().catch(() => null);
  return Boolean(row?.ok);
}

function command(text) {
  const m = /^\/([a-zа-яё_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(String(text || "").trim());
  return m ? { name: m[1].toLowerCase(), arg: String(m[2] || "").trim() } : null;
}

const norm = (s) => String(s || "").toLowerCase().replace(/ё/g, "е").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-zа-я0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

function sourceLabel(id, current, override) {
  if (override) return "правка админа";
  const sports = sportsRuName(id);
  if (sports && sports === current) return "Sports.ru";
  return "авто-перевод";
}

async function findPlayers(db, query) {
  const q = norm(query);
  if (q.length < 2) return [];
  const rows = await db.prepare(`
    SELECT p.player_id, p.full_name_en, p.full_name_ru, p.current_team_tri, p.sweater_number, COALESCE(p.active,0) active, o.full_name_ru override
    FROM players p LEFT JOIN player_name_overrides o ON o.player_id=p.player_id;
  `).all();
  const scored = [];
  for (const r of rows.results || []) {
    const en = norm(r.full_name_en), ru = norm(r.full_name_ru);
    let score = 0;
    for (const name of [en, ru]) {
      if (!name) continue;
      if (name === q) score = Math.max(score, 100);
      else if (name.split(" ").includes(q)) score = Math.max(score, 80);
      else if (name.split(" ").some((w) => w.startsWith(q))) score = Math.max(score, 60);
      else if (name.includes(q)) score = Math.max(score, 40);
    }
    if (score) scored.push({ ...r, score: score + (Number(r.active) ? 10 : 0) });
  }
  return scored.sort((a, b) => b.score - a.score || String(a.full_name_en).localeCompare(String(b.full_name_en))).slice(0, MAX_RESULTS);
}

function playerLine(r, i) {
  const team = [r.current_team_tri, r.sweater_number != null ? `#${r.sweater_number}` : ""].filter(Boolean).join(" ");
  return `${i + 1}. ${r.full_name_en}${team ? ` · ${team}` : ""}\n    ${r.full_name_ru || "—"} (${sourceLabel(r.player_id, r.full_name_ru, r.override)})`;
}

function playerButtons(rows) {
  const keyboard = [];
  for (const [i, r] of rows.entries()) {
    const last = String(r.full_name_en || "").split(" ").slice(-1)[0] || "игрок";
    const row = [{ text: `✏️ ${i + 1}. ${last}`, callback_data: `nm:${r.player_id}` }];
    if (r.override) row.push({ text: "↩️ как на Sports.ru", callback_data: `nr:${r.player_id}` });
    keyboard.push(row);
  }
  return keyboard;
}

async function setState(db, userId, action, payload) {
  await db.prepare(`INSERT INTO admin_bot_state(telegram_user_id,action,payload,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_user_id) DO UPDATE SET action=excluded.action,payload=excluded.payload,updated_at=CURRENT_TIMESTAMP;`).bind(userId, action, payload).run();
}
async function getState(db, userId) {
  const row = await db.prepare(`SELECT action,payload,updated_at FROM admin_bot_state WHERE telegram_user_id=?;`).bind(userId).first().catch(() => null);
  if (!row) return null;
  const age = Date.now() - Date.parse(`${String(row.updated_at).replace(" ", "T")}Z`);
  if (Number.isFinite(age) && age > 30 * 60 * 1000) return null; // an edit left for half an hour is forgotten
  return row;
}
async function clearState(db, userId) {
  await db.prepare(`DELETE FROM admin_bot_state WHERE telegram_user_id=?;`).bind(userId).run();
}

async function playerById(db, id) {
  return db.prepare(`SELECT p.player_id,p.full_name_en,p.full_name_ru,p.current_team_tri,o.full_name_ru override FROM players p LEFT JOIN player_name_overrides o ON o.player_id=p.player_id WHERE p.player_id=?;`).bind(id).first();
}

async function writeName(db, id, name) {
  await db.batch([
    db.prepare(`UPDATE players SET full_name_ru=? WHERE player_id=?;`).bind(name, id),
    db.prepare(`UPDATE player_profile_meta SET full_name_ru=?,updated_at=CURRENT_TIMESTAMP WHERE player_id=?;`).bind(name, id),
  ]);
}

export async function saveNameOverride(db, { playerId, name, adminId }) {
  const clean = String(name || "").replace(/\s+/g, " ").trim();
  if (!NAME_RE.test(clean)) return { ok: false, error: "bad_name" };
  const player = await playerById(db, playerId);
  if (!player) return { ok: false, error: "no_player" };
  await db.prepare(`INSERT INTO player_name_overrides(player_id,full_name_ru,previous_name_ru,edited_by,edited_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(player_id) DO UPDATE SET full_name_ru=excluded.full_name_ru,previous_name_ru=player_name_overrides.previous_name_ru,edited_by=excluded.edited_by,edited_at=CURRENT_TIMESTAMP;`)
    .bind(playerId, clean, player.full_name_ru || null, adminId || null).run();
  await writeName(db, playerId, clean);
  return { ok: true, player, name: clean };
}

export async function resetNameOverride(db, playerId) {
  const player = await playerById(db, playerId);
  if (!player) return { ok: false, error: "no_player" };
  await db.prepare(`DELETE FROM player_name_overrides WHERE player_id=?;`).bind(playerId).run();
  const name = sportsRuName(playerId) || transliterateName(player.full_name_en);
  if (name) await writeName(db, playerId, name);
  return { ok: true, player, name };
}

const HELP = [
  "🛠 Команды админа",
  "",
  "/name Финни — найти игрока по английскому или русскому имени и исправить его русское имя",
  "/names — игроки текущих составов с автоматическим переводом имени (их нет на Sports.ru)",
  "/admins — кто админ; /admin_add @ник — добавить админа (он должен один раз нажать /start в боте)",
  "/cancel — отменить правку",
  "",
  HOST_HELP,
].join("\n");

// Returns { handled } — false for everyone who is not an admin and for messages that are not admin commands.
export async function handleAdminMessage(env, message, send) {
  const db = env?.DB;
  const userId = Number(message?.from?.id);
  const chatId = message?.chat?.id;
  if (!db || !chatId || message?.chat?.type !== "private") return { handled: false };
  const text = String(message?.text || "").trim();
  const cmd = command(text);
  const adminCommands = ["name", "имя", "names", "admins", "admin_add", "cancel", "admin", ...HOST_COMMANDS];
  const state = cmd ? null : await getState(db, userId);
  if (!(cmd && adminCommands.includes(cmd.name)) && !(state && state.action === "rename")) return { handled: false };
  if (!(await isAdmin(db, userId))) return { handled: false };
  const reply = (textOut, extra = {}) => send({ chat_id: chatId, text: textOut, disable_web_page_preview: true, ...extra });

  if (state && state.action === "rename" && !cmd) {
    const playerId = Number(state.payload);
    const saved = await saveNameOverride(db, { playerId, name: text, adminId: userId });
    if (!saved.ok) {
      await reply(saved.error === "bad_name" ? "Имя должно быть русскими буквами, например «Эммитт Финни». Пришлите ещё раз или /cancel." : "Игрок не найден. /cancel и поиск заново: /name …");
      return { handled: true };
    }
    await clearState(db, userId);
    await reply(`Готово ✅ ${saved.player.full_name_en} → ${saved.name}\nПриложение покажет новое имя в течение пары минут.`);
    return { handled: true };
  }

  if (cmd.name === "cancel") {
    await clearState(db, userId);
    await reply("Правка отменена.");
    return { handled: true };
  }
  if (cmd.name === "admin") {
    await reply(HELP);
    return { handled: true };
  }
  if (cmd.name === "name" || cmd.name === "имя") {
    if (!cmd.arg) { await reply(`Напишите часть имени: /name Finnie или /name Финни\n\n${HELP}`); return { handled: true }; }
    const rows = await findPlayers(db, cmd.arg);
    if (!rows.length) { await reply(`По «${cmd.arg}» никого не нашёл. Попробуйте фамилию по-английски или по-русски.`); return { handled: true }; }
    await reply(`Нашёл ${rows.length}:\n\n${rows.map(playerLine).join("\n")}\n\nНажмите ✏️, чтобы исправить русское имя.`, { reply_markup: { inline_keyboard: playerButtons(rows) } });
    return { handled: true };
  }
  if (cmd.name === "names") {
    const rows = await db.prepare(`SELECT p.player_id,p.full_name_en,p.full_name_ru,p.current_team_tri,p.sweater_number,1 active,o.full_name_ru override
      FROM players p LEFT JOIN player_name_overrides o ON o.player_id=p.player_id WHERE COALESCE(p.active,0)=1 AND o.player_id IS NULL ORDER BY p.current_team_tri,p.full_name_en;`).all();
    const auto = (rows.results || []).filter((r) => !sportsRuName(r.player_id)).slice(0, MAX_RESULTS);
    if (!auto.length) { await reply("У всех игроков текущих составов имя со Sports.ru или исправлено админом ✅"); return { handled: true }; }
    await reply(`Имя переведено автоматически (нет на Sports.ru):\n\n${auto.map(playerLine).join("\n")}`, { reply_markup: { inline_keyboard: playerButtons(auto) } });
    return { handled: true };
  }
  // the hosts and the questions of the fans (v35)
  if (HOST_COMMANDS.includes(cmd.name)) {
    await handleHostCommand(env, cmd, userId, reply);
    return { handled: true };
  }
  if (cmd.name === "admins") {
    const rows = await db.prepare(`SELECT a.telegram_user_id,u.username,u.first_name FROM app_admins a LEFT JOIN telegram_users u ON u.telegram_user_id=a.telegram_user_id ORDER BY a.created_at;`).all();
    await reply(`Админы:\n${(rows.results || []).map((r) => `• ${r.username ? `@${r.username}` : r.first_name || r.telegram_user_id}`).join("\n")}`);
    return { handled: true };
  }
  if (cmd.name === "admin_add") {
    const nick = cmd.arg.replace(/^@/, "").trim();
    if (!nick) { await reply("Напишите так: /admin_add @ник"); return { handled: true }; }
    const user = await db.prepare(`SELECT telegram_user_id,username FROM telegram_users WHERE lower(username)=lower(?) LIMIT 1;`).bind(nick).first().catch(() => null);
    if (!user) { await reply(`@${nick} ещё не запускал бота. Попросите его нажать /start в этом боте и повторите.`); return { handled: true }; }
    await db.prepare(`INSERT INTO app_admins(telegram_user_id,added_by) VALUES(?,?) ON CONFLICT(telegram_user_id) DO NOTHING;`).bind(user.telegram_user_id, userId).run();
    await reply(`@${user.username} теперь админ ✅`);
    return { handled: true };
  }
  return { handled: false };
}

export async function handleAdminCallback(env, callback, send, answer) {
  const data = String(callback?.data || "");
  const m = /^(nm|nr):(\d{6,10})$/.exec(data);
  if (!m) return { handled: false };
  const db = env?.DB;
  const userId = Number(callback?.from?.id);
  const chatId = callback?.message?.chat?.id;
  if (!db || !(await isAdmin(db, userId))) {
    await answer(callback.id, "Только для админов");
    return { handled: true };
  }
  const playerId = Number(m[2]);
  if (m[1] === "nm") {
    const player = await playerById(db, playerId);
    if (!player) { await answer(callback.id, "Игрок не найден"); return { handled: true }; }
    await setState(db, userId, "rename", String(playerId));
    await answer(callback.id, "Жду новое имя");
    if (chatId) await send({ chat_id: chatId, text: `Напишите новое русское имя для ${player.full_name_en}\nСейчас: ${player.full_name_ru || "—"}\n\nОтмена — /cancel` });
    return { handled: true };
  }
  const reset = await resetNameOverride(db, playerId);
  await answer(callback.id, reset.ok ? "Вернул имя со Sports.ru" : "Игрок не найден");
  if (reset.ok && chatId) await send({ chat_id: chatId, text: `↩️ ${reset.player.full_name_en} → ${reset.name || "—"} (как на Sports.ru)` });
  return { handled: true };
}
