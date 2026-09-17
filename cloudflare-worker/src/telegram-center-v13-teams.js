const JS_PATH = "/telegram-app/v13.js";
const API = "/api/telegram-center-v13";
const V3_API = "/api/telegram-center-v3";
const V7_PLAYERS = "/api/telegram-center-v7/players";
const NHL = "https://api-web.nhle.com/v1";
const FINAL_STATES = new Set(["FINAL", "OFF"]);

export async function handleTelegramCenterV13Teams(request, env, path) {
  if (path === JS_PATH) {
    if (request.method !== "GET") return json({ok:false,error:"method_not_allowed"},405);
    return new Response(V14_JS,{headers:{"Content-Type":"application/javascript; charset=utf-8","Cache-Control":"no-store, no-cache, must-revalidate","X-Content-Type-Options":"nosniff"}});
  }

  if (path === V7_PLAYERS && request.method === "GET") {
    const team = upper(new URL(request.url).searchParams.get("team") || "");
    if (team) return completePlayersList(request, env, team);
    return null;
  }

  if (!env?.DB) {
    if (path.startsWith(API) || path.startsWith(V3_API)) return json({ok:false,error:"missing_d1_binding"},503);
    return null;
  }

  const compat = new RegExp(`^${V3_API}/teams/([A-Za-z]{3})$`).exec(path);
  if (compat && request.method === "GET") {
    const season = normalizeSeason(new URL(request.url).searchParams.get("season")) || currentSeasonId();
    return teamDetail(env, compat[1].toUpperCase(), season, true);
  }

  const seasons = new RegExp(`^${API}/teams/([A-Za-z]{3})/seasons$`).exec(path);
  if (seasons && request.method === "GET") return teamSeasons(env, seasons[1].toUpperCase());

  const detail = new RegExp(`^${API}/teams/([A-Za-z]{3})/season/(20\\d{6})$`).exec(path);
  if (detail && request.method === "GET") return teamDetail(env, detail[1].toUpperCase(), detail[2], false);

  const table = new RegExp(`^${API}/teams/([A-Za-z]{3})/season/(20\\d{6})/table$`).exec(path);
  if (table && request.method === "GET") return leagueTableResponse(env, table[1].toUpperCase(), table[2]);

  const card = new RegExp(`^${API}/players/(\\d+)/card$`).exec(path);
  if (card && request.method === "GET") return playerCard(env, Number(card[1]));

  const playerSeasonMatch = new RegExp(`^${API}/players/(\\d+)/season/(20\\d{6})$`).exec(path);
  if (playerSeasonMatch && request.method === "GET") return playerSeason(env, Number(playerSeasonMatch[1]), playerSeasonMatch[2]);

  return null;
}

async function completePlayersList(request, env, tri) {
  const u = new URL(request.url);
  const q = String(u.searchParams.get("q") || "").trim().toLowerCase();
  const limit = clampInt(u.searchParams.get("limit"), 160, 1, 250);
  try {
    let roster = await currentRosterNhl(tri).catch(()=>[]);
    if (!roster.length && env?.DB) roster = await activeRosterDb(env.DB, tri).catch(()=>[]);
    roster = await enrichRoster(env?.DB, roster, tri, currentSeasonId());
    if (q) roster = roster.filter(p => String(p.full_name_en||"").toLowerCase().includes(q) || String(p.full_name_ru||"").toLowerCase().includes(q));
    roster = roster.slice(0, limit);
    return json({ok:true,season:currentSeasonId(),source:"nhl_current_roster_v14",players:roster});
  } catch (error) {
    return json({ok:false,error:"player_list_v14_failed",detail:errorText(error),players:[]},503);
  }
}

async function teamSeasons(env, tri) {
  const team = await env.DB.prepare(`SELECT tri_code,name_en,name_ru FROM teams WHERE tri_code=? LIMIT 1;`).bind(tri).first().catch(()=>null);
  if (!team) return json({ok:false,error:"team_not_found"},404);
  const ids = lastSeasonIds(5);
  const marks = ids.map(()=>'?').join(',');
  const games = await env.DB.prepare(`
    SELECT CAST(season_id AS TEXT) season_id,COUNT(*) games
    FROM games WHERE CAST(season_id AS TEXT) IN (${marks}) AND (home_tri=? OR away_tri=?)
    GROUP BY CAST(season_id AS TEXT);
  `).bind(...ids,tri,tri).all().catch(()=>({results:[]}));
  const adv = await env.DB.prepare(`
    SELECT CAST(season_id AS TEXT) season_id,COUNT(DISTINCT game_pk) advanced_games
    FROM team_game_advanced_features WHERE team_tri=? AND CAST(season_id AS TEXT) IN (${marks})
    GROUP BY CAST(season_id AS TEXT);
  `).bind(tri,...ids).all().catch(()=>({results:[]}));
  const gm=Object.fromEntries((games.results||[]).map(x=>[String(x.season_id),num(x.games)]));
  const am=Object.fromEntries((adv.results||[]).map(x=>[String(x.season_id),num(x.advanced_games)]));
  return json({ok:true,team,seasons:ids.map(id=>({season_id:id,label:seasonLabel(id),current:id===currentSeasonId(),d1_games:gm[id]||0,advanced_games:am[id]||0,advanced_available:(am[id]||0)>0}))});
}

