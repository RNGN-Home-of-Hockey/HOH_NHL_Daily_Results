// Live Center v30: the navigation fixes of the owner's review (14 October 2026).
//   - the tabs (and on inner pages the back row) stay on top while the page scrolls: no scrolling back up to change a section
//   - back from a match or a player returns to the same card of the list, not to the top
//   - (the calendar of «Матчи» was one week in a row until 2026-10-19: the owner chose the month as a grid, drawn by v19)
//   - (the folding explanation of «Кто победит?» is gone: since 2026-10-19 the head is one fact about the fan, nothing to fold)
//   - the winner of a finished game is bold (not in the no-spoilers mode)
//   - the names in the players list are not cut ("Кирилл Капри…")
// This function is serialized (navApp.toString()) and served as /telegram-app/v30-nav.js, so it must be self-contained.
export function navApp() {
  const H = window.HOHV15;
  if (!H || window.HOHV30) return;
  const V30 = (window.HOHV30 = {});

  function css() {
    if (document.getElementById("v30css")) return;
    const style = document.createElement("style");
    style.id = "v30css";
    style.textContent = `
html,body{overflow-x:clip!important;overflow-y:visible!important}
html body .app,html body #view{overflow-x:clip!important;overflow-y:visible!important}
.v22NavRow,.v22BackRow,:not(.v22BackRow)>.v15BackRow{position:sticky!important;top:0;z-index:40;margin-left:-12px!important;margin-right:-12px!important;padding:6px 12px!important;background:rgba(244,241,250,.96);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);box-shadow:0 6px 14px -12px rgba(40,20,90,.45)}
html:not(.v15Light) :is(.v22NavRow,.v22BackRow,:not(.v22BackRow)>.v15BackRow){background:rgba(10,11,17,.95);box-shadow:0 6px 14px -12px rgba(0,0,0,.9)}
.playerRow .rowText b{white-space:normal!important;overflow:visible!important;text-overflow:clip!important;line-height:1.15;overflow-wrap:anywhere}
.v30Win{font-weight:900}
.v30Lose{font-weight:600;opacity:.75}
.hohNoSpoilers .v30Win,.hohNoSpoilers .v30Lose{font-weight:inherit;opacity:1}
`;
    document.head.appendChild(style);
  }

  // ---- back to the same card ---------------------------------------------------------------------------------------------------
  // A tap on a card of a list remembers the card; when the list is drawn again (back from the match or the player), the page
  // scrolls to that card instead of starting from the top. The memory lives two minutes.
  const ANCHORS = [
    { sel: ".v19Broadcast[data-v19-game]", key: (el) => `.v19Broadcast[data-v19-game="${el.dataset.v19Game}"]` },
    { sel: ".playerRow[data-player]", key: (el) => `.playerRow[data-player="${el.dataset.player}"]` },
    { sel: "[data-v27-game]", key: (el) => `[data-v27-game="${el.dataset.v27Game}"]` },
    { sel: ".v15Game[data-game]", key: (el) => `.v15Game[data-game="${el.dataset.game}"]` },
  ];
  let anchor = null;
  window.addEventListener("click", (e) => {
    const t = e.target;
    if (!t || !t.closest || t.closest(".v28Fol,[data-v29-pick],[data-v29-sc],[data-v29-sc-save],a[href]")) return;
    for (const a of ANCHORS) {
      const el = t.closest(a.sel);
      if (el && el.closest("#view")) {
        const r = el.getBoundingClientRect();
        anchor = { selector: a.key(el), offset: Math.max(70, Math.round(r.top)), at: Date.now() };
        return;
      }
    }
  }, true);
  function restoreAnchor() {
    if (!anchor || Date.now() - anchor.at > 2 * 60 * 1000) return;
    if (H.state && H.state.profile) return; // still on the inner page
    const el = document.querySelector(`#view ${anchor.selector}`);
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY - anchor.offset;
    anchor = null;
    window.scrollTo(0, Math.max(0, top));
  }
  V30.restoreAnchor = restoreAnchor;
  V30.anchor = () => anchor;

  // ---- the winner of a finished game is bold -------------------------------------------------------------------------------------------
  // since 2026-10-19 the card has the names once (under the logos, or under the cover) with the score between them: v19 marks them [data-v19-side]
  function decorateScores() {
    document.querySelectorAll("#view .v19Broadcast[data-v19-game]").forEach((card) => {
      const scoreEl = card.querySelector(".v19CardScore");
      // only a finished game has a winner: a game that is on keeps both names plain
      const m = !scoreEl || card.querySelector(".v19LiveBadge") ? null : /^(\d+)\s*:\s*(\d+)/.exec(String(scoreEl.textContent || "").trim());
      const won = !m || m[1] === m[2] ? "" : Number(m[1]) > Number(m[2]) ? "away" : "home";
      card.querySelectorAll("[data-v19-side]").forEach((el) => {
        el.classList.toggle("v30Win", Boolean(won) && el.dataset.v19Side === won);
        el.classList.toggle("v30Lose", Boolean(won) && el.dataset.v19Side !== won);
      });
    });
  }

  function update() {
    decorateScores();
    restoreAnchor();
  }
  V30.update = update;

  css();
  let pending = null;
  if (typeof MutationObserver === "function" && document.body) {
    new MutationObserver(() => {
      if (pending) return;
      pending = setTimeout(() => { pending = null; update(); }, 80);
    }).observe(document.body, { childList: true, subtree: true });
  }
  update();
}
