const JS_PATH = "/telegram-app/v13.js";
const API = "/api/telegram-center-v13";
const V3_API = "/api/telegram-center-v3";
const NHL = "https://api-web.nhle.com/v1";
const FINAL_STATES = new Set(["FINAL", "OFF"]);

export async function handleTelegramCenterV13Teams(request, env, path) {
  if (path === JS_PATH) {
    if (request.method !== "GET") return json({ok:false,error:"method_not_allowed"},405);
    return new Response(V13_JS,{headers:{"Content-Type":"application/javascript; charset=utf-8","Cache-Control":"no-store, no-cache, must-revalidate","X-Content-Type-Options":"nosniff"}});
  }

  if (!env?.DB) {
    if (path.startsWith(API)) return json({ok:false,error:"missing_d1_binding"},503);
    return null;
  }

  const compat = new RegExp(`^${V3_API}/teams/([A-Za-z]{3})$`).exec(path);
  if (compat && request.method === "GET") {
    const season = normalizeSeason(new URL(request.url).searchParams.get("season")) || currentSeasonId();
    return teamSeasonResponse(env, compat[1].toUpperCase(), season, {compat:true});
  }

  const seasons = new RegExp(`^${API}/teams/([A-Za-z]{3})/seasons$`).exec(path);
  if (seasons && request.method === "GET") return teamSeasons(env, seasons[1].toUpperCase());

  const detail = new RegExp(`^${API}/teams/([A-Za-z]{3})/season/(20\\d{6})$`).exec(path);
  if (detail && request.method === "GET") return teamSeasonResponse(env, detail[1].toUpperCase(), detail[2], {compat:false});

  const table = new RegExp(`^${API}/teams/([A-Za-z]{3})/season/(20\\d{6})/table$`).exec(path);
  if (table && request.method === "GET") return leagueTableResponse(env, table[1].toUpperCase(), table[2]);

  return null;
}

async function teamSeasons(env, tri) {
  const team = await env.DB.prepare(`SELECT tri_code,name_en,name_ru FROM teams WHERE tri_code=? LIMIT 1;`).bind(tri).first().catch(()=>null);
  if (!team) return json({ok:false,error:"team_not_found"},404);
  const ids = lastSeasonIds(5);
  const marks = ids.map(()=>'?').join(',');
  const games = await env.DB.prepare(`
    SELECT CAST(season_id AS TEXT) season_id,COUNT(*) games,
           SUM(CASE WHEN game_type=2 AND UPPER(COALESCE(game_state,'')) IN ('FINAL','OFF') THEN 1 ELSE 0 END) regular_final
    FROM games
    WHERE CAST(season_id AS TEXT) IN (${marks}) AND (home_tri=? OR away_tri=?)
    GROUP BY CAST(season_id AS TEXT);
  `).bind(...ids,tri,tri).all().catch(()=>({results:[]}));
  const adv = await env.DB.prepare(`
    SELECT CAST(season_id AS TEXT) season_id,COUNT(DISTINCT game_pk) advanced_games
    FROM team_game_advanced_features
    WHERE team_tri=? AND CAST(season_id AS TEXT) IN (${marks})
    GROUP BY CAST(season_id AS TEXT);
  `).bind(tri,...ids).all().catch(()=>({results:[]}));
  const gm = Object.fromEntries((games.results||[]).map(x=>[String(x.season_id),x]));
  const am = Object.fromEntries((adv.results||[]).map(x=>[String(x.season_id),x]));
  return json({ok:true,team,season_count:ids.length,seasons:ids.map(id=>({
    season_id:id,label:seasonLabel(id),current:id===currentSeasonId(),
    d1_games:num(gm[id]?.games),regular_final_games:num(gm[id]?.regular_final),advanced_games:num(am[id]?.advanced_games),
    basic_available:true,detailed_available:num(gm[id]?.games)>0,advanced_available:num(am[id]?.advanced_games)>0,
  }))});
}

