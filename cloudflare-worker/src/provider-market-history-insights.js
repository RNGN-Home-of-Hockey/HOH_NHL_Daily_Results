
import { normalizeWinlineMarket } from "./winline-market-adapter.js";
import { regulationGoalsFromScoreboard } from "./regulation-basis.js";

const WINDOWS=[10,20,40];
const MAX_HISTORY=80;

export async function buildProviderMarketHistoryInsights(db,game,providerMarkets=[]){
  if(!db||!game?.scheduled_start_utc||!game?.away_tri||!game?.home_tri||!Array.isArray(providerMarkets)||!providerMarkets.length)return[];

  const [awayR,homeR]=await db.batch([
    history(db,game.away_tri,game.scheduled_start_utc),
    history(db,game.home_tri,game.scheduled_start_utc),
  ]);
  const rowsByTeam={
    [game.away_tri]:prepareHistoryRows(awayR.results||[],game.away_tri,game),
    [game.home_tri]:prepareHistoryRows(homeR.results||[],game.home_tri,game),
  };

  return evaluateProviderMarketHistoryRows(game,rowsByTeam,providerMarkets);
}

export function evaluateProviderMarketHistoryRows(game,rowsByTeam,providerMarkets=[]){
  const markets=dedupeMarkets(
    (providerMarkets||[])
      .filter(m=>!(m?.is_live===true||Number(m?.is_live||0)===1))
      .map(normalizeWinlineMarket)
      .filter(Boolean)
  );

  const preparedRows={
    [game.away_tri]:prepareHistoryRows(rowsByTeam?.[game.away_tri]||[],game.away_tri,game),
    [game.home_tri]:prepareHistoryRows(rowsByTeam?.[game.home_tri]||[],game.home_tri,game),
  };
  const out=[];
  for(const market of markets){
    for(const window of WINDOWS){
      const result=evaluateMarket(market,game,preparedRows,window);
      if(!result)continue;
      if(marketNeedsVerifiedPeriods(market))result.period_data_verified=true;
      const threshold=displayThreshold(market);
      if(result.rate<threshold||result.decisions<minimumDecisions(window))continue;
      out.push(makeCard(game,market,result,window));
    }
  }
  return out.sort((a,b)=>Number(b.score||0)-Number(a.score||0)).slice(0,900);
}

function history(db,team,before){
  return db.prepare(`
    WITH recent AS (
      SELECT f.*,
             g.game_state AS raw_game_state,g.period_type AS raw_game_period_type,
             CASE WHEN f.is_home=1 THEN g.home_score ELSE g.away_score END AS raw_final_goals_for,
             CASE WHEN f.is_home=1 THEN g.away_score ELSE g.home_score END AS raw_final_goals_against
      FROM team_game_features f
      JOIN games g ON g.game_pk=f.game_pk
      WHERE f.team_tri=? AND f.game_type IN (2,3) AND f.scheduled_start_utc<?
        AND UPPER(COALESCE(g.game_state,'')) IN ('FINAL','OFF')
      ORDER BY f.scheduled_start_utc DESC,f.game_pk DESC
      LIMIT ${MAX_HISTORY}
    ),
    event_period AS (
      SELECT ge.game_pk,ge.period_number,ge.team_tri,COUNT(*) AS goals
      FROM game_events ge
      JOIN recent r ON r.game_pk=ge.game_pk
      WHERE ge.event_type='goal' AND ge.period_number BETWEEN 1 AND 3 AND ge.team_tri IS NOT NULL
      GROUP BY ge.game_pk,ge.period_number,ge.team_tri
    ),
    event_final AS (
      SELECT ge.game_pk,ge.team_tri,COUNT(*) AS goals
      FROM game_events ge
      JOIN recent r ON r.game_pk=ge.game_pk
      WHERE ge.event_type='goal' AND ge.team_tri IS NOT NULL
      GROUP BY ge.game_pk,ge.team_tri
    )
    SELECT f.*,
           CASE WHEN f.is_home=1 THEN p1.home_goals ELSE p1.away_goals END AS raw_p1_goals_for,
           CASE WHEN f.is_home=1 THEN p1.away_goals ELSE p1.home_goals END AS raw_p1_goals_against,
           CASE WHEN f.is_home=1 THEN p2.home_goals ELSE p2.away_goals END AS raw_p2_goals_for,
           CASE WHEN f.is_home=1 THEN p2.away_goals ELSE p2.home_goals END AS raw_p2_goals_against,
           CASE WHEN f.is_home=1 THEN p3.home_goals ELSE p3.away_goals END AS raw_p3_goals_for,
           CASE WHEN f.is_home=1 THEN p3.away_goals ELSE p3.home_goals END AS raw_p3_goals_against,
           COALESCE(e1f.goals,0) AS event_p1_goals_for,COALESCE(e1a.goals,0) AS event_p1_goals_against,
           COALESCE(e2f.goals,0) AS event_p2_goals_for,COALESCE(e2a.goals,0) AS event_p2_goals_against,
           COALESCE(e3f.goals,0) AS event_p3_goals_for,COALESCE(e3a.goals,0) AS event_p3_goals_against,
           COALESCE(eff.goals,0) AS event_final_goals_for,COALESCE(efa.goals,0) AS event_final_goals_against
    FROM recent f
    LEFT JOIN period_scores p1 ON p1.game_pk=f.game_pk AND p1.period_number=1 AND p1.period_type='REG'
    LEFT JOIN period_scores p2 ON p2.game_pk=f.game_pk AND p2.period_number=2 AND p2.period_type='REG'
    LEFT JOIN period_scores p3 ON p3.game_pk=f.game_pk AND p3.period_number=3 AND p3.period_type='REG'
    LEFT JOIN event_period e1f ON e1f.game_pk=f.game_pk AND e1f.period_number=1 AND e1f.team_tri=f.team_tri
    LEFT JOIN event_period e1a ON e1a.game_pk=f.game_pk AND e1a.period_number=1 AND e1a.team_tri=f.opponent_tri
    LEFT JOIN event_period e2f ON e2f.game_pk=f.game_pk AND e2f.period_number=2 AND e2f.team_tri=f.team_tri
    LEFT JOIN event_period e2a ON e2a.game_pk=f.game_pk AND e2a.period_number=2 AND e2a.team_tri=f.opponent_tri
    LEFT JOIN event_period e3f ON e3f.game_pk=f.game_pk AND e3f.period_number=3 AND e3f.team_tri=f.team_tri
    LEFT JOIN event_period e3a ON e3a.game_pk=f.game_pk AND e3a.period_number=3 AND e3a.team_tri=f.opponent_tri
    LEFT JOIN event_final eff ON eff.game_pk=f.game_pk AND eff.team_tri=f.team_tri
    LEFT JOIN event_final efa ON efa.game_pk=f.game_pk AND efa.team_tri=f.opponent_tri
    ORDER BY f.scheduled_start_utc DESC,f.game_pk DESC;
  `).bind(team,before);
}

