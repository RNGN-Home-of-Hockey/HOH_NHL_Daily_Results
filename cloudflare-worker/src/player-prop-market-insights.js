import { withDemoOdds } from "./demo-winline-odds.js";

const WINDOW_MIN_RATE = new Map([[5,0.80],[10,0.70],[20,0.65]]);

export async function buildPlayerPropMarketInsights(db, game) {
  if (!db || !game?.scheduled_start_utc || !game?.away_tri || !game?.home_tri) return [];
  const [rollingR,opponentR] = await db.batch([
    db.prepare(`
      SELECT s.*,p.full_name_en,p.full_name_ru,p.sweater_number,p.position_code
      FROM player_market_snapshots s
      JOIN players p ON p.player_id=s.player_id
      WHERE s.snapshot_type='rolling'
        AND s.scope_key IN ('5','10','20')
        AND s.team_tri IN (?,?)
        AND s.as_of_utc<?
      ORDER BY s.team_tri,s.player_id,CAST(s.scope_key AS INTEGER);
    `).bind(game.away_tri,game.home_tri,game.scheduled_start_utc),
    db.prepare(`
      SELECT s.*,p.full_name_en,p.full_name_ru,p.sweater_number,p.position_code
      FROM player_market_snapshots s
      JOIN players p ON p.player_id=s.player_id
      WHERE s.snapshot_type='opponent' AND s.scope_key='2Y'
        AND ((s.team_tri=? AND s.opponent_tri=?) OR (s.team_tri=? AND s.opponent_tri=?))
        AND s.as_of_utc<? AND s.games>=4
      ORDER BY s.games DESC,s.player_id;
    `).bind(game.away_tri,game.home_tri,game.home_tri,game.away_tri,game.scheduled_start_utc),
  ]);
  return evaluatePlayerPropMarketInsights(game,rollingR.results||[],opponentR.results||[]);
}

export function evaluatePlayerPropMarketInsights(game, rollingRows, opponentRows) {
  const cards=[];
  for(const row of rollingRows||[]) cards.push(...rollingCards(game,row));
  for(const row of opponentRows||[]) cards.push(...opponentCards(game,row));
  return select(cards,game,14);
}

function rollingCards(game,row){
  const games=Number(row.games||0),window=Number(row.scope_key||0);
  if(![5,10,20].includes(window)||games<window)return[];
  const min=WINDOW_MIN_RATE.get(window)||0.65;
  const name=playerName(row);const cards=[];

  const assistRate=rate(row.games_with_assist,games);
  if(assistRate>=min)cards.push(card({game,row,name,category:'player_prop_market',type:`player_assist_o05_w${window}`,score:score(window,assistRate,min),eyebrow:`ПЕРЕДАЧИ · ${window} МАТЧЕЙ`,value:`${row.games_with_assist}/${games}`,title:`${name} делал передачу в ${row.games_with_assist} из последних ${games} матчей`,explanation:'Hit-rate минимум одной передачи по официальным NHL boxscore.',evidence:{window,games,hits:Number(row.games_with_assist),hit_rate:assistRate,assists_pg:Number(row.assists_pg),feature_layer:'player_market_snapshots_v1'},market:{type:'player_assists',period:'GAME',subject:String(row.player_id),player_id:Number(row.player_id),player_name:name,side:'over',line:0.5,label:`${name} ТБ 0.5 передачи`}}));

  const shot=bestThreshold(row,games,[
    ['games_with_5plus_shots',4.5,Math.max(.45,min-.18)],
    ['games_with_4plus_shots',3.5,Math.max(.55,min-.12)],
    ['games_with_3plus_shots',2.5,Math.max(.65,min-.05)],
    ['games_with_2plus_shots',1.5,min],
  ]);
  if(shot)cards.push(card({game,row,name,category:'player_prop_market',type:`player_shots_o${String(shot.line).replace('.','')}_w${window}`,score:score(window,shot.rate,shot.floor),eyebrow:`БРОСКИ · ${window} МАТЧЕЙ`,value:`${shot.hits}/${games}`,title:`${name} пробивал ${shot.line} броска в ${shot.hits} из последних ${games} матчей`,explanation:`Точная линия по броскам в створ. Среднее на отрезке: ${Number(row.shots_pg||0).toFixed(1)}.`,evidence:{window,games,hits:shot.hits,hit_rate:shot.rate,shots_pg:Number(row.shots_pg),feature_layer:'player_market_snapshots_v1'},market:{type:'player_shots',period:'GAME',subject:String(row.player_id),player_id:Number(row.player_id),player_name:name,side:'over',line:shot.line,label:`${name} ТБ ${shot.line} броска`}}));

  const hits=bestThreshold(row,games,[
    ['games_with_3plus_hits',2.5,Math.max(.58,min-.08)],
    ['games_with_2plus_hits',1.5,Math.max(.68,min-.02)],
  ]);
  if(hits)cards.push(card({game,row,name,category:'player_prop_market',type:`player_hits_o${String(hits.line).replace('.','')}_w${window}`,score:score(window,hits.rate,hits.floor)-2,eyebrow:`ХИТЫ · ${window} МАТЧЕЙ`,value:`${hits.hits}/${games}`,title:`${name} проходил линию ${hits.line} хита в ${hits.hits} из ${games} матчей`,explanation:`Физическая активность по официальным NHL boxscore. Среднее: ${Number(row.hits_pg||0).toFixed(1)} хита.`,evidence:{window,games,hits:hits.hits,hit_rate:hits.rate,hits_pg:Number(row.hits_pg),feature_layer:'player_market_snapshots_v1'},market:{type:'player_hits',period:'GAME',subject:String(row.player_id),player_id:Number(row.player_id),player_name:name,side:'over',line:hits.line,label:`${name} ТБ ${hits.line} хита`}}));

  const blockRate=rate(row.games_with_2plus_blocks,games);
  const blockFloor=Math.max(.65,min-.04);
  if(blockRate>=blockFloor)cards.push(card({game,row,name,category:'player_prop_market',type:`player_blocks_o15_w${window}`,score:score(window,blockRate,blockFloor)-3,eyebrow:`БЛОКИ · ${window} МАТЧЕЙ`,value:`${row.games_with_2plus_blocks}/${games}`,title:`${name} делал 2+ блока в ${row.games_with_2plus_blocks} из ${games} матчей`,explanation:`Компактный hit-rate блокированных бросков. Среднее: ${Number(row.blocked_shots_pg||0).toFixed(1)}.`,evidence:{window,games,hits:Number(row.games_with_2plus_blocks),hit_rate:blockRate,blocked_shots_pg:Number(row.blocked_shots_pg),feature_layer:'player_market_snapshots_v1'},market:{type:'player_blocks',period:'GAME',subject:String(row.player_id),player_id:Number(row.player_id),player_name:name,side:'over',line:1.5,label:`${name} ТБ 1.5 блока`}}));
  return cards;
}

