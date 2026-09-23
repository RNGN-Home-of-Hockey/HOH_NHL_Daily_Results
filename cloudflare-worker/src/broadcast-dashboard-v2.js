import { buildBettingInsights } from "./betting-insight-engine.js";
import { WINLINE_LOGO_PNG_BASE64 } from "./winline-logo.js";
import { BROADCAST_CARD_CSS } from "./broadcast-card-theme.js";
import { archiveBroadcastInsightHistory } from "./broadcast-insight-history.js";
import { summarizeMarketCoverage } from "./market-coverage-audit.js";
import { selectBroadcastFour } from "./broadcast-four-card-selector.js";
import { buildCommentatorBrief } from "./commentator-brief.js";

const BROADCAST_PATH = "/broadcast";

export async function handleBroadcastRequest(request, env, path) {
  if (path === "/broadcast/winline-logo.png") {
    if (request.method !== "GET") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
    return pngResponse(WINLINE_LOGO_PNG_BASE64);
  }
  if (path === "/broadcast/card-template.webp" || path === "/broadcast/sofia-sans-condensed-italic.woff2") {
    if (request.method !== "GET") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
    if (!env.ASSETS) return jsonResponse({ ok: false, error: "assets_binding_missing" }, 503);
    return env.ASSETS.fetch(request);
  }
  if (path === "/broadcast/app.js") {
    if (request.method !== "GET") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
    const rendererBase=String(env.BROADCAST_RENDERER_URL||"https://hoh-broadcast-renderer.vercel.app").replace(/\/+$/,"");
    return jsResponse(`const __name=(target,value)=>target;\nconst HOH_RENDERER_BASE=${JSON.stringify(rendererBase)};\n(${browserApp.toString()})();`);
  }

  if (path === BROADCAST_PATH) {
    if (request.method !== "GET") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
    return htmlResponse(DASHBOARD_HTML);
  }

  if (path === "/api/broadcast/games") {
    if (request.method !== "GET") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
    return broadcastGamesRoute(env);
  }

  if (path === "/api/broadcast/state") {
    if (request.method !== "GET") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
    return broadcastStateRoute(request, env);
  }

  const summaryMatch = /^\/api\/broadcast\/queue-summary\/(\d+)$/.exec(path);
  if (summaryMatch) {
    if (request.method !== "GET") return jsonResponse({ ok:false,error:"method_not_allowed" },405);
    return broadcastQueueSummaryRoute(env,Number(summaryMatch[1]));
  }

  const gameMatch = /^\/api\/broadcast\/games\/(\d+)$/.exec(path);
  if (gameMatch) {
    if (request.method !== "GET") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
    return broadcastGameRoute(env, Number(gameMatch[1]));
  }

  return null;
}

async function broadcastGamesRoute(env) {
  if (!env.DB) return jsonResponse({ ok: false, error: "missing_d1_binding" }, 503);
  try {
    const [gamesResult, countsRow] = await Promise.all([
      env.DB.prepare(`
        SELECT g.game_pk,g.season_id,g.game_type,g.scheduled_start_utc,g.game_state,
               g.home_tri,g.away_tri,g.home_score,g.away_score,g.current_period,g.period_type,g.venue_name,
               ht.name_en AS home_name,ht.name_ru AS home_name_ru,ht.logo_url AS home_logo,
               at.name_en AS away_name,at.name_ru AS away_name_ru,at.logo_url AS away_logo,
               bol.operator_name,bol.operator_id,bol.expires_at AS operator_expires_at,
               onair.card_id AS on_air_card_id,
               bqs.strong_count,bqs.priced_count,bqs.total_count,bqs.top_air_score,
               bqs.generated_at AS queue_summary_generated_at
        FROM games g
        LEFT JOIN teams ht ON ht.tri_code=g.home_tri
        LEFT JOIN teams at ON at.tri_code=g.away_tri
        LEFT JOIN broadcast_operator_leases bol ON bol.game_pk=g.game_pk AND datetime(bol.expires_at)>datetime('now')
        LEFT JOIN broadcast_cards onair ON onair.game_pk=g.game_pk AND onair.status='shown'
        LEFT JOIN broadcast_queue_summaries bqs ON bqs.game_pk=g.game_pk
        WHERE g.game_type IN (1,2,3)
          AND (
            UPPER(COALESCE(g.game_state,'')) IN ('LIVE','CRIT')
            OR datetime(g.scheduled_start_utc) >= datetime('now')
          )
        ORDER BY datetime(g.scheduled_start_utc) ASC, g.game_pk ASC
        LIMIT 100;
      `).all(),
      env.DB.prepare(`
        SELECT
          (SELECT COUNT(*) FROM games
            WHERE game_type IN (1,2,3)
              AND (
                UPPER(COALESCE(game_state,'')) IN ('LIVE','CRIT')
                OR datetime(scheduled_start_utc) >= datetime('now')
              )
          ) AS games,
          (SELECT COUNT(*) FROM players) AS players,
          (SELECT COUNT(*) FROM teams) AS teams;
      `).first(),
    ]);
    return jsonResponse({
      ok:true,
      counts:{
        games:Number(countsRow?.games||0),
        players:Number(countsRow?.players||0),
        teams:Number(countsRow?.teams||0),
      },
      games:gamesResult.results||[],
    });
  } catch (error) {
    console.error("broadcast games failed", error);
    return jsonResponse({ ok:false, error:"broadcast_games_failed" }, 500);
  }
}

async function broadcastQueueSummaryRoute(env,gamePk){
  if(!env.DB)return jsonResponse({ok:false,error:"missing_d1_binding"},503);
  if(!Number.isSafeInteger(gamePk)||gamePk<=0)return jsonResponse({ok:false,error:"invalid_game_pk"},400);
  try{
    const [game,cached]=await Promise.all([
      env.DB.prepare(`
        SELECT game_pk,season_id,game_type,scheduled_start_utc,game_state,home_tri,away_tri,home_score,away_score
        FROM games WHERE game_pk=? AND game_type IN (1,2,3) LIMIT 1;
      `).bind(gamePk).first(),
      env.DB.prepare(`
        SELECT game_pk,strong_count,priced_count,total_count,top_air_score,generated_at
        FROM broadcast_queue_summaries WHERE game_pk=? LIMIT 1;
      `).bind(gamePk).first(),
    ]);
    if(!game)return jsonResponse({ok:false,error:"game_not_found"},404);
    const live=["LIVE","CRIT"].includes(String(game.game_state||"").toUpperCase());
    const maxAgeMs=live?45_000:5*60_000;
    const generatedAt=Date.parse(String(cached?.generated_at||"").replace(" ","T")+"Z");
    if(cached&&Number.isFinite(generatedAt)&&(Date.now()-generatedAt)<maxAgeMs){
      return jsonResponse({ok:true,cached:true,summary:normalizeQueueSummary(cached)});
    }
    const summary=await computeBroadcastQueueSummary(env.DB,game);
    await persistBroadcastQueueSummary(env.DB,gamePk,summary);
    return jsonResponse({ok:true,cached:false,summary:{...summary,game_pk:gamePk,generated_at:new Date().toISOString()}});
  }catch(error){
    console.error("broadcast queue summary failed",error);
    return jsonResponse({ok:false,error:"broadcast_queue_summary_failed"},500);
  }
}

async function computeBroadcastQueueSummary(db,game){
  let providerMarkets=[];
  try{providerMarkets=await loadBroadcastWinlineMarkets(db,game)}catch{}
  const statisticalInsights=await buildBettingInsights(db,game);
  let cards=statisticalInsights||[];
  if(providerMarkets.length){
    const pricedInsights=await buildBettingInsights(db,game,{
      provider_markets:providerMarkets,
      market_max_age_ms:broadcastWinlineMaxAgeMs(game),
    });
    cards=mergeBroadcastInsights(statisticalInsights,pricedInsights);
  }else{
    cards=cards.map(stripDemoPrice);
  }
  try{await archiveBroadcastInsightHistory(db,game,cards)}catch(error){console.error("broadcast insight history archive failed",error)}
  return summarizeBroadcastQueueCards(cards);
}

export function summarizeBroadcastQueueCards(cards){
  const list=Array.isArray(cards)?cards:[];
  const priced=list.filter(isRealBroadcastPrice);
  const strong=priced.filter(c=>Number(c?.air_score)>=55);
  const top=strong.reduce((m,c)=>Math.max(m,Number(c?.air_score)||0),0);
  return {
    strong_count:strong.length,
    priced_count:priced.length,
    total_count:list.length,
    top_air_score:top||null,
  };
}
function isRealBroadcastPrice(card){
  const odds=Number(card?.market?.odds);
  return Number.isFinite(odds)&&odds>1&&card?.market?.odds_is_demo===false&&card?.market?.odds_source==="provider_live";
}
async function persistBroadcastQueueSummary(db,gamePk,summary){
  try{
    await db.prepare(`
      INSERT INTO broadcast_queue_summaries(game_pk,strong_count,priced_count,total_count,top_air_score,generated_at)
      VALUES(?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(game_pk) DO UPDATE SET
        strong_count=excluded.strong_count,
        priced_count=excluded.priced_count,
        total_count=excluded.total_count,
        top_air_score=excluded.top_air_score,
        generated_at=CURRENT_TIMESTAMP;
    `).bind(
      gamePk,
      Number(summary?.strong_count||0),
      Number(summary?.priced_count||0),
      Number(summary?.total_count||0),
      summary?.top_air_score==null?null:Number(summary.top_air_score),
    ).run();
  }catch(error){
    console.error("broadcast queue summary persist failed",error);
  }
}
function normalizeQueueSummary(row){
  return {
    game_pk:Number(row?.game_pk||0),
    strong_count:Number(row?.strong_count||0),
    priced_count:Number(row?.priced_count||0),
    total_count:Number(row?.total_count||0),
    top_air_score:row?.top_air_score==null?null:Number(row.top_air_score),
    generated_at:row?.generated_at||null,
  };
}

