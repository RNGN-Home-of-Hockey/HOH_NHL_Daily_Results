import { runCenterRosterMaintenance } from "./telegram-center-roster-maintenance.js";

const API = "/api/telegram-center-v19";
const FINAL_STATES = new Set(["FINAL", "OFF"]);
const MIN_ARCHIVE_DATE = "2024-09-01";
const MAX_RANGE_DAYS = 93;

export async function handleTelegramCenterV19ProductData(request, env, path) {
  if (!path.startsWith(API)) return null;
  if (!env?.DB) return json({ ok:false, error:"missing_d1_binding" }, 503);
  if (request.method !== "GET") return json({ ok:false, error:"method_not_allowed" }, 405);

  if (path === `${API}/status`) return productStatus(env);
  if (path === `${API}/broadcasts`) return broadcasts(request, env);
  if (path === `${API}/featured`) return featuredGame(request, env);
  const game = new RegExp(`^${API}/games/(\\d+)$`).exec(path);
  if (game) return gameDetail(env, Number(game[1]));
  return json({ ok:false, error:"not_found" }, 404);
}

async function productStatus(env) {
  const maintenance = await runCenterRosterMaintenance(env).catch(error => ({ok:false,error:errorText(error)}));
  try {
    const [rows, total, snapshots] = await Promise.all([
      env.DB.prepare(`SELECT current_team_tri team_tri,COUNT(*) players FROM players WHERE COALESCE(active,1)=1 AND current_team_tri IS NOT NULL GROUP BY current_team_tri ORDER BY current_team_tri;`).all(),
      env.DB.prepare(`SELECT COUNT(*) players FROM players WHERE COALESCE(active,1)=1;`).first(),
      env.DB.prepare(`SELECT COUNT(*) snapshots,COUNT(DISTINCT game_pk) games FROM winline_market_snapshots;`).first().catch(()=>({snapshots:0,games:0})),
    ]);
    const teams=(rows.results||[]).map(x=>({team_tri:x.team_tri,players:Number(x.players||0)}));
    const expected=["ANA","BOS","BUF","CGY","CAR","CHI","COL","CBJ","DAL","DET","EDM","FLA","LAK","MIN","MTL","NSH","NJD","NYI","NYR","OTT","PHI","PIT","SJS","SEA","STL","TBL","TOR","UTA","VAN","VGK","WSH","WPG"];
    const counts=new Map(teams.map(x=>[x.team_tri,x.players]));
    const missing_or_short_rosters=expected.filter(tri=>(counts.get(tri)||0)<15).map(tri=>({team_tri:tri,players:counts.get(tri)||0}));
    return json({ok:true,version:"V19",roster_maintenance:maintenance,active_players:Number(total?.players||0),teams_with_roster:teams.length,roster_complete:missing_or_short_rosters.length===0,missing_or_short_rosters,teams,winline_snapshots:Number(snapshots?.snapshots||0),winline_snapshot_games:Number(snapshots?.games||0)});
  } catch (error) {
    return json({ok:false,error:"product_status_failed",detail:errorText(error)},503);
  }
}

