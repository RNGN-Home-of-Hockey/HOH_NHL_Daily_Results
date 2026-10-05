from pathlib import Path
import re


def read(path):
    return Path(path).read_text(encoding="utf-8")


def write(path, text):
    Path(path).write_text(text, encoding="utf-8")


def replace_once(path, old, new):
    text = read(path)
    if old not in text:
        raise SystemExit(f"PATCH_MISS {path}: {old[:120]!r}")
    write(path, text.replace(old, new, 1))


def regex_once(path, pattern, replacement):
    text = read(path)
    new, count = re.subn(pattern, lambda _m: replacement, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f"PATCH_REGEX_MISS {path}: count={count} pattern={pattern[:100]!r}")
    write(path, new)


write("cloudflare-worker/src/nhl-live-score-maintenance.js", r'''import { fetchNhlJson } from "./data-core-importer.js";

const NHL_BASE="https://api-web.nhle.com/v1";
const META_KEY="nhl_live_score_sync_state";

export async function runNhlLiveScoreMaintenance(env,{fetchImpl=fetch,nowMs=Date.now()}={}){
  if(!env?.DB)return {ok:false,error:"missing_d1_binding"};
  let payload;
  try{
    payload=await fetchNhlJson(fetchImpl,`${NHL_BASE}/score/now`,{timeoutMs:10000,maxAttempts:2});
  }catch(error){
    const state={fetched_at:new Date(nowMs).toISOString(),ok:false,error:String(error?.message||error)};
    await saveState(env.DB,state).catch(()=>{});
    return state;
  }
  const games=(Array.isArray(payload?.games)?payload.games:[]).map(normalizeScoreGame).filter(Boolean);
  let written=0;
  for(let i=0;i<games.length;i+=50){
    const chunk=games.slice(i,i+50).map(g=>env.DB.prepare(`
      INSERT INTO games(game_pk,season_id,game_type,scheduled_start_utc,game_state,home_tri,away_tri,home_score,away_score,current_period,period_type,venue_name,last_synced_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(game_pk) DO UPDATE SET
        season_id=excluded.season_id,
        game_type=excluded.game_type,
        scheduled_start_utc=excluded.scheduled_start_utc,
        game_state=excluded.game_state,
        home_tri=excluded.home_tri,
        away_tri=excluded.away_tri,
        home_score=excluded.home_score,
        away_score=excluded.away_score,
        current_period=COALESCE(excluded.current_period,games.current_period),
        period_type=COALESCE(excluded.period_type,games.period_type),
        venue_name=COALESCE(excluded.venue_name,games.venue_name),
        last_synced_at=CURRENT_TIMESTAMP;
    `).bind(g.game_pk,g.season_id,g.game_type,g.scheduled_start_utc,g.game_state,g.home_tri,g.away_tri,g.home_score,g.away_score,g.current_period,g.period_type,g.venue_name));
    if(chunk.length){await env.DB.batch(chunk);written+=chunk.length}
  }
  const state={fetched_at:new Date(nowMs).toISOString(),ok:true,games_seen:games.length,games_written:written};
  await saveState(env.DB,state).catch(()=>{});
  return state;
}

export async function persistNhlLiveGame(db,game){
  if(!db||!game||!Number.isSafeInteger(Number(game.game_pk)))return {ok:false,error:"invalid_game"};
  const result=await db.prepare(`
    UPDATE games SET
      game_state=?,home_score=?,away_score=?,current_period=COALESCE(?,current_period),period_type=COALESCE(?,period_type),last_synced_at=CURRENT_TIMESTAMP
    WHERE game_pk=?;
  `).bind(
    String(game.game_state||"").toUpperCase()||"LIVE",
    finiteOrZero(game.home_score),finiteOrZero(game.away_score),
    intOrNull(game.period_number??game.current_period),game.period_type||null,Number(game.game_pk)
  ).run();
  return {ok:true,game_pk:Number(game.game_pk),updated:Number(result?.meta?.changes||0)};
}

function normalizeScoreGame(raw){
  const id=Number(raw?.id),home=String(raw?.homeTeam?.abbrev||"").toUpperCase(),away=String(raw?.awayTeam?.abbrev||"").toUpperCase();
  const start=String(raw?.startTimeUTC||"");
  if(!Number.isSafeInteger(id)||id<=0||!home||!away||!start)return null;
  return {
    game_pk:id,season_id:String(raw?.season||""),game_type:intOrNull(raw?.gameType)||2,scheduled_start_utc:start,
    game_state:String(raw?.gameState||"FUT").toUpperCase(),home_tri:home,away_tri:away,
    home_score:finiteOrZero(raw?.homeTeam?.score),away_score:finiteOrZero(raw?.awayTeam?.score),
    current_period:intOrNull(raw?.periodDescriptor?.number),period_type:raw?.periodDescriptor?.periodType||raw?.gameOutcome?.lastPeriodType||null,
    venue_name:localized(raw?.venue)
  };
}
async function saveState(db,value){await db.prepare(`INSERT INTO data_core_meta(meta_key,meta_value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP;`).bind(META_KEY,JSON.stringify(value)).run()}
function finiteOrZero(v){const n=Number(v);return Number.isFinite(n)?n:0}
function intOrNull(v){const n=Number(v);return Number.isSafeInteger(n)?n:null}
function localized(v){if(!v)return null;if(typeof v==="string")return v;return v.default||v.en||Object.values(v)[0]||null}
''')