async function broadcastStateRoute(request, env) {
  if (!env.DB) return jsonResponse({ ok:false, error:"missing_d1_binding" },503);
  try {
    const url=new URL(request.url);
    const requested=Number(url.searchParams.get("game")||0);
    const gamePk=Number.isSafeInteger(requested)&&requested>0?requested:null;
    const sql=`
      SELECT bc.card_id,bc.game_pk,bc.headline_ru,bc.stat_text_ru,bc.source_note_ru,bc.shown_at,bc.status,
             bc.suggested_market_type,bc.suggested_market_subject,bc.manual_odds,bc.odds_is_demo,bc.payload_json,
             bc.render_hash,bc.render_bytes,bc.rendered_at,
             g.home_tri,g.away_tri,
             ht.name_ru AS home_name_ru,ht.name_en AS home_name,ht.logo_url AS home_logo,
             at.name_ru AS away_name_ru,at.name_en AS away_name,at.logo_url AS away_logo
      FROM broadcast_cards bc
      LEFT JOIN games g ON g.game_pk=bc.game_pk
      LEFT JOIN teams ht ON ht.tri_code=g.home_tri
      LEFT JOIN teams at ON at.tri_code=g.away_tri
      WHERE bc.status='shown'${gamePk?" AND bc.game_pk=?":""}
      ORDER BY bc.shown_at DESC,bc.updated_at DESC
      LIMIT 1;
    `;
    const stmt=env.DB.prepare(sql);
    const shown=gamePk?await stmt.bind(gamePk).first():await stmt.first();
    return jsonResponse({ ok:true, scope:{game_pk:gamePk}, on_air:shown||null });
  } catch (error) {
    console.error("broadcast state failed", error);
    return jsonResponse({ ok:false, error:"broadcast_state_failed" },500);
  }
}
async function broadcastGameRoute(env, gamePk) {
  if (!env.DB) return jsonResponse({ ok:false, error:"missing_d1_binding" },503);
  if (!Number.isSafeInteger(gamePk) || gamePk<=0) return jsonResponse({ ok:false,error:"invalid_game_pk" },400);
  let routeStage="init";
  try {
    routeStage="game_lookup";
    const game = await env.DB.prepare(`
      SELECT g.*,ht.name_en AS home_name,ht.name_ru AS home_name_ru,ht.logo_url AS home_logo,
             at.name_en AS away_name,at.name_ru AS away_name_ru,at.logo_url AS away_logo
      FROM games g
      LEFT JOIN teams ht ON ht.tri_code=g.home_tri
      LEFT JOIN teams at ON at.tri_code=g.away_tri
      WHERE g.game_pk=? AND g.game_type IN (1,2,3)
      LIMIT 1;
    `).bind(gamePk).first();
    if (!game) return jsonResponse({ ok:false,error:"game_not_found" },404);

    routeStage="secondary_reads";
    const dataDegradedSections=[];
    const safeAll=async(label,statement)=>{
      try {
        const result=await statement.all();
        return result?.results||[];
      } catch (error) {
        dataDegradedSections.push(label);
        console.error(`broadcast data section degraded: ${label}`, error);
        return [];
      }
    };

    const [periods,teamStats,playerStats,events,persistedCards] = await Promise.all([
      safeAll("periods", env.DB.prepare(`SELECT period_number,period_type,home_goals,away_goals FROM period_scores WHERE game_pk=? ORDER BY period_number,period_type;`).bind(gamePk)),
      safeAll("team_stats", env.DB.prepare(`SELECT * FROM team_game_stats WHERE game_pk=? ORDER BY is_home ASC;`).bind(gamePk)),
      safeAll("top_players", env.DB.prepare(`
        SELECT pgs.player_id,pgs.team_tri,pgs.goals,pgs.assists,pgs.points,pgs.shots,pgs.hits,pgs.blocked_shots,
               pgs.pim,pgs.plus_minus,pgs.toi_seconds,p.full_name_en,p.full_name_ru,p.position_code,p.sweater_number
        FROM player_game_stats pgs
        JOIN players p ON p.player_id=pgs.player_id
        WHERE pgs.game_pk=?
        ORDER BY pgs.points DESC,pgs.goals DESC,pgs.shots DESC,pgs.toi_seconds DESC
        LIMIT 20;
      `).bind(gamePk)),
      safeAll("events", env.DB.prepare(`
        SELECT ge.event_key,ge.event_type,ge.period_number,ge.period_type,ge.time_in_period,ge.team_tri,
               ge.home_score,ge.away_score,ge.description,
               GROUP_CONCAT(COALESCE(p.full_name_ru,p.full_name_en)||'|'||ep.role,';;') AS people
        FROM game_events ge
        LEFT JOIN event_players ep ON ep.event_key=ge.event_key
        LEFT JOIN players p ON p.player_id=ep.player_id
        WHERE ge.game_pk=? AND ge.event_type IN ('goal','shootout-goal','penalty','period-end')
        GROUP BY ge.event_key
        ORDER BY ge.sort_order DESC
        LIMIT 50;
      `).bind(gamePk)),
      safeAll("persisted_cards", env.DB.prepare(`
        SELECT card_id,headline_ru,stat_text_ru,source_note_ru,status,shown_at,display_order,
               suggested_market_type,suggested_market_subject,manual_odds,odds_is_demo,payload_json,
               render_hash,render_bytes,rendered_at
        FROM broadcast_cards
        WHERE game_pk=?
        ORDER BY CASE status WHEN 'shown' THEN 0 WHEN 'preview' THEN 1 ELSE 2 END,display_order,created_at;
      `).bind(gamePk)),
    ]);

    routeStage="betting";
    let bettingInsights=[];
    let bettingInsightsDegraded=false;
    let providerMarkets=[];
    let generatorDiagnostics={};
    try {
      providerMarkets=await loadBroadcastWinlineMarkets(env.DB,game);
      const statisticalInsights=await buildBettingInsights(env.DB,game);
      if(providerMarkets.length){
        const pricedInsights=await buildBettingInsights(env.DB,game,{
          provider_markets:providerMarkets,
          market_max_age_ms:broadcastWinlineMaxAgeMs(game),
          generator_diagnostics:generatorDiagnostics,
        });
        bettingInsights=mergeBroadcastInsights(statisticalInsights,pricedInsights);
      }else{
        bettingInsights=(statisticalInsights||[]).map(stripDemoPrice);
      }
      await persistBroadcastQueueSummary(env.DB,gamePk,summarizeBroadcastQueueCards(bettingInsights));
      await archiveBroadcastInsightHistory(env.DB,game,bettingInsights);
    } catch (error) {
      bettingInsightsDegraded=true;
      console.error("broadcast betting insights degraded", error);
    }
    routeStage="quick_cards";
    let quickCards=[];
    try {
      quickCards=buildQuickCards(game,teamStats,playerStats);
    } catch (error) {
      dataDegradedSections.push("quick_cards");
      console.error("broadcast quick cards degraded", error);
    }

    routeStage="serialize_response";
    return jsonResponse({
      ok:true,
      game,
      periods,
      team_stats:teamStats,
      top_players:playerStats,
      events,
      cards:bettingInsights,
      featured_cards:selectBroadcastFour(bettingInsights,game).map(card=>({
        ...card,
        commentator_brief:buildCommentatorBrief(card,game),
      })),
      queue_summary:summarizeBroadcastQueueCards(bettingInsights),
      betting_insights_degraded:bettingInsightsDegraded,
      provider_market_count:providerMarkets.length,
      market_coverage:summarizeMarketCoverage(providerMarkets,bettingInsights),
      generator_diagnostics:generatorDiagnostics,
      data_degraded_sections:dataDegradedSections,
      quick_cards:quickCards,
      persisted_cards:persistedCards,
    });
  } catch (error) {
    console.error(`broadcast game failed at ${routeStage}`, error);
    return jsonResponse({ ok:false,error:"broadcast_game_failed" },500);
  }
}

export async function archiveUpcomingBroadcastAnalytics(env,{limit=12}={}){
  if(!env?.DB)return {ok:false,error:"missing_d1_binding"};
  const rows=await env.DB.prepare(`
    SELECT game_pk,season_id,game_type,scheduled_start_utc,game_state,home_tri,away_tri,home_score,away_score
    FROM games
    WHERE game_type IN (2,3)
      AND datetime(scheduled_start_utc)>datetime('now')
      AND datetime(scheduled_start_utc)<=datetime('now','+30 hours')
    ORDER BY datetime(scheduled_start_utc) ASC
    LIMIT ?;
  `).bind(Math.max(1,Math.min(20,Number(limit)||12))).all();
  let games=0,cards=0;
  for(const game of rows.results||[]){
    try{
      const providerMarkets=await loadBroadcastWinlineMarkets(env.DB,game);
      if(!providerMarkets.length)continue;
      const priced=await buildBettingInsights(env.DB,game,{
        provider_markets:providerMarkets,
        market_max_age_ms:broadcastWinlineMaxAgeMs(game),
      });
      const saved=await archiveBroadcastInsightHistory(env.DB,game,priced);
      games++;cards+=Number(saved?.written||0);
    }catch(error){
      console.error("scheduled broadcast analytics archive failed",game.game_pk,error);
    }
  }
  return {ok:true,games,cards};
}

const WINLINE_TEAM_NAMES={
  anaheimducks:"ANA",bostonbruins:"BOS",buffalosabres:"BUF",calgaryflames:"CGY",carolinahurricanes:"CAR",chicagoblackhawks:"CHI",
  coloradoavalanche:"COL",columbusbluejackets:"CBJ",dallasstars:"DAL",detroitredwings:"DET",edmontonoilers:"EDM",floridapanthers:"FLA",
  losangeleskings:"LAK",minnesotawild:"MIN",montrealcanadiens:"MTL",nashvillepredators:"NSH",newjerseydevils:"NJD",newyorkislanders:"NYI",
  newyorkrangers:"NYR",ottawasenators:"OTT",philadelphiaflyers:"PHI",pittsburghpenguins:"PIT",sanjosesharks:"SJS",seattlekraken:"SEA",
  stlouisblues:"STL",tampabaylightning:"TBL",torontomapleleafs:"TOR",utahmammoth:"UTA",utahhockeyclub:"UTA",vancouvercanucks:"VAN",
  vegasgoldenknights:"VGK",washingtoncapitals:"WSH",winnipegjets:"WPG"
};

export async function loadBroadcastWinlineMarkets(db,game){
  const event=await db.prepare("SELECT winline_event_id,deeplink,raw_json,updated_at FROM winline_events WHERE game_pk=? ORDER BY updated_at DESC LIMIT 1;").bind(game.game_pk).first().catch(()=>null);
  if(!event)return [];
  const result=await db.prepare("SELECT winline_market_id,market_type,subject_key,outcome_name,odds,deeplink,is_live,active,raw_json,updated_at FROM winline_markets WHERE winline_event_id=? AND active=1 AND odds IS NOT NULL ORDER BY updated_at DESC,winline_market_id ASC LIMIT 240;").bind(event.winline_event_id).all().catch(()=>({results:[]}));
  const eventRaw=parseJson(event.raw_json),team1=triFromWinlineName(eventRaw?.team1),team2=triFromWinlineName(eventRaw?.team2);
  const out=[];
  for(const row of result.results||[]){const m=canonicalBroadcastWinlineMarket(row,event,game,{team1,team2});if(m)out.push(m)}
  return out;
}

