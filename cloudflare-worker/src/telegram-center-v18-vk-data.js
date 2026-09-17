const API = "/api/telegram-center-v18";

export async function handleTelegramCenterV18VkData(request, env, path) {
  if (!path.startsWith(API)) return null;
  if (!env?.DB) return json({ ok:false, error:"missing_d1_binding" }, 503);
  if (request.method !== "GET") return json({ ok:false, error:"method_not_allowed" }, 405);

  const game = new RegExp(`^${API}/games/(\\d+)$`).exec(path);
  if (game) return gameDetail(env, Number(game[1]));

  const team = new RegExp(`^${API}/teams/([A-Za-z]{3})/season/(20\\d{6})/vk$`).exec(path);
  if (team) return teamSeason(env, team[1].toUpperCase(), team[2]);

  const player = new RegExp(`^${API}/players/(\\d+)/last-game$`).exec(path);
  if (player) return playerLastGame(env, Number(player[1]));

  if (path === `${API}/vk/status`) return vkStatus(env);
  return json({ ok:false, error:"not_found" }, 404);
}

async function gameDetail(env, gamePk) {
  if (!Number.isSafeInteger(gamePk) || gamePk <= 0) return json({ok:false,error:"invalid_game_pk"},400);
  try {
    const game = await env.DB.prepare(`
      SELECT g.game_pk,g.season_id,g.game_type,g.scheduled_start_utc,g.game_state,
             g.home_tri,g.away_tri,g.home_score,g.away_score,g.period_type,g.venue_name,
             ht.name_en home_name_en,ht.name_ru home_name_ru,ht.logo_url home_logo,
             at.name_en away_name_en,at.name_ru away_name_ru,at.logo_url away_logo
      FROM games g
      LEFT JOIN teams ht ON ht.tri_code=g.home_tri
      LEFT JOIN teams at ON at.tri_code=g.away_tri
      WHERE g.game_pk=? LIMIT 1;
    `).bind(gamePk).first();
    if (!game) return json({ok:false,error:"game_not_found"},404);
    const [broadcast, marketPack] = await Promise.all([
      loadBroadcast(env.DB, gamePk),
      loadGameMarkets(env.DB, gamePk),
    ]);
    return json({ok:true,game:decorateGame(game),broadcast,markets:marketPack.markets,winline_event:marketPack.event});
  } catch (error) {
    if (isMissingVkSchema(error)) return json({ok:true,schema_ready:false,game_pk:gamePk,broadcast:null,markets:[],error:"vk_schema_not_applied"});
    console.error("center v18 game detail failed", gamePk, error);
    return json({ok:false,error:"game_detail_failed",detail:errorText(error)},503);
  }
}

async function teamSeason(env, tri, season) {
  try {
    const rows = await env.DB.prepare(`
      SELECT g.game_pk,g.scheduled_start_utc,g.game_state,g.home_tri,g.away_tri,g.home_score,g.away_score,
             b.source_key,b.title vk_title,b.web_url vk_url,b.app_url vk_app_url,b.thumbnail_url vk_thumbnail,
             b.status vk_status
      FROM games g
      LEFT JOIN game_vk_broadcasts m ON m.game_pk=g.game_pk
      LEFT JOIN vk_broadcasts b ON b.source_key=m.source_key
      WHERE CAST(g.season_id AS TEXT)=? AND (g.home_tri=? OR g.away_tri=?)
      ORDER BY g.scheduled_start_utc ASC,g.game_pk ASC;
    `).bind(season,tri,tri).all();
    const games=(rows.results||[]).map(x=>({
      game_pk:Number(x.game_pk),scheduled_start_utc:x.scheduled_start_utc,game_state:x.game_state,
      home_tri:x.home_tri,away_tri:x.away_tri,home_score:x.home_score,away_score:x.away_score,
      vk:x.source_key?{source_key:x.source_key,title:x.vk_title,web_url:x.vk_url,app_url:x.vk_app_url,thumbnail_url:x.vk_thumbnail,status:x.vk_status}:null,
    }));
    return json({ok:true,schema_ready:true,team_tri:tri,season,games,mapped:games.filter(x=>x.vk).length,total:games.length});
  } catch (error) {
    if (isMissingVkSchema(error)) return json({ok:true,schema_ready:false,team_tri:tri,season,games:[],mapped:0,total:0,error:"vk_schema_not_applied"});
    return json({ok:false,error:"team_vk_schedule_failed",detail:errorText(error)},503);
  }
}