function prepareHistoryRows(rows,team,game){
  const seen=new Set(),out=[];
  for(const raw of rows||[]){
    const pk=Number(raw?.game_pk);
    if(!Number.isSafeInteger(pk)||pk<=0||seen.has(pk))continue;
    if(raw?.team_tri&&String(raw.team_tri).toUpperCase()!==String(team||"").toUpperCase())continue;
    seen.add(pk);
    const periodCheck=verifyRawPeriods(raw),finalCheck=verifyRawFinal(raw);
    const reg=regulationView(raw,periodCheck,finalCheck),streak=streakEligibility(raw,game);
    const prepared={...raw,
      __streak_eligible:streak.eligible,__streak_prev_season:streak.previousSeason,
      __period_verified:periodCheck.ok,__period_validation:periodCheck.reason,
      __final_verified:finalCheck.ok,__final_validation:finalCheck.reason,
      __reg_verified:reg.ok,__reg_validation:reg.reason,__reg_gf:reg.gf,__reg_ga:reg.ga
    };
    if(finalCheck.ok){
      prepared.final_goals_for=finalCheck.gf;prepared.final_goals_against=finalCheck.ga;
      prepared.total_goals=finalCheck.gf+finalCheck.ga;prepared.final_goal_diff=finalCheck.gf-finalCheck.ga;prepared.final_win=finalCheck.gf>finalCheck.ga?1:0;
    }
    if(periodCheck.ok){
      for(let p=1;p<=3;p++){
        prepared[`p${p}_goals_for`]=periodCheck.periods[p-1].gf;
        prepared[`p${p}_goals_against`]=periodCheck.periods[p-1].ga;
      }
    }
    out.push(prepared);
  }
  return out.sort((a,b)=>String(b.scheduled_start_utc||"").localeCompare(String(a.scheduled_start_utc||""))||Number(b.game_pk)-Number(a.game_pk));
}
function verifyRawPeriods(row){
  const periods=[];
  for(let p=1;p<=3;p++){
    const gf=finite(row?.[`raw_p${p}_goals_for`]),ga=finite(row?.[`raw_p${p}_goals_against`]);
    const eventGf=finite(row?.[`event_p${p}_goals_for`]),eventGa=finite(row?.[`event_p${p}_goals_against`]);
    const featureGf=finite(row?.[`p${p}_goals_for`]),featureGa=finite(row?.[`p${p}_goals_against`]);
    if(!Number.isInteger(gf)||!Number.isInteger(ga)||gf<0||ga<0)return {ok:false,reason:"missing_raw_period_scores",periods:[]};
    if(!Number.isInteger(eventGf)||!Number.isInteger(eventGa)||eventGf<0||eventGa<0)return {ok:false,reason:"missing_goal_event_counts",periods:[]};
    if(featureGf!==gf||featureGa!==ga)return {ok:false,reason:"feature_period_mismatch",periods:[]};
    if(eventGf!==gf||eventGa!==ga)return {ok:false,reason:"goal_event_period_mismatch",periods:[]};
    periods.push({gf,ga});
  }
  const regGf=finite(row?.regulation_goals_for),regGa=finite(row?.regulation_goals_against),regDiff=finite(row?.regulation_goal_diff);
  const sumGf=periods.reduce((s,x)=>s+x.gf,0),sumGa=periods.reduce((s,x)=>s+x.ga,0);
  if(regGf===null||regGa===null||regDiff===null||sumGf!==regGf||sumGa!==regGa||sumGf-sumGa!==regDiff)return {ok:false,reason:"period_regulation_mismatch",periods:[]};
  return {ok:true,reason:"period_scores+goal_events+feature+regulation",periods};
}
function verifyRawFinal(row){
  const state=String(row?.raw_game_state||"").toUpperCase(),periodType=String(row?.raw_game_period_type||"").toUpperCase();
  const gf=finite(row?.raw_final_goals_for),ga=finite(row?.raw_final_goals_against);
  const featureGf=finite(row?.final_goals_for),featureGa=finite(row?.final_goals_against);
  const eventGf=finite(row?.event_final_goals_for),eventGa=finite(row?.event_final_goals_against);
  if(!["FINAL","OFF"].includes(state))return {ok:false,reason:"game_not_final"};
  if(!Number.isInteger(gf)||!Number.isInteger(ga)||gf<0||ga<0)return {ok:false,reason:"missing_canonical_final_score"};
  if(featureGf!==gf||featureGa!==ga)return {ok:false,reason:"feature_final_score_mismatch"};
  if(!Number.isInteger(eventGf)||!Number.isInteger(eventGa)||eventGf<0||eventGa<0)return {ok:false,reason:"missing_final_goal_events"};
  if(periodType==="SO"){
    const homeLikeWin=gf===eventGf+1&&ga===eventGa,awayLikeWin=ga===eventGa+1&&gf===eventGf;
    if(eventGf!==eventGa||(!homeLikeWin&&!awayLikeWin))return {ok:false,reason:"shootout_final_mismatch"};
  }else if(periodType==="REG"||periodType==="OT"){
    if(eventGf!==gf||eventGa!==ga)return {ok:false,reason:"goal_event_final_mismatch"};
  }else return {ok:false,reason:"unsupported_final_period_type"};
  return {ok:true,reason:"games+goal_events+feature_final",gf,ga};
}
function marketNeedsVerifiedPeriods(m){
  const type=String(m?.market_type||""),period=String(m?.period||"GAME").toUpperCase();
  return period==="REG"||/^P[123]$/.test(period)||/^period_[123]_result$/.test(type)||type==="highest_scoring_period"||type==="win_all_periods";
}
// The outright winner (Money Line) is settled on the scoreboard result, overtime and shootout included.
function marketNeedsVerifiedFinal(m){
  const type=String(m?.market_type||""),period=String(m?.period||"GAME").toUpperCase();
  if(period!=="GAME")return false;
  return ["moneyline","result_total_combo"].includes(type);
}
// Totals, team totals, handicaps, "both teams to score" and goal buckets settle on regulation time (60 minutes).
function marketNeedsRegulationGoals(m){
  const type=String(m?.market_type||""),period=String(m?.period||"GAME").toUpperCase();
  if(period!=="GAME"&&period!=="REG")return false;
  return ["game_total","team_total","handicap","both_teams_score","team_goal_bucket","result_total_combo"].includes(type);
}
function verifiedRegulationWindow(m,game,rowsByTeam,window){
  if(!marketNeedsRegulationGoals(m))return true;
  const subject=String(m?.subject||"").toUpperCase();
  const sets=subject&&rowsByTeam?.[subject]
    ?[(rowsByTeam[subject]||[]).slice(0,window)]
    :[(rowsByTeam?.[game.away_tri]||[]).slice(0,window),(rowsByTeam?.[game.home_tri]||[]).slice(0,window)];
  return sets.length>0&&sets.every(sample=>sample.length>=Math.min(8,window)&&sample.every(row=>row.__reg_verified===true));
}
// Regulation-time goals of one game, verified two independent ways when both are available:
// (a) the regulation columns checked against period scores, goal events and the feature row,
// (b) the scoreboard result minus the single overtime / shootout goal of the winner.
function regulationView(raw,periodCheck,finalCheck){
  const cols={gf:finite(raw?.regulation_goals_for),ga:finite(raw?.regulation_goals_against)};
  const fromColumns=periodCheck?.ok&&cols.gf!==null&&cols.ga!==null&&cols.gf>=0&&cols.ga>=0?cols:null;
  const fromScoreboard=finalCheck?.ok?regulationGoalsFromScoreboard(finalCheck.gf,finalCheck.ga,raw?.raw_game_period_type):null;
  if(fromColumns&&fromScoreboard){
    if(fromColumns.gf!==fromScoreboard.gf||fromColumns.ga!==fromScoreboard.ga)return {ok:false,reason:"regulation_scoreboard_mismatch",gf:null,ga:null};
    return {ok:true,reason:"period_scores+goal_events+scoreboard",gf:cols.gf,ga:cols.ga};
  }
  if(fromColumns)return {ok:true,reason:"period_scores+goal_events+feature+regulation",gf:cols.gf,ga:cols.ga};
  if(fromScoreboard)return {ok:true,reason:"scoreboard_minus_overtime_goal",gf:fromScoreboard.gf,ga:fromScoreboard.ga};
  return {ok:false,reason:"regulation_not_verifiable",gf:null,ga:null};
}
function regView(row){return row?.__reg_verified===true&&Number.isFinite(row.__reg_gf)&&Number.isFinite(row.__reg_ga)?{gf:row.__reg_gf,ga:row.__reg_ga}:null}
// A run of wins that began last season is still one run: the previous season (regular season and playoffs,
// never preseason) counts towards the streak.
function streakEligibility(raw,game){
  if(!game?.season_id||!raw?.season_id)return {eligible:true,previousSeason:false};
  const current=String(game.season_id),season=String(raw.season_id);
  if(season===current)return {eligible:true,previousSeason:false};
  const start=Number(current.slice(0,4));
  const previous=Number.isFinite(start)?String(start-1)+String(start):"";
  if(season===previous&&Number(raw.game_type)!==1)return {eligible:true,previousSeason:true};
  return {eligible:false,previousSeason:false};
}
function verifiedFinalWindow(m,game,rowsByTeam,window){
  if(!marketNeedsVerifiedFinal(m))return true;
  const subject=String(m?.subject||"").toUpperCase();
  const sets=subject&&rowsByTeam?.[subject]
    ?[(rowsByTeam[subject]||[]).slice(0,window)]
    :[(rowsByTeam?.[game.away_tri]||[]).slice(0,window),(rowsByTeam?.[game.home_tri]||[]).slice(0,window)];
  return sets.length>0&&sets.every(sample=>sample.length>=Math.min(8,window)&&sample.every(row=>row.__final_verified===true));
}
function verifiedPeriodWindow(m,game,rowsByTeam,window){
  if(!marketNeedsVerifiedPeriods(m))return true;
  const subject=String(m?.subject||"").toUpperCase();
  const sets=subject&&rowsByTeam?.[subject]
    ?[(rowsByTeam[subject]||[]).slice(0,window)]
    :[(rowsByTeam?.[game.away_tri]||[]).slice(0,window),(rowsByTeam?.[game.home_tri]||[]).slice(0,window)];
  return sets.length>0&&sets.every(sample=>sample.length>=Math.min(8,window)&&sample.every(row=>row.__period_verified===true));
}
function validRegulationRow(row){
  const gf=finite(row?.regulation_goals_for),ga=finite(row?.regulation_goals_against),diff=finite(row?.regulation_goal_diff),res=String(row?.regulation_result||"");
  if(gf===null||ga===null||diff===null||gf<0||ga<0||diff!==gf-ga||!["W","L","T"].includes(res))return false;
  return res===(diff>0?"W":diff<0?"L":"T");
}
function validFinalRow(row){
  const gf=finite(row?.final_goals_for),ga=finite(row?.final_goals_against),diff=finite(row?.final_goal_diff),win=finite(row?.final_win);
  return row?.__final_verified===true&&gf!==null&&ga!==null&&diff!==null&&win!==null&&gf>=0&&ga>=0&&diff===gf-ga&&win===(gf>ga?1:0);
}

