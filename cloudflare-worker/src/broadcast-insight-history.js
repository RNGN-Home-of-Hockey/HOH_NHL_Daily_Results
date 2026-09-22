export async function archiveBroadcastInsightHistory(db,game,cards){
  if(!db||!game?.game_pk)return {written:0};
  const start=Date.parse(String(game.scheduled_start_utc||""));
  if(Number.isFinite(start)&&Date.now()>=start)return {written:0,skipped:"game_started"};

  const priced=(Array.isArray(cards)?cards:[]).filter(hasRealPrice);
  const stmts=[];
  for(let i=0;i<priced.length;i++){
    const card=priced[i],market=card.market||{};
    const key=historyKey(game.game_pk,card);
    if(!key)continue;
    const rank=i+1,air=finiteInt(card.air_score??card.portfolio_score??card.score);
    stmts.push(db.prepare(`
      INSERT INTO broadcast_insight_history(
        snapshot_key,game_pk,insight_id,category,feature_layer,headline_ru,
        market_type,period,subject,side,line,
        first_odds,latest_odds,first_air_score,max_air_score,
        first_queue_rank,best_queue_rank,top_for_air_seen,evidence_json,
        first_seen_at,last_seen_at,seen_count,outcome_status,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,1,'pending',CURRENT_TIMESTAMP)
      ON CONFLICT(snapshot_key) DO UPDATE SET
        latest_odds=excluded.latest_odds,
        max_air_score=MAX(COALESCE(broadcast_insight_history.max_air_score,0),COALESCE(excluded.max_air_score,0)),
        best_queue_rank=MIN(COALESCE(broadcast_insight_history.best_queue_rank,999),COALESCE(excluded.best_queue_rank,999)),
        top_for_air_seen=MAX(broadcast_insight_history.top_for_air_seen,excluded.top_for_air_seen),
        headline_ru=excluded.headline_ru,
        evidence_json=excluded.evidence_json,
        last_seen_at=CURRENT_TIMESTAMP,
        seen_count=broadcast_insight_history.seen_count+1,
        updated_at=CURRENT_TIMESTAMP;
    `).bind(
      key,Number(game.game_pk),String(card.id||card.insight_type||""),
      String(card.category||card.insight_type||"unknown"),
      String(card?.evidence?.feature_layer||""),
      String(card.broadcast_title||card.title||card.value||"").slice(0,500),
      String(market.type||"unknown"),String(market.period||"GAME"),
      nullable(market.subject),nullable(market.side),finiteNumber(market.line),
      Number(market.odds),Number(market.odds),air,air,rank,rank,
      air!==null&&air>=55&&rank<=3?1:0,
      JSON.stringify(card.evidence||{}).slice(0,12000)
    ));
  }
  for(let i=0;i<stmts.length;i+=40)await db.batch(stmts.slice(i,i+40));
  return {written:stmts.length};
}

export async function settleBroadcastInsightHistory(db,gamePk){
  if(!db||!Number.isSafeInteger(Number(gamePk)))return {settled:0};
  const [game,periods,pending]=await Promise.all([
    db.prepare(`SELECT game_pk,home_tri,away_tri,home_score,away_score,game_state FROM games WHERE game_pk=? LIMIT 1;`).bind(gamePk).first(),
    db.prepare(`SELECT period_number,period_type,home_goals,away_goals FROM period_scores WHERE game_pk=? ORDER BY period_number;`).bind(gamePk).all(),
    db.prepare(`SELECT * FROM broadcast_insight_history WHERE game_pk=? AND outcome_status='pending';`).bind(gamePk).all(),
  ]);
  if(!game||!["FINAL","OFF"].includes(String(game.game_state||"").toUpperCase()))return {settled:0};
  const stmts=[];
  for(const row of pending.results||[]){
    const outcome=evaluateBroadcastInsightOutcome(row,game,periods.results||[]);
    const odds=Number(row.latest_odds);
    const profit=outcome==="win"&&Number.isFinite(odds)?odds-1:outcome==="loss"?-1:0;
    stmts.push(db.prepare(`
      UPDATE broadcast_insight_history
      SET outcome_status=?,profit_units=?,settled_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
      WHERE snapshot_key=? AND outcome_status='pending';
    `).bind(outcome,profit,row.snapshot_key));
  }
  for(let i=0;i<stmts.length;i+=50)await db.batch(stmts.slice(i,i+50));
  return {settled:stmts.length};
}

