import salaryCache from "../../player_salary_2026_27.json" with { type: "json" };
import fullNames from "../../ru_full_names.json" with { type: "json" };
import { runCenterRosterMaintenance } from "./telegram-center-roster-maintenance.js";

const API="/api/telegram-center-v15";
const NHL="https://api-web.nhle.com/v1";
const NHL_STATS="https://api.nhle.com/stats/rest/en";

export async function handleTelegramCenterV15PlayerData(request,env,path){
  if(!env?.DB)return null;
  if(path===`${API}/players`&&request.method==="GET")return players(request,env);
  let m=/^\/api\/telegram-center-v15\/players\/(\d+)$/.exec(path);
  if(m&&request.method==="GET")return profile(env,Number(m[1]));
  m=/^\/api\/telegram-center-v15\/players\/(\d+)\/season\/(20\d{6})\/ranks$/.exec(path);
  if(m&&request.method==="GET")return playerRanks(Number(m[1]),m[2]);
  m=/^\/api\/telegram-center-v15\/players\/(\d+)\/trends$/.exec(path);
  if(m&&request.method==="GET")return trends(request,env,Number(m[1]));
  return null;
}

async function players(request,env){
  await runCenterRosterMaintenance(env).catch(()=>null);
  const u=new URL(request.url),team=up(u.searchParams.get("team")||""),q=String(u.searchParams.get("q")||"").trim(),limit=clamp(u.searchParams.get("limit"),180,1,300);
  try{
    const r=await env.DB.prepare(`SELECT p.player_id,p.full_name_en,COALESCE(m.full_name_ru,p.full_name_ru) full_name_ru,p.current_team_tri,p.position_code,p.sweater_number,m.primary_country_code,m.birth_date FROM players p LEFT JOIN player_profile_meta m ON m.player_id=p.player_id WHERE COALESCE(p.active,1)=1 AND (?='' OR p.current_team_tri=?) AND (?='' OR p.full_name_en LIKE '%'||?||'%' OR COALESCE(m.full_name_ru,p.full_name_ru,'') LIKE '%'||?||'%') ORDER BY CASE UPPER(COALESCE(p.position_code,'')) WHEN 'C' THEN 1 WHEN 'L' THEN 1 WHEN 'LW' THEN 1 WHEN 'R' THEN 1 WHEN 'RW' THEN 1 WHEN 'D' THEN 2 WHEN 'G' THEN 3 ELSE 4 END,CASE WHEN p.sweater_number IS NULL THEN 999 ELSE p.sweater_number END,p.full_name_en LIMIT ?;`).bind(team,team,q,q,q,limit).all();
    const season=currentSeason(),sal=salaryCache?.players||{};
    return json({ok:true,season,players:(r.results||[]).map(p=>decorate(p,sal[String(p.player_id)],season)),source:"d1_current_roster_v15"});
  }catch(error){return json({ok:false,error:"players_failed",detail:err(error),players:[]},503)}
}

async function profile(env,id){
  if(!Number.isSafeInteger(id)||id<=0)return json({ok:false,error:"invalid_player_id"},400);
  await runCenterRosterMaintenance(env).catch(()=>null);
  const row=await env.DB.prepare(`SELECT p.player_id,p.full_name_en,COALESCE(m.full_name_ru,p.full_name_ru) full_name_ru,p.current_team_tri,p.position_code,p.sweater_number,m.primary_country_code,m.birth_date FROM players p LEFT JOIN player_profile_meta m ON m.player_id=p.player_id WHERE p.player_id=? LIMIT 1;`).bind(id).first().catch(()=>null);
  const landing=await fetchJson(`${NHL}/player/${id}/landing`).catch(()=>null);
  if(!row&&!landing)return json({ok:false,error:"player_not_found"},404);
  const tri=up(landing?.currentTeamAbbrev||row?.current_team_tri||""),salary=(salaryCache?.players||{})[String(id)]||null,birth=String(row?.birth_date||landing?.birthDate||"").trim()||null;
  return json({ok:true,player:{player_id:id,full_name_en:row?.full_name_en||[loc(landing?.firstName),loc(landing?.lastName)].filter(Boolean).join(" "),full_name_ru:row?.full_name_ru||fullNames?.[String(id)]||null,current_team_tri:tri,position_code:up(row?.position_code||landing?.position||""),sweater_number:row?.sweater_number??landing?.sweaterNumber??null,primary_country_code:up(row?.primary_country_code||landing?.birthCountry||"").slice(0,3),birth_date:birth,age:age(birth),team_logo:landing?.teamLogo||teamLogo(tri),headshot:landing?.headshot||photo(id,tri,currentSeason()),salary_aav:numOrNull(salary?.aav??salary?.cap_hit),salary_cash:numOrNull(salary?.salary_cash),salary_source:salaryCache?.source||null}});
}