async function teamSeasonResponse(env, tri, season, {compat=false}={}) {
  if (!normalizeSeason(season)) return json({ok:false,error:"invalid_season"},400);
  const team = await env.DB.prepare(`SELECT tri_code,name_en,name_ru,logo_url FROM teams WHERE tri_code=? LIMIT 1;`).bind(tri).first().catch(()=>null);
  if (!team) return json({ok:false,error:"team_not_found"},404);

  try {
    let schedule = await dbSchedule(env.DB, tri, season);
    let scheduleSource = "d1";
    if (!schedule.length) {
      schedule = await nhlSchedule(tri, season).catch(()=>[]);
      scheduleSource = schedule.length ? "nhl_web_api" : "unavailable";
    }

    const regularFinal = schedule.filter(g=>Number(g.game_type)===2 && isFinal(g.game_state));
    const standings = computeRecord(regularFinal, tri);
    const nextGame = schedule.find(g=>!isFinal(g.game_state) && Date.parse(g.scheduled_start_utc||0)>=Date.now()-3600000) || null;
    const recent = [...schedule].filter(g=>isFinal(g.game_state)).sort((a,b)=>Date.parse(b.scheduled_start_utc||0)-Date.parse(a.scheduled_start_utc||0)).slice(0,12);

    const [standard, advanced, roster] = await Promise.all([
      detailedStandardStats(env.DB, tri, season).catch(()=>emptyStandard()),
      advancedStats(env.DB, tri, season).catch(()=>emptyAdvanced()),
      teamRoster(env.DB, tri, season).catch(()=>[]),
    ]);
    let rosterRows = roster;
    let rosterSource = rosterRows.length ? "d1" : "unavailable";
    if (!rosterRows.length) {
      rosterRows = await nhlRoster(tri, season).catch(()=>[]);
      rosterSource = rosterRows.length ? "nhl_web_api" : "unavailable";
    }

    const payload = {
      ok:true,season,season_label:seasonLabel(season),
      team:{...team,logo:team.logo_url||teamLogo(tri)},
      standings:{...standings,season_id:season},
      league_ranks:null,
      standard_stats:standard,
      advanced_stats:advanced,
      roster:rosterRows,
      schedule,
      recent,
      next_game:nextGame,
      coverage:{
        schedule_source:scheduleSource,roster_source:rosterSource,
        d1_games:scheduleSource==="d1"?schedule.length:0,
        standard_games:num(standard.games),advanced_games:num(advanced.games),
        standard_complete:Boolean(standard.games),advanced_complete:Boolean(advanced.games),
      },
      updated_at:new Date().toISOString(),
    };
    if (compat) {
      return json({
        ok:true,season,season_label:payload.season_label,team:payload.team,standings:payload.standings,
        league_ranks:payload.league_ranks,playoff:null,next_game:payload.next_game,recent:payload.recent,schedule:payload.schedule,
        updated_at:payload.updated_at,source:"center_v13_compat",
      });
    }
    return json(payload);
  } catch (error) {
    return json({ok:false,error:"team_season_v13_failed",detail:errorText(error)},503);
  }
}

async function dbSchedule(db, tri, season) {
  const r = await db.prepare(`
    SELECT game_pk,CAST(season_id AS TEXT) season_id,game_type,scheduled_start_utc,game_state,
           home_tri,away_tri,home_score,away_score,period_type
    FROM games
    WHERE CAST(season_id AS TEXT)=? AND (home_tri=? OR away_tri=?)
    ORDER BY scheduled_start_utc ASC,game_pk ASC;
  `).bind(season,tri,tri).all();
  return (r.results||[]).map(g=>annotateGame(g,tri));
}

async function nhlSchedule(tri, season) {
  const d = await fetchNhl(`${NHL}/club-schedule-season/${tri}/${season}`);
  const rows = Array.isArray(d?.games)?d.games:[];
  return rows.map(g=>{
    const home = localized(g?.homeTeam?.abbrev)||g?.homeTeam?.abbrev||"";
    const away = localized(g?.awayTeam?.abbrev)||g?.awayTeam?.abbrev||"";
    const row = {
      game_pk:num(g?.id),season_id:season,game_type:num(g?.gameType),scheduled_start_utc:g?.startTimeUTC||g?.gameDate||null,
      game_state:String(g?.gameState||""),home_tri:upper(home),away_tri:upper(away),
      home_score:g?.homeTeam?.score??null,away_score:g?.awayTeam?.score??null,period_type:g?.periodDescriptor?.periodType||null,
    };
    return annotateGame(row,tri);
  });
}

function annotateGame(g,tri) {
  const home = upper(g.home_tri), away=upper(g.away_tri), isHome=home===tri;
  const opponent = isHome?away:home;
  return {...g,opponent_tri:opponent,is_home:isHome?1:0,opponent_name:opponent,stage_label_ru:Number(g.game_type)===3?"Плей-офф":Number(g.game_type)===1?"Предсезонка":"Регулярка"};
}

function computeRecord(games, tri) {
  let wins=0,losses=0,ot_losses=0,gf=0,ga=0;
  for (const g of games) {
    const isHome=upper(g.home_tri)===tri;
    const a=num(isHome?g.home_score:g.away_score), b=num(isHome?g.away_score:g.home_score);
    gf+=a;ga+=b;
    if(a>b) wins++;
    else {
      const p=upper(g.period_type);
      if(p==="OT"||p==="SO") ot_losses++; else losses++;
    }
  }
  return {games_played:games.length,wins,losses,ot_losses,points:wins*2+ot_losses,goals_for:gf,goals_against:ga,goal_diff:gf-ga};
}