replace_once(
    "cloudflare-worker/src/worker-entry.js",
    'import { getWinlineLiveFeedMaintenanceStatus, runWinlineLiveFeedMaintenance } from "./winline-live-feed-maintenance.js";\n',
    'import { getWinlineLiveFeedMaintenanceStatus, runWinlineLiveFeedMaintenance } from "./winline-live-feed-maintenance.js";\nimport { persistNhlLiveGame, runNhlLiveScoreMaintenance } from "./nhl-live-score-maintenance.js";\n',
)

replace_once(
    "cloudflare-worker/src/worker-entry.js",
    '''    if (cron === "* * * * *") {
      ctx.waitUntil(
        pollTelegramCenterUpdates(env).catch((error) => {''',
    '''    if (cron === "* * * * *") {
      if (env.DB) {
        ctx.waitUntil(
          runNhlLiveScoreMaintenance(env).catch((error) => {
            console.error("scheduled NHL live score maintenance failed", error);
          }),
        );
      }
      ctx.waitUntil(
        pollTelegramCenterUpdates(env).catch((error) => {''',
)

replace_once(
    "cloudflare-worker/src/worker-entry.js",
    '''    let snapshot=await buildLiveGameSnapshot(gamePk);
    if(env?.DB){
      try{
        const providerMarkets=await loadBroadcastWinlineMarkets(env.DB,snapshot.game);''',
    '''    let snapshot=await buildLiveGameSnapshot(gamePk);
    if(env?.DB){
      try{await persistNhlLiveGame(env.DB,snapshot.game)}catch(error){console.error("broadcast live NHL persistence failed",error)}
      try{
        const providerMarkets=await loadBroadcastWinlineMarkets(env.DB,snapshot.game);''',
)

live_path="cloudflare-worker/src/live-betting-engine.js"
replace_once(
    live_path,
    r'''  const shots = [];
  for (const play of payload.plays || []) {
    if (!SHOT_TYPES.has(play.typeDescKey)) continue;
    const teamId = Number(play.details?.eventOwnerTeamId);
    const teamTri = teamsById.get(teamId);
    if (!teamTri) continue;
    shots.push({
      sort_order: Number(play.sortOrder ?? play.eventId ?? 0),
      event_type: play.typeDescKey,
      team_tri: teamTri,
      period_number: Number(play.periodDescriptor?.number || 0),
      period_type: play.periodDescriptor?.periodType || null,
      time_in_period: play.timeInPeriod || null,
      elapsed_seconds: gameElapsedSeconds(play),
    });
  }

  const cards = buildLiveCards(game, shots);
  return {
    ok: true,
    source: "nhl_live_play_by_play",
    fetched_at: new Date().toISOString(),
    game,
    shot_events: shots.length,
    cards,
  };''',
    r'''  const shots = [];
  const rawStats={
    [game.away_tri]:{hits:0,pim:0,faceoff_wins:0},
    [game.home_tri]:{hits:0,pim:0,faceoff_wins:0},
  };
  let faceoffs=0;
  for (const play of payload.plays || []) {
    const teamId = Number(play.details?.eventOwnerTeamId);
    const teamTri = teamsById.get(teamId);
    if (teamTri && play.typeDescKey === "hit") rawStats[teamTri].hits += 1;
    if (teamTri && play.typeDescKey === "penalty") rawStats[teamTri].pim += Math.max(0,Number(play.details?.duration)||0);
    if (teamTri && play.typeDescKey === "faceoff") { rawStats[teamTri].faceoff_wins += 1; faceoffs += 1; }
    if (!SHOT_TYPES.has(play.typeDescKey) || !teamTri) continue;
    shots.push({
      sort_order: Number(play.sortOrder ?? play.eventId ?? 0),
      event_type: play.typeDescKey,
      team_tri: teamTri,
      period_number: Number(play.periodDescriptor?.number || 0),
      period_type: play.periodDescriptor?.periodType || null,
      time_in_period: play.timeInPeriod || null,
      elapsed_seconds: gameElapsedSeconds(play),
    });
  }
  const playShots=teamCounts(shots,game);
  const statFor=(tri,sog)=>({
    team_tri:tri,
    shots:Number.isFinite(Number(sog))?Number(sog):Number(playShots[tri]||0),
    hits:Number(rawStats[tri]?.hits||0),
    pim:Number(rawStats[tri]?.pim||0),
    faceoff_pct:faceoffs>0?round3(Number(rawStats[tri]?.faceoff_wins||0)/faceoffs):null,
  });
  const liveStats={away:statFor(game.away_tri,game.away_sog),home:statFor(game.home_tri,game.home_sog)};
  const liveContext=buildLiveContext(game,shots);

  const cards = buildLiveCards(game, shots);
  return {
    ok: true,
    source: "nhl_live_play_by_play",
    fetched_at: new Date().toISOString(),
    game,
    live_stats:liveStats,
    live_context:liveContext,
    shot_events: shots.length,
    cards,
  };''',
)

