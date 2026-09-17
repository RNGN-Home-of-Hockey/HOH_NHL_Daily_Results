#!/usr/bin/env python3
import json
from pathlib import Path

SRC=Path('state/nhl_games_2024_2026.json')
OUT=Path('migrations/0017_nhl_two_season_games.sql')

TEAM_NAMES={
    'ANA':'Anaheim Ducks','BOS':'Boston Bruins','BUF':'Buffalo Sabres','CAR':'Carolina Hurricanes',
    'CBJ':'Columbus Blue Jackets','CGY':'Calgary Flames','CHI':'Chicago Blackhawks','COL':'Colorado Avalanche',
    'DAL':'Dallas Stars','DET':'Detroit Red Wings','EDM':'Edmonton Oilers','FLA':'Florida Panthers',
    'LAK':'Los Angeles Kings','MIN':'Minnesota Wild','MTL':'Montreal Canadiens','NJD':'New Jersey Devils',
    'NSH':'Nashville Predators','NYI':'New York Islanders','NYR':'New York Rangers','OTT':'Ottawa Senators',
    'PHI':'Philadelphia Flyers','PIT':'Pittsburgh Penguins','SEA':'Seattle Kraken','SJS':'San Jose Sharks',
    'STL':'St. Louis Blues','TBL':'Tampa Bay Lightning','TOR':'Toronto Maple Leafs','UTA':'Utah Hockey Club',
    'VAN':'Vancouver Canucks','VGK':'Vegas Golden Knights','WPG':'Winnipeg Jets','WSH':'Washington Capitals',
}

def q(v):
    if v is None:return 'NULL'
    if isinstance(v,(int,float)):return str(v)
    return "'"+str(v).replace("'","''")+"'"

d=json.loads(SRC.read_text(encoding='utf-8'))
rows=[x for x in d.get('games',[]) if int(x.get('game_type') or 0) in (2,3)]
lines=['PRAGMA foreign_keys = ON;','', '-- Canonical NHL regular-season + playoff games for 2024/25 and 2025/26.', '-- Generated from api-web.nhle.com club season schedules; safe to reapply through ON CONFLICT.','', '-- Seed the 32 team keys so this migration also succeeds on a fresh validation database.', 'INSERT INTO teams (tri_code,name_en) VALUES']
team_values=[f"  ({q(tri)},{q(name)})" for tri,name in sorted(TEAM_NAMES.items())]
lines += [',\n'.join(team_values), 'ON CONFLICT(tri_code) DO NOTHING;', '']
for i in range(0,len(rows),150):
    chunk=rows[i:i+150]
    values=[]
    for g in chunk:
        values.append('('+','.join([
            q(int(g['game_pk'])),q(str(g['season_id'])),q(int(g.get('game_type') or 0)),q(g.get('start_time_utc') or (str(g.get('game_date'))+'T00:00:00Z')),
            q(g.get('game_state') or 'OFF'),q(g['home_tri']),q(g['away_tri']),q(int(g.get('home_score') or 0)),q(int(g.get('away_score') or 0))
        ])+')')
    lines += [
      'INSERT INTO games (game_pk,season_id,game_type,scheduled_start_utc,game_state,home_tri,away_tri,home_score,away_score)',
      'VALUES\n  '+',\n  '.join(values),
      'ON CONFLICT(game_pk) DO UPDATE SET',
      '  season_id=excluded.season_id, game_type=excluded.game_type, scheduled_start_utc=excluded.scheduled_start_utc,',
      '  game_state=excluded.game_state, home_tri=excluded.home_tri, away_tri=excluded.away_tri,',
      '  home_score=excluded.home_score, away_score=excluded.away_score, last_synced_at=CURRENT_TIMESTAMP;',
      ''
    ]
lines.append("INSERT INTO data_core_meta(meta_key,meta_value,updated_at) VALUES ('nhl_two_season_catalog','%d',CURRENT_TIMESTAMP) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP;"%len(rows))
OUT.write_text('\n'.join(lines)+'\n',encoding='utf-8')
print(json.dumps({'rows':len(rows),'regular':sum(1 for x in rows if x['game_type']==2),'playoffs':sum(1 for x in rows if x['game_type']==3),'output':str(OUT)},ensure_ascii=False))