export function canonicalBroadcastWinlineMarket(row,event,game,teams){
  const raw=parseJson(row.raw_json)||{};
  const freetext=String(raw.freetext||row.market_type||"").trim();
  const norm=normalizeWinlineText(freetext);
  const outcome=String(row.outcome_name||"").trim();
  const lowerOutcome=outcome.toLowerCase();
  const value=finiteMarketLine(raw.value,marketLineFromType(row.market_type));
  const updatedAt=isoOrNull(row.updated_at||event.updated_at);
  const base={provider:"winline",event_id:String(event.winline_event_id||""),market_id:String(row.winline_market_id||""),selection_id:String(row.winline_market_id||""),odds:Number(row.odds),status:"open",is_live:Boolean(Number(row.is_live||0)),updated_at:updatedAt,deeplink:row.deeplink||event.deeplink||null};
  if(!Number.isFinite(base.odds)||base.odds<=1||!updatedAt)return null;

  const period=/^(?:1|1st)period|firstperiod|period1/.test(norm)?"P1":
    /^(?:2|2nd)period|secondperiod|period2/.test(norm)?"P2":
    /^(?:3|3rd)period|thirdperiod|period3/.test(norm)?"P3":
    /regulartime|60min|60minutes/.test(norm)?"REG":"GAME";

  if(/firstgoal|firsttoscore|teamtoscorefirst/.test(norm)){
    const subject=teamSubject(row.subject_key,outcome,game,teams);
    if(!subject)return null;
    return {...base,market_type:"first_goal_team",period:"GAME",subject,side:subject,line:null};
  }
  if(/nextgoal|nexttoscore|teamtoscorenext/.test(norm)){
    const subject=teamSubject(row.subject_key,outcome,game,teams);
    if(!subject)return null;
    return {...base,market_type:"next_goal_team",period,subject,side:subject,line:null};
  }
  if(/player|skater/.test(norm)){
    const playerSubject=String(raw.player_id||raw.playerId||raw.person_id||raw.personId||row.subject_key||"").trim();
    const propSide=/over|more|больше|тб/i.test(lowerOutcome)?"over":/under|less|меньше|тм/i.test(lowerOutcome)?"under":null;
    let propType=null;
    if(/goal/.test(norm))propType="player_goals";
    else if(/point/.test(norm))propType="player_points";
    else if(/shot/.test(norm))propType="player_shots";
    else if(/assist/.test(norm))propType="player_assists";
    else if(/block/.test(norm))propType="player_blocks";
    else if(/hit/.test(norm))propType="player_hits";
    if(playerSubject&&propType&&propSide&&value!==null)return {...base,market_type:propType,period,subject:playerSubject,side:propSide,line:value};
  }

  // Expanded market families. These parsers are deliberately conservative:
  // if the outcome cannot be mapped unambiguously, keep the market out rather
  // than attach a statistical story to the wrong Winline selection.
  if(/doublechance|doubleoutcome/.test(norm)){
    const o=normalizeWinlineText(outcome);
    let subject=null,dcSide=null;
    if(o==="1x"||o==="x1"){subject=teams.team1||null;dcSide="team_or_draw";}
    else if(o==="x2"||o==="2x"){subject=teams.team2||null;dcSide="team_or_draw";}
    else if(o==="12"||o==="21"){dcSide="no_draw";}
    else if(o==="homeordraw"||o==="draworhome"){subject=game.home_tri;dcSide="team_or_draw";}
    else if(o==="draworaway"||o==="awayordraw"){subject=game.away_tri;dcSide="team_or_draw";}
    else if(o==="homeoraway"||o==="awayorhome"){dcSide="no_draw";}
    if(!dcSide)return null;
    return {...base,market_type:"double_chance",period:period==="GAME"?"REG":period,subject,side:dcSide,line:null};
  }
  if(/highestscoringperiod|mostscoringperiod|mostgoalsperiod|highestperiod/.test(norm)){
    const o=normalizeWinlineText(outcome);
    const pm=/([123])/.exec(o);
    if(!pm)return null;
    const subject=teamSubject(row.subject_key,"",game,teams);
    return {...base,market_type:"highest_scoring_period",period:"GAME",subject,side:"P"+pm[1],line:null};
  }
  if(/winalleveryperiod|winallperiods|allperiodswinner/.test(norm)){
    const subject=teamSubject(row.subject_key,outcome,game,teams);
    if(!subject)return null;
    return {...base,market_type:"win_all_periods",period:"GAME",subject,side:subject,line:null};
  }
  if(/exactteamgoals|teamgoalsnumber|numberofteamgoals|teamgoalrange/.test(norm)){
    const idx=/team1|1stteam|firstteam/.test(norm)?1:/team2|2ndteam|secondteam/.test(norm)?2:0;
    const subject=String(row.subject_key||"").toUpperCase()||(idx===1?teams.team1:idx===2?teams.team2:null);
    const o=normalizeWinlineText(outcome);
    let bucket=null;
    if(/^(01|0to1|0or1|under2)$/.test(o))bucket="0_1";
    else if(/^(2|exact2|2goals)$/.test(o))bucket="2";
    else if(/3\s*\+|3\s*(?:or|and)\s*more|3\s*(?:или|и)\s*больше/i.test(outcome)||/^(3plus|3ormore|over25|3goalsormore)$/.test(o))bucket="3_plus";
    if(!subject||!bucket)return null;
    return {...base,market_type:"team_goal_bucket",period,subject,side:bucket,line:null};
  }
  if(/resultandtotal|resulttotal|winnerandtotal|winandtotal/.test(norm)){
    const subject=teamSubject(row.subject_key,outcome,game,teams);
    const comboSide=/over|more|больше|тб/i.test(lowerOutcome)?"over":/under|less|меньше|тм/i.test(lowerOutcome)?"under":null;
    if(!subject||!comboSide||value===null)return null;
    return {...base,market_type:"result_total_combo",period,subject,side:comboSide,line:value};
  }
  if(/oddeven|evenodd|chetn|nechetn/.test(norm))return null;

  if(String(row.market_type)==="main_1x2_regular"||/3wayodds|1x2/.test(norm)){
    const subject=teamSubject(row.subject_key,outcome,game,teams);
    const side=subject||(/^(x|draw|tie|ничья|н)$/i.test(outcome)?"draw":null);
    if(!side)return null;
    const resolvedPeriod=String(row.market_type)==="main_1x2_regular"?"REG":(period==="GAME"?"REG":period);
    const periodType=resolvedPeriod==="P1"?"period_1_result":resolvedPeriod==="P2"?"period_2_result":resolvedPeriod==="P3"?"period_3_result":"moneyline";
    return {...base,market_type:periodType,period:resolvedPeriod,subject,side,line:null};
  }
  if(/bothteamstoscore|bothteamscore|bothscore/.test(norm)){
    const o=normalizeWinlineText(outcome);
    const yes=/^(yes|y|да|1)$/.test(o);
    const no=/^(no|n|нет|2)$/.test(o);
    if(!yes&&!no)return null;
    return {...base,market_type:"both_teams_score",period,subject:null,side:yes?"yes":"no",line:null};
  }

  if(/moneyline|matchwinner|winner/.test(norm)&&!/period/.test(norm)){
    const subject=teamSubject(row.subject_key,outcome,game,teams);if(!subject)return null;
    return {...base,market_type:"moneyline",period:"GAME",subject,side:subject,line:null};
  }
  const side=/over|more|больше|тб/i.test(lowerOutcome)?"over":/under|less|меньше|тм/i.test(lowerOutcome)?"under":null;
  if(/teamtotal|individualtotal|team1total|team2total|totalteam/.test(norm)){
    const idx=/team1|1stteam|firstteam|individualtotal1|total1/.test(norm)?1:/team2|2ndteam|secondteam|individualtotal2|total2/.test(norm)?2:0;
    const subject=String(row.subject_key||"").toUpperCase()||(idx===1?teams.team1:idx===2?teams.team2:null);
    if(!subject||!side||value===null)return null;
    return {...base,market_type:"team_total",period,subject,side,line:value};
  }
  if(/handicap|spread|puckline|fora/.test(norm)){
    const subject=teamSubject(row.subject_key,outcome,game,teams);if(!subject||value===null)return null;
    let line=value;const first=subject===teams.team1,second=subject===teams.team2;if(second&&!first)line=-value;
    return {...base,market_type:"handicap",period,subject,side:subject,line};
  }
  if(/total/.test(norm)&&!/team|individual/.test(norm)){
    if(!side||value===null)return null;
    return {...base,market_type:"game_total",period,subject:null,side,line:value};
  }
  return null;
}
function teamSubject(subjectKey,outcome,game,teams){
  const key=String(subjectKey||"").trim().toUpperCase();if(key===game.home_tri||key===game.away_tri)return key;
  if(outcome==="1")return teams.team1||null;if(outcome==="2")return teams.team2||null;
  if(/^home$/i.test(outcome))return game.home_tri;if(/^away$/i.test(outcome))return game.away_tri;return null;
}
function parseJson(v){try{return v?JSON.parse(v):null}catch{return null}}
function normalizeWinlineText(v){return String(v||"").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g,"")}
function triFromWinlineName(v){return WINLINE_TEAM_NAMES[normalizeWinlineText(v)]||null}
function finiteMarketLine(...values){for(const v of values){if(v===null||v===undefined||v==="")continue;const n=Number(String(v).replace(",",".").replace(/[^0-9+.-]/g,""));if(Number.isFinite(n))return n}return null}
function marketLineFromType(v){const m=String(v||"").match(/:([+-]?\d+(?:\.\d+)?)$/);return m?m[1]:null}
function isoOrNull(v){const raw=String(v||"").trim();const t=Date.parse(raw.includes("T")?raw:raw.replace(" ","T")+"Z");return Number.isFinite(t)?new Date(t).toISOString():null}
function broadcastWinlineMaxAgeMs(game){const left=Date.parse(String(game?.scheduled_start_utc||""))-Date.now();if(!Number.isFinite(left))return 7*60*60*1000;if(left>6*60*60*1000)return 7*60*60*1000;if(left>60*60*1000)return 75*60*1000;return 25*60*1000}
export function mergeBroadcastInsights(statisticalInsights,pricedInsights){
  const out=[],seenIds=new Set(),pricedMarkets=new Set();
  for(const card of pricedInsights||[]){
    const id=String(card?.id||"");
    if(id&&seenIds.has(id))continue;
    out.push(card);
    if(id)seenIds.add(id);
    pricedMarkets.add(broadcastExactMarketKey(card?.market));
  }
  for(const card of statisticalInsights||[]){
    const id=String(card?.id||"");
    if(id&&seenIds.has(id))continue;
    // Do not append a second unpriced story for an exact market that already
    // has a real Winline card. The priced story is the source of truth.
    if(pricedMarkets.has(broadcastExactMarketKey(card?.market)))continue;
    out.push(stripDemoPrice(card));
    if(id)seenIds.add(id);
  }
  return out;
}
function broadcastExactMarketKey(market){
  const line=market?.line===null||market?.line===undefined||market?.line===""?"none":Number(market.line).toFixed(2);
  return [market?.type||"unknown",market?.period||"GAME",market?.subject||"all",market?.side||"none",line].join(":");
}
function stripDemoPrice(card){
  const copy=typeof structuredClone==="function"?structuredClone(card):JSON.parse(JSON.stringify(card));
  copy.market={...(copy.market||{}),odds:null,odds_is_demo:false,odds_source:"unavailable",provider:"winline_unavailable"};
  copy.note=`${copy.market?.label||"Рынок"} · WINLINE · точная линия сейчас не найдена`;
  return copy;
}

function buildQuickCards(game, teamStats, playerStats) {
  const cards=[];
  const home=teamStats.find(r=>Number(r.is_home)===1);
  const away=teamStats.find(r=>Number(r.is_home)===0);
  if (home&&away&&home.shots!==null&&away.shots!==null) {
    const hs=Number(home.shots||0),as=Number(away.shots||0);
    const leader=hs===as?null:hs>as?game.home_tri:game.away_tri;
    cards.push({id:`${game.game_pk}:shots`,kind:"match",eyebrow:"БРОСКИ В СТВОР",value:`${as} — ${hs}`,title:leader?`${leader} чаще попадал в створ`:"Равенство по броскам",note:`${game.away_tri} — ${game.home_tri}`});
  }
  if (home&&away&&home.hits!==null&&away.hits!==null) {
    cards.push({id:`${game.game_pk}:hits`,kind:"match",eyebrow:"СИЛОВАЯ ИГРА",value:`${Number(away.hits||0)} — ${Number(home.hits||0)}`,title:"Хиты за матч",note:`${game.away_tri} — ${game.home_tri}`});
  }
  if (home&&away&&home.pim!==null&&away.pim!==null) {
    cards.push({id:`${game.game_pk}:pim`,kind:"match",eyebrow:"ШТРАФ",value:`${Number(away.pim||0)} — ${Number(home.pim||0)}`,title:"Штрафные минуты",note:`${game.away_tri} — ${game.home_tri}`});
  }
  const leader=playerStats.find(r=>Number(r.points||0)>0);
  if (leader) {
    const name=leader.full_name_ru||leader.full_name_en;
    cards.push({id:`${game.game_pk}:leader`,kind:"player",eyebrow:"ЛИДЕР МАТЧА",value:`${Number(leader.points||0)} ОЧК.`,title:name,note:`${Number(leader.goals||0)}+${Number(leader.assists||0)} · ${leader.team_tri}`});
  }
  const goalDiff=Math.abs(Number(game.home_score||0)-Number(game.away_score||0));
  const winner=Number(game.home_score||0)>Number(game.away_score||0)?game.home_tri:game.away_tri;
  cards.push({id:`${game.game_pk}:score`,kind:"match",eyebrow:"ФИНАЛЬНЫЙ СЧЁТ",value:`${game.away_score}:${game.home_score}`,title:goalDiff===0?"Матч завершён вничью":`${winner} победил${goalDiff>=3?" крупно":""}`,note:game.period_type==="OT"?"Овертайм":game.period_type==="SO"?"Буллиты":"Матч завершён"});
  return cards.slice(0,6);
}

function jsonResponse(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}})}
function htmlResponse(html){return new Response(html,{status:200,headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}})}