replace_once(
    live_path,
    "export function buildLiveCards(game, shots) {",
    r'''export function buildLiveContext(game,shots){
  const latest=shots.at(-1);
  const windowByMinutes=(minutes)=>{
    if(!latest||!Number.isFinite(latest.elapsed_seconds))return null;
    const cutoff=latest.elapsed_seconds-minutes*60;
    const rows=shots.filter(x=>Number.isFinite(x.elapsed_seconds)&&x.elapsed_seconds>=cutoff);
    const counts=teamCounts(rows,game),[leader,leaderShots]=leaderEntry(counts),other=opponent(game,leader),otherShots=Number(counts[other]||0);
    return {minutes,total:rows.length,leader,leader_shots:leaderShots,opponent:other,opponent_shots:otherShots,share:rows.length?round3(leaderShots/rows.length):0};
  };
  const period=Number(game.period_number||0),periodRows=period?shots.filter(x=>Number(x.period_number)===period):[];
  const periodCounts=teamCounts(periodRows,game),[periodLeader,periodLeaderShots]=leaderEntry(periodCounts),periodOther=opponent(game,periodLeader);
  return {
    recent_5m:windowByMinutes(5),recent_10m:windowByMinutes(10),
    current_period:{period,total:periodRows.length,leader:periodLeader,leader_shots:periodLeaderShots,opponent:periodOther,opponent_shots:Number(periodCounts[periodOther]||0),share:periodRows.length?round3(periodLeaderShots/periodRows.length):0}
  };
}

export function buildLiveCards(game, shots) {''',
)

