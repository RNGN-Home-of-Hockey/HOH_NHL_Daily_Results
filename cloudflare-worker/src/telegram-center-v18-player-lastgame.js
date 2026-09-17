const API = "/api/telegram-center-v18";
const NHL = "https://api-web.nhle.com/v1";

export async function handleTelegramCenterV18PlayerLastGame(request, env, path) {
  const m = new RegExp(`^${API}/players/(\\d+)/last-game$`).exec(path);
  if (!m) return null;
  if (request.method !== "GET") return json({ok:false,error:"method_not_allowed"},405);
  if (!env?.DB) return json({ok:false,error:"missing_d1_binding"},503);
  return playerLastGame(env, Number(m[1]));
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

    // First choice: official NHL player game log. This guarantees that the match
    // shown really is one in which the player appeared, instead of merely the
    // latest game played by his current team.
    const official = await loadOfficialLastAppearance(playerId).catch(()=>null);
    let row = official?.gameId ? await loadGameRow(env.DB, Number(official.gameId), player.current_team_tri, official) : null;
    let participation = row ? "nhl_game_log" : null;

    // Fallback remains strict: local player_game_stats also proves participation.
    // There is deliberately no "latest team game" fallback.
    if (!row) {
      row = await env.DB.prepare(`
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
      participation = row ? "player_game_stats" : null;
    }

    return json({
      ok:true,schema_ready:true,
      player:{player_id:player.player_id,full_name_en:player.full_name_en,full_name_ru:player.full_name_ru,current_team_tri:player.current_team_tri,team_name_en:player.team_name_en,team_name_ru:player.team_name_ru,team_logo:player.team_logo},
      participation,
      game:row?{
        game_pk:Number(row.game_pk),season_id:row.season_id,scheduled_start_utc:row.scheduled_start_utc,game_state:row.game_state,
        home_tri:row.home_tri,away_tri:row.away_tri,home_score:row.home_score,away_score:row.away_score,team_tri:row.team_tri||official?.teamAbbrev||player.current_team_tri,
        player_stats:{
          goals:num(row.goals ?? official?.goals),assists:num(row.assists ?? official?.assists),points:num(row.points ?? official?.points),
          shots:numOrNull(row.shots ?? official?.shots),toi_seconds:numOrNull(row.toi_seconds),
        },
        vk:row.source_key?{source_key:row.source_key,title:row.vk_title,web_url:row.vk_url,app_url:row.vk_app_url,thumbnail_url:row.vk_thumbnail,status:row.vk_status}:null,
      }:null,
    });
  } catch (error) {
    if (/no such table:\s*(vk_broadcasts|game_vk_broadcasts)/i.test(errorText(error))) return json({ok:true,schema_ready:false,player_id:playerId,game:null,error:"vk_schema_not_applied"});
    console.error("center v18 player last appearance failed",playerId,error);
    return json({ok:false,error:"player_last_game_failed",detail:errorText(error)},503);
  }
}

async function loadOfficialLastAppearance(playerId){
  const season=currentSeason();
  const prev=String(Number(season.slice(0,4))-1)+String(Number(season.slice(4))-1);
  const urls=[
    `${NHL}/player/${playerId}/game-log/${season}/3`,`${NHL}/player/${playerId}/game-log/${season}/2`,
    `${NHL}/player/${playerId}/game-log/${prev}/3`,`${NHL}/player/${playerId}/game-log/${prev}/2`,
  ];
  const packs=await Promise.all(urls.map(u=>fetch(u,{headers:{Accept:"application/json","User-Agent":"HOH-NHL-Center/18 player-last-game"}}).then(r=>r.ok?r.json():null).catch(()=>null)));
  const rows=[];
  for(const p of packs)for(const g of p?.gameLog||[])if(g?.gameId)rows.push(g);
  rows.sort((a,b)=>Date.parse(b.gameDate||0)-Date.parse(a.gameDate||0)||Number(b.gameId)-Number(a.gameId));
  return rows[0]||null;
}

async function loadGameRow(db, gamePk, currentTeamTri, official){
  const g=await db.prepare(`
    SELECT g.game_pk,g.season_id,g.scheduled_start_utc,g.game_state,g.home_tri,g.away_tri,g.home_score,g.away_score,
           b.source_key,b.title vk_title,b.web_url vk_url,b.app_url vk_app_url,b.thumbnail_url vk_thumbnail,b.status vk_status
    FROM games g
    LEFT JOIN game_vk_broadcasts m ON m.game_pk=g.game_pk
    LEFT JOIN vk_broadcasts b ON b.source_key=m.source_key
    WHERE g.game_pk=? LIMIT 1;
  `).bind(gamePk).first();
  if(!g)return null;
  return {...g,team_tri:String(official?.teamAbbrev||currentTeamTri||"").toUpperCase(),goals:official?.goals,assists:official?.assists,points:official?.points,shots:official?.shots,toi_seconds:null};
}
function currentSeason(){const d=new Date(),y=d.getUTCFullYear(),m=d.getUTCMonth()+1,s=m>=7?y:y-1;return String(s)+String(s+1)}
function num(v){const n=Number(v);return Number.isFinite(n)?n:0}
function numOrNull(v){const n=Number(v);return Number.isFinite(n)?n:null}
function errorText(e){return String(e?.message||e||"unknown_error")}
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}})}