async function detailedStandardStats(db, tri, season) {
  const row = await db.prepare(`
    SELECT COUNT(*) games,
      SUM(COALESCE(s.goals,0)) goals_for,SUM(COALESCE(o.goals,0)) goals_against,
      SUM(COALESCE(s.shots,0)) shots_for,SUM(COALESCE(o.shots,0)) shots_against,
      SUM(COALESCE(s.shot_attempts,0)) shot_attempts_for,SUM(COALESCE(o.shot_attempts,0)) shot_attempts_against,
      SUM(COALESCE(s.blocked_shots,0)) blocked_shots,SUM(COALESCE(s.hits,0)) hits,
      SUM(COALESCE(s.pim,0)) pim,SUM(COALESCE(s.giveaways,0)) giveaways,SUM(COALESCE(s.takeaways,0)) takeaways,
      AVG(s.faceoff_pct) faceoff_pct,
      SUM(COALESCE(s.power_play_goals,0)) power_play_goals,SUM(COALESCE(s.power_play_opportunities,0)) power_play_opportunities,
      SUM(COALESCE(s.shorthanded_goals,0)) shorthanded_goals
    FROM games g
    JOIN team_game_stats s ON s.game_pk=g.game_pk AND s.team_tri=?
    LEFT JOIN team_game_stats o ON o.game_pk=g.game_pk AND o.team_tri<>?
    WHERE CAST(g.season_id AS TEXT)=? AND g.game_type=2 AND UPPER(COALESCE(g.game_state,'')) IN ('FINAL','OFF');
  `).bind(tri,tri,season).first();
  if (!row || !num(row.games)) return emptyStandard();
  const ppo=num(row.power_play_opportunities), ppg=num(row.power_play_goals);
  return {...row,games:num(row.games),power_play_pct:ppo?round(ppg*100/ppo,1):null,
    shots_for_pg:row.games?round(num(row.shots_for)/num(row.games),2):null,
    shots_against_pg:row.games?round(num(row.shots_against)/num(row.games),2):null};
}

async function advancedStats(db, tri, season) {
  const row = await db.prepare(`
    SELECT COUNT(*) games,SUM(COALESCE(toi_5v5_minutes,0)) toi_5v5_minutes,
      SUM(COALESCE(goals_for_5v5,0)) goals_for_5v5,SUM(COALESCE(goals_against_5v5,0)) goals_against_5v5,
      SUM(COALESCE(xgf_5v5,0)) xgf_5v5,SUM(COALESCE(xga_5v5,0)) xga_5v5,
      SUM(COALESCE(shots_for_5v5,0)) shots_for_5v5,SUM(COALESCE(shots_against_5v5,0)) shots_against_5v5,
      SUM(COALESCE(corsi_for_5v5,0)) corsi_for_5v5,SUM(COALESCE(corsi_against_5v5,0)) corsi_against_5v5,
      SUM(COALESCE(fenwick_for_5v5,0)) fenwick_for_5v5,SUM(COALESCE(fenwick_against_5v5,0)) fenwick_against_5v5,
      AVG(shooting_pct_5v5) shooting_pct_5v5,AVG(save_pct_5v5) save_pct_5v5,AVG(pdo_5v5) pdo_5v5,
      SUM(COALESCE(goals_minus_expected,0)) goals_minus_expected,SUM(COALESCE(goals_saved_above_expected,0)) goals_saved_above_expected
    FROM team_game_advanced_features
    WHERE team_tri=? AND CAST(season_id AS TEXT)=?;
  `).bind(tri,season).first();
  if (!row || !num(row.games)) return emptyAdvanced();
  const pct=(a,b)=>a+b?round(a*100/(a+b),1):null;
  const gf=num(row.goals_for_5v5),ga=num(row.goals_against_5v5),xgf=num(row.xgf_5v5),xga=num(row.xga_5v5),sf=num(row.shots_for_5v5),sa=num(row.shots_against_5v5),cf=num(row.corsi_for_5v5),ca=num(row.corsi_against_5v5),ff=num(row.fenwick_for_5v5),fa=num(row.fenwick_against_5v5),toi=num(row.toi_5v5_minutes);
  return {...row,games:num(row.games),gf_pct_5v5:pct(gf,ga),xgf_pct_5v5:pct(xgf,xga),sf_pct_5v5:pct(sf,sa),corsi_for_pct_5v5:pct(cf,ca),fenwick_for_pct_5v5:pct(ff,fa),
    xgf60:toi?round(xgf*60/toi,2):null,xga60:toi?round(xga*60/toi,2):null};
}

async function teamRoster(db, tri, season) {
  const r = await db.prepare(`
    SELECT p.player_id,p.full_name_en,p.full_name_ru,p.position_code,p.sweater_number,
      COUNT(*) games,SUM(COALESCE(s.goals,0)) goals,SUM(COALESCE(s.assists,0)) assists,SUM(COALESCE(s.points,0)) points,SUM(COALESCE(s.shots,0)) shots
    FROM player_game_stats s
    JOIN games g ON g.game_pk=s.game_pk
    JOIN players p ON p.player_id=s.player_id
    WHERE s.team_tri=? AND CAST(g.season_id AS TEXT)=? AND g.game_type=2
    GROUP BY p.player_id,p.full_name_en,p.full_name_ru,p.position_code,p.sweater_number
    ORDER BY points DESC,goals DESC,assists DESC,p.full_name_en ASC;
  `).bind(tri,season).all();
  let rows=r.results||[];
  if(rows.length) return rows;
  if(season===currentSeasonId()){
    const cur=await db.prepare(`SELECT player_id,full_name_en,full_name_ru,position_code,sweater_number,0 games,0 goals,0 assists,0 points,0 shots FROM players WHERE active=1 AND current_team_tri=? ORDER BY position_code,full_name_en;`).bind(tri).all();
    rows=cur.results||[];
  }
  return rows;
}

