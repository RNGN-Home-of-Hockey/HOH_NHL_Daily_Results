import { withDemoOdds } from "./demo-winline-odds.js";

const WINDOWS = [5, 10, 20];
const POINT_THRESHOLDS = new Map([[5, 0.80], [10, 0.70], [20, 0.65]]);
const GOAL_THRESHOLDS = new Map([[5, 0.60], [10, 0.50], [20, 0.45]]);

export async function buildPlayerMarketInsights(db, game) {
  if (!db || !game?.game_pk || !game?.scheduled_start_utc || !game?.away_tri || !game?.home_tri) return [];

  const [rollingR, h2hR, goalieR] = await db.batch([
    db.prepare(`
      SELECT r.*,p.full_name_en,p.full_name_ru,p.sweater_number
      FROM player_rolling_snapshots r
      JOIN players p ON p.player_id=r.player_id
      WHERE r.team_tri IN (?,?)
        AND r.window_key IN ('5','10','20')
        AND r.as_of_utc<?
      ORDER BY r.team_tri,r.player_id,r.window_key;
    `).bind(game.away_tri, game.home_tri, game.scheduled_start_utc),
    db.prepare(`
      SELECT s.*,p.full_name_en,p.full_name_ru,p.sweater_number
      FROM player_opponent_splits s
      JOIN players p ON p.player_id=s.player_id
      WHERE s.scope_key='2Y'
        AND ((s.team_tri=? AND s.opponent_tri=?) OR (s.team_tri=? AND s.opponent_tri=?))
        AND s.last_game_utc<?
        AND s.games>=4
      ORDER BY s.points_pg DESC,s.games DESC
      LIMIT 30;
    `).bind(game.away_tri,game.home_tri,game.home_tri,game.away_tri,game.scheduled_start_utc),
    db.prepare(`
      SELECT r.*,p.full_name_en,p.full_name_ru,p.sweater_number
      FROM goalie_rolling_snapshots r
      JOIN players p ON p.player_id=r.player_id
      WHERE r.team_tri IN (?,?)
        AND r.window_key IN ('10','20')
        AND r.as_of_utc<?
      ORDER BY r.team_tri,r.player_id,r.window_key;
    `).bind(game.away_tri, game.home_tri, game.scheduled_start_utc),
  ]);

  return evaluatePlayerMarketInsights(game, rollingR.results || [], h2hR.results || [], goalieR.results || []);
}

export function evaluatePlayerMarketInsights(game, rollingRows, opponentRows, goalieRows) {
  const candidates = [];
  candidates.push(...rollingPlayerCards(game, rollingRows));
  candidates.push(...opponentPlayerCards(game, opponentRows));
  candidates.push(...goalieContextCards(game, goalieRows));
  return selectPlayerPortfolio(candidates, game);
}