async function broadcasts(request, env) {
  const u=new URL(request.url);
  const from=cleanDate(u.searchParams.get("from")||MIN_ARCHIVE_DATE);
  const to=cleanDate(u.searchParams.get("to")||from);
  if(!from||!to)return json({ok:false,error:"invalid_date_range"},400);
  if(from<MIN_ARCHIVE_DATE)return json({ok:false,error:"archive_before_minimum",minimum:MIN_ARCHIVE_DATE},400);
  const span=Math.round((Date.parse(to+"T00:00:00Z")-Date.parse(from+"T00:00:00Z"))/86400000);
  if(!Number.isFinite(span)||span<0||span>MAX_RANGE_DAYS)return json({ok:false,error:"range_too_large",max_days:MAX_RANGE_DAYS},400);
  try{
    const rows=await env.DB.prepare(`
      SELECT date(datetime(g.scheduled_start_utc,'-8 hours')) calendar_date,
             g.game_pk,g.season_id,g.game_type,g.scheduled_start_utc,g.game_state,g.home_tri,g.away_tri,g.home_score,g.away_score,g.period_type,g.venue_name,
             ht.name_en home_name_en,ht.name_ru home_name_ru,ht.logo_url home_logo,
             at.name_en away_name_en,at.name_ru away_name_ru,at.logo_url away_logo,
             b.source_key,b.title vk_title,b.web_url vk_url,b.app_url vk_app_url,b.thumbnail_url vk_thumbnail,b.status vk_status,
             we.winline_event_id winline_event_id,
             w1.odds winline_p1, wx.odds winline_x, w2.odds winline_p2,
             COALESCE(w1.deeplink,wx.deeplink,w2.deeplink,we.deeplink) winline_deeplink,
             ho.home_odds hist_p1,ho.draw_odds hist_x,ho.away_odds hist_p2,
             hof.regulation_result hist_result,ho.source hist_source
      FROM games g
      LEFT JOIN teams ht ON ht.tri_code=g.home_tri
      LEFT JOIN teams at ON at.tri_code=g.away_tri
      LEFT JOIN game_vk_broadcasts m ON m.game_pk=g.game_pk
      LEFT JOIN vk_broadcasts b ON b.source_key=m.source_key
      LEFT JOIN winline_events we ON we.game_pk=g.game_pk
      LEFT JOIN winline_markets w1 ON w1.winline_event_id=we.winline_event_id AND w1.winline_market_id=we.winline_event_id||':main_1x2:1' AND w1.active=1
      LEFT JOIN winline_markets wx ON wx.winline_event_id=we.winline_event_id AND wx.winline_market_id=we.winline_event_id||':main_1x2:X' AND wx.active=1
      LEFT JOIN winline_markets w2 ON w2.winline_event_id=we.winline_event_id AND w2.winline_market_id=we.winline_event_id||':main_1x2:2' AND w2.active=1
      LEFT JOIN historical_odds_closing ho
        ON ho.game_pk=g.game_pk AND ho.market_key='regular_time_1x2' AND ho.source='user_excel_consensus_2seasons'
      LEFT JOIN historical_odds_game_features hof
        ON hof.game_pk=ho.game_pk AND hof.source=ho.source AND hof.market_key=ho.market_key
      WHERE date(datetime(g.scheduled_start_utc,'-8 hours')) BETWEEN ? AND ?
        AND g.game_type IN (1,2,3)
      ORDER BY g.scheduled_start_utc ASC,g.game_pk ASC;
    `).bind(from,to).all();
    const games=(rows.results||[]).map(decorateArchiveGame);
    const map=new Map();
    for(const g of games){const d=map.get(g.calendar_date)||{date:g.calendar_date,count:0,regular:0,playoffs:0,preseason:0,vk:0};d.count++;if(g.game_type===3)d.playoffs++;else if(g.game_type===2)d.regular++;else if(g.game_type===1)d.preseason++;if(g.vk)d.vk++;map.set(g.calendar_date,d)}
    return json({ok:true,version:"V19",minimum_date:MIN_ARCHIVE_DATE,from,to,days:[...map.values()],games});
  }catch(error){
    if(isMissingVkSchema(error))return json({ok:false,error:"vk_schema_not_applied",detail:errorText(error)},503);
    return json({ok:false,error:"broadcast_archive_failed",detail:errorText(error)},503);
  }
}

