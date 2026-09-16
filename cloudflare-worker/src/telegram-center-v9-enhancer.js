import fullNames from "../../ru_full_names.json" with { type: "json" };
import salaryCache from "../../player_salary_2026_27.json" with { type: "json" };

const NHL = "https://api-web.nhle.com/v1";
const API = "/api/telegram-center-v9";
const CSS_PATH = "/telegram-app/v9.css";
const JS_PATH = "/telegram-app/v9.js";
const YOUTUBE_HANDLE = "homeofhockey-yt";
const YOUTUBE_NEWS_FALLBACK = "mjDYO1uaw7E";

export async function handleTelegramCenterV9Enhancer(request, env, path) {
  if (path === CSS_PATH) {
    if (request.method !== "GET") return json({ok:false,error:"method_not_allowed"},405);
    return text(V9_CSS,"text/css; charset=utf-8","no-store");
  }
  if (path === JS_PATH) {
    if (request.method !== "GET") return json({ok:false,error:"method_not_allowed"},405);
    return text(V9_JS,"application/javascript; charset=utf-8","no-store");
  }

  // Shadow V7 data routes where V9 has stricter/correcter product behavior.
  if (path === "/api/telegram-center-v7/games" && request.method === "GET") return gamesForDate(request, env);
  if (path === "/api/telegram-center-v7/players" && request.method === "GET") return playersBySalary(request, env);
  if (path === `${API}/calendar` && request.method === "GET") return calendarForMonth(request, env);
  if (path === `${API}/ru-names` && request.method === "GET") return json({ok:true,names:fullNames||{}});
  if (path === `${API}/salaries` && request.method === "GET") return json({ok:true,season:salaryCache?.season||"2026-27",source:salaryCache?.source||"PuckPedia",players:salaryCache?.players||{}});
  if (path === `${API}/media` && request.method === "GET") return mediaConfig(env);
  return null;
}

async function gamesForDate(request, env) {
  const date = String(new URL(request.url).searchParams.get("date") || "").trim();
  if (!/^20\d\d-\d\d-\d\d$/.test(date)) return json({ok:false,error:"invalid_date"},400);
  try {
    const [payload,names] = await Promise.all([fetchJson(`${NHL}/schedule/${date}`), teamNameMap(env.DB)]);
    const games = scheduleRows(payload)
      .filter(x => x.date === date)
      .map(x => normalizeGame(x.game,names))
      .filter(Boolean)
      .sort((a,b)=>String(a.start_utc).localeCompare(String(b.start_utc)));
    return json({ok:true,date,games,source:"nhl_schedule_exact_date"});
  } catch (error) {
    return json({ok:false,error:"schedule_fetch_failed",detail:errorText(error)},503);
  }
}

