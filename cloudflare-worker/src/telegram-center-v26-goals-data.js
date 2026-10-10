// Goals of one game for the Live Center: the NHL landing feed (who scored, assists, strength, score after the goal)
// joined with the goals index published by the highlights server (the playable clips).
//
// A goal and its clip are the same thing: the NHL `eventId` of the goal is the `event_id` the highlights engine
// stores for the clip, so the join is exact. Names are Russian when the database knows the player.

export const DEFAULT_CLIPS_BASE = "https://72-56-13-100.sslip.io";
const CLIP_PENDING_WINDOW_MS = 4 * 60 * 60 * 1000;

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const text = (v) => {
  if (v && typeof v === "object") return String(v.default ?? "").trim();
  return String(v ?? "").trim();
};

export function periodInfo(descriptor) {
  const n = num(descriptor?.number) ?? 0;
  const type = String(descriptor?.periodType || "REG").toUpperCase();
  if (type === "SO") return { number: n, type, label_ru: "Буллиты", short_ru: "Б" };
  if (type === "OT") return { number: n, type, label_ru: n > 4 ? `${n - 3}-й овертайм` : "Овертайм", short_ru: "ОТ" };
  return { number: n, type: "REG", label_ru: `${n}-й период`, short_ru: `${n}-й` };
}

export function phaseOf(gameState) {
  const s = String(gameState || "").toUpperCase();
  if (s === "LIVE" || s === "CRIT") return "live";
  if (s === "FINAL" || s === "OFF") return "final";
  if (s === "PPD" || s === "SUSP" || s === "CAN") return "postponed";
  return "upcoming";
}

function stateInfo(landing) {
  const phase = phaseOf(landing?.gameState);
  const period = periodInfo(landing?.periodDescriptor);
  const clock = landing?.clock || {};
  const intermission = phase === "live" && clock.inIntermission === true;
  let label = "";
  if (phase === "live") {
    label = intermission ? "Перерыв" : `${period.label_ru}${clock.timeRemaining ? ` · ${clock.timeRemaining}` : ""}`;
  } else if (phase === "final") {
    label = period.type === "OT" ? "Финал · ОТ" : period.type === "SO" ? "Финал · Б" : "Финал";
  } else if (phase === "postponed") {
    label = "Матч перенесён";
  } else {
    label = "Скоро";
  }
  return {
    phase,
    code: String(landing?.gameState || "").toUpperCase(),
    label_ru: label,
    period,
    clock: phase === "live" ? text(clock.timeRemaining) || null : null,
    running: phase === "live" && clock.running === true,
    intermission,
  };
}

function strengthInfo(strength) {
  const s = String(strength || "ev").toLowerCase();
  if (s === "pp") return { strength: "pp", strength_label_ru: "большинство" };
  if (s === "sh") return { strength: "sh", strength_label_ru: "меньшинство" };
  return { strength: "ev", strength_label_ru: null };
}

function modifierInfo(modifier) {
  const m = String(modifier || "none").toLowerCase();
  if (m === "empty-net") return { modifier: "empty-net", modifier_label_ru: "в пустые ворота" };
  if (m === "penalty-shot") return { modifier: "penalty-shot", modifier_label_ru: "штрафной бросок" };
  if (m === "own-goal") return { modifier: "own-goal", modifier_label_ru: "автогол" };
  return { modifier: null, modifier_label_ru: null };
}

export function playerIdsOf(landing) {
  const ids = new Set();
  for (const period of landing?.summary?.scoring || []) {
    for (const goal of period?.goals || []) {
      const id = num(goal?.playerId);
      if (id) ids.add(id);
      for (const a of goal?.assists || []) {
        const aid = num(a?.playerId);
        if (aid) ids.add(aid);
      }
    }
  }
  return [...ids];
}

function englishName(first, last) {
  return [text(first), text(last)].filter(Boolean).join(" ");
}

