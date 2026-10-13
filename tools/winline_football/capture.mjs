#!/usr/bin/env node
// Capture Winline football lines by reading the site's own data store in a real browser, the way
// tools/sync_winline_nba.js does for the NBA. One snapshot = every market line of every chosen event.
//
//   node capture.mjs [--championship 1] [--events 16745863,16745755] [--limit 30] [--out DIR] [--pause 2500] [--headed]
//
// championship 1 is the Premier League ("АПЛ"), sport 1 is football. Some market groups (players, quick markets)
// are loaded by the page only when their tab is opened, so every tab is clicked before the lines are read.
// Sequential, with a pause between events; stops at once if the site shows a challenge page.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { normalizeStoreEvent } from './catalogue.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LISTING = 'https://winline.ru/stavki/sport/futbol/angliya/apl';
const TABS = ['Игроки', 'Быстрые', 'Статистика', 'Угловые', 'Карточки', 'Комбо', 'Счет', 'Фора', 'Тотал', 'Исход'];

function parseArgs(argv) {
  const args = { championship: 1, events: [], limit: 30, pause: 2500, headed: false, out: path.resolve(HERE, '../../local-data/epl/winline') };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split('=');
    const take = () => inline ?? argv[++i];
    if (flag === '--championship') args.championship = Number(take());
    else if (flag === '--events') args.events = String(take()).split(',').map(Number).filter(Boolean);
    else if (flag === '--limit') args.limit = Number(take());
    else if (flag === '--pause') args.pause = Number(take());
    else if (flag === '--out') args.out = path.resolve(take());
    else if (flag === '--headed') args.headed = true;
    else throw new Error(`Unknown argument ${flag}`);
  }
  return args;
}

const log = (message) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);

async function launch(headed) {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
  const options = { headless: !headed, executablePath };
  if (!executablePath) options.channel = process.env.WINLINE_BROWSER_CHANNEL || 'chrome';
  return chromium.launch(options);
}

async function assertNotChallenged(page) {
  const title = await page.title();
  if (/captcha|robot|проверка|access denied|доступ ограничен/i.test(title)) throw new Error(`Winline answered with a challenge page: "${title}"`);
}

const storeEvents = (page) => page.evaluate(() => window.apiWlb.getEvents().dbCollection.data
  .filter((e) => e.idSport === 1)
  .map((e) => ({ id: e.id, members: e.members, date: e.date, championship: e.idChampionship, live: Boolean(e.isLive) })));

async function readEvent(page, id) {
  return page.evaluate((eventId) => {
    const event = window.apiWlb.getEvents().byId(eventId);
    if (!event) return null;
    const rows = [];
    for (const [marketId, lines] of Object.entries(event.linesByIdTipMarkets || {})) {
      for (const line of lines || []) {
        rows.push({
          market_id: Number(marketId), line_id: line.idLine || line.id, koef: line.koef ?? '', V: line.V, countV: line.countV ?? null,
          R: (line.tipLine?.R || []).filter((label) => label !== ''), favorite: line.favorite ?? line.tipLine?.favorite ?? 0,
          template: line.tipLine?.freeTextR || '',
        });
      }
    }
    return { event_id: event.id, members: event.members, start_time: new Date(event.date).toISOString(), championship_id: event.idChampionship, live: Boolean(event.isLive), rows };
  }, id);
}

async function lineCount(page, id) {
  return page.evaluate((eventId) => {
    const event = window.apiWlb.getEvents().byId(eventId);
    return event?.linesByIdTipMarkets ? Object.values(event.linesByIdTipMarkets).reduce((sum, lines) => sum + (lines || []).length, 0) : 0;
  }, id);
}

async function openAllTabs(page, id) {
  const opened = [];
  for (const label of TABS) {
    const clicked = await page.evaluate((name) => {
      const leaves = [...document.querySelectorAll('*')].filter((el) => el.children.length === 0 && el.textContent.trim() === name);
      const target = leaves.find((el) => el.offsetParent !== null) || leaves[0];
      if (!target) return false;
      target.click();
      return true;
    }, label);
    if (clicked) opened.push(label);
    await page.waitForTimeout(700);
  }
  let last = -1;
  for (let i = 0; i < 8; i += 1) {
    const count = await lineCount(page, id);
    if (count === last) break;
    last = count;
    await page.waitForTimeout(800);
  }
  return opened;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotDir = path.join(args.out, 'snapshots', stamp);
  fs.mkdirSync(snapshotDir, { recursive: true });
  const browser = await launch(args.headed);
  const captured = [];
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
    const page = await context.newPage();
    await page.goto(LISTING, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await assertNotChallenged(page);
    await page.waitForFunction(() => window.apiWlb?.getEvents?.()?.dbCollection?.data?.length > 0, null, { timeout: 40000 });
    let events = (await storeEvents(page)).filter((e) => e.championship === args.championship);
    if (args.events.length) events = args.events.map((id) => events.find((e) => e.id === id) || { id, members: [], date: null, championship: args.championship });
    events = events.sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(0, args.limit);
    if (!events.length) throw new Error(`No football events found for championship ${args.championship}`);
    log(`${events.length} events to capture into ${snapshotDir}`);
    for (const [number, event] of events.entries()) {
      try {
        await page.goto(`https://winline.ru/plus/${event.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await assertNotChallenged(page);
        await page.waitForFunction((id) => {
          const e = window.apiWlb?.getEvents?.()?.byId?.(id);
          return e && e.linesByIdTipMarkets && Object.keys(e.linesByIdTipMarkets).length >= 10;
        }, event.id, { timeout: 30000 });
        const tabs = await openAllTabs(page, event.id);
        const raw = await readEvent(page, event.id);
        if (!raw) throw new Error('event missing from the store');
        const normalized = normalizeStoreEvent(raw);
        normalized.captured_at = new Date().toISOString();
        normalized.live = raw.live;
        normalized.tabs_opened = tabs;
        fs.writeFileSync(path.join(snapshotDir, `${event.id}.raw.json`), JSON.stringify(raw));
        captured.push(normalized);
        const s = normalized.summary;
        log(`${number + 1}/${events.length} ${normalized.home} - ${normalized.away}: ${s.market_lines} lines, ${s.market_types} types, ${s.player_lines} player lines (tabs: ${tabs.length})`);
      } catch (error) {
        if (/challenge page/.test(error.message)) throw error;
        errors.push({ event_id: event.id, error: error.message.split('\n')[0] });
        log(`! ${event.id}: ${error.message.split('\n')[0]}`);
      }
      await page.waitForTimeout(args.pause);
    }
  } finally {
    await browser.close();
  }
  const payload = { captured_at: new Date().toISOString(), source: 'winline-site-store', sport_id: 1, championship_id: args.championship, events: captured, errors };
  fs.writeFileSync(path.join(snapshotDir, 'index.json'), JSON.stringify(payload));
  fs.writeFileSync(path.join(args.out, 'latest.json'), JSON.stringify(payload));
  log(`done: ${captured.length} events, ${errors.length} errors; latest.json updated`);
  if (!captured.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