regex_once(
    live_path,
    r'export function attachLiveWinlineMarkets\(snapshot, providerMarkets, options=\{\}\) \{.*?\n\}\n\nexport function buildLiveContext',
    r'''export function attachLiveWinlineMarkets(snapshot, providerMarkets, options={}) {
  if(!snapshot?.game||!Array.isArray(snapshot.cards))return snapshot;
  const liveMarkets=(providerMarkets||[]).filter(m=>m?.is_live===true||Number(m?.is_live||0)===1);
  const maxAgeMs=options.market_max_age_ms||5*60*1000;
  let exact=[];
  try{
    exact=applyWinlineMarkets(snapshot.cards,liveMarkets,{now:options.now,max_age_ms:maxAgeMs});
  }catch(error){
    console.error("live Winline market adapter failed",error);
    exact=[];
  }
  const fallback=buildProviderDrivenLiveCards(snapshot,liveMarkets,exact,{now:options.now,max_age_ms:maxAgeMs});
  let cards=[...exact,...fallback];
  const seen=new Set();
  cards=cards.filter(card=>{const key=String(card?.market?.market_id||card?.market?.selection_id||card?.id||"");if(!key||seen.has(key))return false;seen.add(key);return true});
  cards=cards.map(card=>{
    const narrative=buildNarrative(card,{game:snapshot.game});
    return {
      ...card,
      broadcast_title:card.broadcast_title||narrative?.tv?.title||card.title,
      broadcast_variants:narrative?.tv?.variants||[card.title],
      broadcast_subtitle:card.broadcast_subtitle||narrative?.tv?.subtitle||null,
      operator_narrative:narrative?.operator||null,
      air_score:Math.max(0,Math.min(100,Math.round(Number(card.air_score??card.score??0)))),
      air_label:"LIVE",
      air_reasons:card.air_reasons||["live pressure","реальная линия"],
    };
  }).sort((a,b)=>Number(b.air_score||b.score||0)-Number(a.air_score||a.score||0)).slice(0,10);
  const newestLiveQuote=liveMarkets.map(m=>Date.parse(String(m?.updated_at||""))).filter(Number.isFinite).sort((a,b)=>b-a)[0]||null;
  return {...snapshot,cards,provider_market_count:liveMarkets.length,priced_live_cards:cards.length,provider_live_updated_at:newestLiveQuote?new Date(newestLiveQuote).toISOString():null};
}

export function buildProviderDrivenLiveCards(snapshot,liveMarkets,existing=[],options={}){
  const game=snapshot?.game||{},ctx=snapshot?.live_context||{},nowMs=resolveLiveNow(options.now),maxAgeMs=Number(options.max_age_ms)||5*60*1000;
  const used=new Set((existing||[]).map(c=>String(c?.market?.market_id||c?.market?.selection_id||"")).filter(Boolean));
  const five=ctx.recent_5m,ten=ctx.recent_10m,periodCtx=ctx.current_period;
  const strongFive=five&&five.total>=6&&five.share>=0.74?five:null;
  const strongTen=ten&&ten.total>=10&&ten.share>=0.70?ten:null;
  const periodStrong=periodCtx&&periodCtx.total>=10&&periodCtx.share>=0.70?periodCtx:null;
  const cards=[];
  for(const m of liveMarkets||[]){
    const marketId=String(m?.market_id||m?.selection_id||"");
    if(!marketId||used.has(marketId)||!liveProviderMarketFresh(m,nowMs,maxAgeMs))continue;
    const type=String(m?.market_type||m?.type||"").toLowerCase(),subject=String(m?.subject||"").toUpperCase(),period=String(m?.period||"GAME").toUpperCase();
    let pressure=null,title="",score=0;
    if(type==="next_goal_team"){
      pressure=strongFive?.leader===subject?strongFive:strongTen?.leader===subject?strongTen:null;
      if(!pressure)continue;
      title=`${subject}: ${pressure.leader_shots}:${pressure.opponent_shots} ПО БРОСКАМ ЗА ПОСЛЕДНИЕ ${pressure.minutes} МИНУТ`;
      score=88+Math.min(7,Math.round((pressure.share-.70)*30));
    }else if(type==="moneyline"){
      pressure=strongTen?.leader===subject?strongTen:null;
      if(!pressure)continue;
      const subjectScore=subject===game.home_tri?Number(game.home_score||0):Number(game.away_score||0),oppScore=subject===game.home_tri?Number(game.away_score||0):Number(game.home_score||0);
      if(subjectScore<oppScore-1)continue;
      title=`${subject} ДАВИТ: ${pressure.leader_shots}:${pressure.opponent_shots} ПО БРОСКАМ ЗА 10 МИНУТ ПРИ СЧЁТЕ ${game.away_score}:${game.home_score}`;
      score=subjectScore<oppScore?86:subjectScore===oppScore?89:91;
    }else if(/^period_[123]_result$/.test(type)){
      const expected=`P${Number(game.period_number||0)}`;
      if(period!==expected||periodStrong?.leader!==subject)continue;
      pressure=periodStrong;
      title=`${subject}: ${pressure.leader_shots}:${pressure.opponent_shots} ПО БРОСКАМ В ${game.period_number}-М ПЕРИОДЕ`;
      score=87+Math.min(6,Math.round((pressure.share-.70)*25));
    }else continue;
    const market=providerLiveCardMarket(m,type,subject,period);
    cards.push({
      id:`live-provider:${game.game_pk}:${marketId}`,type:`live_provider_${type}`,category:"live",kind:"live",timing:"live",score,air_score:score,
      eyebrow:"LIVE · ТОЧНАЯ ЛИНИЯ",value:`${pressure.leader_shots}:${pressure.opponent_shots}`,title,broadcast_title:title,
      broadcast_subtitle:`Счёт ${game.away_tri} ${game.away_score}:${game.home_score} ${game.home_tri} · ${pressure.minutes?`отрезок ${pressure.minutes} мин`:`${game.period_number}-й период`}`,
      explanation:`Текущая линия Winline сопоставлена с сильным live-отрезком: ${pressure.leader} ${pressure.leader_shots}, ${pressure.opponent} ${pressure.opponent_shots} по броскам в створ.`,
      evidence:{game_pk:game.game_pk,state:game.game_state,period:game.period_number,time_remaining:game.time_remaining,score:`${game.away_tri} ${game.away_score}:${game.home_score} ${game.home_tri}`,shots_by_team:{[pressure.leader]:pressure.leader_shots,[pressure.opponent]:pressure.opponent_shots},shot_share:pressure.share,window_minutes:pressure.minutes||null,feature_layer:"nhl_live_provider_context_v2"},
      market,air_reasons:["сильный live-отрезок","точная live-линия"]
    });
    used.add(marketId);
  }
  return cards;
}
function providerLiveCardMarket(m,type,subject,period){
  const side=String(m?.side||"").toLowerCase(),line=m?.line===null||m?.line===undefined?null:Number(m.line),odds=Number(m?.odds);
  const p=period==="P1"?"1-Й ПЕРИОД · ":period==="P2"?"2-Й ПЕРИОД · ":period==="P3"?"3-Й ПЕРИОД · ":"";
  const label=type==="next_goal_team"?`Следующий гол — ${subject}`:type==="moneyline"?`Победа ${subject}`:`${p}Победа ${subject}`;
  return {type,period,subject,side:side||subject,line:Number.isFinite(line)?line:null,odds,provider:"winline",odds_is_demo:false,odds_source:"provider_live",event_id:m?.event_id||null,market_id:String(m?.market_id||m?.selection_id||""),selection_id:String(m?.selection_id||m?.market_id||""),updated_at:m?.updated_at||null,deeplink:m?.deeplink||null,label};
}
function liveProviderMarketFresh(m,nowMs,maxAgeMs){const t=Date.parse(String(m?.updated_at||""));if(!Number.isFinite(t)||!Number.isFinite(Number(m?.odds))||Number(m.odds)<=1)return false;const age=nowMs-t;return age>=-60000&&age<=maxAgeMs}
function resolveLiveNow(value){if(value instanceof Date)return value.getTime();if(typeof value==="number"&&Number.isFinite(value))return value;if(typeof value==="string"&&Number.isFinite(Date.parse(value)))return Date.parse(value);return Date.now()}

export function buildLiveContext''',
)

