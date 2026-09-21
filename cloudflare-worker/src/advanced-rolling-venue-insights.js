import snapshot from "../../data/advanced_team_snapshot_2024_2026.json" with { type: "json" };

const WINDOWS=[10,20];
const TEAM_TOTAL_LINES=[1.5,2.5,3.5,4.5];
const MIN_VENUE_SAMPLE=6;

export async function buildAdvancedRollingVenueInsights(db,game){
  if(!db||!game?.away_tri||!game?.home_tri||!game?.scheduled_start_utc)return[];
  const [currentR,awayR,homeR]=await db.batch([
    db.prepare(`
      SELECT *
      FROM team_current_snapshots
      WHERE team_tri IN (?,?) AND window_games IN (10,20)
      ORDER BY window_games DESC,team_tri;
    `).bind(game.away_tri,game.home_tri),
    recentAdvancedRows(db,game.away_tri,game.scheduled_start_utc),
    recentAdvancedRows(db,game.home_tri,game.scheduled_start_utc),
  ]);
  return evaluateAdvancedRollingVenueInsights(
    game,
    currentR.results||[],
    [...(awayR.results||[]),...(homeR.results||[])]
  );
}

function recentAdvancedRows(db,team,before){
  return db.prepare(`
    SELECT a.*,g.scheduled_start_utc,
           CASE WHEN g.home_tri=a.team_tri THEN 1 ELSE 0 END AS is_home
    FROM team_game_advanced_features a
    JOIN games g ON g.game_pk=a.game_pk
    WHERE a.team_tri=? AND g.scheduled_start_utc<? AND g.game_type IN (2,3)
    ORDER BY g.scheduled_start_utc DESC,a.game_pk DESC
    LIMIT 40;
  `).bind(team,before);
}

export function evaluateAdvancedRollingVenueInsights(game,currentRows,historyRows){
  const current=new Map((currentRows||[]).map(r=>[`${up(r.team_tri)}:${Number(r.window_games)}`,r]));
  const histories=new Map();
  for(const row of historyRows||[]){
    const team=up(row.team_tri);
    if(!histories.has(team))histories.set(team,[]);
    histories.get(team).push(row);
  }
  for(const rows of histories.values())rows.sort((a,b)=>String(b.scheduled_start_utc||"").localeCompare(String(a.scheduled_start_utc||""))||Number(b.game_pk)-Number(a.game_pk));

  const out=[];
  for(const team of [up(game.away_tri),up(game.home_tri)]){
    const opponent=team===up(game.home_tri)?up(game.away_tri):up(game.home_tri);
    const signal=bestTeamTotalSignal(game,team,opponent,current,histories);
    if(!signal)continue;
    for(const line of TEAM_TOTAL_LINES){
      out.push(makeCard(game,signal,{
        type:"team_total",period:"GAME",subject:team,side:signal.side,line,
        label:`${team} ${signal.side==="over"?"ИТБ":"ИТМ"} ${line}`,
      },`advanced-rolling-venue:${team}:${signal.side}:${key(line)}`));
    }
  }
  return out.sort((a,b)=>Number(b.score||0)-Number(a.score||0));
}

function bestTeamTotalSignal(game,team,opponent,current,histories){
  const candidates=[
    mismatchSignal(game,team,opponent,current,histories,"over"),
    mismatchSignal(game,team,opponent,current,histories,"under"),
  ].filter(Boolean);
  return candidates.sort((a,b)=>b.score-a.score)[0]||null;
}

