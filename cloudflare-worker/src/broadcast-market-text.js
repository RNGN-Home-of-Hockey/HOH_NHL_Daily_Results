// The market line under the fact on the broadcast card (the PNG for OBS) and on the operator's card in the portal.
// One function for both: the portal gets it as source text inside /broadcast/app.js, so it must stay self-contained
// (no imports, no outer names). It always says the period: commentators read «1-Й ПЕРИОД · ТОТАЛ БОЛЬШЕ 1,5», never
// «ОБЩИЙ ТОТАЛ БОЛЬШЕ 1,5» for a line of the first period (complaint of 2026-10-11). Returns null for an unknown market,
// so the caller keeps its own fallback.
export function broadcastMarketText(market) {
  const m = market && typeof market === "object" ? market : {};
  const type = String(m.type || m.market_type || "").toLowerCase();
  const side = String(m.side || "").toLowerCase();
  const line = m.line === null || m.line === undefined || m.line === "" ? NaN : Number(m.line);
  const periodRaw = String(m.period || "").toUpperCase();
  const typePeriod = /^period_([123])_result$/.exec(type);
  const period = typePeriod ? "P" + typePeriod[1] : periodRaw;
  const p = period === "P1" ? "1-Й ПЕРИОД · " : period === "P2" ? "2-Й ПЕРИОД · " : period === "P3" ? "3-Й ПЕРИОД · " : "";
  const num = (v) => String(v).replace(".", ",");
  const signed = (v) => (v > 0 ? "+" : v < 0 ? "-" : "") + num(Math.abs(v));
  const goals = (v) => {
    const n = Math.abs(v);
    return Number.isInteger(n) && n % 10 === 1 && n % 100 !== 11 ? "ГОЛ" : "ГОЛА";
  };
  if (type === "game_total") {
    if (!Number.isFinite(line)) return null;
    const dir = side === "under" ? "МЕНЬШЕ" : "БОЛЬШЕ";
    return p ? `${p}ТОТАЛ ${dir} ${num(line)}` : `ОБЩИЙ ТОТАЛ ${dir} ${num(line)}`;
  }
  if (type === "team_total") {
    if (!Number.isFinite(line)) return null;
    return `${p}ТОТАЛ КОМАНДЫ ${side === "under" ? "МЕНЬШЕ" : "БОЛЬШЕ"} ${num(Math.abs(line))} ${goals(line)}`;
  }
  if (type === "handicap") {
    if (!Number.isFinite(line)) return null;
    return `${p}ФОРА ${signed(line)} ${goals(line)}`;
  }
  if (type === "moneyline" || typePeriod) {
    if (side === "draw") return p ? `${p}НИЧЬЯ` : "НИЧЬЯ В ОСНОВНОЕ ВРЕМЯ";
    if (p) return `${p}ПОБЕДА`;
    return period === "REG" ? "ПОБЕДА В ОСНОВНОЕ ВРЕМЯ" : "ПОБЕДА";
  }
  if (type === "next_goal_team") return "СЛЕДУЮЩИЙ ГОЛ";
  if (type === "first_goal_team") return "ПЕРВЫЙ ГОЛ В МАТЧЕ";
  if (type === "double_chance") {
    if (side === "no_draw") return `${p}БЕЗ НИЧЬЕЙ`;
    return p ? `${p}НЕ ПРОИГРАЕТ` : "НЕ ПРОИГРАЕТ В ОСНОВНОЕ ВРЕМЯ";
  }
  if (type === "both_teams_score") return side === "no" ? `${p}ОБЕ ЗАБЬЮТ — НЕТ` : `${p}ОБЕ КОМАНДЫ ЗАБЬЮТ`;
  return null;
}
