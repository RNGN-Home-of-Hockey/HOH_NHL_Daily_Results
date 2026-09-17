#!/usr/bin/env python3
import json,re,http.cookiejar
from pathlib import Path
from urllib.request import Request,build_opener,HTTPCookieProcessor
from urllib.error import HTTPError

UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36'
cj=http.cookiejar.CookieJar();op=build_opener(HTTPCookieProcessor(cj))

def get(url):
 req=Request(url,headers={'User-Agent':UA,'Accept':'text/html,application/json;q=0.9,*/*;q=0.8','Accept-Language':'ru-RU,ru;q=0.9,en;q=0.8'})
 try:
  with op.open(req,timeout=30) as r:return {'ok':True,'status':r.status,'final_url':r.geturl(),'body':r.read(3000000).decode('utf-8','replace')}
 except HTTPError as e:return {'ok':False,'status':e.code,'final_url':url,'error':str(e),'body':e.read(500000).decode('utf-8','replace')}
 except Exception as e:return {'ok':False,'status':None,'final_url':url,'error':repr(e),'body':''}

def signals(body):
 pats=[r'(?i)(?:owner_id|ownerId|group_id|groupId|club_id|clubId)["\' :=]{1,12}-?\d+',r'(?i)(?:club|public|event)\d{4,}',r'(?i)video-?\d+_\d+',r'(?i)videos-?\d+',r'(?i)oid["\' :=]{1,12}-?\d+',r'(?i)"id"\s*:\s*-?\d+']
 out=[]
 for p in pats:
  for m in re.finditer(p,body):
   x=m.group(0)
   if x not in out:out.append(x)
   if len(out)>=300:return out
 return out

urls=[
 'https://vk.com/nhl_home_of_hockey',
 'https://m.vk.com/nhl_home_of_hockey',
 'https://vk.com/video/@nhl_home_of_hockey',
 'https://vk.com/video/nhl_home_of_hockey',
 'https://api.vk.com/method/groups.getById?group_ids=nhl_home_of_hockey&v=5.199',
]
out={'pages':[]}
for u in urls:
 r=get(u);b=r.pop('body','');r['body_len']=len(b);r['title']=(re.search(r'<title[^>]*>(.*?)</title>',b,re.S|re.I).group(1)[:300] if re.search(r'<title[^>]*>(.*?)</title>',b,re.S|re.I) else None);r['signals']=signals(b);r['body_preview']=b[:20000];out['pages'].append({'url':u,**r})
Path('state').mkdir(exist_ok=True);Path('state/vk_community_probe.json').write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps([{'url':x['url'],'status':x['status'],'final':x['final_url'],'len':x['body_len'],'title':x['title'],'signals':x['signals'][:20]} for x in out['pages']],ensure_ascii=False,indent=2))
