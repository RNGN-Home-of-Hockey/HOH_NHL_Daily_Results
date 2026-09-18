const API="/api/telegram-center-v20";
const NHL_PAGE="https://www.sports.ru/hockey/tournament/nhl/";
const USER_AGENT="HOH-NHL-Center/20 news-indexer";
const HOME_MIN_INTERVAL_MS=10*60*1000;
const PLAYER_BATCH=4;
const MAX_PLAYER_PAGE=20;

const POLITICAL_RE=/(единая\s+россия|путин|кремл|президент|правительств|депутат|сенатор|конгресс|выбор|предвыбор|парт(?:ия|ии|ию)|политик|боев(?:ые|ых)?\s+действ|войн|украин|нато|санкц|въезд\s+в\s+[а-я]|латви|госдум|мид\b|патриот(?:изм|ическ)|гражданин\s+россии|подданн)/iu;
const OFF_ICE_RE=/(футбол|рпл|динамо\s+махачкал|помидор|день\s+рождения|вечерин|семь[яи]|сын\b|дочь\b|жена\b|отпуск|ресторан|автомобил|мода|кино|концерт)/iu;
const HOCKEY_RE=/(нхл|nhl|хокке|матч|игр[аы]|сезон|гол|шайб|очк|передач|ассист|брос|кубок\s+стэнли|плей-офф|драфт|контракт|клуб|команд|тренер|форвард|защитник|вратар|звено|ворот|рекорд|капитан|трансфер|обмен|состав|трениров|лига|овертайм|буллит|силов)/iu;

export async function handleTelegramCenterV20News(request,env,path){
  if(!path.startsWith(API))return null;
  if(!env?.DB)return json({ok:false,error:"missing_d1_binding"},503);

  if(path===API+"/news/home"&&request.method==="GET")return homeNews(request,env);
  if(path===API+"/news/status"&&request.method==="GET")return status(env);
  if(path===API+"/news/sync"&&request.method==="POST")return manualSync(request,env);

  let m=/^\/api\/telegram-center-v20\/players\/(\d+)\/news$/.exec(path);
  if(m&&request.method==="GET")return playerNews(request,env,Number(m[1]));

  m=/^\/api\/telegram-center-v20\/news\/(\d+)$/.exec(path);
  if(m&&request.method==="GET")return newsDetail(env,Number(m[1]));

  m=/^\/api\/telegram-center-v20\/news\/(\d+)\/comments$/.exec(path);
  if(m&&request.method==="GET")return comments(env,Number(m[1]));
  if(m&&request.method==="POST")return addComment(request,env,Number(m[1]));

  return json({ok:false,error:"not_found"},404);
}

export async function runSportsRuNewsMaintenance(env,{force=false,homeOnly=false}={}){
  if(!env?.DB)return {ok:false,error:"missing_d1_binding"};
  const last=await loadMeta(env.DB,"sports_ru_nhl_home_sync");
  const lastAt=Date.parse(String(last?.updated_at||"").replace(" ","T")+"Z");
  let home={skipped:true,reason:"fresh"};
  if(force||!Number.isFinite(lastAt)||Date.now()-lastAt>=HOME_MIN_INTERVAL_MS){
    home=await scanNhlMain(env);
    await saveMeta(env.DB,"sports_ru_nhl_home_sync",JSON.stringify({ok:home.ok,stored:home.stored,politics:home.politics,at:new Date().toISOString()}));
  }
  let players={skipped:true};
  if(!homeOnly){
    await ensurePlayerSources(env.DB);
    players=await scanPlayerSources(env);
  }
  return {ok:Boolean(home.ok!==false&&players.ok!==false),home,players};
}

async function homeNews(request,env){
  const limit=clamp(new URL(request.url).searchParams.get("limit"),10,1,20);
  try{
    const count=await env.DB.prepare("SELECT COUNT(*) count FROM sports_news WHERE topic='nhl'").first().catch(()=>({count:0}));
    if(Number(count?.count||0)<limit)await runSportsRuNewsMaintenance(env,{homeOnly:true}).catch(()=>null);
    const rows=await env.DB.prepare(`
      SELECT n.news_id,n.title,n.body_text,n.published_at,n.created_at,
             COUNT(c.comment_id) comment_count
      FROM sports_news n
      LEFT JOIN sports_news_comments c ON c.news_id=n.news_id AND c.deleted=0
      WHERE n.topic='nhl'
      GROUP BY n.news_id
      ORDER BY COALESCE(n.published_at,n.created_at) DESC,n.news_id DESC
      LIMIT ?;
    `).bind(limit).all();
    return json({ok:true,version:"V20",news:rows.results||[]});
  }catch(error){return json({ok:false,error:"news_schema_not_ready",detail:errorText(error)},503)}
}

