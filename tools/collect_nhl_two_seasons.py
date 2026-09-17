#!/usr/bin/env python3
import json,time
from pathlib import Path
from urllib.request import Request,urlopen

API='https://api-web.nhle.com/v1'
TEAMS=['ANA','BOS','BUF','CGY','CAR','CHI','COL','CBJ','DAL','DET','EDM','FLA','LAK','MIN','MTL','NSH','NJD','NYI','NYR','OTT','PHI','PIT','SJS','SEA','STL','TBL','TOR','UTA','VAN','VGK','WSH','WPG']
SEASONS=['20242025','20252026']
UA='HOH-NHL-Center/18 historical VK matcher'

def getj(url):
    req=Request(url,headers={'User-Agent':UA,'Accept':'application/json'})
    with urlopen(req,timeout=30) as r:return json.load(r)

def tri(v):
    if isinstance(v,str):return v
    if isinstance(v,dict):return v.get('abbrev') or v.get('triCode') or v.get('default') or ''
    return ''

games={}
errors=[]
for season in SEASONS:
    for team in TEAMS:
        url=f'{API}/club-schedule-season/{team}/{season}'
        try:d=getj(url)
        except Exception as e:
            errors.append({'season':season,'team':team,'error':repr(e)});continue
        for g in d.get('games',[]):
            gid=int(g.get('id') or 0)
            if not gid:continue
            home=tri(g.get('homeTeam'));away=tri(g.get('awayTeam'))
            if not home or not away:continue
            games[gid]={
                'game_pk':gid,'season_id':str(g.get('season') or season),'game_type':g.get('gameType'),
                'game_date':g.get('gameDate'),'start_time_utc':g.get('startTimeUTC'),
                'game_state':g.get('gameState'),'home_tri':home,'away_tri':away,
                'home_score':(g.get('homeTeam') or {}).get('score'),'away_score':(g.get('awayTeam') or {}).get('score'),
            }
        time.sleep(.04)
rows=sorted(games.values(),key=lambda x:(x.get('start_time_utc') or x.get('game_date') or '',x['game_pk']))
by_season={s:sum(1 for x in rows if x['season_id']==s) for s in SEASONS}
by_type={}
for x in rows:by_type[str(x.get('game_type'))]=by_type.get(str(x.get('game_type')),0)+1
summary={'seasons':SEASONS,'games':len(rows),'by_season':by_season,'by_game_type':by_type,'errors':errors}
Path('state').mkdir(exist_ok=True)
Path('state/nhl_games_2024_2026.json').write_text(json.dumps({'summary':summary,'games':rows},ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(summary,ensure_ascii=False,indent=2))
if errors:raise SystemExit(2)
