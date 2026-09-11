from pathlib import Path

p = Path('cloudflare-worker/src/betting-insight-engine.js')
s = p.read_text(encoding='utf-8')
start = s.index('export async function buildBettingInsights')
end = s.index('\nasync function safeInsightBuild', start)
new = '''export async function buildBettingInsights(db, game, options = {}) {
  if (!db || !game?.game_pk) return [];

  // Production defaults to a low-read profile suitable for D1 Free.
  // Heavy league-wide context stays opt-in until it is served from
  // precomputed snapshot tables rather than full historical scans.
  const heavyContext = options.enable_heavy_context === true;

  const universalMarketInsights = await safeInsightBuild("universal_market", () => buildUniversalMarketInsights(db, game));
  const regulationMarketInsights = await safeInsightBuild("regulation_market", () => buildRegulationMarketInsights(db, game));
  const marketSplitInsights = await safeInsightBuild("market_splits", () => buildMarketSplitInsights(db, game));

  let featureInsights = [];
  let rollingRankInsights = [];
  let advancedContextInsights = [];
  if (heavyContext) {
    featureInsights = await safeInsightBuild("feature_market", () => buildFeatureMarketInsights(db, game));
    rollingRankInsights = await safeInsightBuild("rolling_rank", () => buildRollingLeagueRankInsights(db, game));
    advancedContextInsights = await safeInsightBuild("advanced_context", () => buildAdvancedMarketContextInsights(db, game));
  }

  const rawPortfolio = dedupe([
    ...universalMarketInsights,
    ...regulationMarketInsights,
    ...marketSplitInsights,
    ...featureInsights,
    ...rollingRankInsights,
    ...advancedContextInsights,
  ]);

  let portfolio;
  try {
    portfolio = selectInsightPortfolio(rawPortfolio, 12);
  } catch (error) {
    console.error("betting insight portfolio failed", error);
    portfolio = [...rawPortfolio]
      .sort((a, b) => Number(b?.score || 0) - Number(a?.score || 0))
      .slice(0, 12);
  }

  try {
    return applyWinlineMarkets(portfolio, options.provider_markets, {
      now: options.now,
      max_age_ms: options.market_max_age_ms,
    });
  } catch (error) {
    console.error("winline market adapter failed", error);
    return portfolio;
  }
}
'''
p.write_text(s[:start] + new + s[end:], encoding='utf-8')

p = Path('cloudflare-worker/src/broadcast-dashboard-v2.js')
s = p.read_text(encoding='utf-8')
old = '''  } catch (error) {\n    console.error(`broadcast game failed at ${routeStage}`, error);\n    const detail=String(error?.message||error||"unknown").slice(0,300);\n    return jsonResponse({ ok:false,error:"broadcast_game_failed",stage:routeStage,detail },500);\n  }'''
new = '''  } catch (error) {\n    console.error(`broadcast game failed at ${routeStage}`, error);\n    return jsonResponse({ ok:false,error:"broadcast_game_failed" },500);\n  }'''
if old not in s:
    raise SystemExit('diagnostic catch anchor missing')
p.write_text(s.replace(old, new, 1), encoding='utf-8')
