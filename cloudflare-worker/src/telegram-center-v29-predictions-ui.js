// Live Center v29: the game of the fans on the screen.
//   - "Кто победит?" (the winner including overtime and the shootout): in the match of the day (.v29Slot in the hero of the home
//     page) and in the match screen with the question between the two buttons; in every card of the "Матчи" tab, where the games
//     that are over show how the fans voted. No odds on the buttons: the Winline block under them is the only one (the owner);
//   - the order of a pick (the owner, 2026-10-19: «нажал "Кто победит" — точный счёт… можно сохранить, можно нажать "Назад"… и
//     потом только появляется винлайновский коэффициент»): the team → in its place «голос принят, угадаете счёт?» with «← Назад»
//     and «Сохранить» → «Ваш прогноз: NYR · 2:3» and ONE bet under it: the win of that team in regulation time and what a
//     1000 ₽ bet brings, as the broadcast cards say it;
//   - the head of the "Матчи" tab: one bright fact about the fan (the first day, the days in a row, «точнее, чем у 63%»…);
//   - "Твой профиль" (level, points, progress to the next level) and the table of the best fans on the "Мои" screen.
//
// This function is serialized (predictionsApp.toString()) and served as /telegram-app/v29-predict.js, so it must be
// self-contained: no imports and no references to anything outside of its own body.
export function predictionsApp() {
  const H = window.HOHV15;
  if (!H || window.HOHV29) return;
  const S = (window.HOHV29 = { version: "29.0" });
  const API = "/api/telegram-center-v29";
  const BOARD_SHORT = 10;
  const REFRESH_MS = 60000;

  const st = {
    games: new Map(), slate: null, slateAt: 0, slateTried: 0, slateBusy: false, missing: new Map(),
    me: null, meAt: 0, meBusy: false,
    boards: new Map(), period: "week", boardBusy: new Set(), boardOpen: false,
    rulesOpen: false, pending: new Set(), want: new Set(), wantTimer: null,
    draft: new Map(), scoreBusy: new Set(), // the exact score being set: game -> {home, away}
    stage: new Map(), anim: new Set(), // the step of an open pick: game -> "pick" | "score" (none: done); the steps to animate
  };
  const painted = new WeakMap(); // element -> the html it shows, so a redraw happens only when something changed

  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const noSpoilers = () => typeof window.HOHNoSpoilers === "function" && Boolean(window.HOHNoSpoilers());
  const inTelegram = () => Boolean(window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData);
  // signed in: inside Telegram, or on the website through «Войти через Telegram» (telegram-center-web-login-ui.js)
  const signedIn = () => inTelegram() || Boolean(window.HOHAuth && window.HOHAuth.signedIn());
  const webGuest = () => !signedIn() && Boolean(window.HOHAuth);
  const fmtXp = (v) => String(Math.max(0, Math.floor(Number(v) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const clock = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  };
  const LEVELS = [0, 20, 60, 120, 220, 380, 620, 1000, 1600, 2500]; // the XP of the levels 1–10
  const EXACT_XP = 25;
  const SCORE_MAX = 15;
  const MEDAL = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="9" r="5.2"/><path d="M8.6 13.2 7 21l5-2.6 5 2.6-1.6-7.8"/></svg>';

  // ---- styles ----------------------------------------------------------------------------------------------------------------
  function css() {
    if (document.getElementById("v29css")) return;
    const style = document.createElement("style");
    style.id = "v29css";
    style.textContent = `
.v29Vote,.v29MatchesHead,.v29Me{--v29-line:#d9dbe6;--v29-btn:rgba(255,255,255,.72);--v29-text:#0c0d14;--v29-muted:#686c7e;--v29-odd:#5b21b6;--v29-odd-bg:rgba(122,61,240,.1);--v29-pick:#7a3df0;--v29-bar:rgba(122,61,240,.13);--v29-win:#17a06b;--v29-card:rgba(255,255,255,.82)}
html:not(.v15Light) :is(.v29Vote,.v29MatchesHead,.v29Me){--v29-line:#30334a;--v29-btn:rgba(22,24,34,.72);--v29-text:#f7f7fb;--v29-muted:#9094a8;--v29-odd:#d9ccff;--v29-odd-bg:rgba(203,188,255,.13);--v29-pick:#b58aff;--v29-bar:rgba(181,138,255,.16);--v29-win:#62e6ae;--v29-card:rgba(16,18,26,.8)}
html.hohSil.v15Light .v29Me{--v29-card:rgba(255,255,255,.55)}
html.hohSil:not(.v15Light) .v29Me{--v29-card:rgba(16,18,26,.5)}
.v29Vote{display:grid;gap:8px;color:var(--v29-text)}
.v29Btns{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.v29Row3{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;gap:8px}
.v29Mid{font-size:12.5px;font-weight:800;line-height:1.15;text-align:center;color:var(--v29-text)}
.v29Btn{position:relative;overflow:hidden;display:flex;align-items:center;gap:5px;min-width:0;min-height:44px;padding:6px 8px;border-radius:12px;border:1.5px solid var(--v29-line);background:var(--v29-btn);color:inherit;font:inherit;cursor:pointer;text-align:left}
.v29Btn>*{position:relative;z-index:1}
.v29Btn img{width:22px;height:22px;object-fit:contain;flex:0 0 auto}
.v29Btn{justify-content:center;text-align:center}
.v29Btn .v29Nm{display:grid;min-width:0;line-height:1.15;justify-items:center}
.v29Btn .v29T{display:flex;align-items:center;justify-content:center;gap:3px;white-space:nowrap}
.v29Btn b{font-size:14px;font-weight:800}
.v29Btn .v29Tick{font-style:normal;font-weight:900;font-size:13px;color:var(--v29-pick)}
.v29Btn .v29Pc{font-size:11px;font-weight:700;color:var(--v29-muted)}
.v29Btn .v29Share{position:absolute;z-index:0;left:0;top:0;bottom:0;background:var(--v29-bar)}
.v29Btn.mine{border-color:var(--v29-pick);box-shadow:0 0 0 2px rgba(122,61,240,.16)}
.v29Btn.won{border-color:var(--v29-win)}
.v29Btn[disabled]{cursor:default}
.v29Btn.busy{opacity:.6}
.v29Line{font-size:12px;font-weight:600;color:var(--v29-muted)}
.v29Line.ok{color:var(--v29-win)}
.v29Score{display:grid;gap:9px;padding:10px 12px;border:1px solid var(--v29-line);border-radius:14px;background:var(--v29-btn)}
.v29Ok{display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:700;color:var(--v29-win)}
.v29Ok img{width:22px;height:22px;object-fit:contain}
.v29Ok b{color:var(--v29-text);font-weight:900}
.v29Ok b,.v29DoneT b,.v29Line b{display:inline!important;font-size:inherit!important;line-height:inherit!important} /* the cards of «Матчи» make every <b> a block */
.v29Ok i{margin-left:auto;font-style:normal;font-size:15px;font-weight:900}
.v29ScQ{font-size:14px;font-weight:800;color:var(--v29-text)}
.v29ScQ em{font-style:normal;color:var(--v29-pick)}
.v29ScRow{display:flex;align-items:center;justify-content:center;gap:8px}
.v29ScTri{font-size:12.5px;font-weight:800;color:var(--v29-muted)}
.v29Step{display:inline-flex;align-items:center;border:1px solid var(--v29-line);border-radius:10px;overflow:hidden;background:var(--v29-btn)}
.v29Step button{width:34px;height:36px;border:0;background:none;color:var(--v29-pick);font:inherit;font-size:19px;font-weight:800;cursor:pointer}
.v29Step b{min-width:24px;text-align:center;font-size:18px;font-weight:900;color:var(--v29-text)}
.v29ScColon{font-size:18px;font-weight:900}
.v29ScBad{font-size:12px;font-weight:700;color:#c2410c;text-align:center}
html:not(.v15Light) .v29ScBad{color:#ff9a5c}
.v29ScAct{display:grid;grid-template-columns:auto 1fr;gap:8px}
.v29Back{padding:10px 14px;border:1px solid var(--v29-line);border-radius:11px;background:none;color:var(--v29-text);font:inherit;font-size:13.5px;font-weight:800;cursor:pointer}
.v29ScSave{padding:10px 14px;border:0;border-radius:11px;background:var(--v29-pick);color:#fff;font:inherit;font-size:14px;font-weight:900;cursor:pointer}
.v29ScSave[disabled]{opacity:.45;cursor:default}
.v29Skip{justify-self:center;padding:0;border:0;background:none;color:var(--v29-muted);font:inherit;font-size:12px;font-weight:700;text-decoration:underline;cursor:pointer}
.v29Done{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:8px;align-items:center;padding:8px 10px;border-radius:12px;border:1.5px solid var(--v29-pick);background:var(--v29-bar)}
.v29Done img{width:24px;height:24px;object-fit:contain}
.v29DoneT{font-size:13.5px;font-weight:700;color:var(--v29-text)}
.v29DoneT b{font-weight:900}
.v29Edit{padding:6px 10px;border:1px solid var(--v29-line);border-radius:10px;background:var(--v29-btn);color:var(--v29-pick);font:inherit;font-size:12.5px;font-weight:800;cursor:pointer}
.v29ScOpen{justify-self:start;padding:7px 12px;border:1px dashed var(--v29-pick);border-radius:10px;background:none;color:var(--v29-pick);font:inherit;font-size:12.5px;font-weight:800;cursor:pointer}
.v29Score.compact .v29Step button{width:26px;height:28px}
.v29Vote.compact{gap:5px}
.v27Hero .v29Slot{margin-top:2px}
.v29MatchSlot{margin:10px 0;padding:12px;border:1px solid var(--v26-line,#282b38);border-radius:16px;background:var(--v26-card,rgba(16,18,26,.8))}
.v29CardSlot{margin-top:8px}
.v29MatchesHead{display:grid;gap:6px;margin:0 0 10px;padding:12px 14px;border:1px solid var(--v29-line);border-radius:16px;background:var(--v29-card);color:var(--v29-text)}
.v29MhTop{display:flex;align-items:center;justify-content:space-between;gap:10px}
.v29MhTop b{font-size:15px;font-weight:800}
.v29Note{font-size:12px;color:var(--v29-muted);font-weight:600;line-height:1.35}
.v29More,.v29Link{justify-self:start;padding:0;border:0;background:none;color:var(--v29-pick);font:inherit;font-size:13px;font-weight:700;cursor:pointer}
.v29Me{display:grid;gap:12px;margin:0 0 12px;color:var(--v29-text)}
.v29Card{padding:16px;border:1px solid var(--v29-line);border-radius:20px;background:var(--v29-card);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}
.v29Prof{display:grid;gap:10px}
.v29Prof .k{font-size:12px;letter-spacing:.6px;text-transform:uppercase;color:var(--v29-muted);font-weight:600}
.v29Prof .top{display:flex;align-items:center;justify-content:space-between;gap:12px}
.v29Prof .lvl{display:block;font-size:26px;font-weight:800;line-height:1.1}
.v29Prof .note{display:block;margin-top:4px;font-size:14px;color:var(--v29-muted)}
.v29Badge{flex:0 0 auto;display:grid;place-items:center;width:56px;height:56px;border-radius:50%;background:var(--v29-odd-bg);color:var(--v29-odd)}
.v29Badge svg{width:26px;height:26px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linejoin:round;stroke-linecap:round}
.v29Prof .xp{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
.v29Prof .xp b{font-size:20px;font-weight:800}
.v29Prof .xp span{font-size:13px;color:var(--v29-muted);text-align:right}
.v29Bar{height:8px;border-radius:99px;background:var(--v29-odd-bg);overflow:hidden}
.v29Bar i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#7a3df0,#ff5a00)}
.v29Stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.v29Stats div{display:grid;gap:2px;padding:8px 10px;border-radius:12px;background:var(--v29-odd-bg)}
.v29Stats b{font-size:17px;font-weight:800}
.v29Stats span{font-size:11px;color:var(--v29-muted);font-weight:600}
.v29Opt{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:13px;font-weight:600}
.v29Sw{position:relative;flex:0 0 auto;width:44px;height:26px;border-radius:99px;border:0;background:var(--v29-line);cursor:pointer;padding:0}
.v29Sw i{position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;transition:left .2s}
.v29Sw.on{background:#ff5a00}
.v29Sw.on i{left:21px}
.v29Rules{display:grid;gap:4px;font-size:12.5px;line-height:1.4;color:var(--v29-muted)}
.v29Board{display:grid;gap:10px}
.v29Board .head{display:grid;gap:10px}
.v29Board .head b{font-size:16px;font-weight:800}
.v29Seg{display:grid;grid-template-columns:repeat(3,1fr);border:1px solid var(--v29-line);border-radius:99px;overflow:hidden}
.v29Seg button{padding:6px 8px;border:0;background:none;color:var(--v29-muted);font:inherit;font-size:13px;font-weight:700;cursor:pointer}
.v29Seg button.on{background:var(--v29-pick);color:#fff}
.v29Board ol{list-style:none;margin:0;padding:0;display:grid;gap:2px}
.v29Board li{display:grid;grid-template-columns:28px 32px minmax(0,1fr) auto;align-items:center;gap:8px;padding:6px 4px;border-radius:12px}
.v29Board li.me{background:var(--v29-odd-bg)}
.v29Board li.gap{display:block;text-align:center;color:var(--v29-muted);padding:0}
.v29Board .n{font-size:13px;font-weight:800;color:var(--v29-muted);text-align:center}
.v29Board .av{display:grid;place-items:center;width:32px;height:32px;border-radius:50%;overflow:hidden;background:var(--v29-odd-bg);color:var(--v29-odd);font-weight:800;font-size:13px}
.v29Board .av img{width:100%;height:100%;object-fit:cover}
.v29Board .nm{min-width:0;display:grid}
.v29Board .nm span{font-size:14px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.v29Board .nm small{font-size:11px;color:var(--v29-muted);font-weight:600}
.v29Board li b{font-size:14px;font-weight:800;white-space:nowrap}
.v29Empty{font-size:13px;color:var(--v29-muted)}
.v29Offer{display:grid;grid-template-columns:auto minmax(0,1fr) auto;grid-template-areas:"logo main odds" "win win win";gap:6px 10px;align-items:center;padding:10px 12px;border-radius:14px;background:rgba(255,90,0,.08);border:1px solid rgba(255,90,0,.32);color:var(--v29-text);text-decoration:none}
html:not(.v15Light) .v29Offer{background:rgba(255,90,0,.12);border-color:rgba(255,120,40,.38)}
.v29OfLogo{grid-area:logo;display:block;height:18px;width:auto}
.v29OfMain{grid-area:main;display:grid;min-width:0;line-height:1.15}
.v29OfMain b{font-size:15px;font-weight:900}
.v29OfMain span{font-size:12px;font-weight:700;color:var(--v29-muted)}
.v29OfOdds{grid-area:odds;padding:7px 12px;border-radius:10px;background:#ff5a00;color:#fff;font-size:18px;font-weight:900;line-height:1}
.v29OfWin{grid-area:win;font-size:12.5px;font-weight:800;color:#c2410c}
html:not(.v15Light) .v29OfWin{color:#ff9a5c}
.v29Fx{display:grid;grid-template-columns:auto minmax(0,1fr);gap:12px;align-items:center}
.v29FxE{display:grid;place-items:center;width:54px;height:54px;border-radius:17px;font-size:29px;line-height:1;background:linear-gradient(135deg,rgba(122,61,240,.2),rgba(255,90,0,.18))}
.v29FxT{display:grid;gap:3px;min-width:0}
.v29FxT b{font-size:17px;font-weight:900;line-height:1.2}
.v29FxT span{font-size:12.5px;font-weight:600;color:var(--v29-muted);line-height:1.3}
.v29Chips{display:flex;flex-wrap:wrap;gap:6px}
.v29Chips span{padding:5px 10px;border-radius:999px;background:var(--v29-odd-bg);color:var(--v29-odd);font-size:12px;font-weight:800}
@media (prefers-reduced-motion:no-preference){.v29In{animation:v29In .3s ease-out}.v29FxE{animation:v29Pop .55s cubic-bezier(.2,1.6,.4,1)}}
@keyframes v29In{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@keyframes v29Pop{from{transform:scale(.55)}to{transform:scale(1)}}
.v29Asked :is(.v27Wl,.v19CardOdds,.v26Wl){display:none!important}
.v29Fact{font-size:12px;font-weight:700;color:var(--v29-odd)}
.v29Better{display:flex;align-items:center;flex-wrap:wrap;gap:6px;padding:9px 12px;border-radius:12px;background:linear-gradient(120deg,rgba(122,61,240,.14),rgba(255,90,0,.12));font-size:14px;font-weight:800}
.v29Better b{font-size:18px;font-weight:900;color:var(--v29-pick)}
.v29Streak{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:13px;font-weight:700}
.v29Streak b{font-size:15px;font-weight:900}
.v29Streak span{color:var(--v29-muted);font-weight:600}
.v29Board .av.hid{font-size:15px}
`;
    document.head.appendChild(style);
  }

  // ---- the vote ----------------------------------------------------------------------------------------------------------------
  const MIN_SPLIT_VOTES = 5;
  function lineOf(g) {
    const my = g.my;
    const tri = my && g[my.pick] ? g[my.pick].tri : "";
    if (g.open) {
      if (st.pending.has(g.game_pk)) return { text: "Сохраняем…" };
      if (my) return { text: `Ваш выбор: ${tri}${my.score ? `, счёт ${my.score.away}:${my.score.home}` : ""} · можно поменять до ${clock(g.start)}` };
      // the match of the day and the match screen add what the pick opens (the cards of "Матчи" are too narrow for it)
      const hint = signedIn() ? "Выберите победителя, угадайте счёт — и покажем коэффициент Winline" : "";
      return { text: g.votes && g.votes.total ? `Проголосовали: ${g.votes.total} · с учётом ОТ и буллитов` : "Победа с учётом ОТ и буллитов", hint };
    }
    if (noSpoilers()) return { text: "Итог скрыт: режим без спойлеров" };
    if (g.settled && g.settled.winner === "void") return { text: "Матч не состоялся — прогнозы без очков" };
    if (g.settled && my && my.result) return my.result === "win" ? { text: `✓ Угадали${my.exact ? " · 🎯 точный счёт" : ""} · +${my.xp} XP`, ok: true, fact: factOf(g) } : { text: `Не угадали · +${my.xp} XP` };
    if (g.settled) return { text: g.votes && g.votes.total >= MIN_SPLIT_VOTES ? `Как голосовали болельщики · ${g.votes.total}` : g.votes && g.votes.total ? `Проголосовали: ${g.votes.total}` : "Матч завершён" };
    return { text: my ? `Матч идёт · ваш выбор ${tri}` : "Прогнозы закрыты — матч начался" };
  }

  // the personal fact of a right pick (the owner: «ты один из 14% пользователей, которые верили…»), the stars of a streak
  function factOf(g) {
    const my = g.my;
    if (!my || my.result !== "win") return "";
    const n = Number(my.streak) || 0;
    if (n >= 5 && n % 5 === 0) return `${"⭐".repeat(Math.min(3, n / 5))} ${n} угаданных подряд!`;
    const total = g.votes ? Number(g.votes.total) || 0 : 0;
    const mine = g.votes ? Number(g.votes[my.pick]) || 0 : 0;
    if (total >= MIN_SPLIT_VOTES && mine / total < 0.5) return `Вы среди ${Math.max(1, Math.round((100 * mine) / total))}% болельщиков, которые верили в ${(g[my.pick] || {}).tri || ""}`;
    if (n >= 3) return `🔥 ${n} угаданных подряд`;
    return "";
  }

  // the step of an open game with a pick: "pick" (the teams again), "score" (right after the pick), "done" (the pick and the bet)
  const stageOf = (g) => (g && g.open && g.my && !st.pending.has(g.game_pk) ? st.stage.get(g.game_pk) || "done" : null);
  function setStage(pk, stage) {
    if (stage) st.stage.set(pk, stage);
    else st.stage.delete(pk);
    st.anim.add(pk);
  }
  const fmtRub = (n) => String(Math.max(0, Math.round(Number(n) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

  // ONE bet once the pick is made (the owner: «оставим одно… победа в основное время»): the win of the chosen team in regulation
  // time, and what a 1000 ₽ bet brings on top, as the broadcast cards say it («+1 170 РУБ (ПРИ СТАВКЕ 1000 РУБ.)»)
  function offerHtml(g, card) {
    const odds = stageOf(g) === "done" && g.offer ? Number(g.offer.regulation) : 0;
    if (!(odds > 1)) return "";
    const t = g[g.my.pick] || {};
    return `<a class="v29Offer${card ? " compact" : ""}" href="/go/winline?game_pk=${encodeURIComponent(g.game_pk)}" target="_blank" rel="noopener"><img class="v29OfLogo" src="/broadcast/winline-logo.png?asset=canonical-3" alt="WINLINE"><span class="v29OfMain"><b>Победа ${esc(t.tri || "")}</b> <span>в основное время</span></span><span class="v29OfOdds">${odds.toFixed(2)}</span><span class="v29OfWin">+${fmtRub((odds - 1) * 1000)} ₽ на счёт при ставке 1000 ₽</span></a>`;
  }

  // the pick made: who, the score if set, «Изменить»; the fans' split; an invitation to the score if there is none
  function doneHtml(g) {
    const t = g[g.my.pick] || {};
    const sc = g.my.score ? ` · <b>${esc(g.my.score.away)}:${esc(g.my.score.home)}</b>` : "";
    const total = g.votes ? Number(g.votes.total) || 0 : 0;
    const share = (k) => Math.round((100 * (Number(g.votes[k]) || 0)) / total);
    const split = g.votes && g.votes.home != null && total >= MIN_SPLIT_VOTES ? `Болельщики: ${esc(g.away.tri)} ${share("away")}% — ${share("home")}% ${esc(g.home.tri)} · ` : "";
    const invite = g.my.score ? "" : `<button type="button" class="v29ScOpen" data-v29-sc-open="${esc(g.game_pk)}">🎯 Угадать точный счёт · +${EXACT_XP} XP</button>`;
    return `<div class="v29Done"><img src="${esc(t.logo)}" alt=""><span class="v29DoneT">Ваш прогноз: <b>${esc(t.tri)}</b>${sc}</span><button type="button" class="v29Edit" data-v29-edit="${esc(g.game_pk)}">Изменить</button></div><div class="v29Line">${split}можно поменять до ${esc(clock(g.start))}</div>${invite}`;
  }

  // full: the match of the day and the match screen, the question between the buttons; card: the cards of the "Матчи" tab,
  // where a game that is over and had no votes shows nothing
  function voteHtml(g, mode) {
    if (!g) return "";
    const card = mode === "card";
    const stage = stageOf(g);
    const cls = `v29Vote${card ? " compact" : ""}`;
    if (stage === "score") return `<div class="${cls}" data-v29-stage="score">${scoreHtml(g)}</div>`;
    if (stage === "done") return `<div class="${cls}" data-v29-stage="done">${doneHtml(g)}${offerHtml(g, card)}</div>`;
    const hide = !g.open && noSpoilers();
    const total = g.votes ? Number(g.votes.total) || 0 : 0;
    if (card && !g.open && !g.my && total === 0) return "";
    // percentages from a handful of votes say nothing ("100% / 0%" after one vote): the split shows from five votes
    const split = !hide && g.votes && g.votes.home != null && total >= MIN_SPLIT_VOTES;
    const winner = !hide && g.settled && g.settled.winner !== "void" ? g.settled.winner : null;
    const side = (k) => {
      const t = g[k] || {};
      const mine = Boolean(g.my && g.my.pick === k);
      const share = split ? Math.round((100 * (Number(g.votes[k]) || 0)) / total) : null;
      const cls = `v29Btn${mine ? " mine" : ""}${winner === k ? " won" : ""}${st.pending.has(g.game_pk) ? " busy" : ""}`;
      // the share of the fans goes under the name
      return `<button type="button" class="${cls}" data-v29-pick="${k}" data-v29-game="${esc(g.game_pk)}"${g.open ? "" : " disabled"} aria-pressed="${mine}" aria-label="${esc(t.name_ru || t.tri)}">${share != null ? `<span class="v29Share" style="width:${share}%"></span>` : ""}<img src="${esc(t.logo)}" alt=""><span class="v29Nm"><span class="v29T"><b>${esc(t.tri)}</b>${mine ? '<i class="v29Tick">✓</i>' : ""}</span>${share != null ? `<small class="v29Pc">${share}%</small>` : ""}</span></button>`;
    };
    // «← Назад» from the score: the teams again, the pick still marked; the same team goes on to the score, another one is a new pick
    const line = stage === "pick" ? { text: "Выберите команду" } : lineOf(g);
    const row = card ? `<div class="v29Btns">${side("away")}${side("home")}</div>` : `<div class="v29Row3">${side("away")}<span class="v29Mid">Кто<br>победит?</span>${side("home")}</div>`;
    return `<div class="${cls}"${stage ? ' data-v29-stage="pick"' : ""}>${row}<div class="v29Line${line.ok ? " ok" : ""}">${esc(line.text)}</div>${line.fact ? `<div class="v29Fact">${esc(line.fact)}</div>` : ""}${line.hint && !card ? `<div class="v29Fact">${esc(line.hint)}</div>` : ""}</div>`;
  }

  // ---- the exact score: in the place of the teams right after the pick, +25 XP when it is right ----------------------------------
  const defaultScore = (pick) => (pick === "home" ? { home: 3, away: 2 } : { home: 2, away: 3 });
  const scoreFits = (pick, d) => d.home !== d.away && (pick === "home") === (d.home > d.away);
  function scoreHtml(g) {
    const pk = g.game_pk;
    const d = st.draft.get(pk) || g.my.score || defaultScore(g.my.pick);
    const fits = scoreFits(g.my.pick, d);
    const busy = st.scoreBusy.has(pk);
    const t = g[g.my.pick] || {};
    const step = (side) => `<span class="v29Step"><button type="button" data-v29-sc="${esc(pk)}:${side}:-1" aria-label="Меньше">−</button><b>${d[side]}</b><button type="button" data-v29-sc="${esc(pk)}:${side}:1" aria-label="Больше">+</button></span>`;
    return `<div class="v29Score"><div class="v29Ok"><img src="${esc(t.logo)}" alt=""><span>Голос за <b>${esc(t.tri)}</b> принят</span><i aria-hidden="true">✓</i></div><span class="v29ScQ">Угадаете точный счёт? <em>+${EXACT_XP} XP</em></span><span class="v29ScRow"><span class="v29ScTri">${esc(g.away.tri)}</span>${step("away")}<span class="v29ScColon">:</span>${step("home")}<span class="v29ScTri">${esc(g.home.tri)}</span></span>${fits ? "" : `<span class="v29ScBad">Счёт должен быть в пользу ${esc(t.tri)}</span>`}<div class="v29ScAct"><button type="button" class="v29Back" data-v29-back="${esc(pk)}">← Назад</button><button type="button" class="v29ScSave" data-v29-sc-save="${esc(pk)}"${fits && !busy ? "" : " disabled"}>${busy ? "Сохраняем…" : "Сохранить"}</button></div><button type="button" class="v29Skip" data-v29-skip="${esc(pk)}">Без счёта</button></div>`;
  }
  function stepScore(code) {
    const [pkRaw, side, delta] = String(code).split(":");
    const pk = Number(pkRaw);
    const g = st.games.get(pk);
    if (!g || !g.my || (side !== "home" && side !== "away")) return;
    const d = { ...(st.draft.get(pk) || g.my.score || defaultScore(g.my.pick)) };
    d[side] = Math.max(0, Math.min(SCORE_MAX, d[side] + Number(delta)));
    st.draft.set(pk, d);
    paintAll();
  }
  async function saveScore(pk) {
    const g = st.games.get(pk);
    const d = st.draft.get(pk) || (g && g.my ? g.my.score || defaultScore(g.my.pick) : null);
    if (!g || !g.open || !g.my || !d || st.scoreBusy.has(pk) || !scoreFits(g.my.pick, d)) return;
    const saved = g.my.score;
    if (saved && saved.home === d.home && saved.away === d.away) {
      // nothing new to send: on to the bet
      st.draft.delete(pk);
      setStage(pk, null);
      paintAll();
      return;
    }
    st.scoreBusy.add(pk);
    paintAll();
    try {
      const r = await H.api(`${API}/predictions`, { method: "POST", body: JSON.stringify({ game_pk: pk, pick: g.my.pick, score: { home: d.home, away: d.away } }) });
      if (r && r.game) setGame(r.game);
      st.draft.delete(pk);
      st.meAt = 0;
      setStage(pk, null);
    } catch (error) {
      alert(errorText(error));
    } finally {
      st.scoreBusy.delete(pk);
      paintAll();
    }
  }

  // the hero of the home page asks for its html while it is drawn, so the vote is there from the first frame
  S.slotHtml = (pk) => {
    const g = st.games.get(Number(pk));
    if (!g) {
      want(Number(pk));
      return "";
    }
    return voteHtml(g, "full");
  };

  function setGame(g) {
    if (!g || !g.game_pk) return;
    st.games.set(Number(g.game_pk), g);
    if (st.slate && Array.isArray(st.slate.games)) {
      const i = st.slate.games.findIndex((x) => Number(x.game_pk) === Number(g.game_pk));
      if (i >= 0) st.slate.games[i] = g;
    }
  }

  // ---- the tab "Матчи": the vote in every card of the chosen day, how the fans voted in the cards of the games that are over --------
  // the facts about the fan (the owner: «в стиле дуалинга… первый день в приложении… сколько дней… точнее, чем у такого-то
  // процента»): the strongest is the big one, two more go as chips; the results of a game day stay hidden without spoilers
  const word = (n, one, few, many) => { const a = Math.abs(Math.trunc(Number(n) || 0)) % 100, b = a % 10; return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many; };
  function factsOf(sl) {
    const f = sl && sl.facts;
    const out = [];
    if (!f) return out;
    const days = Number(f.days) || 0, better = Number(f.better_pct) || 0, streak = Number(f.streak) || 0;
    if (f.first_day) out.push({ e: "🎉", t: "Первый день в приложении!", s: "Угадайте победителя — первые очки уже сегодня", c: "первый день" });
    if (better >= 50) out.push({ e: "🎯", t: `Ваши прогнозы точнее, чем у ${better}% болельщиков`, s: "Держите планку — выберите сегодняшних победителей", c: `точнее ${better}% болельщиков` });
    if (days >= 2) out.push({ e: "🔥", t: `${days} ${word(days, "день", "дня", "дней")} подряд с хоккеем`, s: `Загляните завтра — будет ${days + 1}`, c: `${days} ${word(days, "день", "дня", "дней")} подряд` });
    if (streak >= 2) out.push({ e: "⚡", t: `${streak} ${word(streak, "угаданный", "угаданных", "угаданных")} подряд`, s: "Следующий матч — продолжение серии", c: `${streak} подряд` });
    const last = sl.last;
    if (last && last.total && !noSpoilers()) {
      const all = last.correct === last.total;
      out.push({ e: all ? "🏆" : "✅", t: all ? `Прошлый игровой день: всё угадано, ${last.correct} из ${last.total}` : `Прошлый игровой день: угадано ${last.correct} из ${last.total}`, s: `+${fmtXp(last.xp)} XP в копилку`, c: `прошлый день: ${last.correct} из ${last.total} · +${fmtXp(last.xp)} XP` });
    }
    return out;
  }
  function matchesHeadHtml() {
    const sl = st.slate;
    const link = '<button type="button" class="v29Link" data-v29-me>Мой профиль и рейтинг →</button>';
    if (sl && !sl.signed_in) {
      const guest = webGuest() ? window.HOHAuth.needLogin("Войдите через Telegram, чтобы голосовать и копить очки — всё будет общим с приложением в Telegram.") : '<div class="v29Note">Голосовать можно в приложении, открытом из Telegram-бота.</div>';
      return `<div class="v29Fx"><span class="v29FxE" aria-hidden="true">🏒</span><span class="v29FxT"><b>Кто победит?</b><span>Угадывайте победителей матчей и копите очки</span></span></div>${guest}`;
    }
    const facts = factsOf(sl);
    const main = facts[0] || { e: "🏒", t: "Кто победит сегодня?", s: "Выберите победителя в карточке матча — до начала игры" };
    const chips = facts.slice(1, 3).map((x) => `<span>${x.e} ${esc(x.c)}</span>`).join("");
    return `<div class="v29Fx"><span class="v29FxE" aria-hidden="true">${main.e}</span><span class="v29FxT"><b>${esc(main.t)}</b><span>${esc(main.s)}</span></span></div>${chips ? `<div class="v29Chips">${chips}</div>` : ""}${link}`;
  }

  function mountCards() {
    const list = document.querySelector("#view .v19BroadcastList");
    if (!list) return;
    list.querySelectorAll(".v19Broadcast[data-v19-game]").forEach((card) => {
      if (card.querySelector(".v29Slot")) return;
      const slot = document.createElement("div");
      slot.className = "v29Slot v29CardSlot";
      slot.dataset.v29Game = card.dataset.v19Game;
      slot.hidden = true;
      (card.querySelector(".v19BroadcastText") || card).appendChild(slot);
    });
    let head = document.getElementById("v29MatchesHead");
    if (!head) {
      head = document.createElement("div");
      head.id = "v29MatchesHead";
      head.className = "v29MatchesHead";
      list.before(head);
    }
    // the summary of the last game day and the hint for guests; a failed load waits for the minute refresh
    if (!st.slate && !st.slateBusy && Date.now() - st.slateTried > REFRESH_MS) loadSlate();
    const html = matchesHeadHtml();
    if (painted.get(head) === html) return;
    head.innerHTML = html;
    painted.set(head, html);
  }

  // ---- the slots: the match of the day and the match screen ------------------------------------------------------------------
  function mountMatch() {
    const root = document.getElementById("v26Root");
    if (!root) return;
    const pk = Number(window.HOHV26 && window.HOHV26.state && window.HOHV26.state.gamePk);
    if (!pk) return;
    let slot = document.getElementById("v29Match");
    if (slot && Number(slot.dataset.v29Game) !== pk) {
      slot.remove();
      slot = null;
    }
    if (slot) return;
    slot = document.createElement("div");
    slot.id = "v29Match";
    slot.className = "v29Slot v29MatchSlot";
    slot.dataset.v29Game = String(pk);
    const head = document.getElementById("v26Head");
    if (head) head.after(slot);
    else root.appendChild(slot);
  }

  function paintSlots() {
    document.querySelectorAll(".v29Slot[data-v29-game]").forEach((slot) => {
      const pk = Number(slot.dataset.v29Game);
      const g = st.games.get(pk);
      if (!g) {
        want(pk);
        return;
      }
      const html = voteHtml(g, slot.classList.contains("v29CardSlot") ? "card" : "full");
      slot.hidden = !html;
      const box = slot.closest(".v27Hero,.v19Broadcast,#v26Root");
      if (box) box.classList.toggle("v29Asked", Boolean(html) && g.open && signedIn());
      if (painted.get(slot) === html && (slot.innerHTML || !html)) return;
      slot.innerHTML = html;
      painted.set(slot, html);
      if (st.anim.has(pk) && slot.firstElementChild) slot.firstElementChild.classList.add("v29In");
    });
    st.anim.clear();
  }

  function want(pk) {
    if (!pk || st.games.has(pk)) return;
    // a game the server does not know in the game (a preseason game, a wrong id): not asked again for a minute
    if (Date.now() - (st.missing.get(pk) || 0) < REFRESH_MS) return;
    st.want.add(pk);
    if (st.wantTimer) return;
    st.wantTimer = setTimeout(() => {
      st.wantTimer = null;
      const ids = [...st.want];
      st.want.clear();
      if (ids.length) loadGames(ids);
    }, 40);
  }

  // ---- "Мои": the profile of the player and the table ------------------------------------------------------------------------
  const onMine = () => !H.state.profile && ["follows", "mine"].includes(H.currentTab()) && H.tabsVisible();

  function profileHtml() {
    const m = st.me;
    if (!m) return '<div class="v29Card v29Prof"><div class="k">Твой профиль</div><div class="v29Empty">Загрузка…</div></div>';
    if (m.guest) return '<div class="v29Card v29Prof"><div class="k">Твой профиль</div>' + (webGuest() ? window.HOHAuth.needLogin('Войдите через Telegram — прогнозы, очки и рейтинг будут общими с приложением в Telegram.') : '<div class="v29Empty">Прогнозы, очки и рейтинг доступны в приложении, открытом из Telegram-бота.</div>') + '</div>';
    const lv = m.level;
    const toNext = lv.next ? `До уровня ${esc(lv.next.n || lv.next.name)}: ${fmtXp(lv.to_next)} XP` : "Высший уровень";
    const week = m.ranks && m.ranks.week;
    const acc = m.stats.accuracy == null ? "—" : `${m.stats.accuracy}%`;
    const rules = st.rulesOpen
      ? `<div class="v29Rules"><span>+1 XP — за каждый прогноз на сыгранный матч</span><span>+10 XP — угадали победителя (с учётом ОТ и буллитов)</span><span>+10 XP сверху — угадали победу андердога (кэф Winline на момент начала от 2.10 и выше)</span><span>+5 XP сверху — угадали, а этот исход выбрали меньше 30% болельщиков (от 10 голосов)</span><span>+${EXACT_XP} XP сверху — угадали точный счёт матча (итоговый: победный гол в ОТ или буллитах считается)</span><span>Серии: 5 угаданных подряд — ⭐ +15 XP, 10 — ⭐⭐ +30 XP, 15 и каждые следующие 5 — ⭐⭐⭐ +50 XP</span><span>Уровни: ${LEVELS.map((x, i) => `${i + 1} — ${fmtXp(x)}`).join(" · ")} XP</span></div>`
      : "";
    const pub = !m.prefs || m.prefs.public_board !== false;
    const nick = !pub ? '<div class="v29Note">В рейтинге вы — «Болельщик скрыл имя»: место считается, имя и фото не видны.</div>' : m.has_nick ? "" : `<div class="v29Note">В рейтинге вы «${esc(m.label)}». Задайте ник в «Профиль и комментарии», чтобы вас узнавали.</div>`;
    // never "you are the last": only how many one is better than, and only when it is somebody
    const better = Number(m.better_pct) > 0 ? `<div class="v29Better"><span>Ваши прогнозы точнее, чем у</span> <b>${Math.round(Number(m.better_pct))}%</b> <span>болельщиков</span></div>` : "";
    const sk = m.streak || { current: 0, best: 0, stars: 0 };
    const bestText = `лучшая серия: ${sk.best}${sk.stars ? ` ${"⭐".repeat(sk.stars)}` : ""}`;
    const streak = sk.best > 0 ? `<div class="v29Streak"><b>${sk.current > 0 ? `🔥 ${sk.current} подряд` : "Серия угаданных"}</b> <span>${bestText}</span></div>` : "";
    return `<div class="v29Card v29Prof"><div class="k">Твой профиль</div><div class="top"><div><b class="lvl">${esc(lv.name)}</b><span class="note">${esc(lv.note)}</span></div><span class="v29Badge">${MEDAL}</span></div><div class="xp"><b>${fmtXp(lv.xp)} XP</b><span>${toNext}</span></div><div class="v29Bar"><i style="width:${Math.round(lv.progress * 100)}%"></i></div><div class="v29Stats"><div><b>${m.stats.total}</b><span>прогнозов</span></div><div><b>${acc}</b><span>угадано</span></div><div><b>${week ? `#${week.rank}` : "—"}</b><span>место за неделю</span></div></div>${better}${streak}${nick}<div class="v29Opt"><span>Утренний итог прогнозов в боте</span><button type="button" class="v29Sw${m.prefs.morning_digest ? " on" : ""}" role="switch" aria-checked="${m.prefs.morning_digest}" aria-label="Утренний итог прогнозов в боте" data-v29-digest><i></i></button></div><div class="v29Opt"><span>${pub ? "Мои прогнозы видны всем в рейтинге" : "Мои прогнозы — только для меня"}</span><button type="button" class="v29Sw${pub ? " on" : ""}" role="switch" aria-checked="${pub}" aria-label="Показывать меня в рейтинге" data-v29-public><i></i></button></div><button type="button" class="v29More" data-v29-rules>${st.rulesOpen ? "Скрыть правила" : "Как начисляются очки"}</button>${rules}</div>`;
  }

  function boardHtml() {
    const b = st.boards.get(st.period);
    const seg = [["week", "Неделя"], ["month", "Месяц"], ["season", "Сезон"]].map(([k, t]) => `<button type="button" data-v29-period="${k}"${st.period === k ? ' class="on"' : ""}>${t}</button>`).join("");
    let body;
    if (!b) body = '<div class="v29Empty">Загрузка…</div>';
    else if (!b.rows.length) body = '<div class="v29Empty">Пока никого нет — сделайте прогноз, и после матча здесь появятся очки.</div>';
    else {
      const me = b.me;
      const rows = st.boardOpen ? b.rows : b.rows.slice(0, BOARD_SHORT);
      const lvl = (r) => (r.level_n ? `Ур. ${r.level_n} · ${r.level_note}` : r.level);
      const av = (r) => (r.avatar_url ? `<img src="${esc(r.avatar_url)}" alt="">` : r.hidden ? "🙈" : esc(String(r.label || "?").replace(/^@/, "").slice(0, 1).toUpperCase()));
      const row = (r, isMe) => `<li${isMe ? ' class="me"' : ""}><span class="n">${r.rank}</span><span class="av${r.hidden && !r.avatar_url ? " hid" : ""}">${av(r)}</span><span class="nm"><span>${esc(isMe && r.hidden ? "Вы (имя скрыто)" : r.label)}</span><small>${esc(lvl(r))} · угадано ${r.correct} из ${r.total}</small></span><b>${fmtXp(r.xp)} XP</b></li>`;
      let html = rows.map((r) => row(r, Boolean(me && me.rank === r.rank))).join("");
      if (me && me.rank > rows.length) html += `<li class="gap">…</li>${row({ rank: me.rank, label: st.me && !st.me.guest ? st.me.label : "Вы", avatar_url: null, level: st.me && st.me.level ? st.me.level.name : "", level_n: st.me && st.me.level ? st.me.level.n : null, level_note: st.me && st.me.level ? st.me.level.note : "", correct: me.correct, total: me.total, xp: me.xp }, true)}`;
      const more = b.rows.length > BOARD_SHORT ? `<button type="button" class="v29More" data-v29-board-more>${st.boardOpen ? "Свернуть" : `Весь рейтинг (${b.rows.length})`}</button>` : "";
      body = `<ol>${html}</ol>${more}`;
    }
    return `<div class="v29Card v29Board"><div class="head"><b>Рейтинг болельщиков</b><span class="v29Seg">${seg}</span></div>${body}</div>`;
  }

  function paintMe() {
    const box = document.getElementById("v29Me");
    if (!box) return;
    const html = profileHtml() + boardHtml();
    if (painted.get(box) === html) return;
    box.innerHTML = html;
    painted.set(box, html);
  }

  function mountMe() {
    const view = H.view();
    if (!view) return;
    let box = view.querySelector(":scope > #v29Me");
    if (!onMine()) {
      if (box) box.remove();
      return;
    }
    if (!box) {
      box = document.createElement("section");
      box.id = "v29Me";
      box.className = "v29Me";
      view.prepend(box);
    }
    if (!st.meBusy && (!st.me || Date.now() - st.meAt > REFRESH_MS)) loadMe();
    const b = st.boards.get(st.period);
    if (!st.boardBusy.has(st.period) && (!b || Date.now() - b.at > REFRESH_MS)) loadBoard(st.period);
    paintMe();
  }

  function paintAll() {
    mountCards();
    paintSlots();
    paintMe();
    resumePendingVote();
  }

  function mountAll() {
    mountMatch();
    mountCards();
    mountMe();
    paintSlots();
  }

  // ---- loading -----------------------------------------------------------------------------------------------------------------
  async function loadSlate() {
    if (st.slateBusy) return;
    st.slateBusy = true;
    st.slateTried = Date.now();
    try {
      const d = await H.api(`${API}/slate`);
      if (d && d.ok !== false) {
        st.slate = d;
        st.slateAt = Date.now();
        for (const g of d.games || []) st.games.set(Number(g.game_pk), g);
      }
    } catch (e) {
      // the list stays hidden; the next refresh tries again
    } finally {
      st.slateBusy = false;
      paintAll();
    }
  }

  async function loadGames(ids) {
    const now = Date.now();
    try {
      const d = await H.api(`${API}/games?ids=${ids.join(",")}`);
      for (const g of (d && d.games) || []) setGame(g);
    } catch (e) {
      // no vote block for these games this time
    }
    for (const id of ids) if (!st.games.has(id)) st.missing.set(id, now);
    paintAll();
  }

  async function loadMe() {
    st.meBusy = true;
    try {
      const d = await H.api(`${API}/me`);
      st.me = d && d.ok !== false ? d : { guest: true };
    } catch (e) {
      st.me = { guest: true };
    } finally {
      st.meAt = Date.now();
      st.meBusy = false;
      paintMe();
    }
  }

  async function loadBoard(period) {
    st.boardBusy.add(period);
    try {
      const d = await H.api(`${API}/leaderboard?period=${period}`);
      if (d && d.ok !== false) st.boards.set(period, { rows: d.rows || [], me: d.me || null, players: d.players || 0, at: Date.now() });
    } catch (e) {
      if (!st.boards.has(period)) st.boards.set(period, { rows: [], me: null, players: 0, at: Date.now() });
    } finally {
      st.boardBusy.delete(period);
      paintMe();
    }
  }

  function errorText(error) {
    const code = String((error && error.message) || error || "");
    if (/voting_closed/.test(code)) return "Матч уже начался — прогнозы на него закрыты.";
    if (/invalid_score/.test(code)) return "Счёт должен быть в пользу команды, которую вы выбрали.";
    if (/expired/.test(code)) return "Сессия устарела: закройте приложение и откройте его снова из Telegram-бота.";
    if (/missing_telegram_init_data|guest|signature|init_data/.test(code)) return window.HOHAuth && !inTelegram() ? "Войдите через Telegram, чтобы голосовать." : "Голосовать можно в приложении, открытом из Telegram-бота.";
    return "Не удалось сохранить прогноз. Попробуйте ещё раз.";
  }

  // a website guest taps a team: the pick waits through «Войти через Telegram» (the page reloads after it) and is sent then
  const PENDING_VOTE = "hoh-pending-vote-v1";
  const PENDING_VOTE_MS = 15 * 60 * 1000;
  function keepPendingVote(pk, side) {
    try { sessionStorage.setItem(PENDING_VOTE, JSON.stringify({ pk, side, at: Date.now() })); } catch (e) { /* storage may be blocked */ }
  }
  function resumePendingVote() {
    if (!signedIn()) return;
    let p = null;
    try { p = JSON.parse(sessionStorage.getItem(PENDING_VOTE) || "null"); } catch (e) { p = null; }
    if (!p) return;
    const g = st.games.get(Number(p.pk));
    if (!g && Date.now() - Number(p.at) < PENDING_VOTE_MS) return; // the game is not loaded yet
    try { sessionStorage.removeItem(PENDING_VOTE); } catch (e) { /* ignore */ }
    if (g && g.open && Date.now() - Number(p.at) < PENDING_VOTE_MS && ["home", "away"].includes(p.side)) setTimeout(() => vote(Number(p.pk), p.side), 0);
  }

  async function vote(pk, side) {
    const g = st.games.get(pk);
    if (!g || !g.open || st.pending.has(pk)) return;
    if (g.my && g.my.pick === side) {
      if (stageOf(g) === "pick") {
        setStage(pk, "score");
        paintAll();
      }
      return;
    }
    if (!signedIn()) {
      if (webGuest()) {
        keepPendingVote(pk, side);
        window.HOHAuth.login();
      } else alert("Голосовать можно в приложении, открытом из Telegram-бота.");
      return;
    }
    const before = g;
    st.draft.delete(pk); // a new pick: the score is set again (the server keeps an old one only if it still fits)
    setGame({ ...g, my: { pick: side, result: null, xp: null, score: null } });
    st.pending.add(pk);
    paintAll();
    try {
      const d = await H.api(`${API}/predictions`, { method: "POST", body: JSON.stringify({ game_pk: pk, pick: side }) });
      if (d && d.game) setGame(d.game);
      if (st.slate) st.slate.signed_in = true; // the server took the vote: the person is signed in
      st.meAt = 0;
      setStage(pk, "score"); // the vote is in: the exact score takes the place of the teams
      window.dispatchEvent(new Event("hoh-predictions-change"));
    } catch (error) {
      setGame(before);
      alert(errorText(error));
      if (/voting_closed/.test(String(error && error.message))) loadGames([pk]);
    } finally {
      st.pending.delete(pk);
      paintAll();
    }
  }

  async function togglePublic() {
    if (!st.me || st.me.guest) return;
    const now = !st.me.prefs || st.me.prefs.public_board !== false;
    st.me = { ...st.me, prefs: { ...st.me.prefs, public_board: !now } };
    paintMe();
    try {
      await H.api(`${API}/me`, { method: "PUT", body: JSON.stringify({ public_board: !now }) });
      st.boards.clear(); // the table shows the new name (or none) on the next load
      loadBoard(st.period);
    } catch (error) {
      st.me = { ...st.me, prefs: { ...st.me.prefs, public_board: now } };
      paintMe();
      alert("Не удалось сохранить настройку. Попробуйте ещё раз.");
    }
  }

  async function toggleDigest() {
    if (!st.me || st.me.guest) return;
    const next = !st.me.prefs.morning_digest;
    st.me = { ...st.me, prefs: { ...st.me.prefs, morning_digest: next } };
    paintMe();
    try {
      await H.api(`${API}/me`, { method: "PUT", body: JSON.stringify({ morning_digest: next }) });
    } catch (error) {
      st.me = { ...st.me, prefs: { ...st.me.prefs, morning_digest: !next } };
      paintMe();
      alert("Не удалось сохранить настройку. Попробуйте ещё раз.");
    }
  }

  // ---- clicks: caught before the cards under them (the hero and the cards of "Матчи" open the match) ---------------------------
  document.addEventListener("click", (e) => {
    const el = e.target && e.target.closest && e.target.closest("[data-v29-pick],[data-v29-sc],[data-v29-sc-save],[data-v29-back],[data-v29-skip],[data-v29-edit],[data-v29-sc-open],[data-v29-me],[data-v29-period],[data-v29-digest],[data-v29-public],[data-v29-rules],[data-v29-board-more]");
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    const d = el.dataset;
    if (d.v29Pick) vote(Number(d.v29Game), d.v29Pick);
    else if (d.v29Sc) stepScore(d.v29Sc);
    else if (d.v29ScSave) saveScore(Number(d.v29ScSave));
    else if (d.v29Back || d.v29Edit) {
      const pk = Number(d.v29Back || d.v29Edit);
      st.draft.delete(pk);
      setStage(pk, "pick");
      paintAll();
    } else if (d.v29Skip || d.v29ScOpen) {
      const pk = Number(d.v29Skip || d.v29ScOpen);
      if (d.v29Skip) st.draft.delete(pk);
      setStage(pk, d.v29Skip ? null : "score");
      paintAll();
    }
    else if (d.v29Me !== undefined) {
      const tab = document.querySelector('.tab[data-tab="follows"]');
      if (tab) tab.click();
      window.scrollTo(0, 0);
    } else if (d.v29Period) {
      st.period = d.v29Period;
      st.boardOpen = false;
      const b = st.boards.get(st.period);
      if (!b || Date.now() - b.at > REFRESH_MS) loadBoard(st.period);
      paintMe();
    } else if (d.v29Digest !== undefined) toggleDigest();
    else if (d.v29Public !== undefined) togglePublic();
    else if (d.v29Rules !== undefined) {
      st.rulesOpen = !st.rulesOpen;
      paintMe();
    } else if (d.v29BoardMore !== undefined) {
      st.boardOpen = !st.boardOpen;
      paintMe();
    }
  }, true);

  // ---- wiring ------------------------------------------------------------------------------------------------------------------
  let pending = null;
  const soon = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      mountAll();
    }, 120);
  };
  if (typeof MutationObserver === "function" && document.body) new MutationObserver(soon).observe(document.body, { childList: true, subtree: true });
  const oldRun = H.runCore;
  H.runCore = function () {
    const result = typeof oldRun === "function" ? oldRun.apply(this, arguments) : undefined;
    soon();
    return result;
  };
  window.addEventListener("hoh-spoilers-change", () => {
    const me = document.getElementById("v29Me");
    if (me) painted.delete(me);
    paintAll();
  });
  // every minute while the app is visible: the summary of the "Матчи" tab, the votes on the screen, my profile
  setInterval(() => {
    if (document.visibilityState === "hidden") return;
    if (document.getElementById("v29MatchesHead")) loadSlate();
    const ids = [...new Set([...document.querySelectorAll(".v29Slot[data-v29-game]")].map((x) => Number(x.dataset.v29Game)).filter(Boolean))];
    if (ids.length) loadGames(ids);
    if (document.getElementById("v29Me")) {
      loadMe();
      loadBoard(st.period);
    }
  }, REFRESH_MS);

  S.state = st;
  S.voteHtml = voteHtml;
  S.factsOf = factsOf;
  S.mountAll = mountAll;
  S.refresh = () => {
    st.slate = null;
    st.slateTried = 0;
    st.missing.clear();
    mountAll();
  };
  css();
  mountAll();
}