async function playerRanks(id,season){
  if(!Number.isSafeInteger(id)||id<=0)return json({ok:false,error:"invalid_player_id"},400);
  try{
    const exp=`seasonId=${season} and gameTypeId=2`,d=await fetchJson(`${NHL_STATS}/skater/summary?isAggregate=false&isGame=false&start=0&limit=-1&sort=points&cayenneExp=${encodeURIComponent(exp)}`),rows=Array.isArray(d?.data)?d.data:[],target=rows.find(x=>Number(x.playerId)===id)||null;
    if(!target)return json({ok:true,player_id:id,season,total:rows.length,ranks:{league:{},team:{}}});
    const tri=up(String(target.teamAbbrevs||target.teamAbbrev||"").split(/[, ]+/).filter(Boolean).pop()||""),teamRows=rows.filter(x=>String(x.teamAbbrevs||x.teamAbbrev||"").toUpperCase().split(/[, ]+/).includes(tri)),metrics={goals:x=>n(x.goals),assists:x=>n(x.assists),points:x=>n(x.points),games:x=>n(x.gamesPlayed)},league={},team={};
    for(const [k,fn] of Object.entries(metrics)){league[`${k}_rank`]=rankOf(rows,id,fn);team[`${k}_rank`]=rankOf(teamRows,id,fn)}
    return json({ok:true,player_id:id,season,team_tri:tri,total:rows.length,team_total:teamRows.length,ranks:{league,team}});
  }catch(error){return json({ok:false,error:"player_ranks_failed",detail:err(error)},503)}
}

async function trends(request,env,id){
  if(!Number.isSafeInteger(id)||id<=0)return json({ok:false,error:"invalid_player_id"},400);
  let season=String(new URL(request.url).searchParams.get("season")||currentSeason()).replace(/\D/g,"");if(!/^20\d{6}$/.test(season))season=currentSeason();
  let rows=await rowsDb(env.DB,id,season).catch(()=>[]),effective=season,source="d1";
  if(rows.length<3&&season===currentSeason()){effective=previousSeason();const prev=await rowsDb(env.DB,id,effective).catch(()=>[]);if(prev.length>=3){rows=prev;source="d1_previous"}}
  if(rows.length<3){const live=await rowsNhl(id,effective).catch(()=>[]);if(live.length){rows=live;source="nhl_game_log"}}
  const built=trendEngine(rows);
  return json({ok:true,player_id:id,requested_season:season,season:effective,season_label:label(effective),source,sample:rows.length,evaluated:built.evaluated,trends:built.trends});
}

