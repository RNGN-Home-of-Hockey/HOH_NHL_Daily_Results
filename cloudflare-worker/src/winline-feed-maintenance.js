const FEED_URL="https://back.winline.ru/banners/prematch_mainsports_eng";
const META_KEY="winline_feed_sync_state";
const MARKET_TYPE="main_1x2_regular";
const MAX_MATCH_DRIFT_MS=90*60*1000;
const SIX_HOURS_MS=6*60*60*1000;
const ONE_HOUR_MS=60*60*1000;
const FIFTEEN_MIN_MS=15*60*1000;

const TEAM_ALIASES={
  ANA:["Anaheim Ducks"],BOS:["Boston Bruins"],BUF:["Buffalo Sabres"],CGY:["Calgary Flames"],
  CAR:["Carolina Hurricanes"],CHI:["Chicago Blackhawks"],COL:["Colorado Avalanche"],CBJ:["Columbus Blue Jackets"],
  DAL:["Dallas Stars"],DET:["Detroit Red Wings"],EDM:["Edmonton Oilers"],FLA:["Florida Panthers"],
  LAK:["Los Angeles Kings"],MIN:["Minnesota Wild"],MTL:["Montreal Canadiens"],NSH:["Nashville Predators"],
  NJD:["New Jersey Devils"],NYI:["New York Islanders"],NYR:["New York Rangers"],OTT:["Ottawa Senators"],
  PHI:["Philadelphia Flyers"],PIT:["Pittsburgh Penguins"],SJS:["San Jose Sharks"],SEA:["Seattle Kraken"],
  STL:["St. Louis Blues","St Louis Blues"],TBL:["Tampa Bay Lightning"],TOR:["Toronto Maple Leafs"],
  UTA:["Utah Mammoth","Utah Hockey Club"],VAN:["Vancouver Canucks"],VGK:["Vegas Golden Knights"],
  WSH:["Washington Capitals"],WPG:["Winnipeg Jets"]
};
const NAME_TO_TRI=buildNameMap();

export async function runWinlineFeedMaintenance(env,{force=false,nowMs=Date.now()}={}){
  if(!env?.DB)return {ok:false,error:"missing_d1_binding"};
  const now=new Date(nowMs);
  const next=await nextUpcomingGame(env.DB,now.toISOString());
  const cadenceMs=cadenceFor(next?.scheduled_start_utc,nowMs);
  const state=await loadState(env.DB);
  const lastAt=Date.parse(String(state?.fetched_at||""));
  const retryUnmapped=Number(state?.mapped_events||0)===0&&Number(state?.unmapped_events||0)>0;
  const due=force||retryUnmapped||!Number.isFinite(lastAt)||nowMs-lastAt>=cadenceMs;
  if(!due){
    return {ok:true,skipped:true,reason:"cadence",cadence_minutes:Math.round(cadenceMs/60000),next_game:next||null,last_fetch_at:state?.fetched_at||null,next_due_at:new Date(lastAt+cadenceMs).toISOString()};
  }

  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);
  let response,text;
  try{
    response=await fetch(FEED_URL,{signal:controller.signal,headers:{accept:"application/xml,text/xml,*/*","user-agent":"HOH-NHL-Center Winline ingest/1.0"}});
    if(!response.ok)throw new Error("Winline HTTP "+response.status);
    text=await response.text();
  }finally{clearTimeout(timer)}

  const feedBytes=new TextEncoder().encode(text).length;
  const events=parseNhlPrematch(text);
  let mapped=await mapEventsToGames(env.DB,events);
  let nhlFallbackGames=0;
  if(mapped.unmatched.length){
    nhlFallbackGames=await ensureNhlGamesForEvents(env.DB,mapped.unmatched);
    if(nhlFallbackGames>0)mapped=await mapEventsToGames(env.DB,events);
  }
  const result=await persistMapped(env.DB,mapped.matched,now.toISOString());
  const finishedAt=new Date().toISOString();
  const payload={
    fetched_at:finishedAt,
    cadence_minutes:Math.round(cadenceMs/60000),
    feed_bytes:feedBytes,
    feed_events:events.length,
    mapped_events:mapped.matched.length,
    unmapped_events:mapped.unmatched.length,
    unmapped:mapped.unmatched.slice(0,20),
    nhl_fallback_games:nhlFallbackGames,
    events_written:result.events_written,
    markets_written:result.markets_written,
    snapshot_rows_written:result.snapshot_rows_written,
    changed_games:result.changed_games,
    unchanged_games:result.unchanged_games,
    next_game:next||null
  };
  await saveState(env.DB,payload);
  return {ok:true,skipped:false,...payload};
}

