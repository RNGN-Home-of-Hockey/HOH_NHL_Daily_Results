import { resolveVkAccessToken } from "./telegram-center-vk-auth.js";

const VK_API = "https://api.vk.com/method/video.get";
const VK_VERSION = "5.199";
const VK_OWNER_ID = -227682170;
const PAGE_SIZE = 100;
const BACKFILL_PAGES_PER_TICK = 30;
const META_ALGO = "hoh_vk_video_backfill_algo";
const BACKFILL_ALGO = "v7-strict-full-broadcast-cleanup";
const META_CURSOR = "hoh_vk_video_backfill_offset";
const META_DONE = "hoh_vk_video_backfill_done";
const META_LAST_SYNC = "hoh_vk_video_last_sync_json";
const META_LAST_ERROR = "hoh_vk_video_last_error";
const HISTORICAL_NOT_BEFORE = Date.parse("2024-09-15T00:00:00Z") / 1000;
const MATCH_WINDOW_MS = 36 * 3600 * 1000;
const MIN_CANONICAL_DURATION_SECONDS = 60 * 60;

const TEAM_ALIASES = {
  ANA:["anaheim","ducks","анахайм","дакс"], BOS:["boston","bruins","бостон","брюинз"], BUF:["buffalo","sabres","баффало","сейбрз"],
  CGY:["calgary","flames","калгари","флэймз","флеймз"], CAR:["carolina","hurricanes","каролина","харрикейнз"], CHI:["chicago","blackhawks","чикаго","блэкхокс"],
  COL:["colorado","avalanche","колорадо","эвеланш","аваланш"], CBJ:["columbus","blue jackets","коламбус","блю джекетс"], DAL:["dallas","stars","даллас","старз"],
  DET:["detroit","red wings","детройт","ред уингз"], EDM:["edmonton","oilers","эдмонтон","ойлерз"], FLA:["florida","panthers","флорида","пантерз"],
  LAK:["los angeles","la kings","kings","лос анджелес","кингз"], MIN:["minnesota","wild","миннесота","уайлд"], MTL:["montreal","canadiens","монреаль","канадиенс"],
  NSH:["nashville","predators","нэшвилл","предаторз"], NJD:["new jersey","devils","нью джерси","дэвилз"], NYI:["new york islanders","islanders","айлендерс","айлендерз","нью йорк айлендерс","нью йорк айлендерз"],
  NYR:["new york rangers","rangers","рейнджерс","рейнджерз","рэйнджерс","рэйнджерз","нью йорк рейнджерс","нью йорк рейнджерз"], OTT:["ottawa","senators","оттава","сенаторз"], PHI:["philadelphia","flyers","филадельфия","флайерз"],
  PIT:["pittsburgh","penguins","питтсбург","пингвинз"], SJS:["san jose","sharks","сан хосе","шаркс"], SEA:["seattle","kraken","сиэтл","кракен"],
  STL:["st louis","blues","сент луис","блюз"], TBL:["tampa bay","lightning","тампа","лайтнинг"], TOR:["toronto","maple leafs","торонто","мэйпл лифс","мейпл лифс"],
  UTA:["utah","utah hockey club","mammoth","hockey club","юта","маммот"], VAN:["vancouver","canucks","ванкувер","кэнакс","канакс"], VGK:["vegas","golden knights","вегас","голден найтс"],
  WSH:["washington","capitals","вашингтон","кэпиталс"], WPG:["winnipeg","jets","виннипег","джетс"],
};

const MONTHS = {
  january:1,jan:1,"января":1,"янв":1,
  february:2,feb:2,"февраля":2,"фев":2,
  march:3,mar:3,"марта":3,"мар":3,
  april:4,apr:4,"апреля":4,"апр":4,
  may:5,"мая":5,
  june:6,jun:6,"июня":6,"июн":6,
  july:7,jul:7,"июля":7,"июл":7,
  august:8,aug:8,"августа":8,"авг":8,
  september:9,sep:9,sept:9,"сентября":9,"сен":9,"сент":9,
  october:10,oct:10,"октября":10,"окт":10,
  november:11,nov:11,"ноября":11,"ноя":11,
  december:12,dec:12,"декабря":12,"дек":12,
};