async function playerNews(request,env,playerId){
  if(!Number.isSafeInteger(playerId)||playerId<=0)return json({ok:false,error:"invalid_player_id"},400);
  const limit=clamp(new URL(request.url).searchParams.get("limit"),100,1,200);
  try{
    const rows=await env.DB.prepare(`
      SELECT n.news_id,n.title,n.body_text,n.published_at,n.created_at,
             COUNT(c.comment_id) comment_count
      FROM sports_news_players p
      JOIN sports_news n ON n.news_id=p.news_id
      LEFT JOIN sports_news_comments c ON c.news_id=n.news_id AND c.deleted=0
      WHERE p.player_id=?
      GROUP BY n.news_id
      ORDER BY COALESCE(n.published_at,n.created_at) DESC,n.news_id DESC
      LIMIT ?;
    `).bind(playerId,limit).all();
    return json({ok:true,version:"V20",player_id:playerId,news:rows.results||[]});
  }catch(error){return json({ok:false,error:"news_schema_not_ready",detail:errorText(error)},503)}
}

async function newsDetail(env,newsId){
  if(!Number.isSafeInteger(newsId)||newsId<=0)return json({ok:false,error:"invalid_news_id"},400);
  let row;
  try{row=await env.DB.prepare(`
    SELECT n.news_id,n.source_url,n.title,n.body_text,n.published_at,n.created_at,
           COUNT(c.comment_id) comment_count
    FROM sports_news n
    LEFT JOIN sports_news_comments c ON c.news_id=n.news_id AND c.deleted=0
    WHERE n.news_id=?
    GROUP BY n.news_id LIMIT 1;
  `).bind(newsId).first()}catch(error){return json({ok:false,error:"news_schema_not_ready",detail:errorText(error)},503)}
  if(!row)return json({ok:false,error:"news_not_found"},404);
  if(!row.body_text&&row.source_url){
    const enriched=await enrichNews(row.source_url).catch(()=>null);
    if(enriched?.body_text||enriched?.published_at){
      await env.DB.prepare("UPDATE sports_news SET body_text=COALESCE(?,body_text),published_at=COALESCE(?,published_at),updated_at=CURRENT_TIMESTAMP WHERE news_id=?")
        .bind(enriched.body_text||null,enriched.published_at||null,newsId).run().catch(()=>null);
      row.body_text=enriched.body_text||row.body_text;
      row.published_at=enriched.published_at||row.published_at;
    }
  }
  delete row.source_url;
  return json({ok:true,version:"V20",news:row});
}

async function comments(env,newsId){
  if(!Number.isSafeInteger(newsId)||newsId<=0)return json({ok:false,error:"invalid_news_id"},400);
  try{
    const rows=await env.DB.prepare(`
      SELECT c.comment_id,c.body,c.created_at,u.telegram_user_id,u.username,u.first_name,u.last_name
      FROM sports_news_comments c
      JOIN telegram_users u ON u.telegram_user_id=c.telegram_user_id
      WHERE c.news_id=? AND c.deleted=0
      ORDER BY c.created_at ASC,c.comment_id ASC LIMIT 250;
    `).bind(newsId).all();
    return json({ok:true,news_id:newsId,comments:(rows.results||[]).map(x=>({...x,author:displayName(x)}))});
  }catch(error){return json({ok:false,error:"comments_failed",detail:errorText(error)},503)}
}

