// Russian names of players. Order of trust: a correction of an admin (table player_name_overrides, made in the Center bot) →
// Sports.ru (ru_full_names.json, refreshed every morning by the "Refresh Center Russian player names" workflow) → a careful
// transliteration of the English name, only for the few players Sports.ru does not know.
import sportsRuNames from "../../ru_full_names.json" with { type: "json" };

export const NAMES_ALGO = "names-v2";

export function sportsRuName(playerId) {
  const name = String(sportsRuNames?.[String(playerId)] || "").trim();
  return name || null;
}

export async function loadNameOverrides(db) {
  const rows = await db.prepare(`SELECT player_id, full_name_ru FROM player_name_overrides;`).all().catch(() => ({ results: [] }));
  return new Map((rows.results || []).map((r) => [String(r.player_id), String(r.full_name_ru || "").trim()]).filter(([, n]) => n));
}

// Sports.ru names with the admins' corrections on top: what the app shows for every known player.
export function mergedNames(overrides) {
  const out = {};
  for (const [id, name] of Object.entries(sportsRuNames || {})) if (/^\d+$/.test(id) && String(name || "").trim()) out[id] = String(name).trim();
  for (const [id, name] of overrides || []) out[id] = name;
  return out;
}

export function resolveRuName(playerId, fullNameEn, overrides) {
  const id = String(playerId);
  const fixed = overrides?.get?.(id);
  if (fixed) return { name: fixed, source: "admin" };
  const sports = sportsRuName(id);
  if (sports) return { name: sports, source: "sportsru" };
  const auto = transliterateName(fullNameEn);
  return { name: auto || null, source: auto ? "translit" : null };
}

// The old letter-by-letter transliteration ("Еммитт Финние", "Мичаел Брандсегг-нйгåрд"). Kept only to recognise its output.
export function legacyTransliterate(value) {
  const words = String(value || "").trim().split(/\s+/).filter(Boolean);
  return words.map((word) => {
    let s = word.toLowerCase();
    const pairs = [["shch", "щ"], ["yo", "ё"], ["yu", "ю"], ["ya", "я"], ["zh", "ж"], ["kh", "х"], ["ts", "ц"], ["ch", "ч"], ["sh", "ш"], ["ph", "ф"], ["th", "т"], ["ck", "к"], ["qu", "кв"], ["mc", "мак"]];
    for (const [a, b] of pairs) s = s.split(a).join(b);
    const map = { a: "а", b: "б", c: "к", d: "д", e: "е", f: "ф", g: "г", h: "х", i: "и", j: "дж", k: "к", l: "л", m: "м", n: "н", o: "о", p: "п", q: "к", r: "р", s: "с", t: "т", u: "у", v: "в", w: "в", x: "кс", y: "й", z: "з" };
    s = [...s].map((ch) => map[ch] || ch).join("");
    return s ? s[0].toUpperCase() + s.slice(1) : s;
  }).join(" ");
}

const ACCENTS = { "å": "o", "ø": "ö", "é": "e", "è": "e", "ê": "e", "ë": "e", "á": "a", "à": "a", "â": "a", "í": "i", "ì": "i", "ï": "i", "ó": "o", "ò": "o", "ô": "o", "ú": "u", "ù": "u", "û": "u", "ý": "y", "č": "ch", "š": "sh", "ž": "zh", "ř": "rzh", "ě": "e", "ł": "l", "ñ": "n", "ç": "s", "ś": "s", "ź": "z", "ć": "ch", "ń": "n" };
const VOWELS = "aeiouyäöü";
const SINGLE = { a: "а", b: "б", c: "к", d: "д", e: "е", f: "ф", g: "г", h: "х", i: "и", j: "дж", k: "к", l: "л", m: "м", n: "н", o: "о", p: "п", q: "к", r: "р", s: "с", t: "т", u: "у", v: "в", w: "в", x: "кс", y: "и", z: "з", "ä": "я", "ö": "ё", "ü": "ю" };
const DIGRAPHS = [["shch", "щ"], ["sch", "ш"], ["tch", "ч"], ["ch", "ч"], ["sh", "ш"], ["zh", "ж"], ["kh", "х"], ["tz", "ц"], ["ts", "ц"], ["ph", "ф"], ["th", "т"], ["ck", "к"], ["qu", "кв"], ["oo", "у"], ["ee", "и"], ["ea", "и"], ["ie", "и"], ["ou", "у"], ["ow", "оу"], ["oa", "о"], ["aw", "о"], ["ai", "эй"], ["ay", "эй"], ["ey", "и"], ["oy", "ой"], ["ew", "ью"], ["gh", "г"], ["wh", "у"]];
const LONG = { a: "ей", i: "ай", y: "ай", o: "оу", u: "ю" };