async function nhlRoster(tri, season) {
  const d=await fetchNhl(`${NHL}/club-stats/${tri}/${season}/2`);
  const sk=Array.isArray(d?.skaters)?d.skaters:[];
  const go=Array.isArray(d?.goalies)?d.goalies:[];
  return [...sk.map(p=>({player_id:num(p.playerId),full_name_en:localized(p.firstName)+' '+localized(p.lastName),full_name_ru:null,position_code:p.positionCode||"",sweater_number:null,games:num(p.gamesPlayed),goals:num(p.goals),assists:num(p.assists),points:num(p.points),shots:num(p.shots)})),
    ...go.map(p=>({player_id:num(p.playerId),full_name_en:localized(p.firstName)+' '+localized(p.lastName),full_name_ru:null,position_code:"G",sweater_number:null,games:num(p.gamesPlayed),goals:0,assists:0,points:0,shots:0,save_pct:p.savePctg??null,gaa:p.goalsAgainstAverage??null}))];
}

async function leagueTableResponse(env, tri, season) {
  try {
    const r=await env.DB.prepare(`
      SELECT game_pk,scheduled_start_utc,game_state,game_type,home_tri,away_tri,home_score,away_score,period_type
      FROM games WHERE CAST(season_id AS TEXT)=? AND game_type=2 AND UPPER(COALESCE(game_state,'')) IN ('FINAL','OFF')
      ORDER BY scheduled_start_utc;
    `).bind(season).all();
    const games=r.results||[];
    if(games.length){
      const teamsR=await env.DB.prepare(`SELECT tri_code,name_en,name_ru,logo_url FROM teams WHERE COALESCE(active,1)=1 ORDER BY tri_code;`).all();
      return json({ok:true,season,source:"d1",table:computeTable(games,teamsR.results||[]),selected_team:tri});
    }
    const schedule=await nhlSchedule(tri,season).catch(()=>[]);
    const last=[...schedule].filter(g=>Number(g.game_type)===2&&isFinal(g.game_state)).pop();
    const endpoint=season===currentSeasonId()?`${NHL}/standings/now`:last?`${NHL}/standings/${String(last.scheduled_start_utc||'').slice(0,10)}`:null;
    if(!endpoint)return json({ok:true,season,source:"unavailable",table:[],selected_team:tri});
    const d=await fetchNhl(endpoint);
    const table=(d?.standings||[]).map(x=>({team_tri:upper(localized(x.teamAbbrev)),name:localized(x.teamName)||upper(localized(x.teamAbbrev)),games_played:num(x.gamesPlayed),wins:num(x.wins),losses:num(x.losses),ot_losses:num(x.otLosses),points:num(x.points),goals_for:num(x.goalFor),goals_against:num(x.goalAgainst),goal_diff:num(x.goalDifferential),league_sequence:num(x.leagueSequence),division_sequence:num(x.divisionSequence),conference_sequence:num(x.conferenceSequence),logo:x.teamLogo||teamLogo(upper(localized(x.teamAbbrev)))}));
    table.sort((a,b)=>(a.league_sequence||999)-(b.league_sequence||999));
    return json({ok:true,season,source:"nhl_web_api",table,selected_team:tri});
  }catch(error){return json({ok:false,error:"team_table_failed",detail:errorText(error)},503)}
}

function computeTable(games, teams) {
  const map=new Map((teams||[]).map(t=>[upper(t.tri_code),{team_tri:upper(t.tri_code),name:t.name_ru||t.name_en||t.tri_code,logo:t.logo_url||teamLogo(t.tri_code),games_played:0,wins:0,losses:0,ot_losses:0,points:0,goals_for:0,goals_against:0,goal_diff:0}]));
  for(const g of games){
    const h=map.get(upper(g.home_tri)),a=map.get(upper(g.away_tri));if(!h||!a)continue;
    const hs=num(g.home_score),as=num(g.away_score);h.games_played++;a.games_played++;h.goals_for+=hs;h.goals_against+=as;a.goals_for+=as;a.goals_against+=hs;
    if(hs>as){h.wins++;h.points+=2;if(["OT","SO"].includes(upper(g.period_type))){a.ot_losses++;a.points+=1}else a.losses++;}
    else {a.wins++;a.points+=2;if(["OT","SO"].includes(upper(g.period_type))){h.ot_losses++;h.points+=1}else h.losses++;}
  }
  const out=[...map.values()].filter(x=>x.games_played>0);for(const x of out)x.goal_diff=x.goals_for-x.goals_against;
  out.sort((a,b)=>b.points-a.points||b.wins-a.wins||b.goal_diff-a.goal_diff||b.goals_for-a.goals_for||a.team_tri.localeCompare(b.team_tri));
  out.forEach((x,i)=>x.league_sequence=i+1);return out;
}