function evaluateMarket(m,game,rowsByTeam,window){
  const type=String(m.market_type||"");
  if(!verifiedFinalWindow(m,game,rowsByTeam,window)||!verifiedRegulationWindow(m,game,rowsByTeam,window)||!verifiedPeriodWindow(m,game,rowsByTeam,window))return null;
  const period=String(m.period||"GAME");
  const side=String(m.side||"").toLowerCase();
  const subject=String(m.subject||"").toUpperCase()||null;
  const line=finite(m.line);

  if(type==="game_total"){
    return combinedTeamSlices(game,rowsByTeam,window,row=>{
      const total=periodTotal(row,period);
      if(total===null||line===null)return null;
      return settleTotal(total,side,line);
    });
  }

  if(type==="team_total"&&subject&&rowsByTeam[subject]){
    return oneTeamSlice(rowsByTeam[subject],window,row=>{
      const goals=periodGoalsFor(row,period);
      if(goals===null||line===null)return null;
      return settleTotal(goals,side,line);
    });
  }

  if(type==="handicap"&&subject&&rowsByTeam[subject]){
    return oneTeamSlice(rowsByTeam[subject],window,row=>{
      const diff=periodGoalDiff(row,period);
      if(diff===null||line===null)return null;
      return settleHandicap(diff,line);
    });
  }

  if(type==="moneyline"){
    if(side==="draw"||!subject){
      return combinedTeamSlices(game,rowsByTeam,window,row=>{
        if(period==="REG")return String(row.regulation_result)==="T"?"win":"loss";
        return null;
      });
    }
    if(!rowsByTeam[subject])return null;
    return oneTeamSlice(rowsByTeam[subject],window,row=>{
      if(period==="REG"){if(!validRegulationRow(row))return null;return String(row.regulation_result)==="W"?"win":"loss";}
      if(period==="GAME"){if(!validFinalRow(row))return null;return Number(row.final_win)===1?"win":"loss";}
      return null;
    });
  }

  if(/^period_[123]_result$/.test(type)){
    const p=Number(type.match(/^period_([123])_result$/)?.[1]||period.replace("P",""));
    if(!p)return null;
    if(side==="draw"||!subject){
      return combinedTeamSlices(game,rowsByTeam,window,row=>{
        const d=periodGoalDiff(row,"P"+p);return d===null?null:(d===0?"win":"loss");
      });
    }
    if(!rowsByTeam[subject])return null;
    return oneTeamSlice(rowsByTeam[subject],window,row=>{
      const d=periodGoalDiff(row,"P"+p);return d===null?null:(d>0?"win":"loss");
    });
  }

  if(type==="double_chance"){
    if(side==="no_draw"){
      return combinedTeamSlices(game,rowsByTeam,window,row=>{
        const r=String(row.regulation_result||"");return r?r!=="T"?"win":"loss":null;
      });
    }
    if(side==="team_or_draw"&&subject&&rowsByTeam[subject]){
      return oneTeamSlice(rowsByTeam[subject],window,row=>{
        const r=String(row.regulation_result||"");return r?r!=="L"?"win":"loss":null;
      });
    }
  }

  if(type==="both_teams_score"){
    return combinedTeamSlices(game,rowsByTeam,window,row=>{
      const g=regView(row);if(!g)return null;
      const yes=g.gf>=1&&g.ga>=1;
      return side==="yes"?(yes?"win":"loss"):side==="no"?(yes?"loss":"win"):null;
    });
  }

  if(type==="first_goal_team"&&subject&&rowsByTeam[subject]){
    return oneTeamSlice(rowsByTeam[subject],window,row=>Number(row.first_goal_for)===1?"win":"loss");
  }

  if(type==="team_goal_bucket"&&subject&&rowsByTeam[subject]){
    return oneTeamSlice(rowsByTeam[subject],window,row=>{
      const goals=periodGoalsFor(row,period);if(goals===null)return null;
      if(side==="0_1")return goals<=1?"win":"loss";
      if(side==="2")return goals===2?"win":"loss";
      if(side==="3_plus")return goals>=3?"win":"loss";
      return null;
    });
  }

  if(type==="highest_scoring_period"){
    const target=Number(side.replace("P",""));
    if(!target)return null;
    const source=subject&&rowsByTeam[subject]?rowsByTeam[subject]:null;
    const settle=row=>{
      const values=[1,2,3].map(p=>periodGoalsFor(row,"P"+p));
      if(values.some(v=>v===null))return null;
      const max=Math.max(...values);
      const winners=values.map((v,i)=>v===max?i+1:0).filter(Boolean);
      if(winners.length!==1)return "push";
      return winners[0]===target?"win":"loss";
    };
    return source?oneTeamSlice(source,window,settle):combinedTeamSlices(game,rowsByTeam,window,settle);
  }

  if(type==="win_all_periods"&&subject&&rowsByTeam[subject]){
    return oneTeamSlice(rowsByTeam[subject],window,row=>{
      for(let p=1;p<=3;p++){const d=periodGoalDiff(row,"P"+p);if(d===null)return null;if(d<=0)return "loss";}
      return "win";
    });
  }

  if(type==="result_total_combo"&&subject&&rowsByTeam[subject]&&line!==null){
    return oneTeamSlice(rowsByTeam[subject],window,row=>{
      if(Number(row.final_win)!==1)return "loss";
      const g=regView(row);if(!g)return null;
      return settleTotal(g.gf+g.ga,side,line);
    });
  }

  return null;
}

