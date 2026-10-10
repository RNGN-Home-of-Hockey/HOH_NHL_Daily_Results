// Live Center home screen must not redraw itself forever.
// Regression for the 2026-10-10 audit: applyHomeOdds() removed and re-inserted every card's cover/odds blocks on
// each call, and the layer-22 MutationObserver called it again after every DOM change -> ~67k mutations/s and a
// request storm whenever a VK cover answered 404.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { handleTelegramCenterV19Ui } from '../cloudflare-worker/src/telegram-center-v19-ui.js';
import { handleTelegramCenterV20Ui } from '../cloudflare-worker/src/telegram-center-v20-ui.js';

const sourceOf = async (handler, path) => (await handler(new Request('https://example.test' + path), path).text());
const v19 = await sourceOf(handleTelegramCenterV19Ui, '/telegram-app/v19.js');
const v20 = await sourceOf(handleTelegramCenterV20Ui, '/telegram-app/v20.js');

const BROADCASTS = {
  games: [101, 102, 103].map((pk) => ({
    game_pk: pk,
    away: { tri: 'PHI', name_ru: 'Филадельфия Флайерз' },
    home: { tri: 'BOS', name_ru: 'Бостон Брюинз' },
    vk: { source_key: `-1_${pk}`, thumbnail_url: `https://iv.okcdn.ru/getVideoPreview?id=${pk}` },
    winline: { event_id: String(900 + pk), p1: 1.9, x: 4.1, p2: 3.2 },
  })),
};

