// Live Center v31: the portrait of a player on his page — one hexagon at a time: NHL 27 (the game's main groups, the main layer),
// «Сезон» or «5 сезонов» (his real numbers on their own axes). A chip switches the layer; nothing is drawn over anything else. The
// game needs no words; under the season layers every axis says its number, his place among the regulars and the share of them.
// A goalie: the game's goalie hexagon, his own pentagon for the seasons. A player the game does not publish opens on his season.
// Since 2026-10-19 the portrait has a page of its own (the player page opens it with «Портрет игрока»; v23 renderPortrait gives
// #v31Mount): nothing of it on the main page of the player.
// This function is serialized (playerProfileApp.toString()) and served as /telegram-app/v31-player.js: it must be self-contained.
export function playerProfileApp() {
  const H = window.HOHV15;
  if (!H || window.HOHV31) return;
  const V31 = (window.HOHV31 = {});
  const API = "/api/telegram-center-v31/players/";
  const cache = new Map(); // "<id>:<season>" -> profile | null
  const busy = new Set();
  const picked = new Map(); // "<id>:<season>" -> the layer the viewer chose on that card
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const LAYERS = [
    { k: "ea", name: "NHL 27" },
    { k: "season", name: "Сезон" },
    { k: "five", name: "5 сезонов" },
  ];
  function word(n, one, few, many) { const a = Math.abs(Math.trunc(Number(n) || 0)) % 100, b = a % 10; return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many; }

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
.v31Layers button:focus-visible{outline:2px solid var(--five);outline-offset:2px}
.v31Radar{display:block;width:100%;max-width:380px;height:auto;justify-self:center}
.v31Radar .ring{fill:none;stroke:#d9d1ee;stroke-width:1}
html:not(.v15Light) .v31Radar .ring{stroke:#34374a}
.v31Radar .spoke{stroke:#e6e0f4;stroke-width:1}
html:not(.v15Light) .v31Radar .spoke{stroke:#2a2d3c}
.v31Radar .area{fill-opacity:.16;stroke-width:2.4;stroke-linejoin:round}
.v31Radar .lab{font:800 12px Inter,Arial,sans-serif;fill:#1d1b2b}
html:not(.v15Light) .v31Radar .lab{fill:#eeeaf8}
.v31Radar .pct{font:900 12px Inter,Arial,sans-serif}
.v31Rows{display:grid}
.v31Empty{padding:18px 12px;text-align:center;color:#7d7a92;font-size:13px;font-weight:700}
.v31Row{display:grid;grid-template-columns:1fr auto;gap:1px 10px;align-items:baseline;padding:8px 2px;border-top:1px solid #ece7f6}
html:not(.v15Light) .v31Row{border-top-color:#2a2d3c}
.v31Row b{font-size:14px;font-weight:900}
.v31Row .v31Pct{font-size:18px;font-weight:900;font-variant-numeric:tabular-nums}
.v31Row small{grid-column:1 / -1;color:#7d7a92;font-size:12px;font-weight:600;line-height:1.35}
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
    return `<svg class="v31Radar" viewBox="-44 0 408 302" role="img" aria-label="${esc(`Портрет игрока: ${said}`)}">${rings}${spokes}${shapes}${texts}</svg>`;
  }

  // the layers this player has, and the one shown: the viewer's choice on this card, else the game, else the season
  function layersOf(p) {
    return LAYERS.filter((L) => p && p[L.k]);
  }
  function shownLayer(p, key) {
    const have = layersOf(p);
    const chosen = picked.get(key);
    return have.some((L) => L.k === chosen) ? chosen : have.length ? have[0].k : null;
  }

  // one axis of a season layer: «Атака 63% / 0,33 гола за матч · 152-е место из 280 нападающих»
  function rowsHtml(p, layer) {
    const rows = layer.axes.map((a) => {
      const place = a.place ? ` · ${esc(a.place)}-е место из ${esc(layer.of)} ${esc(p.peers_word)}` : "";
      return `<div class="v31Row"><b>${esc(a.label)}</b><span class="v31Pct">${a.pct == null ? "—" : `${esc(a.pct)}%`}</span>${a.text || place ? `<small>${esc(a.text)}${place}</small>` : ""}</div>`;
    }).join("");
    return `<div class="v31Rows">${rows}</div>`;
  }

  function cardHtml(p, key) {
    const have = layersOf(p);
    if (!have.length) return "";
    const k = shownLayer(p, key);
    const chips = `<div class="v31Layers" role="group" aria-label="Портрет игрока">${have.map((L) => `<button type="button" data-v31-layer="${L.k}" aria-pressed="${L.k === k}" style="--c:var(--${L.k})"><i></i>${esc(L.k === "ea" ? p.ea.game || L.name : L.name)}</button>`).join("")}</div>`;
    let head, body;
    if (k === "ea") {
      head = p.ea.overall ? `общий рейтинг ${esc(p.ea.overall)}` : "";
      body = radarSvg(p.ea.axes, [{ k: "ea", values: p.ea.axes.map((a) => a.value) }]);
    } else {
      const layer = p[k];
      head = `${esc(layer.games)} ${word(layer.games, "матч", "матча", "матчей")}`;
      body = radarSvg(layer.axes, [{ k, values: layer.axes.map((a) => a.pct) }]) + rowsHtml(p, layer);
    }
    return `<section class="v31Portrait" data-v31-portrait="1" data-v31-shown="${k}"><div class="v31PHead"><b>Портрет игрока</b><small>${head}</small></div>${chips}${body}</section>`;
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
    const mount = document.querySelector("#view .v23PortraitPage #v31Mount");
    if (!mount) return;
    const cur = window.HOHV23 && window.HOHV23.current;
    const id = cur && cur.p && cur.p.player_id;
    const season = (cur && cur.pack && cur.pack.season) || "";
    if (!id || !season) return;
    const key = `${id}:${season}`;
    if (mount.dataset.key === key) return;
    if (!cache.has(key)) { load(id, season); return; }
    // nothing to draw yet (a few games, not in the game): one short line, not an empty page
    mount.innerHTML = cardHtml(cache.get(key), key) || '<div class="v31Empty">Портрет появится после 5 матчей</div>';
    mount.dataset.key = key;
    const card = mount.querySelector("[data-v31-portrait]");
    if (card) card.dataset.key = key;
  }

  // a chip pressed: that layer alone, the same card drawn again in its place
  function press(btn) {
    const card = btn.closest("[data-v31-portrait]");
    const k = btn.dataset.v31Layer;
    if (!card || !LAYERS.some((L) => L.k === k) || card.dataset.v31Shown === k) return;
    const key = card.dataset.key;
    picked.set(key, k);
    const box = document.createElement("div");
    box.innerHTML = cardHtml(cache.get(key), key);
    const next = box.firstElementChild;
    if (!next) return;
    next.dataset.key = key;
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
