const API = "/api/telegram-center-v6";
const SCRIPT_PATH = "/telegram-app/profile-v6.js";
const NHL_WEB = "https://api-web.nhle.com/v1";
const NHL_STATS = "https://api.nhle.com/stats/rest/en";

export async function handleTelegramCenterProductV6(request, env, path) {
  if (path === SCRIPT_PATH) {
    if (request.method !== "GET") return json({ok:false,error:"method_not_allowed"},405);
    return new Response(SCRIPT,{headers:{"Content-Type":"application/javascript; charset=utf-8","Cache-Control":"no-store, no-cache, must-revalidate","X-Content-Type-Options":"nosniff"}});
  }
  if (!path.startsWith(API)) return null;
  if (request.method !== "GET") return json({ok:false,error:"method_not_allowed"},405);
  if (!env.DB) return json({ok:false,error:"missing_d1_binding"},503);

  const schedule = /^\/api\/telegram-center-v6\/teams\/([A-Za-z]{3})\/schedule$/.exec(path);
  if (schedule) return teamSchedule(request,env,schedule[1].toUpperCase());
  const history = /^\/api\/telegram-center-v6\/teams\/([A-Za-z]{3})\/history$/.exec(path);
  if (history) return teamHistory(env,history[1].toUpperCase());
  const standings = /^\/api\/telegram-center-v6\/teams\/([A-Za-z]{3})\/standings$/.exec(path);
  if (standings) return teamStandings(request,env,standings[1].toUpperCase());
  const injuries = /^\/api\/telegram-center-v6\/teams\/([A-Za-z]{3})\/injuries$/.exec(path);
  if (injuries) return json({ok:true,team_tri:injuries[1].toUpperCase(),available:false,items:[],message:"Источник подтвержденных травм пока не подключен"});
  const player = /^\/api\/telegram-center-v6\/players\/(\d+)\/analytics$/.exec(path);
  if (player) return playerAnalytics(request,env,Number(player[1]));
  return json({ok:false,error:"not_found"},404);
}

async function teamSchedule(request,env,tri){
  const season=normalizeSeason(new URL(request.url).searchParams.get("season"))||currentSeasonId();
  try{
    const [payload,names]=await Promise.all([fetchJson(`${NHL_WEB}/club-schedule-season/${tri}/${season}`),teamNameMap(env.DB)]);
    const rows=(payload?.games||[]).map(g=>normalizeScheduleGame(g,season)).filter(Boolean).sort((a,b)=>String(a.scheduled_start_utc).localeCompare(String(b.scheduled_start_utc)));
    let regNo=0;
    const games=rows.map(g=>{
      if(Number(g.game_type)===2) regNo+=1;
      const opponent=g.home_tri===tri?g.away_tri:g.home_tri;
      const round=Number(g.game_type)===3?playoffRound(g.game_pk):null;
      return {...g,opponent_tri:opponent,opponent_name:names[opponent]||opponent,is_home:g.home_tri===tri,team_game_no:Number(g.game_type)===2?regNo:null,playoff_round:round,playoff_game_no:Number(g.game_type)===3?playoffGameNo(g.game_pk):null,stage_label_ru:stageLabel(g.game_type,round),stage_color:stageColor(g.game_type,round)};
    });
    return json({ok:true,season,season_label:seasonLabel(season),team_tri:tri,games,updated_at:new Date().toISOString()});
  }catch(error){return json({ok:false,error:"schedule_fetch_failed",detail:errorText(error)},503)}
}

async function teamHistory(env,tri){
  const seasons=previousSeasonIds(5);
  const out=[];
  try{
    for(const season of seasons){
      const reg=(await env.DB.prepare(`SELECT game_pk,home_tri,away_tri,home_score,away_score,period_type FROM games WHERE season_id=? AND game_type=2 AND UPPER(COALESCE(game_state,'')) IN ('FINAL','OFF');`).bind(season).all()).results||[];
      const po=(await env.DB.prepare(`SELECT game_pk,home_tri,away_tri,home_score,away_score FROM games WHERE season_id=? AND game_type=3 AND (home_tri=? OR away_tri=?) AND UPPER(COALESCE(game_state,'')) IN ('FINAL','OFF') ORDER BY game_pk;`).bind(season,tri,tri).all()).results||[];
      const table=aggregateRegular(reg);
      const row=table.find(x=>x.tri===tri)||{tri,gp:0,w:0,l:0,otl:0,pts:0,gf:0,ga:0};
      const ranked=[...table].sort((a,b)=>b.pts-a.pts||b.w-a.w||(b.gf-b.ga)-(a.gf-a.ga));
      const leagueRank=ranked.findIndex(x=>x.tri===tri)+1||null;
      const highest=po.reduce((m,g)=>Math.max(m,playoffRound(g.game_pk)||0),0);
      let result;
      if(highest){
        if(highest===4){const finalGames=po.filter(g=>playoffRound(g.game_pk)===4),wins=finalGames.filter(g=>winnerTri(g)===tri).length;result=wins>=4?"чемпион НХЛ":"финал Кубка Стэнли"}
        else if(highest===3) result="вылет в 1/2 финала";
        else if(highest===2) result="вылет во 2-м раунде";
        else result="вылет в 1-м раунде";
      }else result=leagueRank?`${leagueRank}-е место в регулярке`:"нет данных";
      out.push({season,season_label:seasonLabel(season),year:Number(String(season).slice(4,8)),result,league_rank:leagueRank,points:row.pts,playoff_round:highest||null});
    }
    return json({ok:true,team_tri:tri,seasons:out});
  }catch(error){return json({ok:false,error:"team_history_failed",detail:errorText(error)},503)}
}