async function featuredGame(request,env){
  const u=new URL(request.url),date=cleanDate(u.searchParams.get("date")||"");
  if(!date)return json({ok:false,error:"invalid_date"},400);
  try{
    const rows=await env.DB.prepare(`
      SELECT date(datetime(g.scheduled_start_utc,'-8 hours')) calendar_date,
             g.game_pk,g.season_id,g.game_type,g.scheduled_start_utc,g.game_state,g.home_tri,g.away_tri,g.home_score,g.away_score,g.period_type,g.venue_name,
             ht.name_en home_name_en,ht.name_ru home_name_ru,ht.logo_url home_logo,
             at.name_en away_name_en,at.name_ru away_name_ru,at.logo_url away_logo,
             b.source_key,b.title vk_title,b.web_url vk_url,b.app_url vk_app_url,b.thumbnail_url vk_thumbnail,b.status vk_status,
             we.winline_event_id winline_event_id,w1.odds winline_p1,wx.odds winline_x,w2.odds winline_p2
      FROM games g
      LEFT JOIN teams ht ON ht.tri_code=g.home_tri LEFT JOIN teams at ON at.tri_code=g.away_tri
      LEFT JOIN game_vk_broadcasts m ON m.game_pk=g.game_pk LEFT JOIN vk_broadcasts b ON b.source_key=m.source_key
      LEFT JOIN winline_events we ON we.game_pk=g.game_pk
      LEFT JOIN winline_markets w1 ON w1.winline_event_id=we.winline_event_id AND w1.winline_market_id=we.winline_event_id||':main_1x2:1' AND w1.active=1
      LEFT JOIN winline_markets wx ON wx.winline_event_id=we.winline_event_id AND wx.winline_market_id=we.winline_event_id||':main_1x2:X' AND wx.active=1
      LEFT JOIN winline_markets w2 ON w2.winline_event_id=we.winline_event_id AND w2.winline_market_id=we.winline_event_id||':main_1x2:2' AND w2.active=1
      WHERE date(datetime(g.scheduled_start_utc,'-8 hours'))=? AND g.game_type IN (1,2,3)
      ORDER BY g.scheduled_start_utc ASC,g.game_pk ASC;
    `).bind(date).all();
    const games=(rows.results||[]).map(x=>({calendar_date:x.calendar_date,game_pk:Number(x.game_pk),game_type:Number(x.game_type),scheduled_start_utc:x.scheduled_start_utc,game_state:x.game_state,home_score:x.home_score,away_score:x.away_score,period_type:x.period_type,venue_name:x.venue_name,
      home:{tri:x.home_tri,name_ru:x.home_name_ru,name_en:x.home_name_en,logo:x.home_logo||teamLogo(x.home_tri)},away:{tri:x.away_tri,name_ru:x.away_name_ru,name_en:x.away_name_en,logo:x.away_logo||teamLogo(x.away_tri)},
      vk:x.source_key?{source_key:x.source_key,title:x.vk_title,web_url:x.vk_url,app_url:x.vk_app_url,thumbnail_url:x.vk_thumbnail,status:x.vk_status}:null,
      winline:[x.winline_p1,x.winline_x,x.winline_p2].some(v=>Number.isFinite(Number(v))&&Number(v)>1)?{event_id:x.winline_event_id,p1:Number(x.winline_p1)||null,x:Number(x.winline_x)||null,p2:Number(x.winline_p2)||null}:null}));
    if(!games.length)return json({ok:true,date,featured:null});
    const tris=[...new Set(games.flatMap(g=>[g.home.tri,g.away.tri]).filter(Boolean))],ph=tris.map(()=>"?").join(",");
    const [standings,followers]=await Promise.all([
      tris.length?env.DB.prepare(`SELECT s.team_tri,s.games_played,s.wins,s.points,s.league_rank FROM standings_snapshots s JOIN (SELECT team_tri,MAX(snapshot_date) md FROM standings_snapshots GROUP BY team_tri) x ON x.team_tri=s.team_tri AND x.md=s.snapshot_date WHERE s.team_tri IN (${ph});`).bind(...tris).all():{results:[]},
      tris.length?env.DB.prepare(`SELECT subject_key team_tri,COUNT(*) followers FROM subscriptions WHERE subject_type='team' AND subject_key IN (${ph}) GROUP BY subject_key;`).bind(...tris).all():{results:[]}
    ]);
    const st=new Map((standings.results||[]).map(x=>[x.team_tri,x])),fol=new Map((followers.results||[]).map(x=>[x.team_tri,Number(x.followers||0)]));
    let overrides={};try{overrides=JSON.parse(String(env.HOH_FEATURED_GAMES_JSON||"{}"))||{}}catch{}
    const special=text=>{const s=String(text||"").toLowerCase(),defs=[["winter classic","Зимняя классика"],["stadium series","Stadium Series"],["heritage classic","Heritage Classic"],["global series","Global Series"],["outdoor","Матч под открытым небом"],["classic","Специальный матч NHL"]];return defs.find(([k])=>s.includes(k))?.[1]||null};
    const scored=games.map(g=>{const a=st.get(g.away.tri)||{},h=st.get(g.home.tri)||{},aw=Number(a.games_played)>0?Number(a.wins||0)/Number(a.games_played):0,hw=Number(h.games_played)>0?Number(h.wins||0)/Number(h.games_played):0,followers=(fol.get(g.away.tri)||0)+(fol.get(g.home.tri)||0),sp=special([g.venue_name,g.vk?.title].filter(Boolean).join(" ")),ov=overrides[String(g.game_pk)]||null,rankQ=(a.league_rank?33-Number(a.league_rank):0)+(h.league_rank?33-Number(h.league_rank):0);const score=(ov?10000:0)+(sp?2000:0)+(g.game_type===3?500:0)+(aw+hw)*240+Math.log2(1+followers)*55+rankQ*2+(g.vk?20:0);return{g,score,aw,hw,followers,sp,ov}});
    scored.sort((a,b)=>b.score-a.score||String(a.g.scheduled_start_utc).localeCompare(String(b.g.scheduled_start_utc)));
    const best=scored[0],g=best.g,away=g.away.name_ru||g.away.name_en||g.away.tri,home=g.home.name_ru||g.home.name_en||g.home.tri,avg=(best.aw+best.hw)/2;
    let reason=best.ov?.description||best.ov?.reason||best.sp||"";
    if(!reason&&g.game_type===3)reason="Главная пара дня в плей-офф.";
    if(!reason&&avg>=.55)reason="Одна из сильнейших пар дня по текущему проценту побед.";
    if(!reason&&best.followers>0)reason="Самая заметная пара дня по интересу пользователей HOME OF HOCKEY.";
    if(!reason)reason="Главный матч игрового дня по сочетанию силы команд и турнирного контекста.";
    const vkUrl=best.ov?.vk_url||g.vk?.web_url||g.vk?.app_url||"https://vkvideo.ru/@nhl_home_of_hockey/lives";
    const cover=best.ov?.cover_url||g.vk?.thumbnail_url||null;
    return json({ok:true,date,featured:{...g,title:best.ov?.title||away+" — "+home,description:reason,vk_url:vkUrl,thumbnail_url:cover,selection_score:Math.round(best.score),signals:{special:best.sp||null,followers:best.followers,away_win_pct:best.aw||null,home_win_pct:best.hw||null,manual:Boolean(best.ov)}}});
  }catch(error){return json({ok:false,error:"featured_game_failed",detail:errorText(error)},503)}
}