function opponentCards(game,row){
  const games=Number(row.games||0);if(games<4)return[];
  const name=playerName(row),cards=[];
  const assistRate=rate(row.games_with_assist,games);
  if(assistRate>=.65)cards.push(card({game,row,name,category:'player_prop_h2h',type:'player_assist_o05_h2h',score:75+Math.min(12,Math.round((assistRate-.65)*30))+Math.min(5,games-4),eyebrow:`ПЕРЕДАЧИ vs ${row.opponent_tri}`,value:`${row.games_with_assist}/${games}`,title:`${name} делал передачу в ${row.games_with_assist} из ${games} матчей против ${row.opponent_tri}`,explanation:'Opponent split по локальному двухсезонному архиву NHL.',evidence:{games,hits:Number(row.games_with_assist),hit_rate:assistRate,opponent:row.opponent_tri,scope:'2Y',feature_layer:'player_market_snapshots_v1'},market:{type:'player_assists',period:'GAME',subject:String(row.player_id),player_id:Number(row.player_id),player_name:name,side:'over',line:.5,label:`${name} ТБ 0.5 передачи`}}));
  const shot=bestThreshold(row,games,[['games_with_5plus_shots',4.5,.50],['games_with_4plus_shots',3.5,.58],['games_with_3plus_shots',2.5,.65],['games_with_2plus_shots',1.5,.72]]);
  if(shot)cards.push(card({game,row,name,category:'player_prop_h2h',type:`player_shots_o${String(shot.line).replace('.','')}_h2h`,score:76+Math.min(14,Math.round((shot.rate-shot.floor)*34))+Math.min(5,games-4),eyebrow:`БРОСКИ vs ${row.opponent_tri}`,value:`${shot.hits}/${games}`,title:`${name} пробивал ${shot.line} броска в ${shot.hits} из ${games} матчей против ${row.opponent_tri}`,explanation:'Точная opponent-specific линия по броскам; используется как подтверждение rolling-формы.',evidence:{games,hits:shot.hits,hit_rate:shot.rate,shots_pg:Number(row.shots_pg),opponent:row.opponent_tri,scope:'2Y',feature_layer:'player_market_snapshots_v1'},market:{type:'player_shots',period:'GAME',subject:String(row.player_id),player_id:Number(row.player_id),player_name:name,side:'over',line:shot.line,label:`${name} ТБ ${shot.line} броска`}}));
  return cards;
}

function bestThreshold(row,games,definitions){for(const [key,line,floor] of definitions){const hits=Number(row[key]||0),r=rate(hits,games);if(r>=floor)return{key,line,floor,hits,rate:r}}return null}
function rate(hits,games){return games>0?Number(hits||0)/games:0}
function score(window,hitRate,floor){const sample=window===20?8:window===10?5:2;return Math.min(97,76+sample+Math.round(Math.max(0,hitRate-floor)*28))}
function playerName(row){return row.full_name_ru||row.full_name_en||`NHL ${row.player_id}`}
function card({game,row,name,category,type,score,eyebrow,value,title,explanation,evidence,market}){const id=`${game.game_pk}:${type}:${row.player_id}:${row.opponent_tri||row.scope_key}`;const priced=withDemoOdds(market,id);return{id,insight_type:type,category,kind:'history',timing:'pregame',score,eyebrow,value,title,explanation,evidence:{...evidence,player_id:Number(row.player_id),team_tri:row.team_tri,position_code:row.position_code||null},note:`${priced.label} · WINLINE · ДЕМО-КЭФ ${priced.odds.toFixed(2)} · промокод HOH`,market:priced}}
function select(cards,game,limit){const best=new Map();for(const c of cards){const m=c.market||{};const key=`${c.category}:${m.type}:${m.subject}:${m.side}:${m.line}`;const prev=best.get(key);if(!prev||Number(c.score)>Number(prev.score))best.set(key,c)}const sorted=[...best.values()].sort((a,b)=>Number(b.score)-Number(a.score));const out=[],perTeam=new Map();for(const c of sorted){const team=c.evidence?.team_tri||'player';const used=perTeam.get(team)||0;if(used>=5)continue;out.push(c);perTeam.set(team,used+1);if(out.length>=limit)break}return out}
