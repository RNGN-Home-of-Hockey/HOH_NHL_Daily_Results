const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;
const OPEN_STATUSES = new Set(["open", "active", "opened"]);

export function normalizeWinlineMarket(raw) {
  if (!raw || typeof raw !== "object") return null;
  const marketType = clean(raw.market_type ?? raw.type);
  const subject = nullableUpper(raw.subject);
  const side = clean(raw.side).toLowerCase();
  const period = normalizePeriod(raw.period);
  const line = normalizeLineValue(raw.line);
  const odds = Number(raw.odds);
  const status = clean(raw.status || "open").toLowerCase();
  const updatedAt = clean(raw.updated_at || raw.updatedAt);

  if (!marketType || !side || !period) return null;
  if (!isLineCompatible(marketType, line)) return null;
  if (!Number.isFinite(odds) || odds <= 1) return null;
  if (!updatedAt || !Number.isFinite(Date.parse(updatedAt))) return null;

  return {
    provider: clean(raw.provider || "winline").toLowerCase(),
    event_id: nullableString(raw.event_id ?? raw.eventId),
    market_id: nullableString(raw.market_id ?? raw.marketId),
    selection_id: nullableString(raw.selection_id ?? raw.selectionId),
    market_type: marketType,
    period,
    subject,
    side,
    line,
    odds,
    status,
    updated_at: new Date(updatedAt).toISOString(),
    deeplink: nullableString(raw.deeplink ?? raw.deep_link ?? raw.url),
  };
}

export function applyWinlineMarkets(insights, providerMarkets, options = {}) {
  if (!Array.isArray(insights)) return [];
  if (providerMarkets === undefined || providerMarkets === null) return insights;
  if (!Array.isArray(providerMarkets) || providerMarkets.length === 0) return [];

  const nowMs = resolveNow(options.now);
  const maxAgeMs = finitePositive(options.max_age_ms, DEFAULT_MAX_AGE_MS);
  const normalized = providerMarkets
    .map(normalizeWinlineMarket)
    .filter(Boolean)
    .filter((market) => isUsableMarket(market, nowMs, maxAgeMs));

  const index = buildNewestMarketIndex(normalized);
  const output = [];

  for (const card of insights) {
    if (!card?.market) continue;
    const key = insightMarketKey(card.market);
    const offered = index.get(key);
    if (!offered) continue;
    output.push(attachRealMarket(card, offered));
  }

  return output;
}

export function insightMarketKey(market) {
  return canonicalKey({
    market_type: clean(market?.type),
    period: inferInsightPeriod(market),
    subject: nullableUpper(market?.subject),
    side: clean(market?.side).toLowerCase(),
    line: normalizeLineValue(market?.line),
  });
}

export function providerMarketKey(market) {
  const normalized = market?.market_type ? market : normalizeWinlineMarket(market);
  if (!normalized) return null;
  return canonicalKey(normalized);
}

function attachRealMarket(card, offered) {
  const copy = structuredCloneSafe(card);
  copy.market = {
    ...(copy.market || {}),
    type: offered.market_type,
    period: offered.period,
    subject: offered.subject,
    side: offered.side,
    line: offered.line,
    odds: offered.odds,
    provider: offered.provider,
    odds_is_demo: false,
    odds_source: "provider_live",
    event_id: offered.event_id,
    market_id: offered.market_id,
    selection_id: offered.selection_id,
    updated_at: offered.updated_at,
    deeplink: offered.deeplink,
  };
  copy.note = `${copy.market.label || marketLabel(copy.market)} · WINLINE · ${offered.odds.toFixed(2)}${offered.updated_at ? ` · линия ${offered.updated_at}` : ""}`;
  copy.evidence = {
    ...(copy.evidence || {}),
    provider_market: {
      provider: offered.provider,
      event_id: offered.event_id,
      market_id: offered.market_id,
      selection_id: offered.selection_id,
      period: offered.period,
      odds: offered.odds,
      status: offered.status,
      updated_at: offered.updated_at,
      exact_market_match: true,
    },
  };
  return copy;
}

function buildNewestMarketIndex(markets) {
  const index = new Map();
  for (const market of markets) {
    const key = providerMarketKey(market);
    if (!key) continue;
    const current = index.get(key);
    if (!current || Date.parse(market.updated_at) > Date.parse(current.updated_at)) index.set(key, market);
  }
  return index;
}

function isUsableMarket(market, nowMs, maxAgeMs) {
  if (!OPEN_STATUSES.has(market.status)) return false;
  const updatedMs = Date.parse(market.updated_at);
  if (!Number.isFinite(updatedMs)) return false;
  const age = nowMs - updatedMs;
  if (age < -60_000) return false;
  return age <= maxAgeMs;
}

function canonicalKey(market) {
  const type = clean(market?.market_type);
  const period = normalizePeriod(market?.period);
  const subject = nullableUpper(market?.subject) || "all";
  const side = clean(market?.side).toLowerCase();
  const line = normalizeLineKey(market?.line);
  if (!type || !period || !side) return null;
  return [type, period, subject, side, line].join(":");
}

function inferInsightPeriod(market) {
  if (market?.period) return normalizePeriod(market.period);
  const type = clean(market?.type);
  const match = /^period_(\d+)_/.exec(type);
  if (match) return `P${match[1]}`;
  if (type === "period_2_result") return "P2";
  return "GAME";
}

function normalizePeriod(value) {
  const raw = clean(value || "GAME").toUpperCase();
  if (["GAME", "FULL", "ALL", "OT_SO", "INCLUDING_OT_SO"].includes(raw)) return "GAME";
  if (["REG", "REGULATION", "60M"].includes(raw)) return "REG";
  if (["P1", "1", "PERIOD1", "PERIOD_1"].includes(raw)) return "P1";
  if (["P2", "2", "PERIOD2", "PERIOD_2"].includes(raw)) return "P2";
  if (["P3", "3", "PERIOD3", "PERIOD_3"].includes(raw)) return "P3";
  return raw || null;
}

function normalizeLineValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeLineKey(value) {
  const line = normalizeLineValue(value);
  return line === null ? "none" : line.toFixed(2);
}

function isLineCompatible(type, line) {
  if (["moneyline", "period_1_result", "period_2_result", "period_3_result", "next_goal_team"].includes(type)) return line === null;
  return line !== null;
}

function marketLabel(market) {
  const subject = market.subject ? `${market.subject} ` : "";
  const line = market.line === null || market.line === undefined ? "" : ` ${market.line}`;
  return `${subject}${market.type} ${market.side}${line}`.trim();
}

function resolveNow(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return Date.parse(value);
  return Date.now();
}

function finitePositive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function clean(value) { return String(value ?? "").trim(); }
function nullableString(value) { const v = clean(value); return v || null; }
function nullableUpper(value) { const v = clean(value).toUpperCase(); return v || null; }

function structuredCloneSafe(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}
