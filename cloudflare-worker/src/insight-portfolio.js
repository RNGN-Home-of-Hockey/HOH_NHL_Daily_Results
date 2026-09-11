const CONTEXT_CATEGORIES = new Set(["league_rank", "advanced_context"]);

const PRIMARY_PRIORITY = new Map([
  ["market_evaluator", 6],
  ["venue_split", 5],
  ["h2h_market", 4],
  ["h2h_split", 4],
  ["feature", 3],
  ["history", 2],
  ["matchup", 2],
  ["period", 2],
  ["league_rank", 1],
  ["advanced_context", 1],
]);

export function selectInsightPortfolio(insights, limit = 12) {
  if (!Array.isArray(insights) || !insights.length) return [];

  const live = insights
    .filter((card) => card?.timing === "live" || card?.kind === "live")
    .map(annotateLiveCard)
    .sort(comparePortfolioCards)
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
    consolidated.push(annotatePortfolioQuality(consolidateGroup(group)));
  }

  consolidated.sort(comparePortfolioCards);

  const selected = [];
  const familyCounts = new Map();
  const lineBuckets = new Set();
  let soloContextCards = 0;

  for (const card of consolidated) {
    const market = card.market || {};
    const quality = card.evidence_quality || {};

    // Context-only ranks are useful editorial evidence, but should not flood the operator queue
    // without a direct market hit-rate / split pointing the same way.
    if (quality.context_only && Number(quality.independent_support_count || 0) === 0) {
      if (Number(card.score || 0) < 88 || soloContextCards >= 2) continue;
    }

    const bucket = familyBucket(market);
    const max = familyLimit(market);
    const used = familyCounts.get(bucket) || 0;
    if (used >= max) continue;

    const lineBucket = redundantLineBucket(market);
    if (lineBucket && lineBuckets.has(lineBucket)) continue;

    selected.push(card);
    familyCounts.set(bucket, used + 1);
    if (lineBucket) lineBuckets.add(lineBucket);
    if (quality.context_only && Number(quality.independent_support_count || 0) === 0) soloContextCards += 1;
    if (selected.length >= Math.max(0, limit - live.length)) break;
  }

  return [...live, ...selected]
    .sort(comparePortfolioCards)
    .slice(0, limit);
}

export function exactMarketKey(market) {
  return [
    market?.type || "unknown",
    normalizePeriod(market),
    market?.subject || "all",
    market?.side || "none",
    normalizeLine(market?.line),
  ].join(":");
}

