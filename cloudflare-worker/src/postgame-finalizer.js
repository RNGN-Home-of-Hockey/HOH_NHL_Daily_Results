import { importGame } from "./data-core-importer.js";
import { refreshTeamGameFeatures } from "./team-game-features.js";
import { refreshCurrentTeamSnapshotsRuntime } from "./current-team-snapshot-refresh.js";

const DEFAULT_LIMIT=3;
const MAX_LIMIT=8;
const LOOKBACK_DAYS=7;
const MIN_GAME_AGE_MINUTES=90;

export async function runPostgameFinalizer(env,{limit=DEFAULT_LIMIT}={}){
  if(!env?.DB)return {ok:false,error:"missing_d1_binding"};
  const db=env.DB;
  const n=Math.max(1,Math.min(MAX_LIMIT,Number(limit)||DEFAULT_LIMIT));
  const candidates=await db.prepare(`
    SELECT g.game_pk,g.scheduled_start_utc,g.home_tri,g.away_tri,g.game_state,
           p.ordinary_status,p.features_status,p.odds_status,p.advanced_status,p.next_retry_at
    FROM games g
    LEFT JOIN postgame_ingestion_status p ON p.game_pk=g.game_pk
    WHERE g.game_type IN (2,3)
      AND julianday(g.scheduled_start_utc)>=julianday('now','-${LOOKBACK_DAYS} days')
      AND julianday(g.scheduled_start_utc)<=julianday('now','-${MIN_GAME_AGE_MINUTES} minutes')
      AND (
        p.game_pk IS NULL OR
        COALESCE(p.ordinary_status,'pending')<>'complete' OR
        COALESCE(p.features_status,'pending')<>'complete' OR
        COALESCE(p.odds_status,'pending') NOT IN ('complete','no_data')
      )
      AND (p.next_retry_at IS NULL OR julianday(p.next_retry_at)<=julianday('now'))
    ORDER BY g.scheduled_start_utc ASC,g.game_pk ASC
    LIMIT ?;
  `).bind(n).all();

  let ordinaryCompleted=0,featuresCompleted=0,oddsCompleted=0,errors=0;
  let refreshSnapshots=false;
  const games=[];

  for(const game of candidates.results||[]){
    const gamePk=Number(game.game_pk);
    await ensureStatus(db,gamePk);
    let status=await statusRow(db,gamePk);
    const result={game_pk:gamePk,ordinary:status?.ordinary_status,features:status?.features_status,odds:status?.odds_status,advanced:status?.advanced_status};

    if(!["complete","no_data"].includes(String(status?.odds_status||"pending"))){
      try{
        const odds=await finalizeWinlineLifecycle(db,gamePk);
        await markComponent(db,gamePk,"odds",odds.rows>0?"complete":"no_data",null);
        oddsCompleted+=odds.rows>0?1:0;
        result.odds=odds.rows>0?"complete":"no_data";
        result.odds_rows=odds.rows;
      }catch(error){
        errors++;result.odds="error";result.odds_error=message(error);
        await markComponent(db,gamePk,"odds","error",error);
      }
    }

    status=await statusRow(db,gamePk);
    if(String(status?.ordinary_status)!=="complete"){
      try{
        const imported=await importGame(db,gamePk);
        await markComponent(db,gamePk,"ordinary","complete",null);
        ordinaryCompleted++;
        result.ordinary="complete";
        result.imported_records=imported?.records||null;
      }catch(error){
        errors++;result.ordinary="error";result.ordinary_error=message(error);
        await markComponent(db,gamePk,"ordinary","error",error,{retry:true});
        await updateAdvancedStatus(db,gamePk);
        games.push(result);
        continue;
      }
    }

    status=await statusRow(db,gamePk);
    if(String(status?.features_status)!=="complete"){
      try{
        await refreshTeamGameFeatures(db,gamePk);
        await markComponent(db,gamePk,"features","complete",null);
        featuresCompleted++;
        refreshSnapshots=true;
        result.features="complete";
      }catch(error){
        errors++;result.features="error";result.features_error=message(error);
        await markComponent(db,gamePk,"features","error",error,{retry:true});
      }
    }

    result.advanced=await updateAdvancedStatus(db,gamePk);
    games.push(result);
  }

  const promotedAdvanced=await refreshPendingAdvancedStatuses(db,24);
  if(promotedAdvanced>0)refreshSnapshots=true;
  let snapshots=null;
  if(refreshSnapshots){
    try{snapshots=await refreshCurrentTeamSnapshotsRuntime(db)}
    catch(error){errors++;console.error("postgame current snapshot refresh failed",error)}
  }
  await refreshPostgameMeta(db);

  return {
    ok:errors===0,
    scanned:(candidates.results||[]).length,
    ordinary_completed:ordinaryCompleted,
    features_completed:featuresCompleted,
    odds_completed:oddsCompleted,
    advanced_promoted:promotedAdvanced,
    snapshots,
    errors,
    games,
  };
}