export async function getWinlineFeedMaintenanceStatus(env){
  if(!env?.DB)return {ok:false,error:"missing_d1_binding"};
  const state=await loadState(env.DB);
  const next=await nextUpcomingGame(env.DB,new Date().toISOString());
  const cadenceMs=cadenceFor(next?.scheduled_start_utc,Date.now());
  const lastAt=Date.parse(String(state?.fetched_at||""));
  return {
    ok:true,
    feed_url:FEED_URL,
    cadence_minutes:Math.round(cadenceMs/60000),
    next_game:next||null,
    last_sync:state||null,
    next_due_at:Number.isFinite(lastAt)?new Date(lastAt+cadenceMs).toISOString():null
  };
}

function cadenceFor(startRaw,nowMs){
  const start=Date.parse(String(startRaw||""));
  if(!Number.isFinite(start))return SIX_HOURS_MS;
  const left=start-nowMs;
  if(left>SIX_HOURS_MS)return SIX_HOURS_MS;
  if(left>ONE_HOUR_MS)return ONE_HOUR_MS;
  if(left>0)return FIFTEEN_MIN_MS;
  return FIFTEEN_MIN_MS;
}

async function nextUpcomingGame(db,nowIso){
  return db.prepare(`
    SELECT game_pk,scheduled_start_utc,home_tri,away_tri,game_type,game_state
    FROM games
    WHERE game_type IN (1,2,3) AND scheduled_start_utc>?
    ORDER BY scheduled_start_utc ASC LIMIT 1;
  `).bind(nowIso).first().catch(()=>null);
}

function parseNhlPrematch(xml){
  const sport=[...String(xml||"").matchAll(/<Sport\b([^>]*)>([\s\S]*?)<\/Sport>/gi)].find(m=>String(attrs(m[1]).Id)==="4");
  if(!sport)return [];
  const out=[];
  for(const cm of sport[2].matchAll(/<Country\b([^>]*)>([\s\S]*?)<\/Country>/gi)){
    for(const tm of cm[2].matchAll(/<Tournament\b([^>]*)>([\s\S]*?)<\/Tournament>/gi)){
      const ta=attrs(tm[1]);
      for(const mm of tm[2].matchAll(/<Match\b([^>]*)>([\s\S]*?)<\/Match>/gi)){
        const ma=attrs(mm[1]);
        // Winline may place NHL preseason under a non-"NHL" tournament label.
        // Team identity is the reliable discriminator.
        if(!triForName(ma.Team1)||!triForName(ma.Team2))continue;
        const lines=[...mm[2].matchAll(/<line\b([^>]*)>/gi)].map(x=>attrs(x[1]));
        const three=lines.find(x=>/^3-way odds$/i.test(String(x.freetext||"").trim()))||
                    lines.find(x=>/3.?way|1x2/i.test(String(x.freetext||"")));
        const p1=Number(three?.odd1),draw=Number(three?.odd2),p2=Number(three?.odd3);
        if(!ma.Id||!ma.Team1||!ma.Team2||!ma.MatchDate||![p1,draw,p2].every(x=>Number.isFinite(x)&&x>1))continue;
        out.push({
          event_id:String(ma.Id),bid:String(ma.BID||""),team1:String(ma.Team1),team2:String(ma.Team2),
          team1_id:String(ma.Id1||""),team2_id:String(ma.Id2||""),starts_at:String(ma.MatchDate),
          deeplink:String(ma.MatchUrl||""),p1,draw,p2,lines,tournament_id:String(ta.Id||""),tournament_name:String(ta.Name||"")
        });
      }
    }
  }
  return out;
}

