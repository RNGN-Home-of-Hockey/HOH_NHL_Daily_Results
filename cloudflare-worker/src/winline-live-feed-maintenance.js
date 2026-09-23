const LIVE_FEED_URL="https://back.winline.ru/banners/live_mainsports_eng";
const META_KEY="winline_live_feed_sync_state";
const LIVE_STATES=new Set(["LIVE","CRIT","INTERMISSION"]);
const TEAM_ALIASES={
  ANA:["Anaheim Ducks"],BOS:["Boston Bruins"],BUF:["Buffalo Sabres"],CGY:["Calgary Flames"],CAR:["Carolina Hurricanes"],CHI:["Chicago Blackhawks"],
  COL:["Colorado Avalanche"],CBJ:["Columbus Blue Jackets"],DAL:["Dallas Stars"],DET:["Detroit Red Wings"],EDM:["Edmonton Oilers"],FLA:["Florida Panthers"],
  LAK:["Los Angeles Kings"],MIN:["Minnesota Wild"],MTL:["Montreal Canadiens"],NSH:["Nashville Predators"],NJD:["New Jersey Devils"],NYI:["New York Islanders"],
  NYR:["New York Rangers"],OTT:["Ottawa Senators"],PHI:["Philadelphia Flyers"],PIT:["Pittsburgh Penguins"],SJS:["San Jose Sharks"],SEA:["Seattle Kraken"],
  STL:["St. Louis Blues","St Louis Blues"],TBL:["Tampa Bay Lightning"],TOR:["Toronto Maple Leafs"],UTA:["Utah Mammoth","Utah Hockey Club"],
  VAN:["Vancouver Canucks"],VGK:["Vegas Golden Knights"],WSH:["Washington Capitals"],WPG:["Winnipeg Jets"]
};
const NAME_TO_TRI=buildNameMap();

export async function runWinlineLiveFeedMaintenance(env,{force=false,nowMs=Date.now(),fetchImpl=fetch}={}){
  if(!env?.DB)return {ok:false,error:"missing_d1_binding"};
  const candidates=await liveGameCandidates(env.DB,new Date(nowMs).toISOString());
  if(!candidates.length)return {ok:true,skipped:true,reason:"no_live_games",live_games:0};
  const state=await loadState(env.DB);
  const last=Date.parse(String(state?.fetched_at||""));
  if(!force&&Number.isFinite(last)&&nowMs-last<45*1000){
    return {ok:true,skipped:true,reason:"cadence",live_games:candidates.length,last_fetch_at:state?.fetched_at||null};
  }
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
  let response,text;
  try{
    response=await fetchImpl(LIVE_FEED_URL,{signal:controller.signal,headers:{accept:"application/xml,text/xml,*/*","user-agent":"HOH-NHL-Live-Winline/1.0"}});
    if(!response.ok)throw new Error("Winline live HTTP "+response.status);
    text=await response.text();
  }finally{clearTimeout(timer)}
  const events=parseNhlLiveFeed(text);
  const mapped=mapLiveEvents(events,candidates);
  const persisted=await persistLive(env.DB,mapped,new Date(nowMs).toISOString());
  const payload={
    fetched_at:new Date(nowMs).toISOString(),live_games:candidates.length,feed_events:events.length,mapped_events:mapped.length,
    markets_written:persisted.markets_written,snapshot_rows_written:persisted.snapshot_rows_written,changed_markets:persisted.changed_markets,
    unmapped_events:Math.max(0,events.length-mapped.length)
  };
  await saveState(env.DB,payload);
  return {ok:true,skipped:false,...payload};
}