function emptyStandard(){return{games:0,goals_for:null,goals_against:null,shots_for:null,shots_against:null,shot_attempts_for:null,shot_attempts_against:null,blocked_shots:null,hits:null,pim:null,giveaways:null,takeaways:null,faceoff_pct:null,power_play_goals:null,power_play_opportunities:null,power_play_pct:null,shorthanded_goals:null,shots_for_pg:null,shots_against_pg:null}}
function emptyAdvanced(){return{games:0,toi_5v5_minutes:null,gf_pct_5v5:null,xgf_pct_5v5:null,sf_pct_5v5:null,corsi_for_pct_5v5:null,fenwick_for_pct_5v5:null,xgf60:null,xga60:null,shooting_pct_5v5:null,save_pct_5v5:null,pdo_5v5:null,goals_minus_expected:null,goals_saved_above_expected:null}}
function lastSeasonIds(count){const cur=currentSeasonId(),start=Number(cur.slice(0,4));return Array.from({length:count},(_,i)=>`${start-i}${start-i+1}`)}
function currentSeasonId(){const d=new Date(),y=d.getUTCFullYear(),m=d.getUTCMonth()+1,s=m>=7?y:y-1;return`${s}${s+1}`}
function normalizeSeason(v){v=String(v||"").replace(/\D/g,"");return /^20\d{6}$/.test(v)?v:""}
function seasonLabel(s){s=String(s||"");return s.length===8?`${s.slice(0,4)}/${s.slice(6,8)}`:s}
function isFinal(v){return FINAL_STATES.has(upper(v))}
function localized(v){return v&&typeof v==="object"?(v.default||v.en||v.ru||""):String(v||"")}
function upper(v){return String(v||"").trim().toUpperCase()}
function num(v){const n=Number(v);return Number.isFinite(n)?n:0}
function round(v,d=1){const p=10**d;return Math.round(v*p)/p}
function errorText(e){return String(e?.message||e||"unknown_error")}
function teamLogo(tri){return `https://assets.nhle.com/logos/nhl/svg/${upper(tri)}_light.svg`}
async function fetchNhl(url){const c=new AbortController(),t=setTimeout(()=>c.abort(),6500);try{const r=await fetch(url,{signal:c.signal,headers:{Accept:"application/json","User-Agent":"HOH-NHL-Center/13"}});if(!r.ok)throw new Error(`NHL HTTP ${r.status}`);return await r.json()}finally{clearTimeout(t)}}
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}})}

