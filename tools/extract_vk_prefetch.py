#!/usr/bin/env python3
import json,re,http.cookiejar
from pathlib import Path
from urllib.request import Request,build_opener,HTTPCookieProcessor
from urllib.error import HTTPError

UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36'
G='227682170';cj=http.cookiejar.CookieJar();op=build_opener(HTTPCookieProcessor(cj))
URLS=[
 'https://vk.com/nhl_home_of_hockey',f'https://vk.com/videos-{G}','https://vk.com/video/@nhl_home_of_hockey','https://vk.com/video/nhl_home_of_hockey',f'https://m.vk.com/videos-{G}','https://m.vk.com/video/@nhl_home_of_hockey']

def get(url):
 req=Request(url,headers={'User-Agent':UA,'Accept':'text/html,application/xhtml+xml','Accept-Language':'ru-RU,ru;q=0.9','Referer':'https://vk.com/nhl_home_of_hockey'})
 try:
  with op.open(req,timeout=30) as r:return r.status,r.geturl(),r.read(7000000).decode('utf-8','replace')
 except HTTPError as e:return e.code,url,e.read(1000000).decode('utf-8','replace')

def raw_json_after(text,key):
 p=text.find(key)
 if p<0:return None
 p=text.find(':',p+len(key))
 if p<0:return None
 s=text[p+1:].lstrip()
 try:return json.JSONDecoder().raw_decode(s)[0]
 except Exception:return None

def trim(v,depth=0):
 if depth>8:return '<depth>'
 if isinstance(v,str):return v if len(v)<3000 else v[:3000]+'…'
 if isinstance(v,list):return [trim(x,depth+1) for x in v[:300]]
 if isinstance(v,dict):return {str(k):trim(x,depth+1) for k,x in list(v.items())[:300]}
 return v

out={'group_id':int(G),'pages':[]}
for u in URLS:
 st,fin,b=get(u); cache=raw_json_after(b,'"apiPrefetchCache"') or []
 entries=[]
 for x in cache if isinstance(cache,list) else []:
  entries.append({'method':x.get('method'),'request':trim(x.get('request')),'version':x.get('version'),'error':trim(x.get('error')),'response':trim(x.get('response'))})
 out['pages'].append({'url':u,'status':st,'final_url':fin,'len':len(b),'methods':[x.get('method') for x in entries],'prefetch':entries})
 print(u,st,len(b),[x.get('method') for x in entries])
Path('state').mkdir(exist_ok=True);Path('state/vk_prefetch_probe.json').write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf-8')
