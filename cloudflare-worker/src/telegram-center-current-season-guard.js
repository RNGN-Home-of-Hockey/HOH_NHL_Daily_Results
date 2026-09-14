const NHL="https://api-web.nhle.com/v1";

export async function handleCurrentSeasonTeamGuard(request,env,path){
  const m=/^\/api\/telegram-center-v3\/teams\/([A-Za-z]{3})$/.exec(path);
  if(!m||request.method!=="GET"||!env.DB)return null;
  const season=String(new URL(request.url).searchParams.get("season")||"");
  if(season!==currentSeasonId())return null;
  const tri=m[1].toUpperCase();
  try{
    const team=await env.DB.prepare(`SELECT tri_code,name_en,name_ru,logo_url FROM teams WHERE tri_code=? LIMIT 1;`).bind(tri).first();
    if(!team)return json({ok:false,error:"team_not_found"},404);
    const [standingsPayload,schedulePayload]=await Promise.all([
      fetchJson(`${NHL}/standings/now`).catch(()=>null),
      fetchJson(`${NHL}/club-schedule-season/${tri}/${season}`).catch(()=>null),
    ]);
    const rows=Array.isArray(standingsPayload?.standings)?standingsPayload.standings:[];
    const currentRows=rows.filter(r=>String(r?.seasonId||"")===season);
    const target=currentRows.find(r=>upper(r?.teamAbbrev?.default||r?.teamAbbrev)===tri)||null;
    const schedule=(schedulePayload?.games||[]).map(g=>normalizeGame(g,tri)).filter(Boolean).sort((a,b)=>String(a.scheduled_start_utc).localeCompare(String(b.scheduled_start_utc)));
    const next=schedule.find(g=>!isFinal(g.game_state)&&Date.parse(g.scheduled_start_utc)>=Date.now()-3600000)||null;
    let standings=emptyStanding(season),leagueRanks=null;
    if(target){
      standings={
        season_id:season,
        games_played:n(target.gamesPlayed)||0,
        wins:n(target.wins)||0,
        losses:n(target.losses)||0,
        ot_losses:n(target.otLosses)||0,
        points:n(target.points)||0,
        goals_for:n(target.goalFor)||0,
        goals_against:n(target.goalAgainst)||0,
        goal_diff:n(target.goalDifferential)||0,
        league_sequence:n(target.leagueSequence),
        conference_sequence:n(target.conferenceSequence),
        division_sequence:n(target.divisionSequence),
        conference_name:localized(target.conferenceName),
        division_name:localized(target.divisionName),
      };
      const scored=[...currentRows].sort((a,b)=>Number(b.goalFor||0)-Number(a.goalFor||0));
      const allowed=[...currentRows].sort((a,b)=>Number(a.goalAgainst||0)-Number(b.goalAgainst||0));
      leagueRanks={gf_rank:1+scored.findIndex(r=>upper(r?.teamAbbrev?.default||r?.teamAbbrev)===tri),ga_rank:1+allowed.findIndex(r=>upper(r?.teamAbbrev?.default||r?.teamAbbrev)===tri)};
      if(leagueRanks.gf_rank<=0)leagueRanks.gf_rank=null;
      if(leagueRanks.ga_rank<=0)leagueRanks.ga_rank=null;
    }
    return json({
      ok:true,
      season,
      season_label:seasonLabel(season),
      team:{...team,logo:team.logo_url||teamLogo(tri)},
      standings,
      league_ranks:leagueRanks,
      playoff:{stage:"Сезон не завершён",color:"#777780",round:null},
      next_game:next,
      recent:schedule.filter(g=>isFinal(g.game_state)).slice(-12).reverse(),
      schedule,
      current_season_guard:true,
      standings_source:target?"nhl_current":"current_season_empty",
      updated_at:new Date().toISOString(),
    });
  }catch(error){return json({ok:false,error:"current_season_guard_failed",detail:String(error?.message||error)},503)}
}

function emptyStanding(season){return {season_id:season,games_played:0,wins:0,losses:0,ot_losses:0,points:0,goals_for:0,goals_against:0,goal_diff:0,league_sequence:null,conference_sequence:null,division_sequence:null,conference_name:null,division_name:null}}
function normalizeGame(g,tri){const id=Number(g?.id),home=upper(g?.homeTeam?.abbrev),away=upper(g?.awayTeam?.abbrev),start=g?.startTimeUTC||g?.startTimeUtc;if(!Number.isSafeInteger(id)||id<=0||!home||!away||!start)return null;const type=Number(g?.gameType)||null,opp=home===tri?away:home;return {game_pk:id,season_id:String(g?.season||currentSeasonId()),game_type:type,scheduled_start_utc:start,game_state:upper(g?.gameState||"FUT"),home_tri:home,away_tri:away,home_score:n(g?.homeTeam?.score),away_score:n(g?.awayTeam?.score),opponent_tri:opp,opponent_name:opp,is_home:home===tri,stage_label_ru:type===1?"Предсезонный матч":type===2?"Регулярный сезон":type===3?"Плей-офф":"Матч НХЛ",stage_color:type===1?"#ffb45f":type===2?"#63a8ff":type===3?"#b98cff":"#8f8f98"}}
function currentSeasonId(){const d=new Date(),y=d.getUTCFullYear(),m=d.getUTCMonth()+1,s=m>=7?y:y-1;return `${s}${s+1}`}
function seasonLabel(s){const x=String(s||"");return x.length===8?`${x.slice(0,4)}/${x.slice(6,8)}`:x}
function isFinal(s){return ["FINAL","OFF"].includes(upper(s))}
function teamLogo(tri){return `https://assets.nhle.com/logos/nhl/svg/${tri}_light.svg`}
function upper(v){return String(v||"").trim().toUpperCase()}
function localized(v){if(!v)return null;if(typeof v==="string")return v;return v.default||v.ru||v.en||Object.values(v)[0]||null}
function n(v){if(v===null||v===undefined||v==="")return null;const x=Number(v);return Number.isFinite(x)?x:null}
async function fetchJson(url){const r=await fetch(url,{headers:{Accept:"application/json","User-Agent":"HOH-NHL-Center/7"}});if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.json()}
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}})}