function mismatchSignal(game,team,opponent,current,histories,side){
  const seasonTeamRank=seasonRank(team,"xgf60","desc");
  const seasonOppRank=seasonRank(opponent,"xga60","asc");
  if(!seasonTeamRank||!seasonOppRank)return null;

  const team10=current.get(`${team}:10`),team20=current.get(`${team}:20`);
  const opp10=current.get(`${opponent}:10`),opp20=current.get(`${opponent}:20`);
  const totalTeams=Math.max(
    Number(team20?.advanced_league_teams||0),
    Number(team10?.advanced_league_teams||0),
    Number(opp20?.advanced_league_teams||0),
    Number(opp10?.advanced_league_teams||0),
    32
  );

  const t10=finiteRank(team10?.rank_xgf60_5v5);
  const t20=finiteRank(team20?.rank_xgf60_5v5);
  const o10=finiteRank(opp10?.rank_xga60_5v5);
  const o20=finiteRank(opp20?.rank_xga60_5v5);
  const top=r=>Number.isFinite(r)&&r<=8;
  const bottom=r=>Number.isFinite(r)&&r>=totalTeams-7;

  let confirmed=false;
  if(side==="over"){
    confirmed=top(seasonTeamRank)&&([t10,t20].filter(top).length>=1)&&bottom(seasonOppRank)&&([o10,o20].filter(bottom).length>=1);
  }else{
    confirmed=bottom(seasonTeamRank)&&([t10,t20].filter(bottom).length>=1)&&top(seasonOppRank)&&([o10,o20].filter(top).length>=1);
  }
  if(!confirmed)return null;

  const teamIsHome=team===up(game.home_tri);
  const oppIsHome=opponent===up(game.home_tri);
  const teamVenue=venueSummary(histories.get(team)||[],teamIsHome);
  const oppVenue=venueSummary(histories.get(opponent)||[],oppIsHome);
  const venueConfirmed=venueSupports(side,teamVenue,oppVenue);

  const teamRoll=bestRollingRank(side,[t20,t10],totalTeams);
  const oppRoll=bestDefenseRollingRank(side,[o20,o10],totalTeams);
  const seasonGap=Math.abs(seasonOppRank-seasonTeamRank);
  const rollingGap=(Number.isFinite(teamRoll.rank)&&Number.isFinite(oppRoll.rank))?Math.abs(oppRoll.rank-teamRoll.rank):0;

  const score=Math.min(99,90
    +(venueConfirmed?5:0)
    +(teamRoll.window===20?2:0)
    +(oppRoll.window===20?2:0)
    +(seasonGap>=15?2:0)
    +(rollingGap>=15?2:0));

  const seasonTeamValue=seasonValue(team,"xgf60");
  const seasonOppValue=seasonValue(opponent,"xga60");
  const title=side==="over"
    ? `${team} — №${seasonTeamRank} НХЛ ПО xGF/60 ЗА СЕЗОН И №${teamRoll.rank} ЗА ПОСЛЕДНИЕ ${teamRoll.window}; ${opponent} — ${oppRoll.rank}-Й ПО xGA/60`
    : `${team} — ${seasonTeamRank}-Й НХЛ ПО xGF/60 ЗА СЕЗОН И ${teamRoll.rank}-Й ЗА ПОСЛЕДНИЕ ${teamRoll.window}; ${opponent} — №${oppRoll.rank} ПО xGA/60`;

  const venueText=venueExplanation(team,opponent,teamIsHome,oppIsHome,teamVenue,oppVenue);
  return {
    side,score,title,
    explanation:`Сезон 2025/26: ${team} ${fmt(seasonTeamValue,2)} xGF/60, ${opponent} ${fmt(seasonOppValue,2)} xGA/60. ${venueText} Это подтверждение из независимых горизонтов, а не вероятность прохода линии.`,
    evidence:{
      sample:Math.max(Number(teamRoll.window||0),Number(oppRoll.window||0)),
      season:"20252026",
      metric:"xgf60",
      opponent_metric:"xga60",
      team,opponent,
      team_rank:seasonTeamRank,
      opponent_rank:seasonOppRank,
      rank_gap:seasonGap,
      rolling_team_rank:teamRoll.rank,
      rolling_team_window:teamRoll.window,
      rolling_opponent_rank:oppRoll.rank,
      rolling_opponent_window:oppRoll.window,
      venue_sample:Math.min(Number(teamVenue?.sample||0),Number(oppVenue?.sample||0)),
      venue_confirmed:venueConfirmed,
      multi_window_confirmed:true,
      team_venue:teamVenue,
      opponent_venue:oppVenue,
      advanced_snapshot:true,
      feature_layer:"advanced_rolling_venue_v1",
    }
  };
}

