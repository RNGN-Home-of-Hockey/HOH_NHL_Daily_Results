import salaryCache from "../../player_salary_2026_27.json" with { type: "json" };
import fullNames from "../../ru_full_names.json" with { type: "json" };
import pronunciationCache from "../../state/center_player_pronunciations_eliteprospects.json" with { type: "json" };
import { runCenterRosterMaintenance } from "./telegram-center-roster-maintenance.js";

const API="/api/telegram-center-v17";
const NHL="https://api-web.nhle.com/v1";

export async function handleTelegramCenterV17PlayerData(request,env,path){
  if(!env?.DB)return null;
  if(path===`${API}/players`&&request.method==="GET")return players(request,env);
  const m=/^\/api\/telegram-center-v17\/players\/(\d+)$/.exec(path);
  if(m&&request.method==="GET")return profile(env,Number(m[1]));
  return null;
}

async function players(request,env){
  await runCenterRosterMaintenance(env).catch(()=>null);
  const u=new URL(request.url),team=up(u.searchParams.get("team")||""),q=String(u.searchParams.get("q")||"").trim(),limit=clamp(u.searchParams.get("limit"),250,1,350);
  const map=new Map();

  for(const [idRaw,s] of Object.entries(salaryCache?.players||{})){
    const id=Number(idRaw);if(!Number.isSafeInteger(id))continue;
    map.set(id,{player_id:id,full_name_en:String(s?.full_name_en||s?.nhl_name||"").trim(),full_name_ru:fullNames?.[idRaw]||null,current_team_tri:up(s?.team||""),salary_aav:numOrNull(s?.aav??s?.cap_hit),salary_cash:numOrNull(s?.salary_cash)});
  }
  for(const [idRaw,p] of Object.entries(pronunciationCache?.players||{})){
    const id=Number(idRaw);if(!Number.isSafeInteger(id))continue;const prev=map.get(id)||{};
    map.set(id,{...prev,player_id:id,full_name_en:prev.full_name_en||String(p?.full_name_en||"").trim(),full_name_ru:prev.full_name_ru||fullNames?.[idRaw]||null,current_team_tri:up(prev.current_team_tri||p?.team_tri||"")});
  }

  try{
    const r=await env.DB.prepare(`SELECT p.player_id,p.full_name_en,COALESCE(m.full_name_ru,p.full_name_ru) full_name_ru,p.current_team_tri,p.position_code,p.sweater_number,m.primary_country_code,m.birth_date FROM players p LEFT JOIN player_profile_meta m ON m.player_id=p.player_id WHERE COALESCE(p.active,1)=1 LIMIT 1800;`).all();
    for(const d of r.results||[]){const id=Number(d.player_id),prev=map.get(id)||{},sal=(salaryCache?.players||{})[String(id)]||{};map.set(id,{...prev,...d,player_id:id,full_name_ru:d.full_name_ru||prev.full_name_ru||fullNames?.[String(id)]||null,salary_aav:numOrNull(sal?.aav??sal?.cap_hit??prev.salary_aav),salary_cash:numOrNull(sal?.salary_cash??prev.salary_cash)});}
  }catch{}

  if(team){
    const live=await liveRoster(team).catch(()=>[]);
    for(const d of live){const id=Number(d.player_id),prev=map.get(id)||{},sal=(salaryCache?.players||{})[String(id)]||{};map.set(id,{...prev,...d,full_name_ru:prev.full_name_ru||fullNames?.[String(id)]||null,salary_aav:numOrNull(sal?.aav??sal?.cap_hit??prev.salary_aav),salary_cash:numOrNull(sal?.salary_cash??prev.salary_cash)});}
  }

  const qq=q.toLocaleLowerCase('ru');
  const arr=[...map.values()].filter(p=>(!team||up(p.current_team_tri)===team)&&(!qq||String(p.full_name_en||"").toLowerCase().includes(qq)||String(p.full_name_ru||"").toLocaleLowerCase('ru').includes(qq))).map(decorate).sort(sortPlayers).slice(0,limit);
  return json({ok:true,players:arr,total:arr.length,source:team?"d1+salary+pronunciation+live_roster":"d1+salary+pronunciation"});
}