async function mapEventsToGames(db,events){
  if(!events.length)return {matched:[],unmatched:[]};
  const starts=events.map(x=>Date.parse(x.starts_at)).filter(Number.isFinite);
  const min=new Date(Math.min(...starts)-3*60*60*1000).toISOString();
  const max=new Date(Math.max(...starts)+3*60*60*1000).toISOString();
  const rows=await db.prepare(`
    SELECT game_pk,scheduled_start_utc,home_tri,away_tri,game_type,game_state
    FROM games WHERE game_type IN (1,2,3) AND scheduled_start_utc BETWEEN ? AND ?
    ORDER BY scheduled_start_utc ASC;
  `).bind(min,max).all();
  const games=rows.results||[],matched=[],unmatched=[];
  for(const event of events){
    const t1=triForName(event.team1),t2=triForName(event.team2),wt=Date.parse(event.starts_at);
    if(!t1||!t2||!Number.isFinite(wt)){unmatched.push({...event,reason:"team_or_time"});continue}
    const candidates=[];
    for(const g of games){
      const gt=Date.parse(String(g.scheduled_start_utc||""));if(!Number.isFinite(gt))continue;
      const direct=g.home_tri===t1&&g.away_tri===t2,reverse=g.home_tri===t2&&g.away_tri===t1;
      const diff=Math.abs(gt-wt);
      if((direct||reverse)&&diff<=MAX_MATCH_DRIFT_MS)candidates.push({g,diff,direct});
    }
    candidates.sort((a,b)=>a.diff-b.diff);
    const best=candidates[0];
    if(!best){unmatched.push({...event,reason:"no_game_match",team1_tri:t1,team2_tri:t2});continue}
    matched.push({...event,game_pk:Number(best.g.game_pk),home_tri:best.g.home_tri,away_tri:best.g.away_tri,scheduled_start_utc:best.g.scheduled_start_utc,time_diff_minutes:Math.round(best.diff/60000),team1_is_home:Boolean(best.direct)});
  }
  return {matched,unmatched};
}

async function ensureNhlGamesForEvents(db,events){
  if(!events.length)return 0;
  const days=new Set();
  for(const event of events){
    const t=Date.parse(String(event.starts_at||""));if(!Number.isFinite(t))continue;
    for(const offset of [-1,0,1])days.add(new Date(t+offset*86400000).toISOString().slice(0,10));
  }
  const unique=new Map();
  await Promise.all([...days].map(async day=>{
    try{
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
      try{
        const r=await fetch("https://api-web.nhle.com/v1/schedule/"+day,{signal:controller.signal,headers:{accept:"application/json","user-agent":"HOH-Winline-NHL-map/1.0"}});
        if(!r.ok)return;
        const d=await r.json();
        for(const week of Array.isArray(d?.gameWeek)?d.gameWeek:[]){
          for(const g of Array.isArray(week?.games)?week.games:[])if(g?.id)unique.set(Number(g.id),g);
        }
      }finally{clearTimeout(timer)}
    }catch{}
  }));
  const needed=new Map();
  for(const event of events){
    const t1=triForName(event.team1),t2=triForName(event.team2),wt=Date.parse(String(event.starts_at||""));
    if(!t1||!t2||!Number.isFinite(wt))continue;
    let best=null;
    for(const g of unique.values()){
      const home=String(g?.homeTeam?.abbrev||"").toUpperCase(),away=String(g?.awayTeam?.abbrev||"").toUpperCase(),gt=Date.parse(String(g?.startTimeUTC||""));
      if(!Number.isFinite(gt))continue;
      const same=(home===t1&&away===t2)||(home===t2&&away===t1),diff=Math.abs(gt-wt);
      if(same&&diff<=MAX_MATCH_DRIFT_MS&&(!best||diff<best.diff))best={g,diff};
    }
    if(best)needed.set(Number(best.g.id),best.g);
  }
  if(!needed.size)return 0;
  const stmts=[];
  for(const g of needed.values()){
    const game=normalizeNhlGame(g);if(!game)continue;
    stmts.push(db.prepare(`
      INSERT INTO games(game_pk,season_id,game_type,scheduled_start_utc,game_state,home_tri,away_tri,home_score,away_score,current_period,period_type,venue_name,last_synced_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(game_pk) DO UPDATE SET
        season_id=excluded.season_id,game_type=excluded.game_type,scheduled_start_utc=excluded.scheduled_start_utc,
        game_state=excluded.game_state,home_tri=excluded.home_tri,away_tri=excluded.away_tri,
        home_score=excluded.home_score,away_score=excluded.away_score,current_period=excluded.current_period,
        period_type=excluded.period_type,venue_name=COALESCE(excluded.venue_name,games.venue_name),last_synced_at=CURRENT_TIMESTAMP;
    `).bind(game.game_pk,game.season_id,game.game_type,game.scheduled_start_utc,game.game_state,game.home_tri,game.away_tri,game.home_score,game.away_score,game.current_period,game.period_type,game.venue_name));
  }
  if(stmts.length)await db.batch(stmts);
  return stmts.length;
}