function person(id, first, last, names, extra = {}) {
  const known = names?.get ? names.get(id) : names?.[id];
  const en = englishName(first, last);
  return { id, name_ru: (known && String(known).trim()) || null, name_en: en || null, ...extra };
}

function clipUrl(base, path) {
  if (!path) return null;
  const clean = String(path).replace(/^\/+/, "");
  return `${String(base).replace(/\/+$/, "")}/${clean}`;
}

// A clip is one video file: the 1080p copy made for the app (the "light" file on the server). The full-bitrate original stays
// on the server and is never offered; it is only the fallback when a goal has no app copy yet.
function clipOf(entry, base) {
  const light = entry?.light?.path ? entry.light : null;
  const file = light || (entry?.orig?.path ? entry.orig : null);
  if (!file) return null;
  return {
    state: "ready",
    url: clipUrl(base, file.path),
    poster_url: entry.poster ? clipUrl(base, entry.poster) : null,
    duration: num(entry.duration),
    bytes: num(file.bytes),
  };
}

function findIndexGame(index, gamePk) {
  const games = Array.isArray(index?.games) ? index.games : [];
  // the same game can appear twice (an old VOD cut and a live cut): prefer the one with more goals
  return games
    .filter((g) => num(g?.game_pk) === gamePk)
    .sort((a, b) => (b.goals?.length || 0) - (a.goals?.length || 0))[0] || null;
}

function matchClip(indexGame, goal) {
  const goals = indexGame?.goals || [];
  const byEvent = goals.find((c) => num(c?.event_id) !== null && num(c.event_id) === num(goal.eventId));
  if (byEvent) return byEvent;
  return goals.find((c) =>
    num(c?.scorer_id) === num(goal.playerId) &&
    num(c?.away_score) === num(goal.awayScore) &&
    num(c?.home_score) === num(goal.homeScore)) || null;
}

// The 1X2 line of the bookmaker is settled on regulation time: a game decided in overtime or a shootout is a draw ("X").
export function regulationResult(landing) {
  if (phaseOf(landing?.gameState) !== "final") return null;
  const lastPeriod = String(landing?.periodDescriptor?.periodType || "REG").toUpperCase();
  if (lastPeriod === "OT" || lastPeriod === "SO") return "X";
  const away = num(landing?.awayTeam?.score);
  const home = num(landing?.homeTeam?.score);
  if (away === null || home === null) return null;
  return home > away ? "1" : home < away ? "2" : "X";
}

function coverUrlOf(index, indexOk, gamePk, base) {
  if (!indexOk) return null;
  const entry = index?.covers?.[String(gamePk)];
  if (!entry?.path) return null;
  const v = num(entry.mtime) ?? num(entry.bytes) ?? 0;
  return `${clipUrl(base, entry.path)}?v=${v}`;
}