replace_once(
    live_path,
    '''    title: `${leader} заметно перебрасывает соперника на последнем пятиминутном отрезке`,
    explanation: `${leaderCount} из ${rows.length} бросков в створ за последние примерно ${minutes} минут игрового времени принадлежат ${leader}.`,''',
    '''    title: `${leader}: ${leaderCount}:${Number(counts[other] || 0)} ПО БРОСКАМ В СТВОР ЗА ПОСЛЕДНИЕ ${minutes} МИНУТ`,
    explanation: `Последние ${minutes} минут игрового времени: ${leader} ${leaderCount}, ${other} ${Number(counts[other] || 0)} по броскам в створ.`,''',
)

regex_once(
    live_path,
    r'function addScoreStateCards\(cards,game,shots\)\{.*?\n\}\n\nfunction addPeriodTotalPressureCard',
    r'''function addScoreStateCards(cards,game,shots){
  const home=game.home_tri,away=game.away_tri;
  const hs=Number(game.home_score||0),as=Number(game.away_score||0);
  const period=Number(game.period_number||0);
  if(!period||!["LIVE","CRIT"].includes(String(game.game_state||"").toUpperCase()))return;
  const latest=shots.at(-1);
  const cutoff=Number.isFinite(latest?.elapsed_seconds)?latest.elapsed_seconds-10*60:null;
  const recent=cutoff===null?shots.slice(-16):shots.filter(x=>Number.isFinite(x.elapsed_seconds)&&x.elapsed_seconds>=cutoff);
  if(recent.length<10)return;
  const counts=teamCounts(recent,game);
  const [pressureTeam,pressureShots]=leaderEntry(counts);
  const other=opponent(game,pressureTeam),otherShots=Number(counts[other]||0);
  const share=pressureShots/Math.max(1,recent.length);
  if(share<.70)return;
  const pressureScore=pressureTeam===home?hs:as;
  const otherScore=pressureTeam===home?as:hs;
  if(pressureScore<otherScore-1)return;
  const state=pressureScore>otherScore?"leading":pressureScore<otherScore?"trailing":"tied";
  let score=state==="trailing"?86:state==="tied"?89:91;
  score+=Math.min(5,Math.round((share-.70)*25));
  cards.push(card({
    game,
    id:`live:${game.game_pk}:scorestate:${pressureTeam}:${latest?.sort_order||0}`,
    type:"live_moneyline_pressure",
    score:Math.min(96,score),
    eyebrow:state==="trailing"?"ДАВЛЕНИЕ ПРИ -1":state==="leading"?"ДАВЛЕНИЕ ПРИ ЛИДЕРСТВЕ":"ДАВЛЕНИЕ ПРИ РАВНОМ СЧЁТЕ",
    value:`${pressureShots}:${otherShots} по броскам · 10 мин`,
    title:`${pressureTeam}: ${pressureShots}:${otherShots} ПО БРОСКАМ ЗА 10 МИНУТ ПРИ СЧЁТЕ ${away} ${as}:${hs} ${home}`,
    explanation:`За последние ~10 минут ${pressureTeam} нанёс ${pressureShots} бросков в створ, ${other} — ${otherShots}. Текущий счёт ${away} ${as}:${hs} ${home}. Карточка появляется только при сильном преимуществе по броскам и отставании не больше одной шайбы.`,
    evidence:{minutes:10,score_state:state,team:pressureTeam,opponent:other,shots_by_team:counts,shot_share:round3(share),period,feature_layer:"nhl_live_score_state_v2"},
    market:{type:"moneyline",period:"GAME",subject:pressureTeam,side:pressureTeam,label:`Победа ${pressureTeam}`}
  }));
}

function addPeriodTotalPressureCard''',
)