async function teamDetail(env, tri, season, compat=false) {
  if (!normalizeSeason(season)) return json({ok:false,error:"invalid_season"},400);
  const team = await env.DB.prepare(`SELECT tri_code,name_en,name_ru,logo_url FROM teams WHERE tri_code=? LIMIT 1;`).bind(tri).first().catch(()=>null);
  if (!team) return json({ok:false,error:"team_not_found"},404);
  try {
    let schedule = await dbSchedule(env.DB,tri,season).catch(()=>[]);
    let scheduleSource = schedule.length ? "d1" : "unavailable";
    if (!schedule.length) {
      schedule = await nhlSchedule(tri,season).catch(()=>[]);
      if (schedule.length) scheduleSource = "nhl_web_api";
    }
    const regularFinal=schedule.filter(g=>Number(g.game_type)===2&&isFinal(g.game_state));
    const standings=computeRecord(regularFinal,tri);
    const nextGame=schedule.find(g=>!isFinal(g.game_state)&&Date.parse(g.scheduled_start_utc||0)>=Date.now()-3600000)||null;
    const recent=[...schedule].filter(g=>isFinal(g.game_state)).sort((a,b)=>Date.parse(b.scheduled_start_utc||0)-Date.parse(a.scheduled_start_utc||0)).slice(0,12);
    const [standard,advanced,roster]=await Promise.all([
      detailedStandardStats(env.DB,tri,season).catch(()=>emptyStandard()),
      advancedStats(env.DB,tri,season).catch(()=>emptyAdvanced()),
      completeTeamRoster(env,tri,season).catch(()=>[]),
    ]);
    const payload={
      ok:true,season,season_label:seasonLabel(season),team:{...team,logo:team.logo_url||teamLogo(tri)},standings,
      standard_stats:standard,advanced_stats:advanced,roster,schedule,recent,next_game:nextGame,
      coverage:{schedule_source:scheduleSource,roster_source:season===currentSeasonId()?"nhl_current_roster":"season_stats",standard_games:num(standard.games),advanced_games:num(advanced.games)},
      updated_at:new Date().toISOString(),source:"center_v14",
    };
    if (compat) return json({ok:true,season,season_label:payload.season_label,team:payload.team,standings:payload.standings,league_ranks:null,playoff:null,next_game:nextGame,recent,schedule,updated_at:payload.updated_at,source:"center_v14_compat"});
    return json(payload);
  } catch (error) {
    return json({ok:false,error:"team_detail_v14_failed",detail:errorText(error)},503);
  }
}

async function dbSchedule(db,tri,season){
  const r=await db.prepare(`SELECT game_pk,CAST(season_id AS TEXT) season_id,game_type,scheduled_start_utc,game_state,home_tri,away_tri,home_score,away_score,period_type FROM games WHERE CAST(season_id AS TEXT)=? AND (home_tri=? OR away_tri=?) ORDER BY scheduled_start_utc,game_pk;`).bind(season,tri,tri).all();
  return (r.results||[]).map(g=>annotateGame(g,tri));
}

async function nhlSchedule(tri,season){
  const d=await fetchNhl(`${NHL}/club-schedule-season/${tri}/${season}`);
  return (Array.isArray(d?.games)?d.games:[]).map(g=>annotateGame({game_pk:num(g?.id),season_id:season,game_type:num(g?.gameType),scheduled_start_utc:g?.startTimeUTC||g?.gameDate||null,game_state:String(g?.gameState||""),home_tri:upper(localized(g?.homeTeam?.abbrev)),away_tri:upper(localized(g?.awayTeam?.abbrev)),home_score:g?.homeTeam?.score??null,away_score:g?.awayTeam?.score??null,period_type:g?.periodDescriptor?.periodType||null},tri));
}

function annotateGame(g,tri){const home=upper(g.home_tri),away=upper(g.away_tri),isHome=home===tri,opp=isHome?away:home;return {...g,home_tri:home,away_tri:away,opponent_tri:opp,is_home:isHome?1:0,opponent_name:opp,stage_label_ru:Number(g.game_type)===3?"Плей-офф":Number(g.game_type)===1?"Предсезонка":"Регулярка"}}
function computeRecord(games,tri){let wins=0,losses=0,ot_losses=0,gf=0,ga=0;for(const g of games){const h=upper(g.home_tri)===tri,a=num(h?g.home_score:g.away_score),b=num(h?g.away_score:g.home_score);gf+=a;ga+=b;if(a>b)wins++;else if(["OT","SO"].includes(upper(g.period_type))){ot_losses++;}else losses++;}return{games_played:games.length,wins,losses,ot_losses,points:wins*2+ot_losses,goals_for:gf,goals_against:ga,goal_diff:gf-ga}}

async function detailedStandardStats(db,tri,season){
  const row=await db.prepare(`SELECT COUNT(*) games,SUM(COALESCE(s.goals,0)) goals_for,SUM(COALESCE(o.goals,0)) goals_against,SUM(COALESCE(s.shots,0)) shots_for,SUM(COALESCE(o.shots,0)) shots_against,SUM(COALESCE(s.blocked_shots,0)) blocked_shots,SUM(COALESCE(s.hits,0)) hits,SUM(COALESCE(s.pim,0)) pim,SUM(COALESCE(s.giveaways,0)) giveaways,SUM(COALESCE(s.takeaways,0)) takeaways,AVG(s.faceoff_pct) faceoff_pct,SUM(COALESCE(s.power_play_goals,0)) power_play_goals,SUM(COALESCE(s.power_play_opportunities,0)) power_play_opportunities,SUM(COALESCE(s.shorthanded_goals,0)) shorthanded_goals FROM games g JOIN team_game_stats s ON s.game_pk=g.game_pk AND s.team_tri=? LEFT JOIN team_game_stats o ON o.game_pk=g.game_pk AND o.team_tri<>? WHERE CAST(g.season_id AS TEXT)=? AND g.game_type=2 AND UPPER(COALESCE(g.game_state,'')) IN ('FINAL','OFF');`).bind(tri,tri,season).first();
  if(!row||!num(row.games))return emptyStandard();const games=num(row.games),ppo=num(row.power_play_opportunities),ppg=num(row.power_play_goals);return{...row,games,power_play_pct:ppo?round(ppg*100/ppo,1):null,shots_for_pg:games?round(num(row.shots_for)/games,1):null,shots_against_pg:games?round(num(row.shots_against)/games,1):null};
}

