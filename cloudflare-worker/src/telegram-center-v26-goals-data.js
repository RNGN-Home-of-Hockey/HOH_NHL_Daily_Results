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

function clipFrom(entry, base) {
  if (!entry?.orig?.path) return null;
  return {
    state: "ready",
    orig_url: clipUrl(base, entry.orig.path),
    light_url: entry.light?.path ? clipUrl(base, entry.light.path) : null,
    poster_url: entry.poster ? clipUrl(base, entry.poster) : null,
    duration: num(entry.duration),
    orig_bytes: num(entry.orig.bytes),
    light_bytes: num(entry.light?.bytes),
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

// ---- goals of one player (every clip in the index where this player scored) ------------------------------------------

const plain = (name) =>
  String(name || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");

const clockSeconds = (value) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

const mmss = (seconds) => `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;

// NHL game ids: 2026 | 02 regular season / 03 playoffs | number. Regular season: OT is 5 minutes and the 5th period is the shootout.
function periodOfClip(gamePk, number) {
  const playoffs = Math.floor(gamePk / 10000) % 100 === 3;
  if (number <= 3) return { period: periodInfo({ number, periodType: "REG" }), length: 1200 };
  if (playoffs) return { period: periodInfo({ number, periodType: "OT" }), length: 1200 };
  if (number === 4) return { period: periodInfo({ number, periodType: "OT" }), length: 300 };
  return { period: periodInfo({ number, periodType: "SO" }), length: null };
}

const isoDate = (yyyymmdd) => {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(yyyymmdd || ""));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

export function buildPlayerGoalsPayload({ playerId, nameEn = null, nameRu = null, index = null, indexOk = false, clipsBase = DEFAULT_CLIPS_BASE }) {
  const games = indexOk && Array.isArray(index?.games) ? index.games : [];
  const wanted = plain(nameEn);
  const seen = new Set();
  const found = [];
  let since = null;
  for (const game of games) {
    const pk = num(game?.game_pk);
    const date = isoDate(game?.date);
    if (date && (!since || date < since)) since = date;
    if (!pk) continue;
    for (const c of game.goals || []) {
      const byId = num(c?.scorer_id) === playerId;
      const byName = num(c?.scorer_id) === null && wanted && plain(c?.scorer) === wanted;
      if (!byId && !byName) continue;
      const key = `${pk}:${num(c?.event_id)}`;
      if (seen.has(key)) continue;
      const clip = clipFrom(c, clipsBase);
      if (!clip) continue;
      seen.add(key);
      const { period, length } = periodOfClip(pk, num(c?.period) ?? 0);
      const remaining = clockSeconds(c?.time_remaining);
      const elapsed = length !== null && remaining !== null ? Math.max(0, length - remaining) : null;
      const team = text(c?.team) || null;
      found.push({
        game_pk: pk,
        date,
        away: text(game.away) || null,
        home: text(game.home) || null,
        kind: game.kind === "vod" ? "vod" : "live",
        event_id: num(c?.event_id),
        period,
        time: elapsed === null ? null : mmss(elapsed),
        team,
        opponent: team && team === text(game.away) ? text(game.home) || null : text(game.away) || null,
        score_after: { away: num(c?.away_score), home: num(c?.home_score) },
        clip,
        _order: [period.number, elapsed ?? 99999],
      });
    }
  }
  found.sort((a, b) =>
    String(b.date || "").localeCompare(String(a.date || "")) || b.game_pk - a.game_pk || a._order[0] - b._order[0] || a._order[1] - b._order[1]);
  for (const g of found) delete g._order;
  return {
    ok: true,
    version: 1,
    player: { id: playerId, name_en: nameEn || null, name_ru: nameRu || null },
    server_ok: Boolean(indexOk),
    since,
    games: new Set(found.map((g) => g.game_pk)).size,
    total: found.length,
    goals: found,
  };
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
      let clip = clipEntry ? clipFrom(clipEntry, clipsBase) : null;
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
    goals,
    clips: {
      server_ok: Boolean(indexOk),
      available: Boolean(indexGame),
      ready,
      total: goals.length,
      all_goals: indexGame?.all_goals ? clipFrom(indexGame.all_goals, clipsBase) : null,
      ending: indexGame?.ending ? { ...clipFrom(indexGame.ending, clipsBase), kind: indexGame.ending.kind || null } : null,
    },
    shootout: Boolean(landing?.summary?.shootout?.length),
  };
}
