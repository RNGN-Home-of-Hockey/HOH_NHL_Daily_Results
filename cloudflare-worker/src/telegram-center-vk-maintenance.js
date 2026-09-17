const VK_API = "https://api.vk.com/method/video.get";
const VK_VERSION = "5.199";
const VK_OWNER_ID = -227682170;
const PAGE_SIZE = 200;
const META_CURSOR = "hoh_vk_video_backfill_offset";
const META_DONE = "hoh_vk_video_backfill_done";
const HISTORICAL_NOT_BEFORE = Date.parse("2024-09-15T00:00:00Z") / 1000;

const TEAM_ALIASES = {
  ANA:["anaheim","ducks","анахайм","дакс"], BOS:["boston","bruins","бостон","брюинз"], BUF:["buffalo","sabres","баффало","сейбрз"],
  CGY:["calgary","flames","калгари","флэймз","флеймз"], CAR:["carolina","hurricanes","каролина","харрикейнз"], CHI:["chicago","blackhawks","чикаго","блэкхокс"],
  COL:["colorado","avalanche","колорадо","эвеланш","аваланш"], CBJ:["columbus","blue jackets","коламбус","блю джекетс"], DAL:["dallas","stars","даллас","старз"],
  DET:["detroit","red wings","детройт","ред уингз"], EDM:["edmonton","oilers","эдмонтон","ойлерз"], FLA:["florida","panthers","флорида","пантерз"],
  LAK:["los angeles","la kings","kings","лос анджелес","кингз"], MIN:["minnesota","wild","миннесота","уайлд"], MTL:["montreal","canadiens","монреаль","канадиенс"],
  NSH:["nashville","predators","нэшвилл","предаторз"], NJD:["new jersey","devils","нью джерси","дэвилз"], NYI:["new york islanders","islanders","айлендерс","нью йорк айлендерс"],
  NYR:["new york rangers","rangers","рейнджерс","нью йорк рейнджерс"], OTT:["ottawa","senators","оттава","сенаторз"], PHI:["philadelphia","flyers","филадельфия","флайерз"],
  PIT:["pittsburgh","penguins","питтсбург","пингвинз"], SJS:["san jose","sharks","сан хосе","шаркс"], SEA:["seattle","kraken","сиэтл","кракен"],
  STL:["st louis","blues","сент луис","блюз"], TBL:["tampa bay","lightning","тампа","лайтнинг"], TOR:["toronto","maple leafs","торонто","мэйпл лифс","мейпл лифс"],
  UTA:["utah","mammoth","hockey club","юта","маммот"], VAN:["vancouver","canucks","ванкувер","кэнакс","канакс"], VGK:["vegas","golden knights","вегас","голден найтс"],
  WSH:["washington","capitals","вашингтон","кэпиталс"], WPG:["winnipeg","jets","виннипег","джетс"],
};

export async function runVkBroadcastMaintenance(env,{forceBackfill=false}={}) {
  if (!env?.DB) return {ok:false,skipped:true,error:"missing_d1_binding"};
  const token=String(env.VK_ACCESS_TOKEN||"").trim();
  if (!token) return {ok:false,skipped:true,error:"missing_vk_access_token"};

  const first=await fetchVkPage(token,0);
  const current=await ingestPage(env,first.items||[],{offset:0,mode:"latest"});

  const meta=await loadMeta(env.DB,META_CURSOR);
  let offset=Math.max(0,Number(meta?.meta_value||0)||0);
  const doneMeta=await loadMeta(env.DB,META_DONE);
  const done=String(doneMeta?.meta_value||"")==="1";
  let backfill={skipped:true,offset,reason:done&&!forceBackfill?"complete":"not_run"};

  if (!done || forceBackfill) {
    if (forceBackfill && done) offset=0;
    const page=offset===0?first:await fetchVkPage(token,offset);
    backfill=await ingestPage(env,page.items||[],{offset,mode:"backfill"});
    const oldest=Math.min(...(page.items||[]).map(x=>Number(x.date||x.adding_date||0)).filter(Number.isFinite),Infinity);
    const exhausted=(page.items||[]).length<PAGE_SIZE || offset+(page.items||[]).length>=Number(page.count||0) || (oldest!==Infinity && oldest<HISTORICAL_NOT_BEFORE);
    await saveMeta(env.DB,META_CURSOR,String(exhausted?offset:offset+PAGE_SIZE));
    if (exhausted) await saveMeta(env.DB,META_DONE,"1");
    backfill={...backfill,total_available:Number(page.count||0),next_offset:exhausted?null:offset+PAGE_SIZE,complete:exhausted,oldest_unix:oldest===Infinity?null:oldest};
  }
  return {ok:true,owner_id:VK_OWNER_ID,current,backfill};
}