dashboard="cloudflare-worker/src/broadcast-dashboard-v2.js"
replace_once(
    dashboard,
    '''function renderMetrics(d){const a=(d.team_stats||[]).find(x=>Number(x.is_home)===0)||{},h=(d.team_stats||[]).find(x=>Number(x.is_home)===1)||{},g=d.game;const rows=[['Броски в створ',a.shots,h.shots],['Хиты',a.hits,h.hits],['Штрафные минуты',a.pim,h.pim],['Вбрасывания',a.faceoff_pct==null||!Number.isFinite(Number(a.faceoff_pct))?null:Math.round(Number(a.faceoff_pct)*100)+'%',h.faceoff_pct==null||!Number.isFinite(Number(h.faceoff_pct))?null:Math.round(Number(h.faceoff_pct)*100)+'%']];$('#metrics').innerHTML=rows.map(r=>`<div class="metric"><div class="mval">${esc(r[1]??'—')} — ${esc(r[2]??'—')}</div><div class="mlabel">${esc(r[0])} · ${esc(g.away_tri)} / ${esc(g.home_tri)}</div></div>`).join('')}''',
    '''function renderMetrics(d,live=null){const a=(d.team_stats||[]).find(x=>Number(x.is_home)===0)||{},h=(d.team_stats||[]).find(x=>Number(x.is_home)===1)||{},g=d.game||{};const la=live?.away||{},lh=live?.home||{};const pick=(v,f)=>v===null||v===undefined||v===''?f:v;const fp=v=>v==null||!Number.isFinite(Number(v))?null:Math.round(Number(v)*100)+'%';const rows=[['Броски в створ',pick(la.shots,a.shots),pick(lh.shots,h.shots)],['Хиты',pick(la.hits,a.hits),pick(lh.hits,h.hits)],['Штрафные минуты',pick(la.pim,a.pim),pick(lh.pim,h.pim)],['Вбрасывания',fp(pick(la.faceoff_pct,a.faceoff_pct)),fp(pick(lh.faceoff_pct,h.faceoff_pct))]];$('#metrics').innerHTML=rows.map(r=>`<div class="metric"><div class="mval">${esc(r[1]??'—')} — ${esc(r[2]??'—')}</div><div class="mlabel">${esc(r[0])} · ${esc(g.away_tri)} / ${esc(g.home_tri)}</div></div>`).join('')}
function applyLiveGameSnapshot(l){if(!l?.game||!currentData)return;currentData.game={...currentData.game,...l.game};const g=currentData.game,row=games.find(x=>Number(x.game_pk)===Number(g.game_pk));if(row)Object.assign(row,{game_state:g.game_state,away_score:g.away_score,home_score:g.home_score,current_period:g.period_number??g.current_period,period_type:g.period_type});const score=$('#hero .score');if(score)score.innerHTML=esc(g.away_score)+'<span>:</span>'+esc(g.home_score);renderMetrics(currentData,l.live_stats||null);renderGames()}''',
)

