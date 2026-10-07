import fs from 'node:fs';
import { chromium } from 'playwright';

const OUTPUT = process.env.WINLINE_SQL_OUTPUT || 'winline_sync.sql';
const CHAMPIONSHIP_ID = 9154;
const BASE = 'https://winline.ru/stavki/sport/basketbol/ssha/nba';
const KNOWN_MARKETS = new Set([491, 1049, 1050, 1051, 1073]);

const TEAM_ALIASES = {
  ATL:['Атланта'], BOS:['Бостон'], BKN:['Бруклин'], CHA:['Шарлотт'], CHI:['Чикаго'],
  CLE:['Кливленд'], DAL:['Даллас'], DEN:['Денвер'], DET:['Детройт'], GSW:['Голден Стэйт','Голден Стейт'],
  HOU:['Хьюстон'], IND:['Индиана'], LAC:['Л-А Клипперс','ЛА Клипперс'], LAL:['Л-А Лейкерс','ЛА Лейкерс'],
  MEM:['Мемфис'], MIA:['Майами'], MIL:['Милуоки'], MIN:['Миннесота'], NOP:['Нью-Орлеан','Нью Орлеан'],
  NYK:['Нью-Йорк','Нью Йорк'], OKC:['Оклахома'], ORL:['Орландо'], PHI:['Филадельфия'], PHX:['Финикс'],
  POR:['Портленд'], SAC:['Сакраменто'], SAS:['Сан-Антонио','Сан Антонио'], TOR:['Торонто'], UTA:['Юта'], WAS:['Вашингтон']
};

function norm(s){ return String(s||'').toLowerCase().replace(/ё/g,'е').replace(/[^a-zа-я0-9]+/g,''); }
const TEAM_LOOKUP = new Map();
for (const [abbr,names] of Object.entries(TEAM_ALIASES)) for (const name of names) TEAM_LOOKUP.set(norm(name), abbr);
function teamAbbr(name){ return TEAM_LOOKUP.get(norm(name)) || null; }
function esc(s){ return `'${String(s ?? '').replace(/'/g, "''")}'`; }
function sqlNum(x){ const n=Number(x); return Number.isFinite(n) ? String(n) : 'NULL'; }
function isoDate(value){ const d=new Date(value); if(Number.isNaN(d.getTime())) throw new Error(`Invalid Winline event date: ${value}`); return d.toISOString(); }
function playerish(row){
  if (KNOWN_MARKETS.has(Number(row.market_id))) return false;
  const text = norm(`${row.market_name||''} ${(row.R||[]).join(' ')} ${row.koef||''}`);
  return /(игрок|player|очкиигрок|подбор|передач|трехоч|блокшот|стил|перехват)/.test(text);
}

function normalizeEvent(event, fetchedAt){
  const [team1, team2] = event.members || [];
  const a1 = teamAbbr(team1), a2 = teamAbbr(team2);
  if (!team1 || !team2 || !a1 || !a2) throw new Error(`Unknown NBA team mapping: ${JSON.stringify(event.members)}`);
  const startTime=isoDate(event.start_time);
  const out = new Map();
  let playerProps = 0;
  const add = (key, marketId, type, entityType, entityName, entityAbbr, side, line, odds, marketLabel, selectionLabel, raw) => {
    const nOdds=Number(odds); if (!Number.isFinite(nOdds) || nOdds <= 1) return;
    out.set(key,{key,marketId,type,entityType,entityName,entityAbbr,side,line,odds:nOdds,marketLabel,selectionLabel,raw});
  };
  for (const r of event.rows || []) {
    const mid=Number(r.market_id), V=Array.isArray(r.V)?r.V:[], kv=String(r.koef ?? '');
    if (playerish(r)) playerProps += 1;
    if (mid === 491 && V.length >= 2) {
      add(`${event.event_id}:ml:${a1}`,mid,'moneyline','team',team1,a1,'WIN',null,V[0],'Исход 12',team1,r);
      add(`${event.event_id}:ml:${a2}`,mid,'moneyline','team',team2,a2,'WIN',null,V[1],'Исход 12',team2,r);
    } else if ([1049,1050,1051].includes(mid) && V.length >= 2) {
      const line=Number(kv); if (!Number.isFinite(line)) continue;
      let type, entityType, entityName, entityAbbr, label;
      if (mid===1049) { type='game_total'; entityType='game'; entityName=`${team1} — ${team2}`; entityAbbr=null; label='Тотал матча'; }
      if (mid===1050) { type='team_total'; entityType='team'; entityName=team1; entityAbbr=a1; label=`Тотал ${team1}`; }
      if (mid===1051) { type='team_total'; entityType='team'; entityName=team2; entityAbbr=a2; label=`Тотал ${team2}`; }
      add(`${event.event_id}:${type}:${entityAbbr||'MATCH'}:${line}:O`,mid,type,entityType,entityName,entityAbbr,'OVER',line,V[0],label,`ТБ ${line}`,r);
      add(`${event.event_id}:${type}:${entityAbbr||'MATCH'}:${line}:U`,mid,type,entityType,entityName,entityAbbr,'UNDER',line,V[1],label,`ТМ ${line}`,r);
    } else if (mid===1073 && V.length >= 2) {
      const line=Number(kv); if (!Number.isFinite(line)) continue;
      add(`${event.event_id}:spread:${a1}:${-line}`,mid,'spread','team',team1,a1,'COVER',-line,V[0],'Фора',`${team1} ${-line>0?'+':''}${-line}`,r);
      add(`${event.event_id}:spread:${a2}:${line}`,mid,'spread','team',team2,a2,'COVER',line,V[1],'Фора',`${team2} ${line>0?'+':''}${line}`,r);
    }
  }
  return {...event,start_time:startTime,team1,team2,a1,a2,markets:[...out.values()],playerProps,fetchedAt};
}