async function fetchVkPage(token,offset){
  const u=new URL(VK_API);
  u.searchParams.set("owner_id",String(VK_OWNER_ID));u.searchParams.set("count",String(PAGE_SIZE));u.searchParams.set("offset",String(offset));u.searchParams.set("extended","0");u.searchParams.set("access_token",token);u.searchParams.set("v",VK_VERSION);
  const r=await fetch(u.toString(),{headers:{Accept:"application/json","User-Agent":"HOH-NHL-Center/18 VK sync"}});
  if(!r.ok)throw new Error(`VK video.get HTTP ${r.status}`);
  const d=await r.json();
  if(d?.error)throw new Error(`VK video.get ${d.error.error_code||"error"}: ${d.error.error_msg||"unknown"}`);
  return d?.response||{count:0,items:[]};
}

async function ingestPage(env,items,{offset,mode}){
  let eligible=0,rawWritten=0,mapped=0,ambiguous=0,unmatched=0;
  for(const item of items||[]){
    const title=String(item?.title||item?.name||"").trim();
    const teams=parseTeams(title);
    if(teams.length<2)continue;
    eligible++;
    const owner=Number(item.owner_id??VK_OWNER_ID),id=Number(item.id||item.video_id||0);
    if(!id)continue;
    const sourceKey=`${owner}_${id}`;
    const published=unixIso(item.date||item.adding_date), scheduled=parseTitleDate(title,published);
    const thumb=bestImage(item.image||item.first_frame||item.first_frame_160||[]);
    const webUrl=`https://vkvideo.ru/video${owner}_${id}`;
    const appUrl=`https://vk.com/video${owner}_${id}`;
    const teamA=teams[0],teamB=teams[1];
    await env.DB.prepare(`
      INSERT INTO vk_broadcasts
        (source_key,source_kind,owner_id,video_id,title,published_at,scheduled_at,status,web_url,app_url,thumbnail_url,duration_seconds,parsed_home_tri,parsed_away_tri,raw_json,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(source_key) DO UPDATE SET
        title=excluded.title,published_at=COALESCE(excluded.published_at,vk_broadcasts.published_at),scheduled_at=COALESCE(excluded.scheduled_at,vk_broadcasts.scheduled_at),
        status=excluded.status,web_url=excluded.web_url,app_url=excluded.app_url,thumbnail_url=COALESCE(excluded.thumbnail_url,vk_broadcasts.thumbnail_url),
        duration_seconds=COALESCE(excluded.duration_seconds,vk_broadcasts.duration_seconds),parsed_home_tri=excluded.parsed_home_tri,parsed_away_tri=excluded.parsed_away_tri,
        raw_json=excluded.raw_json,updated_at=CURRENT_TIMESTAMP;
    `).bind(sourceKey,"vk_video",String(owner),String(id),title,published,scheduled,item.live_status||item.type||"recorded",webUrl,appUrl,thumb,numOrNull(item.duration),teamA,teamB,JSON.stringify(compactItem(item))).run();
    rawWritten++;
    const match=await matchGame(env.DB,teamA,teamB,scheduled||published);
    if(match.kind==="matched"){
      await env.DB.prepare(`
        INSERT INTO game_vk_broadcasts (game_pk,source_key,match_method,match_confidence,matched_at,updated_at)
        VALUES (?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
        ON CONFLICT(game_pk) DO UPDATE SET
          source_key=CASE WHEN excluded.match_confidence>=game_vk_broadcasts.match_confidence THEN excluded.source_key ELSE game_vk_broadcasts.source_key END,
          match_method=CASE WHEN excluded.match_confidence>=game_vk_broadcasts.match_confidence THEN excluded.match_method ELSE game_vk_broadcasts.match_method END,
          match_confidence=MAX(game_vk_broadcasts.match_confidence,excluded.match_confidence),updated_at=CURRENT_TIMESTAMP;
      `).bind(match.game_pk,sourceKey,match.method,match.confidence).run();
      mapped++;
    }else if(match.kind==="ambiguous") ambiguous++; else unmatched++;
  }
  return {mode,offset,seen:(items||[]).length,eligible,raw_written:rawWritten,mapped,ambiguous,unmatched};
}

