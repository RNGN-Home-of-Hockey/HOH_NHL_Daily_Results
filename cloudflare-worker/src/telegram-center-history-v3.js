const API = "/api/telegram-center-v3";
const SCRIPT_PATH = "/telegram-app/history-v3.js";
const NHL = "https://api-web.nhle.com/v1";

export async function handleTelegramCenterHistoryV3(request, env, path) {
  if (path === SCRIPT_PATH) {
    if (request.method !== "GET") return json({ok:false,error:"method_not_allowed"},405);
    return new Response(HISTORY_JS,{headers:{"Content-Type":"application/javascript; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
  }
  if (!path.startsWith(API)) return null;
  if (!env.DB) return json({ok:false,error:"missing_d1_binding"},503);

  if (path === `${API}/seasons` && request.method === "GET") return seasons(env);

  const teamMatch = new RegExp(`^${API}/teams/([A-Za-z]{3})$`).exec(path);
  if (teamMatch && request.method === "GET") return teamSeason(request,env,teamMatch[1].toUpperCase());

  const playerMatch = new RegExp(`^${API}/players/(\\d+)$`).exec(path);
  if (playerMatch && request.method === "GET") return playerSeason(request,env,Number(playerMatch[1]));

  const gameMatch = new RegExp(`^${API}/games/(\\d+)$`).exec(path);
  if (gameMatch && request.method === "GET") return gameProfile(request,env,Number(gameMatch[1]));

  const prefMatch = new RegExp(`^${API}/subscriptions/(\\d+)/preferences$`).exec(path);
  if (prefMatch && request.method === "GET") return getPreferences(request,env,Number(prefMatch[1]));
  if (prefMatch && ["PUT","POST"].includes(request.method)) return putPreferences(request,env,Number(prefMatch[1]));

  const suggestMatch = new RegExp(`^${API}/suggestions/(player|team)/([^/]+)$`).exec(path);
  if (suggestMatch && request.method === "GET") return suggestions(request,env,suggestMatch[1],decodeURIComponent(suggestMatch[2]));

  return json({ok:false,error:"not_found"},404);
}

async function seasons(env){
  try{
    const rows=await env.DB.prepare(`SELECT DISTINCT CAST(season_id AS TEXT) season_id FROM games ORDER BY CAST(season_id AS INTEGER) DESC LIMIT 8;`).all();
    return json({ok:true,seasons:(rows.results||[]).map(r=>({season_id:String(r.season_id),label:seasonLabel(r.season_id)}))});
  }catch(error){return json({ok:false,error:"seasons_failed",detail:errorText(error)},503)}
}

async function teamSeason(request,env,tri){
  const season=normalizeSeason(new URL(request.url).searchParams.get("season"))||await newestSeason(env);
  try{
    const team=await env.DB.prepare(`SELECT tri_code,name_en,name_ru,logo_url FROM teams WHERE tri_code=? LIMIT 1;`).bind(tri).first();
    if(!team)return json({ok:false,error:"team_not_found"},404);
    const gamesR=await env.DB.prepare(`
      SELECT game_pk,season_id,game_type,scheduled_start_utc,game_state,home_tri,away_tri,home_score,away_score,period_type
      FROM games WHERE season_id=? AND (home_tri=? OR away_tri=?)
      ORDER BY scheduled_start_utc ASC,game_pk ASC;
    `).bind(season,tri,tri).all();
    const teamNames=await teamNameMap(env.DB);
    const games=annotateTeamGames(gamesR.results||[],tri,teamNames);
    const regular=games.filter(g=>Number(g.game_type)===2 && isFinal(g.game_state));
    const playoffs=games.filter(g=>Number(g.game_type)===3 && isFinal(g.game_state));
    const regEnd=regular.length?String(regular[regular.length-1].scheduled_start_utc||"").slice(0,10):null;
    const standings=await loadStandingsForSeason(tri,season,regEnd).catch(()=>null);
    const computed=computeRegularStats(regular,tri);
    const leagueRanks=await computeTeamLeagueRanks(env.DB,season).catch(()=>null);
    const playoff=playoffSummary(playoffs,tri);
    const next=games.find(g=>!isFinal(g.game_state) && Date.parse(g.scheduled_start_utc)>=Date.now()-3600000)||null;
    return json({
      ok:true,season,season_label:seasonLabel(season),team:{...team,logo:team.logo_url||teamLogo(tri)},
      standings:standings||computed,
      league_ranks:leagueRanks?.[tri]||null,
      playoff,
      next_game:next,
      recent:[...games].reverse().filter(g=>isFinal(g.game_state)).slice(0,12),
      schedule:games,
      updated_at:new Date().toISOString(),
    });
  }catch(error){console.error("center v3 team season failed",tri,season,error);return json({ok:false,error:"team_season_failed",detail:errorText(error)},503)}
}

async function playerSeason(request,env,playerId){
  if(!Number.isSafeInteger(playerId)||playerId<=0)return json({ok:false,error:"invalid_player_id"},400);
  const season=normalizeSeason(new URL(request.url).searchParams.get("season"))||await newestSeason(env);
  try{
    const row=await env.DB.prepare(`
      SELECT p.player_id,p.full_name_en,p.full_name_ru,p.current_team_tri,p.position_code,p.sweater_number,p.shoots_catches,
             m.full_name_ru meta_name_ru,m.sports_ru_url,m.eliteprospects_url,m.pronunciation_url,
             m.primary_country_code,m.countries_json
      FROM players p LEFT JOIN player_profile_meta m ON m.player_id=p.player_id
      WHERE p.player_id=? LIMIT 1;
    `).bind(playerId).first();
    if(!row)return json({ok:false,error:"player_not_found"},404);
    const [landing,regularLog,playoffLog]=await Promise.all([
      fetchNhl(`${NHL}/player/${playerId}/landing`).catch(()=>null),
      fetchNhl(`${NHL}/player/${playerId}/game-log/${season}/2`).catch(()=>null),
      fetchNhl(`${NHL}/player/${playerId}/game-log/${season}/3`).catch(()=>null),
    ]);
    const regular=aggregateGameLog(regularLog?.gameLog||regularLog?.games||[],row.position_code);
    const playoffs=aggregateGameLog(playoffLog?.gameLog||playoffLog?.games||[],row.position_code);
    const teamTri=upper(landing?.currentTeamAbbrev||row.current_team_tri);
    const [teamRank,leagueRank,nextGame] = await Promise.all([
      playerTeamRank(playerId,teamTri,season,row.position_code).catch(()=>null),
      playerLeagueRank(playerId,season,row.position_code).catch(()=>null),
      nextTeamGame(env.DB,teamTri,season).catch(()=>null),
    ]);
    const nations=parseCountries(row.countries_json,row.primary_country_code||landing?.birthCountry);
    const russianName=row.meta_name_ru||row.full_name_ru||null;
    return json({
      ok:true,season,season_label:seasonLabel(season),
      player:{
        player_id:playerId,full_name_en:row.full_name_en,full_name_ru:russianName,current_team_tri:teamTri,
        position_code:row.position_code,sweater_number:row.sweater_number,shoots_catches:row.shoots_catches,
        photo:landing?.headshot||playerPhoto(playerId,teamTri,season),team_logo:landing?.teamLogo||teamLogo(teamTri),
        countries:nations,flags:nations.map(flagEmoji),sports_ru_url:row.sports_ru_url||null,
        eliteprospects_url:row.eliteprospects_url||null,pronunciation_url:row.pronunciation_url||null,
        birth_country:landing?.birthCountry||null,birth_city:landing?.birthCity?.default||landing?.birthCity||null,birth_date:landing?.birthDate||null,
      },
      regular_season:regular,
      playoffs,
      ranks:{team:teamRank,league:leagueRank},
      next_game:nextGame,
      updated_at:new Date().toISOString(),
    });
  }catch(error){console.error("center v3 player season failed",playerId,season,error);return json({ok:false,error:"player_season_failed",detail:errorText(error)},503)}
}

async function gameProfile(request,env,gamePk){
  if(!Number.isSafeInteger(gamePk)||gamePk<=0)return json({ok:false,error:"invalid_game_pk"},400);
  try{
    let game=await env.DB.prepare(`SELECT * FROM games WHERE game_pk=? LIMIT 1;`).bind(gamePk).first();
    const landing=await fetchNhl(`${NHL}/gamecenter/${gamePk}/landing`).catch(()=>null);
    if(!game && landing) game=gameFromLanding(landing,gamePk);
    if(!game)return json({ok:false,error:"game_not_found"},404);
    const names=await teamNameMap(env.DB);
    const stage=gameStage(game);
    const [periods,teamStats,playerStats,eventR,marketPack]=await Promise.all([
      env.DB.prepare(`SELECT period_number,period_type,home_goals,away_goals FROM period_scores WHERE game_pk=? ORDER BY period_number;`).bind(gamePk).all().catch(()=>({results:[]})),
      env.DB.prepare(`SELECT * FROM team_game_stats WHERE game_pk=? ORDER BY is_home;`).bind(gamePk).all().catch(()=>({results:[]})),
      env.DB.prepare(`SELECT s.*,p.full_name_en,p.full_name_ru,p.position_code,p.sweater_number FROM player_game_stats s JOIN players p ON p.player_id=s.player_id WHERE s.game_pk=? ORDER BY s.points DESC,s.goals DESC,s.shots DESC;`).bind(gamePk).all().catch(()=>({results:[]})),
      env.DB.prepare(`SELECT event_key,event_type,period_number,period_type,time_in_period,team_tri,home_score,away_score,description,details_json FROM game_events WHERE game_pk=? ORDER BY sort_order;`).bind(gamePk).all().catch(()=>({results:[]})),
      loadAllWinlineMarkets(env.DB,gamePk),
    ]);
    return json({
      ok:true,
      game:{...game,...stage,home_name:names[game.home_tri]||game.home_tri,away_name:names[game.away_tri]||game.away_tri,home_logo:teamLogo(game.home_tri),away_logo:teamLogo(game.away_tri)},
      landing:landing?compactLanding(landing):null,
      periods:periods.results||[],team_stats:teamStats.results||[],player_stats:playerStats.results||[],events:eventR.results||[],
      markets:marketPack.markets,event_market:marketPack.event,
      updated_at:new Date().toISOString(),
    });
  }catch(error){console.error("center v3 game profile failed",gamePk,error);return json({ok:false,error:"game_profile_failed",detail:errorText(error)},503)}
}

async function getPreferences(request,env,id){
  const auth=await centerTelegramAuth(request,env,true);if(!auth.ok)return json({ok:false,error:auth.error},401);
  const own=await ownedSubscription(env.DB,id,auth.user.id);if(!own)return json({ok:false,error:"subscription_not_found"},404);
  const row=await env.DB.prepare(`SELECT * FROM subscription_preferences WHERE subscription_id=? LIMIT 1;`).bind(id).first().catch(()=>null);
  return json({ok:true,subscription:own,preferences:row||defaultPreferences(own.subject_type)});
}

async function putPreferences(request,env,id){
  const auth=await centerTelegramAuth(request,env,true);if(!auth.ok)return json({ok:false,error:auth.error},401);
  const own=await ownedSubscription(env.DB,id,auth.user.id);if(!own)return json({ok:false,error:"subscription_not_found"},404);
  let body={};try{body=await request.json()}catch{return json({ok:false,error:"invalid_json"},400)}
  const p=sanitizePreferences(body,own.subject_type);
  await env.DB.prepare(`
    INSERT INTO subscription_preferences (subscription_id,notify_pregame,notify_start,notify_goal,notify_assist,notify_point,notify_period_end,notify_final,notify_odds,notify_trends,notify_lineup,notify_injury,notify_daily_digest,quiet_hours_start,quiet_hours_end,max_pushes_per_day,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(subscription_id) DO UPDATE SET notify_pregame=excluded.notify_pregame,notify_start=excluded.notify_start,notify_goal=excluded.notify_goal,notify_assist=excluded.notify_assist,notify_point=excluded.notify_point,notify_period_end=excluded.notify_period_end,notify_final=excluded.notify_final,notify_odds=excluded.notify_odds,notify_trends=excluded.notify_trends,notify_lineup=excluded.notify_lineup,notify_injury=excluded.notify_injury,notify_daily_digest=excluded.notify_daily_digest,quiet_hours_start=excluded.quiet_hours_start,quiet_hours_end=excluded.quiet_hours_end,max_pushes_per_day=excluded.max_pushes_per_day,updated_at=CURRENT_TIMESTAMP;
  `).bind(id,p.notify_pregame,p.notify_start,p.notify_goal,p.notify_assist,p.notify_point,p.notify_period_end,p.notify_final,p.notify_odds,p.notify_trends,p.notify_lineup,p.notify_injury,p.notify_daily_digest,p.quiet_hours_start,p.quiet_hours_end,p.max_pushes_per_day).run();
  return json({ok:true,subscription_id:id,preferences:p});
}

async function suggestions(request,env,type,key){
  try{
    if(type==="player"){
      const id=Number(key);if(!Number.isSafeInteger(id))return json({ok:false,error:"invalid_player_id"},400);
      const p=await env.DB.prepare(`SELECT p.player_id,p.full_name_en,p.full_name_ru,p.current_team_tri,m.primary_country_code,m.countries_json FROM players p LEFT JOIN player_profile_meta m ON m.player_id=p.player_id WHERE p.player_id=? LIMIT 1;`).bind(id).first();
      if(!p)return json({ok:false,error:"player_not_found"},404);
      const country=upper(p.primary_country_code||"");
      const related=country?await env.DB.prepare(`
        SELECT p.player_id,p.full_name_en,COALESCE(m.full_name_ru,p.full_name_ru) full_name_ru,p.current_team_tri,m.primary_country_code
        FROM players p JOIN player_profile_meta m ON m.player_id=p.player_id
        WHERE p.active=1 AND p.player_id<>? AND (m.primary_country_code=? OR m.countries_json LIKE '%'||?||'%')
        ORDER BY CASE WHEN p.current_team_tri=? THEN 0 ELSE 1 END,p.full_name_en LIMIT 3;
      `).bind(id,country,country,p.current_team_tri).all():{results:[]};
      const groups=[];
      if(country==="RUS")groups.push({group_key:"RUS_NHL",title_ru:"Все россияне в НХЛ",description_ru:"Одна подписка на российских игроков НХЛ"});
      return json({ok:true,subject:p,related:related.results||[],groups});
    }
    const team=await env.DB.prepare(`SELECT tri_code,name_en,name_ru FROM teams WHERE tri_code=? LIMIT 1;`).bind(upper(key)).first();
    return json({ok:true,subject:team,related:[],groups:[]});
  }catch(error){return json({ok:false,error:"suggestions_failed",detail:errorText(error)},503)}
}

async function newestSeason(env){const r=await env.DB.prepare(`SELECT CAST(season_id AS TEXT) season_id FROM games ORDER BY CAST(season_id AS INTEGER) DESC LIMIT 1;`).first();return String(r?.season_id||currentSeasonId())}

async function loadStandingsForSeason(tri,season,regularEnd){
  const current=String(season)===String(currentSeasonId());
  const endpoint=current?`${NHL}/standings/now`:regularEnd?`${NHL}/standings/${regularEnd}`:null;
  if(!endpoint)return null;
  const d=await fetchNhl(endpoint);const row=(d?.standings||[]).find(x=>upper(x?.teamAbbrev?.default||x?.teamAbbrev)===tri);if(!row)return null;
  return {season_id:row.seasonId||season,games_played:n(row.gamesPlayed),wins:n(row.wins),losses:n(row.losses),ot_losses:n(row.otLosses),points:n(row.points),goals_for:n(row.goalFor),goals_against:n(row.goalAgainst),goal_diff:n(row.goalDifferential),league_sequence:n(row.leagueSequence),conference_sequence:n(row.conferenceSequence),division_sequence:n(row.divisionSequence),conference_name:localized(row.conferenceName),division_name:localized(row.divisionName)};
}

async function computeTeamLeagueRanks(db,season){
  const r=await db.prepare(`
    WITH x AS (
      SELECT t.tri_code,
        SUM(CASE WHEN g.game_type=2 AND g.game_state IN ('FINAL','OFF') AND ((g.home_tri=t.tri_code AND g.home_score>g.away_score) OR (g.away_tri=t.tri_code AND g.away_score>g.home_score)) THEN 1 ELSE 0 END) wins,
        SUM(CASE WHEN g.game_type=2 AND g.game_state IN ('FINAL','OFF') THEN CASE WHEN g.home_tri=t.tri_code THEN g.home_score ELSE g.away_score END ELSE 0 END) gf,
        SUM(CASE WHEN g.game_type=2 AND g.game_state IN ('FINAL','OFF') THEN CASE WHEN g.home_tri=t.tri_code THEN g.away_score ELSE g.home_score END ELSE 0 END) ga
      FROM teams t LEFT JOIN games g ON g.season_id=? AND (g.home_tri=t.tri_code OR g.away_tri=t.tri_code)
      WHERE COALESCE(t.active,1)=1 GROUP BY t.tri_code
    ), ranked AS (
      SELECT *,RANK() OVER (ORDER BY gf DESC) gf_rank,RANK() OVER (ORDER BY ga ASC) ga_rank,RANK() OVER (ORDER BY wins DESC) wins_rank FROM x
    ) SELECT * FROM ranked;
  `).bind(season).all();
  const out={};for(const row of r.results||[])out[row.tri_code]=row;return out;
}

function annotateTeamGames(rows,tri,names){
  let regNo=0;return (rows||[]).map(g=>{
    const stage=gameStage(g);let teamGameNo=null;if(Number(g.game_type)===2)teamGameNo=++regNo;
    const opponent=g.home_tri===tri?g.away_tri:g.home_tri;
    return {...g,...stage,team_game_no:teamGameNo,opponent_tri:opponent,opponent_name:names[opponent]||opponent,is_home:g.home_tri===tri};
  });
}

function gameStage(g){
  const type=Number(g.game_type);if(type===1)return {stage_code:"PRE",stage_label_ru:"Предсезон",stage_color:"#7a7a84",playoff_round:null,playoff_game_no:null};
  if(type===2)return {stage_code:"REG",stage_label_ru:"Регулярный чемпионат",stage_color:"#66b7ff",playoff_round:null,playoff_game_no:null};
  if(type===3){const suffix=Number(String(g.game_pk).slice(-4));const compact=suffix%1000;const round=Math.floor(compact/100)||null;const gameNo=compact%10||null;const labels={1:"1-й раунд",2:"2-й раунд",3:"Финал конференции",4:"Финал Кубка Стэнли"};const colors={1:"#8e7dff",2:"#c7b7ff",3:"#ff8d5c",4:"#e7bd55"};return {stage_code:`PO${round||""}`,stage_label_ru:labels[round]||"Плей-офф",stage_color:colors[round]||"#c7b7ff",playoff_round:round,playoff_game_no:gameNo};}
  return {stage_code:"OTHER",stage_label_ru:"Матч НХЛ",stage_color:"#85858e",playoff_round:null,playoff_game_no:null};
}

function playoffSummary(rows,tri){if(!rows.length)return {reached:false,stage:"Не участвовала в плей-офф",round:0};const enriched=rows.map(gameStage);const maxRound=Math.max(...enriched.map(x=>Number(x.playoff_round||0)));const labels={1:"1-й раунд",2:"2-й раунд",3:"Финал конференции",4:"Финал Кубка Стэнли"};let stage=labels[maxRound]||"Плей-офф";if(maxRound===4){const last=[...rows].sort((a,b)=>Date.parse(b.scheduled_start_utc)-Date.parse(a.scheduled_start_utc))[0];const tg=last.home_tri===tri?last.home_score:last.away_score,og=last.home_tri===tri?last.away_score:last.home_score;if(Number(tg)>Number(og))stage="Обладатель Кубка Стэнли";}return {reached:true,round:maxRound,stage,color:gameStage(rows.find(x=>gameStage(x).playoff_round===maxRound)||rows[0]).stage_color};}

function computeRegularStats(rows,tri){let wins=0,losses=0,otl=0,gf=0,ga=0;for(const g of rows){const a=g.home_tri===tri?Number(g.home_score):Number(g.away_score),b=g.home_tri===tri?Number(g.away_score):Number(g.home_score);gf+=a||0;ga+=b||0;if(a>b)wins++;else if(["OT","SO"].includes(upper(g.period_type)))otl++;else losses++;}return {games_played:rows.length,wins,losses,ot_losses:otl,points:wins*2+otl,goals_for:gf,goals_against:ga,goal_diff:gf-ga};}

async function playerTeamRank(playerId,tri,season,pos){if(!tri)return null;const d=await fetchNhl(`${NHL}/club-stats/${tri}/${season}/2`);const list=String(pos).toUpperCase()==="G"?(d?.goalies||[]):(d?.skaters||[]);const metric=String(pos).toUpperCase()==="G"?"savePctg":"points";const sorted=[...list].sort((a,b)=>Number(b?.[metric]||0)-Number(a?.[metric]||0));const i=sorted.findIndex(x=>Number(x.playerId)===playerId);return i<0?null:{metric,rank:i+1,total:sorted.length,value:n(sorted[i]?.[metric])}}
async function playerLeagueRank(playerId,season,pos){const goalie=String(pos).toUpperCase()==="G";const metric=goalie?"savePctg":"points";const base=goalie?"goalie-stats-leaders":"skater-stats-leaders";const d=await fetchNhl(`${NHL}/${base}/${season}/2?categories=${metric}&limit=-1`);const list=d?.[metric]||d?.leaders||[];const i=list.findIndex(x=>Number(x.id||x.playerId)===playerId);return i<0?null:{metric,rank:i+1,total:list.length,value:n(list[i]?.value||list[i]?.[metric])}}

function aggregateGameLog(rows,pos){const goalie=String(pos).toUpperCase()==="G";const o={games_played:rows.length,goals:0,assists:0,points:0,shots:0,pim:0,plus_minus:0,power_play_goals:0,wins:0,losses:0,ot_losses:0,saves:0,shots_against:0,goals_against:0,shutouts:0};for(const g of rows){for(const k of ["goals","assists","points","shots","pim","plusMinus","powerPlayGoals","wins","losses","otLosses","saves","shotsAgainst","goalsAgainst","shutouts"]){const key={plusMinus:"plus_minus",powerPlayGoals:"power_play_goals",otLosses:"ot_losses",shotsAgainst:"shots_against",goalsAgainst:"goals_against"}[k]||k;o[key]+=Number(g?.[k]||0)}}if(goalie){o.save_pct=o.shots_against?o.saves/o.shots_against:null;o.gaa=nul()}return o}

async function nextTeamGame(db,tri,season){const now=new Date().toISOString();const g=await db.prepare(`SELECT game_pk,season_id,game_type,scheduled_start_utc,game_state,home_tri,away_tri,home_score,away_score FROM games WHERE season_id=? AND (home_tri=? OR away_tri=?) AND scheduled_start_utc>=? AND UPPER(COALESCE(game_state,'')) NOT IN ('FINAL','OFF') ORDER BY scheduled_start_utc ASC LIMIT 1;`).bind(season,tri,tri,now).first();return g?{...g,...gameStage(g),opponent_tri:g.home_tri===tri?g.away_tri:g.home_tri,is_home:g.home_tri===tri}:null}

async function loadAllWinlineMarkets(db,gamePk){try{const event=await db.prepare(`SELECT * FROM winline_events WHERE game_pk=? LIMIT 1;`).bind(gamePk).first();if(!event)return {event:null,markets:[]};const r=await db.prepare(`SELECT winline_market_id,market_type,subject_type,subject_key,outcome_name,odds,deeplink,is_live,active,updated_at FROM winline_markets WHERE winline_event_id=? AND active=1 ORDER BY subject_type,market_type,winline_market_id LIMIT 200;`).bind(event.winline_event_id).all();return {event,markets:r.results||[]}}catch{return {event:null,markets:[]}}}

async function teamNameMap(db){const r=await db.prepare(`SELECT tri_code,COALESCE(name_ru,name_en,tri_code) name FROM teams;`).all();const o={};for(const x of r.results||[])o[x.tri_code]=x.name;return o}
async function ownedSubscription(db,id,userId){return db.prepare(`SELECT subscription_id,subject_type,subject_key FROM subscriptions WHERE subscription_id=? AND telegram_user_id=? LIMIT 1;`).bind(id,userId).first()}
function defaultPreferences(type){return {notify_pregame:1,notify_start:0,notify_goal:1,notify_assist:type==="player"?0:0,notify_point:0,notify_period_end:0,notify_final:1,notify_odds:0,notify_trends:0,notify_lineup:0,notify_injury:0,notify_daily_digest:0,quiet_hours_start:null,quiet_hours_end:null,max_pushes_per_day:12}}
function sanitizePreferences(b,type){const d=defaultPreferences(type),out={};for(const k of ["notify_pregame","notify_start","notify_goal","notify_assist","notify_point","notify_period_end","notify_final","notify_odds","notify_trends","notify_lineup","notify_injury","notify_daily_digest"])out[k]=b[k]===undefined?d[k]:(b[k]?1:0);out.quiet_hours_start=validTime(b.quiet_hours_start)?b.quiet_hours_start:null;out.quiet_hours_end=validTime(b.quiet_hours_end)?b.quiet_hours_end:null;out.max_pushes_per_day=Math.max(1,Math.min(50,Number(b.max_pushes_per_day)||12));return out}
function validTime(v){return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v||""))}

async function centerTelegramAuth(request,env,required){const initData=String(request.headers.get("x-telegram-init-data")||"").trim();if(!initData)return required?{ok:false,error:"missing_telegram_init_data"}:{ok:false,error:"guest"};const token=String(env.TELEGRAM_CENTER_BOT_TOKEN||"").trim();if(!token)return {ok:false,error:"missing_telegram_center_token"};try{const p=new URLSearchParams(initData),provided=p.get("hash")||"",date=Number(p.get("auth_date")||0),userRaw=p.get("user")||"";p.delete("hash");if(!provided||!date||!userRaw)return {ok:false,error:"invalid_telegram_init_data"};if(Math.abs(Math.floor(Date.now()/1000)-date)>604800)return {ok:false,error:"telegram_init_data_expired"};const check=[...p.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join("\n"),enc=new TextEncoder();const k1=await crypto.subtle.importKey("raw",enc.encode("WebAppData"),{name:"HMAC",hash:"SHA-256"},false,["sign"]),secret=await crypto.subtle.sign("HMAC",k1,enc.encode(token)),k2=await crypto.subtle.importKey("raw",secret,{name:"HMAC",hash:"SHA-256"},false,["sign"]),digest=await crypto.subtle.sign("HMAC",k2,enc.encode(check)),calc=hex(new Uint8Array(digest));if(!(await secureEq(calc,provided.toLowerCase())))return {ok:false,error:"telegram_signature_invalid"};const u=JSON.parse(userRaw),id=Number(u.id);if(!Number.isSafeInteger(id))return {ok:false,error:"telegram_user_invalid"};return {ok:true,user:{id,username:u.username||null,first_name:u.first_name||null,last_name:u.last_name||null,language_code:u.language_code||null}}}catch{return {ok:false,error:"telegram_init_data_invalid"}}}

function gameFromLanding(x,id){return {game_pk:id,season_id:String(x.season||""),game_type:x.gameType,scheduled_start_utc:x.startTimeUTC,game_state:x.gameState,home_tri:upper(x.homeTeam?.abbrev),away_tri:upper(x.awayTeam?.abbrev),home_score:n(x.homeTeam?.score)||0,away_score:n(x.awayTeam?.score)||0,period_type:x.periodDescriptor?.periodType||null}}
function compactLanding(x){return {game_state:x.gameState,start_utc:x.startTimeUTC,venue:localized(x.venue),period:x.periodDescriptor||null,clock:x.clock||null,three_stars:x.summary?.threeStars||null}}
function parseCountries(jsonText,primary){try{const a=JSON.parse(jsonText||"[]");if(Array.isArray(a)&&a.length)return [...new Set(a.map(upper).filter(Boolean))]}catch{}return primary?[upper(primary)]:[]}
function flagEmoji(code){const c=upper(code).replace(/[^A-Z]/g,"");if(c.length!==2&&c.length!==3)return "";const map={RUS:"RU",CAN:"CA",USA:"US",SWE:"SE",FIN:"FI",CZE:"CZ",SVK:"SK",DEU:"DE",GER:"DE",CHE:"CH",SUI:"CH",LVA:"LV",DNK:"DK",NOR:"NO",AUT:"AT",BLR:"BY",FRA:"FR",GBR:"GB",SVN:"SI"};const two=c.length===2?c:(map[c]||"");return two?[...two].map(ch=>String.fromCodePoint(127397+ch.charCodeAt(0))).join(""):""}
function teamLogo(tri){return tri?`https://assets.nhle.com/logos/nhl/svg/${tri}_light.svg`:null}
function playerPhoto(id,tri,season){return id&&tri?`https://assets.nhle.com/mugs/nhl/${season}/${tri}/${id}.png`:null}
function seasonLabel(s){const x=String(s||"");return x.length===8?`${x.slice(0,4)}/${x.slice(6,8)}`:x}
function normalizeSeason(v){const s=String(v||"").replace(/\D/g,"");return /^20\d{6}$/.test(s)?s:null}
function currentSeasonId(){const d=new Date(),y=d.getUTCFullYear(),m=d.getUTCMonth()+1,start=m>=7?y:y-1;return `${start}${start+1}`}
function isFinal(s){return ["FINAL","OFF"].includes(upper(s))}
function upper(v){return String(v||"").trim().toUpperCase()}
function localized(v){return v?.default||v?.ru||v?.en||v||null}
function n(v){const x=Number(v);return Number.isFinite(x)?x:null}
function nul(){return null}
function errorText(e){return String(e?.message||e||"unknown_error")}
async function fetchNhl(url){const r=await fetch(url,{headers:{Accept:"application/json"}});if(!r.ok)throw new Error(`NHL HTTP ${r.status}`);return r.json()}
function hex(bytes){return [...bytes].map(x=>x.toString(16).padStart(2,"0")).join("")}
async function secureEq(a,b){const e=new TextEncoder(),[x,y]=await Promise.all([crypto.subtle.digest("SHA-256",e.encode(a)),crypto.subtle.digest("SHA-256",e.encode(b))]),aa=new Uint8Array(x),bb=new Uint8Array(y);let d=aa.length^bb.length;for(let i=0;i<Math.min(aa.length,bb.length);i++)d|=aa[i]^bb[i];return d===0}
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}})}

