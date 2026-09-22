// Broadcast Market Library
// Turns one analytical signal into multiple TV-friendly narratives.

const VARIANTS = {
  moneyline: [
    "ПОБЕДА {TEAM}: {STAT}",
    "{TEAM} ПЕРЕД ИГРОЙ: {STAT}",
    "ФАКТОР ФОРМЫ: {TEAM} — {STAT}",
    "КТО ЗАБЕРЁТ МАТЧ? ИСТОРИЯ ГОВОРИТ: {STAT}",
  ],
  game_total: [
    "ТОТАЛ {LINE}: {STAT}",
    "ЖДЁМ ГОЛОВ? {STAT}",
    "АТАКА ПРОТИВ ОБОРОНЫ: {STAT}",
    "ИСТОРИЯ ЭТИХ КОМАНД: {STAT}",
  ],
  team_total: [
    "{TEAM}: {STAT} ПО ГОЛАМ",
    "АТАКА {TEAM} ПЕРЕД МАТЧЕМ: {STAT}",
    "СКОЛЬКО ЖДАТЬ ОТ {TEAM}: {STAT}",
  ],
  handicap: [
    "ФОРА {LINE}: {STAT}",
    "РАЗНИЦА ШАЙБ: {STAT}",
    "МАТЧАП ПО СИЛЕ: {STAT}",
  ],
  period_total: [
    "{PERIOD} ПЕРИОД: {STAT}",
    "КАК НАЧНУТ МАТЧ? {STAT}",
    "ПЕРВЫЕ МИНУТЫ ИГРЫ: {STAT}",
  ],
  live: [
    "ДАВЛЕНИЕ В МАТЧЕ: {STAT}",
    "ПОСЛЕДНИЕ {MINUTES} МИНУТ: {STAT}",
    "КТО БЛИЖЕ К ГОЛУ: {STAT}",
    "MOMENTUM: {STAT}",
  ],
  goalie: [
    "ВРАТАРСКИЙ ФАКТОР: {STAT}",
    "СТЕНА В ВОРОТАХ: {STAT}",
  ],
  special_teams: [
    "БОЛЬШИНСТВО МОЖЕТ РЕШИТЬ: {STAT}",
    "СПЕЦБРИГАДЫ: {STAT}",
  ],
};

export function getBroadcastVariants(type, data = {}) {
  const pool = VARIANTS[type] || [];
  return pool.map(template => template.replace(/\{(\w+)\}/g, (_, key) => data[key] ?? ""));
}

export function getAllBroadcastFamilies(){
  return Object.keys(VARIANTS);
}
