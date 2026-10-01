const NHL = "https://api-web.nhle.com/v1";
const ESPN_INJURIES = "https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/injuries";
const LIVE = new Set(["LIVE","CRIT","INTERMISSION"]);
const FINAL = new Set(["FINAL","OFF"]);
const DELIVERY_SHARDS = 5;
const MAX_SENDS_PER_TICK = 30;
const DEFAULT_NOTIFICATION_TIMEZONE = "Europe/Moscow";
const DIGEST_CATCHUP_HOURS = 4;

export async function getCenterNotificationStatus(env){
  if(!env.DB)return {ok:false,error:"missing_d1_binding"};
  try{
    const row=await env.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM telegram_users WHERE notifications_enabled=1) users,
        (SELECT COUNT(*) FROM subscriptions) subscriptions,
        (SELECT COUNT(*) FROM subscriptions WHERE subject_type='player') player_subscriptions,
        (SELECT COUNT(*) FROM subscriptions WHERE subject_type='game' AND notify_pregame=1) game_reminders,
        (SELECT COUNT(*) FROM subscriptions WHERE subject_type='group') group_subscriptions,
        (SELECT COUNT(*) FROM notification_user_preferences WHERE timezone_name IS NOT NULL AND TRIM(timezone_name)<>'') timezone_users,
        (SELECT COUNT(DISTINCT s.telegram_user_id)
           FROM subscriptions s
           LEFT JOIN notification_user_preferences n ON n.telegram_user_id=s.telegram_user_id
          WHERE s.subject_type='player' AND (n.timezone_name IS NULL OR TRIM(n.timezone_name)='')) timezone_fallback_users,
        (SELECT COUNT(*) FROM notification_log WHERE sent_at>=datetime('now','-24 hours')) sent_24h,
        (SELECT COUNT(*) FROM notification_log WHERE notification_type='daily_player_digest' AND sent_at>=datetime('now','-24 hours')) digests_24h,
        (SELECT COUNT(*) FROM notification_log WHERE notification_type='player_postgame_report' AND sent_at>=datetime('now','-24 hours')) player_reports_24h,
        (SELECT COUNT(*) FROM notification_log WHERE notification_type='reminder_15m' AND sent_at>=datetime('now','-24 hours')) reminders_24h,
        (SELECT MAX(sent_at) FROM notification_log) last_sent_at;
    `).first();
    return {ok:true,engine:"center-v2",enabled:envFlag(env.TELEGRAM_LIVE_NOTIFICATIONS_ENABLED,false),center_token_configured:Boolean(String(env.TELEGRAM_CENTER_BOT_TOKEN||"").trim()),delivery_shards:DELIVERY_SHARDS,max_sends_per_tick:MAX_SENDS_PER_TICK,default_timezone:DEFAULT_NOTIFICATION_TIMEZONE,digest_catchup_hours:DIGEST_CATCHUP_HOURS,...row};
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
  const summary={ok:true,dry_run:dryRun,subscriptions:subscriptions.length,schedule_games:games.length,relevant_games:relevant.length,delivery_shards:DELIVERY_SHARDS,max_sends_per_tick:MAX_SENDS_PER_TICK,planned:0,sent:0,daily_digests:0,player_reports:0,game_reminders:0,injury_feed_records:0,timezone_missing:0,timezone_fallback:0,deferred_budget:0,skipped_limit:0,skipped_duplicate:0,failed:0,events:[]};
  Object.defineProperty(summary,"_delivery",{value:{used:0,sentToday:dryRun?new Map():await loadSentTodayCounts(env.DB)},enumerable:false});
  const active=relevant.filter(g=>!FINAL.has(upper(g.state))),finals=relevant.filter(g=>FINAL.has(upper(g.state)));
  for(const game of active){try{await processGame(env,game,subscriptions,context,userPrefs,clock,dryRun,summary)}catch(error){summary.failed++;summary.events.push({game_pk:game.game_pk,error:errorText(error)})}}
  for(const game of finals){try{await processGame(env,game,subscriptions,context,userPrefs,clock,dryRun,summary)}catch(error){summary.failed++;summary.events.push({game_pk:game.game_pk,error:errorText(error)})}}
  await processDailyPlayerDigests(env,games,subscriptions,context,userPrefs,clock,dryRun,summary);
  summary.ok=summary.failed===0;return summary;
}

async function processGame(env,game,subs,ctx,userPrefs,now,dryRun,summary){
  const state=upper(game.state),relevant=subs.filter(s=>touches(s,game,ctx));if(!relevant.length)return;
  const start=Date.parse(game.start_utc||""),mins=Number.isFinite(start)?(start-now.getTime())/60000:null;

  // First-wave product: a reminder explicitly requested for this exact game.
  if(!LIVE.has(state)&&!FINAL.has(state)&&mins!==null&&mins>=10&&mins<=17){
    await dispatch(env,game,relevant,ctx,{key:`center:reminder15:${game.game_pk}`,type:"reminder_15m",flag:"notify_pregame",scope:"game",sharded:true,now,text:`⏰ Матч скоро начнётся\n${game.away.tri} — ${game.home.tri}\nДо старта около 15 минут.`},dryRun,summary);
  }

  const eventStream=envFlag(env.TELEGRAM_CENTER_EVENT_STREAM_ENABLED,false);
  if(eventStream){
    const pre=envInt(env.TELEGRAM_PREGAME_MINUTES,45,5,180);
    if(!LIVE.has(state)&&!FINAL.has(state)&&mins!==null&&mins>=0&&mins<=pre)await dispatch(env,game,relevant,ctx,{key:`center:pregame:${game.game_pk}`,type:"pregame",flag:"notify_pregame",scope:"non_game",text:`🏒 Скоро матч НХЛ\n${game.away.tri} — ${game.home.tri}\nДо начала ≈ ${Math.max(1,Math.round(mins/5)*5)} мин.`},dryRun,summary);
    if(LIVE.has(state))await dispatch(env,game,relevant,ctx,{key:`center:start:${game.game_pk}`,type:"start",flag:"notify_start",text:`▶️ Матч начался\n${game.away.tri} — ${game.home.tri}`},dryRun,summary);
    if(LIVE.has(state)||FINAL.has(state))await processLivePlays(env,game,relevant,ctx,state,dryRun,summary);
    if(FINAL.has(state))await dispatch(env,game,relevant,ctx,{key:`center:final:${game.game_pk}`,type:"final",flag:"notify_final",scope:"non_player",text:`✅ Матч завершён\n${game.away.tri} ${score(game.away.score)}:${score(game.home.score)} ${game.home.tri}`},dryRun,summary);
  }

  if(FINAL.has(state))await processPlayerPostgameReports(env,game,relevant,ctx,userPrefs,now,dryRun,summary);
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
  for(const [userId,matchesList] of byUser){
    if(event.sharded&&!inDeliveryShard(userId,event.now||new Date()))continue;
    summary.planned++;
    const cap=Math.max(1,Math.min(...matchesList.map(s=>Number(s.max_pushes_per_day)||12)));
    if(!dryRun&&!canSendNow(summary,userId,cap)){continue}
    if(dryRun){summary.events.push({game_pk:game.game_pk,user_id:userId,type:event.type,text:event.text,subscriptions:matchesList.map(minSub),cap});if(event.type==="reminder_15m")summary.game_reminders++;continue}
    const payload=JSON.stringify({engine:"center-v2",game_pk:game.game_pk,type:event.type,subscriptions:matchesList.map(minSub)});
    if(!(await reserve(env.DB,event.key,userId,event.type,game.game_pk,payload))){summary.skipped_duplicate++;continue}
    try{await sendCenter(env,userId,event.text);markSent(summary,userId);summary.sent++;if(event.type==="reminder_15m")summary.game_reminders++}
    catch(error){summary.failed++;await env.DB.prepare(`DELETE FROM notification_log WHERE notification_key=? AND telegram_user_id=?;`).bind(event.key,userId).run().catch(()=>{});summary.events.push({game_pk:game.game_pk,user_id:userId,type:event.type,error:errorText(error)})}
  }
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
  for(const groupChunk of chunks(groups,90)){
    if(!groupChunk.length)continue;
    const q=groupChunk.map(()=>"?").join(","),r=await db.prepare(`SELECT group_key,subject_key FROM subscription_group_members WHERE subject_type='player' AND group_key IN (${q});`).bind(...groupChunk).all().catch(()=>({results:[]}));
    for(const x of r.results||[]){if(!groupPlayers.has(x.group_key))groupPlayers.set(x.group_key,new Set());groupPlayers.get(x.group_key).add(String(x.subject_key));direct.push(String(x.subject_key))}
  }
  const ids=[...new Set(direct)].filter(x=>/^\d+$/.test(x)),playerTeams=new Map(),playerMeta=new Map();
  for(const idChunk of chunks(ids,90)){
    if(!idChunk.length)continue;
    const q=idChunk.map(()=>"?").join(","),r=await db.prepare(`SELECT player_id,current_team_tri,full_name_en,full_name_ru,COALESCE(active,1) active,position_code FROM players WHERE player_id IN (${q});`).bind(...idChunk.map(Number)).all();
    for(const x of r.results||[]){if(x.current_team_tri)playerTeams.set(String(x.player_id),upper(x.current_team_tri));playerMeta.set(String(x.player_id),{player_id:Number(x.player_id),team_tri:upper(x.current_team_tri),name:x.full_name_ru||x.full_name_en||`NHL ${x.player_id}`,full_name_en:x.full_name_en||null,active:Number(x.active)!==0,position_code:upper(x.position_code)})}
  }
  return {playerTeams,groupPlayers,playerMeta}
}

async function loadUserNotificationPreferences(db,subs){
  const ids=[...new Set((subs||[]).map(s=>Number(s.telegram_user_id)).filter(Number.isSafeInteger))];
  const map=new Map();
  if(!ids.length)return map;
  for(const id of ids)map.set(id,{timezone_name:null,daily_player_digest:1,daily_digest_hour:20,player_postgame_reports:1});
  for(const idChunk of chunks(ids,90)){
    const q=idChunk.map(()=>"?").join(",");
    try{
      const r=await db.prepare(`
        SELECT u.telegram_user_id,n.timezone_name,COALESCE(n.daily_player_digest,1) daily_player_digest,
               COALESCE(n.daily_digest_hour,20) daily_digest_hour,COALESCE(n.player_postgame_reports,1) player_postgame_reports
        FROM telegram_users u
        LEFT JOIN notification_user_preferences n ON n.telegram_user_id=u.telegram_user_id
        WHERE u.telegram_user_id IN (${q});
      `).bind(...idChunk).all();
      for(const row of r.results||[])map.set(Number(row.telegram_user_id),{timezone_name:row.timezone_name||null,daily_player_digest:Number(row.daily_player_digest??1),daily_digest_hour:Number(row.daily_digest_hour??20),player_postgame_reports:Number(row.player_postgame_reports??1)});
    }catch{}
  }
  return map;
}

async function processDailyPlayerDigests(env,games,subs,ctx,userPrefs,now,dryRun,summary){
  const byUser=new Map();
  for(const s of subs){if(s.subject_type!=="player")continue;const uid=Number(s.telegram_user_id);if(!byUser.has(uid))byUser.set(uid,[]);byUser.get(uid).push(s)}
  const due=[];
  for(const [userId,playerSubs] of byUser){
    const pref=userPrefs.get(userId)||{};if(Number(pref.daily_player_digest??1)!==1)continue;
    const storedTz=String(pref.timezone_name||"").trim(),tz=storedTz||DEFAULT_NOTIFICATION_TIMEZONE;
    if(!storedTz){summary.timezone_missing++;summary.timezone_fallback++}
    const parts=localParts(now,tz);if(!parts)continue;
    const hour=Number(pref.daily_digest_hour??20);
    const lastHour=Math.min(23,hour+DIGEST_CATCHUP_HOURS-1);
    if(parts.hour<hour||parts.hour>lastHour||(parts.minute%DELIVERY_SHARDS)!==deliveryShard(userId))continue;
    due.push({userId,playerSubs,tz,parts,timezoneFallback:!storedTz});
  }
  if(!due.length)return;
  const injuries=await loadEspnInjuries().catch(()=>new Map());
  summary.injury_feed_records=injuries.size;
  for(const {userId,playerSubs,tz,parts,timezoneFallback} of due){
    const localDate=parts.date,key=`center:daily-players:${localDate}`;
    const lines=[],digestGames=new Map();
    for(const sub of playerSubs){
      const id=String(sub.subject_key),meta=ctx.playerMeta.get(id),tri=ctx.playerTeams.get(id);if(!tri||!meta)continue;
      const game=(games||[]).find(g=>inGame(tri,g)&&isDigestWindowGame(g,now));if(!game)continue;
      const opponent=game.home.tri===tri?game.away.tri:game.home.tri,at=formatLocalTime(game.start_utc,tz);
      const injury=findInjury(meta,injuries);
      const status=injury?formatInjuryStatus(injury):(meta.active?"":" · ⚠️ вне активного состава");
      lines.push(`• ${meta.name} — ${tri} vs ${opponent} · ${at}${status}`);
      digestGames.set(Number(game.game_pk),{game_pk:Number(game.game_pk),away:game.away.tri,home:game.home.tri,at});
    }
    if(!lines.length)continue;
    const digestGameList=[...digestGames.values()];
    const enabledReminders=await loadDigestReminderSet(env.DB,userId,digestGameList.map(x=>x.game_pk));
    const replyMarkup=digestReminderKeyboard(digestGameList,enabledReminders);
    const timezoneNote=timezoneFallback?"\n\n🕗 Часовой пояс ещё не сохранён — временно используем московское время. Откройте Live Center, и дальше время будет локальным.":"";
    const text=`🏒 Сегодня / этой ночью играют ваши игроки\n\n${lines.join("\n")}\n\nВыберите ниже, за какие матчи напомнить за 15 минут.${timezoneNote}`;
    summary.planned++;
    if(dryRun){summary.daily_digests++;summary.events.push({user_id:userId,type:"daily_player_digest",local_date:localDate,timezone:tz,timezone_fallback:Boolean(timezoneFallback),players:lines.length,games:digestGameList.length,text,reply_markup:replyMarkup});continue}
    const cap=Math.max(1,Math.min(...playerSubs.map(x=>Number(x.max_pushes_per_day)||12)));
    if(!canSendNow(summary,userId,cap))continue;
    if(!(await reserve(env.DB,key,userId,"daily_player_digest",null,JSON.stringify({timezone:tz,local_date:localDate,players:lines.length})))){summary.skipped_duplicate++;continue}
    try{await sendCenter(env,userId,text,{reply_markup:replyMarkup});markSent(summary,userId);summary.sent++;summary.daily_digests++}
    catch(error){summary.failed++;await env.DB.prepare(`DELETE FROM notification_log WHERE notification_key=? AND telegram_user_id=?;`).bind(key,userId).run().catch(()=>{});summary.events.push({user_id:userId,type:"daily_player_digest",error:errorText(error)})}
  }
}

async function loadDigestReminderSet(db,userId,gamePks){
  const ids=[...new Set((gamePks||[]).map(Number).filter(x=>Number.isSafeInteger(x)&&x>0))];
  const out=new Set();if(!ids.length)return out;
  const q=ids.map(()=>"?").join(",");
  try{
    const r=await db.prepare(`
      SELECT s.subject_key
      FROM subscriptions s
      LEFT JOIN subscription_preferences p ON p.subscription_id=s.subscription_id
      WHERE s.telegram_user_id=? AND s.subject_type='game'
        AND COALESCE(p.notify_pregame,s.notify_pregame,0)=1
        AND CAST(s.subject_key AS INTEGER) IN (${q});
    `).bind(Number(userId),...ids).all();
    for(const row of r.results||[])out.add(Number(row.subject_key));
  }catch{}
  return out;
}
function digestReminderKeyboard(games,enabled){
  const rows=(games||[]).map(g=>[{text:`${enabled?.has(Number(g.game_pk))?"✅":"☐"} ${g.away} — ${g.home} · ${g.at}`,callback_data:`center_gr:${g.game_pk}`}]);
  if(rows.length>1){const all=(games||[]).every(g=>enabled?.has(Number(g.game_pk)));rows.push([{text:all?"✅ Все матчи":"🔔 Все матчи",callback_data:"center_gra"}])}
  return {inline_keyboard:rows};
}

async function loadEspnInjuries(){
  const data=await fetchJson(ESPN_INJURIES);
  const records=[];
  collectInjuryRecords(data,records,null);
  const map=new Map();
  for(const row of records){
    const name=normalizePersonName(row.name);if(!name)continue;
    const team=upper(row.team||"");
    const key=team?`${team}|${name}`:name;
    if(!map.has(key)||injuryRank(row)>injuryRank(map.get(key)))map.set(key,row);
    if(!map.has(name)||injuryRank(row)>injuryRank(map.get(name)))map.set(name,row);
  }
  return map;
}
function collectInjuryRecords(node,out,parentTeam){
  if(!node)return;
  if(Array.isArray(node)){for(const x of node)collectInjuryRecords(x,out,parentTeam);return}
  if(typeof node!=="object")return;
  const team=upper(node?.team?.abbreviation||node?.team?.abbrev||node?.team?.shortDisplayName||parentTeam||"");
  const athlete=node.athlete||node.player||null;
  const name=athlete?.displayName||athlete?.fullName||node?.displayName||node?.playerName||null;
  const status=stringValue(node.status?.name||node.status?.type||node.status||node.type);
  const detail=stringValue(node.details?.detail||node.details?.type||node.details?.location||node.detail||node.description);
  if(name&&(status||detail)&&looksLikeInjury(node,status,detail))out.push({name:String(name),team,status,detail,date:stringValue(node.date||node.updated||node.lastUpdated)});
  for(const [k,v] of Object.entries(node)){
    if(["athlete","player","status","details","team"].includes(k))continue;
    if(v&&typeof v==="object")collectInjuryRecords(v,out,team||parentTeam);
  }
}
function looksLikeInjury(node,status,detail){
  const text=`${status||""} ${detail||""} ${stringValue(node?.type)||""}`.toLowerCase();
  return Boolean(node?.injury||node?.injuries||/injur|out|day.to.day|questionable|doubtful|ir\b|ltir|reserve|upper.body|lower.body/.test(text));
}
function findInjury(meta,map){
  const name=normalizePersonName(meta?.full_name_en||meta?.name);if(!name)return null;
  return map.get(`${upper(meta?.team_tri)}|${name}`)||map.get(name)||null;
}
function formatInjuryStatus(row){
  const raw=`${row?.status||""} ${row?.detail||""}`.trim(),low=raw.toLowerCase();
  const out=/\bout\b|injured reserve|\bir\b|ltir|long.term|sidelined/.test(low);
  const uncertain=/questionable|doubtful|day.to.day|game.time|probable/.test(low);
  const suffix=row?.detail&&String(row.detail).length<=48?`: ${row.detail}`:"";
  if(out)return ` · 🚑 травмирован, не сыграет${suffix}`;
  if(uncertain)return ` · 🚑 есть травма, участие под вопросом${suffix}`;
  return ` · 🚑 в списке травмированных${suffix}`;
}
function injuryRank(row){const s=`${row?.status||""} ${row?.detail||""}`.toLowerCase();if(/\bout\b|injured reserve|\bir\b|ltir/.test(s))return 3;if(/questionable|doubtful|day.to.day/.test(s))return 2;return 1}
function normalizePersonName(v){return String(v||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim()}
function stringValue(v){if(v==null)return"";if(typeof v==="string"||typeof v==="number")return String(v).trim();if(typeof v==="object")return String(v.displayName||v.name||v.description||v.type||"").trim();return""}

function isDigestWindowGame(game,now){
  if(FINAL.has(upper(game.state)))return false;
  const start=Date.parse(String(game.start_utc||""));if(!Number.isFinite(start))return false;
  // The 20:00 digest is for the coming NHL night, not just the strict calendar day.
  return start>=now.getTime()-2*60*60*1000&&start<=now.getTime()+18*60*60*1000;
}
function localParts(date,tz){try{const p=new Intl.DateTimeFormat("en-CA",{timeZone:tz,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(date),m=Object.fromEntries(p.map(x=>[x.type,x.value]));return{date:`${m.year}-${m.month}-${m.day}`,hour:Number(m.hour),minute:Number(m.minute)}}catch{return null}}
function formatLocalTime(value,tz){const d=new Date(value);if(!Number.isFinite(d.getTime()))return"—";try{return new Intl.DateTimeFormat("ru-RU",{timeZone:tz,hour:"2-digit",minute:"2-digit"}).format(d)}catch{return d.toISOString().slice(11,16)}}

async function processPlayerPostgameReports(env,game,relevant,ctx,userPrefs,now,dryRun,summary){
  const byUser=new Map();
  for(const s of relevant){if(s.subject_type!=="player"||!truthy(s.notify_final))continue;const uid=Number(s.telegram_user_id),pref=userPrefs.get(uid)||{};if(Number(pref.player_postgame_reports??1)!==1||!inDeliveryShard(uid,now))continue;if(!byUser.has(uid))byUser.set(uid,[]);byUser.get(uid).push(s)}
  if(!byUser.size)return;
  // Avoid refetching the NHL boxscore every minute after all recipients for this
  // game have already received their report.
  if(!dryRun){
    try{
      const sent=await env.DB.prepare(`SELECT telegram_user_id FROM notification_log WHERE notification_type='player_postgame_report' AND game_pk=?;`).bind(game.game_pk).all();
      for(const row of sent.results||[])byUser.delete(Number(row.telegram_user_id));
    }catch{}
    if(!byUser.size)return;
  }
  const box=await fetchJson(`${NHL}/gamecenter/${game.game_pk}/boxscore`).catch(()=>null),stats=box?boxscorePlayerMap(box):new Map();
  if(!stats.size)return; // NHL may mark FINAL a little before the complete player boxscore is ready; retry next minute.
  for(const [userId,list] of byUser){
    const blocks=[];
    for(const sub of list){const id=String(sub.subject_key),meta=ctx.playerMeta.get(id);if(!meta)continue;const row=stats.get(id);blocks.push(formatPlayerReportBlock(meta,row))}
    if(!blocks.length)continue;
    const key=`center:player-report:${game.game_pk}`,text=`🏒 <b>${html(game.away.tri)} ${html(score(game.away.score))} : ${html(score(game.home.score))} ${html(game.home.tri)}</b>\n📊 <b>СТАТИСТИКА ВАШИХ ИГРОКОВ</b>\n\n${blocks.join("\n\n────────────\n\n")}`;
    summary.planned++;
    if(dryRun){summary.player_reports++;summary.events.push({game_pk:game.game_pk,user_id:userId,type:"player_postgame_report",players:blocks.length,text});continue}
    const cap=Math.max(1,Math.min(...list.map(x=>Number(x.max_pushes_per_day)||12)));
    if(!canSendNow(summary,userId,cap))continue;
    if(!(await reserve(env.DB,key,userId,"player_postgame_report",game.game_pk,JSON.stringify({players:blocks.length})))){summary.skipped_duplicate++;continue}
    try{await sendCenter(env,userId,text,{parse_mode:"HTML"});markSent(summary,userId);summary.sent++;summary.player_reports++}catch(error){summary.failed++;await env.DB.prepare(`DELETE FROM notification_log WHERE notification_key=? AND telegram_user_id=?;`).bind(key,userId).run().catch(()=>{});summary.events.push({game_pk:game.game_pk,user_id:userId,type:"player_postgame_report",error:errorText(error)})}
  }
}
function boxscorePlayerMap(box){const out=new Map(),root=box?.playerByGameStats||box?.playerByGameStats?.playerByGameStats||{};for(const side of ["awayTeam","homeTeam"]){const team=root?.[side]||{};for(const section of ["forwards","defense","defensemen","goalies"]){for(const p of team?.[section]||[]){const id=positive(p.playerId||p.id);if(id)out.set(String(id),{...p,__goalie:section==="goalies"})}}}return out}
function formatPlayerReportBlock(meta,row){
  const name=html(meta?.name||"Игрок");
  if(!row)return `⭐ <b>${name}</b>\nНе выходил на лёд`;
  if(row.__goalie){
    const saves=finite(row.saves),against=finite(row.shotsAgainst),ga=finite(row.goalsAgainst),pct=finite(row.savePctg??row.savePercentage),toi=String(row.toi||row.timeOnIce||"—");
    const savePct=pct==null?"—":(pct<=1?(pct*100).toFixed(1):pct.toFixed(1))+"%";
    return `🥅 <b>${name}</b>\n🧤 Сейвы: <b>${html(saves??"—")}</b> / ${html(against??"—")}\n📈 % отражённых: <b>${html(savePct)}</b>\n🚨 Пропущено: <b>${html(ga??"—")}</b>\n⏱ Время: <b>${html(toi)}</b>`;
  }
  const g=finite(row.goals)??0,a=finite(row.assists)??0,p=finite(row.points)??g+a,shots=finite(row.sog??row.shots)??0,hits=finite(row.hits)??0,blocks=finite(row.blockedShots??row.blocked)??0,pm=finite(row.plusMinus),toi=String(row.toi||row.timeOnIce||"—");
  const plusMinus=pm==null?"—":(pm>0?"+":"")+pm;
  return `⭐ <b>${name}</b>\n🏒 Голы: <b>${g}</b>   🎯 Передачи: <b>${a}</b>   🔥 Очки: <b>${p}</b>\n🥅 Броски: <b>${shots}</b>   💥 Хиты: <b>${hits}</b>   🧱 Блоки: <b>${blocks}</b>\n➕ +/-: <b>${html(plusMinus)}</b>   ⏱ TOI: <b>${html(toi)}</b>`;
}

async function loadSchedule(now){const dates=[-1,0,1].map(o=>{const d=new Date(now);d.setUTCDate(d.getUTCDate()+o);return d.toISOString().slice(0,10)}),payloads=await Promise.all(dates.map(d=>fetchJson(`${NHL}/schedule/${d}`).catch(()=>null))),map=new Map();for(let i=0;i<payloads.length;i++)for(const g of normalizeSchedule(payloads[i],dates[i]))map.set(g.game_pk,g);return [...map.values()].sort((a,b)=>String(a.start_utc).localeCompare(String(b.start_utc)))}
function normalizeSchedule(d,date){if(!d)return[];let games=Array.isArray(d.games)?d.games:[];if(!games.length&&Array.isArray(d.gameWeek))games=d.gameWeek.flatMap(x=>x.games||[]);return games.filter(g=>!g.gameDate||String(g.gameDate)===date).map(g=>({game_pk:Number(g.id||g.gameId||g.gamePk),start_utc:g.startTimeUTC||null,state:upper(g.gameState||g.gameStatus),home:{id:positive(g.homeTeam?.id),tri:upper(g.homeTeam?.abbrev),score:finite(g.homeTeam?.score)},away:{id:positive(g.awayTeam?.id),tri:upper(g.awayTeam?.abbrev),score:finite(g.awayTeam?.score)}})).filter(g=>Number.isSafeInteger(g.game_pk)&&g.game_pk>0&&g.home.tri&&g.away.tri)}
function eventFromPlay(game,p,roster,teamIds){const type=String(p?.typeDescKey||"").toLowerCase(),sort=sortOrder(p);if(!sort)return null;if(type==="goal"){const d=p.details||{},scorer=positive(d.scoringPlayerId),assists=[positive(d.assist1PlayerId),positive(d.assist2PlayerId)].filter(Boolean),tri=teamIds.get(Number(d.eventOwnerTeamId))||"",name=roster.get(scorer)||`NHL ${scorer||""}`;return {key:`center:goal:${game.game_pk}:${sort}`,type:"goal",flag:"notify_goal",scoring_team_tri:tri,scorer_id:scorer,assist_ids:assists,text:`🚨 ГОЛ ${tri||"NHL"}\n${game.away.tri} ${score(d.awayScore??game.away.score)}:${score(d.homeScore??game.home.score)} ${game.home.tri}\n${name}`}}if(type==="period-end"){const period=positive(p?.periodDescriptor?.number)||0;return {key:`center:period:${game.game_pk}:${period||sort}`,type:"period_end",flag:"notify_period_end",text:`⏸ Конец ${period||"—"}-го периода\n${game.away.tri} ${score(game.away.score)}:${score(game.home.score)} ${game.home.tri}`}}return null}
function rosterMap(pbp){const m=new Map();for(const p of pbp?.rosterSpots||[]){const id=positive(p.playerId);if(id)m.set(id,[localized(p.firstName),localized(p.lastName)].filter(Boolean).join(" ")||`NHL ${id}`)}return m}
function teamIdMap(game,pbp){const m=new Map();if(game.home.id)m.set(game.home.id,game.home.tri);if(game.away.id)m.set(game.away.id,game.away.tri);const h=positive(pbp?.homeTeam?.id),a=positive(pbp?.awayTeam?.id);if(h)m.set(h,game.home.tri);if(a)m.set(a,game.away.tri);return m}
async function loadSentTodayCounts(db){const map=new Map();try{const r=await db.prepare(`SELECT telegram_user_id,COUNT(*) count FROM notification_log WHERE sent_at>=datetime('now','-24 hours') GROUP BY telegram_user_id;`).all();for(const x of r.results||[])map.set(Number(x.telegram_user_id),Number(x.count||0))}catch{}return map}
function canSendNow(summary,userId,cap){
  const d=summary?._delivery;if(!d)return true;
  if(Number(d.used||0)>=MAX_SENDS_PER_TICK){summary.deferred_budget++;return false}
  if(Number(d.sentToday.get(Number(userId))||0)>=cap){summary.skipped_limit++;return false}
  return true;
}
function markSent(summary,userId){const d=summary?._delivery;if(!d)return;d.used=Number(d.used||0)+1;d.sentToday.set(Number(userId),Number(d.sentToday.get(Number(userId))||0)+1)}
async function reserve(db,key,user,type,game,payload){const r=await db.prepare(`INSERT OR IGNORE INTO notification_log (notification_key,telegram_user_id,notification_type,subject_type,subject_key,game_pk,payload_json) VALUES (?,?,?,?,?,?,?);`).bind(key,user,type,"game",String(game),game,payload).run();return Number(r?.meta?.changes??r?.changes??0)>0}
async function sendCenter(env,user,text,options={}){const token=String(env.TELEGRAM_CENTER_BOT_TOKEN||"").trim();if(!token)throw new Error("missing_telegram_center_token");const payload={chat_id:user,text,disable_web_page_preview:true};if(options.parse_mode)payload.parse_mode=options.parse_mode;if(options.reply_markup)payload.reply_markup=options.reply_markup;const r=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)}),d=await r.json().catch(()=>({}));if(!r.ok||!d.ok)throw new Error(d.description||`Telegram ${r.status}`)}
async function fetchJson(url){const r=await fetch(url,{headers:{Accept:"application/json"}});if(!r.ok)throw new Error(`NHL HTTP ${r.status}`);return r.json()}
function html(v){return String(v??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}
function chunks(values,size=90){const out=[];for(let i=0;i<(values||[]).length;i+=size)out.push(values.slice(i,i+size));return out}
function deliveryShard(userId){return Math.abs(Number(userId)||0)%DELIVERY_SHARDS}
function inDeliveryShard(userId,now){const d=now instanceof Date?now:new Date(now);return deliveryShard(userId)===(d.getUTCMinutes()%DELIVERY_SHARDS)}
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