function jsResponse(js){return new Response(js,{status:200,headers:{"Content-Type":"application/javascript; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}})}

function pngResponse(base64){const raw=atob(base64);const bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i+=1)bytes[i]=raw.charCodeAt(i);return new Response(bytes,{status:200,headers:{"Content-Type":"image/png","Cache-Control":"public, max-age=31536000, immutable","X-Content-Type-Options":"nosniff"}})}

function browserApp(){
const $=s=>document.querySelector(s);let games=[],selected=null,currentCards=[],historicalCards=[],liveCards=[],liveTimer=null,currentData=null;let groupOpen={1:true,2:false,3:false};let leaseTimer=null,leaseOwned=false,currentLease=null,actionTimer=null,queueWarmRunning=false;
const operatorId=(()=>{let v=localStorage.getItem('hohBroadcastOperatorId')||'';if(!v){v='op-'+(crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+'-'+Math.random().toString(36).slice(2));localStorage.setItem('hohBroadcastOperatorId',v)}return v})();
let operatorName=localStorage.getItem('hohBroadcastOperatorName')||'';
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
async function operatorApi(url,opts={}){const headers={...(opts.headers||{})};if(opts.body&&!headers['Content-Type'])headers['Content-Type']='application/json';const r=await fetch(url,{...opts,headers,cache:'no-store'});const d=await r.json().catch(()=>({}));if(r.status===401)throw new Error('Operator access закрыт — нужен ключ');if(!r.ok){const e=new Error(d.message||d.error||('HTTP '+r.status));e.code=d.error||'';e.lease=d.lease||null;throw e}return d}
function identity(){if(!operatorName){operatorName=(prompt('Имя оператора (покажем коллегам)','')||'').trim().slice(0,48);if(!operatorName)operatorName='Оператор '+operatorId.slice(-4).toUpperCase();localStorage.setItem('hohBroadcastOperatorName',operatorName)}return{operator_id:operatorId,operator_name:operatorName}}
async function acquireLease(gamePk){const who=identity();try{const d=await operatorApi('/api/broadcast/operator/leases/'+gamePk,{method:'POST',body:JSON.stringify(who)});leaseOwned=true;currentLease=d.lease||null;syncLeaseToGame(gamePk,currentLease);if(leaseTimer)clearInterval(leaseTimer);leaseTimer=setInterval(()=>heartbeatLease(gamePk),30000);return true}catch(e){leaseOwned=false;currentLease=e.lease||null;syncLeaseToGame(gamePk,currentLease);return false}}
async function heartbeatLease(gamePk){if(!leaseOwned||Number(gamePk)!==Number(selected))return;try{const d=await operatorApi('/api/broadcast/operator/leases/'+gamePk,{method:'POST',body:JSON.stringify(identity())});currentLease=d.lease||currentLease;syncLeaseToGame(gamePk,currentLease)}catch(e){leaseOwned=false;currentLease=e.lease||null;syncLeaseToGame(gamePk,currentLease);renderCards(currentCards)}}
async function releaseLease(gamePk){if(!gamePk)return;if(leaseTimer){clearInterval(leaseTimer);leaseTimer=null}try{await operatorApi('/api/broadcast/operator/leases/'+gamePk,{method:'DELETE',body:JSON.stringify({operator_id:operatorId})})}catch{}const g=games.find(x=>Number(x.game_pk)===Number(gamePk));if(g&&g.operator_id===operatorId){g.operator_id=null;g.operator_name=null;g.operator_expires_at=null}leaseOwned=false;currentLease=null}
function syncLeaseToGame(gamePk,lease){const g=games.find(x=>Number(x.game_pk)===Number(gamePk));if(!g)return;if(lease){g.operator_id=lease.operator_id;g.operator_name=lease.operator_name;g.operator_expires_at=lease.expires_at}else if(g.operator_id===operatorId){g.operator_id=null;g.operator_name=null;g.operator_expires_at=null}renderGames()}
function overlayUrl(gamePk){
  return '/broadcast/overlay?game='+encodeURIComponent(gamePk);
}
function syncOverlayLinks(gamePk){
  const href=overlayUrl(gamePk);
  const side=$('#overlay-link'),open=$('#overlay-open');
  if(side)side.href=href;
  if(open)open.href=href;
}
function absoluteOverlayUrl(gamePk){
  return new URL(overlayUrl(gamePk),location.origin).href;
}
function fmtDate(v){if(!v)return'';const d=new Date(v);return d.toLocaleString('ru-RU',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}).replace(',',' ·')}
function typeLabel(t){const n=Number(t);return n===1?'Предсезонка':n===3?'Плей-офф':'Регулярка'}
async function api(url){const r=await fetch(url,{cache:'no-store'});if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}
async function load(){try{const g=await api('/api/broadcast/games');games=g.games||[];$('#counts').textContent=`${g.counts.games} ближайших игр · предсезонка + регулярка + плей-офф`;const requested=Number(new URLSearchParams(location.search).get('game'));const first=games.find(x=>Number(x.game_pk)===requested)||games[0];selected=first?.game_pk||null;renderGames();if(first)await selectGame(first.game_pk);else renderAir(null);await refreshActions();void warmQueueSummaries();if(!actionTimer)actionTimer=setInterval(refreshActions,15000)}catch(e){$('#hero').innerHTML='<div class="empty">Не удалось загрузить Data Core</div>'}}
function renderAir(card){const air=$('#air'),text=$('#airtext');if(card){air.classList.add('live');text.textContent=`${card.headline_ru}: ${card.stat_text_ru}`}else{air.classList.remove('live');text.textContent='Сейчас ничего не показано'}}
function queueSummaryFresh(g){
  const raw=String(g?.queue_summary_generated_at||'').trim();
  const t=Date.parse(raw.includes('T')?raw:(raw?raw.replace(' ','T')+'Z':''));
  const live=['LIVE','CRIT'].includes(String(g?.game_state||'').toUpperCase());
  return Number.isFinite(t)&&(Date.now()-t)<(live?45000:5*60*1000);
}
function queueBadge(g){
  const strong=Number(g?.strong_count);
  if(Number.isFinite(strong)&&g?.queue_summary_generated_at){
    if(strong>0)return `<b class="strongpill">${strong} СИЛЬН${strong===1?'АЯ':'ЫХ'}</b>`;
    return '<span class="noline">НЕТ СИЛЬНЫХ ЛИНИЙ</span>';
  }
  return '<span class="summarywait">ПРОВЕРЯЮ ЛИНИИ…</span>';
}
function syncQueueSummary(gamePk,summary){
  if(!summary)return;
  const g=games.find(x=>Number(x.game_pk)===Number(gamePk));if(!g)return;
  g.strong_count=Number(summary.strong_count||0);
  g.priced_count=Number(summary.priced_count||0);
  g.total_count=Number(summary.total_count||0);
  g.top_air_score=summary.top_air_score==null?null:Number(summary.top_air_score);
  g.queue_summary_generated_at=summary.generated_at||new Date().toISOString();
  renderGames();
}
function syncQueueSummaryFromCards(gamePk,cards){
  const list=Array.isArray(cards)?cards:[];
  const priced=list.filter(hasRealWinlinePrice);
  const strong=priced.filter(c=>airScore(c)>=55);
  syncQueueSummary(gamePk,{
    strong_count:strong.length,
    priced_count:priced.length,
    total_count:list.length,
    top_air_score:strong.length?Math.max(...strong.map(airScore)):null,
    generated_at:new Date().toISOString(),
  });
}
async function warmQueueSummaries(){
  if(queueWarmRunning)return;
  queueWarmRunning=true;
  try{
    const targets=games.filter(g=>!queueSummaryFresh(g)).slice(0,18);
    let cursor=0;
    const worker=async()=>{
      while(cursor<targets.length){
        const g=targets[cursor++];
        try{
          const d=await api('/api/broadcast/queue-summary/'+encodeURIComponent(g.game_pk));
          if(d?.summary)syncQueueSummary(g.game_pk,d.summary);
        }catch{}
      }
    };
    await Promise.all([worker(),worker()]);
  }finally{queueWarmRunning=false}
}
function renderGames(){
  const selectedGame=games.find(g=>Number(g.game_pk)===Number(selected));
  if(selectedGame)groupOpen[Number(selectedGame.game_type)]=true;
  const groups=[{type:1,label:'Предсезонка'},{type:2,label:'Регулярка'},{type:3,label:'Плей-офф'}];
  const row=g=>{const room=[g.on_air_card_id?'<b class="pill">ON AIR</b>':'',g.operator_name?`<span class="roomop">${esc(g.operator_name)}</span>`:''].filter(Boolean).join(' ');const q=queueBadge(g);return `<button class="game ${Number(g.game_pk)===Number(selected)?'active':''}" data-id="${g.game_pk}"><div class="gline"><span class="gteams">${esc(g.away_tri)} · ${esc(g.home_tri)}</span><span class="gscore">${g.away_score}:${g.home_score}</span></div><div class="gmeta"><span>${esc(fmtDate(g.scheduled_start_utc))}</span><span class="roomstate">${room}</span></div><div class="gqueue">${q}</div></button>`};
  $('#games').innerHTML=groups.map(group=>{
    const rows=games.filter(g=>Number(g.game_type)===group.type);
    if(!rows.length)return'';
    return `<details class="gamegroup" data-type="${group.type}" ${groupOpen[group.type]?'open':''}><summary class="grouphead"><span>${group.label}</span><span class="groupcount">${rows.length}</span><span class="groupchev">⌄</span></summary><div class="grouprows">${rows.map(row).join('')}</div></details>`;
  }).join('');
  document.querySelectorAll('.gamegroup').forEach(d=>d.addEventListener('toggle',()=>{groupOpen[Number(d.dataset.type)]=d.open}));
  document.querySelectorAll('.game').forEach(b=>b.onclick=()=>selectGame(Number(b.dataset.id)));
}
async function selectGame(id){const previous=selected;if(previous&&Number(previous)!==Number(id))await releaseLease(previous);selected=id;history.replaceState(null,'','/broadcast?game='+encodeURIComponent(id));syncOverlayLinks(id);renderGames();if(liveTimer){clearInterval(liveTimer);liveTimer=null}liveCards=[];historicalCards=[];$('#hero').innerHTML='<div class="empty">Загружаю матч...</div>';const [d,s,owned]=await Promise.all([api('/api/broadcast/games/'+id),api('/api/broadcast/state?game='+encodeURIComponent(id)),acquireLease(id)]);if(Number(id)!==Number(selected))return;currentData=d;historicalCards=(d.featured_cards||d.cards||[]).slice(0,4);syncQueueSummary(id,d.queue_summary);renderAir(s.on_air);renderGame(d);if(!owned){const sub=document.querySelector('.psub');if(sub)sub.textContent='Режим просмотра · матч ведёт '+(currentLease?.operator_name||'другой оператор')}await refreshLive(id,true)}
function teamHtml(g,side){const tri=g[side+'_tri'],name=g[side+'_name_ru']||g[side+'_name']||tri,logo=g[side+'_logo'];return `<div class="team ${side==='home'?'home':''}">${side==='home'?`<div><div class="code">${esc(tri)}</div><div class="name">${esc(name)}</div></div>`:''}<div class="logo">${logo?`<img src="${esc(logo)}" alt="">`:`<span class="fallback">${esc(tri)}</span>`}</div>${side==='away'?`<div><div class="code">${esc(tri)}</div><div class="name">${esc(name)}</div></div>`:''}</div>`}
function renderGame(d){const g=d.game,periods=d.periods||[];$('#hero').innerHTML=`<div class="herohead"><span>${typeLabel(g.game_type)} · ${esc(g.season_id)}</span><span>${esc(fmtDate(g.scheduled_start_utc))}${g.venue_name?' · '+esc(g.venue_name):''}</span></div><div class="match">${teamHtml(g,'away')}<div class="score">${g.away_score}<span>:</span>${g.home_score}</div>${teamHtml(g,'home')}</div><div class="periods" id="liveclock">${esc(g.game_state)} · ${periods.map(p=>'P'+p.period_number+' '+p.away_goals+':'+p.home_goals).join(' · ')}</div>`;renderMetrics(d);renderCombinedCards();renderPlayers(d.top_players||[]);renderEvents(d.events||[])}
function renderMetrics(d){const a=(d.team_stats||[]).find(x=>Number(x.is_home)===0)||{},h=(d.team_stats||[]).find(x=>Number(x.is_home)===1)||{},g=d.game;const rows=[['Броски в створ',a.shots,h.shots],['Хиты',a.hits,h.hits],['Штрафные минуты',a.pim,h.pim],['Вбрасывания',a.faceoff_pct==null||!Number.isFinite(Number(a.faceoff_pct))?null:Math.round(Number(a.faceoff_pct)*100)+'%',h.faceoff_pct==null||!Number.isFinite(Number(h.faceoff_pct))?null:Math.round(Number(h.faceoff_pct)*100)+'%']];$('#metrics').innerHTML=rows.map(r=>`<div class="metric"><div class="mval">${esc(r[1]??'—')} — ${esc(r[2]??'—')}</div><div class="mlabel">${esc(r[0])} · ${esc(g.away_tri)} / ${esc(g.home_tri)}</div></div>`).join('')}
function renderCombinedCards(){const merged=(historicalCards||[]).slice(0,4);renderCards(merged);syncQueueSummaryFromCards(selected,merged);const priced=merged.filter(hasRealWinlinePrice).length,sub=document.querySelector('.psub');if(sub)sub.textContent=`4 карточки на матч · 2 форма команд + 2 личные встречи · линий WINLINE: ${priced}/${merged.length}`}
async function refreshLive(id,initial=false){try{const l=await api('/api/broadcast/live/'+id);if(Number(id)!==Number(selected))return;liveCards=(l.cards||[]).filter(x=>x?.market?.odds_is_demo===false&&Number.isFinite(Number(x?.market?.odds)));renderCombinedCards();const c=$('#liveclock');if(c&&l.game){const parts=[l.game.game_state,l.game.period_number?'P'+l.game.period_number:null,l.game.time_remaining].filter(Boolean);c.textContent=parts.join(' · ')+' · LIVE FEED '+new Date(l.fetched_at).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}if(['LIVE','CRIT'].includes(String(l.game?.game_state||'').toUpperCase())&&!liveTimer){liveTimer=setInterval(()=>refreshLive(id,false),15000)}}catch(e){if(initial){const sub=document.querySelector('.psub');if(sub)sub.textContent=`История ${historicalCards.length} · NHL live feed временно недоступен`}}}
const TEAM_META={
  ANA:{name:"АНАХАЙМ",color:"#FC4C02"},BOS:{name:"БОСТОН",color:"#FFB81C"},BUF:{name:"БАФФАЛО",color:"#003087"},
  CGY:{name:"КАЛГАРИ",color:"#D2001C"},CAR:{name:"КАРОЛИНА",color:"#CE1126"},CHI:{name:"ЧИКАГО",color:"#CF0A2C"},
  COL:{name:"КОЛОРАДО",color:"#6F263D"},CBJ:{name:"КОЛАМБУС",color:"#002654"},DAL:{name:"ДАЛЛАС",color:"#006847"},
  DET:{name:"ДЕТРОЙТ",color:"#CE1126"},EDM:{name:"ЭДМОНТОН",color:"#FF4C00"},FLA:{name:"ФЛОРИДА",color:"#041E42"},
  LAK:{name:"ЛОС-АНДЖЕЛЕС",color:"#A2AAAD"},MIN:{name:"МИННЕСОТА",color:"#154734"},MTL:{name:"МОНРЕАЛЬ",color:"#AF1E2D"},
  NSH:{name:"НЭШВИЛЛ",color:"#FFB81C"},NJD:{name:"НЬЮ-ДЖЕРСИ",color:"#CE1126"},NYI:{name:"АЙЛЕНДЕРС",color:"#00539B"},
  NYR:{name:"РЕЙНДЖЕРС",color:"#0038A8"},OTT:{name:"ОТТАВА",color:"#C52032"},PHI:{name:"ФИЛАДЕЛЬФИЯ",color:"#F74902"},
  PIT:{name:"ПИТТСБУРГ",color:"#FCB514"},SJS:{name:"САН-ХОСЕ",color:"#006D75"},SEA:{name:"СИЭТЛ",color:"#99D9D9"},
  STL:{name:"СЕНТ-ЛУИС",color:"#002F87"},TBL:{name:"ТАМПА-БЭЙ",color:"#002868"},TOR:{name:"ТОРОНТО",color:"#003E7E"},
  UTA:{name:"ЮТА",color:"#71AFE5"},VAN:{name:"ВАНКУВЕР",color:"#00843D"},VGK:{name:"ВЕГАС",color:"#B4975A"},
  WSH:{name:"ВАШИНГТОН",color:"#C8102E"},WPG:{name:"ВИННИПЕГ",color:"#AC162C"}
};
function teamCodeFromCard(card){
  const g=currentData?.game||{},away=String(g.away_tri||"").toUpperCase(),home=String(g.home_tri||"").toUpperCase();
  const candidates=[card?.market?.subject,card?.market?.side,card?.evidence?.team,card?.team_tri,card?.evidence?.subject_team];
  for(const raw of candidates){const tri=String(raw||"").toUpperCase();if(tri===away||tri===home)return tri}
  const hay=String(card?.title||"")+" "+String(card?.value||"")+" "+String(card?.market?.label||"");
  if(away&&new RegExp("\\b"+away+"\\b","i").test(hay))return away;
  if(home&&new RegExp("\\b"+home+"\\b","i").test(hay))return home;
  return away||home||"";
}
function cardTeam(card){
  const g=currentData?.game||{},tri=teamCodeFromCard(card),side=tri===String(g.home_tri||"").toUpperCase()?"home":"away";
  const meta=TEAM_META[tri]||{name:tri||"КОМАНДА",color:"#00E6C3"};
  return {tri,name:meta.name,color:meta.color,logo:g[side+"_logo"]||""};
}
function displayText(value){
  let s=String(value??"");
  for(const [tri,meta] of Object.entries(TEAM_META))s=s.replace(new RegExp("\\b"+tri+"\\b","gi"),meta.name);
  return s.replace(/([+-]?\\d+)\\.(\\d+)/g,"$1,$2").toUpperCase();
}
function lineText(value){
  const n=Number(value);if(!Number.isFinite(n))return"";
  const abs=Math.abs(n).toString().replace(".",",");
  return (n>0?"+":n<0?"-":"")+abs;
}
function marketDescription(card,team){
  const m=card?.market||{},type=String(m.type||"").toLowerCase(),side=String(m.side||"").toLowerCase();
  const line=Number(m.line);
  if(type==="handicap"){let v=Number.isFinite(line)?line:null;if(v===null){const mm=String(m.label||"").match(/([+-]\\d+(?:[.,]\\d+)?)/);if(mm)v=Number(mm[1].replace(",","."))}return "ФОРА "+(v===null?"":lineText(v))+" ГОЛА"}
  if(type==="team_total"){const dir=side==="under"?"ИТМ":"ИТБ";return dir+" "+(Number.isFinite(line)?lineText(Math.abs(line)).replace("+",""):"")+" ГОЛА"}
  if(type==="game_total"){const dir=side==="under"?"ТОТАЛ МЕНЬШЕ":"ТОТАЛ БОЛЬШЕ";return dir+" "+(Number.isFinite(line)?String(line).replace(".",","):"")}
  if(type==="moneyline")return"ПОБЕДА";
  if(type==="next_goal_team")return"СЛЕДУЮЩИЙ ГОЛ";
  if(type==="period_2_result")return"2-Й ПЕРИОД · ПОБЕДА";
  const fallback=displayText(m.label||"СТАВКА WINLINE").replace(team.name,"").replace(/^\\s*[·—-]+\\s*/,"").trim();
  return fallback||"СТАВКА WINLINE";
}
function factText(card){
  const m=card?.market||{};
  let s=displayText(card?.broadcast_title||card?.title||card?.value||"");
  if(String(m.type||"").toLowerCase()==="handicap"&&!/ФОРУ[^А-ЯЁ]*[+-]?\\d+(?:,\\d+)?\\s+ГОЛА/.test(s)){
    s=s.replace(/ФОРУ\\s+([+-]?\\d+(?:,\\d+)?)/,"ФОРУ $1 ГОЛА");
  }
  return s;
}
function factHtml(card,team){
  let html=esc(factText(card));
  const safeName=esc(team.name);
  if(safeName)html=html.replace(safeName,'<span class="facthot">'+safeName+'</span>');
  html=html.replace(/(\\d+\\s+ИЗ\\s+\\d+)/g,'<span class="facthot">$1</span>');
  html=html.replace(/(\\d+\\s*\/\\s*\\d+)/g,'<span class="facthot">$1</span>');
  return html;
}
function profitParts(odds){
  if(!Number.isFinite(odds)||odds<=1)return{amount:"ЛИНИЯ НЕ НАЙДЕНА",suffix:"WINLINE"};
  const profit=Math.round((odds-1)*1000);
  return{amount:"+"+profit.toLocaleString("ru-RU")+" РУБ",suffix:"(ПРИ СТАВКЕ 1000 РУБ.)"};
}

function hasRealWinlinePrice(c){const o=Number(c?.market?.odds);return Number.isFinite(o)&&o>1&&c?.market?.odds_is_demo===false&&c?.market?.odds_source==="provider_live"}
function candidateCardId(c){
  const raw="insight-"+String(selected)+"-"+String(c?.id||c?.insight_type||c?.type||"insight");
  return raw.replace(/[^a-zA-Z0-9_.:-]+/g,"-").slice(0,180);
}
function syncPersistedCard(card){
  if(!card||!currentData)return;
  const id=String(card.card_id||"");
  if(!id)return;
  const list=Array.isArray(currentData.persisted_cards)?currentData.persisted_cards:[];
  currentData.persisted_cards=list;
  if(String(card.status)==='shown'){
    for(const p of list){
      if(String(p.card_id)!==id&&String(p.status)==='shown')p.status='hidden';
    }
  }
  const i=list.findIndex(p=>String(p.card_id)===id);
  if(i>=0)list[i]={...list[i],...card};
  else list.push({...card});
}
function syncGameOnAir(cardId,status){
  const g=games.find(x=>Number(x.game_pk)===Number(selected));if(!g)return;
  if(status==='shown')g.on_air_card_id=cardId;
  else if(String(g.on_air_card_id||'')===String(cardId))g.on_air_card_id=null;
  renderGames();
}
function applyPersistedState(cards){
  const persisted=currentData?.persisted_cards||[];
  const map=new Map(persisted.map(p=>[String(p.card_id),p]));
  for(const c of cards){
    const id=candidateCardId(c),p=map.get(id);
    c.__cardId=id;
    if(p){
      c.__persisted=true;
      c.__status=String(p.status||"draft");
      c.__renderHash=p.render_hash||null;
      c.__renderedAt=p.rendered_at||null;
    }else{
      c.__persisted=false;
      c.__status=c.__status||"draft";
      c.__renderHash=null;
      c.__renderedAt=null;
    }
  }
}
function airScore(c){const n=Number(c?.air_score??c?.portfolio_score??c?.score);return Number.isFinite(n)?Math.max(0,Math.min(100,Math.round(n))):0}
function airTone(score){return score>=85?'great':score>=70?'good':score>=55?'mid':'low'}
function cardSummaryHtml(c){
  const team=cardTeam(c),odds=Number(c?.market?.odds),priced=Number.isFinite(odds)&&odds>1,profit=profitParts(odds),score=airScore(c),tone=airTone(score);
  const reasons=(c?.air_reasons||[]).slice(0,3).map(x=>`<span>${esc(x)}</span>`).join('');
  return `<div class="signal">
    <div class="airmeta ${tone}"><b>${score}</b><strong>${esc(c?.air_label||'AIR SCORE')}</strong><div>${reasons}</div></div>
    <div class="signal-fact">${esc(factText(c))}</div>${c?.broadcast_subtitle?`<div class="signal-detail">${esc(displayText(c.broadcast_subtitle))}</div>`:c?.broadcast_detail?`<div class="signal-detail">${esc(displayText(c.broadcast_detail))}</div>`:''}
    <div class="signal-main">
      <div class="signal-copy">
        <div class="signal-team">${esc(team.name)}</div>
        <div class="signal-market">${esc(marketDescription(c,team))}</div>
      </div>
      <div class="signal-price">${priced?odds.toFixed(2):'—'}</div>
    </div>
    <div class="signal-profit"><b>${esc(profit.amount)}</b><span>${esc(profit.suffix)}</span></div>
  </div>`;
}
function cardArticleHtml(c,i,featured=false){
  const priced=hasRealWinlinePrice(c),shown=c.__status==='shown',locked=!leaseOwned,score=airScore(c),weak=!priced||score<55;
  const label=locked?'МАТЧ ЗАНЯТ':shown?'УБРАТЬ':priced?'ДАТЬ ПЛАШКУ':'НЕТ ЛИНИИ WINLINE';
  return `<article class="card ${featured?'featured':''} ${weak?'weak':''}">${cardSummaryHtml(c)}<div class="actions"><button class="act detailbtn" data-detail="${i}">ДЕТАЛИ</button><button class="act ${shown?'hide':priced?'show':'noln'} showbtn" data-i="${i}" ${locked||(!shown&&!priced)?'disabled':''}>${label}</button></div></article>`;
}
function renderCards(cards){
  applyPersistedState(cards);
  currentCards=cards;
  if(!cards.length){$('#cards').innerHTML='<div class="empty">Пока нет статистических карточек для этого матча</div>';return}
  const entries=cards.map((c,i)=>({c,i}));
  const top=entries.filter(x=>hasRealWinlinePrice(x.c)&&airScore(x.c)>=55).slice(0,3);
  const topIds=new Set(top.map(x=>x.i));
  const rest=entries.filter(x=>!topIds.has(x.i));
  const topHtml=top.length
    ? `<section class="queueblock"><div class="queuehead"><span>ТОП ДЛЯ ЭФИРА</span><b>${top.length}</b></div><div class="cardgrid">${top.map(x=>cardArticleHtml(x.c,x.i,true)).join('')}</div></section>`
    : '<section class="queueblock"><div class="queuehead muted"><span>СИЛЬНЫХ ЛИНИЙ СЕЙЧАС НЕТ</span></div></section>';
  const restHtml=rest.length
    ? `<details class="queueblock queue-more" ${top.length?'':'open'}><summary><span>ЕЩЁ ${rest.length} ВАРИАНТОВ</span><small>показать</small></summary><div class="cardgrid">${rest.map(x=>cardArticleHtml(x.c,x.i,false)).join('')}</div></details>`
    : '';
  $('#cards').innerHTML=topHtml+restHtml;
  document.querySelectorAll('.showbtn:not([disabled])').forEach(b=>b.onclick=()=>toggleShow(Number(b.dataset.i),b));
  document.querySelectorAll('[data-detail]').forEach(b=>b.onclick=()=>openCardDetails(Number(b.dataset.detail)));
}
function finiteUiNumber(v){if(v===null||v===undefined||v==="")return null;const n=Number(v);return Number.isFinite(n)?n:null}
function openCardDetails(i){
  const c=currentCards[i];if(!c)return;
  const score=airScore(c),meta=c?.air_meta||{},reasons=(c?.air_reasons||[]);
  const hist=finiteUiNumber(meta.historical_rate),implied=finiteUiNumber(meta.implied_probability),sample=finiteUiNumber(meta.sample_size);
  const detailRows=[
    ['AIR SCORE',score+' / 100'],
    ['Оценка',c?.air_label||'—'],
    ['Причины',reasons.length?reasons.join(' · '):'—'],
    ['Выборка',Number.isFinite(sample)&&sample>0?sample+' игр':'—'],
    ['Исторический проход',hist!==null?Math.round(hist*100)+'%':'—'],
    ['Вероятность из кэфа',implied!==null?Math.round(implied*100)+'%':'—'],
    ['Статистический score',Number.isFinite(Number(meta.source_score))?String(meta.source_score):'—'],
    ['Эфирный угол',c?.broadcast_angle_family?displayText(c.broadcast_angle_family):'—'],
    ['Почему выбран',c?.broadcast_angle_reason?displayText(c.broadcast_angle_reason):'—'],
  ];
  const op=c?.operator_narrative||{};
  const operatorDetails=Array.isArray(op.details)?op.details.filter(Boolean):[];
  const operatorHtml=operatorDetails.length
    ?`<div class="detailnote"><b>${esc(op.headline||'КОММЕНТАТОРУ')}</b><br>${operatorDetails.map(x=>esc(displayText(x))).join('<br>')}</div>`
    :'';
  const structured=Array.isArray(c?.broadcast_angle_variants)?c.broadcast_angle_variants.filter(x=>x?.title).slice(0,8):[];
  const variants=structured.length?structured:(Array.isArray(c?.broadcast_variants)?c.broadcast_variants.filter(Boolean).slice(0,8).map((title,index)=>({id:'legacy_'+index,title,family:'вариант',reason:''})):[]);
  const variantsHtml=variants.length>1
    ?`<div class="detailnote"><b>ВАРИАНТЫ ЭФИРНОЙ ФОРМУЛИРОВКИ</b><br>${variants.map((x,index)=>`<button class="act variantpick" data-variant="${index}" style="margin:6px 6px 0 0;text-align:left">${esc(displayText(x.title))}</button>${x.reason?`<small style="display:block;margin:2px 0 7px">${esc(displayText(x.reason))}</small>`:''}`).join('')}</div>`
    :'';
  $('#previewcard').innerHTML=`<div class="detailfact">${esc(factText(c))}</div>${c?.broadcast_detail?`<div class="detailnote">${esc(displayText(c.broadcast_detail))}</div>`:''}<div class="detailmarket">${esc(marketDescription(c,cardTeam(c)))} · ${Number.isFinite(Number(c?.market?.odds))?Number(c.market.odds).toFixed(2):'нет линии'}</div><div class="detailrows">${detailRows.map(r=>`<div><span>${esc(r[0])}</span><b>${esc(r[1])}</b></div>`).join('')}</div>${operatorHtml}${variantsHtml}<div class="detailnote">${esc(c?.explanation||c?.note||'')}</div>`;
  document.querySelector('.dtitle').textContent='РАСШИРЕННАЯ АНАЛИТИКА';
  document.querySelector('.dfoot').textContent='Короткая версия идёт в эфир. Здесь оператор видит исходную метрику, сравнение команд, форму, выборку и связь с реальной линией WINLINE.';
  $('#drawer').classList.add('open');
  document.querySelectorAll('.variantpick').forEach(btn=>btn.onclick=()=>{
    const picked=variants[Number(btn.dataset.variant)];
    if(!picked?.title)return;
    c.broadcast_title=picked.title;
    if(picked.subtitle)c.broadcast_subtitle=picked.subtitle;
    c.broadcast_angle_id=picked.id||null;
    c.broadcast_angle_family=picked.family||null;
    c.broadcast_angle_reason=picked.reason||null;
    if(c.operator_narrative&&typeof c.operator_narrative==='object'){
      const prefix='Почему выбрана эта эфирная подача:';
      const details=Array.isArray(c.operator_narrative.details)
        ?c.operator_narrative.details.filter(x=>!String(x||'').startsWith(prefix))
        :[];
      if(picked.reason)details.unshift(prefix+' '+picked.reason+'.');
      c.operator_narrative={
        ...c.operator_narrative,
        details,
        raw:{...(c.operator_narrative.raw||{}),selected_broadcast_angle:picked}
      };
    }
    renderCards(currentCards);
    openCardDetails(i);
  });
}
async function ensureDraft(c){
  if(c.__cardId&&c.__persisted)return c.__cardId;
  const d=await operatorApi('/api/broadcast/operator/drafts/from-insight',{method:'POST',body:JSON.stringify({game_pk:Number(selected),card:c,...identity()})});
  c.__cardId=d.card?.card_id||d.card_id||c.__cardId;
  if(!c.__cardId)throw new Error('Не удалось создать эфирную карточку');
  c.__status=d.card?.status||'draft';
  c.__persisted=true;
  c.__renderHash=d.card?.render_hash||null;
  syncPersistedCard(d.card);
  return c.__cardId;
}
async function setBroadcastStatus(c,status){
  const id=await ensureDraft(c);
  const d=await operatorApi('/api/broadcast/operator/cards/'+encodeURIComponent(id)+'/status',{method:'POST',body:JSON.stringify({status,card:status==='shown'?c:undefined,...identity()})});
  c.__status=d.card?.status||status;
  c.__renderHash=d.card?.render_hash||c.__renderHash||null;
  syncPersistedCard(d.card);
  syncGameOnAir(id,c.__status);
  const s=await api('/api/broadcast/state?game='+encodeURIComponent(selected));
  renderAir(s.on_air);
  await refreshActions();
  return d;
}
async function toggleShow(i,b){
  const c=currentCards[i];if(!c)return;
  b.disabled=true;
  const old=b.textContent;
  try{
    if(c.__status==='shown'){
      b.textContent='СНИМАЮ…';
      await setBroadcastStatus(c,'hidden');
    }else{
      b.textContent='ГЕНЕРАЦИЯ…';
      await ensureDraft(c);
      await setBroadcastStatus(c,'shown');
    }
    renderCards(currentCards);
  }catch(e){
    alert(e.message);
    b.textContent=old;
  }finally{
    b.disabled=false;
  }
}

async function refreshActions(){
  try{
    const d=await operatorApi('/api/broadcast/operator/actions?limit=24');
    renderActions(d.actions||[]);
  }catch(e){
    const el=$('#actionlog');if(el&&!el.children.length)el.innerHTML='<div class="empty">Журнал действий недоступен</div>';
  }
}
function renderActions(rows){
  const el=$('#actionlog');if(!el)return;
  el.innerHTML=rows.length?rows.slice(0,24).map(a=>{
    const teams=[a.away_tri,a.home_tri].filter(Boolean).join(' · ')||String(a.game_pk||'');
    const action=String(a.action)==='shown'?'ПОКАЗАЛ':'СНЯЛ';
    const time=a.created_at?new Date(String(a.created_at).replace(' ','T')+'Z').toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}):'';
    return `<div class="actionrow"><div class="actiontime">${esc(time)}</div><div><div class="actionmain"><b>${esc(a.operator_name||'Оператор')}</b> · ${action}</div><div class="actionmeta">${esc(teams)} · ${esc(displayText(a.headline_ru||a.stat_text_ru||''))}</div></div></div>`;
  }).join(''):'<div class="empty">Пока никто не давал плашки</div>';
}
function renderPlayers(rows){$('#players').innerHTML=`<div class="prow head"><div>Игрок</div><div class="num">Г</div><div class="num">П</div><div class="num">О</div><div class="num">Бр</div></div>`+(rows.length?rows.slice(0,10).map(p=>`<div class="prow"><div><div class="pname">${esc(p.full_name_ru||p.full_name_en)}</div><div class="pmeta">${esc(p.team_tri)} · ${esc(p.position_code||'—')} · #${esc(p.sweater_number??'—')}</div></div><div class="num">${p.goals??0}</div><div class="num">${p.assists??0}</div><div class="num">${p.points??0}</div><div class="num">${p.shots??'—'}</div></div>`).join(''):'<div class="empty">Нет статистики</div>')}
function renderEvents(rows){$('#events').innerHTML=rows.length?rows.slice(0,18).map(e=>`<div class="event"><div class="etime">P${esc(e.period_number??'—')} ${esc(e.time_in_period||'')}</div><div><div class="etype">${e.event_type==='goal'||e.event_type==='shootout-goal'?'ГОЛ':e.event_type==='penalty'?'УДАЛЕНИЕ':'КОНЕЦ ПЕРИОДА'}${e.team_tri?' · '+esc(e.team_tri):''}</div><div class="edesc">${esc(e.description||peopleText(e.people)||'')}</div></div><div class="escore">${e.away_score??''}${e.away_score!==null&&e.away_score!==undefined?':':''}${e.home_score??''}</div></div>`).join(''):'<div class="empty">Нет ключевых событий</div>'}
function peopleText(v){return String(v||'').split(';;').map(x=>x.split('|')[0]).filter(Boolean).join(', ')}
$('#close').onclick=()=>$('#drawer').classList.remove('open');$('#drawer').onclick=e=>{if(e.target===$('#drawer'))$('#drawer').classList.remove('open')};$('#overlay-copy').onclick=async()=>{if(!selected)return;const b=$('#overlay-copy'),old=b.textContent;try{await navigator.clipboard.writeText(absoluteOverlayUrl(selected));b.textContent='URL СКОПИРОВАН';setTimeout(()=>{b.textContent=old},1400)}catch{prompt('Скопируй URL overlay для OBS',absoluteOverlayUrl(selected))}};window.addEventListener('pagehide',()=>{if(selected)fetch('/api/broadcast/operator/leases/'+selected,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({operator_id:operatorId}),keepalive:true}).catch(()=>{})});load();

}