function oneTeamSlice(rows,window,settler){
  const sample=(rows||[]).slice(0,window);
  if(sample.length<Math.min(8,window))return null;
  return aggregate(sample,settler,{perspectives:1});
}

function combinedTeamSlices(game,rowsByTeam,window,settler){
  const away=(rowsByTeam[game.away_tri]||[]).slice(0,window);
  const home=(rowsByTeam[game.home_tri]||[]).slice(0,window);
  if(away.length<Math.min(8,window)||home.length<Math.min(8,window))return null;
  const a=aggregate(away,settler,{perspectives:1});
  const h=aggregate(home,settler,{perspectives:1});
  if(!a||!h)return null;

  // A recent head-to-head can occur in both team slices. Count that game once
  // in the combined hit-rate, while retaining each team's separate perspective
  // for the operator explanation.
  const uniqueRows=new Map();
  for(const row of [...away,...home]){
    const key=Number(row?.game_pk);
    if(Number.isFinite(key)&&!uniqueRows.has(key))uniqueRows.set(key,row);
  }
  const combined=aggregate([...uniqueRows.values()],settler,{perspectives:2});
  if(!combined)return null;
  return {
    ...combined,
    away:{hits:a.hits,decisions:a.decisions,pushes:a.pushes,rate:a.rate,sample:a.sample},
    home:{hits:h.hits,decisions:h.decisions,pushes:h.pushes,rate:h.rate,sample:h.sample},
  };
}

