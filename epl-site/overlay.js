// OBS / vMix overlay of the Winline EPL plates: polls the on-air state of one channel (?room=1) and shows or hides
// the plate with a short fade, drawn by plate.js exactly like the PNG files. A failed poll keeps what is on screen;
// a long outage reloads the page. ?demo=1 shows a sample plate (to place the layer), ?check=1 a chequered background.
import { loadPlateAssets, renderPlate } from './plate.js';

const params = new URLSearchParams(location.search);
const room = (params.get('room') || '1').toLowerCase().replace(/[^a-z0-9-]/g, '') || '1';
const stage = document.getElementById('stage');
const buffer = document.createElement('canvas');
const POLL_MS = 700;
const FADE_MS = 320;
const DEMO = { headline: 'Челси – топ-5 АПЛ по контролю мяча', team: 'Челси', bet: 'Фора -1,5 гола', odds: 2.6, crests: [4] };

let shownKey = '';
let busy = false;
let lastOk = Date.now();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function show(plate) {
  const key = plate ? JSON.stringify(plate) : '';
  if (key === shownKey) return;
  if (shownKey) {
    stage.classList.remove('on');
    await wait(FADE_MS);
  }
  shownKey = key;
  if (!plate) return;
  await renderPlate(buffer, plate);
  const ctx = stage.getContext('2d');
  ctx.clearRect(0, 0, stage.width, stage.height);
  ctx.drawImage(buffer, 0, 0);
  void stage.offsetWidth;  // start the fade from the hidden state (no requestAnimationFrame: it pauses in a background source)
  stage.classList.add('on');
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const response = await fetch(`/api/onair/state?room=${encodeURIComponent(room)}&_=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const state = await response.json();
    lastOk = Date.now();
    await show(state.on && state.plate ? state.plate : null);
  } catch (error) {
    console.warn('on-air poll failed', error);
  } finally {
    busy = false;
  }
}

if (params.has('check')) document.body.classList.add('check');
await loadPlateAssets();
if (params.has('demo')) {
  await show(DEMO);
} else {
  tick();
  setInterval(tick, POLL_MS);
  setInterval(() => { if (Date.now() - lastOk > 30000) location.reload(); }, 5000);
}