export function buildGoalsPayload({ gamePk, landing, index = null, indexOk = false, names = null, now = Date.now(), clipsBase = DEFAULT_CLIPS_BASE }) {
  const state = stateInfo(landing);
  const startMs = Date.parse(String(landing?.startTimeUTC || ""));
  const recentlyStarted = Number.isFinite(startMs) && now - startMs < CLIP_PENDING_WINDOW_MS;
  const indexGame = indexOk ? findIndexGame(index, gamePk) : null;
  const goals = [];
  for (const periodBlock of landing?.summary?.scoring || []) {
    const period = periodInfo(periodBlock?.periodDescriptor);
    for (const g of periodBlock?.goals || []) {
      const id = num(g?.playerId);
      const clipEntry = indexGame ? matchClip(indexGame, g) : null;
      let clip = clipEntry ? clipOf(clipEntry, clipsBase) : null;
      if (!clip) {
        const waiting = indexOk && (state.phase === "live" || (state.phase === "final" && recentlyStarted));
        clip = { state: waiting ? "pending" : "none" };
      }
      goals.push({
        event_id: num(g?.eventId),
        period,
        time: text(g?.timeInPeriod) || null,
        team: text(g?.teamAbbrev) || null,
        side: g?.isHome === true ? "home" : g?.isHome === false ? "away" : null,
        score_after: { away: num(g?.awayScore), home: num(g?.homeScore) },
        ...strengthInfo(g?.strength),
        ...modifierInfo(g?.goalModifier),
        scorer: person(id, g?.firstName, g?.lastName, names, {
          headshot: g?.headshot || null,
          goals_to_date: num(g?.goalsToDate),
        }),
        assists: (g?.assists || []).map((a) => person(num(a?.playerId), a?.firstName, a?.lastName, names, { sweater: num(a?.sweaterNumber) })),
        clip,
      });
    }
  }
  const ready = goals.filter((g) => g.clip.state === "ready").length;
  return {
    ok: true,
    version: 1,
    game_pk: gamePk,
    state,
    teams: {
      away: { tri: text(landing?.awayTeam?.abbrev) || null, score: num(landing?.awayTeam?.score), shots: num(landing?.awayTeam?.sog) },
      home: { tri: text(landing?.homeTeam?.abbrev) || null, score: num(landing?.homeTeam?.score), shots: num(landing?.homeTeam?.sog) },
    },
    result: regulationResult(landing),
    cover_url: coverUrlOf(index, indexOk, gamePk, clipsBase),
    goals,
    clips: {
      server_ok: Boolean(indexOk),
      available: Boolean(indexGame),
      ready,
      total: goals.length,
    },
    shootout: Boolean(landing?.summary?.shootout?.length),
  };
}

// ---- every goal of one player in a season, with or without video -------------------------------------------------------
// `log` is the NHL game log of the player (one row per game he played), `landings` maps a game id to its landing feed.
// Games without a loaded landing feed are counted in `missing` so the page can say that the list is incomplete.
export function buildPlayerSeasonPayload({ playerId, names = {}, season = null, log = [], landings = new Map(), index = null, indexOk = false, clipsBase = DEFAULT_CLIPS_BASE, now = Date.now(), truncated = false }) {
  const rows = [...log].filter((r) => num(r?.goals) > 0).sort((a, b) => String(b.gameDate || "").localeCompare(String(a.gameDate || "")) || num(b.gameId) - num(a.gameId));
  const goals = [];
  let missing = 0;
  for (const row of rows) {
    const gamePk = num(row.gameId);
    const expected = num(row.goals) || 0;
    const landing = landings instanceof Map ? landings.get(gamePk) : landings?.[gamePk];
    if (!landing) { missing += expected; continue; }
    const game = buildGoalsPayload({ gamePk, landing, index, indexOk, now, clipsBase });
    const mine = game.goals.filter((g) => g.scorer.id === playerId);
    if (mine.length < expected) missing += expected - mine.length;
    for (const g of mine) {
      goals.push({
        game_pk: gamePk,
        date: text(row.gameDate) || null,
        away: game.teams.away.tri,
        home: game.teams.home.tri,
        opponent: text(row.opponentAbbrev) || null,
        event_id: g.event_id,
        period: g.period,
        time: g.time,
        team: g.team,
        score_after: g.score_after,
        strength_label_ru: g.strength_label_ru,
        modifier_label_ru: g.modifier_label_ru,
        clip: g.clip,
      });
    }
  }
  goals.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")) || b.game_pk - a.game_pk || a.period.number - b.period.number || String(a.time || "").localeCompare(String(b.time || "")));
  return {
    ok: true,
    version: 2,
    player: { id: playerId, name_en: names?.nameEn || null, name_ru: names?.nameRu || null },
    season,
    server_ok: Boolean(indexOk),
    total: goals.length + missing,
    listed: goals.length,
    with_video: goals.filter((g) => g.clip.state === "ready").length,
    games: new Set(goals.map((g) => g.game_pk)).size,
    missing,
    truncated: Boolean(truncated),
    goals,
  };
}