async function matchGame(db,a,b,dateIso){
  const t=Date.parse(dateIso||"");
  if(!Number.isFinite(t))return {kind:"unmatched"};
  const lo=new Date(t-36*3600*1000).toISOString(),hi=new Date(t+36*3600*1000).toISOString();
  const rows=await db.prepare(`
    SELECT game_pk,scheduled_start_utc,home_tri,away_tri FROM games
    WHERE ((home_tri=? AND away_tri=?) OR (home_tri=? AND away_tri=?))
      AND scheduled_start_utc BETWEEN ? AND ? AND game_type IN (2,3)
    ORDER BY ABS(strftime('%s',scheduled_start_utc)-strftime('%s',?)) ASC,game_pk ASC LIMIT 4;
  `).bind(a,b,b,a,lo,hi,dateIso).all();
  const candidates=rows.results||[];
  if(!candidates.length)return {kind:"unmatched"};
  const scored=candidates.map(g=>({g,d:Math.abs(Date.parse(g.scheduled_start_utc)-t)})).sort((x,y)=>x.d-y.d);
  if(scored.length>1&&Math.abs(scored[1].d-scored[0].d)<15*60*1000)return {kind:"ambiguous"};
  const d=scored[0].d,confidence=d<=6*3600*1000?1:d<=18*3600*1000?.97:.92;
  return {kind:"matched",game_pk:Number(scored[0].g.game_pk),confidence,method:"title_teams_time"};
}

function parseTeams(title){
  const n=` ${norm(title)} `,hits=[];
  for(const [tri,names] of Object.entries(TEAM_ALIASES)){
    let score=0;for(const raw of names){const a=norm(raw);if(a&&n.includes(` ${a} `))score=Math.max(score,a.length)}
    if(score)hits.push({tri,score});
  }
  return hits.sort((x,y)=>y.score-x.score).slice(0,2).map(x=>x.tri);
}
function parseTitleDate(title,fallback){
  let m=String(title||"").match(/(?<!\d)([0-3]?\d)[.\-/]([01]?\d)[.\-/](20\d{2})(?!\d)/);
  if(m){const d=new Date(Date.UTC(Number(m[3]),Number(m[2])-1,Number(m[1]),0,0,0));if(Number.isFinite(d.getTime()))return d.toISOString()}
  m=String(title||"").match(/(?<!\d)(20\d{2})[.\-/]([01]?\d)[.\-/]([0-3]?\d)(?!\d)/);
  if(m){const d=new Date(Date.UTC(Number(m[1]),Number(m[2])-1,Number(m[3]),0,0,0));if(Number.isFinite(d.getTime()))return d.toISOString()}
  return fallback||null;
}
function bestImage(images){
  const list=Array.isArray(images)?images:[];if(!list.length)return typeof images==="string"?images:null;
  return list.slice().sort((a,b)=>(Number(b.width||0)*Number(b.height||0))-(Number(a.width||0)*Number(a.height||0)))[0]?.url||null;
}
function compactItem(x){return {id:x.id,owner_id:x.owner_id,title:x.title,date:x.date,adding_date:x.adding_date,duration:x.duration,type:x.type,live_status:x.live_status,views:x.views,player:x.player,image:x.image}}
function unixIso(v){const n=Number(v);return Number.isFinite(n)&&n>0?new Date(n*1000).toISOString():null}
function norm(v){return String(v||"").toLowerCase().replaceAll("ё","е").replace(/[^0-9a-zа-я]+/gi," ").trim().replace(/\s+/g," ")}
function numOrNull(v){const n=Number(v);return Number.isFinite(n)?n:null}
async function loadMeta(db,key){try{return await db.prepare(`SELECT meta_value,updated_at FROM data_core_meta WHERE meta_key=? LIMIT 1;`).bind(key).first()}catch{return null}}
async function saveMeta(db,key,value){await db.prepare(`INSERT INTO data_core_meta(meta_key,meta_value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP;`).bind(key,value).run()}