const V13_JS=String.raw`(function(){
'use strict';
const API='/api/telegram-center-v13',MEDIA='/api/telegram-center-v12/media';
const esc=function(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})};
const n=function(v){var x=Number(v);return Number.isFinite(x)?x:null};
const fmt=function(v,d){var x=n(v);return x==null?'—':x.toFixed(d==null?1:d).replace(/\\.0$/,'')};
async function api(u){var r=await fetch(u,{cache:'no-store'}),d=await r.json().catch(function(){return{}});if(!r.ok)throw new Error(d.detail||d.error||('HTTP '+r.status));return d}
function css(){if(document.getElementById('centerV13Css'))return;var s=document.createElement('style');s.id='centerV13Css';s.textContent='.v8{border-color:#7a542b!important;color:#ffb46c!important}.v13Refresh{position:fixed;right:12px;bottom:82px;z-index:90;width:40px;height:40px;border-radius:50%;border:1px solid #5e3b23;background:#1b120d;color:#ff8a3d;font-size:21px;font-weight:900;box-shadow:0 8px 24px #0009}.v13Refresh.spin{animation:v13spin .6s linear infinite}@keyframes v13spin{to{transform:rotate(360deg)}}.mediaShelf.v12Media{display:grid!important;grid-template-columns:minmax(0,.58fr) minmax(0,.58fr) minmax(0,1.9fr)!important;gap:7px!important;align-items:start}.v12MediaHead{grid-column:1/-1!important}.v13MediaCard{display:block;text-decoration:none;color:#fff;min-width:0}.v13MediaPic{position:relative;overflow:hidden;border-radius:12px;border:1px solid #2b2e39;background:#11131a}.v13MediaCard.short .v13MediaPic{aspect-ratio:9/16}.v13MediaCard.news .v13MediaPic{aspect-ratio:16/9}.v13MediaPic img{width:100%;height:100%;display:block;object-fit:cover}.v13Play{position:absolute;inset:50% auto auto 50%;transform:translate(-50%,-50%);width:28px;height:28px;border-radius:50%;display:grid;place-items:center;background:#050507c9;font-size:11px}.v13Ribbon{position:absolute;top:6px;right:0;background:#ff5a00;color:#fff;padding:4px 6px;font:950 7px/1 Arial;letter-spacing:.3px;border-radius:6px 0 0 6px}.v13MediaTitle{font-size:8px;font-weight:850;line-height:1.2;margin:5px 2px 0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;color:#d8dae4}.profileHead:not(.player)~.season{height:38px!important}.profileHead:not(.player)~.profileTabs{scrollbar-width:none}.profileHead:not(.player)~.profileTabs::-webkit-scrollbar{display:none}.v13TeamBody{display:grid;gap:9px}.v13Metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}.v13Metric{min-height:72px;padding:9px;border:1px solid #2a2d38;border-radius:13px;background:linear-gradient(180deg,#13151d,#0f1117);overflow:hidden}.v13Metric.orange{border-color:#5f331f}.v13Metric.lav{border-color:#4e3a69}.v13Metric .k{font-size:8px;color:#9ea2b0;text-transform:uppercase;letter-spacing:.3px}.v13Metric .v{font:950 19px/1.1 Arial;margin-top:5px;white-space:nowrap}.v13Metric .s{font-size:8px;color:#777d91;margin-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.v13Coverage{font-size:9px;color:#8f93a7;border:1px solid #262936;border-radius:11px;padding:8px 9px}.v13Coverage strong{color:#d7d9e2}.v13List{display:grid;gap:6px}.v13Roster{display:grid;grid-template-columns:30px minmax(0,1fr) 76px;gap:8px;align-items:center;padding:8px 9px;border:1px solid #252833;border-radius:11px;background:#101219}.v13Roster .num{font-size:10px;color:#9da1b0;text-align:center}.v13Roster b{font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.v13Roster small{display:block;font-size:8px;color:#777d91;margin-top:2px}.v13Roster .stat{text-align:right;font-size:9px;color:#cbb4ef}.v13Game{display:grid;grid-template-columns:67px minmax(0,1fr) auto;gap:8px;align-items:center;padding:8px 9px;border:1px solid #252833;border-radius:11px;background:#101219}.v13Game .date{font-size:8px;color:#8f93a7}.v13Game b{font-size:11px}.v13Game .score{font-size:11px;font-weight:950}.v13Table{display:grid;gap:3px}.v13TableRow{display:grid;grid-template-columns:24px 34px minmax(0,1fr) 30px 36px;gap:5px;align-items:center;padding:6px 7px;border-radius:9px;font-size:9px}.v13TableRow.sel{background:#2a2133;border:1px solid #694c82}.v13TableRow img{width:24px;height:24px;object-fit:contain}.v13TableRow b{font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.v13Empty{padding:24px 12px;text-align:center;border:1px dashed #353846;border-radius:13px;color:#9296a8;font-size:10px}.v13SectionTitle{font-size:9px;color:#cbb4ef;text-transform:uppercase;letter-spacing:.6px;font-weight:950;margin:4px 1px 0}@media(max-width:390px){.mediaShelf.v12Media{grid-template-columns:minmax(0,.55fr) minmax(0,.55fr) minmax(0,1.75fr)!important}.v13MediaCard.news .v13MediaPic{aspect-ratio:5/4}.v13MediaTitle{font-size:7px}.v13Metric{min-height:68px;padding:8px}.v13Metric .v{font-size:18px}}';document.head.appendChild(s)}
function shortTitle(v){var s=String(v||'HOME OF HOCKEY').replace(/#\\w+/g,'').replace(/HOME OF HOCKEY NEWS/ig,'').replace(/\\s*[|–—-]\\s*$/,'').trim();return s.length>54?s.slice(0,51)+'…':s}
function currentTab(){return document.querySelector('.tab.active')&&document.querySelector('.tab.active').dataset.tab||''}
function mediaCard(x){var news=x.kind==='news';return '<a class="v13MediaCard '+(news?'news':'short')+'" href="'+esc(x.url)+'" target="_blank" rel="noopener"><div class="v13MediaPic"><img src="'+esc(x.thumb||'')+'" alt=""><span class="v13Play">▶</span>'+(news?'<span class="v13Ribbon">СВЕЖИЙ NEWS</span>':'')+'</div><div class="v13MediaTitle">'+esc(shortTitle(x.title))+'</div></a>'}
async function renderMedia(force){if(currentTab()!=='games'||document.querySelector('.profileHead'))return;var view=document.getElementById('view');if(!view)return;if(!force&&view.querySelector('.v13MediaCard'))return;try{var d=await api(MEDIA+'?v13='+Date.now()),items=Array.isArray(d.items)?d.items:[];var shorts=items.filter(function(x){return x.kind==='short'}).slice(0,2),news=items.find(function(x){return x.kind==='news'});if(shorts.length<2||!news)return;view.querySelectorAll('.mediaShelf').forEach(function(x){x.remove()});var shelf=document.createElement('section');shelf.className='mediaShelf v12Media';shelf.innerHTML='<div class="v12MediaHead"><b>HOME OF HOCKEY</b><span>YouTube</span></div>'+shorts.map(mediaCard).join('')+mediaCard(news);var toolbar=view.querySelector('.toolbar');if(toolbar)view.insertBefore(shelf,toolbar);else view.prepend(shelf)}catch(e){}}
function refreshButton(){if(document.getElementById('v13Refresh'))return;var b=document.createElement('button');b.id='v13Refresh';b.className='v13Refresh';b.type='button';b.setAttribute('aria-label','Обновить экран');b.textContent='↻';b.onclick=async function(){if(b.classList.contains('spin'))return;b.classList.add('spin');try{var active=document.querySelector('.tab.active');if(active&&document.getElementById('tabs')&&getComputedStyle(document.getElementById('tabs')).display!=='none')active.click();await new Promise(function(r){setTimeout(r,100)});await renderMedia(true);syncTeam(true)}finally{setTimeout(function(){b.classList.remove('spin')},250)}};document.body.appendChild(b)}
function teamTri(){var head=document.querySelector('#view .profileHead:not(.player)'),meta=head&&head.querySelector('.meta');var m=String(meta&&meta.textContent||'').match(/\\b([A-Z]{3})\\b/);return m?m[1]:''}
function teamBody(){return document.querySelector('#view .profileBody')}
function seasonSel(){return document.querySelector('#view select.season')}
function tabs(){return Array.from(document.querySelectorAll('#view .profileTabs button'))}
function metric(k,v,s,kind){return '<div class="v13Metric '+(kind||'')+'"><div class="k">'+esc(k)+'</div><div class="v">'+esc(v==null?'—':v)+'</div>'+(s?'<div class="s">'+esc(s)+'</div>':'')+'</div>'}
function dateText(v){if(!v)return'—';var d=new Date(v);if(!Number.isFinite(d.getTime()))return String(v).slice(0,10);return d.toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit',year:'2-digit'})}
function scoreText(g,tri){if(!g)return'';if(String(g.game_state).toUpperCase()==='FINAL'||String(g.game_state).toUpperCase()==='OFF'){var h=String(g.home_tri).toUpperCase()===tri;return (h?g.home_score:g.away_score)+' : '+(h?g.away_score:g.home_score)}return '—'}
function overview(d,tri){var s=d.standings||{},c=d.coverage||{};return '<div class="v13TeamBody"><div class="v13Metrics">'+metric('В–П–ОТ',(s.wins||0)+'–'+(s.losses||0)+'–'+(s.ot_losses||0),(s.games_played||0)+' матчей','lav')+metric('Очки',s.points||0,'за сезон','orange')+metric('Забито',s.goals_for==null?'—':s.goals_for,'разница '+(s.goal_diff>0?'+':'')+(s.goal_diff||0),'orange')+metric('Пропущено',s.goals_against==null?'—':s.goals_against,'регулярка','lav')+'</div>'+coverage(c)+(d.next_game?'<div><div class="v13SectionTitle">Ближайший матч</div><div class="v13Game"><div class="date">'+esc(dateText(d.next_game.scheduled_start_utc))+'</div><b>'+esc(d.next_game.opponent_tri||'Соперник')+'</b><div class="score">'+esc(d.next_game.game_state||'')+'</div></div></div>':'')+'<div><div class="v13SectionTitle">Последние матчи</div><div class="v13List">'+((d.recent||[]).slice(0,5).map(function(g){return gameRow(g,tri)}).join('')||'<div class="v13Empty">Матчей пока нет</div>')+'</div></div></div>'}
function coverage(c){var a=[];a.push('расписание: '+(c.schedule_source==='d1'?'D1':c.schedule_source==='nhl_web_api'?'NHL API':'нет'));a.push('детальные: '+(c.standard_games||0)+' игр');a.push('advanced: '+(c.advanced_games||0)+' игр');return '<div class="v13Coverage"><strong>Покрытие данных</strong> · '+esc(a.join(' · '))+'</div>'}
function roster(d){var rows=d.roster||[];if(!rows.length)return '<div class="v13Empty">Состав для этого сезона пока не загружен.</div>';return '<div class="v13List">'+rows.map(function(p){return '<div class="v13Roster" data-player="'+esc(p.player_id||'')+'"><div class="num">'+esc(p.sweater_number?'#'+p.sweater_number:(p.position_code||''))+'</div><div><b>'+esc(p.full_name_ru||p.full_name_en||('Player '+p.player_id))+'</b><small>'+esc((p.position_code||'')+' · '+(p.games||0)+' игр')+'</small></div><div class="stat">'+esc((p.goals||0)+'+'+(p.assists||0)+' = '+(p.points||0))+'</div></div>'}).join('')+'</div>'}
function stats(d){var s=d.standard_stats||{},a=d.advanced_stats||{},standard=s.games?'<div class="v13Metrics">'+metric('Броски / матч',fmt(s.shots_for_pg,1),'в створ','orange')+metric('Броски соп. / матч',fmt(s.shots_against_pg,1),'в створ','lav')+metric('Большинство',s.power_play_pct==null?'—':fmt(s.power_play_pct,1)+'%',(s.power_play_goals||0)+' / '+(s.power_play_opportunities||0),'orange')+metric('Вбрасывания',s.faceoff_pct==null?'—':fmt(s.faceoff_pct,1)+'%','FO%','lav')+metric('Хиты',s.hits,'за сезон','')+metric('Блоки',s.blocked_shots,'за сезон','')+metric('Потери',s.giveaways,'за сезон','')+metric('Перехваты',s.takeaways,'за сезон','')+'</div>':'<div class="v13Empty">Детальная обычная статистика этого сезона отсутствует в D1.</div>';var adv=a.games?'<div class="v13Metrics">'+metric('xGF%',fmt(a.xgf_pct_5v5,1)+'%','5-на-5','lav')+metric('CF%',fmt(a.corsi_for_pct_5v5,1)+'%','5-на-5','orange')+metric('FF%',fmt(a.fenwick_for_pct_5v5,1)+'%','5-на-5','lav')+metric('SF%',fmt(a.sf_pct_5v5,1)+'%','5-на-5','orange')+metric('xGF/60',fmt(a.xgf60,2),'5-на-5','')+metric('xGA/60',fmt(a.xga60,2),'5-на-5','')+metric('PDO',fmt(a.pdo_5v5,1),'5-на-5','')+metric('GSAx',fmt(a.goals_saved_above_expected,1),'сумма','')+'</div>':'<div class="v13Empty">Продвинутая статистика этого сезона пока не загружена.</div>';return '<div class="v13TeamBody"><div class="v13SectionTitle">Обычная статистика</div>'+standard+'<div class="v13SectionTitle">Продвинутая · 5-на-5</div>'+adv+coverage(d.coverage||{})+'</div>'}
function gameRow(g,tri){var opp=g.opponent_tri||(String(g.home_tri).toUpperCase()===tri?g.away_tri:g.home_tri);return '<div class="v13Game"><div class="date">'+esc(dateText(g.scheduled_start_utc))+'</div><b>'+esc(opp||'—')+'</b><div class="score">'+esc(scoreText(g,tri))+'</div></div>'}
function schedule(d,tri){var rows=d.schedule||[];return '<div class="v13List">'+(rows.length?rows.map(function(g){return gameRow(g,tri)}).join(''):'<div class="v13Empty">Расписание этого сезона недоступно.</div>')+'</div>'}
async function table(tri,season){var body=teamBody();if(!body)return;body.innerHTML='<div class="v13Empty">Загрузка таблицы...</div>';try{var d=await api(API+'/teams/'+tri+'/season/'+season+'/table'),rows=d.table||[];body.innerHTML='<div class="v13Table">'+(rows.length?rows.map(function(x,i){return '<div class="v13TableRow '+(x.team_tri===tri?'sel':'')+'"><div>'+(x.league_sequence||i+1)+'</div><img src="'+esc(x.logo||('https://assets.nhle.com/logos/nhl/svg/'+x.team_tri+'_light.svg'))+'"><b>'+esc(x.name||x.team_tri)+'</b><div>'+esc(x.games_played||0)+'</div><div><b>'+esc(x.points||0)+'</b> оч.</div></div>'}).join(''):'<div class="v13Empty">Таблица недоступна.</div>')+'</div>'}catch(e){body.innerHTML='<div class="v13Empty">Не удалось загрузить таблицу.</div>'}}
function sectionName(b){var t=String(b.textContent||'').toLowerCase();if(t.indexOf('состав')>=0)return'roster';if(t.indexOf('статист')>=0)return'stats';if(t.indexOf('распис')>=0)return'schedule';if(t.indexOf('таблиц')>=0)return'table';return'overview'}
async function renderSection(root,section){var body=teamBody(),tri=root.dataset.v13Tri,season=root.dataset.v13Season,data=root._v13Data;if(!body||!data)return;tabs().forEach(function(b){b.classList.toggle('active',sectionName(b)===section)});root.dataset.v13Section=section;if(section==='overview')body.innerHTML=overview(data,tri);else if(section==='roster')body.innerHTML=roster(data);else if(section==='stats')body.innerHTML=stats(data);else if(section==='schedule')body.innerHTML=schedule(data,tri);else if(section==='table')await table(tri,season)}
async function loadTeam(root,tri,season){var body=teamBody();if(body)body.innerHTML='<div class="v13Empty">Загрузка данных команды...</div>';try{var d=await api(API+'/teams/'+tri+'/season/'+season);root._v13Data=d;root.dataset.v13Season=season;await renderSection(root,root.dataset.v13Section||'overview')}catch(e){if(body)body.innerHTML='<div class="v13Empty">Ошибка загрузки команды: '+esc(e.message||e)+'</div>'}}
async function installTeam(root,force){var tri=teamTri();if(!tri)return;if(root.dataset.v13Tri===tri&&!force)return;root.dataset.v13Tri=tri;root.dataset.v13Section='overview';var bs=tabs();bs.forEach(function(b){var sec=sectionName(b);b.dataset.v13Section=sec;b.onclick=function(ev){ev.preventDefault();ev.stopPropagation();renderSection(root,sec)}});var sel=seasonSel();if(!sel)return;try{var sd=await api(API+'/teams/'+tri+'/seasons');var old=String(sel.value||'').replace(/\D/g,'');sel.innerHTML=(sd.seasons||[]).map(function(s,i){return '<option value="'+esc(s.season_id)+'" '+(i===0?'selected':'')+'>'+esc(s.label)+(s.advanced_available?' · ADV':'')+'</option>'}).join('');var season=sel.value||(sd.seasons&&sd.seasons[0]&&sd.seasons[0].season_id)||'';sel.onchange=function(){root.dataset.v13Section='overview';loadTeam(root,tri,sel.value)};await loadTeam(root,tri,season)}catch(e){var body=teamBody();if(body)body.innerHTML='<div class="v13Empty">Не удалось загрузить список сезонов.</div>'}}
function syncTeam(force){var head=document.querySelector('#view .profileHead:not(.player)');if(!head)return;installTeam(head,Boolean(force))}
function run(){css();refreshButton();var badge=document.querySelector('.v8');if(badge)badge.textContent='V13';syncTeam(false);renderMedia(false);var rb=document.getElementById('v13Refresh');if(rb)rb.style.display=document.querySelector('.profileHead')?'none':'block'}
let timer=null;var obs=new MutationObserver(function(){clearTimeout(timer);timer=setTimeout(run,55)});obs.observe(document.documentElement,{subtree:true,childList:true});document.addEventListener('click',function(e){if(e.target&&e.target.closest&&e.target.closest('.tab'))setTimeout(function(){renderMedia(true);run()},120)},true);run();
})();`;