async function playersBySalary(request, env) {
  if (!env.DB) return json({ok:false,error:"missing_d1_binding"},503);
  const u = new URL(request.url);
  const team = upper(u.searchParams.get("team") || "");
  const q = String(u.searchParams.get("q") || "").trim();
  const limit = clampInt(u.searchParams.get("limit"),160,1,250);
  const sort = String(u.searchParams.get("sort") || "salary").trim().toLowerCase();
  try {
    const r = await env.DB.prepare(`
      SELECT p.player_id,p.full_name_en,COALESCE(m.full_name_ru,p.full_name_ru) full_name_ru,
             p.current_team_tri,p.position_code,p.sweater_number,m.primary_country_code,m.birth_date,
             COALESCE(s.followers,0) follower_count
      FROM players p
      LEFT JOIN player_profile_meta m ON m.player_id=p.player_id
      LEFT JOIN (
        SELECT subject_key,COUNT(*) followers
        FROM subscriptions
        WHERE subject_type='player'
        GROUP BY subject_key
      ) s ON s.subject_key=CAST(p.player_id AS TEXT)
      WHERE COALESCE(p.active,1)=1
        AND (?='' OR p.current_team_tri=?)
        AND (?='' OR p.full_name_en LIKE '%'||?||'%' OR COALESCE(m.full_name_ru,p.full_name_ru,'') LIKE '%'||?||'%');
    `).bind(team,team,q,q,q).all();
    const season=currentSeasonId();
    const salaries=salaryCache?.players||{};
    const rows=(r.results||[]).map(p=>{
      const id=String(p.player_id),salary=salaries[id]||null;
      return {
        ...p,
        full_name_ru:p.full_name_ru||fullNames?.[id]||null,
        photo:playerPhoto(p.player_id,p.current_team_tri,season),
        salary_aav:Number(salary?.aav||salary?.cap_hit||0)||null,
        salary_cap_hit:Number(salary?.cap_hit||salary?.aav||0)||null,
        salary_source_url:salary?.source_url||null,
        follower_count:Number(p.follower_count||0),
      };
    });
    rows.sort((a,b)=>{
      if(sort==="followers") return b.follower_count-a.follower_count || (b.salary_aav||0)-(a.salary_aav||0) || playerName(a).localeCompare(playerName(b),"ru");
      return (b.salary_aav||0)-(a.salary_aav||0) || b.follower_count-a.follower_count || playerName(a).localeCompare(playerName(b),"ru");
    });
    return json({ok:true,season,sort,players:rows.slice(0,limit),salary_source:salaryCache?.source||"PuckPedia",salary_season:salaryCache?.season||"2026-27"});
  } catch (error) {
    return json({ok:false,error:"player_list_failed",detail:errorText(error)},503);
  }
}

async function calendarForMonth(request, env) {
  const month = String(new URL(request.url).searchParams.get("month") || "").trim();
  if (!/^20\d\d-(0[1-9]|1[0-2])$/.test(month)) return json({ok:false,error:"invalid_month"},400);
  const [year,mon] = month.split("-").map(Number);
  const days = new Date(Date.UTC(year,mon,0)).getUTCDate();
  const anchors = [];
  for (let day=1; day<=days; day+=7) anchors.push(`${month}-${String(day).padStart(2,"0")}`);
  try {
    const payloads = await Promise.all(anchors.map(d=>fetchJson(`${NHL}/schedule/${d}`).catch(()=>null)));
    const byId = new Map();
    for (const payload of payloads) {
      for (const row of scheduleRows(payload||{})) {
        if (!row.date?.startsWith(month)) continue;
        const id = Number(row.game?.id || row.game?.gameId || row.game?.gamePk);
        if (Number.isSafeInteger(id) && id > 0) byId.set(id,row);
      }
    }
    const counts = {};
    for (let day=1;day<=days;day++) counts[`${month}-${String(day).padStart(2,"0")}`]=0;
    for (const row of byId.values()) if (counts[row.date] !== undefined) counts[row.date]++;
    return json({ok:true,month,days,counts,total_games:[...byId.values()].length});
  } catch (error) {
    return json({ok:false,error:"calendar_fetch_failed",detail:errorText(error)},503);
  }
}

function scheduleRows(payload) {
  if (Array.isArray(payload?.gameWeek)) {
    return payload.gameWeek.flatMap(day => (day?.games || []).map(game => ({
      date: String(day?.date || game?.gameDate || dateFromStart(game?.startTimeUTC || game?.startTimeUtc) || ""),
      game,
    })));
  }
  if (Array.isArray(payload?.games)) {
    return payload.games.map(game => ({
      date: String(game?.gameDate || dateFromStart(game?.startTimeUTC || game?.startTimeUtc) || ""),
      game,
    }));
  }
  return [];
}