async function playerLastGame(env, playerId) {
  if (!Number.isSafeInteger(playerId) || playerId <= 0) return json({ok:false,error:"invalid_player_id"},400);
  try {
    const player = await env.DB.prepare(`
      SELECT p.player_id,p.full_name_en,p.full_name_ru,p.current_team_tri,
             t.name_en team_name_en,t.name_ru team_name_ru,t.logo_url team_logo
      FROM players p LEFT JOIN teams t ON t.tri_code=p.current_team_tri
      WHERE p.player_id=? LIMIT 1;
    `).bind(playerId).first();
    if (!player) return json({ok:false,error:"player_not_found"},404);
    let row = await env.DB.prepare(`
      SELECT g.game_pk,g.season_id,g.scheduled_start_utc,g.game_state,g.home_tri,g.away_tri,g.home_score,g.away_score,
             s.team_tri,s.goals,s.assists,s.points,s.shots,s.toi_seconds,
             b.source_key,b.title vk_title,b.web_url vk_url,b.app_url vk_app_url,b.thumbnail_url vk_thumbnail,b.status vk_status
      FROM player_game_stats s
      JOIN games g ON g.game_pk=s.game_pk
      LEFT JOIN game_vk_broadcasts m ON m.game_pk=g.game_pk
      LEFT JOIN vk_broadcasts b ON b.source_key=m.source_key
      WHERE s.player_id=? AND UPPER(COALESCE(g.game_state,'')) IN ('FINAL','OFF')
      ORDER BY g.scheduled_start_utc DESC,g.game_pk DESC LIMIT 1;
    `).bind(playerId).first();
    let participation="player_game_stats";
    if (!row) {
      row = await env.DB.prepare(`
        SELECT g.game_pk,g.season_id,g.scheduled_start_utc,g.game_state,g.home_tri,g.away_tri,g.home_score,g.away_score,
               ? team_tri,NULL goals,NULL assists,NULL points,NULL shots,NULL toi_seconds,
               b.source_key,b.title vk_title,b.web_url vk_url,b.app_url vk_app_url,b.thumbnail_url vk_thumbnail,b.status vk_status
        FROM games g
        LEFT JOIN game_vk_broadcasts m ON m.game_pk=g.game_pk
        LEFT JOIN vk_broadcasts b ON b.source_key=m.source_key
        WHERE (g.home_tri=? OR g.away_tri=?) AND UPPER(COALESCE(g.game_state,'')) IN ('FINAL','OFF')
        ORDER BY g.scheduled_start_utc DESC,g.game_pk DESC LIMIT 1;
      `).bind(player.current_team_tri,player.current_team_tri,player.current_team_tri).first();
      participation=row?"team_fallback":null;
    }
    return json({
      ok:true,schema_ready:true,
      player:{player_id:player.player_id,full_name_en:player.full_name_en,full_name_ru:player.full_name_ru,current_team_tri:player.current_team_tri,team_name_en:player.team_name_en,team_name_ru:player.team_name_ru,team_logo:player.team_logo},
      participation,
      game:row?{
        game_pk:Number(row.game_pk),season_id:row.season_id,scheduled_start_utc:row.scheduled_start_utc,game_state:row.game_state,
        home_tri:row.home_tri,away_tri:row.away_tri,home_score:row.home_score,away_score:row.away_score,team_tri:row.team_tri,
        player_stats:participation==="player_game_stats"?{goals:row.goals,assists:row.assists,points:row.points,shots:row.shots,toi_seconds:row.toi_seconds}:null,
        vk:row.source_key?{source_key:row.source_key,title:row.vk_title,web_url:row.vk_url,app_url:row.vk_app_url,thumbnail_url:row.vk_thumbnail,status:row.vk_status}:null,
      }:null,
    });
  } catch (error) {
    if (isMissingVkSchema(error)) return json({ok:true,schema_ready:false,player_id:playerId,game:null,error:"vk_schema_not_applied"});
    return json({ok:false,error:"player_last_game_failed",detail:errorText(error)},503);
  }
}