function normalizeNhlGame(g){
  const id=Number(g?.id),home=String(g?.homeTeam?.abbrev||"").toUpperCase(),away=String(g?.awayTeam?.abbrev||"").toUpperCase(),start=String(g?.startTimeUTC||"");
  if(!Number.isSafeInteger(id)||!home||!away||!start)return null;
  const num=v=>v===null||v===undefined||v===""?null:Number.isFinite(Number(v))?Number(v):null;
  const localized=v=>typeof v==="string"?v:(v?.default||v?.en||null);
  return {game_pk:id,season_id:String(g?.season||""),game_type:num(g?.gameType),scheduled_start_utc:start,game_state:String(g?.gameState||"FUT").toUpperCase(),home_tri:home,away_tri:away,home_score:num(g?.homeTeam?.score)??0,away_score:num(g?.awayTeam?.score)??0,current_period:num(g?.periodDescriptor?.number),period_type:g?.periodDescriptor?.periodType||g?.gameOutcome?.lastPeriodType||null,venue_name:localized(g?.venue)};
}

async function persistMapped(db,items,capturedAt){
  if(!items.length)return {events_written:0,markets_written:0,snapshot_rows_written:0,changed_games:0,unchanged_games:0};
  const eventIds=items.map(x=>x.event_id);
  const placeholders=eventIds.map(()=>"?").join(",");
  const [eventRows,marketRows]=await Promise.all([
    db.prepare(`SELECT winline_event_id,game_pk,status,starts_at,deeplink FROM winline_events WHERE winline_event_id IN (${placeholders});`).bind(...eventIds).all(),
    db.prepare(`SELECT winline_market_id,winline_event_id,market_type,subject_type,subject_key,outcome_name,odds,deeplink,is_live,active,raw_json FROM winline_markets WHERE winline_event_id IN (${placeholders});`).bind(...eventIds).all()
  ]);
  const existingEvents=new Map((eventRows.results||[]).map(x=>[String(x.winline_event_id),x]));
  const existingMarkets=new Map((marketRows.results||[]).map(x=>[String(x.winline_market_id),x]));
  const eventStmts=[],marketStmts=[],snapshotStmts=[];
  let changedGames=0,unchangedGames=0;

  for(const item of items){
    let gameChanged=false;
    const oldEvent=existingEvents.get(item.event_id);
    const eventRaw=JSON.stringify({source:"prematch_mainsports_eng",bid:item.bid,team1_id:item.team1_id,team2_id:item.team2_id,team1:item.team1,team2:item.team2});
    eventStmts.push(db.prepare(`
      INSERT INTO winline_events(winline_event_id,game_pk,status,starts_at,deeplink,raw_json,updated_at)
      VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(winline_event_id) DO UPDATE SET game_pk=excluded.game_pk,status=excluded.status,starts_at=excluded.starts_at,deeplink=excluded.deeplink,raw_json=excluded.raw_json,updated_at=CURRENT_TIMESTAMP;
    `).bind(item.event_id,item.game_pk,"prematch",item.starts_at,item.deeplink||null,eventRaw));

    // A successful feed fetch is also a freshness confirmation. First deactivate the
    // previous event market set; every line still present below is reactivated and
    // receives a fresh updated_at even when its price did not move.
    marketStmts.push(db.prepare(`
      UPDATE winline_markets SET active=0
      WHERE winline_event_id=? AND active=1;
    `).bind(item.event_id));

    // Preserve every Winline line in current-state storage.
    for(const line of item.lines||[]){
      const base=fullMarketBase(line),defs=fullMarketOutcomes(line,item);
      if(!base||!defs.length)continue;
      let groupChanged=false;
      for(const o of defs){
        const id=item.event_id+":"+base+":"+o.idx,old=existingMarkets.get(id);
        const changed=!old||Math.abs(Number(old.odds)-o.odds)>1e-9||String(old.subject_key||"")!==String(o.key||"")||String(old.outcome_name||"")!==String(o.name||"")||Number(old.active)!==1||Number(old.is_live)!==0;
        if(changed){groupChanged=true;gameChanged=true}
        marketStmts.push(db.prepare(`
          INSERT INTO winline_markets(winline_market_id,winline_event_id,market_type,subject_type,subject_key,outcome_name,odds,deeplink,is_live,active,raw_json,updated_at)
          VALUES(?,?,?,?,?,?,?,?,0,1,?,CURRENT_TIMESTAMP)
          ON CONFLICT(winline_market_id) DO UPDATE SET winline_event_id=excluded.winline_event_id,market_type=excluded.market_type,subject_type=excluded.subject_type,subject_key=excluded.subject_key,outcome_name=excluded.outcome_name,odds=excluded.odds,deeplink=excluded.deeplink,is_live=0,active=1,raw_json=excluded.raw_json,updated_at=CURRENT_TIMESTAMP;
        `).bind(id,item.event_id,base,o.key?"team":"match",o.key,o.name,o.odds,item.deeplink||null,JSON.stringify(line)));
      }
      if(groupChanged){
        for(const o of defs){
          const id=item.event_id+":"+base+":"+o.idx;
          snapshotStmts.push(db.prepare(`
            INSERT INTO winline_market_snapshots(game_pk,winline_event_id,winline_market_id,market_type,subject_type,subject_key,outcome_name,odds,deeplink,is_live,captured_at,source_updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,0,?,?);
          `).bind(item.game_pk,item.event_id,id,base,o.key?"team":"match",o.key,o.name,o.odds,item.deeplink||null,capturedAt,capturedAt));
        }
      }
    }

    // Stable canonical ids are consumed by the current match/broadcast UI.
    const outcomeDefs=item.team1_is_home
      ?[{suffix:"1",name:"1",key:item.home_tri,odds:item.p1},{suffix:"X",name:"X",key:null,odds:item.draw},{suffix:"2",name:"2",key:item.away_tri,odds:item.p2}]
      :[{suffix:"1",name:"1",key:item.away_tri,odds:item.p1},{suffix:"X",name:"X",key:null,odds:item.draw},{suffix:"2",name:"2",key:item.home_tri,odds:item.p2}];
    let canonicalChanged=false;
    for(const o of outcomeDefs){
      const id=item.event_id+":main_1x2:"+o.suffix,old=existingMarkets.get(id);
      const changed=!old||Math.abs(Number(old.odds)-o.odds)>1e-9||String(old.subject_key||"")!==String(o.key||"")||Number(old.active)!==1||Number(old.is_live)!==0;
      if(changed){canonicalChanged=true;gameChanged=true}
      marketStmts.push(db.prepare(`
        INSERT INTO winline_markets(winline_market_id,winline_event_id,market_type,subject_type,subject_key,outcome_name,odds,deeplink,is_live,active,raw_json,updated_at)
        VALUES(?,?,?,?,?,?,?,?,0,1,NULL,CURRENT_TIMESTAMP)
        ON CONFLICT(winline_market_id) DO UPDATE SET winline_event_id=excluded.winline_event_id,market_type=excluded.market_type,subject_type=excluded.subject_type,subject_key=excluded.subject_key,outcome_name=excluded.outcome_name,odds=excluded.odds,deeplink=excluded.deeplink,is_live=0,active=1,updated_at=CURRENT_TIMESTAMP;
      `).bind(id,item.event_id,MARKET_TYPE,o.key?"team":"match",o.key,o.name,o.odds,item.deeplink||null));
    }
    if(canonicalChanged){
      for(const o of outcomeDefs){
        const id=item.event_id+":main_1x2:"+o.suffix;
        snapshotStmts.push(db.prepare(`
          INSERT INTO winline_market_snapshots(game_pk,winline_event_id,winline_market_id,market_type,subject_type,subject_key,outcome_name,odds,deeplink,is_live,captured_at,source_updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,0,?,?);
        `).bind(item.game_pk,item.event_id,id,MARKET_TYPE,o.key?"team":"match",o.key,o.name,o.odds,item.deeplink||null,capturedAt,capturedAt));
      }
    }

    if(gameChanged)changedGames++;else unchangedGames++;
  }

  await runStatementBatches(db,eventStmts);
  await runStatementBatches(db,marketStmts);
  await runStatementBatches(db,snapshotStmts);
  return {events_written:eventStmts.length,markets_written:marketStmts.length,snapshot_rows_written:snapshotStmts.length,changed_games:changedGames,unchanged_games:unchangedGames};
}