export async function runVkBroadcastMaintenance(env,{forceBackfill=false}={}) {
  if (!env?.DB) return {ok:false,skipped:true,error:"missing_d1_binding"};
  let token;
  try {
    token=await resolveVkAccessToken(env);
  } catch (error) {
    return {ok:false,skipped:true,error:errorText(error)};
  }

  try {
    await env.DB.prepare(`
      DELETE FROM game_vk_broadcasts
      WHERE source_key IN (
        SELECT source_key FROM vk_broadcasts
        WHERE (duration_seconds IS NOT NULL AND duration_seconds < ?)
           OR LOWER(title) LIKE '%хайлайт%'
           OR LOWER(title) LIKE '%highlight%'
           OR LOWER(title) LIKE '%обзор матча%'
           OR LOWER(title) LIKE '%лучшие моменты%'
           OR LOWER(title) LIKE '%best moment%'
      );
    `).bind(MIN_CANONICAL_DURATION_SECONDS).run();

    const algoMeta=await loadMeta(env.DB,META_ALGO);
    if(String(algoMeta?.meta_value||"")!==BACKFILL_ALGO){
      await saveMeta(env.DB,META_CURSOR,"0");
      await saveMeta(env.DB,META_DONE,"0");
      await saveMeta(env.DB,META_ALGO,BACKFILL_ALGO);
      forceBackfill=true;
    }
    const first=await fetchVkPage(token,0);
    const current=await ingestPage(env,first.items||[],{offset:0,mode:"latest"});

    const meta=await loadMeta(env.DB,META_CURSOR);
    let offset=Math.max(0,Number(meta?.meta_value||0)||0);
    const doneMeta=await loadMeta(env.DB,META_DONE);
    const done=String(doneMeta?.meta_value||"")==="1";
    let backfill={skipped:true,offset,reason:done&&!forceBackfill?"complete":"not_run"};

    if (!done || forceBackfill) {
      if (forceBackfill) {
        offset=0;
        await saveMeta(env.DB,META_CURSOR,"0");
        await saveMeta(env.DB,META_DONE,"0");
      }
      let pages=0;
      let seen=0,stored=0,eligible=0,mapped=0,ambiguous=0,unmatched=0;
      let totalAvailable=0;
      let oldestSeen=null;
      let complete=false;
      while(pages<BACKFILL_PAGES_PER_TICK&&!complete){
        const page=(offset===0&&pages===0)?first:await fetchVkPage(token,offset);
        const items=page.items||[];
        const one=await ingestPage(env,items,{offset,mode:"backfill"});
        seen+=Number(one.seen||0); stored+=Number(one.stored||0); eligible+=Number(one.eligible||0);
        mapped+=Number(one.mapped||0); ambiguous+=Number(one.ambiguous||0); unmatched+=Number(one.unmatched||0);
        totalAvailable=Number(page.count||totalAvailable||0);
        const dates=items.map(x=>Number(x.date||x.adding_date||0)).filter(n=>Number.isFinite(n)&&n>0);
        const oldest=dates.length?Math.min(...dates):Infinity;
        if(oldest!==Infinity)oldestSeen=oldestSeen===null?oldest:Math.min(oldestSeen,oldest);
        complete=items.length===0 || offset+items.length>=totalAvailable || (oldest!==Infinity&&oldest<HISTORICAL_NOT_BEFORE);
        if(complete){
          await saveMeta(env.DB,META_DONE,"1");
        }else{
          offset+=items.length;
          await saveMeta(env.DB,META_CURSOR,String(offset));
        }
        pages++;
      }
      backfill={mode:"backfill",pages,seen,stored,eligible,mapped,ambiguous,unmatched,total_available:totalAvailable,next_offset:complete?null:offset,complete,oldest_unix:oldestSeen};
    }

    const result={ok:true,owner_id:VK_OWNER_ID,current,backfill,finished_at:new Date().toISOString()};
    await saveMeta(env.DB,META_LAST_SYNC,JSON.stringify(result));
    await saveMeta(env.DB,META_LAST_ERROR,"");
    return result;
  } catch (error) {
    let message=errorText(error);
    if (/VK video\.get 5:|authorization failed|access token/i.test(message)) {
      try {
        token=await resolveVkAccessToken(env,{force:true});
        const first=await fetchVkPage(token,0);
        const current=await ingestPage(env,first.items||[],{offset:0,mode:"latest"});
        const result={ok:true,owner_id:VK_OWNER_ID,current,backfill:{skipped:true,reason:"token_refreshed_latest_only"},finished_at:new Date().toISOString()};
        await saveMeta(env.DB,META_LAST_SYNC,JSON.stringify(result));
        await saveMeta(env.DB,META_LAST_ERROR,"");
        return result;
      } catch (refreshError) {
        message=errorText(refreshError);
      }
    }
    try { await saveMeta(env.DB,META_LAST_ERROR,JSON.stringify({at:new Date().toISOString(),error:message})); } catch {}
    console.error("VK broadcast maintenance failed", message);
    return {ok:false,error:message};
  }
}

