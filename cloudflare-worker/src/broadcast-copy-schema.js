// Broadcast copy model
// Every insight should have two versions:
// 1) tv_short: understandable in 2 seconds on air
// 2) operator_detail: expanded explanation for commentator

export function buildBroadcastCopy(insight = {}) {
  const market = insight.market || {};
  const evidence = insight.evidence || {};
  const team = market.subject || evidence.team || "Команда";
  const line = market.line ?? "";
  const type = String(market.type || "").toLowerCase();

  if (type === "moneyline") {
    return {
      tv_short: `${team}: фактор победы`,
      operator_detail: `${team} имеет преимущество по выбранной модели. Учитываются форма, исторические результаты и дополнительные matchup-факторы.`
    };
  }

  if (type === "handicap") {
    return {
      tv_short: `${team}: преимущество по форе ${line}`,
      operator_detail: `${team} подходит под линию ${line} благодаря совокупности исторических результатов и текущих игровых факторов.`
    };
  }

  if (type === "game_total" || type === "team_total") {
    return {
      tv_short: `Ждём голы: линия ${line}`,
      operator_detail: `Тотал поддерживается статистикой команд: темп, результативность и последние игровые отрезки.`
    };
  }

  return {
    tv_short: "Аналитический фактор матча",
    operator_detail: String(insight.title || "")
  };
}