async function rowsDb(db,id,season){const r=await db.prepare(`SELECT s.goals,s.assists,s.points,s.shots,s.hits,s.blocked_shots,s.pim,s.plus_minus,s.toi_seconds,s.power_play_points FROM player_game_stats s JOIN games g ON g.game_pk=s.game_pk WHERE s.player_id=? AND CAST(g.season_id AS TEXT)=? AND g.game_type=2 AND UPPER(COALESCE(g.game_state,'')) IN ('FINAL','OFF') ORDER BY g.scheduled_start_utc DESC,g.game_pk DESC LIMIT 24;`).bind(id,season).all();return(r.results||[]).map(normRow)}
async function rowsNhl(id,season){const d=await fetchJson(`${NHL}/player/${id}/game-log/${season}/2`),a=Array.isArray(d?.gameLog)?d.gameLog:Array.isArray(d?.games)?d.games:[];return a.slice(0,24).map(x=>normRow({goals:x.goals,assists:x.assists,points:x.points,shots:x.shots,hits:x.hits,blocked_shots:x.blockedShots,pim:x.pim,plus_minus:x.plusMinus,toi_seconds:toi(x.toi||x.timeOnIce),power_play_points:x.powerPlayPoints}))}
function normRow(x){return{goals:n(x.goals),assists:n(x.assists),points:n(x.points),shots:n(x.shots),hits:n(x.hits),blocks:n(x.blocked_shots),pim:n(x.pim),plusMinus:n(x.plus_minus),toi:n(x.toi_seconds),ppp:n(x.power_play_points)}}

