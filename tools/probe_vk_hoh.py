#!/usr/bin/env python3
import json, re, subprocess, sys
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

SOURCE = "https://vkvideo.ru/@nhl_home_of_hockey/lives"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36"

def get(url):
    req=Request(url, headers={"User-Agent":UA,"Accept":"text/html,application/json;q=0.9,*/*;q=0.8"})
    try:
        with urlopen(req, timeout=30) as r:
            body=r.read(2_000_000).decode("utf-8","replace")
            return {"ok":True,"status":getattr(r,"status",200),"url":r.geturl(),"body":body}
    except HTTPError as e:
        try: body=e.read(200000).decode("utf-8","replace")
        except Exception: body=""
        return {"ok":False,"status":e.code,"url":url,"error":str(e),"body":body}
    except Exception as e:
        return {"ok":False,"status":None,"url":url,"error":repr(e),"body":""}

def main():
    out={"source":SOURCE,"http":{},"candidates":[],"ytdlp":{}}
    r=get(SOURCE)
    out["http"]={k:v for k,v in r.items() if k!="body"}
    html=r.get("body","")
    out["http"]["html_len"]=len(html)
    pats=[r'https?://api\.live\.vkvideo\.ru[^"\'<> ]+',r'live\.vkvideo\.ru/[A-Za-z0-9_\-]+',r'"(?:ownerId|owner_id|channelId|channel_id|screenName|screen_name)"\s*:\s*"?([^",}]+)',r'video-?(-?\d+)[_/](\d+)']
    hits=[]
    for p in pats:
        for m in re.finditer(p,html,re.I):
            hits.append(m.group(0)[:500])
            if len(hits)>=100: break
    out["http"]["signals"]=hits

    for u in [
        "https://live.vkvideo.ru/nhl_home_of_hockey/records",
        "https://api.live.vkvideo.ru/v1/blog/nhl_home_of_hockey/public_video_stream",
        "https://api.live.vkvideo.ru/v1/blog/nhl_home_of_hockey",
    ]:
        x=get(u)
        body=x.pop("body","")
        x["body_preview"]=body[:5000]
        x["body_len"]=len(body)
        out["candidates"].append({"url":u,**x})

    try:
        p=subprocess.run([sys.executable,"-m","yt_dlp","--flat-playlist","--playlist-end","25","--dump-single-json",SOURCE],capture_output=True,text=True,timeout=180)
        out["ytdlp"]={"returncode":p.returncode,"stdout":p.stdout[-200000:],"stderr":p.stderr[-50000:]}
    except Exception as e:
        out["ytdlp"]={"error":repr(e)}

    Path("state").mkdir(exist_ok=True)
    Path("state/vk_hoh_probe.json").write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps({"http":out["http"],"candidate_status":[(x["url"],x.get("status"),x.get("body_len")) for x in out["candidates"]],"ytdlp_rc":out["ytdlp"].get("returncode")},ensure_ascii=False,indent=2))

if __name__=="__main__": main()