function normalizeGame(g,names){
  const id=Number(g?.id||g?.gameId||g?.gamePk),home=upper(g?.homeTeam?.abbrev),away=upper(g?.awayTeam?.abbrev),start=g?.startTimeUTC||g?.startTimeUtc;
  if(!Number.isSafeInteger(id)||id<=0||!home||!away||!start)return null;
  const type=Number(g?.gameType)||null;
  return {
    game_pk:id,game_type:type,start_utc:start,state:upper(g?.gameState||g?.gameStatus||"FUT"),
    home:{tri:home,name:names[home]||home,logo:teamLogo(home),score:num(g?.homeTeam?.score)},
    away:{tri:away,name:names[away]||away,logo:teamLogo(away),score:num(g?.awayTeam?.score)},
    stage_label:stageText(type),stage_color:stageColor(type),
  };
}

async function teamNameMap(db){
  if(!db)return{};
  try{const r=await db.prepare(`SELECT tri_code,name_en,name_ru FROM teams;`).all();return Object.fromEntries((r.results||[]).map(x=>[x.tri_code,x.name_ru||x.name_en||x.tri_code]));}catch{return{}}
}

async function mediaConfig(env){
  const configured=manualMedia(env);
  const fallbackNews={kind:"news",url:`https://www.youtube.com/watch?v=${YOUTUBE_NEWS_FALLBACK}`,title:"Свежий HOME OF HOCKEY NEWS",thumb:`https://i.ytimg.com/vi/${YOUTUBE_NEWS_FALLBACK}/hq720.jpg`};
  let news=null,shorts=[];
  try{
    const [videosHtml,shortsHtml]=await Promise.all([
      fetchYouTube(`https://www.youtube.com/@${YOUTUBE_HANDLE}/videos`),
      fetchYouTube(`https://www.youtube.com/@${YOUTUBE_HANDLE}/shorts?view=0&sort=p&flow=grid`),
    ]);
    const videos=parseYouTubeVideos(videosHtml);
    news=videos.find(x=>/\bnews\b/i.test(x.title))||videos[0]||null;
    const popular=parseYouTubeShorts(shortsHtml).slice(0,10);
    shorts=pickTwoPopularShorts(popular);
  }catch{}

  const items=[];
  if(shorts.length>=2)items.push(...shorts.slice(0,2));
  else items.push(...configured.filter(x=>x.kind==="short").slice(0,2));
  items.push(news||configured.find(x=>x.kind==="news")||fallbackNews);
  const normalized=items.filter(Boolean).map(x=>({
    kind:x.kind,
    url:String(x.url||"").trim(),
    title:String(x.title||defaultMediaTitle(x.kind)).trim(),
    thumb:String(x.thumb||youtubeThumb(x.url)||"").trim(),
  }));
  return json({ok:true,configured:normalized.length===3,items:normalized.slice(0,3),source:{news:news?"youtube_channel_live":"fallback",shorts:shorts.length>=2?"youtube_popular_top10":"configured_fallback"}});
}

function manualMedia(env){
  const raw=[
    {kind:"short",url:env.HOH_YOUTUBE_SHORT_1_URL,title:env.HOH_YOUTUBE_SHORT_1_TITLE,thumb:env.HOH_YOUTUBE_SHORT_1_THUMB},
    {kind:"short",url:env.HOH_YOUTUBE_SHORT_2_URL,title:env.HOH_YOUTUBE_SHORT_2_TITLE,thumb:env.HOH_YOUTUBE_SHORT_2_THUMB},
    {kind:"news",url:env.HOH_YOUTUBE_NEWS_URL,title:env.HOH_YOUTUBE_NEWS_TITLE,thumb:env.HOH_YOUTUBE_NEWS_THUMB},
  ];
  return raw.filter(x=>String(x.url||"").trim()).map(x=>({...x,url:String(x.url).trim()}));
}

async function fetchYouTube(url){
  const r=await fetch(url,{headers:{"User-Agent":"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1","Accept-Language":"ru-RU,ru;q=0.9,en;q=0.7"},cf:{cacheTtl:900,cacheEverything:true}});
  if(!r.ok)throw new Error(`YouTube HTTP ${r.status}`);
  return r.text();
}