function trendEngine(rows){
  rows=(rows||[]).slice(0,20);if(!rows.length)return{evaluated:0,trends:[]};
  const p=[P("pts1","points","набрал минимум 1 очко",r=>r.points>=1),P("pts2","points","набрал минимум 2 очка",r=>r.points>=2),P("pts3","points","набрал минимум 3 очка",r=>r.points>=3),P("g1","goals","забил минимум 1 гол",r=>r.goals>=1),P("g2","goals","забил минимум 2 гола",r=>r.goals>=2),P("a1","assists","сделал минимум 1 передачу",r=>r.assists>=1),P("a2","assists","сделал минимум 2 передачи",r=>r.assists>=2),P("s2","shots","нанёс минимум 2 броска",r=>r.shots>=2),P("s3","shots","нанёс минимум 3 броска",r=>r.shots>=3),P("s4","shots","нанёс минимум 4 броска",r=>r.shots>=4),P("s5","shots","нанёс минимум 5 бросков",r=>r.shots>=5),P("s6","shots","нанёс минимум 6 бросков",r=>r.shots>=6),P("h1","hits","сделал минимум 1 хит",r=>r.hits>=1),P("h2","hits","сделал минимум 2 хита",r=>r.hits>=2),P("h3","hits","сделал минимум 3 хита",r=>r.hits>=3),P("b1","blocks","заблокировал минимум 1 бросок",r=>r.blocks>=1),P("b2","blocks","заблокировал минимум 2 броска",r=>r.blocks>=2),P("pm0","pm","завершил матч с неотрицательным +/-",r=>r.plusMinus>=0),P("pm1","pm","завершил матч с +1 или лучше",r=>r.plusMinus>=1),P("pp1","pp","набрал очко в большинстве",r=>r.ppp>=1),P("t15","toi","сыграл минимум 15 минут",r=>r.toi>=900),P("t18","toi","сыграл минимум 18 минут",r=>r.toi>=1080),P("t20","toi","сыграл минимум 20 минут",r=>r.toi>=1200),P("t22","toi","сыграл минимум 22 минуты",r=>r.toi>=1320)];
  const windows=[3,4,5,6,7,8,10,12,15,20].filter(w=>w<=rows.length),c=[];let evaluated=0;
  for(const w of windows){const s=rows.slice(0,w);for(const a of p){evaluated++;const h=s.filter(a.test).length,r=h/w;if(r>=.6&&h>=2)c.push(C(a,w,h,r))}for(let i=0;i<p.length;i++)for(let j=i+1;j<p.length;j++){const a=p[i],b=p[j];if(a.family===b.family)continue;evaluated++;const h=s.filter(x=>a.test(x)&&b.test(x)).length,r=h/w;if(r>=.6&&h>=2)c.push({key:`${a.key}+${b.key}-${w}`,family:`${a.family}+${b.family}`,text:`${h} из ${w}: ${a.text} и ${b.text}`,hits:h,sample:w,rate:r,score:r*100+w+12})}}
  for(const a of p){let st=0;for(const x of rows){if(a.test(x))st++;else break}evaluated++;if(st>=3)c.push({key:`st-${a.key}`,family:a.family,text:`${st} матчей подряд: ${a.text}`,hits:st,sample:st,rate:1,score:180+st*3})}
  c.sort((a,b)=>b.score-a.score||b.sample-a.sample);const out=[],families=new Map();for(const x of c){const count=families.get(x.family)||0;if(count>=2||out.some(y=>sim(y.text,x.text)))continue;out.push(x);families.set(x.family,count+1);if(out.length>=6)break}
  return{evaluated,trends:out.map(x=>({key:x.key,text:x.text,hits:x.hits,sample:x.sample,rate:Math.round(x.rate*100)}))};
}
function P(key,family,text,test){return{key,family,text,test}}function C(a,w,h,r){return{key:`${a.key}-${w}`,family:a.family,text:`${h} из ${w} последних матчей: ${a.text}`,hits:h,sample:w,rate:r,score:r*100+w*1.5+(r===1?18:0)}}function sim(a,b){return String(a).replace(/\d+/g,"#")===String(b).replace(/\d+/g,"#")}
function decorate(p,salary,season){return{...p,full_name_ru:p.full_name_ru||fullNames?.[String(p.player_id)]||null,salary_aav:numOrNull(salary?.aav??salary?.cap_hit),salary_cash:numOrNull(salary?.salary_cash),photo:photo(p.player_id,p.current_team_tri,season),team_logo:teamLogo(p.current_team_tri),age:age(p.birth_date)}}
function rankOf(rows,id,get){const a=[...rows].sort((x,y)=>get(y)-get(x)||Number(x.playerId)-Number(y.playerId)),i=a.findIndex(x=>Number(x.playerId)===id);return i<0?null:i+1}
function age(v){if(!v)return null;const d=new Date(v),z=new Date();if(Number.isNaN(d.getTime()))return null;let a=z.getUTCFullYear()-d.getUTCFullYear(),m=z.getUTCMonth()-d.getUTCMonth();if(m<0||(m===0&&z.getUTCDate()<d.getUTCDate()))a--;return a}
function toi(v){if(typeof v==="number")return v;const m=String(v||"").match(/^(\d+):(\d+)$/);return m?Number(m[1])*60+Number(m[2]):n(v)}
function photo(id,tri,season){return id&&tri?`https://assets.nhle.com/mugs/nhl/${season}/${tri}/${id}.png`:null}function teamLogo(t){return t?`https://assets.nhle.com/logos/nhl/svg/${up(t)}_light.svg`:null}
function currentSeason(){const d=new Date(),y=d.getUTCFullYear(),m=d.getUTCMonth()+1,s=m>=7?y:y-1;return`${s}${s+1}`}function previousSeason(){const s=Number(currentSeason().slice(0,4))-1;return`${s}${s+1}`}function label(s){s=String(s||"");return s.length===8?`${s.slice(0,4)}/${s.slice(6,8)}`:s}
function loc(v){return v&&typeof v==="object"?(v.default||v.en||v.ru||""):String(v||"")}function up(v){return String(v||"").trim().toUpperCase()}function n(v){const x=Number(v);return Number.isFinite(x)?x:0}function numOrNull(v){if(v===null||v===undefined||v==="")return null;const x=Number(v);return Number.isFinite(x)?x:null}function clamp(v,f,min,max){const x=Number(v);return Number.isSafeInteger(x)&&x>=min&&x<=max?x:f}function err(e){return String(e?.message||e||"unknown_error")}
async function fetchJson(url){const c=new AbortController(),t=setTimeout(()=>c.abort(),8000);try{const r=await fetch(url,{signal:c.signal,headers:{Accept:"application/json","User-Agent":"HOH-NHL-Center/15"}});if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.json()}finally{clearTimeout(t)}}
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}})}