async function fetchVkPage(token,offset){
  const u=new URL(VK_API);
  u.searchParams.set("owner_id",String(VK_OWNER_ID));
  u.searchParams.set("count",String(PAGE_SIZE));
  u.searchParams.set("offset",String(offset));
  u.searchParams.set("extended","0");
  u.searchParams.set("access_token",token);
  u.searchParams.set("v",VK_VERSION);
  const r=await fetch(u.toString(),{headers:{Accept:"application/json","User-Agent":"HOH-NHL-Center/18 VK sync"}});
  if(!r.ok)throw new Error(`VK video.get HTTP ${r.status}`);
  const d=await r.json();
  if(d?.error)throw new Error(`VK video.get ${d.error.error_code||"error"}: ${d.error.error_msg||"unknown"}`);
  return d?.response||{count:0,items:[]};
}

async function ingestPage(env,items,{offset,mode}){
  const records=[];
  for(const item of items||[]){
    const owner=Number(item?.owner_id??VK_OWNER_ID),id=Number(item?.id||item?.video_id||0);
    if(!id)continue;
    const title=String(item?.title||item?.name||"").trim()||`VK video ${id}`;
    const teams=parseTeams(title);
    const published=unixIso(item?.date||item?.adding_date);
    const scheduled=parseTitleDate(title,published);
    records.push({
      source_key:`${owner}_${id}`,
      source_kind:"vk_video",
      owner_id:String(owner),video_id:String(id),title,published_at:published,scheduled_at:scheduled,
      status:String(item?.live_status||item?.type||"recorded"),
      web_url:`https://vkvideo.ru/video${owner}_${id}`,
      app_url:`https://vk.com/video${owner}_${id}`,
      thumbnail_url:bestImage(item?.image||item?.first_frame||item?.first_frame_160||[]),
      duration_seconds:numOrNull(item?.duration),
      parsed_home_tri:teams[0]||null,parsed_away_tri:teams[1]||null,
      raw_json:JSON.stringify(compactItem(item)),
    });
  }

  if(!records.length)return {mode,offset,seen:(items||[]).length,stored:0,eligible:0,mapped:0,ambiguous:0,unmatched:0};
  await bulkUpsertBroadcasts(env.DB,records);

  const eligible=records.filter(x=>x.parsed_home_tri&&x.parsed_away_tri&&(x.scheduled_at||x.published_at)&&broadcastLengthEligible(x));
  const rejected=records.filter(x=>!broadcastLengthEligible(x));
  if(rejected.length)await deleteMappingsForSources(env.DB,rejected.map(x=>x.source_key));
  let matchable=eligible,alreadyMapped=0;
  if(mode==="latest"&&eligible.length){
    const mapped=await loadMappedSourceKeys(env.DB,eligible);
    matchable=eligible.filter(x=>!mapped.has(x.source_key));
    alreadyMapped=eligible.length-matchable.length;
  }
  const games=await loadCandidateGames(env.DB,matchable);
  const mappings=[];
  let ambiguous=0,unmatched=0;
  for(const record of matchable){
    const match=matchFromCandidates(games,record.parsed_home_tri,record.parsed_away_tri,record.scheduled_at||record.published_at,record);
    if(match.kind==="matched")mappings.push({game_pk:match.game_pk,source_key:record.source_key,match_method:match.method,match_confidence:match.confidence});
    else if(match.kind==="ambiguous")ambiguous++;
    else unmatched++;
  }
  if(mappings.length)await bulkUpsertMappings(env.DB,mappings);
  return {mode,offset,seen:(items||[]).length,stored:records.length,eligible:eligible.length,already_mapped:alreadyMapped,matched_now:mappings.length,mapped:alreadyMapped+mappings.length,ambiguous,unmatched};
}