function makeSql(events, fetchedAt){
  const lines=['DELETE FROM nba_winline_markets;','DELETE FROM nba_winline_events;'];
  let marketCount=0, playerProps=0;
  for (const e of events) {
    marketCount += e.markets.length; playerProps += e.playerProps;
    lines.push(`INSERT OR REPLACE INTO nba_winline_events(event_id,championship_id,starts_at,team1_name,team2_name,team1_abbr,team2_abbr,source_url,market_count,player_props_count,fetched_at,raw_json) VALUES (${e.event_id},${e.championship_id},${esc(e.start_time)},${esc(e.team1)},${esc(e.team2)},${esc(e.a1)},${esc(e.a2)},${esc(`${BASE}/${e.event_id}`)},${e.markets.length},${e.playerProps},${esc(fetchedAt)},NULL);`);
    for (const m of e.markets) lines.push(`INSERT OR REPLACE INTO nba_winline_markets(market_key,event_id,market_id,market_type,entity_type,entity_name,entity_abbr,selection_side,line_value,odds,market_label,selection_label,fetched_at,raw_json) VALUES (${esc(m.key)},${e.event_id},${m.marketId},${esc(m.type)},${esc(m.entityType)},${esc(m.entityName)},${m.entityAbbr?esc(m.entityAbbr):'NULL'},${esc(m.side)},${m.line==null?'NULL':sqlNum(m.line)},${sqlNum(m.odds)},${esc(m.marketLabel)},${esc(m.selectionLabel)},${esc(fetchedAt)},${esc(JSON.stringify(m.raw))});`);
  }
  lines.push(`INSERT OR REPLACE INTO nba_winline_sync(source,fetched_at,event_count,market_count,player_props_count,status,note) VALUES ('winline',${esc(fetchedAt)},${events.length},${marketCount},${playerProps},'ok','Public Winline NBA preseason line via site websocket');`);
  return {sql:lines.join('\n')+'\n',marketCount,playerProps};
}

(async()=>{
  const fetchedAt=new Date().toISOString();
  const browser=await chromium.launch({headless:true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined});
  try {
    const page=await browser.newPage({viewport:{width:1280,height:720},locale:'ru-RU',timezoneId:'Europe/Moscow'});
    await page.goto(BASE,{waitUntil:'domcontentloaded',timeout:60000});
    await page.waitForFunction(() => window.apiWlb?.getEvents?.()?.dbCollection?.data?.length > 0,{timeout:30000});
    const baseEvents=await page.evaluate((championshipId)=>window.apiWlb.getEvents().dbCollection.data
      .filter(e=>Number(e.idChampionship)===championshipId && Number(e.idSport)===2)
      .map(e=>({event_id:e.id,start_time:new Date(e.date).toISOString(),members:e.members,championship_id:e.idChampionship})),CHAMPIONSHIP_ID);
    if (!baseEvents.length) throw new Error('No current NBA preseason Winline events found');
    const raw=[];
    for (const event of baseEvents) {
      await page.goto(`${BASE}/${event.event_id}`,{waitUntil:'domcontentloaded',timeout:60000});
      await page.waitForFunction(id=>{
        const e=window.apiWlb?.getEvents?.().byId?.(id);
        return e && e.linesByIdTipMarkets && Object.keys(e.linesByIdTipMarkets).length>0;
      },event.event_id,{timeout:25000}).catch(()=>{});
      await page.waitForTimeout(1200);
      const full=await page.evaluate((id)=>{
        const e=window.apiWlb?.getEvents?.().byId?.(id); if(!e) return null;
        const rows=[];
        for(const [marketId,arr] of Object.entries(e.linesByIdTipMarkets||{})) for(const l of (arr||[])) rows.push({market_id:Number(marketId),line_id:l.idLine||l.id,koef:l.koef,V:l.V,market_name:l.tipLine?.freeTextR||'',R:l.tipLine?.R||[],favorite:l.favorite||0});
        return {event_id:e.id,start_time:new Date(e.date).toISOString(),members:e.members,championship_id:e.idChampionship,rows};
      },event.event_id);
      if (full) raw.push(full);
    }
    if (!raw.length) throw new Error('Winline event details returned no data');
    const normalized=raw.map(e=>normalizeEvent(e,fetchedAt)).filter(e=>e.markets.length>0);
    if (!normalized.length) throw new Error('Winline returned no supported NBA markets');
    const result=makeSql(normalized,fetchedAt);
    fs.writeFileSync(OUTPUT,result.sql,'utf8');
    fs.writeFileSync(`${OUTPUT}.json`,JSON.stringify({fetchedAt,eventCount:normalized.length,marketCount:result.marketCount,playerPropsCount:result.playerProps,events:normalized.map(e=>({event_id:e.event_id,start_time:e.start_time,members:e.members,team1_abbr:e.a1,team2_abbr:e.a2,markets:e.markets.length,playerProps:e.playerProps}))},null,2),'utf8');
    console.log(`Winline NBA sync: ${normalized.length} events, ${result.marketCount} markets, ${result.playerProps} player-prop rows`);
  } finally { await browser.close(); }
})().catch(err=>{ console.error(err.stack||err); process.exit(1); });
