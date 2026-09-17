#!/usr/bin/env python3
import json,re,http.cookiejar
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request,build_opener,HTTPCookieProcessor
from urllib.error import HTTPError

UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36'
OID='-227682170';cj=http.cookiejar.CookieJar();op=build_opener(HTTPCookieProcessor(cj))

def req(url,data=None):
 h={'User-Agent':UA,'Accept':'*/*','Accept-Language':'ru-RU,ru;q=0.9','Referer':'https://vk.com/nhl_home_of_hockey','X-Requested-With':'XMLHttpRequest'}
 if data is not None:data=urlencode(data).encode();h['Content-Type']='application/x-www-form-urlencoded'
 r=Request(url,data=data,headers=h)
 try:
  with op.open(r,timeout=30) as x:return {'status':x.status,'final':x.geturl(),'body':x.read(3000000).decode('utf-8','replace')}
 except HTTPError as e:return {'status':e.code,'final':url,'error':str(e),'body':e.read(500000).decode('utf-8','replace')}
 except Exception as e:return {'status':None,'final':url,'error':repr(e),'body':''}

def summarize(label,r):
 b=r.pop('body',''); vids=list(dict.fromkeys(re.findall(r'video-?\d+_\d+',b,re.I))); ids=list(dict.fromkeys(re.findall(r'(?i)["\'](?:id|video_id)["\']\s*[:=]\s*["\']?(\d{3,})',b))); titles=[]
 for m in re.finditer(r'(?i)(?:title|name)["\']?\s*[:=]\s*["\']([^"\']{3,180})',b):
  if len(titles)<100:titles.append(m.group(1))
 return {'label':label,**r,'len':len(b),'video_tokens':vids[:300],'ids':ids[:300],'titles':titles[:100],'preview':b[:50000]}

# Establish anonymous cookies/session first.
req('https://vk.com/nhl_home_of_hockey')
tests=[]
for offset in (0,40,100):
 tests.append((f'legacy_get_{offset}',req(f'https://vk.com/al_video.php?act=load_videos_silent&al=1&offset={offset}&oid={OID}')))
 tests.append((f'legacy_post_{offset}',req('https://vk.com/al_video.php',{'act':'load_videos_silent','al':'1','offset':str(offset),'oid':OID})))
 tests.append((f'mobile_{offset}',req(f'https://m.vk.com/videos{OID}?offset={offset}')))
out={'oid':OID,'cookies':[{'name':c.name,'domain':c.domain} for c in cj], 'tests':[summarize(k,v) for k,v in tests]}
Path('state').mkdir(exist_ok=True);Path('state/vk_legacy_video_probe.json').write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps([{'label':x['label'],'status':x['status'],'len':x['len'],'videos':len(x['video_tokens']),'ids':len(x['ids']),'final':x['final']} for x in out['tests']],ensure_ascii=False,indent=2))