async function gameDetail(env, gamePk) {
  if (!Number.isSafeInteger(gamePk) || gamePk<=0) return json({ok:false,error:"invalid_game_pk"},400);
  try{
    const game=await env.DB.prepare(`
      SELECT g.game_pk,g.season_id,g.game_type,g.scheduled_start_utc,g.game_state,g.home_tri,g.away_tri,g.home_score,g.away_score,g.period_type,g.venue_name,
             ht.name_en home_name_en,ht.name_ru home_name_ru,ht.logo_url home_logo,
             at.name_en away_name_en,at.name_ru away_name_ru,at.logo_url away_logo
      FROM games g
      LEFT JOIN teams ht ON ht.tri_code=g.home_tri
      LEFT JOIN teams at ON at.tri_code=g.away_tri
      WHERE g.game_pk=? LIMIT 1;
    `).bind(gamePk).first();
    if(!game)return json({ok:false,error:"game_not_found"},404);
    const [broadcast,winline,historicalOdds]=await Promise.all([
      loadBroadcast(env.DB,gamePk),
      loadCanonicalWinline(env.DB,game),
      loadHistoricalOdds(env.DB,game),
    ]);
    const videoFallback=!broadcast&&FINAL_STATES.has(up(game.game_state))
      ? await loadOfficialNhlYoutubeHighlight(game).catch(()=>null)
      : null;
    return json({ok:true,version:"V19",game:decorateGame(game),broadcast,video_fallback:videoFallback,winline,historical_odds:historicalOdds});
  }catch(error){
    if(isMissingVkSchema(error))return json({ok:false,error:"vk_schema_not_applied",detail:errorText(error)},503);
    return json({ok:false,error:"game_detail_failed",detail:errorText(error)},503);
  }
}

const NHL_YOUTUBE_HANDLE="@NHL";