async function teamStandings(request,env,tri){
  const season=normalizeSeason(new URL(request.url).searchParams.get("season"))||currentSeasonId();
  try{
    if(season===currentSeasonId()){
      const d=await fetchJson(`${NHL_WEB}/standings/now`).catch(()=>null);
      const rows=(d?.standings||[]);
      const valid=rows.length&&String(rows[0]?.seasonId||"")===season;
      if(valid){
        const target=rows.find(r=>upper(r?.teamAbbrev?.default||r?.teamAbbrev)===tri);
        const conf=localized(target?.conferenceName)||null;
        const data=rows.filter(r=>!conf||localized(r?.conferenceName)===conf).sort((a,b)=>Number(a.conferenceSequence||99)-Number(b.conferenceSequence||99)).map(r=>({tri:upper(r?.teamAbbrev?.default||r?.teamAbbrev),name:localized(r?.teamName)||localized(r?.teamCommonName)||upper(r?.teamAbbrev?.default||r?.teamAbbrev),gp:n(r.gamesPlayed),w:n(r.wins),l:n(r.losses),otl:n(r.otLosses),pts:n(r.points),conference_rank:n(r.conferenceSequence),division_rank:n(r.divisionSequence)}));
        return json({ok:true,season,conference:conf,rows:data});
      }
    }
    const reg=(await env.DB.prepare(`SELECT home_tri,away_tri,home_score,away_score,period_type FROM games WHERE season_id=? AND game_type=2 AND UPPER(COALESCE(game_state,'')) IN ('FINAL','OFF');`).bind(season).all()).results||[];
    const table=aggregateRegular(reg).sort((a,b)=>b.pts-a.pts||b.w-a.w||(b.gf-b.ga)-(a.gf-a.ga));
    return json({ok:true,season,conference:null,rows:table.map((x,i)=>({...x,league_rank:i+1}))});
  }catch(error){return json({ok:false,error:"standings_failed",detail:errorText(error)},503)}
}

async function playerAnalytics(request,env,playerId){
  if(!Number.isSafeInteger(playerId)||playerId<=0)return json({ok:false,error:"invalid_player_id"},400);
  const season=normalizeSeason(new URL(request.url).searchParams.get("season"))||currentSeasonId();
  try{
    const player=await env.DB.prepare(`SELECT player_id,current_team_tri,position_code FROM players WHERE player_id=? LIMIT 1;`).bind(playerId).first();
    if(!player)return json({ok:false,error:"player_not_found"},404);
    const goalie=String(player.position_code||"").toUpperCase()==="G";
    const report=goalie?"goalie/summary":"skater/summary";
    const exp=`seasonId=${season} and gameTypeId=2`;
    const url=`${NHL_STATS}/${report}?isAggregate=false&isGame=false&start=0&limit=-1&sort=${encodeURIComponent(goalie?'wins':'points')}&cayenneExp=${encodeURIComponent(exp)}`;
    const statsPayload=await fetchJson(url).catch(()=>({data:[]}));
    const rows=Array.isArray(statsPayload?.data)?statsPayload.data:[];
    const row=rows.find(x=>Number(x.playerId)===playerId)||null;
    const tri=upper(player.current_team_tri);
    const teamRows=rows.filter(x=>String(x.teamAbbrevs||x.teamAbbrev||"").toUpperCase().split(/[, ]+/).includes(tri));
    const metrics=goalie?["wins","savePct","goalsAgainstAverage","shutouts"]:["goals","assists","points","shots"];
    const ranks={};
    for(const metric of metrics){
      const value=n(row?.[metric]);
      if(value==null){ranks[metric]={league:null,team:null};continue}
      const asc=metric==="goalsAgainstAverage";
      ranks[metric]={league:1+rows.filter(x=>better(n(x?.[metric]),value,asc)).length,team:1+teamRows.filter(x=>better(n(x?.[metric]),value,asc)).length};
    }
    const log=await fetchJson(`${NHL_WEB}/player/${playerId}/game-log/${season}/2`).catch(()=>null);
    const games=(log?.gameLog||log?.games||[]).slice(0,10);
    const trends=buildPlayerTrends(games);
    return json({ok:true,season,player_id:playerId,position_code:player.position_code,stats:row,ranks,trends,sample:games.length});
  }catch(error){return json({ok:false,error:"player_analytics_failed",detail:errorText(error)},503)}
}