export async function getPostgameIngestionStatus(db,{limit=20}={}){
  const [counts,recent,lifecycle]=await Promise.all([
    db.prepare(`
      SELECT
        COUNT(*) games,
        SUM(CASE WHEN ordinary_status='complete' THEN 1 ELSE 0 END) ordinary_complete,
        SUM(CASE WHEN features_status='complete' THEN 1 ELSE 0 END) features_complete,
        SUM(CASE WHEN odds_status='complete' THEN 1 ELSE 0 END) odds_complete,
        SUM(CASE WHEN odds_status='no_data' THEN 1 ELSE 0 END) odds_no_data,
        SUM(CASE WHEN advanced_status='complete' THEN 1 ELSE 0 END) advanced_complete,
        SUM(CASE WHEN advanced_status='partial' THEN 1 ELSE 0 END) advanced_partial,
        SUM(CASE WHEN advanced_status='pending_external' THEN 1 ELSE 0 END) advanced_pending
      FROM postgame_ingestion_status;
    `).first(),
    db.prepare(`
      SELECT p.*,g.scheduled_start_utc,g.away_tri,g.home_tri,g.game_state
      FROM postgame_ingestion_status p JOIN games g ON g.game_pk=p.game_pk
      ORDER BY g.scheduled_start_utc DESC LIMIT ?;
    `).bind(Math.max(1,Math.min(100,Number(limit)||20))).all(),
    db.prepare(`SELECT COUNT(*) rows,COUNT(DISTINCT game_pk) games,MAX(finalized_at) latest FROM winline_market_lifecycle;`).first(),
  ]);
  return {
    ok:true,
    counts:normalizeCountRow(counts),
    lifecycle:{rows:Number(lifecycle?.rows||0),games:Number(lifecycle?.games||0),latest:lifecycle?.latest||null},
    recent:recent.results||[],
  };
}

export function summarizeWinlineLifecycleRows(rows,startRaw){
  const start=parseUtc(startRaw);
  const byMarket=new Map();
  for(const row of rows||[]){
    const id=String(row?.winline_market_id||"").trim();
    const at=parseUtc(row?.captured_at||row?.updated_at);
    const odds=Number(row?.odds);
    if(!id||!Number.isFinite(at)||!Number.isFinite(odds)||odds<=1)continue;
    if(Number.isFinite(start)&&at>start)continue;
    const item={
      winline_market_id:id,
      winline_event_id:nullable(row?.winline_event_id),
      market_type:String(row?.market_type||"unknown"),
      subject_type:nullable(row?.subject_type),
      subject_key:nullable(row?.subject_key),
      outcome_name:nullable(row?.outcome_name),
      odds,
      at:new Date(at).toISOString(),
    };
    if(!byMarket.has(id))byMarket.set(id,[]);
    byMarket.get(id).push(item);
  }
  const out=[];
  for(const items of byMarket.values()){
    items.sort((a,b)=>a.at.localeCompare(b.at));
    const dedup=[];
    for(const item of items){
      const prev=dedup[dedup.length-1];
      if(prev&&prev.at===item.at&&Math.abs(prev.odds-item.odds)<1e-9)continue;
      dedup.push(item);
    }
    const first=dedup[0],last=dedup[dedup.length-1];
    out.push({
      winline_market_id:first.winline_market_id,
      winline_event_id:last.winline_event_id||first.winline_event_id,
      market_type:last.market_type||first.market_type,
      subject_type:last.subject_type||first.subject_type,
      subject_key:last.subject_key||first.subject_key,
      outcome_name:last.outcome_name||first.outcome_name,
      opening_odds:first.odds,
      opening_at:first.at,
      closing_odds:last.odds,
      closing_at:last.at,
      min_odds:Math.min(...dedup.map(x=>x.odds)),
      max_odds:Math.max(...dedup.map(x=>x.odds)),
      snapshot_count:dedup.length,
      odds_change:Number((last.odds-first.odds).toFixed(6)),
    });
  }
  return out.sort((a,b)=>a.winline_market_id.localeCompare(b.winline_market_id));
}