async function bulkUpsertBroadcasts(db,records){
  const payload=JSON.stringify(records);
  await db.prepare(`
    INSERT INTO vk_broadcasts
      (source_key,source_kind,owner_id,video_id,title,published_at,scheduled_at,status,web_url,app_url,thumbnail_url,duration_seconds,parsed_home_tri,parsed_away_tri,raw_json,updated_at)
    SELECT
      json_extract(value,'$.source_key'),json_extract(value,'$.source_kind'),json_extract(value,'$.owner_id'),json_extract(value,'$.video_id'),
      json_extract(value,'$.title'),json_extract(value,'$.published_at'),json_extract(value,'$.scheduled_at'),json_extract(value,'$.status'),
      json_extract(value,'$.web_url'),json_extract(value,'$.app_url'),json_extract(value,'$.thumbnail_url'),json_extract(value,'$.duration_seconds'),
      json_extract(value,'$.parsed_home_tri'),json_extract(value,'$.parsed_away_tri'),json_extract(value,'$.raw_json'),CURRENT_TIMESTAMP
    FROM json_each(?) WHERE 1
    ON CONFLICT(source_key) DO UPDATE SET
      title=excluded.title,published_at=COALESCE(excluded.published_at,vk_broadcasts.published_at),scheduled_at=COALESCE(excluded.scheduled_at,vk_broadcasts.scheduled_at),
      status=excluded.status,web_url=excluded.web_url,app_url=excluded.app_url,thumbnail_url=COALESCE(excluded.thumbnail_url,vk_broadcasts.thumbnail_url),
      duration_seconds=COALESCE(excluded.duration_seconds,vk_broadcasts.duration_seconds),parsed_home_tri=excluded.parsed_home_tri,parsed_away_tri=excluded.parsed_away_tri,
      raw_json=excluded.raw_json,updated_at=CURRENT_TIMESTAMP;
  `).bind(payload).run();
}

async function bulkUpsertMappings(db,mappings){
  const payload=JSON.stringify(mappings);
  // A source video is unique. If a later, better matcher moves it to another game,
  // remove the stale relation first so the UNIQUE(source_key) constraint cannot block correction.
  await db.prepare(`
    DELETE FROM game_vk_broadcasts
    WHERE EXISTS (
      SELECT 1 FROM json_each(?) j
      WHERE json_extract(j.value,'$.source_key')=game_vk_broadcasts.source_key
        AND CAST(json_extract(j.value,'$.game_pk') AS INTEGER)<>game_vk_broadcasts.game_pk
    );
  `).bind(payload).run();
  await db.prepare(`
    INSERT INTO game_vk_broadcasts (game_pk,source_key,match_method,match_confidence,matched_at,updated_at)
    SELECT CAST(json_extract(value,'$.game_pk') AS INTEGER),json_extract(value,'$.source_key'),json_extract(value,'$.match_method'),
           CAST(json_extract(value,'$.match_confidence') AS REAL),CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
    FROM json_each(?) WHERE 1
    ON CONFLICT(game_pk) DO UPDATE SET
      source_key=CASE WHEN excluded.match_confidence>=game_vk_broadcasts.match_confidence THEN excluded.source_key ELSE game_vk_broadcasts.source_key END,
      match_method=CASE WHEN excluded.match_confidence>=game_vk_broadcasts.match_confidence THEN excluded.match_method ELSE game_vk_broadcasts.match_method END,
      match_confidence=MAX(game_vk_broadcasts.match_confidence,excluded.match_confidence),updated_at=CURRENT_TIMESTAMP;
  `).bind(payload).run();
}