regex_once(
    dashboard,
    r'async function refreshLive\(id,initial=false\)\{.*?\nconst TEAM_META=',
    r'''async function refreshLive(id,initial=false){try{const l=await api('/api/broadcast/live/'+id);if(Number(id)!==Number(selected))return;applyLiveGameSnapshot(l);liveMonitoring=l.monitoring||null;liveCards=(l.cards||[]).filter(x=>x?.market?.odds_is_demo===false&&Number.isFinite(Number(x?.market?.odds))&&Number(x.market.odds)>=1.50);renderCombinedCards();const c=$('#liveclock');if(c&&l.game){const parts=[l.game.game_state,l.game.period_number?l.game.period_number+'-Й ПЕРИОД':null,l.game.time_remaining].filter(Boolean);const nhlAt=l.fetched_at?new Date(l.fetched_at).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—';const winAt=l.provider_live_updated_at?new Date(l.provider_live_updated_at).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}):'нет live-линии';const freshness=liveMonitoring?.winline_status==='fresh'?'свежая':liveMonitoring?.winline_status==='stale'?'УСТАРЕЛА':'нет';c.textContent=parts.join(' · ')+' · NHL '+nhlAt+' · WINLINE '+winAt+' · '+freshness}if(gameLooksLive(l.game||currentData?.game)&&!liveTimer){liveTimer=setInterval(()=>refreshLive(id,false),15000)}else if(!gameLooksLive(l.game||currentData?.game)&&liveTimer){clearInterval(liveTimer);liveTimer=null}}catch(e){if(initial){const sub=document.querySelector('.psub');if(sub)sub.textContent=`Предматчевых ${historicalCards.length} · NHL live feed временно недоступен`}}}
const TEAM_META=''',
)

replace_once(
    dashboard,
    "async function refreshGameList(){try{const d=await api('/api/broadcast/games');const fresh=d.games||[],byPk=new Map(games.map(g=>[Number(g.game_pk),g]));games=fresh.map(g=>({...byPk.get(Number(g.game_pk)),...g}));$('#counts').textContent=`${d.counts.games} матчей · ближайшие + live + предматчевый архив за 7 дней`;renderGames();void warmQueueSummaries()}catch{}}",
    "async function refreshGameList(){try{const d=await api('/api/broadcast/games');const fresh=d.games||[],byPk=new Map(games.map(g=>[Number(g.game_pk),g])),live=currentData?.game;games=fresh.map(g=>{const merged={...byPk.get(Number(g.game_pk)),...g};if(live&&Number(g.game_pk)===Number(selected)&&gameLooksLive(live))Object.assign(merged,{game_state:live.game_state,away_score:live.away_score,home_score:live.home_score,current_period:live.period_number??live.current_period,period_type:live.period_type});return merged});$('#counts').textContent=`${d.counts.games} матчей · ближайшие + live + предматчевый архив за 7 дней`;renderGames();void warmQueueSummaries()}catch{}}",
)

operator="cloudflare-worker/src/broadcast-operator.js"
regex_once(
    operator,
    r'let current="";\nconst overlayGame=.*?\ntick\(\);\nsetInterval\(tick,750\);',
    r'''let current="",failures=0,imageFailures=0,lastOk=Date.now();
const overlayGame=new URLSearchParams(location.search).get("game")||"";
const stateUrl="/api/broadcast/state"+(overlayGame?"?game="+encodeURIComponent(overlayGame):"");
function statePollUrl(){return stateUrl+(stateUrl.includes("?")?"&":"?")+"_ts="+Date.now()}
async function tick(){
  const img=document.getElementById("cardimg");
  try{
    const r=await fetch(statePollUrl(),{cache:"no-store",headers:{"Cache-Control":"no-cache"}});
    if(!r.ok)throw new Error("state_http_"+r.status);
    const d=await r.json();
    failures=0;lastOk=Date.now();
    const c=d&&d.on_air;
    if(!c||!c.render_hash){
      current="";imageFailures=0;
      img.classList.remove("on");
      img.removeAttribute("src");
      return;
    }
    const key=String(c.card_id)+"@"+String(c.render_hash);
    if(key!==current){
      current=key;
      img.classList.remove("on");
      img.onload=()=>{imageFailures=0;img.classList.add("on")};
      img.onerror=()=>{img.classList.remove("on");current="";imageFailures++;if(imageFailures>=4)location.reload()};
      img.src="/api/broadcast/rendered/"+encodeURIComponent(c.card_id)+".png?v="+encodeURIComponent(c.render_hash)+"&t="+Date.now();
    }else{
      img.classList.add("on");
    }
  }catch(error){
    console.error(error);
    failures++;
    img.classList.remove("on");
    if(failures>=12)location.reload();
  }
}
tick();
setInterval(tick,750);
setInterval(()=>{if(Date.now()-lastOk>20000)location.reload()},5000);''',
)