export function advancedCoverageStatus(rows){
  const list=Array.isArray(rows)?rows:[];
  const full=list.filter(r=>finiteNullable(r?.xgf_5v5)!==null&&finiteNullable(r?.xga_5v5)!==null);
  if(full.length>=2)return "complete";
  if(list.length>0)return "partial";
  return "pending_external";
}

async function finalizeWinlineLifecycle(db,gamePk){
  const game=await db.prepare(`SELECT scheduled_start_utc FROM games WHERE game_pk=? LIMIT 1;`).bind(gamePk).first();
  if(!game)return {rows:0};
  const [snapshots,current]=await Promise.all([
    db.prepare(`
      SELECT winline_market_id,winline_event_id,market_type,subject_type,subject_key,outcome_name,
             odds,captured_at,source_updated_at
      FROM winline_market_snapshots WHERE game_pk=?;
    `).bind(gamePk).all().catch(()=>({results:[]})),
    db.prepare(`
      SELECT m.winline_market_id,m.winline_event_id,m.market_type,m.subject_type,m.subject_key,m.outcome_name,
             m.odds,m.updated_at
      FROM winline_markets m JOIN winline_events e ON e.winline_event_id=m.winline_event_id
      WHERE e.game_pk=? AND m.odds IS NOT NULL;
    `).bind(gamePk).all().catch(()=>({results:[]})),
  ]);
  const rows=[
    ...(snapshots.results||[]),
    ...(current.results||[]).map(r=>({...r,captured_at:r.updated_at})),
  ];
  const lifecycle=summarizeWinlineLifecycleRows(rows,game.scheduled_start_utc);
  if(!lifecycle.length)return {rows:0};
  const stmts=lifecycle.map(x=>db.prepare(`
    INSERT INTO winline_market_lifecycle(
      game_pk,winline_market_id,winline_event_id,market_type,subject_type,subject_key,outcome_name,
      opening_odds,opening_at,closing_odds,closing_at,min_odds,max_odds,snapshot_count,odds_change,finalized_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(game_pk,winline_market_id) DO UPDATE SET
      winline_event_id=excluded.winline_event_id,market_type=excluded.market_type,
      subject_type=excluded.subject_type,subject_key=excluded.subject_key,outcome_name=excluded.outcome_name,
      opening_odds=excluded.opening_odds,opening_at=excluded.opening_at,
      closing_odds=excluded.closing_odds,closing_at=excluded.closing_at,
      min_odds=excluded.min_odds,max_odds=excluded.max_odds,
      snapshot_count=excluded.snapshot_count,odds_change=excluded.odds_change,finalized_at=CURRENT_TIMESTAMP;
  `).bind(
    gamePk,x.winline_market_id,x.winline_event_id,x.market_type,x.subject_type,x.subject_key,x.outcome_name,
    x.opening_odds,x.opening_at,x.closing_odds,x.closing_at,x.min_odds,x.max_odds,x.snapshot_count,x.odds_change
  ));
  for(let i=0;i<stmts.length;i+=50)await db.batch(stmts.slice(i,i+50));
  return {rows:lifecycle.length};
}

async function updateAdvancedStatus(db,gamePk){
  const rows=await db.prepare(`
    SELECT xgf_5v5,xga_5v5 FROM team_game_advanced_features
    WHERE game_pk=? ORDER BY team_tri;
  `).bind(gamePk).all().catch(()=>({results:[]}));
  const status=advancedCoverageStatus(rows.results||[]);
  await db.prepare(`
    UPDATE postgame_ingestion_status
    SET advanced_status=?,
        advanced_completed_at=CASE WHEN ?='complete' THEN COALESCE(advanced_completed_at,CURRENT_TIMESTAMP) ELSE advanced_completed_at END,
        updated_at=CURRENT_TIMESTAMP
    WHERE game_pk=?;
  `).bind(status,status,gamePk).run();
  return status;
}