async function deleteMappingsForSources(db,keys){
  const clean=[...new Set((keys||[]).map(x=>String(x||"")).filter(Boolean))];
  if(!clean.length)return;
  for(let i=0;i<clean.length;i+=80){
    const part=clean.slice(i,i+80),q=part.map(()=>"?").join(",");
    await db.prepare("DELETE FROM game_vk_broadcasts WHERE source_key IN ("+q+");").bind(...part).run();
  }
}
async function loadMappedSourceKeys(db,records){
  if(!records.length)return new Set();
  const keys=records.map(x=>String(x.source_key||"")).filter(Boolean);
  if(!keys.length)return new Set();
  const placeholders=keys.map(()=>"?").join(",");
  const rows=await db.prepare("SELECT source_key FROM game_vk_broadcasts WHERE source_key IN ("+placeholders+");").bind(...keys).all();
  return new Set((rows.results||[]).map(x=>String(x.source_key||"")).filter(Boolean));
}
async function loadCandidateGames(db,records){
  const times=records.map(x=>Date.parse(x.scheduled_at||x.published_at||"")).filter(Number.isFinite);
  if(!times.length)return [];
  const lo=new Date(Math.min(...times)-MATCH_WINDOW_MS).toISOString();
  const hi=new Date(Math.max(...times)+MATCH_WINDOW_MS).toISOString();
  const rows=await db.prepare(`
    SELECT game_pk,scheduled_start_utc,home_tri,away_tri,game_type
    FROM games
    WHERE scheduled_start_utc BETWEEN ? AND ? AND game_type IN (1,2,3)
    ORDER BY scheduled_start_utc ASC,game_pk ASC;
  `).bind(lo,hi).all();
  return rows.results||[];
}

function broadcastLengthEligible(record){
  const title=String(record?.title||"");
  if(/(?:хайлайт|highlights?|обзор\s+матча|лучшие\s+моменты|best\s+moments?)/iu.test(title))return false;
  const duration=Number(record?.duration_seconds);
  if(Number.isFinite(duration)&&duration>0)return duration>=MIN_CANONICAL_DURATION_SECONDS;
  const status=norm(record?.status||"");
  return /live|прямой эфир/.test(status);
}
function matchFromCandidates(games,a,b,dateIso,record){
  if(!broadcastLengthEligible(record))return {kind:"unmatched",reason:"duration_under_60m"};
  const t=Date.parse(dateIso||"");
  if(!Number.isFinite(t))return {kind:"unmatched"};
  const pair=(games||[]).filter(g=>((g.home_tri===a&&g.away_tri===b)||(g.home_tri===b&&g.away_tri===a)));
  const titleDay=explicitTitleDay(record?.title||"");
  if(titleDay){
    const exact=pair.filter(g=>String(g.scheduled_start_utc||"").slice(0,10)===titleDay);
    if(exact.length===1){
      return {kind:"matched",game_pk:Number(exact[0].game_pk),confidence:1,method:"title_teams_calendar_date"};
    }
  }
  const scored=pair
    .map(g=>({g,d:Math.abs(Date.parse(g.scheduled_start_utc)-t)}))
    .filter(x=>Number.isFinite(x.d)&&x.d<=MATCH_WINDOW_MS)
    .sort((x,y)=>x.d-y.d||Number(x.g.game_pk)-Number(y.g.game_pk));
  if(!scored.length)return {kind:"unmatched"};
  if(scored.length>1&&Math.abs(scored[1].d-scored[0].d)<15*60*1000)return {kind:"ambiguous"};
  const d=scored[0].d;
  let confidence=d<=6*3600*1000?1:d<=18*3600*1000?.97:.92;
  const duration=Number(record?.duration_seconds||0);
  const title=norm(record?.title||"");
  if(duration>=90*60)confidence=Math.min(1,confidence+.003);
  if(/прямой эфир|трансляц|live|полный матч/.test(title))confidence=Math.min(1,confidence+.002);
  return {kind:"matched",game_pk:Number(scored[0].g.game_pk),confidence,method:"title_teams_time"};
}
function explicitTitleDay(title){
  const text=String(title||"");
  let m=text.match(/(?<!\d)([0-3]?\d)[.\-/]([01]?\d)[.\-/](20\d{2})(?!\d)/);
  if(m)return `${m[3]}-${String(Number(m[2])).padStart(2,"0")}-${String(Number(m[1])).padStart(2,"0")}`;
  m=text.match(/(?<!\d)(20\d{2})[.\-/]([01]?\d)[.\-/]([0-3]?\d)(?!\d)/);
  if(m)return `${m[1]}-${String(Number(m[2])).padStart(2,"0")}-${String(Number(m[3])).padStart(2,"0")}`;
  return null;
}