function translitWord(word) {
  let w = [...String(word).toLowerCase()].map((ch) => ACCENTS[ch] ?? ch).join("").replace(/['’]/g, "");
  if (!w) return "";
  let prefix = "";
  if (w.startsWith("mc") && w.length > 3) { prefix = "мак"; w = w.slice(2); }
  // a final silent "e" after a vowel and one consonant makes that vowel long: Mike → Майк, Kyle → Кайл, Gage → Гейдж, Luke → Люк
  const magic = w.length > 3 && /[^aeiouy][aiouy][bcdfgklmnprstvz]e$/.test(w);
  if (magic) w = w.slice(0, -1);
  let out = "";
  for (let i = 0; i < w.length;) {
    const rest = w.slice(i);
    const prev = i > 0 ? w[i - 1] : "";
    const next = w[i + 1] || "";
    if (magic && i === w.length - 2 && LONG[w[i]]) { out += LONG[w[i]]; i += 1; continue; }
    if (magic && i === w.length - 1 && w[i] === "g") { out += "дж"; i += 1; continue; }
    const pair = DIGRAPHS.find(([a]) => rest.startsWith(a));
    if (pair) { out += pair[1]; i += pair[0].length; continue; }
    const ch = w[i];
    if (ch === "e" && (i === 0 || VOWELS.includes(prev))) { out += "э"; i++; continue; }
    if (ch === "y" && i === 0 && VOWELS.includes(next)) { out += { a: "я", u: "ю", o: "йо", e: "е", i: "йи" }[next] || "й"; i += 2; continue; }
    if (ch === "y" && VOWELS.includes(prev)) { out += "й"; i++; continue; }
    if (ch === "c") { out += "eiy".includes(next) ? "с" : "к"; i++; continue; }
    if (ch === "w" && VOWELS.includes(next)) { out += "у"; i++; continue; }
    // "u" before two consonants sounds "а": Justin → Джастин, Dustin → Дастин
    if (ch === "u" && next && !VOWELS.includes(next) && w[i + 2] && !VOWELS.includes(w[i + 2])) { out += "а"; i++; continue; }
    if (ch === "h" && i > 0) { i++; continue; }
    out += SINGLE[ch] ?? ch;
    i++;
  }
  out = prefix + out;
  return out ? out[0].toUpperCase() + out.slice(1) : out;
}

// Careful English → Russian transliteration for players Sports.ru does not know: "Justin Dowling" → "Джастин Доулинг". An admin
// can still correct it in the bot, but nothing like "Мичаел Брандсегг-нйгåрд" any more.
export function transliterateName(value) {
  return String(value || "").trim().split(/\s+/).filter(Boolean)
    .map((word) => word.split("-").map(translitWord).join("-"))
    .join(" ") || null;
}

// Russian age: 21 год, 22 года, 25 лет.
export function yearsWord(n) {
  const x = Math.abs(Number(n)) % 100, y = x % 10;
  if (x > 10 && x < 20) return "лет";
  if (y === 1) return "год";
  if (y >= 2 && y <= 4) return "года";
  return "лет";
}