function rollingPlayerCards(game, rows) {
  const cards = [];
  for (const row of rows || []) {
    const window = Number(row.window_key);
    if (!WINDOWS.includes(window) || Number(row.games || 0) < window) continue;
    const games = Number(row.games);
    const pointRate = Number(row.games_with_point || 0) / games;
    const goalRate = Number(row.games_with_goal || 0) / games;
    const twoPointRate = Number(row.games_with_2plus_points || 0) / games;
    const name = playerName(row);

    if (pointRate >= POINT_THRESHOLDS.get(window)) {
      cards.push(playerCard({
        game,row,window,name,
        category:"player_market",
        type:`player_point_o05_w${window}`,
        score:playerScore(window,pointRate,0.60),
        eyebrow:`ИГРОК · ПОСЛЕДНИЕ ${window}`,
        value:`${row.games_with_point}/${games}`,
        title:`${name} набрал очки в ${row.games_with_point} из последних ${games} матчей`,
        explanation:`Точный hit-rate по официальным NHL boxscore. Snapshot заканчивается ${formatDate(row.as_of_utc)} — до старта выбранного матча.`,
        evidence:{window,games,hits:Number(row.games_with_point),hit_rate:pointRate,points:Number(row.points),points_pg:Number(row.points_pg),feature_layer:"player_rolling_snapshots_v1"},
        market:{type:"player_points",period:"GAME",subject:String(row.player_id),player_id:Number(row.player_id),player_name:name,side:"over",line:0.5,label:`${name} ТБ 0.5 очка`},
      }));
    }

    if (goalRate >= GOAL_THRESHOLDS.get(window)) {
      cards.push(playerCard({
        game,row,window,name,
        category:"player_market",
        type:`player_goal_o05_w${window}`,
        score:playerScore(window,goalRate,0.40),
        eyebrow:`ГОЛЫ · ПОСЛЕДНИЕ ${window}`,
        value:`${row.games_with_goal}/${games}`,
        title:`${name} забивал в ${row.games_with_goal} из последних ${games} матчей`,
        explanation:`Частота матчей минимум с одним голом; это не вероятность гола в следующей игре.`,
        evidence:{window,games,hits:Number(row.games_with_goal),hit_rate:goalRate,goals:Number(row.goals),goals_pg:Number(row.goals_pg),feature_layer:"player_rolling_snapshots_v1"},
        market:{type:"player_goals",period:"GAME",subject:String(row.player_id),player_id:Number(row.player_id),player_name:name,side:"over",line:0.5,label:`${name} забьёт`},
      }));
    }

    if (window >= 10 && twoPointRate >= 0.40) {
      cards.push(playerCard({
        game,row,window,name,
        category:"player_market",
        type:`player_points_o15_w${window}`,
        score:playerScore(window,twoPointRate,0.30),
        eyebrow:`2+ ОЧКА · ПОСЛЕДНИЕ ${window}`,
        value:`${row.games_with_2plus_points}/${games}`,
        title:`${name} набирал 2+ очка в ${row.games_with_2plus_points} из последних ${games} матчей`,
        explanation:`Точная линия 1.5 по очкам; маленькая выборка не используется.`,
        evidence:{window,games,hits:Number(row.games_with_2plus_points),hit_rate:twoPointRate,feature_layer:"player_rolling_snapshots_v1"},
        market:{type:"player_points",period:"GAME",subject:String(row.player_id),player_id:Number(row.player_id),player_name:name,side:"over",line:1.5,label:`${name} ТБ 1.5 очка`},
      }));
    }
  }
  return cards;
}

function opponentPlayerCards(game, rows) {
  const cards = [];
  for (const row of rows || []) {
    const games = Number(row.games || 0);
    if (games < 4) continue;
    const pointRate = Number(row.games_with_point || 0) / games;
    if (pointRate < 0.70) continue;
    const name = playerName(row);
    const id = `${game.game_pk}:player-h2h:${row.player_id}:${row.opponent_tri}:points`;
    const market = withDemoOdds({
      type:"player_points",period:"GAME",subject:String(row.player_id),player_id:Number(row.player_id),player_name:name,
      side:"over",line:0.5,label:`${name} ТБ 0.5 очка`,
    },id);
    cards.push({
      id,
      insight_type:"player_opponent_points_o05",
      category:"player_h2h",
      kind:"history",
      timing:"pregame",
      score:Math.min(94,72 + Math.round(pointRate*16) + Math.min(6,games-4)),
      eyebrow:`ПРОТИВ ${row.opponent_tri} · 2 СЕЗОНА`,
      value:`${row.games_with_point}/${games}`,
      title:`${name} набрал очки в ${row.games_with_point} из ${games} матчей против ${row.opponent_tri}`,
      explanation:`Opponent split собран из официальных NHL game logs за локальный двухсезонный архив.`,
      evidence:{games,hits:Number(row.games_with_point),hit_rate:pointRate,points:Number(row.points),points_pg:Number(row.points_pg),team_tri:row.team_tri,opponent:row.opponent_tri,scope:"2Y",feature_layer:"player_opponent_splits_v1"},
      note:`${market.label} · WINLINE · ДЕМО-КЭФ ${market.odds.toFixed(2)} · промокод HOH`,
      market,
    });
  }
  return cards;
}