function parseYouTubeVideos(html){
  const out=[],seen=new Set();
  const re=/"videoRenderer"\s*:\s*\{[\s\S]{0,500}?"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"[\s\S]{0,2500}?"title"\s*:\s*\{[\s\S]{0,500}?"text"\s*:\s*"((?:\\.|[^"\\])+)"/g;
  let m;while((m=re.exec(String(html||"")))){if(seen.has(m[1]))continue;seen.add(m[1]);out.push(mediaItem("news",m[1],decodeYouTubeText(m[2])))}
  return out;
}

function parseYouTubeShorts(html){
  const out=[],seen=new Set();
  const re=/"reelItemRenderer"\s*:\s*\{[\s\S]{0,500}?"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"[\s\S]{0,2200}?(?:"headline"|"title")\s*:\s*\{[\s\S]{0,500}?(?:"simpleText"|"text")\s*:\s*"((?:\\.|[^"\\])+)"/g;
  let m;while((m=re.exec(String(html||"")))){if(seen.has(m[1]))continue;seen.add(m[1]);out.push(mediaItem("short",m[1],decodeYouTubeText(m[2])))}
  if(out.length)return out;
  const idRe=/"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/g;
  while((m=idRe.exec(String(html||"")))&&out.length<10){if(seen.has(m[1]))continue;seen.add(m[1]);out.push(mediaItem("short",m[1],"Популярный ролик HOME OF HOCKEY"))}
  return out;
}

function pickTwoPopularShorts(top){
  if(!Array.isArray(top)||top.length<2)return [];
  const day=Math.floor(Date.now()/86400000),a=day%top.length,b=(day*7+3)%top.length;
  return [top[a],top[b===a?(b+1)%top.length:b]];
}
function mediaItem(kind,id,title){return{kind,url:`https://www.youtube.com/${kind==="short"?"shorts/":"watch?v="}${id}`,title:title||defaultMediaTitle(kind),thumb:`https://i.ytimg.com/vi/${id}/hq720.jpg`}}
function decodeYouTubeText(v){try{return JSON.parse(`"${String(v||"").replace(/"/g,'\\"')}"`).replace(/&amp;/g,"&")}catch{return String(v||"").replace(/\\u0026/g,"&").replace(/\\n/g," ")}}
function defaultMediaTitle(kind){return kind==="news"?"Свежий HOME OF HOCKEY NEWS":"Популярный ролик HOME OF HOCKEY"}
function youtubeThumb(url){const m=String(url||"").match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|shorts\/))([A-Za-z0-9_-]{6,})/);return m?`https://i.ytimg.com/vi/${m[1]}/hq720.jpg`:""}
function dateFromStart(value){if(!value)return"";const d=new Date(value);return Number.isNaN(d.getTime())?"":d.toISOString().slice(0,10)}
function stageText(type){return Number(type)===1?"Предсезонный матч":Number(type)===2?"Регулярный сезон":Number(type)===3?"Плей-офф":"Матч НХЛ"}
function stageColor(type){return Number(type)===1?"#ff9b35":Number(type)===2?"#5da6ff":Number(type)===3?"#bb8cff":"#9ba0ad"}
function teamLogo(tri){return tri?`https://assets.nhle.com/logos/nhl/svg/${tri}_light.svg`:null}
function playerPhoto(id,tri,season){return id&&tri?`https://assets.nhle.com/mugs/nhl/${season}/${tri}/${id}.png`:null}
function playerName(p){return String(p?.full_name_ru||p?.full_name_en||"")}
function currentSeasonId(){const d=new Date(),y=d.getUTCFullYear(),m=d.getUTCMonth()+1,start=m>=7?y:y-1;return `${start}${start+1}`}
function upper(v){return String(v||"").trim().toUpperCase()}
function num(v){if(v===null||v===undefined||v==="")return null;const x=Number(v);return Number.isFinite(x)?x:null}
function clampInt(v,fallback,min,max){const x=Number(v);return Number.isSafeInteger(x)&&x>=min&&x<=max?x:fallback}
function errorText(e){return String(e?.message||e||"unknown_error")}
async function fetchJson(url){const r=await fetch(url,{headers:{Accept:"application/json","User-Agent":"HOH-NHL-Center/9"}});if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.json()}
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}})}
function text(body,type,cache){return new Response(body,{headers:{"Content-Type":type,"Cache-Control":cache,"X-Content-Type-Options":"nosniff"}})}

