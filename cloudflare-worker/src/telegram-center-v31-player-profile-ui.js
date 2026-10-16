// Live Center v31: the portrait of a player on his page — a hexagon of the main groups of the game NHL 27 (the game's ratings are the
// main layer, on by default), and beside them two layers to press: «Сезон» and «5 сезонов», the real numbers under the same axes
// (the share of the players of his position he is better than). Under the hexagon a table: every axis, every layer, the numbers.
// A goalie: the hexagon of the game's goalie groups, his season numbers in the table. A player the game does not publish (EA shows
// the 300 best): the season layer is the main one.
// This function is serialized (playerProfileApp.toString()) and served as /telegram-app/v31-player.js: it must be self-contained.
export function playerProfileApp() {
  const H = window.HOHV15;
  if (!H || window.HOHV31) return;
  const V31 = (window.HOHV31 = {});
  const API = "/api/telegram-center-v31/players/";
  const cache = new Map(); // "<id>:<season>" -> profile | null
  const busy = new Set();
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const LAYERS = [
    { k: "ea", name: "NHL 27" },
    { k: "season", name: "Сезон" },
    { k: "five", name: "5 сезонов" },
  ];
  // what the viewer pressed (the same for every player he opens); at first the game alone
  V31.on = { ea: true, season: false, five: false };

  function css() {
    if (document.getElementById("v31css")) return;
    const style = document.createElement("style");
    style.id = "v31css";
    style.textContent = `
.v31Portrait{--ea:#7a3df0;--season:#e85200;--five:#0b84c2;display:grid;gap:10px;margin:10px 0 4px;padding:14px;border:1px solid #e3dcf3;border-radius:18px;background:rgba(255,255,255,.9)}
html:not(.v15Light) .v31Portrait{--ea:#b48cff;--season:#ff8a4c;--five:#4cc3ff;border-color:#2e3142;background:rgba(16,18,26,.88)}
.v31PHead{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.v31PHead b{font-size:16px;font-weight:900}
.v31PHead small{font-size:11.5px;font-weight:700;color:#7d7a92;text-align:right}
.v31Layers{display:flex;flex-wrap:wrap;gap:6px}
.v31Layers button{display:inline-flex;align-items:center;gap:6px;min-height:36px;padding:6px 10px;border:1.5px solid #ddd6ee;border-radius:12px;background:transparent;color:inherit;font:inherit;font-size:13px;font-weight:800;cursor:pointer}
html:not(.v15Light) .v31Layers button{border-color:#34374a}
.v31Layers button i{width:12px;height:12px;border-radius:3px;background:var(--c);opacity:.3}
.v31Layers button[aria-pressed="true"]{border-color:var(--c)}
.v31Layers button[aria-pressed="true"] i{opacity:1}
.v31Layers button small{font-size:11px;font-weight:700;color:#7d7a92}
.v31Layers button:disabled{cursor:default;opacity:.55}
.v31Layers button:focus-visible{outline:2px solid var(--five);outline-offset:2px}
.v31Radar{display:block;width:100%;max-width:380px;height:auto;justify-self:center}
.v31Radar .ring{fill:none;stroke:#d9d1ee;stroke-width:1}
html:not(.v15Light) .v31Radar .ring{stroke:#34374a}
.v31Radar .spoke{stroke:#e6e0f4;stroke-width:1}
html:not(.v15Light) .v31Radar .spoke{stroke:#2a2d3c}
.v31Radar .area{fill-opacity:.14;stroke-width:2.4;stroke-linejoin:round}
.v31Radar .lab{font:800 12px Inter,Arial,sans-serif;fill:#1d1b2b}
html:not(.v15Light) .v31Radar .lab{fill:#eeeaf8}
.v31Radar .pct{font:900 12px Inter,Arial,sans-serif}
.v31Tbl{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}
.v31Tbl th,.v31Tbl td{padding:7px 5px;border-top:1px solid #ece7f6;text-align:left;vertical-align:top}
html:not(.v15Light) .v31Tbl th,html:not(.v15Light) .v31Tbl td{border-top-color:#2a2d3c}
.v31Tbl thead th{border-top:0;font-size:10.5px;letter-spacing:.5px;text-transform:uppercase;color:#7d7a92;font-weight:900}
.v31Tbl tbody th{font-weight:800}
.v31Tbl td b{display:block;font-size:18px;font-weight:900;line-height:1.1}
.v31Tbl td small{display:block;margin-top:2px;color:#7d7a92;font-size:11.5px;font-weight:600;line-height:1.3}
.v31Note{font-size:12px;color:#7d7a92;font-weight:600;line-height:1.4}
.v31Trends{display:grid;gap:8px}
.v31Trend{display:grid!important;grid-template-columns:auto 1fr;gap:12px;align-items:center;padding:12px 14px!important;border:0!important;border-radius:16px!important;background:linear-gradient(120deg,#6d28d9,#a855f7)!important;color:#fff!important;box-shadow:0 8px 20px -12px rgba(109,40,217,.7)}
.v31Trend:nth-child(2){background:linear-gradient(120deg,#ea580c,#f59e0b)!important;box-shadow:0 8px 20px -12px rgba(234,88,12,.7)}
.v31Trend:nth-child(3){background:linear-gradient(120deg,#0f766e,#14b8a6)!important}
.v31TNum{display:grid;justify-items:center;min-width:64px;line-height:1}
.v31TNum b{font-size:28px;font-weight:900;letter-spacing:-.5px}
.v31TNum small{margin-top:3px;font-size:10.5px;font-weight:800;opacity:.9;text-align:center}
.v31TText{font-size:15px;font-weight:800;line-height:1.25}
.v31Rec{display:grid!important;grid-template-columns:auto 1fr auto;gap:10px;align-items:center;padding:12px!important;border-radius:16px!important;cursor:pointer}
.v31Rec .v23RecBrand{height:20px;width:auto}
.v31RecText{display:grid;gap:2px;min-width:0}
.v31RecText b{font-size:15px;font-weight:900;line-height:1.2}
.v31RecText span{font-size:12.5px;font-weight:700;opacity:.8}
.v31RecOdds{display:grid;justify-items:center;padding:6px 12px;border-radius:12px;background:#ff5a00;color:#fff;line-height:1}
.v31RecOdds b{font-size:19px;font-weight:900}
.v31RecOdds small{margin-top:2px;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.4px}
`;
    document.head.appendChild(style);
  }

  // ---- the hexagon: labels [{label}], layers [{k, values:[0..100|null]}] ---------------------------------------------------------
  function radarSvg(labels, layers) {
    const n = labels.length;
    const cx = 160, cy = 136, R = 92;
    const at = (i, r) => {
      const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
      return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    };
    const xy = (p) => p.map((v) => v.toFixed(1)).join(",");
    const poly = (r) => labels.map((_, i) => xy(at(i, r))).join(" ");
    const rings = [0.25, 0.5, 0.75, 1].map((f) => `<polygon class="ring" points="${poly(R * f)}"/>`).join("");
    const spokes = labels.map((_, i) => { const [x, y] = at(i, R); return `<line class="spoke" x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>`; }).join("");
    const shapes = layers.map((L) => {
      const pts = L.values.map((v, i) => at(i, R * Math.max(0.04, Math.min(100, Number(v) || 0) / 100)));
      return `<polygon class="area" data-layer="${esc(L.k)}" points="${pts.map(xy).join(" ")}" style="fill:var(--${esc(L.k)});stroke:var(--${esc(L.k)})"/>`
        + pts.map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.2" style="fill:var(--${esc(L.k)})"/>`).join("");
    }).join("");
    const texts = labels.map((a, i) => {
      const [x, y] = at(i, R + 20);
      const anchor = Math.abs(x - cx) < 8 ? "middle" : x > cx ? "start" : "end";
      // a long name in two lines: «Владение / шайбой»
      const words = String(a.label).split(" ");
      const lines = String(a.label).length > 10 && words.length > 1 ? [words[0], words.slice(1).join(" ")] : [String(a.label)];
      const top = y < cy - R * 0.6, bottom = y > cy + R * 0.6;
      const y0 = top ? y - 6 - 13 * lines.length : bottom ? y + 8 : y - 4;
      const name = lines.map((t, j) => `<tspan x="${x.toFixed(1)}" dy="${j ? 13 : 0}">${esc(t)}</tspan>`).join("");
      const vals = layers.map((L) => `<tspan style="fill:var(--${esc(L.k)})">${L.values[i] == null ? "—" : esc(L.values[i])}</tspan>`).join('<tspan class="lab"> · </tspan>');
      return `<text class="lab" x="${x.toFixed(1)}" y="${(y0 + 10).toFixed(1)}" text-anchor="${anchor}">${name}</text>`
        + (layers.length ? `<text class="pct" x="${x.toFixed(1)}" y="${(y0 + 10 + 13 * lines.length + 1).toFixed(1)}" text-anchor="${anchor}">${vals}</text>` : "");
    }).join("");
    const said = labels.map((a, i) => `${a.label} ${layers.map((L) => (L.values[i] == null ? "—" : L.values[i])).join(" / ") || "—"}`).join(", ");
    return `<svg class="v31Radar" viewBox="-44 0 408 290" role="img" aria-label="${esc(`Портрет игрока: ${said}`)}">${rings}${spokes}${shapes}${texts}</svg>`;
  }

  // which layers this player has, and which of them are shown
  function shown(p) {
    const have = { ea: !!(p && p.ea), season: !!(p && p.season), five: !!(p && p.five) };
    const on = {};
    for (const L of LAYERS) on[L.k] = have[L.k] && !!V31.on[L.k];
    // one layer is always on: the game, else the season, else the five seasons (a player outside the game opens on his season)
    if (!LAYERS.some((L) => on[L.k])) { const first = LAYERS.find((L) => have[L.k]); if (first) on[first.k] = true; }
    return { have, on };
  }

  function chips(p, have, on) {
    const why = { season: `с ${p.min_games || 5} матчей · сыграно ${p.season_games || 0}`, five: `от ${p.min_five_games || 82} матчей · сыграно ${p.five_games || 0}`, ea: "нет в игре" };
    return `<div class="v31Layers" role="group" aria-label="Слои портрета">${LAYERS.map((L) => {
      const label = L.k === "ea" && have.ea ? esc(p.ea.game || L.name) : esc(L.name); // the overall rating is in the head of the card
      return `<button type="button" data-v31-layer="${L.k}" aria-pressed="${on[L.k]}"${have[L.k] ? "" : " disabled"} style="--c:var(--${L.k})"><i></i>${label}${have[L.k] ? "" : ` <small>${esc(why[L.k])}</small>`}</button>`;
    }).join("")}</div>`;
  }

  function table(rows, cols) {
    if (!cols.length) return "";
    const head = `<thead><tr><th scope="col">Ось</th>${cols.map((c) => `<th scope="col" style="color:var(--${c.k})">${esc(c.name)}</th>`).join("")}</tr></thead>`;
    const body = rows.map((r, i) => `<tr><th scope="row">${esc(r.label)}</th>${cols.map((c) => {
      const x = c.cells[i] || {};
      return `<td><b style="color:var(--${c.k})">${x.v == null ? "—" : esc(x.v)}</b>${x.t ? `<small>${esc(x.t)}</small>` : ""}</td>`;
    }).join("")}</tr>`).join("");
    return `<table class="v31Tbl">${head}<tbody>${body}</tbody></table>`;
  }

  function cardHtml(p) {
    if (!p || !(p.ea || p.season || p.five)) return "";
    const { have, on } = shown(p);
    const goalie = p.pos_group === "G";
    const statCols = ["season", "five"].filter((k) => on[k]).map((k) => ({
      k, name: LAYERS.find((L) => L.k === k).name,
      cells: p[k].axes.map((a) => ({ v: a.pct, t: a.text })),
    }));
    const statRows = (p.season || p.five || {}).axes || [];
    const eaCol = on.ea ? { k: "ea", name: p.ea.game || "NHL 27", cells: p.ea.axes.map((a) => ({ v: a.value, t: "" })) } : null;
    let radar, tables;
    if (goalie && have.ea && on.ea) {
      // the game's goalie groups are not his numbers: the hexagon of the game, his season below it
      radar = radarSvg(p.ea.axes, [{ k: "ea", values: p.ea.axes.map((a) => a.value) }]);
      tables = table(p.ea.axes, [eaCol]) + (statCols.length ? table(statRows, statCols) : "");
    } else {
      const labels = goalie && statRows.length ? statRows : (p.ea || p.season || p.five).axes;
      const layers = [];
      if (eaCol) layers.push({ k: "ea", values: p.ea.axes.map((a) => a.value) });
      for (const c of statCols) layers.push({ k: c.k, values: c.cells.map((x) => x.v) });
      radar = radarSvg(labels, layers);
      tables = table(labels, [eaCol, ...statCols].filter(Boolean));
    }
    const notes = [];
    if (on.ea) notes.push(`${p.ea.game || "NHL 27"} — средняя оценка игры EA SPORTS по группе навыков, из 99${p.ea.overall ? `; общий рейтинг ${p.ea.overall}` : ""}.`);
    if (on.season || on.five) notes.push(`Сезон и 5 сезонов — лучше скольких ${p.peers_word}, в процентах (в сезоне — от ${p.min_games || 5} матчей, за 5 сезонов — от ${p.min_five_games || 82}).`);
    if (!have.ea) notes.push("Рейтинга NHL 27 у игрока нет: EA показывает только 300 лучших игроков лиги.");
    const head = have.ea ? `${esc(p.ea.game || "NHL 27")}${p.ea.overall ? ` · общий ${esc(p.ea.overall)}` : ""}` : `лучше скольких ${esc(p.peers_word)}, %`;
    return `<section class="v31Portrait" data-v31-portrait="1"><div class="v31PHead"><b>Портрет игрока</b><small>${head}</small></div>${chips(p, have, on)}${radar}${tables}${notes.map((t) => `<div class="v31Note">${esc(t)}</div>`).join("")}</section>`;
  }

  async function load(id, season) {
    const key = `${id}:${season}`;
    if (cache.has(key) || busy.has(key)) return;
    busy.add(key);
    try {
      const d = await H.api(`${API}${encodeURIComponent(id)}/profile?season=${encodeURIComponent(season)}`);
      cache.set(key, d && d.ok !== false ? d.profile || null : null);
    } catch (e) {
      cache.set(key, null);
    } finally {
      busy.delete(key);
    }
    update();
  }

  function update() {
    const page = document.querySelector("#view .v23PlayerProfile:not(.v23StatsPage)");
    if (!page) return;
    const cur = window.HOHV23 && window.HOHV23.current;
    const id = cur && cur.p && cur.p.player_id;
    const season = (cur && cur.pack && cur.pack.season) || "";
    if (!id || !season) return;
    const key = `${id}:${season}`;
    const have = page.querySelector("[data-v31-portrait]");
    if (have && have.dataset.key === key) return;
    if (!cache.has(key)) { load(id, season); return; }
    const html = cardHtml(cache.get(key));
    if (have) have.remove();
    if (!html) return;
    const box = document.createElement("div");
    box.innerHTML = html;
    const card = box.firstElementChild;
    card.dataset.key = key;
    const anchor = page.querySelector("#v23Season") || page.querySelector(".v23Head");
    if (anchor) anchor.after(card);
  }

  // a layer pressed: the same card drawn again in its place
  function press(btn) {
    const card = btn.closest("[data-v31-portrait]");
    const k = btn.dataset.v31Layer;
    if (!card || btn.disabled || !LAYERS.some((L) => L.k === k)) return;
    const p = cache.get(card.dataset.key);
    const { have, on } = shown(p);
    if (on[k] && LAYERS.filter((L) => on[L.k]).length === 1) return; // the last layer stays
    // what this player shows is what the viewer sees; a layer he lacks (the game) keeps the earlier choice
    for (const L of LAYERS) if (have[L.k]) V31.on[L.k] = on[L.k];
    V31.on[k] = !on[k];
    const box = document.createElement("div");
    box.innerHTML = cardHtml(p);
    const next = box.firstElementChild;
    if (!next) return;
    next.dataset.key = card.dataset.key;
    card.replaceWith(next);
    const again = next.querySelector(`[data-v31-layer="${k}"]`);
    if (again) again.focus();
  }
  document.addEventListener("click", (e) => {
    const btn = e.target && e.target.closest && e.target.closest("[data-v31-layer]");
    if (btn) press(btn);
  });

  V31.update = update;
  V31.radarSvg = radarSvg;
  V31.cardHtml = cardHtml;

  css();
  let pending = null;
  if (typeof MutationObserver === "function" && document.body) {
    new MutationObserver(() => {
      if (pending) return;
      pending = setTimeout(() => { pending = null; update(); }, 60);
    }).observe(document.body, { childList: true, subtree: true });
  }
  update();
}