function aggregate(rows,settler,extra={}){
  let hits=0,losses=0,pushes=0,current_streak=0,streakOpen=true,streak_cross_season=false,recentHits=0,recentDecisions=0;
  const game_pks=[],streak_game_pks=[];
  for(const row of rows){
    const result=settler(row);
    if(result===null||result===undefined){if(streakOpen)streakOpen=false;continue;}
    game_pks.push(Number(row.game_pk));
    // rows are newest first: the first 8 decided games are the latest form
    if((result==="win"||result==="loss")&&recentDecisions<8){recentDecisions++;if(result==="win")recentHits++;}
    if(result==="win"){
      hits++;
      if(streakOpen&&row.__streak_eligible===true){current_streak++;streak_game_pks.push(Number(row.game_pk));if(row.__streak_prev_season===true)streak_cross_season=true;}
      else if(streakOpen)streakOpen=false;
    }else if(result==="push"){
      pushes++;
      streakOpen=false;
    }else{
      losses++;
      streakOpen=false;
    }
  }
  const decisions=hits+losses,sample=hits+losses+pushes;
  if(!sample||!decisions)return null;
  return {hits,losses,pushes,decisions,sample,rate:hits/decisions,current_streak,streak_verified:current_streak>0&&streak_game_pks.length===current_streak,streak_game_pks,streak_cross_season,game_pks,
    // only meaningful for one team's own games (a combined two-team slice has no single "latest 8")
    recent_form:extra.perspectives===1&&decisions>8&&recentDecisions===8?{window:8,hits:recentHits,decisions:8}:null,...extra};
}