async function advancedStats(db,tri,season){
  const row=await db.prepare(`SELECT COUNT(*) games,SUM(COALESCE(toi_5v5_minutes,0)) toi_5v5_minutes,SUM(COALESCE(goals_for_5v5,0)) goals_for_5v5,SUM(COALESCE(goals_against_5v5,0)) goals_against_5v5,SUM(COALESCE(xgf_5v5,0)) xgf_5v5,SUM(COALESCE(xga_5v5,0)) xga_5v5,SUM(COALESCE(shots_for_5v5,0)) shots_for_5v5,SUM(COALESCE(shots_against_5v5,0)) shots_against_5v5,SUM(COALESCE(corsi_for_5v5,0)) corsi_for_5v5,SUM(COALESCE(corsi_against_5v5,0)) corsi_against_5v5,SUM(COALESCE(fenwick_for_5v5,0)) fenwick_for_5v5,SUM(COALESCE(fenwick_against_5v5,0)) fenwick_against_5v5,AVG(pdo_5v5) pdo_5v5,SUM(COALESCE(goals_saved_above_expected,0)) goals_saved_above_expected FROM team_game_advanced_features WHERE team_tri=? AND CAST(season_id AS TEXT)=?;`).bind(tri,season).first();
  if(!row||!num(row.games))return emptyAdvanced();const gf=num(row.goals_for_5v5),ga=num(row.goals_against_5v5),xgf=num(row.xgf_5v5),xga=num(row.xga_5v5),sf=num(row.shots_for_5v5),sa=num(row.shots_against_5v5),cf=num(row.corsi_for_5v5),ca=num(row.corsi_against_5v5),ff=num(row.fenwick_for_5v5),fa=num(row.fenwick_against_5v5),toi=num(row.toi_5v5_minutes),pct=(a,b)=>a+b?round(a*100/(a+b),1):null;return{...row,games:num(row.games),gf_pct_5v5:pct(gf,ga),xgf_pct_5v5:pct(xgf,xga),sf_pct_5v5:pct(sf,sa),corsi_for_pct_5v5:pct(cf,ca),fenwick_for_pct_5v5:pct(ff,fa),xgf60:toi?round(xgf*60/toi,2):null,xga60:toi?round(xga*60/toi,2):null};
}

async function completeTeamRoster(env,tri,season){
  if(season===currentSeasonId()){
    let rows=await currentRosterNhl(tri).catch(()=>[]);
    if(!rows.length)rows=await activeRosterDb(env.DB,tri).catch(()=>[]);
    return enrichRoster(env.DB,rows,tri,season);
  }
  let rows=await historicalRosterDb(env.DB,tri,season).catch(()=>[]);
  if(!rows.length)rows=await clubStatsRoster(tri,season).catch(()=>[]);
  return enrichRoster(env.DB,rows,tri,season);
}

async function currentRosterNhl(tri){
  const d=await fetchNhl(`${NHL}/roster/${tri}/current`);const groups=[...(d?.forwards||[]),...(d?.defensemen||[]),...(d?.goalies||[])];return groups.map(p=>({player_id:num(p.id||p.playerId),full_name_en:[localized(p.firstName),localized(p.lastName)].filter(Boolean).join(' '),full_name_ru:null,current_team_tri:tri,position_code:p.positionCode||p.position||'',sweater_number:p.sweaterNumber??null,games:0,goals:0,assists:0,points:0,shots:0})).filter(p=>p.player_id);
}
async function clubStatsRoster(tri,season){const d=await fetchNhl(`${NHL}/club-stats/${tri}/${season}/2`);const sk=Array.isArray(d?.skaters)?d.skaters:[],go=Array.isArray(d?.goalies)?d.goalies:[];return[...sk.map(p=>({player_id:num(p.playerId),full_name_en:[localized(p.firstName),localized(p.lastName)].filter(Boolean).join(' '),current_team_tri:tri,position_code:p.positionCode||'',sweater_number:null,games:num(p.gamesPlayed),goals:num(p.goals),assists:num(p.assists),points:num(p.points),shots:num(p.shots)})),...go.map(p=>({player_id:num(p.playerId),full_name_en:[localized(p.firstName),localized(p.lastName)].filter(Boolean).join(' '),current_team_tri:tri,position_code:'G',sweater_number:null,games:num(p.gamesPlayed),goals:0,assists:0,points:num(p.points),shots:0}))].filter(p=>p.player_id)}
async function historicalRosterDb(db,tri,season){const r=await db.prepare(`SELECT p.player_id,p.full_name_en,p.full_name_ru,p.position_code,p.sweater_number,COUNT(*) games,SUM(COALESCE(s.goals,0)) goals,SUM(COALESCE(s.assists,0)) assists,SUM(COALESCE(s.points,0)) points,SUM(COALESCE(s.shots,0)) shots FROM player_game_stats s JOIN games g ON g.game_pk=s.game_pk JOIN players p ON p.player_id=s.player_id WHERE s.team_tri=? AND CAST(g.season_id AS TEXT)=? AND g.game_type=2 GROUP BY p.player_id,p.full_name_en,p.full_name_ru,p.position_code,p.sweater_number ORDER BY points DESC,goals DESC,assists DESC,p.full_name_en;`).bind(tri,season).all();return(r.results||[]).map(x=>({...x,current_team_tri:tri}))}
async function activeRosterDb(db,tri){const r=await db.prepare(`SELECT player_id,full_name_en,full_name_ru,current_team_tri,position_code,sweater_number,0 games,0 goals,0 assists,0 points,0 shots FROM players WHERE COALESCE(active,1)=1 AND current_team_tri=? ORDER BY position_code,full_name_en;`).bind(tri).all();return r.results||[]}
async function enrichRoster(db,rows,tri,season){if(!rows.length)return[];let meta=new Map();if(db){const ids=[...new Set(rows.map(x=>num(x.player_id)).filter(Boolean))],marks=ids.map(()=>'?').join(',');if(ids.length){const r=await db.prepare(`SELECT p.player_id,p.full_name_en,p.full_name_ru,p.position_code,p.sweater_number,m.full_name_ru meta_name_ru,m.primary_country_code FROM players p LEFT JOIN player_profile_meta m ON m.player_id=p.player_id WHERE p.player_id IN (${marks});`).bind(...ids).all().catch(()=>({results:[]}));meta=new Map((r.results||[]).map(x=>[num(x.player_id),x]));}}
  return rows.map(p=>{const m=meta.get(num(p.player_id))||{};return{...p,full_name_en:m.full_name_en||p.full_name_en,full_name_ru:m.meta_name_ru||m.full_name_ru||p.full_name_ru||null,position_code:m.position_code||p.position_code||'',sweater_number:p.sweater_number??m.sweater_number??null,primary_country_code:m.primary_country_code||null,current_team_tri:tri,photo:playerPhoto(p.player_id,tri,season)}});
}