function consolidateGroup(group) {
  const ordered = [...group].sort(comparePrimaryCandidates);
  const primary = structuredCloneSafe(ordered[0]);
  const support = [];
  const primaryCategory = cardCategory(primary);
  const categories = new Set([primaryCategory]);

  for (const candidate of ordered.slice(1).sort(compareRawCards)) {
    const category = cardCategory(candidate);
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
    if (support.length >= 4) break;
  }

  primary.evidence = {
    ...(primary.evidence || {}),
    supporting_signals: support,
    independent_support_count: support.length,
    portfolio_policy: "one_card_per_exact_market_with_independent_support",
  };

  if (support.length) {
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

function annotatePortfolioQuality(card) {
  const copy = structuredCloneSafe(card);
  const category = cardCategory(copy);
  const supportCount = Number(copy?.evidence?.independent_support_count || 0);
  const contextOnly = CONTEXT_CATEGORIES.has(category);
  const directSignal = !contextOnly;
  const sample = primarySampleSize(copy);
  const sourceScore = Number(copy.score || 0);
  const utilityPenalty = marketUtilityPenalty(copy.market || {});

  let tier = "C";
  if (directSignal && supportCount >= 2) {
    tier = "A";
  } else if (
    (directSignal && supportCount >= 1) ||
    (directSignal && sourceScore >= 86 && sample >= 10)
  ) {
    tier = "B";
  }

  const tierBonus = tier === "A" ? 10 : tier === "B" ? 4 : 0;
  const supportBonus = Math.min(12, supportCount * 4);
  const contextPenalty = contextOnly && supportCount === 0 ? -10 : 0;
  const directBonus = category === "market_evaluator" ? 3 : category === "venue_split" ? 2 : 0;
  const portfolioScore = sourceScore + tierBonus + supportBonus + contextPenalty + directBonus + utilityPenalty;

  copy.portfolio_score = Math.round(portfolioScore * 10) / 10;
  copy.evidence_quality = {
    tier,
    meaning: "editorial_evidence_strength_not_probability",
    primary_category: category,
    primary_role: contextOnly ? "context" : "direct",
    context_only: contextOnly,
    independent_support_count: supportCount,
    primary_sample_size: sample,
    market_utility_penalty: utilityPenalty,
  };
  return copy;
}

function annotateLiveCard(card) {
  const copy = structuredCloneSafe(card);
  copy.portfolio_score = Number(copy.score || 0);
  copy.evidence_quality = {
    tier: "LIVE",
    meaning: "live_signal_priority_not_probability",
    primary_category: cardCategory(copy),
    primary_role: "live",
    context_only: false,
    independent_support_count: Number(copy?.evidence?.independent_support_count || 0),
    primary_sample_size: primarySampleSize(copy),
    market_utility_penalty: 0,
  };
  return copy;
}

function marketUtilityPenalty(market) {
  const type = market?.type || "unknown";
  const side = market?.side || "none";
  const line = Number(market?.line);
  if (!Number.isFinite(line)) return 0;

  // Broad "safe" demo lines are less interesting editorially. This is a presentation
  // penalty only; it is not a probability adjustment and does not change the statistic.
  if (type === "game_total") {
    if (side === "over" && line <= 4.5) return -5;
    if (side === "under" && line >= 7.5) return -5;
  }
  if (type === "team_total") {
    if (side === "over" && line <= 1.5) return -5;
    if (side === "under" && line >= 4.5) return -5;
  }
  if (type === "handicap" && line >= 2.5) return -6;
  return 0;
}

function comparePrimaryCandidates(a, b) {
  const priorityDiff = primaryPriority(b) - primaryPriority(a);
  if (priorityDiff) return priorityDiff;
  return compareRawCards(a, b);
}

function primaryPriority(card) {
  return PRIMARY_PRIORITY.get(cardCategory(card)) || 0;
}

function cardCategory(card) {
  return card?.category || card?.insight_type || "unknown";
}

function primarySampleSize(card) {
  const e = card?.evidence || {};
  const candidates = [
    e.window,
    e.sample_size,
    e.sample,
    e.attack?.sample,
    e.cover?.sample,
    e.away?.sample,
    e.home?.sample,
  ].map(Number).filter(Number.isFinite);
  return candidates.length ? Math.max(...candidates) : 0;
}

function familyBucket(market) {
  const type = market?.type || "unknown";
  const subject = market?.subject || "all";
  const period = normalizePeriod(market);
  if (type === "game_total") return `game_total:${period}`;
  if (type === "team_total") return `team_total:${period}:${subject}`;
  if (type === "handicap") return `handicap:${period}:${subject}`;
  if (/^period_\d+_result$/.test(type) || type === "period_2_result") return `${type}:${subject}`;
  if (type === "moneyline") return `moneyline:${period}`;
  return `${type}:${period}:${subject}`;
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
  const period = normalizePeriod(market);
  if (type === "game_total") return `game_total:${period}:${side}`;
  if (type === "team_total") return `team_total:${period}:${subject}:${side}`;
  if (type === "handicap") return `handicap:${period}:${subject}:${side}`;
  return null;
}

function comparePortfolioCards(a, b) {
  const tierDiff = tierRank(b?.evidence_quality?.tier) - tierRank(a?.evidence_quality?.tier);
  if (tierDiff) return tierDiff;
  const portfolioDiff = Number(b?.portfolio_score || b?.score || 0) - Number(a?.portfolio_score || a?.score || 0);
  if (portfolioDiff) return portfolioDiff;
  return compareRawCards(a, b);
}

function compareRawCards(a, b) {
  const scoreDiff = Number(b?.score || 0) - Number(a?.score || 0);
  if (scoreDiff) return scoreDiff;
  const aWindow = primarySampleSize(a);
  const bWindow = primarySampleSize(b);
  if (bWindow !== aWindow) return bWindow - aWindow;
  return String(a?.id || "").localeCompare(String(b?.id || ""));
}

function tierRank(tier) {
  if (tier === "LIVE") return 4;
  if (tier === "A") return 3;
  if (tier === "B") return 2;
  return 1;
}

function normalizePeriod(market) {
  const raw = String(market?.period || "").trim().toUpperCase();
  if (raw) return raw;
  return "GAME";
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
