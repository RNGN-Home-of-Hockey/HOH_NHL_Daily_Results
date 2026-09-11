export function selectInsightPortfolio(insights, limit = 12) {
  if (!Array.isArray(insights) || !insights.length) return [];

  const live = insights
    .filter((card) => card?.timing === "live" || card?.kind === "live")
    .sort(compareCards)
    .slice(0, 4);

  const history = insights.filter((card) => !(card?.timing === "live" || card?.kind === "live"));
  const grouped = new Map();

  for (const card of history) {
    if (!card?.market) continue;
    const key = exactMarketKey(card.market);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(card);
  }

  const consolidated = [];
  for (const group of grouped.values()) {
    group.sort(compareCards);
    consolidated.push(consolidateGroup(group));
  }

  consolidated.sort(compareCards);

  const selected = [];
  const familyCounts = new Map();
  const lineBuckets = new Set();

  for (const card of consolidated) {
    const market = card.market || {};
    const bucket = familyBucket(market);
    const max = familyLimit(market);
    const used = familyCounts.get(bucket) || 0;
    if (used >= max) continue;

    const lineBucket = redundantLineBucket(market);
    if (lineBucket && lineBuckets.has(lineBucket)) continue;

    selected.push(card);
    familyCounts.set(bucket, used + 1);
    if (lineBucket) lineBuckets.add(lineBucket);
    if (selected.length >= Math.max(0, limit - live.length)) break;
  }

  return [...live, ...selected]
    .sort(compareCards)
    .slice(0, limit);
}

export function exactMarketKey(market) {
  return [
    market?.type || "unknown",
    market?.subject || "all",
    market?.side || "none",
    normalizeLine(market?.line),
  ].join(":");
}

function consolidateGroup(group) {
  const primary = structuredCloneSafe(group[0]);
  const support = [];
  const categories = new Set([primary.category || primary.insight_type || "primary"]);

  for (const candidate of group.slice(1)) {
    const category = candidate.category || candidate.insight_type || "other";
    if (categories.has(category)) continue;
    categories.add(category);
    support.push({
      category,
      insight_type: candidate.insight_type || null,
      score: Number(candidate.score || 0),
      title: candidate.title || null,
      eyebrow: candidate.eyebrow || null,
      value: candidate.value || null,
      evidence: candidate.evidence || null,
    });
    if (support.length >= 3) break;
  }

  if (support.length) {
    const boost = Math.min(6, support.length * 2);
    primary.score = Math.min(99, Number(primary.score || 0) + boost);
    primary.evidence = {
      ...(primary.evidence || {}),
      supporting_signals: support,
      independent_support_count: support.length,
      portfolio_policy: "one_card_per_exact_market_with_support",
    };
    const supportText = support
      .map((item) => item.eyebrow || item.title)
      .filter(Boolean)
      .slice(0, 2)
      .join(" · ");
    if (supportText) {
      primary.explanation = `${primary.explanation || ""}${primary.explanation ? " " : ""}Доп. подтверждение: ${supportText}.`;
    }
  }

  return primary;
}

function familyBucket(market) {
  const type = market?.type || "unknown";
  const subject = market?.subject || "all";
  if (type === "game_total") return "game_total";
  if (type === "team_total") return `team_total:${subject}`;
  if (type === "handicap") return `handicap:${subject}`;
  if (/^period_\d+_result$/.test(type) || type === "period_2_result") return `${type}:${subject}`;
  if (type === "moneyline") return "moneyline";
  return `${type}:${subject}`;
}

function familyLimit(market) {
  const type = market?.type || "unknown";
  if (type === "game_total") return 1;
  if (type === "team_total") return 1;
  if (type === "handicap") return 1;
  if (type === "moneyline") return 2;
  return 1;
}

function redundantLineBucket(market) {
  const type = market?.type || "unknown";
  const subject = market?.subject || "all";
  const side = market?.side || "none";
  if (type === "game_total") return `game_total:${side}`;
  if (type === "team_total") return `team_total:${subject}:${side}`;
  if (type === "handicap") return `handicap:${subject}:${side}`;
  return null;
}

function compareCards(a, b) {
  const scoreDiff = Number(b?.score || 0) - Number(a?.score || 0);
  if (scoreDiff) return scoreDiff;
  const aWindow = Number(a?.evidence?.window || a?.evidence?.sample_size || 0);
  const bWindow = Number(b?.evidence?.window || b?.evidence?.sample_size || 0);
  if (bWindow !== aWindow) return bWindow - aWindow;
  return String(a?.id || "").localeCompare(String(b?.id || ""));
}

function normalizeLine(line) {
  if (line === null || line === undefined || line === "") return "none";
  const value = Number(line);
  return Number.isFinite(value) ? value.toFixed(1) : String(line);
}

function structuredCloneSafe(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}