const V9_CSS=String.raw`
:root{--v9-orange:#ff5a00;--v9-orange2:#ff7f2a;--v9-violet:#a96cff;--v9-violet2:#d3b1ff;--v9-ink:#07080d;--v9-panel:#10121a;--v9-panel2:#151823;--v9-line:#2a2e3b}
.app{max-width:560px!important;padding:14px 16px 104px!important;background:radial-gradient(90% 36% at -8% 0,#ff5a0019,transparent 62%),radial-gradient(82% 42% at 108% 12%,#9d62ff1c,transparent 64%),#07080d!important}
.brand{min-height:90px;padding:14px 2px 18px!important;gap:14px!important}.centerTitle{font-size:21px!important;letter-spacing:1.1px!important}.v8{padding:6px 11px!important;border-color:#6d508b!important;color:#d5b7ff!important;background:#a56cff0c}
.tabs{margin:16px 0 12px!important;border-radius:17px!important;padding:5px!important;gap:4px!important}.tab{min-height:45px;font-size:12px!important;letter-spacing:.15px}.tab.active{background:linear-gradient(135deg,#3a3045,#24202d)!important;border:1px solid #655074!important;box-shadow:0 0 22px #a56cff18!important}
.status{margin:0 2px 14px!important;font-size:10px!important}.view{gap:12px!important}.toolbar{gap:9px!important}.dateBox,.select,.search{height:48px!important;border-radius:14px!important;font-size:13px!important}.dateBox{display:flex;align-items:center;justify-content:center;font-size:16px!important;letter-spacing:.25px}.navBtn,.iconBtn,.calendarBtn{width:48px;height:48px;border-radius:14px;border:1px solid #303442;background:linear-gradient(180deg,#171923,#11131a);color:#fff;font-size:20px}
.gameCard,.teamRow,.playerRow,.myRow,.panel,.metric,.trend,.nextCard{border-color:#303441!important;background:linear-gradient(180deg,#141720,#0f1118)!important;box-shadow:inset 0 1px 0 #ffffff05}.gameCard{border-radius:20px!important;padding:15px!important;gap:12px!important;margin-bottom:10px}.gameTop{font-size:11px!important}.stage{font-size:10px!important}.teamMini{font-size:15px!important}.teamMini img{width:54px!important;height:54px!important;margin-bottom:8px!important}.score{font-size:25px!important}
.playerRow,.myRow,.teamRow{border-radius:18px!important;padding:12px 13px!important;min-height:74px}.playerRow img,.myRow img,.teamRow img{width:50px!important;height:50px!important;border-radius:13px!important}.rowText b{font-size:15px!important}.rowText small{font-size:10px!important;margin-top:3px;display:block}.myRow .rowText b{font-size:16px!important}.salaryLine{display:block;margin-top:4px;color:#ff8d50;font-size:10px;font-weight:900;letter-spacing:.1px}.salaryLine .salarySource{color:#8f93a7;font-weight:700}
.profileHead{padding:14px!important;border-radius:20px!important;gap:13px!important}.profileHead img{width:78px!important;height:78px!important}.profileInfo h1{font-size:22px!important;line-height:1.05!important}.profileInfo .original{font-size:10px!important}.profileInfo .meta{font-size:10px!important}.follow{width:52px!important;height:52px!important;font-size:29px!important}.followLabel{font-size:8px!important}.season{height:46px!important;border-radius:14px!important}.profileTabs{gap:7px!important}.profileTabs button{padding:10px 12px!important;border-radius:11px!important}
.metrics{grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:9px!important}.metric{min-height:104px!important;height:auto!important;padding:12px 13px!important;border-radius:17px!important;display:grid!important;grid-template-columns:1fr auto!important;grid-template-rows:auto auto 7px auto!important;column-gap:8px!important;align-items:start!important}.metric .label{grid-column:1;grid-row:1;font-size:10px!important;margin:0!important;color:#b3b6c3!important;font-weight:800}.metric .value{grid-column:2;grid-row:1/3;align-self:center;justify-self:end;font-size:25px!important;margin:0!important;line-height:1!important}.metric .bar{grid-column:1/-1;grid-row:3;height:7px!important;margin:8px 0 5px!important}.metric .rankTxt{grid-column:1/-1;grid-row:4;font-size:9px!important;line-height:1.25!important;min-height:12px;color:#a6a9b7!important}.metricEmoji{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:7px;margin-right:6px;background:linear-gradient(135deg,#ff5a002b,#a56cff2b);font-size:13px;vertical-align:middle}
.trend{border-radius:16px!important;min-height:60px!important}.trendIcon{background:linear-gradient(135deg,#ff5a0030,#9b61ff30)!important}.winline{border-radius:20px!important;padding:14px!important;border-color:#8b4627!important;box-shadow:0 0 28px #ff5a001c,0 0 30px #9b61ff10!important}.markets{gap:8px!important}.market{border-radius:13px!important;padding:10px!important}.market .odds{font-size:22px!important}
.mediaShelf{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin:2px 0 4px}.mediaCard{position:relative;overflow:hidden;border-radius:17px;border:1px solid #303441;background:#11131b;text-decoration:none;color:white;min-height:168px;box-shadow:inset 0 1px 0 #ffffff07}.mediaCard.news{grid-column:1/-1;min-height:118px}.mediaCard img{width:100%;height:100%;position:absolute;inset:0;object-fit:cover;opacity:.68}.mediaCard:after{content:'';position:absolute;inset:0;background:linear-gradient(180deg,transparent 26%,#07080de8 100%)}.mediaMeta{position:absolute;left:12px;right:12px;bottom:11px;z-index:2}.mediaType{font-size:8px;text-transform:uppercase;letter-spacing:1px;color:#ff9259;font-weight:950}.mediaTitle{font-size:12px;line-height:1.15;font-weight:950;margin-top:4px;text-shadow:0 2px 8px #000}.mediaCard.news .mediaTitle{font-size:14px}.mediaPlay{position:absolute;right:10px;top:10px;z-index:2;width:30px;height:30px;border-radius:50%;display:grid;place-items:center;background:#090a0dcc;border:1px solid #ffffff2b;font-size:12px}
.monthModal{position:fixed;inset:0;z-index:10020;background:#03040ae8;display:flex;align-items:flex-end;padding:14px}.monthCard{width:min(520px,100%);margin:auto;background:#0d0f16;border:1px solid #343846;border-radius:22px;padding:15px;box-shadow:0 20px 70px #000c}.monthHead{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}.monthHead b{font-size:18px}.monthClose{width:38px;height:38px;border-radius:11px;border:1px solid #343846;background:#161922;color:white}.weekdayGrid,.dayGrid{display:grid;grid-template-columns:repeat(7,1fr);gap:6px}.weekdayGrid{margin-bottom:6px}.weekday{font-size:8px;text-align:center;color:#777d91;text-transform:uppercase}.dayCell{min-height:54px;border:1px solid #292d39;background:#12151d;border-radius:11px;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px}.dayCell.out{opacity:.25}.dayCell.today{border-color:#a36be0;box-shadow:0 0 0 1px #a36be040}.dayCell.has{background:linear-gradient(145deg,#1e1512,#171223);border-color:#5a3c3f}.dayNum{font-weight:900;font-size:12px}.dayCount{font-size:8px;color:#c8a7ff}.dayCell.has .dayCount{color:#ff8a49}.calendarHint{font-size:9px;color:#8e93a5;margin-top:10px;text-align:center}
@media(max-width:390px){.app{padding-left:12px!important;padding-right:12px!important}.brand{min-height:82px}.centerTitle{font-size:18px!important}.metric{min-height:100px!important}.metric .value{font-size:23px!important}.mediaCard{min-height:150px}.mediaCard.news{min-height:105px}}
`;

