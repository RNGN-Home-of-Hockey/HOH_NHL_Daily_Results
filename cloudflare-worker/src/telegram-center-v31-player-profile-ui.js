// Live Center v31: the portrait of a player on his page — a hexagon of six axes (a pentagon for a goalie), where every axis is
// the share of the players of his position he is better than, and under it his strengths and his weaker sides in plain words.
// This function is serialized (playerProfileApp.toString()) and served as /telegram-app/v31-player.js: it must be self-contained.
export function playerProfileApp() {
  const H = window.HOHV15;
  if (!H || window.HOHV31) return;
  const V31 = (window.HOHV31 = {});
  const API = "/api/telegram-center-v31/players/";
  const cache = new Map(); // "<id>:<season>" -> profile | null
  const busy = new Set();
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  function css() {
    if (document.getElementById("v31css")) return;
    const style = document.createElement("style");
    style.id = "v31css";
    style.textContent = `
.v31Portrait{display:grid;gap:10px;margin:10px 0 4px;padding:14px;border:1px solid #e3dcf3;border-radius:18px;background:rgba(255,255,255,.9)}
html:not(.v15Light) .v31Portrait{border-color:#2e3142;background:rgba(16,18,26,.88)}
.v31PHead{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.v31PHead b{font-size:16px;font-weight:900}
.v31PHead small{font-size:11.5px;font-weight:700;color:#7d7a92}
.v31Radar{display:block;width:100%;max-width:380px;height:auto;justify-self:center}
.v31Radar .ring{fill:none;stroke:#d9d1ee;stroke-width:1}
html:not(.v15Light) .v31Radar .ring{stroke:#34374a}
.v31Radar .spoke{stroke:#e6e0f4;stroke-width:1}
html:not(.v15Light) .v31Radar .spoke{stroke:#2a2d3c}
.v31Radar .area{fill:rgba(122,61,240,.28);stroke:#7a3df0;stroke-width:2.5;stroke-linejoin:round}
.v31Radar .dot{fill:#7a3df0}
.v31Radar .lab{font:800 12px Inter,Arial,sans-serif;fill:#1d1b2b}
html:not(.v15Light) .v31Radar .lab{fill:#eeeaf8}
.v31Radar .pct{font:900 12px Inter,Arial,sans-serif;fill:#7a3df0}
html:not(.v15Light) .v31Radar .pct{fill:#c4a6ff}
.v31Side{display:grid;gap:6px}
.v31Side h4{margin:4px 0 0;font-size:12px;font-weight:900;letter-spacing:.4px;text-transform:uppercase;color:#17784f}
.v31Side.weak h4{color:#9a6a00}
html:not(.v15Light) .v31Side h4{color:#62e6ae}
html:not(.v15Light) .v31Side.weak h4{color:#f0c060}
.v31Item{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;align-items:center;padding:8px 10px;border-radius:12px;background:#effaf4}
.v31Side.weak .v31Item{background:#fff6e5}
html:not(.v15Light) .v31Item{background:#12271f}
html:not(.v15Light) .v31Side.weak .v31Item{background:#2a2312}
.v31Item b{font-size:14px;font-weight:900}
.v31Item .n{grid-row:span 2;display:grid;place-items:center;min-width:44px;height:44px;border-radius:12px;background:#17a06b;color:#fff;font-weight:900;font-size:15px}
.v31Side.weak .v31Item .n{background:#d39a1c}
.v31Item span{font-size:12.5px;color:#56607a;font-weight:600}
html:not(.v15Light) .v31Item span{color:#b8bdd0}
.v31Note{font-size:12px;color:#7d7a92;font-weight:600}
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

  // ---- the hexagon ------------------------------------------------------------------------------------------------------------
  function radarSvg(axes) {
    const n = axes.length;
    const cx = 160, cy = 132, R = 92;
    const at = (i, r) => {
      const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
      return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    };
    const poly = (r) => axes.map((_, i) => at(i, r).map((v) => v.toFixed(1)).join(",")).join(" ");
    const rings = [0.25, 0.5, 0.75, 1].map((f) => `<polygon class="ring" points="${poly(R * f)}"/>`).join("");
    const spokes = axes.map((_, i) => { const [x, y] = at(i, R); return `<line class="spoke" x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>`; }).join("");
    const pts = axes.map((a, i) => at(i, R * Math.max(0.04, (Number(a.pct) || 0) / 100)));
    const area = `<polygon class="area" points="${pts.map((p) => p.map((v) => v.toFixed(1)).join(",")).join(" ")}"/>`;
    const dots = pts.map(([x, y]) => `<circle class="dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5"/>`).join("");
    const labels = axes.map((a, i) => {
      const [x, y] = at(i, R + 22);
      const anchor = Math.abs(x - cx) < 8 ? "middle" : x > cx ? "start" : "end";
      const dy = y < cy - R * 0.6 ? -4 : y > cy + R * 0.6 ? 10 : 3;
      return `<text class="lab" x="${x.toFixed(1)}" y="${(y + dy).toFixed(1)}" text-anchor="${anchor}">${esc(a.label)}</text><text class="pct" x="${x.toFixed(1)}" y="${(y + dy + 14).toFixed(1)}" text-anchor="${anchor}">${a.pct == null ? "—" : esc(a.pct)}</text>`;
    }).join("");
    return `<svg class="v31Radar" viewBox="-40 0 400 280" role="img" aria-label="Портрет игрока: ${esc(axes.map((a) => `${a.label} ${a.pct ?? "—"}`).join(", "))}">${rings}${spokes}${area}${dots}${labels}</svg>`;
  }

  function cardHtml(p) {
    if (!p) return "";
    const item = (x) => `<div class="v31Item"><span class="n">${esc(x.pct)}</span><b>${esc(x.label)}</b><span>${esc(x.text)} · ${esc(x.note)}</span></div>`;
    const strong = p.strengths && p.strengths.length ? `<div class="v31Side"><h4>Сильные стороны</h4>${p.strengths.map(item).join("")}</div>` : "";
    const weak = p.weaker && p.weaker.length ? `<div class="v31Side weak"><h4>Слабее</h4>${p.weaker.map(item).join("")}</div>` : "";
    const note = p.low_sample ? '<div class="v31Note">Пока мало матчей — портрет уточнится с новыми играми.</div>' : "";
    return `<section class="v31Portrait" data-v31-portrait="1"><div class="v31PHead"><b>Портрет игрока</b><small>лучше скольких ${esc(p.peers_word)}, %</small></div>${radarSvg(p.axes || [])}${strong}${weak}${note}</section>`;
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