async function loadOfficialNhlYoutubeHighlight(game){
  const away=String(game?.away_name_en||game?.away_tri||"").trim();
  const home=String(game?.home_name_en||game?.home_tri||"").trim();
  const d=new Date(String(game?.scheduled_start_utc||""));
  const date=Number.isNaN(d.getTime())?"":d.toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric",timeZone:"UTC"});
  const query=[away,home,date,"highlights"].filter(Boolean).join(" ");
  const searchUrl="https://www.youtube.com/"+NHL_YOUTUBE_HANDLE+"/search?query="+encodeURIComponent(query);
  const fallback={
    source_kind:"youtube_nhl_search",
    broadcast_kind:"highlights",
    match_method:"official_nhl_youtube_search_fallback",
    match_confidence:0.5,
    title:[away,home].filter(Boolean).join(" — ")+" · NHL highlights",
    web_url:searchUrl,
    app_url:searchUrl,
    thumbnail_url:null,
    channel_handle:NHL_YOUTUBE_HANDLE,
  };
  let html="";
  try{
    const r=await fetch(searchUrl,{
      headers:{
        "User-Agent":"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
        "Accept-Language":"en-US,en;q=0.9",
      },
      redirect:"follow",
    });
    if(!r.ok)return fallback;
    html=await r.text();
  }catch{return fallback}
  const candidates=parseNhlYoutubeCandidates(html);
  if(!candidates.length)return fallback;
  const tokens=teamVideoTokens(away).concat(teamVideoTokens(home));
  let best=null,bestScore=-1;
  for(const candidate of candidates){
    const title=String(candidate.title||"").toLowerCase();
    let score=0;
    for(const token of tokens)if(title.includes(token))score+=2;
    if(/highlight|recap|extended|condensed|game recap/.test(title))score+=4;
    if(/shorts|short #|mic'd up|interview|press conference/.test(title))score-=4;
    if(score>bestScore){best=candidate;bestScore=score}
  }
  if(!best||bestScore<4)return fallback;
  return {
    source_kind:"youtube_nhl",
    broadcast_kind:"highlights",
    match_method:"official_nhl_youtube_search",
    match_confidence:Math.min(0.96,0.68+bestScore*0.025),
    video_id:best.video_id,
    title:best.title||fallback.title,
    web_url:"https://www.youtube.com/watch?v="+best.video_id,
    app_url:"https://www.youtube.com/watch?v="+best.video_id,
    thumbnail_url:"https://i.ytimg.com/vi/"+best.video_id+"/hq720.jpg",
    channel_handle:NHL_YOUTUBE_HANDLE,
  };
}
function parseNhlYoutubeCandidates(html){
  const source=String(html||""),out=[],seen=new Set(),re=/"videoId":"([A-Za-z0-9_-]{11})"/g;
  let m;
  while((m=re.exec(source))&&out.length<30){
    const id=m[1];
    if(seen.has(id))continue;
    const chunk=source.slice(m.index,Math.min(source.length,m.index+2400));
    const tm=/"title":\{"runs":\[\{"text":"((?:\\.|[^"\\])+)"/.exec(chunk)
      || /"title":\{"simpleText":"((?:\\.|[^"\\])+)"/.exec(chunk);
    const title=tm?decodeYoutubeText(tm[1]):"";
    if(!title)continue;
    seen.add(id);
    out.push({video_id:id,title});
  }
  return out;
}
function decodeYoutubeText(value){
  const s=String(value||"");
  try{return JSON.parse('"'+s.replace(/"/g,'\\"')+'"')}catch{
    return s.replace(/\\u0026/g,"&").replace(/\\u003d/g,"=").replace(/\\n/g," ").replace(/\\\"/g,'"').replace(/\\\\/g,"\\");
  }
}
function teamVideoTokens(name){
  return String(name||"").toLowerCase().split(/[^a-z0-9]+/).filter(x=>x.length>=4&&!["hockey","club","the"].includes(x));
}

async function loadBroadcast(db,gamePk){
  const direct=await db.prepare(`
    SELECT b.source_key,b.source_kind,b.owner_id,b.video_id,b.title,b.published_at,b.scheduled_at,b.status,b.web_url,b.app_url,b.thumbnail_url,b.duration_seconds,m.match_method,m.match_confidence,m.matched_at,'full' broadcast_kind
    FROM game_vk_broadcasts m JOIN vk_broadcasts b ON b.source_key=m.source_key
    WHERE m.game_pk=? LIMIT 1;
  `).bind(gamePk).first();
  if(direct)return direct;
  const game=await db.prepare(`
    SELECT game_pk,scheduled_start_utc,home_tri,away_tri FROM games WHERE game_pk=? LIMIT 1;
  `).bind(gamePk).first();
  return game?findBroadcastByPairTime(db,game):null;
}
async function findBroadcastByPairTime(db,game){
  const start=String(game?.scheduled_start_utc||"");
  const home=String(game?.home_tri||"").toUpperCase(),away=String(game?.away_tri||"").toUpperCase();
  if(!start||!home||!away)return null;
  const full=await db.prepare(`
    SELECT b.source_key,b.source_kind,b.owner_id,b.video_id,b.title,b.published_at,b.scheduled_at,b.status,
           b.web_url,b.app_url,b.thumbnail_url,b.duration_seconds,
           'pair_time_fallback' match_method,0.82 match_confidence,NULL matched_at,'full' broadcast_kind
    FROM vk_broadcasts b
    WHERE ((b.parsed_home_tri=? AND b.parsed_away_tri=?) OR (b.parsed_home_tri=? AND b.parsed_away_tri=?))
      AND COALESCE(b.scheduled_at,b.published_at) IS NOT NULL
      AND ABS(julianday(COALESCE(b.scheduled_at,b.published_at))-julianday(?))<=2.0
      AND (b.duration_seconds IS NULL OR b.duration_seconds>=1800)
      AND LOWER(COALESCE(b.title,'')) NOT LIKE '%хайлайт%'
      AND LOWER(COALESCE(b.title,'')) NOT LIKE '%highlight%'
      AND LOWER(COALESCE(b.title,'')) NOT LIKE '%обзор матча%'
      AND LOWER(COALESCE(b.title,'')) NOT LIKE '%лучшие моменты%'
      AND LOWER(COALESCE(b.title,'')) NOT LIKE '%best moment%'
    ORDER BY ABS(julianday(COALESCE(b.scheduled_at,b.published_at))-julianday(?)) ASC,
             COALESCE(b.duration_seconds,0) DESC,b.updated_at DESC LIMIT 1;
  `).bind(home,away,away,home,start,start).first().catch(()=>null);
  if(full)return full;
  return db.prepare(`
    SELECT b.source_key,b.source_kind,b.owner_id,b.video_id,b.title,b.published_at,b.scheduled_at,b.status,
           b.web_url,b.app_url,b.thumbnail_url,b.duration_seconds,
           'pair_time_highlight_fallback' match_method,0.74 match_confidence,NULL matched_at,'highlights' broadcast_kind
    FROM vk_broadcasts b
    WHERE ((b.parsed_home_tri=? AND b.parsed_away_tri=?) OR (b.parsed_home_tri=? AND b.parsed_away_tri=?))
      AND COALESCE(b.scheduled_at,b.published_at) IS NOT NULL
      AND ABS(julianday(COALESCE(b.scheduled_at,b.published_at))-julianday(?))<=1.0
      AND COALESCE(b.duration_seconds,0)>=120
      AND (
        LOWER(COALESCE(b.title,'')) LIKE '%хайлайт%' OR LOWER(COALESCE(b.title,'')) LIKE '%highlight%'
        OR LOWER(COALESCE(b.title,'')) LIKE '%обзор матча%' OR LOWER(COALESCE(b.title,'')) LIKE '%лучшие моменты%'
        OR LOWER(COALESCE(b.title,'')) LIKE '%best moment%'
      )
    ORDER BY ABS(julianday(COALESCE(b.scheduled_at,b.published_at))-julianday(?)) ASC,
             COALESCE(b.duration_seconds,0) DESC,b.updated_at DESC LIMIT 1;
  `).bind(home,away,away,home,start,start).first().catch(()=>null);
}

async function loadHistoricalOdds(db,game){
  try{
    const row=await db.prepare(`
      SELECT o.source,o.market_key,o.home_odds,o.draw_odds,o.away_odds,o.overround_pct,
             f.regulation_result
      FROM historical_odds_closing o
      LEFT JOIN historical_odds_game_features f
        ON f.game_pk=o.game_pk AND f.source=o.source AND f.market_key=o.market_key
      WHERE o.game_pk=? AND o.market_key='regular_time_1x2'
      ORDER BY CASE WHEN o.source='user_excel_consensus_2seasons' THEN 0 ELSE 1 END,o.updated_at DESC
      LIMIT 1;
    `).bind(game.game_pk).first();
    if(!row)return null;
    const result=String(row.regulation_result||"").toUpperCase();
    return {
      source:row.source,
      market_key:row.market_key,
      overround_pct:Number.isFinite(Number(row.overround_pct))?Number(row.overround_pct):null,
      markets:[
        {outcome_key:"home",label:"П1",odds:Number(row.home_odds),winner:result==="1"},
        {outcome_key:"draw",label:"X",odds:Number(row.draw_odds),winner:result==="X"},
        {outcome_key:"away",label:"П2",odds:Number(row.away_odds),winner:result==="2"},
      ].filter(x=>Number.isFinite(x.odds)),
      settled_outcome:result||null,
    };
  }catch{return null}
}

async function loadCanonicalWinline(db,game){
  const event=await db.prepare(`SELECT winline_event_id,game_pk,status,starts_at,deeplink,updated_at FROM winline_events WHERE game_pk=? LIMIT 1;`).bind(game.game_pk).first().catch(()=>null);
  if(!event)return {event:null,source:"none",captured_at:null,market_type:null,markets:[],settled_outcome:null};
  const final=FINAL_STATES.has(up(game.game_state));
  let rows=[],source="current",capturedAt=null;
  if(final){
    try{
      const snap=await db.prepare(`
        SELECT MAX(captured_at) captured_at FROM winline_market_snapshots
        WHERE game_pk=? AND is_live=0 AND captured_at<=?;
      `).bind(game.game_pk,game.scheduled_start_utc).first();
      if(snap?.captured_at){
        const r=await db.prepare(`
          SELECT winline_market_id,market_type,subject_type,subject_key,outcome_name,odds,deeplink,is_live,captured_at updated_at
          FROM winline_market_snapshots WHERE game_pk=? AND captured_at=? AND is_live=0 AND odds IS NOT NULL
          ORDER BY winline_market_id ASC;
        `).bind(game.game_pk,snap.captured_at).all();
        rows=r.results||[];source="historical_pregame";capturedAt=snap.captured_at;
      }
    }catch{}
    if(!rows.length){
      const safe=await db.prepare(`
        SELECT winline_market_id,market_type,subject_type,subject_key,outcome_name,odds,deeplink,is_live,active,updated_at
        FROM winline_markets WHERE winline_event_id=? AND is_live=0 AND odds IS NOT NULL AND updated_at<=?
        ORDER BY updated_at DESC,winline_market_id ASC LIMIT 80;
      `).bind(event.winline_event_id,game.scheduled_start_utc).all().catch(()=>({results:[]}));
      rows=safe.results||[];if(rows.length){source="safe_current_pregame";capturedAt=rows[0]?.updated_at||null}
    }
  }else{
    const r=await db.prepare(`
      SELECT winline_market_id,market_type,subject_type,subject_key,outcome_name,odds,deeplink,is_live,active,updated_at
      FROM winline_markets WHERE winline_event_id=? AND active=1 AND odds IS NOT NULL
      ORDER BY is_live ASC,updated_at DESC,winline_market_id ASC LIMIT 80;
    `).bind(event.winline_event_id).all().catch(()=>({results:[]}));
    rows=r.results||[];capturedAt=rows[0]?.updated_at||null;
  }
  const canonical=canonicalMarket(rows,game);
  const settled=final?settledOutcome(game,canonical.keys):null;
  return {event,source,captured_at:capturedAt,market_type:canonical.market_type,markets:canonical.rows.map(x=>({...x,winner:Boolean(settled&&x.outcome_key===settled)})),settled_outcome:settled};
}

function canonicalMarket(rows,game){
  const groups=new Map();
  for(const raw of rows||[]){const key=String(raw.market_type||"");if(!groups.has(key))groups.set(key,[]);groups.get(key).push({...raw,outcome_key:outcomeKey(raw,game)})}
  let best={score:-1,market_type:null,rows:[],keys:new Set()};
  for(const [marketType,list] of groups){
    const dedupe=new Map();for(const x of list){const k=x.outcome_key||String(x.outcome_name||x.winline_market_id);if(!dedupe.has(k))dedupe.set(k,x)}
    const vals=[...dedupe.values()],keys=new Set(vals.map(x=>x.outcome_key).filter(Boolean));
    let score=0;if(keys.has("home"))score+=4;if(keys.has("away"))score+=4;if(keys.has("draw"))score+=5;if(keys.size>=2)score+=3;if(keys.size===3)score+=4;if(marketType==="main_1x2_regular")score+=100;else if(/1x2|3.?way|regular|60|основ|исход|match.?result/i.test(marketType)&&!/period/i.test(marketType))score+=6;score-=vals.some(x=>Number(x.is_live)===1)?1:0;
    if(score>best.score)best={score,market_type:marketType,rows:vals,keys};
  }
  const order={home:1,draw:2,away:3};best.rows.sort((a,b)=>(order[a.outcome_key]||9)-(order[b.outcome_key]||9));return best;
}

function outcomeKey(row,game){
  const sk=up(row.subject_key),name=String(row.outcome_name||"").trim().toLowerCase(),type=String(row.market_type||"").toLowerCase();
  if(sk&&sk===up(game.home_tri))return "home";if(sk&&sk===up(game.away_tri))return "away";
  if(/(^|\s)(draw|x|ничья|н)(\s|$)/i.test(name)||name==="х")return "draw";
  if(/home|хозя|п1|(^|\s)1(\s|$)/i.test(name))return "home";
  if(/away|гост|п2|(^|\s)2(\s|$)/i.test(name))return "away";
  if(/1x2|3.?way|regular|60|основ|исход/i.test(type)){if(name==="1")return "home";if(name==="x")return "draw";if(name==="2")return "away"}
  return null;
}

function settledOutcome(game,keys){
  const hs=Number(game.home_score),as=Number(game.away_score);if(!Number.isFinite(hs)||!Number.isFinite(as))return null;
  if(keys?.has("draw")&&["OT","SO"].includes(up(game.period_type)))return "draw";
  if(hs>as)return "home";if(as>hs)return "away";return keys?.has("draw")?"draw":null;
}

function decorateArchiveGame(x){
  const validWinline=[x.winline_p1,x.winline_x,x.winline_p2].every(v=>v!==null&&v!==undefined&&Number.isFinite(Number(v))&&Number(v)>1);
  const validHistorical=[x.hist_p1,x.hist_x,x.hist_p2].every(v=>v!==null&&v!==undefined&&Number.isFinite(Number(v))&&Number(v)>1);
  const winline=validWinline?{event_id:x.winline_event_id,p1:Number(x.winline_p1),x:Number(x.winline_x),p2:Number(x.winline_p2),deeplink:x.winline_deeplink||null,source:"winline"}:null;
  const historical_odds=validHistorical?{p1:Number(x.hist_p1),x:Number(x.hist_x),p2:Number(x.hist_p2),result:String(x.hist_result||""),source:x.hist_source||"archive"}:null;
  return {calendar_date:x.calendar_date,game_pk:Number(x.game_pk),season_id:x.season_id,game_type:Number(x.game_type),is_playoff:Number(x.game_type)===3,scheduled_start_utc:x.scheduled_start_utc,game_state:x.game_state,home_score:x.home_score,away_score:x.away_score,period_type:x.period_type,venue_name:x.venue_name,
    home:{tri:x.home_tri,name_ru:x.home_name_ru,name_en:x.home_name_en,logo:x.home_logo||teamLogo(x.home_tri)},away:{tri:x.away_tri,name_ru:x.away_name_ru,name_en:x.away_name_en,logo:x.away_logo||teamLogo(x.away_tri)},
    vk:x.source_key?{source_key:x.source_key,title:x.vk_title,web_url:x.vk_url,app_url:x.vk_app_url,thumbnail_url:x.vk_thumbnail,status:x.vk_status}:null,
    winline,historical_odds};
}
function decorateGame(x){return {...x,game_pk:Number(x.game_pk),game_type:Number(x.game_type),is_playoff:Number(x.game_type)===3,home:{tri:x.home_tri,name_ru:x.home_name_ru,name_en:x.home_name_en,logo:x.home_logo||teamLogo(x.home_tri)},away:{tri:x.away_tri,name_ru:x.away_name_ru,name_en:x.away_name_en,logo:x.away_logo||teamLogo(x.away_tri)}}}
function teamLogo(tri){return tri?`https://assets.nhle.com/logos/nhl/svg/${up(tri)}_light.svg`:""}
function cleanDate(v){const s=String(v||"").trim();return /^20\d\d-\d\d-\d\d$/.test(s)?s:""}
function up(v){return String(v||"").trim().toUpperCase()}
function isMissingVkSchema(error){return /no such table:\s*(vk_broadcasts|game_vk_broadcasts)/i.test(errorText(error))}
function errorText(error){return String(error?.message||error||"unknown_error")}
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}})}
