// Broadcast Line Variation Engine
// Generates editorially different ways to use the same market evidence.
// Goal: avoid repeating identical betting cards on air.

const TEMPLATES = {
  moneyline: [
    "{team} ПОБЕЖДАЕТ В {pct}% ПОСЛЕДНИХ МАТЧЕЙ",
    "{team}: ФОРМА ПЕРЕД ИГРОЙ — {pct}% ПОБЕД",
    "{team} ИДЁТ ЗА ПОБЕДОЙ ПОСЛЕ {sample} МАТЧЕЙ",
  ],
  game_total: [
    "ТОТАЛ {line} ПРОБИВАЛСЯ В {pct}% ИГР",
    "ОБОРОНЫ НЕ ЗАКРЫВАЮТ ИГРУ: {pct}% ПРОХОДА ТБ {line}",
    "ИСТОРИЯ МАТЧЕЙ ГОВОРИТ О ГОЛАХ: {pct}% НАД ЛИНИЕЙ",
  ],
  team_total: [
    "{team} ЗАБИВАЕТ ЧАЩЕ ЛИНИИ {line} В {pct}% ИГР",
    "АТАКА {team}: {pct}% МАТЧЕЙ С НУЖНЫМ ОБЪЁМОМ",
    "СКОЛЬКО ГОЛОВ ЖДАТЬ ОТ {team}: ИСТОРИЯ {pct}%",
  ],
  handicap: [
    "{team} УДЕРЖИВАЕТ ФОРУ {line} В {pct}% СЛУЧАЕВ",
    "МАТЧАП ПО РАЗНИЦЕ ШАЙБ: {pct}% ПОДТВЕРЖДЕНИЙ",
    "{team} ЧАЩЕ ДЕРЖИТ ЭТУ ГРАНИЦУ, ЧЕМ НЕТ",
  ],
  period: [
    "{period}: {team} ИМЕЕТ СВОЙ СЦЕНАРИЙ",
    "ПЕРИОДНЫЙ ТРЕНД: {pct}% ПОПАДАНИЙ",
    "ГДЕ РЕШАЕТСЯ ИГРА: {period} ПЕРИОД",
  ],
  live: [
    "ПОСЛЕДНИЕ {minutes} МИНУТ: ДАВЛЕНИЕ {team}",
    "MOMENTUM: {team} ЗАБИРАЕТ ИНИЦИАТИВУ",
    "СЦЕНАРИЙ МАТЧА МЕНЯЕТСЯ ПО БРОСКАМ",
  ],
};

export function buildLineVariations(card = {}) {
  const marketType = normalizeType(card.market?.type || card.kind);
  const templates = TEMPLATES[marketType] || TEMPLATES.moneyline;
  const data = {
    team: card.market?.subject || card.team || "КОМАНДА",
    pct: Math.round(Number(card.rate || card.evidence?.hit_rate || 0) * 100),
    sample: card.evidence?.sample || card.sample || "",
    line: card.market?.line || "",
    period: card.period || "",
    minutes: card.minutes || "10",
  };

  return templates.map((template, index) => ({
    variant_id: `${marketType}_${index + 1}`,
    text: fill(template, data),
  }));
}

export function chooseBroadcastVariation(card = {}, used = []) {
  const variants = buildLineVariations(card);
  return variants.find(v => !used.includes(v.variant_id)) || variants[0] || null;
}

function normalizeType(type) {
  const t = String(type || "").toLowerCase();
  if (t.includes("total") && t.includes("team")) return "team_total";
  if (t.includes("total")) return "game_total";
  if (t.includes("handicap") || t.includes("spread")) return "handicap";
  if (t.includes("period")) return "period";
  if (t.includes("live")) return "live";
  return "moneyline";
}

function fill(template, data) {
  return template.replace(/\{(\w+)\}/g, (_, key) => data[key] ?? "");
}
