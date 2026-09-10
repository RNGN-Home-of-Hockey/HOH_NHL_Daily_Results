from pathlib import Path

# 1) Backfill: materialize features immediately after every imported historical game.
p = Path('cloudflare-worker/src/data-core-backfill.js')
s = p.read_text()
imp = 'import { refreshTeamGameFeatures } from "./team-game-features.js";\n'
if imp not in s:
    s = s.replace('import { fetchNhlJson, importGame } from "./data-core-importer.js";\n', 'import { fetchNhlJson, importGame } from "./data-core-importer.js";\n' + imp, 1)
old = '      const importResult = await importGame(db, gamePk, fetchImpl);\n      return {\n'
new = '      const importResult = await importGame(db, gamePk, fetchImpl);\n      const featureResult = await refreshTeamGameFeatures(db, gamePk);\n      return {\n'
if old not in s and 'const featureResult = await refreshTeamGameFeatures' not in s:
    raise SystemExit('backfill import anchor missing')
if old in s:
    s = s.replace(old, new, 1)
old2 = '        import_result: importResult,\n'
new2 = '        import_result: importResult,\n        feature_result: featureResult,\n'
if old2 in s and 'feature_result: featureResult' not in s:
    s = s.replace(old2, new2, 1)
p.write_text(s)

# 2) Historical insight engine: merge feature-layer market insights.
p = Path('cloudflare-worker/src/betting-insight-engine.js')
s = p.read_text()
imp = 'import { buildFeatureMarketInsights } from "./feature-market-insights.js";\n'
if imp not in s:
    s = s.replace('import { withDemoOdds } from "./demo-winline-odds.js";\n', 'import { withDemoOdds } from "./demo-winline-odds.js";\n' + imp, 1)
anchor = '  const insights = [];\n'
if 'const featureInsights = await buildFeatureMarketInsights' not in s:
    if anchor not in s:
        raise SystemExit('insight array anchor missing')
    s = s.replace(anchor, '  const featureInsights = await buildFeatureMarketInsights(db, game);\n\n' + anchor, 1)
anchor2 = '  insights.push(...conferenceInsights(conferenceR.results?.[0] || null, game));\n'
if 'insights.push(...featureInsights);' not in s:
    if anchor2 not in s:
        raise SystemExit('conference insight anchor missing')
    s = s.replace(anchor2, anchor2 + '  insights.push(...featureInsights);\n', 1)
p.write_text(s)

# 3) Health schema expectation.
p = Path('cloudflare-worker/src/index.js')
s = p.read_text()
if '  "team_game_features",\n' not in s:
    anchor = '  "team_game_stats",\n'
    if anchor not in s:
        raise SystemExit('DATA_CORE_TABLES anchor missing')
    s = s.replace(anchor, '  "team_game_features",\n' + anchor, 1)
p.write_text(s)
