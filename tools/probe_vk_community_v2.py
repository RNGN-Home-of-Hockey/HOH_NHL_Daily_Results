#!/usr/bin/env python3
import json,re,http.cookiejar,html as htmllib
from pathlib import Path
from urllib.request import Request,build_opener,HTTPCookieProcessor
from urllib.error import HTTPError

UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36'
GROUP='227682170'
cj=http.cookiejar.CookieJar();op=build_opener(HTTPCookieProcessor(cj))

def get(url):
 req=Request(url,headers={'User-Agent':UA,'Accept':'text/html,application/json;q=0.9,*/*;q=0.8','Accept-Language':'ru-RU,ru;q=0.9,en;q=0.8','Referer':'https://vk.com/nhl_home_of_hockey'})
 try:
  with op.open(req,timeout=30) as r:return {'status':r.status,'final_url':r.geturl(),'body':r.read(5000000).decode('utf-8','replace')}
 except HTTPError as e:return {'status':e.code,'final_url':url,'error':str(e),'body':e.read(1000000).decode('utf-8','replace')}
 except Exception as e:return {'status':None,'final_url':url,'error':repr(e),'body':''}

def snippets(text,needle,limit=60,radius=400):
 out=[];p=0;low=text.lower();nd=needle.lower()
 while len(out)<limit:
  i=low.find(nd,p)
  if i<0:break
  out.append(text[max(0,i-radius):min(len(text),i+len(needle)+radius)])
  p=i+len(needle)
 return out

def parse_page(url):
 r=get(url);b=r.pop('body','');
 hrefs=[]
 for x in re.findall(r'''href=["']([^"']+)["']''',b,re.I):
  y=htmllib.unescape(x)
  if re.search(r'video|live|clip|album|playlist|nhl_home',y,re.I) and y not in hrefs:hrefs.append(y)
 signals=[]
 for p in [r'video-?\d+_\d+',r'videos-?\d+',r'owner_id.{0,120}',r'oid.{0,80}',r'al_video[^"\'<> ]*',r'video\.get.{0,100}',r'web\.api\.vk\.com[^"\'<> ]*',r'execute[^"\'<> ]*']:
  for m in re.finditer(p,b,re.I):
   x=m.group(0)
   if x not in signals:signals.append(x)
   if len(signals)>500:break
 return {**r,'url':url,'body_len':len(b),'hrefs':hrefs[:1000],'signals':signals[:500],
  'group_snippets':snippets(b,GROUP,80),'video_snippets':snippets(b,'video',80),'live_snippets':snippets(b,'live',40)}

urls=[
 'https://vk.com/nhl_home_of_hockey',
 f'https://vk.com/videos-{GROUP}',
 'https://vk.com/video/@nhl_home_of_hockey',
 'https://vk.com/video/nhl_home_of_hockey',
 f'https://m.vk.com/videos-{GROUP}',
 'https://m.vk.com/video/@nhl_home_of_hockey',
 'https://m.vk.com/nhl_home_of_hockey?own=1&z=video',
]
out={'group_id':int(GROUP),'pages':[parse_page(u) for u in urls]}
Path('state').mkdir(exist_ok=True);Path('state/vk_community_probe_v2.json').write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps([{'url':x['url'],'status':x['status'],'final':x['final_url'],'len':x['body_len'],'hrefs':len(x['hrefs']),'signals':x['signals'][:10]} for x in out['pages']],ensure_ascii=False,indent=2))