function makeCard(game,m,r,window){
  const score=qualityScore(m,r,window);
  const title=marketHistoryTitle(m,r,window);
  return {
    id:`${game.game_pk}:provider-history:${marketKey(m)}:w${window}`,
    insight_type:"provider_exact_history",
    category:"provider_history",
    kind:"history",
    timing:"pregame",
    score,
    eyebrow:eyebrow(m,window),
    value:`${r.hits}/${r.decisions}`,
    title,
    explanation:operatorExplanation(m,r,game),
    evidence:{
      window,
      sample:r.sample,
      decisions:r.decisions,
      hits:r.hits,
      losses:r.losses,
      pushes:r.pushes,
      hit_rate:r.rate,
      current_streak:r.current_streak||0,
      streak_verified:r.streak_verified===true,
      streak_game_pks:r.streak_game_pks||[],
      streak_cross_season:r.streak_cross_season===true,
      ...(r.recent_form?{recent_form:r.recent_form}:{}),
      stats_validation:"exact_market_v7_regulation_goal_events",
      goal_basis:marketNeedsRegulationGoals(m)?"regulation":"scoreboard",
      regulation_data_verified:marketNeedsRegulationGoals(m)?true:null,
      final_data_verified:marketNeedsVerifiedFinal(m)?true:null,
      final_validation:marketNeedsVerifiedFinal(m)?"games+goal_events+feature_final":null,
      period_data_verified:marketNeedsVerifiedPeriods(m)?r.period_data_verified===true:null,
      period_validation:marketNeedsVerifiedPeriods(m)?"period_scores+goal_events+feature+regulation":null,
      history_scope:"official_nhl_games_regular_plus_playoffs",
      away:r.away||null,
      home:r.home||null,
      exact_provider_line:true,
      provider_market_key:marketKey(m),
      game_pks:r.game_pks,
      feature_layer:"provider_exact_market_history_v1",
    },
    market:{
      type:m.market_type,period:m.period,subject:m.subject,side:m.side,line:m.line,
      label:marketLabel(m),
      odds:m.odds,provider:m.provider,odds_is_demo:false,odds_source:"provider_live",
      event_id:m.event_id,market_id:m.market_id,selection_id:m.selection_id,updated_at:m.updated_at,deeplink:m.deeplink,
    },
  };
}

function displayThreshold(m){
  const type=String(m.market_type||"");
  const side=String(m.side||"").toLowerCase();
  if((type==="moneyline"||/^period_[123]_result$/.test(type))&&side==="draw")return .34;
  if(type==="highest_scoring_period")return .34;
  if(type==="win_all_periods")return .18;
  if(type==="result_total_combo")return .35;
  if(type==="team_goal_bucket")return .45;
  if(type==="double_chance")return .62;
  return .58;
}
function minimumDecisions(window){return window>=40?24:window>=20?14:7}
function qualityScore(m,r,window){
  const sampleBonus=window>=40?9:window>=20?6:3;
  const perspectives=r.perspectives===2?5:0;
  const pushPenalty=Math.min(8,r.pushes*1.5);
  const price=Number(m.odds);
  const priceBonus=Number.isFinite(price)&&price>=1.55&&price<=3?5:0;
  return Math.max(55,Math.min(97,Math.round(56+r.rate*26+sampleBonus+perspectives+priceBonus-pushPenalty)));
}

