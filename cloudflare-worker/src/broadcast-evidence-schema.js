// Two-layer broadcast copy contract.
// TV sees the simple explanation. Operator sees the analytical reason.

export function buildBroadcastEvidence({
  team,
  rank,
  metric,
  metricValue,
  meaning,
  extended,
} = {}) {
  return {
    tv: {
      title: buildTvTitle({ team, rank, metric, metricValue, meaning }),
      subtitle: meaning || null,
    },
    operator: {
      headline: extended || null,
      details: {
        team: team || null,
        rank: rank || null,
        metric: metric || null,
        value: metricValue ?? null,
      },
    },
  };
}

function buildTvTitle({ team, rank, metric, metricValue, meaning }) {
  const name = String(team || "Команда").toUpperCase();
  const metricName = String(metric || "показателю");

  if (rank) {
    return `${name} — ТОП-${rank} НХЛ ПО ${metricName}`;
  }

  if (metricValue !== undefined && metricValue !== null) {
    return `${name} — ${metricValue} ПОКАЗАТЕЛЬ ${metricName}`;
  }

  return meaning || name;
}