const V9_JS=String.raw`(function(){
'use strict';
const V9='/api/telegram-center-v9';
let ruNames=null,salaries=null,mediaLoaded=false,calendarBusy=false;
const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function getJson(url){const r=await fetch(url,{cache:'no-store'});if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}
function metricEmoji(label){const s=String(label||'').toLowerCase();if(s.includes('гол'))return'🥅';if(s.includes('передач'))return'🎯';if(s.includes('очк'))return'⭐';if(s.includes('брос'))return'🏒';if(s.includes('в–п')||s.includes('в-п'))return'🏆';if(s.includes('забито'))return'⚡';if(s.includes('пропущ'))return'🛡️';if(s.includes('побед'))return'🏆';return'📊'}
function decorateMetrics(){document.querySelectorAll('.metric .label').forEach(el=>{if(el.querySelector('.metricEmoji'))return;const icon=document.createElement('span');icon.className='metricEmoji';icon.textContent=metricEmoji(el.textContent);el.prepend(icon)})}
async function loadRuNames(){if(ruNames)return ruNames;try{const d=await getJson(V9+'/ru-names');ruNames=d.names||{}}catch{ruNames={}}return ruNames}
async function loadSalaries(){if(salaries)return salaries;try{const d=await getJson(V9+'/salaries');salaries=d.players||{}}catch{salaries={}}return salaries}
async function localizeVisiblePlayers(){const map=await loadRuNames();document.querySelectorAll('[data-player]').forEach(row=>{const id=String(row.dataset.player||'');const name=map[id];if(!name)return;const b=row.querySelector('.rowText b');if(!b||b.dataset.ruDone)return;const original=(b.textContent||'').replace(/^\s*[A-Z]{2}\s+/,'').trim();b.innerHTML='<span class="orangeText" style="font-size:10px">RU</span> '+esc(name)+(original&&!original.includes(name)?' <span style="color:#85899b;font-size:10px;font-weight:600">('+esc(original)+')</span>':'');b.dataset.ruDone='1'})}
async function decoratePlayerSalaries(){const map=await loadSalaries();document.querySelectorAll('.playerRow[data-player]').forEach(row=>{if(row.querySelector('.salaryLine'))return;const id=String(row.dataset.player||''),s=map[id],box=row.querySelector('.rowText');if(!s||!box)return;const value=Number(s.aav||s.cap_hit||0);if(!value)return;const line=document.createElement('span');line.className='salaryLine';line.textContent='💰 '+money(value)+' / год';box.appendChild(line)})}
function money(v){v=Number(v||0);if(v>=1000000)return'$'+(v/1000000).toLocaleString('ru-RU',{maximumFractionDigits:2})+' млн';if(v>=1000)return'$'+Math.round(v/1000)+' тыс.';return'$'+Math.round(v)}
async function fixMineNames(){const map=await loadRuNames();document.querySelectorAll('.myRow[data-type="player"]').forEach(row=>{const id=String(row.dataset.key||'');const b=row.querySelector('.rowText b');if(!b||!map[id])return;if(/^\d+$/.test((b.textContent||'').trim())||!b.dataset.ruDone){b.textContent=map[id];b.dataset.ruDone='1'}})}
function currentTab(){return document.querySelector('.tab.active')?.dataset.tab||''}
function installCalendarButton(){if(currentTab()!=='games'||document.querySelector('.calendarBtn'))return;const bar=document.querySelector('#view>.toolbar');if(!bar||!bar.querySelector('.dateBox'))return;const btn=document.createElement('button');btn.className='calendarBtn';btn.type='button';btn.title='Календарь месяца';btn.textContent='▦';bar.appendChild(btn);btn.onclick=openMonthCalendar}
async function openMonthCalendar(){if(calendarBusy)return;calendarBusy=true;try{const date=(document.querySelector('#view .dateBox')?.textContent||new Date().toISOString().slice(0,10)).trim();const month=date.slice(0,7);const d=await getJson(V9+'/calendar?month='+month);const first=new Date(month+'-01T12:00:00');const shift=(first.getDay()+6)%7;const cells=[];for(let i=0;i<shift;i++)cells.push('<div></div>');const today=new Date();const todayKey=[today.getFullYear(),String(today.getMonth()+1).padStart(2,'0'),String(today.getDate()).padStart(2,'0')].join('-');for(let day=1;day<=d.days;day++){const key=month+'-'+String(day).padStart(2,'0'),count=Number(d.counts?.[key]||0);cells.push('<button class="dayCell '+(count?'has ':'')+(key===todayKey?'today':'')+'" data-day="'+key+'"><span class="dayNum">'+day+'</span><span class="dayCount">'+(count?count+' матч.':'—')+'</span></button>')}const wrap=document.createElement('div');wrap.className='monthModal';wrap.id='monthModal';wrap.innerHTML='<div class="monthCard"><div class="monthHead"><b>'+month+'</b><button class="monthClose">×</button></div><div class="weekdayGrid">'+['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(x=>'<div class="weekday">'+x+'</div>').join('')+'</div><div class="dayGrid">'+cells.join('')+'</div><div class="calendarHint">Число под датой — количество матчей НХЛ в этот день</div></div>';document.body.appendChild(wrap);wrap.querySelector('.monthClose').onclick=()=>wrap.remove();wrap.querySelectorAll('[data-day]').forEach(b=>b.onclick=async()=>{const target=b.dataset.day;wrap.remove();await jumpToDate(target)})}catch(e){alert('Календарь: '+(e.message||e))}finally{calendarBusy=false}}
async function jumpToDate(target){let guard=0;while(guard++<40){const box=document.querySelector('#view .dateBox');if(!box)return;const cur=(box.textContent||'').trim();if(cur===target)return;const dir=cur<target?'next':'prev';const btn=document.getElementById(dir);if(!btn)return;btn.click();let n=0;while(n++<30){await wait(80);const now=(document.querySelector('#view .dateBox')?.textContent||'').trim();if(now!==cur)break}}}
async function injectMedia(){if(mediaLoaded||currentTab()!=='games')return;const view=document.getElementById('view');if(!view||view.querySelector('.mediaShelf'))return;try{const d=await getJson(V9+'/media');if(!d.configured||!Array.isArray(d.items)||d.items.length<3)return;mediaLoaded=true;const shelf=document.createElement('section');shelf.className='mediaShelf';shelf.innerHTML=d.items.slice(0,3).map(x=>'<a class="mediaCard '+(x.kind==='news'?'news':'')+'" href="'+esc(x.url)+'" target="_blank" rel="noopener"><img src="'+esc(x.thumb||'')+'" alt=""><span class="mediaPlay">▶</span><div class="mediaMeta"><div class="mediaType">'+(x.kind==='news'?'HOH NEWS':'SHORTS')+'</div><div class="mediaTitle">'+esc(x.title)+'</div></div></a>').join('');const toolbar=view.querySelector('.toolbar');if(toolbar)view.insertBefore(shelf,toolbar);else view.prepend(shelf)}catch{}}
function run(){decorateMetrics();installCalendarButton();localizeVisiblePlayers();decoratePlayerSalaries();fixMineNames();injectMedia()}
let timer=null;const obs=new MutationObserver(()=>{clearTimeout(timer);timer=setTimeout(run,35)});obs.observe(document.documentElement,{subtree:true,childList:true});
document.addEventListener('click',()=>setTimeout(run,80),true);run();
})();`;