async function addComment(request,env,newsId){
  if(!Number.isSafeInteger(newsId)||newsId<=0)return json({ok:false,error:"invalid_news_id"},400);
  const auth=await telegramAuth(request,env,true);
  if(!auth.ok)return json({ok:false,error:auth.error},401);
  let body;try{body=await request.json()}catch{return json({ok:false,error:"invalid_json"},400)}
  const text=String(body?.body||"").trim();
  if(!text||text.length>1000)return json({ok:false,error:"invalid_comment_length",max:1000},400);
  const exists=await env.DB.prepare("SELECT news_id FROM sports_news WHERE news_id=? LIMIT 1").bind(newsId).first();
  if(!exists)return json({ok:false,error:"news_not_found"},404);
  await upsertTelegramUser(env.DB,auth.user);
  const r=await env.DB.prepare("INSERT INTO sports_news_comments(news_id,telegram_user_id,body) VALUES(?,?,?)").bind(newsId,auth.user.id,text).run();
  return json({ok:true,comment_id:Number(r.meta?.last_row_id||0)},201);
}

async function status(env){
  try{
    const [n,p,c,s]=await Promise.all([
      env.DB.prepare("SELECT COUNT(*) count,MAX(COALESCE(published_at,created_at)) latest FROM sports_news").first(),
      env.DB.prepare("SELECT COUNT(DISTINCT player_id) players FROM sports_news_players").first(),
      env.DB.prepare("SELECT COUNT(*) count FROM sports_news_comments WHERE deleted=0").first(),
      env.DB.prepare("SELECT COUNT(*) sources,SUM(CASE WHEN backfill_done=1 THEN 1 ELSE 0 END) done FROM sports_player_sources").first()
    ]);
    return json({ok:true,version:"V20",news:Number(n?.count||0),latest:n?.latest||null,players_with_news:Number(p?.players||0),comments:Number(c?.count||0),player_sources:Number(s?.sources||0),player_backfill_done:Number(s?.done||0)});
  }catch(error){return json({ok:false,error:"news_schema_not_ready",detail:errorText(error)},503)}
}

async function manualSync(request,env){
  if(!(await managementAuthorized(request,env)))return json({ok:false,error:"unauthorized"},401);
  const result=await runSportsRuNewsMaintenance(env,{force:true});
  return json(result,result.ok?200:502);
}

async function scanNhlMain(env){
  let html;
  try{html=await fetchText(NHL_PAGE)}catch(error){return {ok:false,error:"sports_main_fetch_failed",detail:errorText(error),stored:0,politics:0}}
  const items=extractHtmlNews(html,NHL_PAGE).slice(0,60);
  const players=await activePlayerNames(env.DB);
  let stored=0,politics=0,duplicate=0;
  for(let i=0;i<items.length&&stored<30;i++){
    const item=items[i];
    if(isPolitical(item.title)){politics++;continue}
    item.published_at=item.published_at||new Date(Date.now()-i*1000).toISOString();
    const id=await upsertNews(env.DB,item);
    if(!id){duplicate++;continue}
    stored++;
    await linkPlayersFromTitle(env.DB,id,item.title,players);
  }
  return {ok:true,seen:items.length,stored,politics,duplicate};
}

async function ensurePlayerSources(db){
  const rows=await db.prepare(`
    SELECT p.player_id,p.full_name_en
    FROM players p
    LEFT JOIN sports_player_sources s ON s.player_id=p.player_id
    WHERE COALESCE(p.active,1)=1 AND p.full_name_en IS NOT NULL AND TRIM(p.full_name_en)<>'' AND s.player_id IS NULL
    ORDER BY p.player_id ASC LIMIT 40;
  `).all();
  const stmts=[];
  for(const p of rows.results||[]){
    const slug=playerSlug(p.full_name_en);
    if(!slug)continue;
    stmts.push(db.prepare(`
      INSERT OR IGNORE INTO sports_player_sources(player_id,sports_slug,source_url,next_page,backfill_done)
      VALUES(?,?,?,1,0);
    `).bind(Number(p.player_id),slug,`https://www.sports.ru/hockey/person/${slug}/news/`));
  }
  if(stmts.length)await db.batch(stmts);
}