function buildPlayerTrends(games){
  const rows=Array.isArray(games)?games:[];if(!rows.length)return [];
  const nGames=rows.length;
  const candidates=[
    {code:"point",count:rows.filter(g=>Number(g.points??(Number(g.goals||0)+Number(g.assists||0)))>=1).length,text:c=>`${c} из ${nGames} последних матчей набрал минимум 1 очко`},
    {code:"goal",count:rows.filter(g=>Number(g.goals||0)>=1).length,text:c=>`${c} из ${nGames} последних матчей забил гол`},
    {code:"shots3",count:rows.filter(g=>Number(g.shots||g.shotsOnGoal||0)>=3).length,text:c=>`${c} из ${nGames} последних матчей нанёс минимум 3 броска`},
    {code:"pim2",count:rows.filter(g=>Number(g.pim||g.penaltyMinutes||0)>=2).length,text:c=>`${c} из ${nGames} последних матчей получил удаление`},
  ].sort((a,b)=>b.count-a.count);
  return candidates.filter(x=>x.count>0).slice(0,2).map(x=>({code:x.code,hits:x.count,sample:nGames,text:x.text(x.count)}));
}

function aggregateRegular(games){
  const map=new Map();const row=tri=>{if(!map.has(tri))map.set(tri,{tri,gp:0,w:0,l:0,otl:0,pts:0,gf:0,ga:0});return map.get(tri)};
  for(const g of games||[]){const h=row(g.home_tri),a=row(g.away_tri),hs=Number(g.home_score||0),as=Number(g.away_score||0);h.gp++;a.gp++;h.gf+=hs;h.ga+=as;a.gf+=as;a.ga+=hs;const homeWin=hs>as,w=homeWin?h:a,l=homeWin?a:h;w.w++;w.pts+=2;const ot=["OT","SO"].includes(upper(g.period_type));if(ot){l.otl++;l.pts++}else l.l++}
  return [...map.values()];
}
function winnerTri(g){return Number(g.home_score)>Number(g.away_score)?g.home_tri:g.away_tri}
function better(v,base,asc){if(v==null)return false;return asc?v<base:v>base}
function normalizeScheduleGame(g,season){const id=Number(g?.id),home=upper(g?.homeTeam?.abbrev),away=upper(g?.awayTeam?.abbrev),start=g?.startTimeUTC||g?.startTimeUtc;if(!Number.isSafeInteger(id)||!home||!away||!start)return null;return {game_pk:id,season_id:String(g?.season||season),game_type:Number(g?.gameType)||null,scheduled_start_utc:start,game_state:upper(g?.gameState||"FUT"),home_tri:home,away_tri:away,home_score:n(g?.homeTeam?.score),away_score:n(g?.awayTeam?.score),period_type:g?.periodDescriptor?.periodType||g?.gameOutcome?.lastPeriodType||null}}
function playoffRound(id){const n=Number(id);return Number.isSafeInteger(n)?Math.floor((n%10000)/1000)||null:null}
function playoffGameNo(id){const n=Number(id);return Number.isSafeInteger(n)?n%10||null:null}
function stageLabel(type,round){if(Number(type)!==3)return "Регулярный чемпионат";return round===4?"Финал Кубка Стэнли":round===3?"Финал конференции":round===2?"2-й раунд плей-офф":"1-й раунд плей-офф"}
function stageColor(type,round){if(Number(type)!==3)return "#4f9cff";return round===4?"#f5c451":round===3?"#d56dff":round===2?"#9e7bff":"#7b65ff"}
async function teamNameMap(db){const r=await db.prepare(`SELECT tri_code,name_en,name_ru FROM teams;`).all();return Object.fromEntries((r.results||[]).map(x=>[x.tri_code,x.name_ru||x.name_en||x.tri_code]))}
function previousSeasonIds(count){const cur=currentSeasonId(),start=Number(cur.slice(0,4));return Array.from({length:count},(_,i)=>String(start-1-i)+String(start-i))}
function currentSeasonId(){const d=new Date(),y=d.getUTCFullYear(),m=d.getUTCMonth()+1,start=m>=7?y:y-1;return `${start}${start+1}`}
function seasonLabel(s){const x=String(s||"");return x.length===8?`${x.slice(0,4)}/${x.slice(6,8)}`:x}
function normalizeSeason(v){const s=String(v||"").replace(/\D/g,"");return /^20\d{6}$/.test(s)?s:null}
function localized(v){if(!v)return null;if(typeof v==="string")return v;return v.default||v.ru||v.en||Object.values(v)[0]||null}
function upper(v){return String(v||"").trim().toUpperCase()}
function n(v){const x=Number(v);return Number.isFinite(x)?x:null}
function errorText(e){return String(e?.message||e||"unknown_error")}
async function fetchJson(url){const r=await fetch(url,{headers:{Accept:"application/json","User-Agent":"HOH-NHL-Center/6"}});if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.json()}
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}})}