async function profile(env,id){
  if(!Number.isSafeInteger(id)||id<=0)return json({ok:false,error:"invalid_player_id"},400);
  const sal=(salaryCache?.players||{})[String(id)]||null,pron=(pronunciationCache?.players||{})[String(id)]||null;
  let row=null;
  try{row=await env.DB.prepare(`SELECT p.player_id,p.full_name_en,COALESCE(m.full_name_ru,p.full_name_ru) full_name_ru,p.current_team_tri,p.position_code,p.sweater_number,m.primary_country_code,m.birth_date FROM players p LEFT JOIN player_profile_meta m ON m.player_id=p.player_id WHERE p.player_id=? LIMIT 1;`).bind(id).first();}catch{}
  const landing=await fetchJson(`${NHL}/player/${id}/landing`).catch(()=>null);
  if(!row&&!landing&&!sal&&!pron&&!fullNames?.[String(id)])return json({ok:false,error:"player_not_found"},404);
  const tri=up(landing?.currentTeamAbbrev||row?.current_team_tri||sal?.team||pron?.team_tri||""),birth=String(row?.birth_date||landing?.birthDate||"").trim()||null;
  const en=String(row?.full_name_en||[loc(landing?.firstName),loc(landing?.lastName)].filter(Boolean).join(" ")||sal?.full_name_en||sal?.nhl_name||pron?.full_name_en||"").trim();
  const p={player_id:id,full_name_en:en,full_name_ru:row?.full_name_ru||fullNames?.[String(id)]||null,current_team_tri:tri,position_code:up(row?.position_code||landing?.position||""),sweater_number:row?.sweater_number??landing?.sweaterNumber??null,primary_country_code:up(row?.primary_country_code||landing?.birthCountry||"").slice(0,3),birth_date:birth,age:age(birth),team_logo:landing?.teamLogo||teamLogo(tri),headshot:landing?.headshot||photo(id,tri,currentSeason()),salary_aav:numOrNull(sal?.aav??sal?.cap_hit),salary_cash:numOrNull(sal?.salary_cash),profile_source:landing?"nhl_landing":row?"d1":pron?"pronunciation_cache":"salary_cache"};
  return json({ok:true,player:p});
}

async function liveRoster(tri){
  const d=await fetchJson(`${NHL}/roster/${tri}/current`),out=[];
  for(const [section,forced] of [["forwards",null],["defensemen","D"],["goalies","G"]])for(const r of d?.[section]||[]){const id=Number(r?.id);if(!Number.isSafeInteger(id))continue;const first=loc(r?.firstName),last=loc(r?.lastName),birth=String(r?.birthDate||"").trim()||null;out.push({player_id:id,full_name_en:[first,last].filter(Boolean).join(" "),current_team_tri:tri,position_code:up(forced||r?.positionCode||r?.position||""),sweater_number:numOrNull(r?.sweaterNumber),primary_country_code:up(r?.birthCountry||"").slice(0,3),birth_date:birth,age:age(birth),team_logo:teamLogo(tri),headshot:photo(id,tri,currentSeason())});}
  return out;
}

function decorate(p){const tri=up(p.current_team_tri||""),birth=p.birth_date||null;return{...p,full_name_ru:p.full_name_ru||fullNames?.[String(p.player_id)]||null,current_team_tri:tri,age:p.age??age(birth),team_logo:p.team_logo||teamLogo(tri),headshot:p.headshot||p.photo||photo(p.player_id,tri,currentSeason()),photo:p.photo||p.headshot||photo(p.player_id,tri,currentSeason())}}
function sortPlayers(a,b){const pos=x=>{x=up(x);return['C','L','LW','R','RW'].includes(x)?1:x==='D'?2:x==='G'?3:4};return pos(a.position_code)-pos(b.position_code)||(Number(a.sweater_number)||999)-(Number(b.sweater_number)||999)||String(a.full_name_en||'').localeCompare(String(b.full_name_en||''))}
function age(v){if(!v)return null;const d=new Date(v),z=new Date();if(Number.isNaN(d.getTime()))return null;let a=z.getUTCFullYear()-d.getUTCFullYear(),m=z.getUTCMonth()-d.getUTCMonth();if(m<0||(m===0&&z.getUTCDate()<d.getUTCDate()))a--;return a}
function currentSeason(){const d=new Date(),y=d.getUTCFullYear(),m=d.getUTCMonth()+1,s=m>=7?y:y-1;return`${s}${s+1}`}
function photo(id,tri,season){return id&&tri?`https://assets.nhle.com/mugs/nhl/${season}/${tri}/${id}.png`:""}function teamLogo(t){return t?`https://assets.nhle.com/logos/nhl/svg/${up(t)}_light.svg`:""}
function loc(v){return v&&typeof v==='object'?(v.default||v.en||v.ru||Object.values(v)[0]||''):String(v||'')}function up(v){return String(v||'').trim().toUpperCase()}function numOrNull(v){if(v===null||v===undefined||v==='')return null;const n=Number(v);return Number.isFinite(n)?n:null}function clamp(v,d,min,max){const n=Number(v);return Number.isFinite(n)?Math.max(min,Math.min(max,Math.trunc(n))):d}
async function fetchJson(url){const r=await fetch(url,{headers:{Accept:'application/json','User-Agent':'HOH-NHL-Center/17'}});if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.json()}
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store, no-cache, must-revalidate','X-Content-Type-Options':'nosniff'}})}