export function parseNhlLiveFeed(xml){
  const sport=[...String(xml||"").matchAll(/<Sport\b([^>]*)>([\s\S]*?)<\/Sport>/gi)].find(m=>String(attrs(m[1]).Id)==="4");
  if(!sport)return[];
  const out=[];
  for(const cm of sport[2].matchAll(/<Country\b([^>]*)>([\s\S]*?)<\/Country>/gi)){
    for(const tm of cm[2].matchAll(/<Tournament\b([^>]*)>([\s\S]*?)<\/Tournament>/gi)){
      for(const mm of tm[2].matchAll(/<Match\b([^>]*)>([\s\S]*?)<\/Match>/gi)){
        const ma=attrs(mm[1]),team1=triForName(ma.Team1),team2=triForName(ma.Team2);
        if(!ma.Id||!team1||!team2)continue;
        const lines=[...mm[2].matchAll(/<line\b([^>]*)>/gi)].map(x=>attrs(x[1])).filter(hasPricedOutcome);
        if(!lines.length)continue;
        out.push({event_id:String(ma.Id),team1:String(ma.Team1),team2:String(ma.Team2),team1_tri:team1,team2_tri:team2,starts_at:String(ma.MatchDate||""),deeplink:String(ma.MatchUrl||""),lines});
      }
    }
  }
  return out;
}

export function mapLiveEvents(events,games){
  const out=[];
  for(const e of events||[]){
    const candidates=(games||[]).filter(g=>{
      const h=String(g.home_tri||"").toUpperCase(),a=String(g.away_tri||"").toUpperCase();
      return (h===e.team1_tri&&a===e.team2_tri)||(h===e.team2_tri&&a===e.team1_tri);
    });
    if(!candidates.length)continue;
    candidates.sort((a,b)=>liveStateRank(b)-liveStateRank(a)||Math.abs(Date.parse(String(a.scheduled_start_utc||""))-Date.now())-Math.abs(Date.parse(String(b.scheduled_start_utc||""))-Date.now()));
    const g=candidates[0];
    out.push({...e,game_pk:Number(g.game_pk),home_tri:String(g.home_tri),away_tri:String(g.away_tri),team1_is_home:String(g.home_tri)===e.team1_tri});
  }
  return out;
}

async function liveGameCandidates(db,nowIso){
  return (await db.prepare(`
    SELECT game_pk,scheduled_start_utc,game_state,home_tri,away_tri
    FROM games
    WHERE game_type IN (1,2,3)
      AND (game_state IN ('LIVE','CRIT','INTERMISSION')
           OR datetime(scheduled_start_utc) BETWEEN datetime(?,'-4 hours') AND datetime(?,'+30 minutes'))
    ORDER BY datetime(scheduled_start_utc) ASC
    LIMIT 24;
  `).bind(nowIso,nowIso).all()).results||[];
}

async function persistLive(db,items,capturedAt){
  if(!items.length)return {markets_written:0,snapshot_rows_written:0,changed_markets:0};
  const marketStmts=[],eventStmts=[],snapshotStmts=[];let changedMarkets=0;
  for(const item of items){
    const eventRaw=JSON.stringify({source:"live_mainsports_eng",team1:item.team1,team2:item.team2});
    eventStmts.push(db.prepare(`
      INSERT INTO winline_events(winline_event_id,game_pk,status,starts_at,deeplink,raw_json,updated_at)
      VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(winline_event_id) DO UPDATE SET game_pk=excluded.game_pk,status='live',starts_at=COALESCE(NULLIF(excluded.starts_at,''),winline_events.starts_at),deeplink=COALESCE(excluded.deeplink,winline_events.deeplink),raw_json=excluded.raw_json,updated_at=CURRENT_TIMESTAMP;
    `).bind(item.event_id,item.game_pk,"live",item.starts_at||null,item.deeplink||null,eventRaw));
    marketStmts.push(db.prepare(`UPDATE winline_markets SET active=0 WHERE winline_event_id=? AND is_live=1 AND active=1;`).bind(item.event_id));
    const existing=await db.prepare(`SELECT winline_market_id,odds,subject_key,outcome_name,active FROM winline_markets WHERE winline_event_id=? AND is_live=1;`).bind(item.event_id).all();
    const byId=new Map((existing.results||[]).map(x=>[String(x.winline_market_id),x]));
    for(const line of item.lines||[]){
      const base=marketBase(line),defs=marketOutcomes(line,item);
      if(!base||!defs.length)continue;
      for(const o of defs){
        const id=item.event_id+":live:"+base+":"+o.idx,old=byId.get(id);
        const changed=!old||Math.abs(Number(old.odds)-o.odds)>1e-9||String(old.subject_key||"")!==String(o.key||"")||String(old.outcome_name||"")!==o.name||Number(old.active)!==1;
        if(changed)changedMarkets++;
        marketStmts.push(db.prepare(`
          INSERT INTO winline_markets(winline_market_id,winline_event_id,market_type,subject_type,subject_key,outcome_name,odds,deeplink,is_live,active,raw_json,updated_at)
          VALUES(?,?,?,?,?,?,?,?,1,1,?,CURRENT_TIMESTAMP)
          ON CONFLICT(winline_market_id) DO UPDATE SET winline_event_id=excluded.winline_event_id,market_type=excluded.market_type,subject_type=excluded.subject_type,subject_key=excluded.subject_key,outcome_name=excluded.outcome_name,odds=excluded.odds,deeplink=excluded.deeplink,is_live=1,active=1,raw_json=excluded.raw_json,updated_at=CURRENT_TIMESTAMP;
        `).bind(id,item.event_id,base,o.key?"team":"match",o.key,o.name,o.odds,item.deeplink||null,JSON.stringify(line)));
        if(changed){
          snapshotStmts.push(db.prepare(`
            INSERT INTO winline_market_snapshots(game_pk,winline_event_id,winline_market_id,market_type,subject_type,subject_key,outcome_name,odds,deeplink,is_live,captured_at,source_updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,1,?,?);
          `).bind(item.game_pk,item.event_id,id,base,o.key?"team":"match",o.key,o.name,o.odds,item.deeplink||null,capturedAt,capturedAt));
        }
      }
    }
  }
  await runBatches(db,eventStmts);await runBatches(db,marketStmts);await runBatches(db,snapshotStmts);
  return {markets_written:marketStmts.length,snapshot_rows_written:snapshotStmts.length,changed_markets:changedMarkets};
}