async function refreshPendingAdvancedStatuses(db,limit){
  const rows=await db.prepare(`
    SELECT p.game_pk
    FROM postgame_ingestion_status p
    WHERE p.advanced_status IN ('pending_external','partial')
    ORDER BY p.updated_at ASC LIMIT ?;
  `).bind(limit).all();
  let promoted=0;
  for(const row of rows.results||[]){
    const before=await statusRow(db,row.game_pk);
    const after=await updateAdvancedStatus(db,Number(row.game_pk));
    if(before?.advanced_status!=="complete"&&after==="complete")promoted++;
  }
  return promoted;
}

async function ensureStatus(db,gamePk){
  await db.prepare(`
    INSERT OR IGNORE INTO postgame_ingestion_status(game_pk,updated_at)
    VALUES(?,CURRENT_TIMESTAMP);
  `).bind(gamePk).run();
  await db.prepare(`
    UPDATE postgame_ingestion_status
    SET attempt_count=attempt_count+1,last_attempt_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
    WHERE game_pk=?;
  `).bind(gamePk).run();
}

async function statusRow(db,gamePk){
  return db.prepare(`SELECT * FROM postgame_ingestion_status WHERE game_pk=? LIMIT 1;`).bind(gamePk).first();
}

async function markComponent(db,gamePk,component,status,error,{retry=false}={}){
  const allowed=new Set(["ordinary","features","odds"]);
  if(!allowed.has(component))throw new Error("invalid postgame component");
  const completedField=component+"_completed_at";
  const nextRetry=retry?"datetime('now','+30 minutes')":"NULL";
  const sql=`
    UPDATE postgame_ingestion_status
    SET ${component}_status=?,
        ${completedField}=CASE WHEN ? IN ('complete','no_data') THEN COALESCE(${completedField},CURRENT_TIMESTAMP) ELSE ${completedField} END,
        last_error=?,
        next_retry_at=${nextRetry},
        updated_at=CURRENT_TIMESTAMP
    WHERE game_pk=?;
  `;
  await db.prepare(sql).bind(status,status,error?message(error):null,gamePk).run();
}

async function refreshPostgameMeta(db){
  const [s,l]=await Promise.all([
    db.prepare(`
      SELECT COUNT(*) games,
             SUM(CASE WHEN ordinary_status='complete' AND features_status='complete' THEN 1 ELSE 0 END) finalized,
             SUM(CASE WHEN advanced_status='pending_external' THEN 1 ELSE 0 END) advanced_pending
      FROM postgame_ingestion_status;
    `).first(),
    db.prepare(`SELECT COUNT(*) rows,COUNT(DISTINCT game_pk) games FROM winline_market_lifecycle;`).first(),
  ]);
  const meta=[
    ["postgame_ingestion.games",String(Number(s?.games||0))],
    ["postgame_ingestion.finalized",String(Number(s?.finalized||0))],
    ["postgame_ingestion.advanced_pending",String(Number(s?.advanced_pending||0))],
    ["winline_market_lifecycle.rows",String(Number(l?.rows||0))],
    ["winline_market_lifecycle.games",String(Number(l?.games||0))],
    ["postgame_ingestion.last_tick_at",new Date().toISOString()],
  ];
  await db.batch(meta.map(([k,v])=>db.prepare(`
    INSERT INTO data_core_meta(meta_key,meta_value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP;
  `).bind(k,v)));
}

function normalizeCountRow(row){
  const out={};for(const [k,v] of Object.entries(row||{}))out[k]=Number(v||0);return out;
}
function parseUtc(value){
  const raw=String(value||"").trim();if(!raw)return NaN;
  const normalized=raw.includes("T")?raw:raw.replace(" ","T")+"Z";
  return Date.parse(normalized);
}
function nullable(v){const x=String(v??"").trim();return x||null}
function finiteNullable(v){if(v===null||v===undefined||v==="")return null;const n=Number(v);return Number.isFinite(n)?n:null}
function message(error){return String(error?.message||error||"unknown_error").slice(0,900)}