function goalieContextCards(game, rows) {
  const bestByGoalie = new Map();
  for (const row of rows || []) {
    const pid = Number(row.player_id);
    const current = bestByGoalie.get(pid);
    if (!current || Number(row.games || 0) > Number(current.games || 0)) bestByGoalie.set(pid,row);
  }
  const cards = [];
  for (const row of bestByGoalie.values()) {
    const games = Number(row.games || 0);
    const starts = Number(row.starts || 0);
    const sv = Number(row.save_pct);
    if (games < 10 || starts < Math.ceil(games*0.6) || !Number.isFinite(sv)) continue;
    let side = null;
    if (sv >= 0.920) side = "under";
    else if (sv <= 0.890) side = "over";
    if (!side) continue;
    const opponent = row.team_tri === game.home_tri ? game.away_tri : game.home_tri;
    const name = playerName(row);
    const id = `${game.game_pk}:goalie-context:${row.player_id}:${side}:w${games}`;
    const market = withDemoOdds({
      type:"team_total",period:"GAME",subject:opponent,side,line:2.5,
      label:`${opponent} ${side === "under" ? "ИТМ" : "ИТБ"} 2.5`,
    },id);
    cards.push({
      id,
      insight_type:`goalie_save_context_${side}`,
      category:"goalie_context",
      kind:"history",
      timing:"pregame",
      score:84,
      eyebrow:`ВРАТАРЬ · ${games} МАТЧЕЙ`,
      value:`${(sv*100).toFixed(1)}%`,
      title:`${name}: ${(sv*100).toFixed(1)}% отражённых бросков на отрезке ${games} матчей`,
      explanation:`Вратарская форма используется только как контекст к командному тоталу соперника, а не как самостоятельный прогноз.`,
      evidence:{player_id:Number(row.player_id),games,starts,save_pct:sv,goals_against_pg:Number(row.goals_against_pg),team_tri:row.team_tri,feature_layer:"goalie_rolling_snapshots_v1"},
      note:`${market.label} · WINLINE · ДЕМО-КЭФ ${market.odds.toFixed(2)} · промокод HOH`,
      market,
    });
  }
  return cards;
}

function playerCard({game,row,window,name,category,type,score,eyebrow,value,title,explanation,evidence,market}) {
  const id = `${game.game_pk}:${type}:${row.player_id}`;
  const priced = withDemoOdds(market,id);
  return {
    id,insight_type:type,category,kind:"history",timing:"pregame",score,
    eyebrow,value,title,explanation,
    evidence:{...evidence,player_id:Number(row.player_id),team_tri:row.team_tri,position_code:row.position_code || null},
    note:`${priced.label} · WINLINE · ДЕМО-КЭФ ${priced.odds.toFixed(2)} · промокод HOH`,
    market:priced,
  };
}

function selectPlayerPortfolio(cards, game) {
  // Keep one candidate per independent category + exact market. The global
  // portfolio later consolidates rolling + H2H into one card and preserves the
  // second category as supporting evidence.
  const bestByCategoryExact = new Map();
  for (const card of cards) {
    const market = card.market || {};
    const key = `${card.category}:${market.type}:${market.subject}:${market.side}:${market.line ?? ""}`;
    const current = bestByCategoryExact.get(key);
    const window = Number(card.evidence?.window || card.evidence?.games || 0);
    const currentWindow = Number(current?.evidence?.window || current?.evidence?.games || 0);
    if (!current || Number(card.score || 0) > Number(current.score || 0) || (Number(card.score || 0) === Number(current.score || 0) && window > currentWindow)) {
      bestByCategoryExact.set(key, card);
    }
  }

  const grouped = new Map();
  for (const card of bestByCategoryExact.values()) {
    const market = card.market || {};
    const exact = `${market.type}:${market.subject}:${market.side}:${market.line ?? ""}`;
    if (!grouped.has(exact)) grouped.set(exact, []);
    grouped.get(exact).push(card);
  }

  const candidates = [];
  for (const group of grouped.values()) {
    group.sort((a,b)=>categoryPriority(b.category)-categoryPriority(a.category) || Number(b.score||0)-Number(a.score||0));
    candidates.push(...group.slice(0,2));
  }
  candidates.sort((a,b)=>Number(b.score||0)-Number(a.score||0));

  const selected=[];
  const perTeam=new Map();
  for(const card of candidates){
    const team=card.evidence?.team_tri || teamForPlayerCard(card,game);
    const used=perTeam.get(team)||0;
    if(used>=5) continue;
    selected.push(card); perTeam.set(team,used+1);
    if(selected.length>=10) break;
  }
  return selected;
}

function categoryPriority(category) {
  if (category === "player_market") return 3;
  if (category === "player_h2h") return 2;
  if (category === "goalie_context") return 1;
  return 0;
}

function teamForPlayerCard(card, game) {
  if (card.market?.subject === game.away_tri || card.market?.subject === game.home_tri) {
    return card.market.subject === game.away_tri ? game.home_tri : game.away_tri;
  }
  return "player";
}

function playerScore(window, rate, floor) {
  const sampleBonus = window===20 ? 9 : window===10 ? 5 : 1;
  const edge = Math.max(0,rate-floor);
  return Math.min(97,76 + sampleBonus + Math.round(edge*24));
}

function playerName(row) {
  return row.full_name_ru || row.full_name_en || `NHL ${row.player_id}`;
}

function formatDate(value) {
  return String(value || "").slice(0,10);
}