const SCRIPT=String.raw`(function(){
'use strict';
const V2='/api/telegram-center-v2',V3='/api/telegram-center-v3',V6='/api/telegram-center-v6';
const tg=window.Telegram&&window.Telegram.WebApp?window.Telegram.WebApp:null,initData=tg&&tg.initData?tg.initData:'';
const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(u,o){o=o||{};const h=Object.assign({},o.headers||{});if(initData)h['X-Telegram-Init-Data']=initData;if(o.body)h['Content-Type']='application/json';const r=await fetch(u,Object.assign({},o,{headers:h,cache:'no-store'})),d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||('HTTP '+r.status));return d}
function currentSeason(){const d=new Date(),y=d.getUTCFullYear(),m=d.getUTCMonth()+1,s=m>=7?y:y-1;return ''+s+(s+1)}
function seasons(){const c=Number(currentSeason().slice(0,4));return Array.from({length:6},(_,i)=>{const s=c-i;return {season_id:''+s+(s+1),label:s+'/'+String(s+1).slice(-2)}})}
function css(){if(document.getElementById('centerV6Css'))return;const s=document.createElement('style');s.id='centerV6Css';s.textContent='.v6sheet{position:fixed;inset:0;z-index:12000;background:#09090b;overflow:auto;overscroll-behavior:contain;padding:8px 12px 30px}.v6card{max-width:720px;margin:auto}.v6top{display:flex;align-items:center;gap:9px;padding:2px 0 8px}.v6top b{font-size:8px;color:#61d8a2}.v6top span{flex:1;color:#8d8d98;font-size:10px}.v6close{border:1px solid #33343c;background:#17171a;color:#fff;border-radius:10px;padding:8px 11px}.v6hero{display:grid;grid-template-columns:78px 1fr auto;gap:12px;align-items:center;background:#121214;border:1px solid #2b2b31;border-radius:16px;padding:11px}.v6hero img{width:78px;height:78px;object-fit:contain;border-radius:14px;background:#18181b}.v6hero img.player{object-fit:cover;object-position:top}.v6hero h2{margin:0 0 2px;font-size:20px;line-height:1.05}.v6original{font-size:10px;color:#85858f}.v6meta{font-size:10px;color:#a4a4ad;margin-top:4px}.v6plus{width:44px;height:44px;border-radius:50%;border:1px solid #71422d;background:#26160f;color:#ff9367;font-size:24px;font-weight:900}.v6plus.on{border-color:#37644d;background:#102219;color:#7ee0ad}.v6season{width:100%;margin:9px 0;background:#151517;color:#fff;border:1px solid #303038;border-radius:10px;padding:9px}.v6tabs{display:grid;grid-template-columns:repeat(6,1fr);gap:4px;overflow:auto;margin:6px 0 10px}.v6tab{white-space:nowrap;border:1px solid #292930;background:#111113;color:#90909a;border-radius:9px;padding:8px 5px;font-size:9px}.v6tab.on{background:#2a2630;color:#fff;border-color:#443b50}.v6h{font-size:11px;color:#cdbdff;margin:14px 0 7px}.v6stats{display:grid;grid-template-columns:1fr 1fr;gap:7px}.v6stat{background:#141416;border:1px solid #2c2c32;border-radius:11px;padding:9px}.v6stat small{display:block;color:#8a8a94;font-size:8px}.v6stat b{font-size:16px}.v6rank{font-size:9px!important;color:#b9a8ff;margin-left:4px}.v6rank.gold{color:#e8bf5c!important}.v6mini{font-size:8px;color:#8c8c96;margin-top:3px}.v6game{display:grid;grid-template-columns:7px 1fr auto;gap:8px;align-items:center;background:#141416;border:1px solid #2c2c32;border-radius:11px;padding:9px;margin:6px 0;cursor:pointer}.v6game i{height:42px;border-radius:9px}.v6game strong{font-size:12px}.v6game small{display:block;color:#85858f;font-size:8px;margin-top:3px}.v6trend,.v6market,.v6hist,.v6row{background:#141416;border:1px solid #2c2c32;border-radius:10px;padding:9px;margin:6px 0}.v6trend b{font-size:11px}.v6market{display:flex;justify-content:space-between;gap:10px}.v6market b{color:#ff946c}.v6hist{display:flex;justify-content:space-between;gap:12px}.v6hist span:last-child{color:#bba8ff;text-align:right}.v6roster{display:grid;grid-template-columns:1fr 1fr;gap:6px}.v6person{display:flex;gap:8px;align-items:center;background:#141416;border:1px solid #2c2c32;border-radius:10px;padding:7px;cursor:pointer}.v6person img{width:40px;height:40px;object-fit:cover;object-position:top;border-radius:9px;background:#18181b}.v6empty{text-align:center;color:#85858f;padding:24px 8px}.v6audio{border:1px solid #34343c;background:#17171a;color:#fff;border-radius:8px;padding:5px 7px;font-size:11px}.v6audio[disabled]{opacity:.25}.v6flags{font-size:17px}.v6stand{display:grid;grid-template-columns:26px 1fr repeat(5,28px);gap:4px;align-items:center;padding:7px 4px;border-bottom:1px solid #222228;font-size:9px}.v6stand.me{background:#181323;border-radius:8px}.v6gamefull{position:fixed;inset:0;z-index:12100;background:#09090b;overflow:auto;padding:10px}.v6gamehead{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:10px;text-align:center;margin:16px 0}.v6gamehead img{width:70px;height:70px}.v6score{font-size:25px;font-weight:900}@media(max-width:390px){.v6tabs{grid-template-columns:repeat(6,82px)}.v6hero{grid-template-columns:68px 1fr auto}.v6hero img{width:68px;height:68px}.v6roster{grid-template-columns:1fr}.v6sheet{padding-left:9px;padding-right:9px}}';document.head.appendChild(s)}
function root(html){document.getElementById('v6sheet')?.remove();const d=document.createElement('div');d.id='v6sheet';d.className='v6sheet';d.innerHTML='<div class="v6card">'+html+'</div>';document.body.appendChild(d);return d}
function fmt(v){return v==null||v===''?'—':String(v)}
function seasonSel(selected){return '<select class="v6season" data-v6-season>'+seasons().map(s=>'<option value="'+s.season_id+'" '+(String(s.season_id)===String(selected)?'selected':'')+'>'+esc(s.label)+'</option>').join('')+'</select>'}
function rankHtml(rank){if(!rank)return '';return '<span class="v6rank '+(Number(rank)===1?'gold':'')+'">#'+esc(rank)+'</span>'}
function stat(label,value,extra){return '<div class="v6stat"><small>'+esc(label)+'</small><b>'+esc(fmt(value))+(extra||'')+'</b></div>'}
function gameRow(g){if(!g)return '';const final=['FINAL','OFF'].includes(String(g.game_state||'').toUpperCase()),label=g.stage_label_ru|| (Number(g.game_type)===3?'Плей-офф':'Регулярный чемпионат'),no=Number(g.game_type)===3?(g.playoff_game_no?'Матч №'+g.playoff_game_no:'Плей-офф'):(g.team_game_no?'Матч №'+g.team_game_no:'Регулярка');return '<div class="v6game" data-v6-game="'+esc(g.game_pk)+'"><i style="background:'+esc(g.stage_color||'#4f9cff')+'"></i><div><strong style="color:'+esc(g.stage_color||'#a9a9b5')+'">'+esc(label)+' · '+esc(no)+'</strong><div>'+esc(g.opponent_name||g.opponent_tri||'')+'</div><small>'+esc(new Date(g.scheduled_start_utc).toLocaleString('ru-RU',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}))+(g.is_home===true?' · дома':g.is_home===false?' · в гостях':'')+'</small></div><b>'+(final?esc(fmt(g.away_score)+' : '+fmt(g.home_score)):'›')+'</b></div>'}
function plus(sub,type,key){return '<button class="v6plus '+(sub?'on':'')+'" data-v2-subtype="'+esc(type)+'" data-v2-key="'+esc(key)+'" data-v2-subid="'+esc(sub?.subscription_id||'')+'" aria-label="Подписка">'+(sub?'✓':'+')+'</button>'}
function marketFirst(rows,label){if(!rows||!rows.length)return '<div class="v6empty">Линия Winline пока не загружена</div>';const m=rows[0];return '<div class="v6market"><span><small>'+esc(label||'Winline')+'</small><br>'+esc(m.outcome_name||m.market_type||'Рынок')+'</span><b>'+esc(fmt(m.odds))+'</b></div>'}
function tabBar(active){return '<div class="v6tabs">'+[['overview','Обзор'],['roster','Состав'],['stats','Статистика'],['schedule','Расписание'],['standings','Таблица'],['injuries','Травмы']].map(x=>'<button class="v6tab '+(active===x[0]?'on':'')+'" data-v6-tab="'+x[0]+'">'+x[1]+'</button>').join('')+'</div>'}
async function openTeam(tri,season){css();const selected=season||currentSeason(),r=root('<div class="v6top"><b>CENTER V6</b><span>Команда</span><button class="v6close" data-v6-close>×</button></div><div class="v6empty">Загрузка…</div>');try{const [v3,v2,sch,hist]=await Promise.all([api(V3+'/teams/'+tri+'?season='+selected).catch(()=>({})),api(V2+'/teams/'+tri),api(V6+'/teams/'+tri+'/schedule?season='+selected),api(V6+'/teams/'+tri+'/history')]);const team=v3.team||v2.team||{},schedule=sch.games||[],current=selected===currentSeason(),raw=v3.standings||{},stale=current&&String(raw.season_id||'')!==selected,s=stale?{}:raw,rank=stale?{}:(v3.league_ranks||{}),next=schedule.find(g=>!['FINAL','OFF'].includes(String(g.game_state||'').toUpperCase())&&Date.parse(g.scheduled_start_utc)>=Date.now()-3600000)||null;const state={tri,selected,v3,v2,team,s,rank,schedule,next,hist};renderTeam(r,state,'overview');r.querySelector('[data-v6-season]').onchange=e=>openTeam(tri,e.target.value)}catch(e){r.querySelector('.v6card').innerHTML='<div class="v6top"><b>CENTER V6</b><span>Команда</span><button class="v6close" data-v6-close>×</button></div><div class="v6empty">'+esc(e.message)+'</div>'}}
function renderTeam(r,x,active){const t=x.team,s=x.s,rank=x.rank,po=x.v3.playoff||{};r.querySelector('.v6card').innerHTML='<div class="v6top"><b>CENTER V6</b><span>'+esc(t.name_ru||t.name_en||x.tri)+'</span><button class="v6close" data-v6-close>×</button></div><div class="v6hero"><img src="'+esc(t.logo||t.logo_url||'')+'"><div><h2>'+esc(t.name_ru||t.name_en||x.tri)+'</h2><div class="v6meta">'+esc(x.tri)+' · сезон '+esc(x.selected.slice(0,4)+'/'+x.selected.slice(6,8))+'</div></div>'+plus(x.v2.subscription,'team',x.tri)+'</div>'+seasonSel(x.selected)+tabBar(active)+'<div data-v6-body></div>';const body=r.querySelector('[data-v6-body]');if(active==='overview'){body.innerHTML='<div class="v6h">Регулярный сезон '+esc(x.selected.slice(0,4)+'/'+x.selected.slice(6,8))+'</div><div class="v6stats">'+stat('В–П–ОТ',(s.wins??0)+'–'+(s.losses??0)+'–'+(s.ot_losses??0))+stat('Очки',s.points??0,'<span class="v6rank">див. #'+esc(fmt(s.division_sequence))+'</span>')+stat('Забито',s.goals_for??0,rankHtml(rank.gf_rank))+stat('Пропущено',s.goals_against??0,rankHtml(rank.ga_rank))+'</div><div class="v6h">Ближайший матч</div>'+(x.next?gameRow(x.next):'<div class="v6empty">Ближайший матч пока не найден</div>')+'<div class="v6h">Тенденции</div>'+((x.v2.trends||[]).slice(0,2).map(t=>'<div class="v6trend"><b>'+esc(t.text)+'</b><div class="v6mini">'+(t.market?'Winline · '+esc(fmt(t.market.odds)):'по последним матчам')+'</div></div>').join('')||'<div class="v6empty">Пока недостаточно матчей для тенденций</div>')+'<div class="v6h">Winline</div>'+marketFirst(x.v2.markets,'Основной рынок')+'<div class="v6h">Последние 5 сезонов</div>'+((x.hist.seasons||[]).map(h=>'<div class="v6hist"><b>'+esc(h.year)+'</b><span>'+esc(h.result)+'</span></div>').join('')||'<div class="v6empty">История пока не собрана</div>')}
if(active==='roster'){body.innerHTML='<div class="v6h">Состав</div><div class="v6roster">'+(x.v2.roster||[]).map(p=>'<div class="v6person" data-v6-player="'+p.player_id+'"><img src="'+esc(p.photo||'')+'"><div><b>'+esc(p.full_name_ru||p.full_name_en)+'</b><div class="v6mini">'+esc(p.position_code||'')+(p.sweater_number?' · #'+p.sweater_number:'')+'</div></div></div>').join('')+'</div>'}
if(active==='stats'){body.innerHTML='<div class="v6h">Статистика '+esc(x.selected.slice(0,4)+'/'+x.selected.slice(6,8))+'</div><div class="v6stats">'+stat('Матчи',s.games_played??0)+stat('В–П–ОТ',(s.wins??0)+'–'+(s.losses??0)+'–'+(s.ot_losses??0))+stat('Очки',s.points??0)+stat('Место в конференции',s.conference_sequence?('#'+s.conference_sequence):'—')+stat('Забито',s.goals_for??0,rankHtml(rank.gf_rank))+stat('Пропущено',s.goals_against??0,rankHtml(rank.ga_rank))+'</div><div class="v6h">Плей-офф</div><div class="v6row">'+esc(po.stage||'В этом сезоне данных плей-офф нет')+'</div>'}
if(active==='schedule'){const reg=x.schedule.filter(g=>Number(g.game_type)===2),play=x.schedule.filter(g=>Number(g.game_type)===3);body.innerHTML='<div class="v6h">Регулярный чемпионат</div>'+reg.map(gameRow).join('')+'<div class="v6h" style="color:#b88cff">Плей-офф</div>'+(play.length?play.map(gameRow).join(''):'<div class="v6empty">Матчей плей-офф нет</div>')}
if(active==='standings'){body.innerHTML='<div class="v6empty">Загрузка таблицы…</div>';api(V6+'/teams/'+x.tri+'/standings?season='+x.selected).then(d=>{body.innerHTML='<div class="v6h">Таблица</div>'+((d.rows||[]).map((q,i)=>'<div class="v6stand '+(q.tri===x.tri?'me':'')+'"><b>'+esc(q.conference_rank||q.league_rank||i+1)+'</b><span>'+esc(q.name||q.tri)+'</span><span>'+esc(fmt(q.gp))+'</span><span>'+esc(fmt(q.w))+'</span><span>'+esc(fmt(q.l))+'</span><span>'+esc(fmt(q.otl))+'</span><b>'+esc(fmt(q.pts))+'</b></div>').join('')||'<div class="v6empty">Таблица пока пустая</div>')}).catch(e=>body.innerHTML='<div class="v6empty">'+esc(e.message)+'</div>')}
if(active==='injuries'){body.innerHTML='<div class="v6empty">Загрузка…</div>';api(V6+'/teams/'+x.tri+'/injuries').then(d=>{body.innerHTML='<div class="v6h">Травмы</div>'+((d.items||[]).map(i=>'<div class="v6row">'+esc(i.name)+' · '+esc(i.status)+'</div>').join('')||'<div class="v6empty">'+esc(d.message||'Нет подтвержденных данных')+'</div>')}).catch(e=>body.innerHTML='<div class="v6empty">'+esc(e.message)+'</div>')}
r.querySelectorAll('[data-v6-tab]').forEach(b=>b.onclick=()=>renderTeam(r,x,b.dataset.v6Tab));r.querySelector('[data-v6-season]').onchange=e=>openTeam(x.tri,e.target.value)}
async function openPlayer(id,season){css();const selected=season||currentSeason(),r=root('<div class="v6top"><b>CENTER V6</b><span>Игрок</span><button class="v6close" data-v6-close>×</button></div><div class="v6empty">Загрузка…</div>');try{const [v3,v2,a]=await Promise.all([api(V3+'/players/'+id+'?season='+selected).catch(()=>({})),api(V2+'/players/'+id),api(V6+'/players/'+id+'/analytics?season='+selected)]);const p=v3.player||v2.player||{},stats=a.stats||{},ranks=a.ranks||{},ru=p.full_name_ru||'',name=ru||p.full_name_en||'Игрок',orig=ru&&p.full_name_en&&p.full_name_en!==ru?p.full_name_en:'';let offers=v2.markets||[],offerLabel='Персональная линия';if(!offers.length&&p.current_team_tri){const team=await api(V2+'/teams/'+p.current_team_tri).catch(()=>({}));offers=team.markets||[];offerLabel='Линия команды '+p.current_team_tri}const vals=String(p.position_code||'').toUpperCase()==='G'?[['Победы','wins'],['% сейвов','savePct'],['КН','goalsAgainstAverage'],['Сухие','shutouts']]:[['Голы','goals'],['Передачи','assists'],['Очки','points'],['Броски','shots']];r.querySelector('.v6card').innerHTML='<div class="v6top"><b>CENTER V6</b><span>Игрок</span><button class="v6close" data-v6-close>×</button></div><div class="v6hero"><img class="player" src="'+esc(p.photo||v2.player?.photo||'')+'"><div><h2>'+esc(name)+'</h2>'+(orig?'<div class="v6original">'+esc(orig)+'</div>':'')+'<div class="v6meta">'+esc(p.current_team_tri||'NHL')+' · '+esc(p.position_code||'')+(p.sweater_number?' · #'+p.sweater_number:'')+'</div><div class="v6flags">'+esc((p.flags||[]).join(' '))+' '+(p.pronunciation_url?'<button class="v6audio" data-v6-audio="'+esc(p.pronunciation_url)+'">🔊</button>':'<button class="v6audio" disabled>🔊</button>')+'</div></div>'+plus(v2.subscription,'player',id)+'</div>'+seasonSel(selected)+'<div class="v6h">Регулярный сезон '+esc(selected.slice(0,4)+'/'+selected.slice(6,8))+'</div><div class="v6stats">'+vals.map(v=>stat(v[0],stats[v[1]]??0,metricRanks(ranks[v[1]]))).join('')+'</div><div class="v6h">Последние тенденции</div>'+((a.trends||[]).slice(0,2).map(t=>'<div class="v6trend"><b>'+esc(t.text)+'</b><div class="v6mini">выборка '+esc(t.sample)+' матчей</div></div>').join('')||'<div class="v6empty">Текущий сезон ещё не дал выборку</div>')+'<div class="v6h">Winline</div>'+marketFirst(offers,offerLabel)+(v3.next_game?'<div class="v6h">Следующий матч</div>'+gameRow(v3.next_game):'');r.querySelector('[data-v6-season]').onchange=e=>openPlayer(id,e.target.value)}catch(e){r.querySelector('.v6card').innerHTML='<div class="v6top"><b>CENTER V6</b><span>Игрок</span><button class="v6close" data-v6-close>×</button></div><div class="v6empty">'+esc(e.message)+'</div>'}}
function metricRanks(r){if(!r)return '';let s='';if(r.team)s+='<span class="v6rank '+(r.team===1?'gold':'')+'">'+r.team+'-й в команде</span>';if(r.league)s+='<span class="v6rank '+(r.league===1?'gold':'')+'">#'+r.league+' НХЛ</span>';return s}
async function openGame(id){css();document.getElementById('v6gamefull')?.remove();const d=document.createElement('div');d.id='v6gamefull';d.className='v6gamefull';d.innerHTML='<div class="v6card"><div class="v6top"><b>CENTER V6</b><span>Матч</span><button class="v6close" data-v6-game-close>×</button></div><div class="v6empty">Загрузка…</div></div>';document.body.appendChild(d);try{const x=await api(V3+'/games/'+id),g=x.game||{};d.querySelector('.v6card').innerHTML='<div class="v6top"><b>CENTER V6</b><span>'+esc(g.stage_label_ru||'Матч НХЛ')+'</span><button class="v6close" data-v6-game-close>×</button></div><div class="v6meta">'+esc(new Date(g.scheduled_start_utc).toLocaleString('ru-RU'))+' · Game ID '+esc(g.game_pk)+'</div><div class="v6gamehead"><div><img src="'+esc(g.away_logo||'')+'"><div>'+esc(g.away_name||g.away_tri)+'</div></div><div class="v6score">'+esc(fmt(g.away_score)+' : '+fmt(g.home_score))+'</div><div><img src="'+esc(g.home_logo||'')+'"><div>'+esc(g.home_name||g.home_tri)+'</div></div></div><div class="v6h">Winline</div>'+marketFirst(x.markets||[],'Линия матча')+'<div class="v6h">Статистика матча</div><div class="v6row">Данные матча обновляются после каждого импорта Data Core.</div>'}catch(e){d.querySelector('.v6card').innerHTML='<button class="v6close" data-v6-game-close>×</button><div class="v6empty">'+esc(e.message)+'</div>'}}
function baseTarget(e){const t=e.target.closest('[data-v2-team]');if(t)return {type:'team',key:t.dataset.v2Team};const p=e.target.closest('[data-v2-player]');if(p)return {type:'player',key:p.dataset.v2Player};return null}
document.addEventListener('click',e=>{const target=baseTarget(e);if(target&&!e.target.closest('#v6sheet')){e.preventDefault();e.stopImmediatePropagation();target.type==='team'?openTeam(target.key):openPlayer(Number(target.key));return}const c=e.target.closest('[data-v6-close]');if(c){e.preventDefault();document.getElementById('v6sheet')?.remove();return}const gc=e.target.closest('[data-v6-game-close]');if(gc){e.preventDefault();document.getElementById('v6gamefull')?.remove();return}const g=e.target.closest('[data-v6-game]');if(g){e.preventDefault();e.stopPropagation();openGame(Number(g.dataset.v6Game));return}const p=e.target.closest('[data-v6-player]');if(p){e.preventDefault();openPlayer(Number(p.dataset.v6Player));return}const a=e.target.closest('[data-v6-audio]');if(a){e.preventDefault();try{new Audio(a.dataset.v6Audio).play()}catch(_){}}},true);
css();
})();`;
