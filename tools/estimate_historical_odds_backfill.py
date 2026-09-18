#!/usr/bin/env python3
"""Estimate licensed historical NHL odds backfill calls from canonical HOH games.

No external requests. Groups games by scheduled start timestamp because one
The Odds API historical league snapshot can cover every NHL event at that
timestamp. Historical featured-market requests cost 10 credits per
region/market according to provider docs.
"""
from __future__ import annotations
import json,re
from collections import Counter,defaultdict
from pathlib import Path

SRC=Path("migrations/0017_nhl_two_season_games.sql")
PAT=re.compile(r"^\s*\((\d+),'(20\d{6})',([23]),'([^']+)','[^']+','([A-Z]+)','([A-Z]+)',",re.M)

text=SRC.read_text(encoding="utf-8")
rows=[]
for m in PAT.finditer(text):
    pk,season,gt,start,home,away=m.groups()
    rows.append(dict(game_pk=int(pk),season_id=season,game_type=int(gt),start=start,home=home,away=away))

groups=defaultdict(list)
for r in rows: groups[r["start"]].append(r)

by_season=Counter(r["season_id"] for r in rows)
by_type=Counter((r["season_id"],r["game_type"]) for r in rows)
group_sizes=Counter(len(v) for v in groups.values())
unique_starts=len(groups)
cost_one_region_one_market=unique_starts*10

summary={
  "games":len(rows),
  "unique_start_timestamps":unique_starts,
  "credits_eu_h2h_only":cost_one_region_one_market,
  "credits_eu_h2h_totals_spreads":cost_one_region_one_market*3,
  "by_season":dict(by_season),
  "by_season_game_type":{f"{k[0]}_gt{k[1]}":v for k,v in sorted(by_type.items())},
  "games_per_shared_start_histogram":dict(sorted(group_sizes.items())),
  "largest_shared_start":max(group_sizes) if group_sizes else 0,
}
print(json.dumps(summary,ensure_ascii=False,indent=2))