async function playerCard(env,playerId){
  if(!Number.isSafeInteger(playerId)||playerId<=0)return json({ok:false,error:"invalid_player_id"},400);
  const row=await env.DB.prepare(`SELECT p.player_id,p.full_name_en,p.full_name_ru,p.current_team_tri,p.position_code,p.sweater_number,m.full_name_ru meta_name_ru,m.primary_country_code FROM players p LEFT JOIN player_profile_meta m ON m.player_id=p.player_id WHERE p.player_id=? LIMIT 1;`).bind(playerId).first().catch(()=>null);
  const landing=await fetchNhl(`${NHL}/player/${playerId}/landing`).catch(()=>null);if(!row&&!landing)return json({ok:false,error:"player_not_found"},404);
  const tri=upper(landing?.currentTeamAbbrev||row?.current_team_tri||''),country=upper(row?.primary_country_code||landing?.birthCountry||'').slice(0,3),nameEn=row?.full_name_en||[localized(landing?.firstName),localized(landing?.lastName)].filter(Boolean).join(' ');
  return json({ok:true,player_id:playerId,full_name_en:nameEn,full_name_ru:row?.meta_name_ru||row?.full_name_ru||null,team_tri:tri,country_code:country,team_logo:landing?.teamLogo||teamLogo(tri),headshot:landing?.headshot||playerPhoto(playerId,tri,currentSeasonId())});
}

async function playerSeason(env,playerId,season){
  if(!Number.isSafeInteger(playerId)||playerId<=0)return json({ok:false,error:"invalid_player_id"},400);
  if(!normalizeSeason(season))return json({ok:false,error:"invalid_season"},400);
  try{
    const [landing,log]=await Promise.all([fetchNhl(`${NHL}/player/${playerId}/landing`).catch(()=>null),fetchNhl(`${NHL}/player/${playerId}/game-log/${season}/2`).catch(()=>null)]);
    const rows=Array.isArray(log?.gameLog)?log.gameLog:Array.isArray(log?.games)?log.games:[];const stats={games_played:rows.length,goals:0,assists:0,points:0};for(const g of rows){stats.goals+=num(g?.goals);stats.assists+=num(g?.assists);stats.points+=num(g?.points)}
    let tri='';for(const g of rows){tri=upper(localized(g?.teamAbbrev)||g?.teamAbbrev||g?.teamTri||'');if(tri)break}if(!tri)tri=upper(landing?.currentTeamAbbrev||'');
    const [teamRanks,leagueRanks]=await Promise.all([playerTeamRanks(playerId,tri,season).catch(()=>emptyPlayerRanks()),playerLeagueRanks(playerId,season).catch(()=>emptyPlayerRanks())]);
    return json({ok:true,player_id:playerId,season,team_tri:tri,stats,ranks:{team:teamRanks,league:leagueRanks},updated_at:new Date().toISOString()});
  }catch(error){return json({ok:false,error:"player_season_v14_failed",detail:errorText(error)},503)}
}
async function playerTeamRanks(playerId,tri,season){if(!tri)return emptyPlayerRanks();const d=await fetchNhl(`${NHL}/club-stats/${tri}/${season}/2`),list=Array.isArray(d?.skaters)?d.skaters:[];const out={total:list.length};for(const [key,src] of [['games_played','gamesPlayed'],['goals','goals'],['assists','assists'],['points','points']]){const sorted=[...list].sort((a,b)=>num(b?.[src])-num(a?.[src]));const i=sorted.findIndex(x=>num(x?.playerId)===playerId);out[`${key}_rank`]=i<0?null:i+1}return out}
async function playerLeagueRanks(playerId,season){const out={};await Promise.all([['goals','goals'],['assists','assists'],['points','points'],['games_played','gamesPlayed']].map(async([key,cat])=>{try{const d=await fetchNhl(`${NHL}/skater-stats-leaders/${season}/2?categories=${cat}&limit=50`),list=Array.isArray(d?.[cat])?d[cat]:Array.isArray(d?.leaders)?d.leaders:[];const i=list.findIndex(x=>num(x?.id||x?.playerId)===playerId);out[`${key}_rank`]=i<0?null:i+1}catch{out[`${key}_rank`]=null}}));return out}
function emptyPlayerRanks(){return{games_played_rank:null,goals_rank:null,assists_rank:null,points_rank:null,total:null}}

async function leagueTableResponse(env,tri,season){
  try{const r=await env.DB.prepare(`SELECT game_pk,scheduled_start_utc,game_state,game_type,home_tri,away_tri,home_score,away_score,period_type FROM games WHERE CAST(season_id AS TEXT)=? AND game_type=2 AND UPPER(COALESCE(game_state,'')) IN ('FINAL','OFF') ORDER BY scheduled_start_utc;`).bind(season).all();const games=r.results||[];if(games.length){const teamsR=await env.DB.prepare(`SELECT tri_code,name_en,name_ru,logo_url FROM teams WHERE COALESCE(active,1)=1 ORDER BY tri_code;`).all();return json({ok:true,season,source:'d1',table:computeTable(games,teamsR.results||[]),selected_team:tri})}const schedule=await nhlSchedule(tri,season).catch(()=>[]),last=[...schedule].filter(g=>Number(g.game_type)===2&&isFinal(g.game_state)).pop(),endpoint=season===currentSeasonId()?`${NHL}/standings/now`:last?`${NHL}/standings/${String(last.scheduled_start_utc||'').slice(0,10)}`:null;if(!endpoint)return json({ok:true,season,source:'unavailable',table:[],selected_team:tri});const d=await fetchNhl(endpoint),table=(d?.standings||[]).map(x=>({team_tri:upper(localized(x.teamAbbrev)),name:localized(x.teamName)||upper(localized(x.teamAbbrev)),games_played:num(x.gamesPlayed),wins:num(x.wins),losses:num(x.losses),ot_losses:num(x.otLosses),points:num(x.points),goals_for:num(x.goalFor),goals_against:num(x.goalAgainst),goal_diff:num(x.goalDifferential),league_sequence:num(x.leagueSequence),logo:x.teamLogo||teamLogo(upper(localized(x.teamAbbrev)))}));table.sort((a,b)=>(a.league_sequence||999)-(b.league_sequence||999));return json({ok:true,season,source:'nhl_web_api',table,selected_team:tri})}catch(error){return json({ok:false,error:'team_table_failed',detail:errorText(error)},503)}}