export function evaluateBroadcastInsightOutcome(row,game,periodRows=[]){
  const type=String(row?.market_type||"").toLowerCase();
  const period=String(row?.period||"GAME").toUpperCase();
  const side=String(row?.side||"").toUpperCase();
  const subject=String(row?.subject||"").toUpperCase();
  const line=finiteNumber(row?.line);

  const scores=scoreForPeriod(game,periodRows,period);
  if(!scores)return "void";
  const home=Number(scores.home),away=Number(scores.away);
  if(!Number.isFinite(home)||!Number.isFinite(away))return "void";
  const subjectScore=subject===String(game.home_tri).toUpperCase()?home:subject===String(game.away_tri).toUpperCase()?away:null;
  const opponentScore=subject===String(game.home_tri).toUpperCase()?away:subject===String(game.away_tri).toUpperCase()?home:null;

  if(type==="moneyline"||/^period_\d+_result$/.test(type)){
    if(side==="DRAW")return home===away?"win":"loss";
    if(subjectScore===null)return "void";
    // Team selections in regulation/period 3-way markets lose on a draw.
    // Full-game moneyline includes OT/SO and therefore should not tie either.
    if(subjectScore===opponentScore)return "loss";
    return subjectScore>opponentScore?"win":"loss";
  }
  if(type==="handicap"){
    if(subjectScore===null||line===null)return "void";
    return compare(subjectScore+line,opponentScore);
  }
  if(type==="game_total"){
    if(line===null)return "void";
    return totalOutcome(home+away,line,side);
  }
  if(type==="team_total"){
    if(subjectScore===null||line===null)return "void";
    return totalOutcome(subjectScore,line,side);
  }
  return "void";
}

export async function broadcastInsightAnalyticsSummary(db){
  const r=await db.prepare(`
    SELECT category,COALESCE(NULLIF(feature_layer,''),category) AS layer,
           COUNT(*) settled,
           SUM(CASE WHEN outcome_status='win' THEN 1 ELSE 0 END) wins,
           SUM(CASE WHEN outcome_status='loss' THEN 1 ELSE 0 END) losses,
           SUM(CASE WHEN outcome_status='push' THEN 1 ELSE 0 END) pushes,
           ROUND(SUM(COALESCE(profit_units,0)),3) profit_units,
           ROUND(AVG(CASE WHEN outcome_status IN ('win','loss') THEN max_air_score END),1) avg_air
    FROM broadcast_insight_history
    WHERE outcome_status<>'pending' AND outcome_status<>'void'
    GROUP BY category,layer
    ORDER BY settled DESC,profit_units DESC;
  `).all();
  return r.results||[];
}

function scoreForPeriod(game,periodRows,period){
  if(period==="GAME")return {home:Number(game.home_score),away:Number(game.away_score)};
  if(period==="REG"){
    const rows=(periodRows||[]).filter(r=>Number(r.period_number)>=1&&Number(r.period_number)<=3);
    if(rows.length<3)return null;
    return {home:rows.reduce((s,r)=>s+Number(r.home_goals||0),0),away:rows.reduce((s,r)=>s+Number(r.away_goals||0),0)};
  }
  const m=/^P([123])$/.exec(period);
  if(!m)return null;
  const row=(periodRows||[]).find(r=>Number(r.period_number)===Number(m[1]));
  return row?{home:Number(row.home_goals),away:Number(row.away_goals)}:null;
}
function totalOutcome(value,line,side){
  if(Math.abs(value-line)<1e-9)return "push";
  if(side==="OVER")return value>line?"win":"loss";
  if(side==="UNDER")return value<line?"win":"loss";
  return "void";
}
function compare(a,b){if(Math.abs(a-b)<1e-9)return"push";return a>b?"win":"loss"}
function hasRealPrice(card){const o=Number(card?.market?.odds);return Number.isFinite(o)&&o>1&&card?.market?.odds_is_demo===false&&card?.market?.odds_source==="provider_live"}
function historyKey(gamePk,card){
  const m=card?.market||{};
  const line=m.line===null||m.line===undefined||m.line===""?"none":Number(m.line).toFixed(2);
  return [gamePk,String(card?.id||card?.insight_type||"insight"),m.type||"unknown",m.period||"GAME",m.subject||"all",m.side||"none",line].join("|").slice(0,700);
}
function finiteNumber(v){if(v===null||v===undefined||v==="")return null;const n=Number(v);return Number.isFinite(n)?n:null}
function finiteInt(v){const n=finiteNumber(v);return n===null?null:Math.round(n)}
function nullable(v){const s=String(v??"").trim();return s||null}