function fullMarketBase(line){
  const name=norm(String(line?.freetext||"market"));
  if(!name)return null;
  const value=line?.value!==undefined&&line?.value!==null&&String(line.value)!==""?String(line.value).replace(/[^0-9+.-]/g,""):"";
  return name+(value?":"+value:"");
}
function fullMarketOutcomes(line,item){
  const defs=[["1",line?.name1,line?.odd1],["2",line?.name2,line?.odd2],["3",line?.name3,line?.odd3]],out=[];
  for(const [idx,nameRaw,oddRaw] of defs){
    const odd=Number(oddRaw),name=String(nameRaw||"").trim();
    if(!name||!Number.isFinite(odd)||odd<=1)continue;
    let key=null;
    if(name==="1")key=triForName(item.team1);
    else if(name==="2")key=triForName(item.team2);
    else if(/^home$/i.test(name))key=item.home_tri;
    else if(/^away$/i.test(name))key=item.away_tri;
    out.push({idx,name,key,odds:odd});
  }
  return out;
}
async function runStatementBatches(db,stmts,size=60){
  for(let i=0;i<stmts.length;i+=size)await db.batch(stmts.slice(i,i+size));
}

function buildNameMap(){
  const m=new Map();
  for(const [tri,names] of Object.entries(TEAM_ALIASES))for(const name of names)m.set(norm(name),tri);
  return m;
}
function triForName(name){return NAME_TO_TRI.get(norm(name))||null}
function norm(v){return String(v||"").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g,"")}
function decode(v){return String(v||"").replace(/&quot;/g,'"').replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&#39;|&apos;/g,"'")}
function attrs(tag){return Object.fromEntries([...String(tag||"").matchAll(/([A-Za-z0-9_]+)="([^"]*)"/g)].map(m=>[m[1],decode(m[2])]))}

async function loadState(db){
  const row=await db.prepare("SELECT meta_value FROM data_core_meta WHERE meta_key=? LIMIT 1").bind(META_KEY).first().catch(()=>null);
  if(!row?.meta_value)return null;try{return JSON.parse(row.meta_value)}catch{return null}
}
async function saveState(db,state){
  await db.prepare("INSERT INTO data_core_meta(meta_key,meta_value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP").bind(META_KEY,JSON.stringify(state)).run();
}
