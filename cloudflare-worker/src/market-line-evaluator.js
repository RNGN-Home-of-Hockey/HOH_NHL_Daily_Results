const GAME_TOTAL_LINES = [4.5,5.5,6.5,7.5];
const TEAM_TOTAL_LINES = [1.5,2.5,3.5,4.5];
const HANDICAPS = [-2.5,-1.5,1.5,2.5];

export async function evaluateMarketLines(db, game, options = {}) {
  if (!db || !game?.home_tri || !game?.away_tri) return [];
  const window = clampInt(options.window,20,5,20);
  const before = String(options.before || game.start_utc || game.scheduled_start_utc || "").trim() || null;
  const [home,away] = await Promise.all([
    loadTeamWindow(db,game.home_tri,window,before),
    loadTeamWindow(db,game.away_tri,window,before),
  ]);
  if (home.length < 5 || away.length < 5) return [];

  const result = [
    ...gameTotals(game,home,away),
    ...teamTotals(game,game.home_tri,game.away_tri,home,away),
    ...teamTotals(game,game.away_tri,game.home_tri,away,home),
    ...handicaps(game,game.home_tri,game.away_tri,home,away),
    ...handicaps(game,game.away_tri,game.home_tri,away,home),
  ];
  return result.sort((a,b)=>b.confidence-a.confidence||b.combined_rate-a.combined_rate||a.label.localeCompare(b.label));
}

async function loadTeamWindow(db,team,window,before) {
  const sql = before ? `
    SELECT game_pk,scheduled_start_utc,opponent_tri,is_home,final_goals_for,final_goals_against,
           total_goals,final_goal_diff,final_win
    FROM team_game_features
    WHERE team_tri=? AND game_type IN (2,3) AND scheduled_start_utc<?
    ORDER BY scheduled_start_utc DESC,game_pk DESC
    LIMIT ?;
  ` : `
    SELECT game_pk,scheduled_start_utc,opponent_tri,is_home,final_goals_for,final_goals_against,
           total_goals,final_goal_diff,final_win
    FROM team_game_features
    WHERE team_tri=? AND game_type IN (2,3)
    ORDER BY scheduled_start_utc DESC,game_pk DESC
    LIMIT ?;
  `;
  const statement = before ? db.prepare(sql).bind(team,before,window) : db.prepare(sql).bind(team,window);
  const result = await statement.all();
  return result.results || [];
}

function gameTotals(game,home,away) {
  return GAME_TOTAL_LINES.map(line=>{
    const homeRate=rate(home,r=>Number(r.total_goals)>line);
    const awayRate=rate(away,r=>Number(r.total_goals)>line);
    const p=mean([homeRate,awayRate]);
    const side=p>=.5?'over':'under';
    const chosen=side==='over'?p:1-p;
    return market({
      game,type:'game_total',subject:null,line,side,
      label:`${side==='over'?'ТБ':'ТМ'} ${line}`,
      combinedRate:chosen,
      components:{
        [`${game.home_tri}_games_${side}`]:side==='over'?homeRate:1-homeRate,
        [`${game.away_tri}_games_${side}`]:side==='over'?awayRate:1-awayRate,
      },
      samples:{[game.home_tri]:home.length,[game.away_tri]:away.length},
    });
  });
}

function teamTotals(game,team,opponent,teamRows,opponentRows) {
  return TEAM_TOTAL_LINES.map(line=>{
    const scoring=rate(teamRows,r=>Number(r.final_goals_for)>line);
    const conceding=rate(opponentRows,r=>Number(r.final_goals_against)>line);
    const p=mean([scoring,conceding]);
    const side=p>=.5?'over':'under';
    const chosen=side==='over'?p:1-p;
    return market({
      game,type:'team_total',subject:team,line,side,
      label:`${team} ${side==='over'?'ТБ':'ТМ'} ${line}`,
      combinedRate:chosen,
      components:{
        [`${team}_scoring_${side}`]:side==='over'?scoring:1-scoring,
        [`${opponent}_conceding_${side}`]:side==='over'?conceding:1-conceding,
      },
      samples:{[team]:teamRows.length,[opponent]:opponentRows.length},
    });
  });
}

function handicaps(game,team,opponent,teamRows,opponentRows) {
  return HANDICAPS.map(line=>{
    const own=rate(teamRows,r=>Number(r.final_goal_diff)+line>0);
    const allowed=rate(opponentRows,r=>Number(r.final_goal_diff)<line);
    const p=mean([own,allowed]);
    return market({
      game,type:'handicap',subject:team,line,side:'cover',
      label:`${team} ${line>0?'+':''}${line}`,
      combinedRate:p,
      components:{[`${team}_cover`]:own,[`${opponent}_allows`]:allowed},
      samples:{[team]:teamRows.length,[opponent]:opponentRows.length},
    });
  });
}

function market({game,type,subject,line,side,label,combinedRate,components,samples}) {
  // Confidence is evidence FOR the displayed market. A low handicap hit rate
  // must not become a high-confidence card merely because it is far from 50%.
  const edge=Math.max(0,Number(combinedRate)-.5);
  const confidence=Math.round(edge*2000)/10;
  const score=Math.round((50+confidence*.5)*10)/10;
  return {
    game_pk:Number(game.game_pk)||null,
    market_type:type,
    subject,
    line,
    side,
    label,
    combined_rate:round(combinedRate),
    edge_pp:Math.round(edge*1000)/10,
    confidence,
    score,
    sample:Object.values(samples).reduce((a,b)=>a+Number(b||0),0),
    evidence:{components:roundObject(components),samples},
  };
}

function rate(rows,predicate){if(!rows.length)return 0;return rows.filter(predicate).length/rows.length}
function mean(values){return values.reduce((a,b)=>a+b,0)/values.length}
function round(value){return Math.round(Number(value)*1000)/1000}
function roundObject(value){return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,round(v)]))}
function clampInt(value,fallback,min,max){const n=Number(value);return Number.isSafeInteger(n)&&n>=min&&n<=max?n:fallback}