function makePage({ withToolbar = true } = {}) {
  const dom = new JSDOM(
    `<!doctype html><body><nav id="tabs"><button class="tab active" data-tab="games"></button></nav>
     <main id="view" class="view">
       <section class="v15Media"></section><section class="v20News"></section><section class="v25FeaturedGame"></section>
       ${withToolbar ? '<div class="toolbar"></div>' : ''}
       ${BROADCASTS.games.map((g) => `<article class="gameCard" data-game="${g.game_pk}"><div class="gameTop"></div></article>`).join('')}
     </main></body>`,
    { url: 'https://example.test/telegram-app-v24', pretendToBeVisual: true, runScripts: 'outside-only' },
  );
  const { window } = dom;
  window.HOHV15 = {
    esc: (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
    state: { profile: false },
    currentTab: () => 'games',
    tabsVisible: () => true,
    view: () => window.document.getElementById('view'),
    api: async () => BROADCASTS,
    V2: '/api/telegram-center-v2',
  };
  window.Telegram = { WebApp: { openLink() {} } };
  return window;
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const countMutations = (window, root, fn) => {
  const mo = new window.MutationObserver(() => {});
  mo.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
  fn();
  const n = mo.takeRecords().length;
  mo.disconnect();
  return n;
};

// 1) applyHomeOdds is idempotent: repeating it on unchanged data must not touch the DOM.
{
  const window = makePage();
  window.eval(v19);
  const H = window.HOHV15;
  assert.equal(typeof H.decorateHomeOdds, 'function', 'v19 must expose decorateHomeOdds');
  await H.decorateHomeOdds(true);
  await tick(20);
  const view = window.document.getElementById('view');
  assert.equal(view.querySelectorAll('.v25GameCover').length, 3, 'covers are rendered once');
  assert.equal(view.querySelectorAll('.v24HomeOdds').length, 3, 'odds are rendered once');
  const churn = countMutations(window, view, () => { for (let i = 0; i < 5; i += 1) H.decorateHomeOdds(); });
  assert.equal(churn, 0, `repeating decorateHomeOdds must not mutate the DOM (got ${churn} mutations)`);
  window.close();
}

// 2) A cover that fails to load is dropped for good: no placeholder churn, no retry of the same URL.
{
  const window = makePage();
  window.eval(v19);
  const H = window.HOHV15;
  await H.decorateHomeOdds(true);
  await tick(20);
  const view = window.document.getElementById('view');
  const img = view.querySelector('.gameCard[data-game="101"] .v25GameCover img');
  assert.ok(img, 'cover image exists before the failure');
  const failedSrc = img.getAttribute('src');
  img.dispatchEvent(new window.Event('error'));
  await tick(20);
  assert.equal(view.querySelector('.gameCard[data-game="101"] .v25GameCover'), null, 'failed cover is removed');
  assert.equal(view.querySelector('.gameCard[data-game="101"]').classList.contains('v25HasCover'), false);
  const churn = countMutations(window, view, () => { for (let i = 0; i < 5; i += 1) H.decorateHomeOdds(); });
  assert.equal(churn, 0, `a failed cover must not be re-inserted (got ${churn} mutations)`);
  const retried = [...view.querySelectorAll('img')].some((el) => el.getAttribute('src') === failedSrc);
  assert.equal(retried, false, 'the failed cover URL must not be requested again');
  // the other cards keep their covers
  assert.equal(view.querySelectorAll('.v25GameCover').length, 2);
  window.close();
}

// 3) stabilizeHome keeps blocks in order without re-inserting nodes that are already in place.
{
  const window = makePage();
  window.eval(v20);
  const view = window.document.getElementById('view');
  const { stabilizeHome } = window.HOHV20;
  assert.equal(typeof stabilizeHome, 'function', 'v20 must expose stabilizeHome');
  stabilizeHome(view);
  const churn = countMutations(window, view, () => { for (let i = 0; i < 5; i += 1) stabilizeHome(view); });
  assert.equal(churn, 0, `stabilizeHome on an ordered view must not mutate the DOM (got ${churn} mutations)`);
  // ...but it still repairs a wrong order
  view.appendChild(view.querySelector('.v15Media'));
  stabilizeHome(view);
  assert.equal(view.firstElementChild.className.includes('v15Media'), true, 'media block is moved back to the top');
  window.close();
}

// 4) Integration: the layer-22 style observer (re-decorate on every DOM change) must settle instead of looping.
{
  const window = makePage();
  window.eval(v19);
  window.eval(v20);
  const H = window.HOHV15;
  const view = window.document.getElementById('view');
  await H.decorateHomeOdds(true);
  let runs = 0;
  const obs = new window.MutationObserver(() => {
    window.requestAnimationFrame(() => { runs += 1; H.decorateHomeOdds(); window.HOHV20.stabilizeHome(view); });
  });
  obs.observe(window.document.documentElement, { childList: true, subtree: true });
  // kick the loop once, exactly like a real DOM change would
  view.appendChild(window.document.createElement('i'));
  await tick(700);
  obs.disconnect();
  assert.ok(runs <= 4, `observer feedback loop must settle (observer ran ${runs} times in 700 ms)`);
  window.close();
}

// 5) Server: a missing cover must be cacheable for a few minutes, a working cover keeps its long cache.
{
  const { handleTelegramCenterMediaProxy } = await import('../cloudflare-worker/src/telegram-center-media-proxy.js');
  const path = '/api/telegram-center-media/vk-cover';
  const noRow = { DB: { prepare: () => ({ bind: () => ({ first: async () => ({ thumbnail_url: '' }) }) }) } };
  const missing = await handleTelegramCenterMediaProxy(new Request('https://example.test' + path + '?source_key=-1_1'), noRow, path);
  assert.equal(missing.status, 404);
  assert.match(String(missing.headers.get('cache-control')), /max-age=300/, 'cover_not_found must be cached for 5 minutes');
  const notVk = await handleTelegramCenterMediaProxy(new Request('https://example.test' + path + '?url=' + encodeURIComponent('https://example.com/x.jpg')), {}, path);
  assert.equal(notVk.status, 400, 'non-VK hosts are still refused');
  assert.equal(notVk.headers.get('cache-control'), 'no-store', 'errors other than a missing cover stay uncached');
}

// 6) Layer 15 re-runs cleanup() on every DOM change (45 ms debounce): it must only write when the label differs,
//    otherwise its own write re-triggers the observer ~22 times a second forever.
{
  const { handleTelegramCenterV15CoreUi } = await import('../cloudflare-worker/src/telegram-center-v15-core-ui.js');
  const v15 = await handleTelegramCenterV15CoreUi(new Request('https://example.test/telegram-app/v15-core.js'), '/telegram-app/v15-core.js').text();
  assert.ok(v15.includes("if(t&&t.textContent!=='Главное')t.textContent='Главное'"), 'cleanup() must not rewrite an unchanged tab label');
  assert.ok(!v15.includes("if(t)t.textContent='Главное'"), 'unconditional tab label write is back');
}

console.log('CENTER_HOME_LOOP_OK');
process.exit(0);