function marketBase(line){const name=norm(String(line?.freetext||"market"));if(!name)return null;const value=line?.value!==undefined&&line?.value!==null&&String(line.value)!==""?String(line.value).replace(/[^0-9+.-]/g,""):"";return name+(value?":"+value:"")}
function marketOutcomes(line,item){
  const defs=[["1",line?.name1,line?.odd1],["2",line?.name2,line?.odd2],["3",line?.name3,line?.odd3]],out=[];
  for(const [idx,nameRaw,oddRaw] of defs){
    const odd=Number(oddRaw),name=String(nameRaw||"").trim();if(!name||!Number.isFinite(odd)||odd<=1)continue;
    let key=null;if(name==="1")key=item.team1_tri;else if(name==="2")key=item.team2_tri;else if(/^home$/i.test(name))key=item.home_tri;else if(/^away$/i.test(name))key=item.away_tri;
    out.push({idx,name,key,odds:odd});
  }
  return out;
}
function hasPricedOutcome(line){return [line?.odd1,line?.odd2,line?.odd3].some(v=>Number.isFinite(Number(v))&&Number(v)>1)}
function liveStateRank(g){return LIVE_STATES.has(String(g?.game_state||"").toUpperCase())?1:0}
async function runBatches(db,stmts,size=60){for(let i=0;i<stmts.length;i+=size)await db.batch(stmts.slice(i,i+size))}
function buildNameMap(){const m=new Map();for(const [tri,names] of Object.entries(TEAM_ALIASES))for(const name of names)m.set(norm(name),tri);return m}
function triForName(name){return NAME_TO_TRI.get(norm(name))||null}
function norm(v){return String(v||"").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g,"")}
function decode(v){return String(v||"").replace(/&quot;/g,'"').replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&#39;|&apos;/g,"\'")}
function attrs(tag){return Object.fromEntries([...String(tag||"").matchAll(/([A-Za-z0-9_]+)="([^"]*)"/g)].map(m=>[m[1],decode(m[2])]))}
async function loadState(db){const row=await db.prepare("SELECT meta_value FROM data_core_meta WHERE meta_key=? LIMIT 1").bind(META_KEY).first().catch(()=>null);if(!row?.meta_value)return null;try{return JSON.parse(row.meta_value)}catch{return null}}
async function saveState(db,state){await db.prepare("INSERT INTO data_core_meta(meta_key,meta_value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP").bind(META_KEY,JSON.stringify(state)).run()}
