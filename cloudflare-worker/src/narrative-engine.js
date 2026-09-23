// Narrative Engine
// Converts analytical signals into two layers:
// 1) TV copy: short, understandable, with important numbers preserved.
// 2) Operator copy: full analytical context.

export function buildNarrative(card = {}) {
  const evidence = card.evidence || {};
  const metric = card.metric || card.analytics || {};
  const team = String(card.market?.subject || evidence.team || card.team || "КОМАНДА").toUpperCase();

  const rank = Number(metric.rank || evidence.rank);
  const metricName = normalizeMetric(metric.name || evidence.metric_name);
  const value = metric.value ?? evidence.value;

  const tv = buildTvLine({ team, rank, metricName, value, card });
  const operator = buildOperatorLine({ team, rank, metricName, value, evidence, metric, card });

  return {
    tv: {
      title: tv.title,
      subtitle: tv.subtitle || null,
    },
    operator: {
      headline: operator.headline,
      details: operator.details,
      raw: {
        metric,
        evidence,
      },
    },
  };
}

function buildTvLine({ team, rank, metricName, value, card }) {
  if (rank && metricName) {
    return {
      title: `${team} — ТОП-${rank} НХЛ ПО ${metricName}`,
      subtitle: value ? String(value) : null,
    };
  }

  if (card.market?.type === "moneyline") {
    return { title: `${team} — ФАКТОР ПРЕИМУЩЕСТВА ПЕРЕД МАТЧЕМ` };
  }

  return { title: String(card.title || "АНАЛИТИЧЕСКИЙ ФАКТ") };
}

function buildOperatorLine({ team, rank, metricName, value, evidence, metric }) {
  const details = [];

  if (rank && metricName) {
    details.push(`${team} занимает ${rank}-е место в НХЛ по показателю «${metricName}».`);
  }
  if (value !== undefined && value !== null) {
    details.push(`Текущее значение показателя: ${value}.`);
  }
  if (evidence.sample_size) {
    details.push(`Выборка: ${evidence.sample_size} матчей.`);
  }
  if (evidence.opponent_rank) {
    details.push(`Соперник: ${evidence.opponent_rank}-е место по этому показателю.`);
  }

  return {
    headline: `${team}: расширенная аналитика`,
    details,
  };
}

function normalizeMetric(value) {
  const text = String(value || "").toLowerCase();
  const map = {
    "xg-differential": "РАЗНИЦЕ ОПАСНЫХ МОМЕНТОВ",
    "xg": "СОЗДАНИЮ ОПАСНЫХ МОМЕНТОВ",
    "high-danger": "ОПАСНЫМ МОМЕНТАМ",
    "shot-share": "КОНТРОЛЮ БРОСКОВ",
  };

  return map[text] || String(value || "АНАЛИТИКЕ").toUpperCase();
}