function parseTeams(title){
  const n=` ${norm(title)} `,hits=[];
  for(const [tri,names] of Object.entries(TEAM_ALIASES)){
    let score=0;
    const triAlias=tri.toLowerCase();
    if(n.includes(` ${triAlias} `))score=Math.max(score,10);
    for(const raw of names){const a=norm(raw);if(a&&n.includes(` ${a} `))score=Math.max(score,a.length)}
    if(score)hits.push({tri,score});
  }
  return hits.sort((x,y)=>y.score-x.score||x.tri.localeCompare(y.tri)).slice(0,2).map(x=>x.tri);
}
function parseTitleDate(title,fallback){
  const text=String(title||"");
  let m=text.match(/(?<!\d)([0-3]?\d)[.\-/]([01]?\d)[.\-/](20\d{2})(?!\d)/);
  if(m){const d=new Date(Date.UTC(Number(m[3]),Number(m[2])-1,Number(m[1]),0,0,0));if(Number.isFinite(d.getTime()))return d.toISOString()}
  m=text.match(/(?<!\d)(20\d{2})[.\-/]([01]?\d)[.\-/]([0-3]?\d)(?!\d)/);
  if(m){const d=new Date(Date.UTC(Number(m[1]),Number(m[2])-1,Number(m[3]),0,0,0));if(Number.isFinite(d.getTime()))return d.toISOString()}
  m=norm(text).match(/(?:^|\s)([0-3]?\d)\s+([a-zа-я]+)\s+(20\d{2})(?:\s|$)/i);
  if(m){const month=MONTHS[m[2]];if(month){const d=new Date(Date.UTC(Number(m[3]),month-1,Number(m[1]),0,0,0));if(Number.isFinite(d.getTime()))return d.toISOString()}}
  return fallback||null;
}
function bestImage(images){
  const list=Array.isArray(images)?images:[];if(!list.length)return typeof images==="string"?images:null;
  return list.slice().sort((a,b)=>(Number(b.width||0)*Number(b.height||0))-(Number(a.width||0)*Number(a.height||0)))[0]?.url||null;
}
function compactItem(x){return {id:x?.id,owner_id:x?.owner_id,title:x?.title,date:x?.date,adding_date:x?.adding_date,duration:x?.duration,type:x?.type,live_status:x?.live_status,views:x?.views,player:x?.player}}
function unixIso(v){const n=Number(v);return Number.isFinite(n)&&n>0?new Date(n*1000).toISOString():null}
function norm(v){return String(v||"").toLowerCase().replaceAll("ё","е").replace(/[^0-9a-zа-я]+/gi," ").trim().replace(/\s+/g," ")}
function numOrNull(v){const n=Number(v);return Number.isFinite(n)?n:null}
function errorText(error){return String(error?.message||error||"unknown_error")}
async function loadMeta(db,key){try{return await db.prepare(`SELECT meta_value,updated_at FROM data_core_meta WHERE meta_key=? LIMIT 1;`).bind(key).first()}catch{return null}}
async function saveMeta(db,key,value){await db.prepare(`INSERT INTO data_core_meta(meta_key,meta_value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP;`).bind(key,value).run()}