function eyebrow(m,window){
  const type=String(m.market_type||"");
  const period=String(m.period||"GAME");
  const prefix=period==="P1"?"1-Й ПЕРИОД":period==="P2"?"2-Й ПЕРИОД":period==="P3"?"3-Й ПЕРИОД":period==="REG"?"60 МИНУТ":"ТОЧНАЯ ЛИНИЯ";
  const family=
    type==="game_total"?"ТОТАЛ":
    type==="team_total"?"КОМАНДНЫЙ ТОТАЛ":
    type==="handicap"?"ФОРА":
    type==="moneyline"||/^period_[123]_result$/.test(type)?"ИСХОД":
    type==="double_chance"?"ДВОЙНОЙ ШАНС":
    type==="both_teams_score"?"ОБЕ ЗАБЬЮТ":
    type==="first_goal_team"?"ПЕРВЫЙ ГОЛ":
    type==="team_goal_bucket"?"ГОЛЫ КОМАНДЫ":
    type==="highest_scoring_period"?"РЕЗУЛЬТАТИВНЫЙ ПЕРИОД":
    type==="win_all_periods"?"ВСЕ ПЕРИОДЫ":
    type==="result_total_combo"?"ПОБЕДА + ТОТАЛ":"WINLINE";
  return `${prefix} · ${family} · ${window} МАТЧЕЙ`;
}

function marketHistoryTitle(m,r,window){
  const t=String(m.market_type||""),p=String(m.period||"GAME"),s=String(m.subject||""),side=String(m.side||"").toLowerCase(),line=finite(m.line);
  const count=`${r.hits} ИЗ ${r.decisions}`;
  const suffix=r.pushes?` · ${r.pushes} ВОЗВР.`:"";
  const per=periodRu(p);
  if(t==="game_total")return `${per}${side==="over"?"ТОТАЛ БОЛЬШЕ":"ТОТАЛ МЕНЬШЕ"} ${fmt(line)} — ${count} РЕШЁННЫХ МАТЧЕЙ${suffix}`;
  if(t==="team_total")return `${s} · ${per}${side==="over"?"ТОТАЛ КОМАНДЫ БОЛЬШЕ":"ТОТАЛ КОМАНДЫ МЕНЬШЕ"} ${fmt(line)} — ${count}${suffix}`;
  if(t==="handicap")return `${s} · ${per}ФОРА ${signed(line)} — ${count}${suffix}`;
  if(t==="moneyline")return side==="draw"?`НИЧЬЯ В ОСНОВНОЕ ВРЕМЯ — ${count} РЕЛЕВАНТНЫХ МАТЧЕЙ`:`${s} ПОБЕДИЛ ${count} МАТЧЕЙ`;
  if(/^period_[123]_result$/.test(t)){
    const n=t.match(/^period_([123])_result$/)?.[1];
    return side==="draw"?`${n}-Й ПЕРИОД ЗАВЕРШИЛСЯ ВНИЧЬЮ В ${count} МАТЧЕЙ`:`${s} ВЫИГРАЛ ${n}-Й ПЕРИОД В ${count} МАТЧЕЙ`;
  }
  if(t==="double_chance")return side==="no_draw"?`БЕЗ НИЧЬЕЙ В ОСНОВНОЕ ВРЕМЯ — ${count} МАТЧЕЙ`:`${s} НЕ ПРОИГРАЛ В ОСНОВНОЕ ВРЕМЯ В ${count} МАТЧЕЙ`;
  if(t==="both_teams_score")return side==="yes"?`ОБЕ КОМАНДЫ ЗАБИВАЛИ В ${count} МАТЧЕЙ`:`ХОТЯ БЫ ОДНА НЕ ЗАБИВАЛА В ${count} МАТЧЕЙ`;
  if(t==="first_goal_team")return `${s} ОТКРЫВАЛ СЧЁТ В ${count} МАТЧЕЙ`;
  if(t==="team_goal_bucket")return `${s}: ${side==="0_1"?"0–1 ШАЙБА":side==="2"?"РОВНО 2 ШАЙБЫ":"3+ ШАЙБЫ"} — ${count} МАТЧЕЙ`;
  if(t==="highest_scoring_period")return `${s||"КОМАНДА"}: ${side.replace("P","")}-Й ПЕРИОД БЫЛ САМЫМ РЕЗУЛЬТАТИВНЫМ В ${count} МАТЧЕЙ`;
  if(t==="win_all_periods")return `${s} ВЫИГРАЛ ВСЕ 3 ПЕРИОДА В ${count} МАТЧЕЙ`;
  if(t==="result_total_combo")return `${s} ПОБЕДИЛ + ${side==="over"?"ТОТАЛ БОЛЬШЕ":"ТОТАЛ МЕНЬШЕ"} ${fmt(line)} В ${count} МАТЧЕЙ`;
  return `${marketLabel(m)} — ${count}`;
}
function operatorExplanation(m,r,game){
  const parts=[`Точная текущая линия WINLINE: ${marketLabel(m)} · кэф ${Number(m.odds).toFixed(2)}.`,`Исторический результат: ${r.hits}/${r.decisions} решённых наблюдений (${Math.round(r.rate*100)}%).`];
  if(r.pushes)parts.push(`Возвраты по целой линии: ${r.pushes}.`);
  if(r.away&&r.home)parts.push(`${game.away_tri}: ${r.away.hits}/${r.away.decisions}; ${game.home_tri}: ${r.home.hits}/${r.home.decisions}.`);
  parts.push("Карточка рассчитана непосредственно для этой линии; статистика другой линии не переименовывается.");
  return parts.join(" ");
}