async function scanPlayerSources(env){
  const rows=await env.DB.prepare(`
    SELECT s.player_id,s.sports_slug,s.source_url,s.next_page,p.full_name_en,p.full_name_ru,p.current_team_tri
    FROM sports_player_sources s
    JOIN players p ON p.player_id=s.player_id
    WHERE s.backfill_done=0
    ORDER BY CASE WHEN s.player_id=8471214 THEN 0 ELSE 1 END,
             CASE WHEN s.last_scanned_at IS NULL THEN 0 ELSE 1 END,
             s.last_scanned_at ASC,s.player_id ASC
    LIMIT ?;
  `).bind(PLAYER_BATCH).all();
  let sources=0,stored=0,politics=0,offIce=0,errors=0;
  for(const src of rows.results||[]){
    sources++;
    const page=Math.max(1,Number(src.next_page||1));
    const url=page===1?src.source_url:src.source_url+`page${page}/`;
    let html;
    try{html=await fetchText(url)}catch(error){
      errors++;
      await env.DB.prepare("UPDATE sports_player_sources SET backfill_done=1,last_scanned_at=CURRENT_TIMESTAMP,last_error=?,updated_at=CURRENT_TIMESTAMP WHERE player_id=?").bind(errorText(error).slice(0,300),src.player_id).run();
      continue;
    }
    const items=extractHtmlNews(html,url);
    let accepted=0;
    for(const item of items){
      const combined=item.title+" "+(item.body_text||"");
      if(isPolitical(combined)){politics++;continue}
      if(!isHockeyOnly(combined)){offIce++;continue}
      const id=await upsertNews(env.DB,item);
      if(!id)continue;
      await linkNewsPlayer(env.DB,id,Number(src.player_id));
      stored++;accepted++;
    }
    const hasNext=page<MAX_PLAYER_PAGE&&hasNextNewsPage(html,page+1)&&items.length>0;
    await env.DB.prepare(`
      UPDATE sports_player_sources
      SET next_page=?,backfill_done=?,last_scanned_at=CURRENT_TIMESTAMP,last_error=NULL,updated_at=CURRENT_TIMESTAMP
      WHERE player_id=?;
    `).bind(hasNext?page+1:page,hasNext?0:1,src.player_id).run();
  }
  return {ok:true,sources,stored,politics,off_ice:offIce,errors};
}

async function upsertNews(db,item){
  const sourceKey=item.source_key||item.source_url;
  if(!sourceKey||!item.source_url||!item.title)return 0;
  await db.prepare(`
    INSERT INTO sports_news(source,source_key,source_url,title,body_text,published_at,topic,updated_at)
    VALUES('sports_ru',?,?,?,?,?,'nhl',CURRENT_TIMESTAMP)
    ON CONFLICT(source,source_key) DO UPDATE SET
      title=excluded.title,
      body_text=COALESCE(NULLIF(excluded.body_text,''),sports_news.body_text),
      published_at=COALESCE(excluded.published_at,sports_news.published_at),
      updated_at=CURRENT_TIMESTAMP;
  `).bind(sourceKey,item.source_url,item.title,item.body_text||null,item.published_at||null).run();
  const row=await db.prepare("SELECT news_id FROM sports_news WHERE source='sports_ru' AND source_key=? LIMIT 1").bind(sourceKey).first();
  return Number(row?.news_id||0);
}

async function linkNewsPlayer(db,newsId,playerId){
  await db.prepare("INSERT OR IGNORE INTO sports_news_players(news_id,player_id) VALUES(?,?)").bind(newsId,playerId).run();
}

async function activePlayerNames(db){
  const r=await db.prepare("SELECT player_id,full_name_en,full_name_ru FROM players WHERE COALESCE(active,1)=1 AND (full_name_en IS NOT NULL OR full_name_ru IS NOT NULL) LIMIT 1800").all();
  return (r.results||[]).map(p=>({id:Number(p.player_id),en:String(p.full_name_en||""),ru:String(p.full_name_ru||"")}));
}

async function linkPlayersFromTitle(db,newsId,title,players){
  const n=norm(title),hits=[];
  for(const p of players){
    const names=[p.ru,p.en].filter(Boolean);
    let ok=false;
    for(const name of names){
      const parts=norm(name).split(" ").filter(Boolean);
      const last=parts.at(-1)||"";
      if(last.length>=5&&n.includes(last)){ok=true;break}
    }
    if(ok)hits.push(p.id);
    if(hits.length>=8)break;
  }
  if(hits.length)await db.batch(hits.map(id=>db.prepare("INSERT OR IGNORE INTO sports_news_players(news_id,player_id) VALUES(?,?)").bind(newsId,id)));
}

