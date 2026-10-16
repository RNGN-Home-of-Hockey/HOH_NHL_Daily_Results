// The ratings of the game NHL 27 for the player portrait, read outside Cloudflare: EA's site did not give them to the Worker
// (2026-10-17), so GitHub Actions reads the same pages twice a week and writes the same rows the Worker would
// (storeGameRatings of telegram-center-v31-player-profile.js, with its matching to NHL ids) into D1 through wrangler.
// Only counts are printed: the logs of the public repo never carry the ratings themselves.
//   node tools/import_game_ratings.mjs           (needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fetchGameRatings, storeGameRatings } from "../cloudflare-worker/src/telegram-center-v31-player-profile.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const MIN_MATCHED = 100;

// a value as an SQL literal: text with doubled quotes, numbers as they are
export function literal(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  return `'${String(v).replace(/'/g, "''")}'`;
}
export function inline(sql, args) {
  let i = 0;
  return sql.replace(/\?/g, () => literal(args[i++]));
}

// storeGameRatings run against a recorder: the players and teams read before, every write turned into one SQL statement
export async function ratingsSql(data, players, teams, now = Date.now()) {
  const out = [];
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    all: async () => ({ results: /FROM players/.test(sql) ? players : /FROM teams/.test(sql) ? teams : [] }),
    first: async () => null,
    run: async () => { out.push(`${inline(sql.trim().replace(/\s+/g, " "), args).replace(/;?$/, ";")}`); return {}; },
  });
  const db = { prepare: (sql) => stmt(sql), batch: async (list) => { for (const s of list) await s.run(); return []; } };
  const result = await storeGameRatings(db, data, now);
  return { sql: out.join("\n"), result };
}

function d1(args) {
  return execFileSync(process.execPath, [WRANGLER, "d1", "execute", "hoh-data-core", "--remote", ...args], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 });
}
function d1Rows(sql) {
  const text = d1(["--json", "--command", sql]);
  const data = JSON.parse(text.slice(text.search(/\[\s*\{\s*"results"/)));
  return data[0].results || [];
}

async function main() {
  const players = d1Rows("SELECT player_id,full_name_en,last_name_en,current_team_tri,sweater_number FROM players;");
  const teams = d1Rows("SELECT tri_code,name_en FROM teams;");
  const data = await fetchGameRatings(fetch);
  const { sql, result } = await ratingsSql(data, players, teams);
  console.log(`${result.game}: ${data.items.length} players on EA's site, ${result.players} found among ours, ${result.missed} not found`);
  if (result.players < MIN_MATCHED) throw new Error(`too few players matched (${result.players}): nothing written`);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hoh-ratings-")), "ratings.sql");
  fs.writeFileSync(file, sql);
  d1(["--file", file]);
  const [check] = d1Rows("SELECT COUNT(*) AS n FROM player_game_ratings;");
  console.log(`player_game_ratings rows: ${check.n}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(String(error?.message || error)); process.exit(1); });
}