function marketLabel(m){
  const t=String(m.market_type||""),s=String(m.subject||""),side=String(m.side||"").toLowerCase(),line=finite(m.line),p=periodRu(m.period);
  if(t==="game_total")return `${p}${side==="over"?"ОБЩИЙ ТОТАЛ БОЛЬШЕ":"ОБЩИЙ ТОТАЛ МЕНЬШЕ"} ${fmt(line)}`;
  if(t==="team_total")return `${s} · ${p}${side==="over"?"ТОТАЛ КОМАНДЫ БОЛЬШЕ":"ТОТАЛ КОМАНДЫ МЕНЬШЕ"} ${fmt(line)}`;
  if(t==="handicap")return `${s} · ${p}ФОРА ${signed(line)}`;
  if(t==="moneyline")return side==="draw"?"НИЧЬЯ В ОСНОВНОЕ ВРЕМЯ":`ПОБЕДА ${s}`;
  if(/^period_[123]_result$/.test(t))return side==="draw"?`${p}НИЧЬЯ`:`${p}ПОБЕДА ${s}`;
  if(t==="double_chance")return side==="no_draw"?"12 — БЕЗ НИЧЬЕЙ":`${s} НЕ ПРОИГРАЕТ В ОСНОВНОЕ ВРЕМЯ`;
  if(t==="both_teams_score")return side==="yes"?"ОБЕ ЗАБЬЮТ — ДА":"ОБЕ ЗАБЬЮТ — НЕТ";
  if(t==="first_goal_team")return `ПЕРВЫЙ ГОЛ — ${s}`;
  if(t==="team_goal_bucket")return `${s} · ${side==="0_1"?"0–1":side==="2"?"РОВНО 2":"3+"} ШАЙБЫ`;
  if(t==="highest_scoring_period")return `${s} · САМЫЙ РЕЗУЛЬТАТИВНЫЙ ${side}`;
  if(t==="win_all_periods")return `${s} · ВЫИГРАЕТ ВСЕ ПЕРИОДЫ`;
  if(t==="result_total_combo")return `ПОБЕДА ${s} + ${side==="over"?"ТОТАЛ БОЛЬШЕ":"ТОТАЛ МЕНЬШЕ"} ${fmt(line)}`;
  return [p,t,s,side,line===null?"":fmt(line)].filter(Boolean).join(" ");
}

function periodTotal(row,period){
  if(period==="GAME"||period==="REG"){const g=regView(row);return g?g.gf+g.ga:null}
  const p=periodNumber(period);if(!p)return null;
  const gf=finite(row[`p${p}_goals_for`]),ga=finite(row[`p${p}_goals_against`]);
  return gf===null||ga===null?null:gf+ga;
}
function periodGoalsFor(row,period){
  if(period==="GAME"||period==="REG"){const g=regView(row);return g?g.gf:null}
  const p=periodNumber(period);return p?finite(row[`p${p}_goals_for`]):null;
}
function periodGoalDiff(row,period){
  if(period==="GAME"||period==="REG"){const g=regView(row);return g?g.gf-g.ga:null}
  const p=periodNumber(period);if(!p)return null;
  const gf=finite(row[`p${p}_goals_for`]),ga=finite(row[`p${p}_goals_against`]);
  return gf===null||ga===null?null:gf-ga;
}
function settleTotal(total,side,line){
  if(total===line)return "push";
  if(side==="over")return total>line?"win":"loss";
  if(side==="under")return total<line?"win":"loss";
  return null;
}
function settleHandicap(diff,line){
  const x=diff+line;if(x===0)return"push";return x>0?"win":"loss";
}
function periodNumber(period){const m=/^P([123])$/.exec(String(period||""));return m?Number(m[1]):0}
function periodRu(period){const p=periodNumber(period);return p?`${p}-Й ПЕРИОД · `:String(period)==="REG"?"60 МИН · ":""}
function displaySide(m){return String(m.side||"")}
function marketKey(m){const l=finite(m.line);return [m.market_type,m.period,m.subject||"all",displaySide(m),l===null?"none":l.toFixed(2)].join(":")}
function dedupeMarkets(markets){const seen=new Set(),out=[];for(const m of markets){const k=marketKey(m);if(seen.has(k))continue;seen.add(k);out.push(m)}return out}
function finite(v){if(v===null||v===undefined||v==="")return null;const n=Number(v);return Number.isFinite(n)?n:null}
function fmt(v){const n=finite(v);return n===null?"":String(n).replace(".",",")}
function signed(v){const n=finite(v);if(n===null)return"";return(n>0?"+":"")+fmt(n)}