function extractHtmlNews(html,base){
  const out=[],seen=new Set();
  const re=/<a\b([^>]*?)href=(["'])([^"']+)\2([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while((m=re.exec(String(html||"")))){
    let href=decodeEntities(m[3]);
    if(!href||href.startsWith("#"))continue;
    try{href=new URL(href,base).toString()}catch{continue}
    if(!/^https?:\/\/(?:www\.)?sports\.ru\/hockey\/\d+\.html(?:[?#].*)?$/i.test(href))continue;
    const title=cleanText(m[5]);
    if(title.length<20||title.length>700||seen.has(href))continue;
    seen.add(href);
    const attrs=(m[1]||"")+" "+(m[4]||"");
    const dt=/datetime=(["'])([^"']+)\1/i.exec(attrs)?.[2]||null;
    out.push({source_key:canonicalUrl(href),source_url:canonicalUrl(href),title,body_text:null,published_at:validDate(dt)});
  }
  return out;
}

export function extractSportsRss(xml){
  const out=[];
  for(const block of String(xml||"").match(/<item\b[\s\S]*?<\/item>/gi)||[]){
    const title=tag(block,"title"),link=tag(block,"link"),guid=tag(block,"guid"),desc=tag(block,"content:encoded")||tag(block,"description"),pub=tag(block,"pubDate");
    if(!title||!link)continue;
    out.push({source_key:cleanText(guid)||canonicalUrl(link),source_url:canonicalUrl(link),title:cleanText(title),body_text:cleanText(desc).slice(0,5000)||null,published_at:validDate(pub)});
  }
  return out;
}

function tag(block,name){
  const m=new RegExp("<"+name+"(?:\\s[^>]*)?>([\\s\\S]*?)<\\/"+name+">","i").exec(block);
  return m?decodeEntities(String(m[1]).replace(/^<!\[CDATA\[/,"").replace(/\]\]>$/,"")):"";
}
function hasNextNewsPage(html,next){return new RegExp("(Следующие\\s+100\\s+новостей|/news/page"+next+"/)","i").test(cleanText(html))||new RegExp("/news/page"+next+"/","i").test(String(html||""))}
function isPolitical(text){return POLITICAL_RE.test(String(text||""))}
function isHockeyOnly(text){const s=String(text||"");return HOCKEY_RE.test(s)&&!OFF_ICE_RE.test(s)}
function playerSlug(name){return String(name||"").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[’']/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"")}
function canonicalUrl(v){try{const u=new URL(v);u.hash="";u.search="";return u.toString()}catch{return String(v||"").trim()}}
function validDate(v){if(!v)return null;const d=new Date(v);return Number.isNaN(d.getTime())?null:d.toISOString()}
function cleanText(v){return decodeEntities(String(v||"").replace(/<script\b[\s\S]*?<\/script>/gi," ").replace(/<style\b[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim())}
function decodeEntities(v){return String(v||"").replace(/&nbsp;|&#160;/gi," ").replace(/&amp;/gi,"&").replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&lt;/gi,"<").replace(/&gt;/gi,">").replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)||32))}
function norm(v){return cleanText(v).toLocaleLowerCase("ru").replaceAll("ё","е")}
async function fetchText(url){
  const r=await fetch(url,{headers:{Accept:"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8","User-Agent":USER_AGENT}});
  if(!r.ok)throw new Error("HTTP "+r.status+" "+url);
  return r.text();
}
async function enrichNews(url){
  const html=await fetchText(url);
  const meta=(name)=>{
    const patterns=[
      new RegExp('<meta[^>]+(?:property|name)=(["\\\'])'+name+'\\1[^>]+content=(["\\\'])([\\s\\S]*?)\\2[^>]*>','i'),
      new RegExp('<meta[^>]+content=(["\\\'])([\\s\\S]*?)\\1[^>]+(?:property|name)=(["\\\'])'+name+'\\3[^>]*>','i')
    ];
    for(const re of patterns){const m=re.exec(html);if(m)return decodeEntities(m[m.length-1])}
    return '';
  };
  let body=cleanText(meta('og:description')||meta('description')).slice(0,5000);
  if(!body){
    const m=/"description"\s*:\s*"((?:\\.|[^"\\])*)"/i.exec(html);
    if(m)try{body=cleanText(JSON.parse('"'+m[1]+'"')).slice(0,5000)}catch{}
  }
  let published=meta('article:published_time');
  if(!published){
    const m=/"datePublished"\s*:\s*"([^"]+)"/i.exec(html);published=m?.[1]||'';
  }
  return {body_text:body||null,published_at:validDate(published)};
}

function displayName(x){return [x.first_name,x.last_name].filter(Boolean).join(" ").trim()||(x.username?"@"+x.username:"Пользователь")}
function clamp(v,d,min,max){const n=Number(v);return Number.isFinite(n)?Math.max(min,Math.min(max,Math.trunc(n))):d}
function errorText(error){return String(error?.message||error||"unknown_error")}

async function upsertTelegramUser(db,user){
  await db.prepare(`INSERT INTO telegram_users(telegram_user_id,username,first_name,last_name,language_code,notifications_enabled,updated_at)
    VALUES(?,?,?,?,?,1,CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_user_id) DO UPDATE SET username=excluded.username,first_name=excluded.first_name,last_name=excluded.last_name,language_code=excluded.language_code,updated_at=CURRENT_TIMESTAMP`)
    .bind(user.id,user.username,user.first_name,user.last_name,user.language_code).run();
}
async function telegramAuth(request,env,required){
  const initData=String(request.headers.get("x-telegram-init-data")||"").trim();
  if(!initData)return required?{ok:false,error:"missing_telegram_init_data"}:{ok:false,error:"guest"};
  const token=String(env.TELEGRAM_CENTER_BOT_TOKEN||"").trim();
  if(!token)return {ok:false,error:"missing_telegram_center_token"};
  try{
    const params=new URLSearchParams(initData),provided=params.get("hash")||"",authDate=Number(params.get("auth_date")||0),userRaw=params.get("user")||"";params.delete("hash");
    if(!provided||!authDate||!userRaw)return {ok:false,error:"invalid_telegram_init_data"};
    const max=Number(env.TELEGRAM_WEBAPP_MAX_AGE_SECONDS||86400),age=Number.isFinite(max)?Math.min(604800,Math.max(300,Math.floor(max))):86400;
    if(Math.abs(Math.floor(Date.now()/1000)-authDate)>age)return {ok:false,error:"telegram_init_data_expired"};
    const check=[...params.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join("\n"),e=new TextEncoder();
    const k1=await crypto.subtle.importKey("raw",e.encode("WebAppData"),{name:"HMAC",hash:"SHA-256"},false,["sign"]),secret=await crypto.subtle.sign("HMAC",k1,e.encode(token));
    const k2=await crypto.subtle.importKey("raw",secret,{name:"HMAC",hash:"SHA-256"},false,["sign"]),digest=await crypto.subtle.sign("HMAC",k2,e.encode(check)),calc=hex(new Uint8Array(digest));
    if(!(await secureEqual(calc,provided.toLowerCase())))return {ok:false,error:"telegram_signature_invalid"};
    const raw=JSON.parse(userRaw),id=Number(raw.id);if(!Number.isSafeInteger(id)||id<=0)return {ok:false,error:"telegram_user_invalid"};
    return {ok:true,user:{id,username:raw.username||null,first_name:raw.first_name||null,last_name:raw.last_name||null,language_code:raw.language_code||null}};
  }catch{return {ok:false,error:"telegram_init_data_invalid"}}
}
async function managementAuthorized(request,env){const expected=String(env.MANAGEMENT_API_SECRET||"").trim(),m=/^Bearer\s+(\S+)$/i.exec(String(request.headers.get("authorization")||"").trim());return Boolean(expected&&m&&await secureEqual(m[1],expected))}
async function secureEqual(a,b){const e=new TextEncoder(),[x,y]=await Promise.all([crypto.subtle.digest("SHA-256",e.encode(String(a))),crypto.subtle.digest("SHA-256",e.encode(String(b)))]),aa=new Uint8Array(x),bb=new Uint8Array(y);let d=aa.length^bb.length;for(let i=0;i<Math.min(aa.length,bb.length);i++)d|=aa[i]^bb[i];return d===0}
function hex(bytes){return [...bytes].map(x=>x.toString(16).padStart(2,"0")).join("")}
async function loadMeta(db,key){try{return await db.prepare("SELECT meta_value,updated_at FROM data_core_meta WHERE meta_key=? LIMIT 1").bind(key).first()}catch{return null}}
async function saveMeta(db,key,value){await db.prepare("INSERT INTO data_core_meta(meta_key,meta_value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP").bind(key,value).run()}
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}})}