const DASHBOARD_HTML=String.raw`<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HOH Broadcast Control</title>
<style>
${BROADCAST_CARD_CSS}
.airmeta{display:flex;align-items:center;gap:7px;padding:8px 14px 7px;border-bottom:1px solid #29292f;font-size:10px}.airmeta>b{font-size:15px;min-width:28px}.airmeta>strong{font-size:9px;letter-spacing:.08em}.airmeta>div{display:flex;gap:5px;margin-left:auto;flex-wrap:wrap;justify-content:flex-end}.airmeta span{font-size:8px;color:#9a9aa2;border:1px solid #303037;border-radius:999px;padding:3px 6px}.airmeta.great>b,.airmeta.great>strong{color:var(--green)}.airmeta.good>b,.airmeta.good>strong{color:#d8ef9d}.airmeta.mid>b,.airmeta.mid>strong{color:#ffd28a}.airmeta.low>b,.airmeta.low>strong{color:#8b8b94}.signal-detail{padding:0 14px 9px;color:#7f7f88;font-size:9px;letter-spacing:.02em}

:root{--bg:#080808;--side:#0b0b0c;--panel:#111113;--panel2:#17171a;--line:#2a2a2f;--text:#f8f8f6;--muted:#85858d;--orange:#ff5a1f;--lav:#c8b7ff;--lav2:#7869a7;--green:#83e6b1;--red:#ff6161}.overlaytools{display:flex;gap:7px;align-items:center;margin-top:10px;flex-wrap:wrap}.overlayopen,.overlaycopy{font-size:8px;font-weight:950;letter-spacing:.08em;border-radius:8px;padding:8px 10px;text-decoration:none}.overlayopen{background:#f1f1f0;color:#0b0b0d}.overlaycopy{border:1px solid #35353b;background:#17171a;color:#aaaab2;cursor:pointer}.overlaycopy:hover{color:#fff;border-color:#55555e}
*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:var(--bg);color:var(--text);font-family:Inter,Arial,sans-serif}body{overflow-x:hidden}button{font:inherit}
.app{display:grid;grid-template-columns:290px minmax(0,1fr);min-height:100vh}.side{position:sticky;top:0;height:100vh;overflow:auto;border-right:1px solid var(--line);background:var(--side);padding:20px 16px}.brand{display:flex;align-items:center;justify-content:space-between;margin-bottom:26px}.brandname{display:flex;align-items:center;gap:10px;font-size:15px;font-weight:950}.mark{width:18px;height:18px;border-radius:4px;background:var(--orange);box-shadow:10px 0 0 var(--lav)}.alpha{font-size:9px;letter-spacing:.15em;color:#777;border:1px solid #29292e;padding:5px 8px;border-radius:99px}.label{font-size:9px;font-weight:900;letter-spacing:.16em;color:#67676f;text-transform:uppercase;margin:18px 6px 8px}.nav{display:grid;gap:4px}.navitem{padding:11px 12px;border-radius:11px;color:#9a9aa1;display:flex;align-items:center;gap:10px;text-decoration:none;cursor:pointer;border:0;background:transparent;font:inherit;text-align:left}.navitem:hover{background:#141416;color:#fff}.navitem.active{background:#1a1a1d;color:#fff}.dot{width:7px;height:7px;border-radius:50%;background:#53535a}.active .dot{background:var(--orange);box-shadow:0 0 0 5px rgba(255,90,31,.1)}.soon{margin-left:auto;font-size:10px;color:#555}.sidecount{font-size:10px;color:#6f6f76;margin:0 6px 10px}.games{display:grid;gap:5px}
.gamegroup{border:1px solid #242429;border-radius:12px;background:#0d0d0f;overflow:hidden}.gamegroup+.gamegroup{margin-top:4px}.grouphead{list-style:none;display:grid;grid-template-columns:1fr auto 16px;align-items:center;gap:8px;padding:10px 11px;color:#9b9ba4;font-size:10px;font-weight:950;letter-spacing:.11em;text-transform:uppercase;cursor:pointer;user-select:none}.grouphead::-webkit-details-marker{display:none}.grouphead:hover{background:#151517;color:#fff}.groupcount{min-width:23px;text-align:center;color:#777780;border:1px solid #2d2d33;border-radius:999px;padding:2px 6px;font-size:9px;letter-spacing:0}.groupchev{font-size:15px;line-height:1;color:#666;transform:rotate(0deg);transition:transform .15s ease}.gamegroup[open] .groupchev{transform:rotate(180deg)}.grouprows{border-top:1px solid #202024;padding:4px}.grouprows .game{width:100%}
.game{border:1px solid transparent;border-radius:12px;background:transparent;color:inherit;padding:10px 11px;text-align:left;cursor:pointer}.game:hover{background:#141416}.game.active{background:#19191c;border-color:#35353b}.gline{display:flex;justify-content:space-between;gap:8px;align-items:center}.gteams{font-size:13px;font-weight:900}.gscore{font-size:18px;font-weight:950}.gmeta{display:flex;justify-content:space-between;gap:8px;margin-top:5px;color:#74747b;font-size:10px}.pill{font-size:8px;color:var(--lav);padding:3px 5px;background:rgba(200,183,255,.08);border-radius:5px;text-transform:uppercase}
.main{padding:22px 26px 40px;min-width:0;background:radial-gradient(circle at 88% -8%,rgba(200,183,255,.10),transparent 26%),radial-gradient(circle at 25% 110%,rgba(255,90,31,.07),transparent 34%)}.top{display:grid;grid-template-columns:1fr 360px;gap:14px;margin-bottom:16px}.heading{padding:5px 2px}.heading h1{font-size:13px;letter-spacing:.17em;margin:0;text-transform:uppercase}.heading p{margin:6px 0 0;color:#777;font-size:11px}.air{border:1px solid var(--line);background:#0f0f11;border-radius:14px;padding:12px 14px;display:flex;align-items:center;justify-content:space-between;gap:12px}.airtag{display:flex;align-items:center;gap:8px;font-size:10px;font-weight:900;letter-spacing:.12em}.airdot{width:8px;height:8px;border-radius:50%;background:#45454c}.air.live .airdot{background:var(--red);box-shadow:0 0 12px rgba(255,97,97,.7)}.airtext{font-size:11px;color:#8c8c94;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px}
.hero{border:1px solid var(--line);border-radius:20px;background:linear-gradient(135deg,#111113,#0f0f11 65%,#18141f);overflow:hidden}.herohead{display:flex;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--line);font-size:10px;color:#777}.match{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;padding:22px 26px;gap:20px}.team{display:flex;align-items:center;gap:14px}.team.home{justify-content:flex-end;text-align:right}.logo{width:58px;height:58px;border-radius:16px;border:1px solid #303036;background:#18181a;display:grid;place-items:center;overflow:hidden}.logo img{width:46px;height:46px;object-fit:contain}.fallback{font-size:18px;font-weight:950}.code{font-size:27px;font-weight:950;letter-spacing:-.05em}.name{margin-top:3px;color:#777;font-size:10px}.score{font-size:56px;font-weight:950;letter-spacing:-.08em}.score span{color:#46464d;margin:0 5px}.periods{text-align:center;color:var(--lav);font-size:9px;font-weight:900;letter-spacing:.09em;padding:0 18px 15px;text-transform:uppercase}
.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:10px 0 14px}.metric{border:1px solid var(--line);background:#101012;border-radius:14px;padding:13px 14px}.mval{font-size:22px;font-weight:950;letter-spacing:-.05em}.mlabel{font-size:9px;color:#696970;letter-spacing:.12em;text-transform:uppercase;margin-top:4px}
.work{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(330px,.65fr);gap:14px}.panel{border:1px solid var(--line);background:#0f0f11;border-radius:18px;overflow:hidden}.phead{padding:14px 16px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:10px}.ptitle{font-size:12px;font-weight:900}.psub{font-size:9px;color:#666}.cards{padding:12px;display:block}.queueblock+.queueblock{margin-top:12px}.queuehead,.queue-more>summary{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 2px 8px;color:#b7b7bf;font-size:9px;font-weight:950;letter-spacing:.12em;text-transform:uppercase}.queuehead b{min-width:22px;text-align:center;border:1px solid #34343b;border-radius:999px;padding:2px 6px;color:var(--green);letter-spacing:0}.queuehead.muted{color:#686870}.queue-more>summary{cursor:pointer;list-style:none;border-top:1px solid #28282d;padding-top:12px}.queue-more>summary::-webkit-details-marker{display:none}.queue-more>summary small{font-size:8px;color:#696971;letter-spacing:.04em}.cardgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.card{border:1px solid #303036;border-radius:15px;background:#171719;overflow:hidden;position:relative}.card.featured{border-color:#44444d;box-shadow:0 0 0 1px rgba(131,230,177,.05)}.card.weak{opacity:.66}.card.weak:hover{opacity:.9}.card:before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--orange)}.card.lav:before{background:var(--lav)}.cardbody{padding:14px 15px 11px}.eyebrow{font-size:9px;color:#7c7c85;font-weight:900;letter-spacing:.13em}.cvalue{font-size:29px;font-weight:950;letter-spacing:-.06em;margin-top:12px}.ctitle{font-size:12px;font-weight:850;margin-top:8px}.cnote{font-size:9px;color:#73737b;margin-top:6px}.actions{display:grid;grid-template-columns:1fr 1.2fr;border-top:1px solid #29292e}.act{border:0;background:transparent;color:#aaa;padding:10px 8px;font-size:9px;font-weight:900;letter-spacing:.08em;cursor:pointer}.act:hover{background:#202024;color:#fff}.show{color:#111;background:var(--orange)}.show:hover{background:#ff6b36}.show[disabled]{background:#26262a;color:#64646b;cursor:not-allowed}.kind{position:absolute;right:10px;top:9px;font-size:8px;color:#65656d;text-transform:uppercase}
.rightcol{display:grid;gap:14px;align-content:start}.roomstate{display:inline-flex;align-items:center;gap:5px}.roomop{max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#8d8d95}.gqueue{margin-top:6px;min-height:16px;display:flex;align-items:center}.strongpill{display:inline-block;font-size:8px;color:#0c1a12;background:var(--green);border-radius:999px;padding:3px 7px;font-weight:950;letter-spacing:.06em}.noline{font-size:8px;color:#777780;font-weight:850;letter-spacing:.06em}.summarywait{font-size:8px;color:#4f4f56;letter-spacing:.05em}.actionlog{padding:4px 14px 12px;max-height:300px;overflow:auto}.actionrow{display:grid;grid-template-columns:38px 1fr;gap:8px;padding:9px 0;border-bottom:1px solid #242428}.actiontime{font-size:9px;color:var(--lav);font-weight:900}.actionmain{font-size:9px;color:#d7d7db}.actionmain b{color:#fff}.actionmeta{font-size:8px;color:#71717a;margin-top:3px;line-height:1.35}.players{padding:4px 14px 12px}.prow{display:grid;grid-template-columns:minmax(0,1fr) 28px 28px 28px 34px;gap:5px;align-items:center;padding:10px 0;border-bottom:1px solid #252529}.prow.head{padding:8px 0;color:#666;font-size:8px;text-transform:uppercase}.pname{font-size:10px;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pmeta{font-size:8px;color:#6f6f76;margin-top:2px}.num{text-align:center;font-size:10px;font-weight:850}.events{padding:4px 14px 12px;max-height:310px;overflow:auto}.event{display:grid;grid-template-columns:44px 1fr auto;gap:8px;padding:9px 0;border-bottom:1px solid #242428}.etime{font-size:9px;color:var(--lav);font-weight:900}.etype{font-size:9px;font-weight:900}.edesc{font-size:8px;color:#73737b;margin-top:2px;line-height:1.35}.escore{font-size:11px;font-weight:950}.empty{padding:18px;color:#666;font-size:10px}
.detailfact{font-size:18px;font-weight:950;line-height:1.12;margin:12px 0}.detailmarket{font-size:13px;font-weight:900;color:var(--lav);margin:12px 0}.detailrows{border-top:1px solid #2b2b31;border-bottom:1px solid #2b2b31;margin:14px 0}.detailrows>div{display:flex;justify-content:space-between;gap:18px;padding:8px 0;border-bottom:1px solid #232328;font-size:10px}.detailrows>div:last-child{border-bottom:0}.detailrows span{color:#777780}.detailrows b{text-align:right}.detailnote{font-size:10px;color:#8a8a93;line-height:1.45;margin-top:8px}.drawerback{position:fixed;inset:0;background:rgba(0,0,0,.66);display:none;z-index:20}.drawerback.open{display:block}.drawer{position:absolute;right:0;top:0;bottom:0;width:min(520px,92vw);background:#101012;border-left:1px solid #303036;padding:24px;display:flex;flex-direction:column}.dtop{display:flex;justify-content:space-between;align-items:center}.dtitle{font-size:10px;letter-spacing:.16em;font-weight:900;color:#777}.close{border:1px solid #333;background:#171719;color:#aaa;border-radius:9px;padding:7px 10px;cursor:pointer}.preview{margin:auto 0;border-radius:24px;background:linear-gradient(135deg,#151517,#201a27);border:1px solid #37333f;padding:30px}.pvbrand{font-size:10px;letter-spacing:.16em;font-weight:950}.pveyebrow{margin-top:34px;color:var(--lav);font-size:10px;font-weight:900;letter-spacing:.12em}.pvvalue{font-size:58px;font-weight:950;letter-spacing:-.08em;margin-top:10px}.pvtitle{font-size:20px;font-weight:900;margin-top:10px;line-height:1.15}.pvnote{font-size:11px;color:#83838c;margin-top:12px}.dfoot{font-size:10px;color:#74747c;line-height:1.5;padding-top:20px}.legend{display:flex;gap:8px;align-items:center}.safe{display:inline-flex;align-items:center;gap:6px;color:#8d8d94}.safe:before{content:"";width:6px;height:6px;border-radius:50%;background:var(--green)}

/* Fixed HOH × Winline broadcast-card template */
.cards{padding:12px;grid-template-columns:1fr;gap:12px}.card{border:1px solid #303036;border-radius:14px;background:#0d0d0f;overflow-x:auto;overflow-y:hidden;position:relative}.card:before,.card.lav:before,.kind,.cardbody{display:none}
.aircard{--team-color:#00e6c3;position:relative;width:820px;height:196px;min-width:820px;max-width:820px;margin:0 auto;background:transparent;color:#fff;overflow:visible}
.factbar{position:absolute;left:0;width:820px;top:0;height:58px;border:1px solid #5a5a60;border-radius:13px;background:linear-gradient(135deg,#151517,#0b0b0d);display:flex;align-items:center;padding:0 22px 0 36px;overflow:hidden;box-shadow:0 6px 20px rgba(0,0,0,.28)}
.teamstripe{position:absolute;left:0;top:8px;bottom:8px;width:7px;border-radius:5px;background:var(--team-color);box-shadow:0 0 15px color-mix(in srgb,var(--team-color) 65%,transparent)}
.facttext{font-family:"Arial Narrow","Roboto Condensed",Arial,sans-serif;font-size:18px;line-height:1;font-weight:950;letter-spacing:-.02em;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.facthot{color:var(--orange)}
.betpanel{position:absolute;left:0;width:820px;top:66px;height:126px;border:1px solid #5a5a60;border-radius:14px;background:linear-gradient(135deg,#101113,#070809 72%,#101114);overflow:visible;box-shadow:0 8px 25px rgba(0,0,0,.3)}
.teammark{position:absolute;left:0;top:0;width:126px;height:124px;border-right:1px solid #35353a;border-radius:13px 0 0 13px;background:linear-gradient(135deg,color-mix(in srgb,var(--team-color) 20%,#060708),#060708 70%);display:grid;place-items:center;overflow:hidden}.teammark img{width:92px;height:92px;object-fit:contain}.teammark span{font-size:22px;font-weight:950;color:#aaa}
.betcopy{position:absolute;left:126px;top:0;width:276px;height:124px;padding:23px 20px;display:flex;flex-direction:column;justify-content:center;overflow:hidden}.betteam{font-size:30px;line-height:1;font-weight:950;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.betdesc{margin-top:10px;font-size:18px;line-height:1;font-weight:900;color:#d0d0d4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.winlinebrand{position:absolute;left:58%;top:24px;transform:translateX(-50%);width:174px;height:50px;display:grid;place-items:center}.winlineSvg{display:block;width:174px;height:auto}
.oddsbox{position:absolute;right:0;top:-1px;width:148px;height:82px;background:linear-gradient(135deg,#176eff,#0b4df5);color:#fff;clip-path:polygon(12% 0,100% 0,92% 100%,0 100%);display:grid;place-items:center;padding:0 12px 0 22px;font-size:46px;line-height:1;font-weight:950;font-style:italic;letter-spacing:-.055em;border-radius:0 13px 0 0}
.profitbox{position:absolute;right:-1px;bottom:-1px;width:58%;height:50px;border:1px solid #5b5b61;border-radius:13px;background:linear-gradient(135deg,#19191c,#0b0b0d);display:flex;align-items:center;justify-content:center;gap:10px;padding:0 16px;white-space:nowrap;overflow:hidden}.profitbox strong{font-size:20px;color:var(--orange);font-weight:950}.profitbox span{font-size:12px;color:#c9c9ce;font-weight:850}
.actions{height:36px;display:grid;grid-template-columns:1fr 1.2fr;border-top:1px solid #29292e}.act{padding:8px;font-size:9px}.show{background:#29292e;color:#a8a8ae}.show:hover{background:var(--orange);color:#111}.hide{background:#35171a;color:#ff8f8f}.noln{background:#17171a;color:#666;cursor:not-allowed}.drawer{width:min(930px,96vw)}.preview{margin:auto 0;background:transparent;border:0;border-radius:0;padding:18px;overflow:auto}.preview .aircard{width:820px;height:196px;min-width:820px;max-width:820px;margin:auto}
@media(max-width:1100px){.app{grid-template-columns:240px 1fr}.work{grid-template-columns:1fr}.rightcol{grid-template-columns:1fr 1fr}.top{grid-template-columns:1fr}.air{max-width:none}.metrics{grid-template-columns:repeat(2,1fr)}}
@media(max-width:760px){.app{display:block}.side{position:relative;height:auto}.main{padding:16px}.match{grid-template-columns:1fr auto 1fr;padding:18px 12px}.logo{display:none}.score{font-size:42px}.code{font-size:22px}.cardgrid{grid-template-columns:1fr}.rightcol{grid-template-columns:1fr}.metrics{grid-template-columns:1fr 1fr}}

#cards .card:before{content:none}
#cards .card{padding-top:0}
#cards .hohcard{width:100%;max-width:820px}
.signal{width:100%;max-width:820px;margin:0 auto;background:#0e0e11;border:1px solid #303036;border-radius:12px;overflow:hidden}
.signal-fact{padding:13px 16px 11px;font-size:15px;font-weight:900;line-height:1.25;border-bottom:1px solid #29292e;color:#f5f5f4}
.signal-main{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:12px 14px 8px 16px}
.signal-copy{min-width:0}.signal-team{font-size:22px;font-weight:950;line-height:1.05}.signal-market{margin-top:5px;color:#aaaab1;font-size:13px;font-weight:800}
.signal-price{flex:0 0 auto;min-width:104px;text-align:center;padding:10px 16px;border-radius:10px;background:#1557f5;color:#fff;font-size:28px;font-weight:950;font-style:italic}
.signal-profit{display:flex;justify-content:flex-end;align-items:center;gap:8px;padding:0 16px 12px;font-size:11px;color:#9b9ba2}.signal-profit b{color:var(--orange);font-size:14px}

.preview .hohcard{width:820px;max-width:100%}\n.renderedcard{width:820px;max-width:100%;aspect-ratio:820/211;margin:0 auto;display:flex;align-items:center;justify-content:center;overflow:hidden}.renderedcard img{display:block;width:100%;height:auto;object-fit:contain}.preview .renderedcard{width:820px;max-width:100%}
</style></head><body>
<div class="app">
<aside class="side">
  <div class="brand"><div class="brandname"><span class="mark"></span>HOME OF HOCKEY</div><span class="alpha">ALPHA</span></div>
  <div class="label">Broadcast control</div>
  <div class="nav"><a class="navitem active" href="#hero"><span class="dot"></span>Матчи</a><a class="navitem" href="#cards-panel"><span class="dot"></span>Карточки</a><a class="navitem" id="overlay-link" href="/broadcast/overlay" target="_blank" rel="noopener"><span class="dot"></span>Overlay матча</a></div>
  <div class="label">Ближайшие матчи NHL</div><div class="sidecount" id="counts">загрузка...</div><div class="games" id="games"></div>
</aside>
<main class="main">
  <div class="top"><div class="heading"><h1>Broadcast Stats / Control Room</h1><p>Реальные данные NHL → HOH Data Core → эфир</p><div class="overlaytools"><a id="overlay-open" class="overlayopen" href="/broadcast/overlay" target="_blank" rel="noopener">ОТКРЫТЬ OVERLAY ЭТОГО МАТЧА ↗</a><button id="overlay-copy" class="overlaycopy" type="button">СКОПИРОВАТЬ URL ДЛЯ OBS</button></div></div><div class="air" id="air"><div class="airtag"><span class="airdot"></span><span>ON AIR</span></div><div class="airtext" id="airtext">Сейчас ничего не показано</div></div></div>
  <section class="hero" id="hero"><div class="empty">Выбираю матч...</div></section>
  <section class="metrics" id="metrics"></section>
  <section class="work">
    <div class="panel" id="cards-panel"><div class="phead"><div><div class="ptitle">Очередь карточек</div><div class="psub">Сигналы: история + live-динамика → подходящий рынок Winline.</div></div><div class="safe">ручной показ</div></div><div class="cards" id="cards"></div></div>
    <div class="rightcol">
      <div class="panel"><div class="phead"><div class="ptitle">Игроки</div><div class="psub">топ по очкам</div></div><div class="players" id="players"></div></div>
      <div class="panel"><div class="phead"><div class="ptitle">События</div><div class="psub">голы / удаления</div></div><div class="events" id="events"></div></div>
      <div class="panel"><div class="phead"><div class="ptitle">Эфирная лента</div><div class="psub">все операторы · все матчи</div></div><div class="actionlog" id="actionlog"></div></div>
    </div>
  </section>
</main></div>
<div class="drawerback" id="drawer"><div class="drawer"><div class="dtop"><div class="dtitle">ПРЕДПРОСМОТР КАРТОЧКИ</div><button class="close" id="close">Закрыть</button></div><div class="preview" id="previewcard"></div><div class="dfoot">PREVIEW подготавливает эту же плашку для эфира. ПОКАЗАТЬ отправляет её в прозрачный overlay.</div></div></div>
<script src="/broadcast/app.js"></script></body></html>`;