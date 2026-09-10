export function withDemoOdds(market, seed) {
  const safeMarket = market || {};
  const odds = demoOdds(`${seed || "market"}:${safeMarket.type || "unknown"}:${safeMarket.subject || "all"}:${safeMarket.side || ""}`);
  return {
    ...safeMarket,
    odds,
    odds_is_demo: true,
    odds_source: "synthetic_demo",
    promo_code: "HOH",
    provider: "winline_demo",
  };
}

export function demoOdds(seed) {
  const bucket = unit(`${seed}:bucket`);
  const center = (unit(`${seed}:a`) + unit(`${seed}:b`) + unit(`${seed}:c`)) / 3;

  let value;
  if (bucket < 0.84) {
    // Most prices live near 1.85: 1.30–2.35, triangular-ish around the middle.
    value = 1.3 + center * 1.05;
  } else if (bucket < 0.96) {
    // Less common plus-money / underdog-like demo prices.
    value = 2.35 + center * 2.15;
  } else {
    // Rare long prices for exotic/high-variance markets.
    value = 4.5 + center * 4.5;
  }

  return Math.max(1.3, Math.min(9, Math.round(value * 100) / 100));
}

function unit(input) {
  let hash = 2166136261;
  const text = String(input || "");
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967296;
}
