import fs from 'node:fs';
import { chromium } from 'playwright';

const URL='https://vkvideo.ru/@nhl_home_of_hockey/lives';
const out={url:URL,started_at:new Date().toISOString(),responses:[],anchors:[],html_signals:[],storage:{}};
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({
  locale:'ru-RU',
  userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
  viewport:{width:1440,height:1000},
});
const page=await context.newPage();
const seen=new Set();
page.on('response',async r=>{
  const u=r.url();
  if(seen.has(u)) return;
  seen.add(u);
  const type=r.request().resourceType();
  const ct=(r.headers()['content-type']||'').toLowerCase();
  if(!/(vkvideo|vk\.com|api|video|live|playlist|feed|catalog|album|owner|community)/i.test(u) && !ct.includes('json')) return;
  const item={url:u,status:r.status(),resource_type:type,content_type:ct};
  if(ct.includes('json')||type==='xhr'||type==='fetch'){
    try{item.body=(await r.text()).slice(0,150000)}catch{}
  }
  out.responses.push(item);
});
try{
  await page.goto(URL,{waitUntil:'domcontentloaded',timeout:90000});
  await page.waitForTimeout(12000);
  for(let i=0;i<12;i++){
    await page.mouse.wheel(0,1800);
    await page.waitForTimeout(1200);
  }
  out.final_url=page.url();
  out.title=await page.title();
  out.anchors=await page.$$eval('a[href]',els=>els.slice(0,5000).map(a=>({href:a.href,text:(a.textContent||'').trim().slice(0,300),aria:a.getAttribute('aria-label')})));
  const html=await page.content();
  out.html_len=html.length;
  const re=/(?:https?:\/\/[^"'<>\s]+|video[-_]?\d+[_/]\d+|owner[_-]?id.{0,80}|playlist.{0,120}|nhl_home_of_hockey.{0,180})/ig;
  let m; while((m=re.exec(html))&&out.html_signals.length<1000) out.html_signals.push(m[0]);
  out.storage=await page.evaluate(()=>({localStorage:{...localStorage},sessionStorage:{...sessionStorage},cookies:document.cookie}));
}catch(e){out.error=String(e?.stack||e)}
finally{await browser.close()}
out.finished_at=new Date().toISOString();
fs.mkdirSync('state',{recursive:true});
fs.writeFileSync('state/vkvideo_browser_probe.json',JSON.stringify(out,null,2));
console.log(JSON.stringify({final_url:out.final_url,title:out.title,responses:out.responses.length,anchors:out.anchors.length,html_len:out.html_len,error:out.error||null},null,2));
