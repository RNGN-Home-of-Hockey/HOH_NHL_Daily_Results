// Live Center v30: the navigation fixes of the owner's review (14 October 2026).
//   - the tabs (and on inner pages the back row) stay on top while the page scrolls: no scrolling back up to change a section
//   - back from a match or a player returns to the same card of the list, not to the top
//   - the calendar of «Матчи» is one week in a row; the whole month opens on a tap
//   - the long explanation «Кто победит?» is shown in full once, then folds into one line
//   - the score of a finished game is big and the winner is bold (not in the no-spoilers mode)
//   - the names in the players list are not cut ("Кирилл Капри…")
// This function is serialized (navApp.toString()) and served as /telegram-app/v30-nav.js, so it must be self-contained.
export function navApp() {
  const H = window.HOHV15;
  if (!H || window.HOHV30) return;
  const V30 = (window.HOHV30 = {});
  const store = {
    get(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
  };

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
.v19BroadcastText small .v19CardScore.v30Has{display:inline-block;font-size:16px;font-weight:900;letter-spacing:.2px;color:inherit;vertical-align:-1px}
.v30Win{font-weight:900}
.v30Lose{font-weight:600;opacity:.75}
.hohNoSpoilers .v30Win,.hohNoSpoilers .v30Lose{font-weight:inherit;opacity:1}
.v19Cal.v30Week .v19Days .v19Day.v30Out{display:none}
.v30CalMore{display:block;width:100%;margin-top:7px;height:30px;border:1px dashed #b7a6e6;border-radius:10px;background:transparent;color:#5b21b6;font:inherit;font-size:12px;font-weight:800;cursor:pointer}
html:not(.v15Light) .v30CalMore{border-color:#464a59;color:#cdb9ff}
#v29MatchesHead.v30Short .v29Note,#v29MatchesHead.v30Short .v29Last{display:none}
.v30Why{justify-self:start;padding:0;border:0;background:none;color:#7a3df0;font:inherit;font-size:12px;font-weight:700;cursor:pointer}
html:not(.v15Light) .v30Why{color:#b58aff}
#v29MatchesHead:not(.v30Short) .v30Why{display:none}
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

  // ---- the calendar: one week, the month on a tap -----------------------------------------------------------------------------------
  function decorateCalendar() {
    const cal = document.querySelector("#view .v19Cal");
    if (!cal) return;
    const open = store.get("hoh-cal-month") === "1";
    const days = [...cal.querySelectorAll(".v19Days .v19Day[data-v19-date]")];
    if (!days.length) return;
    const sel = days.findIndex((d) => d.classList.contains("sel"));
    const center = sel >= 0 ? sel : Math.max(0, days.findIndex((d) => d.classList.contains("today")));
    // seven days around the chosen one, inside the month
    const start = Math.max(0, Math.min(center - 3, days.length - 7));
    days.forEach((d, i) => d.classList.toggle("v30Out", i < start || i >= start + 7));
    cal.classList.toggle("v30Week", !open);
    let more = cal.querySelector(".v30CalMore");
    if (!more) {
      more = document.createElement("button");
      more.type = "button";
      more.className = "v30CalMore";
      more.addEventListener("click", () => {
        store.set("hoh-cal-month", cal.classList.contains("v30Week") ? "1" : "0");
        decorateCalendar();
      });
      cal.appendChild(more);
    }
    const label = open ? "Свернуть до недели ▴" : "Весь месяц ▾";
    if (more.textContent !== label) more.textContent = label;
  }

  // ---- «Кто победит?»: the long explanation once, then one line -----------------------------------------------------------------------
  function decorateExplainer() {
    const head = document.getElementById("v29MatchesHead");
    if (!head || head.dataset.v30) return;
    head.dataset.v30 = "1";
    const seen = store.get("hoh-v29-explained") === "1";
    if (seen) head.classList.add("v30Short");
    else store.set("hoh-v29-explained", "1");
    const why = document.createElement("button");
    why.type = "button";
    why.className = "v30Why";
    why.textContent = "Как это работает?";
    why.addEventListener("click", () => head.classList.remove("v30Short"));
    head.appendChild(why);
  }

  // ---- the score of a finished game: big, the winner bold -----------------------------------------------------------------------------
  function decorateScores() {
    document.querySelectorAll("#view .v19Broadcast[data-v19-game]").forEach((card) => {
      const title = card.querySelector(".v19BroadcastText > b");
      const scoreEl = card.querySelector(".v19CardScore");
      if (!title || !scoreEl) return;
      // only a finished game has a winner: a game that is on keeps both names plain
      const m = card.querySelector(".v19LiveBadge") ? null : /^(\d+)\s*:\s*(\d+)/.exec(String(scoreEl.textContent || "").trim());
      scoreEl.classList.toggle("v30Has", Boolean(m) || /^\d+\s*:\s*\d+/.test(String(scoreEl.textContent || "").trim()));
      const key = m ? `${m[1]}:${m[2]}` : "-";
      if (title.dataset.v30 === key) return;
      if (!title.dataset.v30Names) title.dataset.v30Names = title.textContent;
      const names = title.dataset.v30Names.split(" — ");
      title.dataset.v30 = key;
      if (!m || names.length !== 2 || m[1] === m[2]) {
        title.textContent = title.dataset.v30Names;
        return;
      }
      const left = Number(m[1]) > Number(m[2]);
      const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
      title.innerHTML = `<span class="${left ? "v30Win" : "v30Lose"}">${esc(names[0])}</span> — <span class="${left ? "v30Lose" : "v30Win"}">${esc(names[1])}</span>`;
    });
  }

  function update() {
    decorateCalendar();
    decorateExplainer();
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
