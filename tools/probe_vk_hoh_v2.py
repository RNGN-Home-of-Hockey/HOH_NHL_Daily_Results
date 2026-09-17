#!/usr/bin/env python3
import json,re
from pathlib import Path
from urllib.request import Request,urlopen
from urllib.error import HTTPError

URL='https://live.vkvideo.ru/nhl_home_of_hockey/records'
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36'

def get(url):
    req=Request(url,headers={'User-Agent':UA,'Accept':'text/html,application/json;q=0.9,*/*;q=0.8','Referer':URL})
    try:
        with urlopen(req,timeout=30) as r:return r.status,r.geturl(),r.read(4_000_000).decode('utf-8','replace')
    except HTTPError as e:return e.code,url,e.read(300000).decode('utf-8','replace')

def snippets(text,needle,limit=30,radius=260):
    out=[];p=0;low=text.lower();nd=needle.lower()
    while len(out)<limit:
        i=low.find(nd,p)
        if i<0:break
        out.append(text[max(0,i-radius):min(len(text),i+len(needle)+radius)])
        p=i+len(needle)
    return out

status,final,html=get(URL)
ids=list(dict.fromkeys(re.findall(r'/record/([0-9a-fA-F-]{36})',html)))
api=list(dict.fromkeys(re.findall(r'https?://api\.live\.vkvideo\.ru[^"\'<> ]+|/v1/[A-Za-z0-9_?=&%./:{}\-]+',html)))
# Also collect UUIDs near obvious record objects even if href is escaped.
uuids=list(dict.fromkeys(re.findall(r'(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',html)))
out={
 'url':URL,'status':status,'final_url':final,'html_len':len(html),
 'record_ids':ids,'record_count':len(ids),'uuid_count':len(uuids),'uuids':uuids[:500],
 'api_paths':api[:500],
 'record_snippets':snippets(html,'/record/',60),
 'public_video_record_snippets':snippets(html,'public_video_record',40),
 'records_snippets':snippets(html,'records',40),
 'pagination_snippets':snippets(html,'pagination',30),
 'cursor_snippets':snippets(html,'cursor',30),
 'offset_snippets':snippets(html,'offset',30),
 'limit_snippets':snippets(html,'limit',30),
}
Path('state').mkdir(exist_ok=True)
Path('state/vk_hoh_probe_v2.json').write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'status':status,'html_len':len(html),'record_count':len(ids),'uuid_count':len(uuids),'api_paths':api[:30]},ensure_ascii=False,indent=2))
