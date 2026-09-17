#!/usr/bin/env python3
"""Match HOH VK broadcast records to the canonical NHL game catalog.

Input record format is intentionally loose: every item may contain title, url/web_url,
thumbnail/thumbnail_url, published_at/created_at/date, owner_id and video_id.
The matcher uses the two teams plus the date (Moscow titles can be one calendar day
ahead of NHL UTC gameDate). Ambiguous rows are never silently attached.
"""
import argparse,json,re,unicodedata
from datetime import datetime,timedelta,timezone
from pathlib import Path

ALIASES={
'ANA':['anaheim','ducks','анахайм','дакc','дакс'],'BOS':['boston','bruins','бостон','брюинз'],'BUF':['buffalo','sabres','баффало','сейбрз'],
'CGY':['calgary','flames','калгари','флэймз','флеймз'],'CAR':['carolina','hurricanes','каролина','харрикейнз'],'CHI':['chicago','blackhawks','чикаго','блэкхокс'],
'COL':['colorado','avalanche','колорадо','эвеланш','аваланш'],'CBJ':['columbus','blue jackets','коламбус','блю джекетс'],'DAL':['dallas','stars','даллас','старз'],
'DET':['detroit','red wings','детройт','ред уингз'],'EDM':['edmonton','oilers','эдмонтон','ойлерз'],'FLA':['florida','panthers','флорида','пантерз'],
'LAK':['los angeles','kings','la kings','лос анджелес','кингз'],'MIN':['minnesota','wild','миннесота','уайлд'],'MTL':['montreal','canadiens','монреаль','канадиенс'],
'NSH':['nashville','predators','нэшвилл','предаторз'],'NJD':['new jersey','devils','нью джерси','дэвилз'],'NYI':['new york islanders','islanders','айлендерс','нью йорк айлендерс'],
'NYR':['new york rangers','rangers','рейнджерс','нью йорк рейнджерс'],'OTT':['ottawa','senators','оттава','сенаторз'],'PHI':['philadelphia','flyers','филадельфия','флайерз'],
'PIT':['pittsburgh','penguins','питтсбург','пингвинз'],'SJS':['san jose','sharks','сан хосе','шаркс'],'SEA':['seattle','kraken','сиэтл','кракен'],
'STL':['st louis','blues','сент луис','блюз'],'TBL':['tampa bay','lightning','тампа','лайтнинг'],'TOR':['toronto','maple leafs','торонто','мэйпл лифс','мейпл лифс'],
'UTA':['utah','mammoth','hockey club','юта','маммот'],'VAN':['vancouver','canucks','ванкувер','кэнакс','канакс'],'VGK':['vegas','golden knights','вегас','голден найтс'],
'WSH':['washington','capitals','вашингтон','кэпиталс'],'WPG':['winnipeg','jets','виннипег','джетс']}

DATE_RE=[re.compile(r'(?<!\d)([0-3]?\d)[.\-/]([01]?\d)[.\-/](20\d{2})(?!\d)'),re.compile(r'(?<!\d)(20\d{2})[.\-/]([01]?\d)[.\-/]([0-3]?\d)(?!\d)')]

def norm(s):
 s=unicodedata.normalize('NFKD',str(s or '')).lower().replace('ё','е')
 s=re.sub(r'[^0-9a-zа-я]+',' ',s)
 return ' '.join(s.split())

def teams_in(title):
 n=' '+norm(title)+' '; hits=[]
 for tri,names in ALIASES.items():
  score=max([len(a) for a in names if (' '+norm(a)+' ') in n] or [0])
  if score:hits.append((score,tri))
 hits.sort(reverse=True)
 return [t for _,t in hits[:4]]

def title_date(title):
 s=str(title or '')
 m=DATE_RE[0].search(s)
 if m:
  try:return datetime(int(m.group(3)),int(m.group(2)),int(m.group(1))).date()
  except:pass
 m=DATE_RE[1].search(s)
 if m:
  try:return datetime(int(m.group(1)),int(m.group(2)),int(m.group(3))).date()
  except:pass
 return None

def any_date(v):
 if not v:return None
 try:return datetime.fromisoformat(str(v).replace('Z','+00:00')).date()
 except:return None

def main():
 ap=argparse.ArgumentParser();ap.add_argument('--vk',default='state/vk_hoh_broadcasts.json');ap.add_argument('--nhl',default='state/nhl_games_2024_2026.json');ap.add_argument('--out',default='state/vk_nhl_game_matches.json');a=ap.parse_args()
 vk=json.loads(Path(a.vk).read_text(encoding='utf-8')); nhl=json.loads(Path(a.nhl).read_text(encoding='utf-8'))
 records=vk.get('broadcasts') or vk.get('records') or vk.get('items') or (vk if isinstance(vk,list) else [])
 games=nhl.get('games',[])
 matches=[];unmatched=[];ambiguous=[]
 for r in records:
  title=r.get('title') or ''; ts=title_date(title) or any_date(r.get('scheduled_at') or r.get('published_at') or r.get('created_at') or r.get('date'))
  ts_teams=teams_in(title)
  if len(ts_teams)<2:
   unmatched.append({**r,'match_reason':'fewer_than_two_teams','parsed_teams':ts_teams});continue
  pair=set(ts_teams[:2]); candidates=[]
  for g in games:
   if {g['home_tri'],g['away_tri']}!=pair:continue
   gd=any_date(g.get('start_time_utc')) or any_date(g.get('game_date'))
   if ts and gd:
    delta=abs((gd-ts).days)
    if delta>1:continue
   else:delta=9
   score=1.0 if delta==0 else .94 if delta==1 else .75
   candidates.append((score,g))
  candidates.sort(key=lambda x:(-x[0],x[1]['game_pk']))
  if not candidates:
   unmatched.append({**r,'match_reason':'no_team_date_game','parsed_teams':list(pair),'parsed_date':str(ts) if ts else None});continue
  top=candidates[0][0]; tied=[g for s,g in candidates if s==top]
  if len(tied)!=1:
   ambiguous.append({**r,'match_reason':'multiple_games','candidate_game_pks':[x['game_pk'] for x in tied],'parsed_teams':list(pair),'parsed_date':str(ts) if ts else None});continue
  g=tied[0]; source=str(r.get('source_key') or r.get('id') or r.get('video_id') or r.get('url') or r.get('web_url') or '')
  matches.append({'source_key':source,'game_pk':g['game_pk'],'season_id':g['season_id'],'home_tri':g['home_tri'],'away_tri':g['away_tri'],'match_confidence':top,'match_method':'title_teams_date','title':title,'web_url':r.get('web_url') or r.get('url'),'thumbnail_url':r.get('thumbnail_url') or r.get('thumbnail'),'published_at':r.get('published_at') or r.get('created_at'),'parsed_date':str(ts) if ts else None})
 out={'summary':{'records':len(records),'matched':len(matches),'unmatched':len(unmatched),'ambiguous':len(ambiguous)},'matches':matches,'unmatched':unmatched,'ambiguous':ambiguous}
 Path(a.out).write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(out['summary'],ensure_ascii=False,indent=2))

if __name__=='__main__':main()
