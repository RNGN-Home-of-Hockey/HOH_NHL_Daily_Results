const NHL = "https://api-web.nhle.com/v1";
const LIVE = new Set(["LIVE","CRIT","INTERMISSION"]);
const FINAL = new Set(["FINAL","OFF"]);

export async function getCenterNotificationStatus(env){
  if(!env.DB)return {ok:false,error:"missing_d1_binding"};
  try{
    const row=await env.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM telegram_users WHERE notifications_enabled=1) users,
        (SELECT COUNT(*) FROM subscriptions) subscriptions,
        (SELECT COUNT(*) FROM subscriptions WHERE subject_type='group') group_subscriptions,
        (SELECT COUNT(*) FROM notification_log WHERE sent_at>=datetime('now','-24 hours')) sent_24h,
        (SELECT MAX(sent_at) FROM notification_log) last_sent_at;
    `).first();
    return {ok:true,engine:"center-v2",enabled:envFlag(env.TELEGRAM_LIVE_NOTIFICATIONS_ENABLED,false),center_token_configured:Boolean(String(env.TELEGRAM_CENTER_BOT_TOKEN||"").trim()),...row};
  }catch(error){return {ok:false,error:"center_notification_status_failed",detail:errorText(error)}}
}

export async function runCenterNotificationTick(env,{dryRun=true,now=null}={}){
  if(!env.DB)return {ok:false,error:"missing_d1_binding"};
  if(!dryRun&&!String(env.TELEGRAM_CENTER_BOT_TOKEN||"").trim())return {ok:false,error:"missing_telegram_center_token"};
  const clock=now?new Date(now):new Date();if(!Number.isFinite(clock.getTime()))return {ok:false,error:"invalid_now"};
  const subscriptions=await loadSubscriptions(env.DB);
  if(!subscriptions.length)return {ok:true,dry_run:dryRun,subscriptions:0,relevant_games:0,planned:0,sent:0,skipped_limit:0,skipped_duplicate:0,failed:0,events:[]};
  const context=await buildSubjectContext(env.DB,subscriptions);
  const userPrefs=await loadUserNotificationPreferences(env.DB,subscriptions);
  const games=await loadSchedule(clock);
  const relevant=games.filter(g=>subscriptions.some(s=>touches(s,g,context)));
  const summary={ok:true,dry_run:dryRun,subscriptions:subscriptions.length,schedule_games:games.length,relevant_games:relevant.length,planned:0,sent:0,daily_digests:0,player_reports:0,game_reminders:0,timezone_missing:0,skipped_limit:0,skipped_duplicate:0,failed:0,events:[]};
  await processDailyPlayerDigests(env,games,subscriptions,context,userPrefs,clock,dryRun,summary);
  for(const game of relevant){try{await processGame(env,game,subscriptions,context,userPrefs,clock,dryRun,summary)}catch(error){summary.failed++;summary.events.push({game_pk:game.game_pk,error:errorText(error)})}}
  summary.ok=summary.failed===0;return summary;
}

async function processGame(env,game,subs,ctx,userPrefs,now,dryRun,summary){
  const state=upper(game.state),relevant=subs.filter(s=>touches(s,game,ctx));if(!relevant.length)return;
  const start=Date.parse(game.start_utc||""),mins=Number.isFinite(start)?(start-now.getTime())/60000:null;

  // First-wave product: a reminder explicitly requested for this exact game.
  if(!LIVE.has(state)&&!FINAL.has(state)&&mins!==null&&mins>=10&&mins<=16){
    await dispatch(env,game,relevant,ctx,{key:`center:reminder15:${game.game_pk}`,type:"reminder_15m",flag:"notify_pregame",scope:"game",text:`⏰ Матч скоро начнётся\n${game.away.tri} — ${game.home.tri}\nДо старта около 15 минут.`},dryRun,summary);
  }

  const eventStream=envFlag(env.TELEGRAM_CENTER_EVENT_STREAM_ENABLED,false);
  if(eventStream){
    const pre=envInt(env.TELEGRAM_PREGAME_MINUTES,45,5,180);
    if(!LIVE.has(state)&&!FINAL.has(state)&&mins!==null&&mins>=0&&mins<=pre)await dispatch(env,game,relevant,ctx,{key:`center:pregame:${game.game_pk}`,type:"pregame",flag:"notify_pregame",scope:"non_game",text:`🏒 Скоро матч НХЛ\n${game.away.tri} — ${game.home.tri}\nДо начала ≈ ${Math.max(1,Math.round(mins/5)*5)} мин.`},dryRun,summary);
    if(LIVE.has(state))await dispatch(env,game,relevant,ctx,{key:`center:start:${game.game_pk}`,type:"start",flag:"notify_start",text:`▶️ Матч начался\n${game.away.tri} — ${game.home.tri}`},dryRun,summary);
    if(LIVE.has(state)||FINAL.has(state))await processLivePlays(env,game,relevant,ctx,state,dryRun,summary);
    if(FINAL.has(state))await dispatch(env,game,relevant,ctx,{key:`center:final:${game.game_pk}`,type:"final",flag:"notify_final",scope:"non_player",text:`✅ Матч завершён\n${game.away.tri} ${score(game.away.score)}:${score(game.home.score)} ${game.home.tri}`},dryRun,summary);
  }

  if(FINAL.has(state))await processPlayerPostgameReports(env,game,relevant,ctx,userPrefs,dryRun,summary);
}
async function processLivePlays(env,game,relevant,ctx,state,dryRun,summary){
  const pbp=await fetchJson(`${NHL}/gamecenter/${game.game_pk}/play-by-play`).catch(()=>null);if(!pbp)return;
  const plays=Array.isArray(pbp.plays)?[...pbp.plays].sort((a,b)=>sortOrder(a)-sortOrder(b)):[],max=plays.reduce((m,p)=>Math.max(m,sortOrder(p)),0);
  let cursor=null;try{cursor=await env.DB.prepare(`SELECT last_sort_order FROM live_notification_cursors WHERE game_pk=? LIMIT 1;`).bind(game.game_pk).first()}catch{}
  if(!cursor){if(!dryRun)await env.DB.prepare(`INSERT OR IGNORE INTO live_notification_cursors (game_pk,last_sort_order,last_game_state,last_period,updated_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP);`).bind(game.game_pk,max,state,currentPeriod(pbp)).run().catch(()=>{});return}
  const roster=rosterMap(pbp),teamIds=teamIdMap(game,pbp),after=Number(cursor.last_sort_order||0);let failures=0;
  for(const play of plays.filter(p=>sortOrder(p)>after)){const e=eventFromPlay(game,play,roster,teamIds);if(!e)continue;const before=summary.failed;await dispatch(env,game,relevant,ctx,e,dryRun,summary);failures+=summary.failed-before}
  if(!dryRun&&max>after&&!failures)await env.DB.prepare(`UPDATE live_notification_cursors SET last_sort_order=?,last_game_state=?,last_period=?,updated_at=CURRENT_TIMESTAMP WHERE game_pk=?;`).bind(max,state,currentPeriod(pbp),game.game_pk).run().catch(()=>{});
}

async function dispatch(env,game,relevant,ctx,event,dryRun,summary){
  const byUser=new Map();for(const s of relevant){if(!matches(s,game,event,ctx))continue;if(!byUser.has(s.telegram_user_id))byUser.set(s.telegram_user_id,[]);byUser.get(s.telegram_user_id).push(s)}
  for(const [userId,matchesList] of byUser){summary.planned++;const cap=Math.max(1,Math.min(...matchesList.map(s=>Number(s.max_pushes_per_day)||12)));if(!dryRun&&await sentToday(env.DB,userId)>=cap){summary.skipped_limit++;continue}if(dryRun){summary.events.push({game_pk:game.game_pk,user_id:userId,type:event.type,text:event.text,subscriptions:matchesList.map(minSub),cap});if(event.type==="reminder_15m")summary.game_reminders++;continue}const payload=JSON.stringify({engine:"center-v2",game_pk:game.game_pk,type:event.type,subscriptions:matchesList.map(minSub)});if(!(await reserve(env.DB,event.key,userId,event.type,game.game_pk,payload))){summary.skipped_duplicate++;continue}try{await sendCenter(env,userId,event.text);summary.sent++;if(event.type==="reminder_15m")summary.game_reminders++}catch(error){summary.failed++;await env.DB.prepare(`DELETE FROM notification_log WHERE notification_key=? AND telegram_user_id=?;`).bind(event.key,userId).run().catch(()=>{});summary.events.push({game_pk:game.game_pk,user_id:userId,type:event.type,error:errorText(error)})}}
}

function matches(s,game,event,ctx){
  if(!truthy(s[event.flag]))return false;
  const type=String(s.subject_type||""),key=String(s.subject_key||"");
  if(event.scope==="game"&&type!=="game")return false;
  if(event.scope==="non_game"&&type==="game")return false;
  if(event.scope==="non_player"&&type==="player")return false;
  if(event.type==="goal"){
    if(type==="game")return key===String(game.game_pk);
    if(type==="team")return upper(key)===event.scoring_team_tri;
    if(type==="player")return String(event.scorer_id||"")===key||(truthy(s.notify_assist)&&(event.assist_ids||[]).map(String).includes(key));
    if(type==="group"){const set=ctx.groupPlayers.get(key)||new Set();return set.has(String(event.scorer_id||""))||(truthy(s.notify_assist)&&(event.assist_ids||[]).some(id=>set.has(String(id))))}
  }
  return touches(s,game,ctx);
}

function touches(s,game,ctx){const type=String(s.subject_type||""),key=String(s.subject_key||"");if(type==="game")return key===String(game.game_pk);if(type==="team")return inGame(upper(key),game);if(type==="player"){const tri=ctx.playerTeams.get(key);return Boolean(tri&&inGame(tri,game))}if(type==="group"){for(const id of ctx.groupPlayers.get(key)||[]){const tri=ctx.playerTeams.get(String(id));if(tri&&inGame(tri,game))return true}}return false}

async function loadSubscriptions(db){
  try{const r=await db.prepare(`
    SELECT s.subscription_id,s.telegram_user_id,s.subject_type,s.subject_key,
      COALESCE(p.notify_pregame,s.notify_pregame) notify_pregame,
      COALESCE(p.notify_start,s.notify_start) notify_start,
      COALESCE(p.notify_goal,s.notify_goal) notify_goal,
      COALESCE(p.notify_assist,s.notify_assist) notify_assist,
      COALESCE(p.notify_point,0) notify_point,
      COALESCE(p.notify_period_end,s.notify_period_end) notify_period_end,
      COALESCE(p.notify_final,s.notify_final) notify_final,
      COALESCE(p.max_pushes_per_day,12) max_pushes_per_day
    FROM subscriptions s JOIN telegram_users u ON u.telegram_user_id=s.telegram_user_id
    LEFT JOIN subscription_preferences p ON p.subscription_id=s.subscription_id
    WHERE u.notifications_enabled=1 ORDER BY s.telegram_user_id,s.subscription_id;
  `).all();return r.results||[]}catch{const r=await db.prepare(`SELECT s.*,12 max_pushes_per_day FROM subscriptions s JOIN telegram_users u ON u.telegram_user_id=s.telegram_user_id WHERE u.notifications_enabled=1 ORDER BY s.telegram_user_id,s.subscription_id;`).all();return r.results||[]}
}

async function buildSubjectContext(db,subs){
  const direct=[...new Set(subs.filter(s=>s.subject_type==="player").map(s=>String(s.subject_key)).filter(x=>/^\d+$/.test(x)))],groups=[...new Set(subs.filter(s=>s.subject_type==="group").map(s=>String(s.subject_key)))],groupPlayers=new Map();
  if(groups.length){const q=groups.map(()=>"?").join(","),r=await db.prepare(`SELECT group_key,subject_key FROM subscription_group_members WHERE subject_type='player' AND group_key IN (${q});`).bind(...groups).all().catch(()=>({results:[]}));for(const x of r.results||[]){if(!groupPlayers.has(x.group_key))groupPlayers.set(x.group_key,new Set());groupPlayers.get(x.group_key).add(String(x.subject_key));direct.push(String(x.subject_key))}}
  const ids=[...new Set(direct)].filter(x=>/^\d+$/.test(x)),playerTeams=new Map(),playerMeta=new Map();
  if(ids.length){const q=ids.map(()=>"?").join(","),r=await db.prepare(`SELECT player_id,current_team_tri,full_name_en,full_name_ru,COALESCE(active,1) active,position_code FROM players WHERE player_id IN (${q});`).bind(...ids.map(Number)).all();for(const x of r.results||[]){if(x.current_team_tri)playerTeams.set(String(x.player_id),upper(x.current_team_tri));playerMeta.set(String(x.player_id),{player_id:Number(x.player_id),team_tri:upper(x.current_team_tri),name:x.full_name_ru||x.full_name_en||`NHL ${x.player_id}`,active:Number(x.active)!==0,position_code:upper(x.position_code)})}}
  return {playerTeams,groupPlayers,playerMeta}
}

async function loadUserNotificationPreferences(db,subs){
  const ids=[...new Set((subs||[]).map(s=>Number(s.telegram_user_id)).filter(Number.isSafeInteger))];
  const map=new Map();
  if(!ids.length)return map;
  const q=ids.map(()=>"?").join(",");
  let rows=[];
  try{const r=await db.prepare(`
    SELECT u.telegram_user_id,n.timezone_name,COALESCE(n.daily_player_digest,1) daily_player_digest,
           COALESCE(n.daily_digest_hour,20) daily_digest_hour,COALESCE(n.player_postgame_reports,1) player_postgame_reports
    FROM telegram_users u
    LEFT JOIN notification_user_preferences n ON n.telegram_user_id=u.telegram_user_id
    WHERE u.telegram_user_id IN (${q});
  `).bind(...ids).all();rows=r.results||[]}catch{}
  for(const id of ids)map.set(id,{timezone_name:null,daily_player_digest:1,daily_digest_hour:20,player_postgame_reports:1});
  for(const r of rows)map.set(Number(r.telegram_user_id),{timezone_name:r.timezone_name||null,daily_player_digest:Number(r.daily_player_digest??1),daily_digest_hour:Number(r.daily_digest_hour??20),player_postgame_reports:Number(r.player_postgame_reports??1)});
  return map;
}

async function processDailyPlayerDigests(env,games,subs,ctx,userPrefs,now,dryRun,summary){
  const byUser=new Map();
  for(const s of subs){if(s.subject_type!=="player")continue;const uid=Number(s.telegram_user_id);if(!byUser.has(uid))byUser.set(uid,[]);byUser.get(uid).push(s)}
  for(const [userId,playerSubs] of byUser){
    const pref=userPrefs.get(userId)||{};if(Number(pref.daily_player_digest??1)!==1)continue;
    const tz=String(pref.timezone_name||"").trim();if(!tz){summary.timezone_missing++;continue}
    const parts=localParts(now,tz);if(!parts)continue;
    const hour=Number(pref.daily_digest_hour??20),bucket=Math.abs(Number(userId))%5;
    if(parts.hour!==hour||parts.minute!==bucket)continue;
    const localDate=parts.date,key=`center:daily-players:${localDate}`;
    const lines=[];
    for(const sub of playerSubs){
      const id=String(sub.subject_key),meta=ctx.playerMeta.get(id),tri=ctx.playerTeams.get(id);if(!tri||!meta)continue;
      const game=(games||[]).find(g=>inGame(tri,g)&&isDigestWindowGame(g,now,tz,hour));if(!game)continue;
      const opponent=game.home.tri===tri?game.away.tri:game.home.tri,at=formatLocalTime(game.start_utc,tz);
      const status=meta.active?"": " · ⚠️ вне активного состава";
      lines.push(`• ${meta.name} — ${tri} vs ${opponent} · ${at}${status}`);
    }
    if(!lines.length)continue;
    const text=`🏒 Сегодня / этой ночью играют ваши игроки\n\n${lines.join("\n")}\n\nОткройте матч в Live Center, чтобы включить напоминание за 15 минут.`;
    summary.planned++;
    if(dryRun){summary.daily_digests++;summary.events.push({user_id:userId,type:"daily_player_digest",local_date:localDate,timezone:tz,players:lines.length,text});continue}
    if(!(await reserve(env.DB,key,userId,"daily_player_digest",null,JSON.stringify({timezone:tz,local_date:localDate,players:lines.length})))){summary.skipped_duplicate++;continue}
    try{await sendCenter(env,userId,text);summary.sent++;summary.daily_digests++}catch(error){summary.failed++;await env.DB.prepare(`DELETE FROM notification_log WHERE notification_key=? AND telegram_user_id=?;`).bind(key,userId).run().catch(()=>{});summary.events.push({user_id:userId,type:"daily_player_digest",error:errorText(error)})}
  }
}

function isDigestWindowGame(game,now,tz,hour){
  if(FINAL.has(upper(game.state)))return false;
  const start=Date.parse(String(game.start_utc||""));if(!Number.isFinite(start))return false;
  // The 20:00 digest is for the coming NHL night, not just the strict calendar day.
  return start>=now.getTime()-2*60*60*1000&&start<=now.getTime()+18*60*60*1000;
}
function localParts(date,tz){try{const p=new Intl.DateTimeFormat("en-CA",{timeZone:tz,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(date),m=Object.fromEntries(p.map(x=>[x.type,x.value]));return{date:`${m.year}-${m.month}-${m.day}`,hour:Number(m.hour),minute:Number(m.minute)}}catch{return null}}
function formatLocalTime(value,tz){const d=new Date(value);if(!Number.isFinite(d.getTime()))return"—";try{return new Intl.DateTimeFormat("ru-RU",{timeZone:tz,hour:"2-digit",minute:"2-digit"}).format(d)}catch{return d.toISOString().slice(11,16)}}

async function processPlayerPostgameReports(env,game,relevant,ctx,userPrefs,dryRun,summary){
  const byUser=new Map();
  for(const s of relevant){if(s.subject_type!=="player"||!truthy(s.notify_final))continue;const uid=Number(s.telegram_user_id),pref=userPrefs.get(uid)||{};if(Number(pref.player_postgame_reports??1)!==1)continue;if(!byUser.has(uid))byUser.set(uid,[]);byUser.get(uid).push(s)}
  if(!byUser.size)return;
  const box=await fetchJson(`${NHL}/gamecenter/${game.game_pk}/boxscore`).catch(()=>null),stats=box?boxscorePlayerMap(box):new Map();
  if(!stats.size)return; // NHL may mark FINAL a little before the complete player boxscore is ready; retry next minute.
  for(const [userId,list] of byUser){
    const lines=[];
    for(const sub of list){const id=String(sub.subject_key),meta=ctx.playerMeta.get(id);if(!meta)continue;const row=stats.get(id);lines.push(formatPlayerReportLine(meta,row))}
    if(!lines.length)continue;
    const key=`center:player-report:${game.game_pk}`,text=`📊 Матч завершён: статистика ваших игроков\n${game.away.tri} ${score(game.away.score)}:${score(game.home.score)} ${game.home.tri}\n\n${lines.join("\n")}`;
    summary.planned++;
    if(dryRun){summary.player_reports++;summary.events.push({game_pk:game.game_pk,user_id:userId,type:"player_postgame_report",players:lines.length,text});continue}
    if(!(await reserve(env.DB,key,userId,"player_postgame_report",game.game_pk,JSON.stringify({players:lines.length})))){summary.skipped_duplicate++;continue}
    try{await sendCenter(env,userId,text);summary.sent++;summary.player_reports++}catch(error){summary.failed++;await env.DB.prepare(`DELETE FROM notification_log WHERE notification_key=? AND telegram_user_id=?;`).bind(key,userId).run().catch(()=>{});summary.events.push({game_pk:game.game_pk,user_id:userId,type:"player_postgame_report",error:errorText(error)})}
  }
}
function boxscorePlayerMap(box){const out=new Map(),root=box?.playerByGameStats||box?.playerByGameStats?.playerByGameStats||{};for(const side of ["awayTeam","homeTeam"]){const team=root?.[side]||{};for(const section of ["forwards","defense","defensemen","goalies"]){for(const p of team?.[section]||[]){const id=positive(p.playerId||p.id);if(id)out.set(String(id),{...p,__goalie:section==="goalies"})}}}return out}
function formatPlayerReportLine(meta,row){
  if(!row)return `• ${meta.name} — не выходил на лёд`;
  if(row.__goalie){const saves=finite(row.saves),against=finite(row.shotsAgainst),ga=finite(row.goalsAgainst),pct=finite(row.savePctg??row.savePercentage);return `• ${meta.name} — ${saves??"—"} сейвов из ${against??"—"} · ${pct==null?"—":(pct<=1?(pct*100).toFixed(1):pct.toFixed(1))}% · пропущено ${ga??"—"}`}
  const g=finite(row.goals)??0,a=finite(row.assists)??0,p=finite(row.points)??g+a,shots=finite(row.sog??row.shots),hits=finite(row.hits),blocks=finite(row.blockedShots??row.blocked),pm=finite(row.plusMinus),toi=String(row.toi||row.timeOnIce||"—");
  const extras=[shots==null?null:`${shots} брос.`,hits==null?null:`${hits} хитов`,blocks==null?null:`${blocks} блоков`,pm==null?null:`+/- ${pm>0?"+":""}${pm}`,toi&&toi!=="—"?`TOI ${toi}`:null].filter(Boolean).join(" · ");
  return `• ${meta.name} — ${g}+${a}=${p}${extras?" · "+extras:""}`
}

async function loadSchedule(now){const dates=[-1,0,1].map(o=>{const d=new Date(now);d.setUTCDate(d.getUTCDate()+o);return d.toISOString().slice(0,10)}),payloads=await Promise.all(dates.map(d=>fetchJson(`${NHL}/schedule/${d}`).catch(()=>null))),map=new Map();for(let i=0;i<payloads.length;i++)for(const g of normalizeSchedule(payloads[i],dates[i]))map.set(g.game_pk,g);return [...map.values()].sort((a,b)=>String(a.start_utc).localeCompare(String(b.start_utc)))}
function normalizeSchedule(d,date){if(!d)return[];let games=Array.isArray(d.games)?d.games:[];if(!games.length&&Array.isArray(d.gameWeek))games=d.gameWeek.flatMap(x=>x.games||[]);return games.filter(g=>!g.gameDate||String(g.gameDate)===date).map(g=>({game_pk:Number(g.id||g.gameId||g.gamePk),start_utc:g.startTimeUTC||null,state:upper(g.gameState||g.gameStatus),home:{id:positive(g.homeTeam?.id),tri:upper(g.homeTeam?.abbrev),score:finite(g.homeTeam?.score)},away:{id:positive(g.awayTeam?.id),tri:upper(g.awayTeam?.abbrev),score:finite(g.awayTeam?.score)}})).filter(g=>Number.isSafeInteger(g.game_pk)&&g.game_pk>0&&g.home.tri&&g.away.tri)}
function eventFromPlay(game,p,roster,teamIds){const type=String(p?.typeDescKey||"").toLowerCase(),sort=sortOrder(p);if(!sort)return null;if(type==="goal"){const d=p.details||{},scorer=positive(d.scoringPlayerId),assists=[positive(d.assist1PlayerId),positive(d.assist2PlayerId)].filter(Boolean),tri=teamIds.get(Number(d.eventOwnerTeamId))||"",name=roster.get(scorer)||`NHL ${scorer||""}`;return {key:`center:goal:${game.game_pk}:${sort}`,type:"goal",flag:"notify_goal",scoring_team_tri:tri,scorer_id:scorer,assist_ids:assists,text:`🚨 ГОЛ ${tri||"NHL"}\n${game.away.tri} ${score(d.awayScore??game.away.score)}:${score(d.homeScore??game.home.score)} ${game.home.tri}\n${name}`}}if(type==="period-end"){const period=positive(p?.periodDescriptor?.number)||0;return {key:`center:period:${game.game_pk}:${period||sort}`,type:"period_end",flag:"notify_period_end",text:`⏸ Конец ${period||"—"}-го периода\n${game.away.tri} ${score(game.away.score)}:${score(game.home.score)} ${game.home.tri}`}}return null}
function rosterMap(pbp){const m=new Map();for(const p of pbp?.rosterSpots||[]){const id=positive(p.playerId);if(id)m.set(id,[localized(p.firstName),localized(p.lastName)].filter(Boolean).join(" ")||`NHL ${id}`)}return m}
function teamIdMap(game,pbp){const m=new Map();if(game.home.id)m.set(game.home.id,game.home.tri);if(game.away.id)m.set(game.away.id,game.away.tri);const h=positive(pbp?.homeTeam?.id),a=positive(pbp?.awayTeam?.id);if(h)m.set(h,game.home.tri);if(a)m.set(a,game.away.tri);return m}
async function sentToday(db,user){const r=await db.prepare(`SELECT COUNT(*) count FROM notification_log WHERE telegram_user_id=? AND sent_at>=datetime('now','-24 hours');`).bind(user).first();return Number(r?.count||0)}
async function reserve(db,key,user,type,game,payload){const r=await db.prepare(`INSERT OR IGNORE INTO notification_log (notification_key,telegram_user_id,notification_type,subject_type,subject_key,game_pk,payload_json) VALUES (?,?,?,?,?,?,?);`).bind(key,user,type,"game",String(game),game,payload).run();return Number(r?.meta?.changes??r?.changes??0)>0}
async function sendCenter(env,user,text){const token=String(env.TELEGRAM_CENTER_BOT_TOKEN||"").trim();if(!token)throw new Error("missing_telegram_center_token");const r=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:user,text,disable_web_page_preview:true})}),d=await r.json().catch(()=>({}));if(!r.ok||!d.ok)throw new Error(d.description||`Telegram ${r.status}`)}
async function fetchJson(url){const r=await fetch(url,{headers:{Accept:"application/json"}});if(!r.ok)throw new Error(`NHL HTTP ${r.status}`);return r.json()}
function minSub(s){return {subscription_id:s.subscription_id,subject_type:s.subject_type,subject_key:s.subject_key}}
function inGame(t,g){return t===g.home.tri||t===g.away.tri}
function sortOrder(p){return positive(p?.sortOrder)||positive(p?.eventId)||0}
function currentPeriod(p){return positive(p?.periodDescriptor?.number)||positive(p?.plays?.at?.(-1)?.periodDescriptor?.number)||null}
function localized(v){if(!v)return"";if(typeof v==="string")return v;return v.default||v.en||Object.values(v)[0]||""}
function positive(v){const n=Number(v);return Number.isSafeInteger(n)&&n>0?n:null}
function finite(v){const n=Number(v);return Number.isFinite(n)?n:null}
function score(v){return v==null?"—":String(v)}
function truthy(v){return v===true||Number(v)===1}
function upper(v){return String(v||"").trim().toUpperCase()}
function envFlag(v,f=false){if(v==null||v==="")return f;return ["1","true","yes","on"].includes(String(v).trim().toLowerCase())}
function envInt(v,f,min,max){const n=Number(v);return Number.isSafeInteger(n)&&n>=min&&n<=max?n:f}
function errorText(e){return String(e?.message||e||"unknown_error")}