write("tests/validate_live_center_stage2.mjs", r'''import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import { buildLiveGameSnapshot, buildLiveCards, buildProviderDrivenLiveCards } from '../cloudflare-worker/src/live-betting-engine.js';

const plays=[];
let order=1;
const add=(type,team,minute,extra={})=>plays.push({sortOrder:order++,eventId:order,typeDescKey:type,details:{eventOwnerTeamId:team,...extra},periodDescriptor:{number:1,periodType:'REG'},timeInPeriod:minute});
for(const t of ['03:00','03:40','04:10','04:40','05:10','05:40','06:10','06:40'])add('shot-on-goal',1,t);
for(const t of ['03:20','06:20'])add('shot-on-goal',2,t);
add('hit',1,'07:00');add('hit',2,'07:10');add('penalty',2,'07:20',{duration:2});add('faceoff',1,'07:30');add('faceoff',2,'08:00');
const payload={id:2026020001,season:20262027,gameType:2,gameState:'LIVE',homeTeam:{id:2,abbrev:'ANA',score:1,sog:8},awayTeam:{id:1,abbrev:'FLA',score:1,sog:12},periodDescriptor:{number:1,periodType:'REG'},clock:{timeRemaining:'12:00',secondsRemaining:720,running:true,inIntermission:false},plays};
const fakeFetch=async()=>new Response(JSON.stringify(payload),{status:200,headers:{'content-type':'application/json'}});
const snap=await buildLiveGameSnapshot(2026020001,fakeFetch);
assert.equal(snap.game.away_score,1);assert.equal(snap.game.home_score,1);
assert.equal(snap.live_stats.away.shots,12);assert.equal(snap.live_stats.home.shots,8);
assert.equal(snap.live_stats.home.pim,2);assert.equal(snap.live_stats.away.faceoff_pct,0.5);
assert.equal(snap.live_context.recent_10m.leader,'FLA');

const weakGame={...snap.game,home_score:2,away_score:1};
const weakShots=[];for(let i=0;i<6;i++)weakShots.push({sort_order:i+1,event_type:'shot-on-goal',team_tri:i<5?'FLA':'ANA',period_number:1,elapsed_seconds:300+i*20});
assert.equal(buildLiveCards(weakGame,weakShots).some(c=>c.type==='live_moneyline_pressure'),false,'5:1 alone must not create match-winner card');

const provider=[{provider:'winline',event_id:'1',market_id:'m1',selection_id:'m1',market_type:'moneyline',period:'GAME',subject:'FLA',side:'FLA',line:null,odds:2.9,status:'open',is_live:true,updated_at:new Date().toISOString()}];
const fallback=buildProviderDrivenLiveCards(snap,provider,[],{now:Date.now(),max_age_ms:90000});
assert.equal(fallback.length,1);assert.match(fallback[0].broadcast_title,/БРОСКАМ/);assert.equal(fallback[0].market.odds_is_demo,false);

const dash=fs.readFileSync(new URL('../cloudflare-worker/src/broadcast-dashboard-v2.js',import.meta.url),'utf8');
for(const needle of ['applyLiveGameSnapshot(l)','renderMetrics(currentData,l.live_stats||null)','score.innerHTML=esc(g.away_score)'])assert.ok(dash.includes(needle),'dashboard missing '+needle);
const overlay=fs.readFileSync(new URL('../cloudflare-worker/src/broadcast-operator.js',import.meta.url),'utf8');
for(const needle of ['statePollUrl()','failures>=12','imageFailures>=4','Date.now()-lastOk>20000'])assert.ok(overlay.includes(needle),'overlay watchdog missing '+needle);
console.log('LIVE_CENTER_STAGE2_OK');
''')

replace_once(
    ".github/workflows/validate-product.yml",
    "      - name: UI route contracts\n",
    "      - name: Live Center reliability\n        run: node tests/validate_live_center_stage2.mjs\n\n      - name: UI route contracts\n",
)

docs="docs/BROADCAST_CONTROL_ROOM_V2_PLAN.md"
text=read(docs)
marker="## P7 — live reliability and useful in-game cards"
if marker not in text:
    text += r'''

## P7 — live reliability and useful in-game cards
- [x] Repaint the visible score and live metrics from direct NHL play-by-play every 15 seconds; never leave the hero score on the initial D1 snapshot.
- [x] Persist selected-game live score/state back to D1 and run a minute-level NHL scoreboard sync for the global match list.
- [x] Add live SOG, hits, PIM and faceoff metrics from NHL play-by-play.
- [x] Reject weak “5:1 shots therefore match winner” logic; moneyline pressure needs a larger sample, >=70% shot share and no >1-goal deficit.
- [x] Use real offered Winline moneyline/next-goal/period-result markets as conservative fallback cards when a strong live context exists, so exact synthetic-line matching does not empty the queue.
- [x] Make live copy concrete: score, exact shot split and time window are visible in the headline/subtitle.
- [x] Add cache-busting and an automatic watchdog to the OBS overlay so a stuck Browser Source recovers without manual reload.
- [x] Cover score repaint, live metrics, weak-signal rejection, provider-driven fallback and overlay watchdog with product CI.
'''
    write(docs,text)

print("PATCH_APPLIED")