function computeTable(games,teams){const map=new Map((teams||[]).map(t=>[upper(t.tri_code),{team_tri:upper(t.tri_code),name:t.name_ru||t.name_en||t.tri_code,logo:t.logo_url||teamLogo(t.tri_code),games_played:0,wins:0,losses:0,ot_losses:0,points:0,goals_for:0,goals_against:0,goal_diff:0}]));for(const g of games){const h=map.get(upper(g.home_tri)),a=map.get(upper(g.away_tri));if(!h||!a)continue;const hs=num(g.home_score),as=num(g.away_score);h.games_played++;a.games_played++;h.goals_for+=hs;h.goals_against+=as;a.goals_for+=as;a.goals_against+=hs;if(hs>as){h.wins++;h.points+=2;if(['OT','SO'].includes(upper(g.period_type))){a.ot_losses++;a.points++}else a.losses++}else{a.wins++;a.points+=2;if(['OT','SO'].includes(upper(g.period_type))){h.ot_losses++;h.points++}else h.losses++}}const out=[...map.values()].filter(x=>x.games_played>0);for(const x of out)x.goal_diff=x.goals_for-x.goals_against;out.sort((a,b)=>b.points-a.points||b.wins-a.wins||b.goal_diff-a.goal_diff||a.team_tri.localeCompare(b.team_tri));out.forEach((x,i)=>x.league_sequence=i+1);return out}

function emptyStandard(){return{games:0,goals_for:null,goals_against:null,shots_for:null,shots_against:null,blocked_shots:null,hits:null,pim:null,giveaways:null,takeaways:null,faceoff_pct:null,power_play_goals:null,power_play_opportunities:null,power_play_pct:null,shorthanded_goals:null,shots_for_pg:null,shots_against_pg:null}}
function emptyAdvanced(){return{games:0,gf_pct_5v5:null,xgf_pct_5v5:null,sf_pct_5v5:null,corsi_for_pct_5v5:null,fenwick_for_pct_5v5:null,xgf60:null,xga60:null,pdo_5v5:null,goals_saved_above_expected:null}}
function lastSeasonIds(count){const cur=currentSeasonId(),start=Number(cur.slice(0,4));return Array.from({length:count},(_,i)=>`${start-i}${start-i+1}`)}
function currentSeasonId(){const d=new Date(),y=d.getUTCFullYear(),m=d.getUTCMonth()+1,s=m>=7?y:y-1;return`${s}${s+1}`}
function normalizeSeason(v){v=String(v||'').replace(/\D/g,'');return/^20\d{6}$/.test(v)?v:''}
function seasonLabel(s){s=String(s||'');return s.length===8?`${s.slice(0,4)}/${s.slice(6,8)}`:s}
function isFinal(v){return FINAL_STATES.has(upper(v))}
function localized(v){return v&&typeof v==='object'?(v.default||v.en||v.ru||''):String(v||'')}
function upper(v){return String(v||'').trim().toUpperCase()}
function num(v){const n=Number(v);return Number.isFinite(n)?n:0}
function round(v,d=1){const p=10**d;return Math.round(v*p)/p}
function clampInt(v,fallback,min,max){const x=Number(v);return Number.isSafeInteger(x)&&x>=min&&x<=max?x:fallback}
function errorText(e){return String(e?.message||e||'unknown_error')}
function teamLogo(tri){return tri?`https://assets.nhle.com/logos/nhl/svg/${upper(tri)}_light.svg`:null}
function playerPhoto(id,tri,season){return id&&tri?`https://assets.nhle.com/mugs/nhl/${season}/${tri}/${id}.png`:null}
async function fetchNhl(url){const c=new AbortController(),t=setTimeout(()=>c.abort(),6500);try{const r=await fetch(url,{signal:c.signal,headers:{Accept:'application/json','User-Agent':'HOH-NHL-Center/14'}});if(!r.ok)throw new Error(`NHL HTTP ${r.status}`);return await r.json()}finally{clearTimeout(t)}}
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}})}