const HISTORY_JS = String.raw`(function(){
'use strict';
const API='/api/telegram-center-v3';
const tg=window.Telegram&&window.Telegram.WebApp?window.Telegram.WebApp:null,initData=tg&&tg.initData?tg.initData:'';
const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(u,o){o=o||{};const h=Object.assign({},o.headers||{});if(initData)h['X-Telegram-Init-Data']=initData;if(o.body)h['Content-Type']='application/json';const r=await fetch(u,Object.assign({},o,{headers:h,cache:'no-store'})),d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||('HTTP '+r.status));return d}
function css(){if(document.getElementById('centerHistoryV3Css'))return;const s=document.createElement('style');s.id='centerHistoryV3Css';s.textContent='.v2sheet{align-items:stretch!important;padding-top:max(8px,env(safe-area-inset-top))}.v2panel{max-height:none!important;height:100%!important;border-radius:18px 18px 0 0!important;overscroll-behavior:contain}.v2head{top:0!important;margin:-14px -14px 0;padding:14px!important}.v3season{width:100%;margin:8px 0 2px;background:#141416;color:#fff;border:1px solid #303038;border-radius:10px;padding:9px}.v3game{display:grid;grid-template-columns:9px 1fr auto;gap:9px;align-items:center;border:1px solid #25252b;border-radius:11px;padding:9px;margin:6px 0;background:#121214;cursor:pointer}.v3game i{width:9px;height:42px;border-radius:7px}.v3game small{display:block;color:#8a8a94;font-size:8px;margin-top:3px}.v3badge{font-size:8px;border:1px solid #3a3a42;border-radius:99px;padding:3px 7px}.v3rank.gold{color:#e7bd55!important;text-shadow:0 0 14px #e7bd5566}.v3flags{font-size:18px;letter-spacing:2px}.v3audio{border:1px solid #3a3a42;background:#17171a;color:#fff;border-radius:9px;padding:7px 9px}.v3audio.off{opacity:.28}.v3stage{font-size:10px;font-weight:800}.v3full{font-size:11px}.v3gameSheet{position:fixed;inset:0;background:#08080af2;z-index:10020;overflow:auto;padding:16px}.v3gameCard{max-width:720px;margin:auto}.v3teams{display:grid;grid-template-columns:1fr auto 1fr;gap:12px;align-items:center;text-align:center;margin:18px 0}.v3teams img{width:72px;height:72px}.v3score{font-size:30px;font-weight:950}.v3prefs{display:grid;gap:7px}.v3pref{display:flex;justify-content:space-between;align-items:center;background:#151517;border:1px solid #29292f;border-radius:10px;padding:9px}.v3suggest{border:1px solid #2d2d34;border-radius:11px;padding:9px;margin:6px 0}.v3suggest b{display:block}.v3scrollhint{position:sticky;top:0;z-index:10;text-align:center;font-size:8px;color:#777;background:linear-gradient(#0b0b0d,#0b0b0dcc);padding:3px}' ;document.head.appendChild(s)}
function gameRow(g){const no=g.game_type==3?(g.playoff_game_no?'Матч №'+g.playoff_game_no:'Плей-офф'):(g.team_game_no?'Матч №'+g.team_game_no:'Матч');return '<div class="v3game" data-v3-game="'+g.game_pk+'"><i style="background:'+esc(g.stage_color||'#777')+'"></i><div><div class="v3stage" style="color:'+esc(g.stage_color||'#aaa')+'">'+esc(g.stage_label_ru||'НХЛ')+' · '+esc(no)+'</div><div class="v3full">'+esc(g.opponent_name||g.opponent_tri||'')+'</div><small>'+esc(new Date(g.scheduled_start_utc).toLocaleString('ru-RU',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}))+' · '+(g.is_home?'дома':'в гостях')+'</small></div><b>'+(g.game_state==='FINAL'||g.game_state==='OFF'?esc(g.away_score+' : '+g.home_score):'›')+'</b></div>'}
async function enhanceTeam(tri){const panel=document.querySelector('#v2sheet .v2panel');if(!panel)return;const seasons=await api(API+'/seasons'),sel=document.createElement('select');sel.className='v3season';sel.innerHTML=seasons.seasons.map((s,i)=>'<option value="'+s.season_id+'" '+(i===0?'selected':'')+'>'+esc(s.label)+'</option>').join('');panel.querySelector('.v2head')?.insertAdjacentElement('afterend',sel);async function load(){const d=await api(API+'/teams/'+tri+'?season='+sel.value),s=d.standings||{};const old=panel.querySelector('[data-v3-team-extra]');if(old)old.remove();const box=document.createElement('div');box.dataset.v3TeamExtra='1';box.innerHTML='<div class="v2h">Сезон '+esc(d.season_label)+'</div><div class="v2stats"><div class="v2stat"><small>Место в конференции</small><b>#'+esc(s.conference_sequence||'—')+'</b></div><div class="v2stat"><small>Голы · место НХЛ</small><b>'+esc(s.goals_for??'—')+' · #'+esc(d.league_ranks?.gf_rank||'—')+'</b></div><div class="v2stat"><small>Пропущено · место НХЛ</small><b>'+esc(s.goals_against??'—')+' · #'+esc(d.league_ranks?.ga_rank||'—')+'</b></div></div><div class="v2h">Плей-офф</div><div class="v2next"><strong style="color:'+esc(d.playoff?.color||'#aaa')+'">'+esc(d.playoff?.stage||'—')+'</strong></div><div class="v2h">Матчи сезона</div>'+d.schedule.slice().reverse().map(gameRow).join('');panel.appendChild(box)}sel.onchange=load;await load()}
async function enhancePlayer(id){const panel=document.querySelector('#v2sheet .v2panel');if(!panel)return;const seasons=await api(API+'/seasons'),sel=document.createElement('select');sel.className='v3season';sel.innerHTML=seasons.seasons.map((s,i)=>'<option value="'+s.season_id+'" '+(i===0?'selected':'')+'>'+esc(s.label)+'</option>').join('');panel.querySelector('.v2head')?.insertAdjacentElement('afterend',sel);async function load(){const d=await api(API+'/players/'+id+'?season='+sel.value),p=d.player,r=d.regular_season||{},rank=d.ranks||{};panel.querySelector('[data-v3-player-extra]')?.remove();const box=document.createElement('div');box.dataset.v3PlayerExtra='1';const league=rank.league,team=rank.team;box.innerHTML='<div class="v2h">Профиль</div><div class="v2next"><div class="v3flags">'+esc((p.flags||[]).join(' '))+'</div><div class="v2muted">'+esc((p.countries||[]).join(' · ')||p.birth_country||'Страна не указана')+'</div><button class="v3audio '+(p.pronunciation_url?'':'off')+'" '+(p.pronunciation_url?'data-v3-audio="'+esc(p.pronunciation_url)+'"':'disabled')+'>🔊 Произношение</button></div><div class="v2h">Статистика '+esc(d.season_label)+'</div><div class="v2stats"><div class="v2stat"><small>Матчи</small><b>'+esc(r.games_played??'—')+'</b></div><div class="v2stat"><small>Голы</small><b>'+esc(r.goals??'—')+'</b></div><div class="v2stat"><small>Передачи</small><b>'+esc(r.assists??'—')+'</b></div><div class="v2stat"><small>Очки</small><b>'+esc(r.points??'—')+'</b></div><div class="v2stat"><small>Место в команде</small><b class="v3rank '+(team?.rank===1?'gold':'')+'">'+(team?'#'+team.rank:'—')+'</b></div><div class="v2stat"><small>Место в НХЛ</small><b class="v3rank '+(league?.rank===1?'gold':'')+'">'+(league?'#'+league.rank:'—')+'</b></div></div>'+(d.next_game?'<div class="v2h">Ближайший матч</div>'+gameRow(d.next_game):'');panel.appendChild(box)}sel.onchange=load;await load()}
async function openGame(id){document.getElementById('v3gameSheet')?.remove();const wrap=document.createElement('div');wrap.id='v3gameSheet';wrap.className='v3gameSheet';wrap.innerHTML='<div class="v3gameCard"><button class="v2close" data-v3-close>×</button><div class="v2empty">Загружаю матч…</div></div>';document.body.appendChild(wrap);try{const d=await api(API+'/games/'+id),g=d.game;wrap.querySelector('.v3gameCard').innerHTML='<div class="v2head"><div class="v2title"><h2>'+esc(g.stage_label_ru)+'</h2><div class="v2muted">'+esc(new Date(g.scheduled_start_utc).toLocaleString('ru-RU'))+' · Game ID '+g.game_pk+'</div></div><button class="v2close" data-v3-close>×</button></div><div class="v3teams"><div><img src="'+esc(g.away_logo)+'"><b>'+esc(g.away_name)+'</b></div><div class="v3score">'+esc((g.away_score??'—')+' : '+(g.home_score??'—'))+'</div><div><img src="'+esc(g.home_logo)+'"><b>'+esc(g.home_name)+'</b></div></div><div class="v2h">Линия Winline</div>'+(d.markets?.length?'<div class="v2markets">'+d.markets.slice(0,20).map(m=>'<div class="v2market"><span>'+esc(m.outcome_name||m.market_type)+'</span><b>'+esc(m.odds??'—')+'</b></div>').join('')+'</div>':'<div class="v2empty">Линия пока не загружена</div>')+'<div class="v2h">Статистика команд</div><div class="v2note">Матч автоматически обновляется из Data Core после синхронизации.</div>'}catch(e){wrap.querySelector('.v3gameCard').innerHTML='<button class="v2close" data-v3-close>×</button><div class="v2empty">'+esc(e.message)+'</div>'}}
const enhanced=new WeakSet();const obs=new MutationObserver(()=>{const sheet=document.getElementById('v2sheet'),panel=sheet?.querySelector('.v2panel');if(!panel||enhanced.has(panel))return;const team=sheet.querySelector('[data-v2-subtype="team"]')?.dataset.v2Key,player=sheet.querySelector('[data-v2-subtype="player"]')?.dataset.v2Key;if(team||player){enhanced.add(panel);panel.insertAdjacentHTML('afterbegin','<div class="v3scrollhint">Профиль прокручивается ↓</div>');setTimeout(()=>team?enhanceTeam(team):enhancePlayer(Number(player)),20)}});obs.observe(document.body,{childList:true,subtree:true});
document.addEventListener('click',e=>{const g=e.target.closest('[data-v3-game]');if(g){e.stopPropagation();openGame(Number(g.dataset.v3Game))}const c=e.target.closest('[data-v3-close]');if(c)document.getElementById('v3gameSheet')?.remove();const a=e.target.closest('[data-v3-audio]');if(a){e.stopPropagation();try{new Audio(a.dataset.v3Audio).play()}catch(_){}}});
css();
})();`;