async function vkStatus(env) {
  try {
    const [broadcasts,mapped,games] = await Promise.all([
      env.DB.prepare(`SELECT COUNT(*) n,MAX(updated_at) updated_at FROM vk_broadcasts;`).first(),
      env.DB.prepare(`SELECT COUNT(*) n,MAX(updated_at) updated_at FROM game_vk_broadcasts;`).first(),
      env.DB.prepare(`SELECT COUNT(*) n FROM games WHERE CAST(season_id AS TEXT) IN ('20242025','20252026') AND game_type IN (2,3);`).first(),
    ]);
    return json({ok:true,schema_ready:true,broadcasts:Number(broadcasts?.n||0),mapped:Number(mapped?.n||0),target_games:Number(games?.n||0),updated_at:mapped?.updated_at||broadcasts?.updated_at||null});
  } catch (error) {
    if (isMissingVkSchema(error)) return json({ok:true,schema_ready:false,broadcasts:0,mapped:0,target_games:0,error:"vk_schema_not_applied"});
    return json({ok:false,error:"vk_status_failed",detail:errorText(error)},503);
  }
}

async function loadBroadcast(db, gamePk) {
  return db.prepare(`
    SELECT b.source_key,b.source_kind,b.owner_id,b.video_id,b.title,b.published_at,b.scheduled_at,b.status,
           b.web_url,b.app_url,b.thumbnail_url,b.duration_seconds,m.match_method,m.match_confidence,m.matched_at
    FROM game_vk_broadcasts m JOIN vk_broadcasts b ON b.source_key=m.source_key
    WHERE m.game_pk=? LIMIT 1;
  `).bind(gamePk).first();
}

async function loadGameMarkets(db, gamePk) {
  try {
    const event=await db.prepare(`SELECT winline_event_id,game_pk,status,starts_at,deeplink,updated_at FROM winline_events WHERE game_pk=? LIMIT 1;`).bind(gamePk).first();
    if(!event)return {event:null,markets:[]};
    const rows=await db.prepare(`
      SELECT winline_market_id,market_type,subject_type,subject_key,outcome_name,odds,deeplink,is_live,active,updated_at
      FROM winline_markets WHERE winline_event_id=? AND active=1 AND odds IS NOT NULL
      ORDER BY is_live DESC,updated_at DESC,winline_market_id ASC LIMIT 40;
    `).bind(event.winline_event_id).all();
    return {event,markets:rows.results||[]};
  } catch { return {event:null,markets:[]}; }
}

function decorateGame(g){
  return {...g,
    home:{tri:g.home_tri,name_ru:g.home_name_ru,name_en:g.home_name_en,logo:g.home_logo||teamLogo(g.home_tri)},
    away:{tri:g.away_tri,name_ru:g.away_name_ru,name_en:g.away_name_en,logo:g.away_logo||teamLogo(g.away_tri)},
  };
}
function teamLogo(tri){return `https://assets.nhle.com/logos/nhl/svg/${String(tri||"").toUpperCase()}_light.svg`}
function isMissingVkSchema(error){return /no such table:\s*(vk_broadcasts|game_vk_broadcasts)/i.test(errorText(error))}
function errorText(error){return String(error?.message||error||"unknown_error")}
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}})}