const V14_JS=String.raw`(function(){
'use strict';
const API='/api/telegram-center-v13';
const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(u){const r=await fetch(u,{cache:'no-store'}),d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.detail||d.error||('HTTP '+r.status));return d}
function css(){if(document.getElementById('centerV14Css'))return;const s=document.createElement('style');s.id='centerV14Css';s.textContent=
'.v8{font-size:0!important;border-color:#7a542b!important;color:#ffb46c!important}.v8:after{content:"V14";font-size:9px;font-weight:900;letter-spacing:.8px}'+
'.profileHead.player .v11Audio,.profileHead.player .v12Audio{width:26px!important;height:26px!important;min-width:26px!important;max-width:26px!important;flex:0 0 26px!important;padding:0!important;margin:0 0 0 3px!important;border-radius:7px!important;font-size:13px!important;line-height:26px!important;transform:none!important;transition:border-color .15s,background .15s,opacity .15s!important}.profileHead.player .v11Audio:active,.profileHead.player .v12Audio:active{transform:none!important;width:26px!important;height:26px!important}.v12PhotoBadge{display:none!important}'+
'.v14Portrait{position:relative;width:92px;height:82px;flex:0 0 92px;border-radius:14px;overflow:hidden;background:#11141d;isolation:isolate}.v14Portrait:before{content:"";position:absolute;right:-6px;top:8px;width:65px;height:65px;background-image:var(--v14-team-logo);background-repeat:no-repeat;background-position:center;background-size:contain;opacity:.88;filter:brightness(1.25) saturate(1.18);z-index:0}.v14Portrait>img{position:absolute!important;z-index:2!important;left:2px!important;bottom:0!important;width:78px!important;height:78px!important;object-fit:contain!important;background:transparent!important;margin:0!important;border-radius:0!important}.v14Country{position:absolute;z-index:3;left:4px;top:5px;writing-mode:vertical-rl;text-orientation:upright;font:1000 10px/1 Arial;letter-spacing:1.5px;color:#fff;text-shadow:0 0 3px #000,0 0 7px #ff7a1a,0 0 13px #ff5a00;filter:brightness(1.45)}'+
'.v14TeamBody{display:grid;gap:10px}.v14TeamMetrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.v14TeamMetric{padding:11px;min-height:93px;position:relative;overflow:hidden;background:linear-gradient(180deg,#13151d,#0f1117);border:1px solid #2a2d38;border-radius:16px}.v14TeamMetric.orange{border-color:#5f331f}.v14TeamMetric.lav{border-color:#4e3a69}.v14TeamMetric .label{font-size:10px;color:#a3a6b2;margin-bottom:7px}.v14TeamMetric .value{font:900 23px/1 Arial;margin-bottom:7px}.v14TeamMetric .sub{font-size:9px;color:#8c90a0}.v14TeamMetric .bar{height:6px;background:#272b38;border-radius:999px;overflow:hidden;margin:8px 0 5px}.v14TeamMetric .fill{height:100%;border-radius:999px;background:linear-gradient(90deg,#ff5a00,#ff964d)}.v14TeamMetric.lav .fill{background:linear-gradient(90deg,#7f56ff,#c08cff)}'+
'.v14Coverage{font-size:9px;color:#8f93a7;border:1px solid #262936;border-radius:11px;padding:8px 9px}.v14Coverage strong{color:#d7d9e2}.v14List{display:grid;gap:6px}.v14Roster{display:grid;grid-template-columns:34px minmax(0,1fr) 78px;gap:8px;align-items:center;padding:9px 10px;border:1px solid #252833;border-radius:12px;background:#101219}.v14Roster .num{font-size:10px;color:#9da1b0;text-align:center}.v14Roster b{font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.v14Roster small{display:block;font-size:8px;color:#777d91;margin-top:2px}.v14Roster .stat{text-align:right;font-size:9px;color:#cbb4ef}.v14Game{display:grid;grid-template-columns:70px minmax(0,1fr) auto;gap:8px;align-items:center;padding:9px 10px;border:1px solid #252833;border-radius:12px;background:#101219}.v14Game .date{font-size:8px;color:#8f93a7}.v14Game b{font-size:11px}.v14Game .score{font-size:11px;font-weight:950}.v14SectionTitle{font-size:9px;color:#cbb4ef;text-transform:uppercase;letter-spacing:.6px;font-weight:950;margin:4px 1px 0}.v14Empty{padding:24px 12px;text-align:center;border:1px dashed #353846;border-radius:13px;color:#9296a8;font-size:10px}.v14Table{display:grid;gap:3px}.v14TableRow{display:grid;grid-template-columns:24px 34px minmax(0,1fr) 30px 40px;gap:5px;align-items:center;padding:6px 7px;border-radius:9px;font-size:9px}.v14TableRow.sel{background:#2a2133;border:1px solid #694c82}.v14TableRow img{width:24px;height:24px;object-fit:contain}.v14TableRow b{font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'+
'.rankTxt .v14Gold{color:#f6c64f!important;text-shadow:0 0 8px #d6a31e55;font-weight:950}.metric .rankTxt{line-height:1.25!important;min-height:12px}.metric.v14NoGold .rankTxt .v14Gold{color:#aaa!important;text-shadow:none!important;font-weight:700}'+
'@media(max-width:390px){.v14Portrait{width:86px;flex-basis:86px}.v14TeamMetric{min-height:88px;padding:10px}.v14TeamMetric .value{font-size:21px}}';document.head.appendChild(s)}
function teamTri(){const h=document.querySelector('#view .profileHead:not(.player)'),m=h&&h.querySelector('.meta'),x=String(m&&m.textContent||'').match(/\b([A-Z]{3})\b/);return x?x[1]:''}
function teamEls(){return{head:document.querySelector('#view .profileHead:not(.player)'),sel:document.querySelector('#view select.season'),body:document.querySelector('#view .profileBody'),tabs:Array.from(document.querySelectorAll('#view .profileTabs button'))}}
function secName(b){const t=String(b.textContent||'').toLowerCase();if(t.includes('состав'))return'roster';if(t.includes('статист'))return'stats';if(t.includes('распис'))return'schedule';if(t.includes('таблиц'))return'table';return'overview'}
function metric(label,value,sub,kind,pct){return '<div class="v14TeamMetric '+(kind||'')+'"><div class="label">'+esc(label)+'</div><div class="value">'+esc(value==null?'—':value)+'</div><div class="bar"><div class="fill" style="width:'+Math.max(4,Math.min(100,Number(pct)||0))+'%"></div></div><div class="sub">'+esc(sub||'')+'</div></div>'}
function coverage(c){return '<div class="v14Coverage"><strong>Данные</strong> · состав: '+esc(c.roster_source||'—')+' · обычные: '+esc(c.standard_games||0)+' игр · advanced: '+esc(c.advanced_games||0)+' игр</div>'}
function dateText(v){if(!v)return'—';const d=new Date(v);return Number.isFinite(d.getTime())?d.toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit',year:'2-digit'}):String(v).slice(0,10)}
function gameRow(g,tri){const opp=g.opponent_tri||(String(g.home_tri||'').toUpperCase()===tri?g.away_tri:g.home_tri),fin=['FINAL','OFF'].includes(String(g.game_state||'').toUpperCase()),home=String(g.home_tri||'').toUpperCase()===tri,score=fin?(home?g.home_score:g.away_score)+' : '+(home?g.away_score:g.home_score):'—';return '<div class="v14Game"><div class="date">'+esc(dateText(g.scheduled_start_utc))+'</div><b>'+esc(opp||'—')+'</b><div class="score">'+esc(score)+'</div></div>'}
function overview(d,tri){const s=d.standings||{},gp=Number(s.games_played||0),max=Math.max(Number(s.goals_for||0),Number(s.goals_against||0),1);return '<div class="v14TeamBody"><div class="v14TeamMetrics">'+metric('В–П–ОТ',(s.wins||0)+'–'+(s.losses||0)+'–'+(s.ot_losses||0),gp+' матчей','lav',gp?Number(s.wins||0)*100/gp:0)+metric('Очки',s.points||0,'регулярка','orange',Math.min(100,Number(s.points||0)/1.4))+metric('Забито',s.goals_for||0,'разница '+(Number(s.goal_diff||0)>0?'+':'')+Number(s.goal_diff||0),'orange',Number(s.goals_for||0)*100/max)+metric('Пропущено',s.goals_against||0,'регулярка','lav',Number(s.goals_against||0)*100/max)+'</div>'+coverage(d.coverage||{})+(d.next_game?'<div><div class="v14SectionTitle">Ближайший матч</div>'+gameRow(d.next_game,tri)+'</div>':'')+'<div><div class="v14SectionTitle">Последние матчи</div><div class="v14List">'+((d.recent||[]).slice(0,5).map(g=>gameRow(g,tri)).join('')||'<div class="v14Empty">Матчей пока нет</div>')+'</div></div></div>'}
function roster(d){const rows=d.roster||[];if(!rows.length)return'<div class="v14Empty">Состав не найден.</div>';return'<div class="v14List">'+rows.map(p=>'<div class="v14Roster"><div class="num">'+esc(p.sweater_number?'#'+p.sweater_number:(p.position_code||''))+'</div><div><b>'+esc(p.full_name_ru||p.full_name_en||('Player '+p.player_id))+'</b><small>'+esc((p.position_code||'')+' · '+(p.games||0)+' игр')+'</small></div><div class="stat">'+esc((p.goals||0)+'+'+(p.assists||0)+' = '+(p.points||0))+'</div></div>').join('')+'</div>'}
function fmt(v,d=1){const n=Number(v);return Number.isFinite(n)?n.toFixed(d).replace(/\.0$/,''):'—'}
function stats(d){const s=d.standard_stats||{},a=d.advanced_stats||{};const standard=s.games?'<div class="v14TeamMetrics">'+metric('Броски / матч',fmt(s.shots_for_pg), 'в створ','orange',60)+metric('Броски соп. / матч',fmt(s.shots_against_pg),'в створ','lav',60)+metric('Большинство',s.power_play_pct==null?'—':fmt(s.power_play_pct)+'%',(s.power_play_goals||0)+' / '+(s.power_play_opportunities||0),'orange',s.power_play_pct||0)+metric('Вбрасывания',s.faceoff_pct==null?'—':fmt(s.faceoff_pct)+'%','FO%','lav',s.faceoff_pct||0)+metric('Хиты',s.hits,'за сезон','',50)+metric('Блоки',s.blocked_shots,'за сезон','',50)+metric('Потери',s.giveaways,'за сезон','',50)+metric('Перехваты',s.takeaways,'за сезон','',50)+'</div>':'<div class="v14Empty">Обычная детальная статистика этого сезона пока отсутствует.</div>';const adv=a.games?'<div class="v14TeamMetrics">'+metric('xGF%',fmt(a.xgf_pct_5v5)+'%','5-на-5','lav',a.xgf_pct_5v5)+metric('CF%',fmt(a.corsi_for_pct_5v5)+'%','5-на-5','orange',a.corsi_for_pct_5v5)+metric('FF%',fmt(a.fenwick_for_pct_5v5)+'%','5-на-5','lav',a.fenwick_for_pct_5v5)+metric('SF%',fmt(a.sf_pct_5v5)+'%','5-на-5','orange',a.sf_pct_5v5)+metric('xGF/60',fmt(a.xgf60,2),'5-на-5','',50)+metric('xGA/60',fmt(a.xga60,2),'5-на-5','',50)+metric('PDO',fmt(a.pdo_5v5),'5-на-5','',50)+metric('GSAx',fmt(a.goals_saved_above_expected),'сумма','',50)+'</div>':'<div class="v14Empty">Продвинутая статистика этого сезона пока не загружена.</div>';return'<div class="v14TeamBody"><div class="v14SectionTitle">Обычная статистика</div>'+standard+'<div class="v14SectionTitle">Продвинутая · 5-на-5</div>'+adv+coverage(d.coverage||{})+'</div>'}
function schedule(d,tri){const rows=d.schedule||[];return'<div class="v14List">'+(rows.length?rows.map(g=>gameRow(g,tri)).join(''):'<div class="v14Empty">Расписание недоступно.</div>')+'</div>'}
async function table(head,tri,season){const {body}=teamEls();if(!body)return;body.innerHTML='<div class="v14Empty">Загрузка таблицы...</div>';try{const d=await api(API+'/teams/'+tri+'/season/'+season+'/table'),rows=d.table||[];body.innerHTML='<div class="v14Table">'+(rows.length?rows.map((x,i)=>'<div class="v14TableRow '+(x.team_tri===tri?'sel':'')+'"><div>'+esc(x.league_sequence||i+1)+'</div><img src="'+esc(x.logo||('https://assets.nhle.com/logos/nhl/svg/'+x.team_tri+'_light.svg'))+'"><b>'+esc(x.name||x.team_tri)+'</b><div>'+esc(x.games_played||0)+'</div><div><b>'+esc(x.points||0)+'</b> оч.</div></div>').join(''):'<div class="v14Empty">Таблица недоступна.</div>')+'</div>'}catch(e){body.innerHTML='<div class="v14Empty">Не удалось загрузить таблицу.</div>'}}
async function renderTeam(head,section){const {body,tabs}=teamEls(),d=head._v14Data,tri=head.dataset.v14Tri,season=head.dataset.v14Season;if(!body||!d)return;tabs.forEach(b=>b.classList.toggle('active',secName(b)===section));head.dataset.v14Section=section;if(section==='overview')body.innerHTML=overview(d,tri);else if(section==='roster')body.innerHTML=roster(d);else if(section==='stats')body.innerHTML=stats(d);else if(section==='schedule')body.innerHTML=schedule(d,tri);else if(section==='table')await table(head,tri,season)}
async function loadTeam(head,tri,season){const {body}=teamEls();if(body)body.innerHTML='<div class="v14Empty">Загрузка данных команды...</div>';try{const d=await api(API+'/teams/'+tri+'/season/'+season+'?v14='+Date.now());head._v14Data=d;head.dataset.v14Season=season;await renderTeam(head,head.dataset.v14Section||'overview')}catch(e){if(body)body.innerHTML='<div class="v14Empty">Ошибка загрузки команды: '+esc(e.message||e)+'</div>'}}
async function bindTeam(){const e=teamEls(),tri=teamTri();if(!e.head||!e.sel||!e.body||e.tabs.length<5||!tri)return;e.head.dataset.v13Tri=tri;if(e.head.dataset.v14Bound===tri)return;e.head.dataset.v14Bound=tri;e.head.dataset.v14Tri=tri;e.head.dataset.v14Section='overview';e.tabs.forEach(b=>{const sec=secName(b);b.onclick=ev=>{ev.preventDefault();ev.stopPropagation();renderTeam(e.head,sec)}});try{const sd=await api(API+'/teams/'+tri+'/seasons?v14='+Date.now()),old=String(e.sel.value||'').replace(/\D/g,'');e.sel.innerHTML=(sd.seasons||[]).map((s,i)=>'<option value="'+esc(s.season_id)+'" '+((old===s.season_id||(!old&&i===0))?'selected':'')+'>'+esc(s.label)+(s.advanced_available?' · ADV':'')+'</option>').join('');if(!e.sel.value&&sd.seasons&&sd.seasons[0])e.sel.value=sd.seasons[0].season_id;e.sel.onchange=()=>{e.head.dataset.v14Section='overview';loadTeam(e.head,tri,e.sel.value)};await loadTeam(e.head,tri,e.sel.value)}catch(err){e.head.dataset.v14Bound='';e.body.innerHTML='<div class="v14Empty">Не удалось загрузить сезоны.</div>'}}
function playerId(){const head=document.querySelector('#view .profileHead.player'),img=head&&head.querySelector('img'),m=String(img&&img.src||'').match(/\/(\d{6,})\.(?:png|jpe?g|webp)(?:\?|$)/i);return m?m[1]:''}
async function decoratePlayer(){const head=document.querySelector('#view .profileHead.player'),id=playerId();if(!head||!id)return;if(head.dataset.v14Player===id){syncPlayerStats(head,id);return}head.dataset.v14Player=id;try{const d=await api(API+'/players/'+id+'/card?v14='+Date.now());let img=head.querySelector('.v14Portrait>img')||head.querySelector('.v12PhotoWrap img')||head.querySelector(':scope > img');if(!img)return;let portrait=head.querySelector('.v14Portrait');if(!portrait){portrait=document.createElement('div');portrait.className='v14Portrait';const old=img.parentElement&&img.parentElement.classList.contains('v12PhotoWrap')?img.parentElement:null;(old||img).parentNode.insertBefore(portrait,old||img);portrait.appendChild(img);if(old)old.remove()}portrait.style.setProperty('--v14-team-logo','url("'+String(d.team_logo||'').replace(/"/g,'')+'")');let c=portrait.querySelector('.v14Country');if(!c){c=document.createElement('span');c.className='v14Country';portrait.appendChild(c)}c.textContent=d.country_code||'NHL';head.dataset.v14Country=d.country_code||'';head.dataset.v14Team=d.team_tri||'';const audio=head.querySelector('.v12Audio,.v11Audio');if(audio)audio.classList.add('v14Audio');syncPlayerStats(head,id,true)}catch(e){head.dataset.v14Player=''}}
function rankHtml(teamRank,leagueRank,noGold){const parts=[];if(teamRank){const g=!noGold&&teamRank<=10;parts.push('<span class="'+(g?'v14Gold':'')+'">№'+teamRank+' в команде</span>')}if(leagueRank&&leagueRank<=50){const g=!noGold&&leagueRank<=10;parts.push('<span class="'+(g?'v14Gold':'')+'">№'+leagueRank+' в НХЛ</span>')}return parts.join(' · ')}
function applyPlayerStats(head,d){head._v14Stats=d;const cards=Array.from(document.querySelectorAll('#view .metrics .metric')).slice(0,4);if(cards.length<4)return;const defs=[['goals','Голы',3,false],['assists','Передачи',2,false],['points','Очки',1.4,false],['games_played','Матчи',1.2,true]];defs.forEach((x,i)=>{const [key,label,mult,noGold]=x,card=cards[i],val=Number(d.stats&&d.stats[key]||0),lab=card.querySelector('.label'),v=card.querySelector('.value'),rank=card.querySelector('.rankTxt'),fill=card.querySelector('.fill');if(lab)lab.textContent=label;if(v)v.textContent=String(val);if(fill)fill.style.width=Math.max(val?4:0,Math.min(100,val*mult))+'%';if(rank){rank.innerHTML=rankHtml(d.ranks&&d.ranks.team&&d.ranks.team[key+'_rank'],d.ranks&&d.ranks.league&&d.ranks.league[key+'_rank'],noGold);card.classList.toggle('noRank',!rank.textContent)}card.classList.toggle('v14NoGold',noGold)})}
function syncPlayerStats(head,id,force){const sel=document.querySelector('#view select.season');if(!sel)return;if(!sel.dataset.v14Bound){sel.dataset.v14Bound='1';sel.addEventListener('change',()=>setTimeout(()=>syncPlayerStats(head,id,true),180))}const season=String(sel.value||'').replace(/\D/g,'');if(!/^20\d{6}$/.test(season))return;if(!force&&head.dataset.v14StatsSeason===season&&head._v14Stats){applyPlayerStats(head,head._v14Stats);return}head.dataset.v14StatsSeason=season;api(API+'/players/'+id+'/season/'+season+'?v14='+Date.now()).then(d=>{head._v14Stats=d;applyPlayerStats(head,d)}).catch(()=>{head.dataset.v14StatsSeason=''})}
function run(){css();const badge=document.querySelector('.v8');if(badge)badge.setAttribute('data-active-version','V14');if(document.querySelector('#view .profileHead.player'))decoratePlayer();else if(document.querySelector('#view .profileHead:not(.player)'))bindTeam()}
let timer=null;const obs=new MutationObserver(()=>{clearTimeout(timer);timer=setTimeout(run,70)});obs.observe(document.documentElement,{subtree:true,childList:true,characterData:true});document.addEventListener('click',()=>setTimeout(run,100),true);run();
})();`;
