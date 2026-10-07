from pathlib import Path

path = Path("tests/validate_live_market_enrichment.mjs")
text = path.read_text(encoding="utf-8")
old = '''  p2_goals_for:strong?(i<7?2:0):(i<4?2:0),p2_goals_against:strong?(i<7?0:1):(i<4?0:1),'''
new = '''  p2_goals_for:strong?(i<7?2:0):(i<6?0:1),p2_goals_against:strong?(i<7?0:1):(i<6?2:0),'''
if old not in text:
    raise SystemExit("LIVE_DIVERSITY_FIXTURE_MARKER_MISSING")
path.write_text(text.replace(old, new, 1), encoding="utf-8")
print("LIVE_DIVERSITY_V3_FIXTURE_FIXED")
