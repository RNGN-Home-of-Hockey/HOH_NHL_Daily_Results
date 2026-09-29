import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { broadcastGameLooksLive } from "../cloudflare-worker/src/broadcast-dashboard-v2.js";

const now=Date.parse("2026-09-29T21:12:00.000Z");

assert.equal(
  broadcastGameLooksLive({game_state:"LIVE",scheduled_start_utc:"2026-09-29T21:00:00.000Z"},now),
  true,
  "explicit LIVE state must stay visible"
);

assert.equal(
  broadcastGameLooksLive({game_state:"FUT",scheduled_start_utc:"2026-09-29T21:00:00.000Z"},now),
  true,
  "a just-started game must stay visible even if D1 still says FUT"
);

assert.equal(
  broadcastGameLooksLive({game_state:"FUT",scheduled_start_utc:"2026-09-29T12:00:00.000Z"},now),
  false,
  "the stale-state fallback is intentionally capped at eight hours"
);

assert.equal(
  broadcastGameLooksLive({game_state:"FINAL",scheduled_start_utc:"2026-09-29T21:00:00.000Z"},now),
  false,
  "final games are archive, not live"
);

const source=await readFile(new URL("../cloudflare-worker/src/broadcast-dashboard-v2.js",import.meta.url),"utf8");
assert.match(source,/datetime\(g\.scheduled_start_utc\) >= datetime\('now','-8 hours'\)/,"games SQL must retain just-started non-final games");
assert.match(source,/gameListTimer=setInterval\(refreshGameList,15000\)/,"games list must refresh while the control room is open");
assert.match(source,/if\(gameLooksLive\(l\.game\|\|currentData\?\.game\)&&!liveTimer\)/,"live endpoint must keep polling after puck drop even if the stored game state lags");
assert.match(source,/if\(broadcastGameLooksLive\(game\)\)return 90\*1000/,"started games must require fresh Winline pricing");

console.log("BROADCAST_LIVE_VISIBILITY_OK");