function venueSummary(rows,isHome){
  const sample=(rows||[]).filter(r=>Number(r.is_home)===Number(Boolean(isHome))).slice(0,10);
  if(sample.length<MIN_VENUE_SAMPLE)return null;
  const valid=sample.filter(r=>num(r.toi_5v5_minutes)>0);
  if(valid.length<MIN_VENUE_SAMPLE)return null;
  const toi=sum(valid,"toi_5v5_minutes");
  const xgf=sum(valid,"xgf_5v5"),xga=sum(valid,"xga_5v5");
  const sf=sum(valid,"shots_for_5v5"),sa=sum(valid,"shots_against_5v5");
  return {
    sample:valid.length,
    xgf60:toi>0?60*xgf/toi:null,
    xga60:toi>0?60*xga/toi:null,
    sf60:toi>0?60*sf/toi:null,
    sa60:toi>0?60*sa/toi:null,
    xgf_pct:(xgf+xga)>0?100*xgf/(xgf+xga):null,
  };
}

function venueSupports(side,teamVenue,oppVenue){
  if(!teamVenue||!oppVenue)return false;
  if(side==="over"){
    return num(teamVenue.xgf60)>=2.7&&num(oppVenue.xga60)>=2.7;
  }
  return num(teamVenue.xgf60)<=2.6&&num(oppVenue.xga60)<=2.6;
}

function venueExplanation(team,opponent,teamHome,oppHome,teamVenue,oppVenue){
  if(!teamVenue||!oppVenue)return"Релевантный home/away advanced-сплит пока недостаточен по выборке.";
  return `${team} ${teamHome?"дома":"в гостях"}: ${fmt(teamVenue.xgf60,2)} xGF/60 за ${teamVenue.sample} матчей; ${opponent} ${oppHome?"дома":"в гостях"}: ${fmt(oppVenue.xga60,2)} xGA/60 за ${oppVenue.sample} матчей.`;
}

function bestRollingRank(side,ranks,totalTeams){
  const pairs=[{rank:ranks[0],window:20},{rank:ranks[1],window:10}].filter(x=>Number.isFinite(x.rank));
  pairs.sort((a,b)=>{
    const av=side==="over"?a.rank:totalTeams-a.rank+1;
    const bv=side==="over"?b.rank:totalTeams-b.rank+1;
    return av-bv||b.window-a.window;
  });
  return pairs[0]||{rank:null,window:null};
}
function bestDefenseRollingRank(side,ranks,totalTeams){
  const pairs=[{rank:ranks[0],window:20},{rank:ranks[1],window:10}].filter(x=>Number.isFinite(x.rank));
  pairs.sort((a,b)=>{
    const av=side==="over"?totalTeams-a.rank+1:a.rank;
    const bv=side==="over"?totalTeams-b.rank+1:b.rank;
    return av-bv||b.window-a.window;
  });
  return pairs[0]||{rank:null,window:null};
}

function seasonRank(team,metric,direction){
  const rows=Object.entries(snapshot?.teams||{})
    .map(([tri,row])=>({tri,value:num(row?.v?.[metric])}))
    .filter(x=>Number.isFinite(x.value))
    .sort((a,b)=>direction==="asc"?a.value-b.value:b.value-a.value||a.tri.localeCompare(b.tri));
  const i=rows.findIndex(x=>x.tri===team);
  return i<0?null:i+1;
}
function seasonValue(team,metric){return num(snapshot?.teams?.[team]?.v?.[metric])}

function makeCard(game,signal,market,suffix){
  return {
    id:`${game.game_pk}:${suffix}`,
    insight_type:suffix,
    category:"advanced_rolling_venue",
    kind:"history",
    timing:"pregame",
    score:Math.round(signal.score),
    eyebrow:"ADVANCED · СЕЗОН + ФОРМА + HOME/AWAY",
    value:signal.title,
    title:signal.title,
    explanation:signal.explanation,
    evidence:signal.evidence,
    market,
  };
}

function finiteRank(v){const n=Number(v);return Number.isFinite(n)&&n>0?n:null}
function sum(rows,key){return rows.reduce((s,r)=>s+(num(r?.[key])||0),0)}
function num(v){const n=Number(v);return Number.isFinite(n)?n:null}
function fmt(v,d=2){const n=Number(v);return Number.isFinite(n)?n.toFixed(d).replace(".",","):"—"}
function up(v){return String(v||"").trim().toUpperCase()}
function key(v){return String(v).replace("-","m").replace(".","_")}
