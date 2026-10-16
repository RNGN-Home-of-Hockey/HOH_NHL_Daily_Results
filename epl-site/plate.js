// Winline EPL plate: the designer's empty 1920x1080 template + club crest + texts in PF DIN Text Compressed Pro.
// Sizes are the designer's (headline 40 Bold Italic, team 40 Bold Italic, bet 29.45 Regular, odds 63.14 Bold,
// profit 34.15 Bold Italic, stake note 23.91 Light); positions and the -0.01 em tracking were measured on the
// designer's example (pixel overlap 0.95 for the headline and the odds). Everything is drawn on a canvas, so the PNG
// is exactly what the operator sees. Fonts, template and crests live in assets/ (tools/epl_plate_assets.py, not in git).

export const SIZE = { width: 1920, height: 1080 };
export const CROP = { x: 60, y: 800, width: 920, height: 240 };  // the plate alone, for previews and "plate only" files
const FONT_FILES = { boldItalic: 'PFDinTextCompPro-BoldItal.ttf', regular: 'PFDinTextCompPro-Regular.ttf', bold: 'PFDinTextCompPro-Bold.ttf', light: 'PFDinTextCompPro-Light.ttf' };
const family = (key) => `EPL Plate ${key}`;
export const LAYOUT = {
  headline: { font: 'boldItalic', size: 40, x: 120, baseline: 856, maxWidth: 825, minSize: 26, tracking: -0.01, color: '#ffffff' },
  team: { font: 'boldItalic', size: 40, baseline: 921, minSize: 26, tracking: -0.01, color: '#ffffff' },  // x and width: textLeft()
  bet: { font: 'regular', size: 29.45, baseline: 954, minSize: 20, tracking: -0.01, color: '#ffffff' },
  odds: { font: 'bold', size: 63.14, center: 861, baseline: 947, maxWidth: 165, minSize: 40, color: '#ffffff' },
  profit: { font: 'boldItalic', size: 34.15, right: 913.5, baseline: 1005, maxWidth: 225, minSize: 24, color: '#ff6a13' },
  stake: { font: 'light', size: 23.91, right: 911, baseline: 1027, maxWidth: 225, minSize: 18, color: '#ffffff' },
};
// Crests (designer, 2026-10-16): every crest 77 px high, whole, at the left end of the black bar, vertically centred;
// one or two side by side (10 px apart), and the team and bet lines start 17 px after the last crest. Measured on the
// designer's two examples: crests at x 85-162 and 172-249, text at x 179 (one crest) / 266 (two). The text ends at
// x 514, before the WINLINE logo (x 530): 335 px for the text with one crest, 248 px with two, 429 px with none.
const BAR = { left: 85, right: 514, centerY: 923.5 };
const CREST = { size: 77, gap: 10, textGap: 17 };
export const textLeft = (crests) => (crests ? BAR.left + crests * CREST.size + (crests - 1) * CREST.gap + CREST.textGap : BAR.left);
export const textWidth = (crests) => BAR.right - textLeft(crests);
export const STAKE = 1000;

let assets = null;
const images = new Map();

function loadImage(src) {
  if (!images.has(src)) {
    images.set(src, new Promise((resolve) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => resolve(null);
      image.src = src;
    }));
  }
  return images.get(src);
}

export function loadPlateAssets(base = 'assets/') {
  if (!assets) {
    assets = (async () => {
      await Promise.all(Object.entries(FONT_FILES).map(async ([key, file]) => {
        const face = new FontFace(family(key), `url(${base}fonts/${file})`);
        await face.load();
        document.fonts.add(face);
      }));
      const template = await loadImage(`${base}plate-template.png`);
      if (!template) throw new Error('нет шаблона плашки (assets/plate-template.png)');
      return { base, template };
    })();
    assets.catch(() => { assets = null; });
  }
  return assets;
}

const rubles = (n) => {
  const n100 = n % 100, n10 = n % 10;
  return n10 === 1 && n100 !== 11 ? 'РУБЛЬ' : n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14) ? 'РУБЛЯ' : 'РУБЛЕЙ';
};
const money = (n) => (n >= 10000 ? n.toLocaleString('ru-RU').replace(/\s/g, ' ') : String(n));

export function profitText(odds, stake = STAKE) {
  const win = Math.round((Number(odds) - 1) * stake);
  return `+${money(win)} ${rubles(win)}`;
}

export const oddsText = (odds) => Number(odds).toFixed(2);

function setFont(ctx, spec, size) {
  ctx.font = `${size}px "${family(spec.font)}"`;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${(spec.tracking || 0) * size}px`;
}

/** Draws one line: shrinks the font down to minSize to fit maxWidth, then narrows it (not below 80%) if still too wide. */
function drawText(ctx, spec, text) {
  if (!text) return;
  let size = spec.size;
  setFont(ctx, spec, size);
  let width = ctx.measureText(text).width;
  while (width > spec.maxWidth && size > spec.minSize) {
    size = Math.max(spec.minSize, size - 0.5);
    setFont(ctx, spec, size);
    width = ctx.measureText(text).width;
  }
  const squeeze = width > spec.maxWidth ? Math.max(0.8, spec.maxWidth / width) : 1;
  const drawn = width * squeeze;
  const x = spec.center != null ? spec.center - drawn / 2 : spec.right != null ? spec.right - drawn : spec.x;
  ctx.save();
  ctx.translate(x, spec.baseline);
  ctx.scale(squeeze, 1);
  ctx.fillStyle = spec.color;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

const crestBoxes = new Map();

/** The crest image and the box of its visible pixels: the badge files have transparent margins of different sizes,
 *  so the crest is cut to what is visible before it is scaled to 77 px. */
async function loadCrest(base, id) {
  const src = `${base}badges/${id}.png`;
  if (!crestBoxes.has(src)) {
    crestBoxes.set(src, loadImage(src).then((image) => {
      if (!image) return null;
      const probe = document.createElement('canvas');
      probe.width = image.naturalWidth;
      probe.height = image.naturalHeight;
      const ctx = probe.getContext('2d');
      ctx.drawImage(image, 0, 0);
      const alpha = ctx.getImageData(0, 0, probe.width, probe.height).data;
      let x0 = probe.width, y0 = probe.height, x1 = -1, y1 = -1;
      for (let y = 0; y < probe.height; y++) {
        for (let x = 0; x < probe.width; x++) {
          if (alpha[(y * probe.width + x) * 4 + 3] > 20) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
        }
      }
      return x1 < 0 ? null : { image, x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    }));
  }
  return crestBoxes.get(src);
}

/** Each crest whole, 77 px high (a wide one 77 px wide), centred in its 77 px slot. */
function drawCrests(ctx, crests) {
  crests.forEach((crest, i) => {
    const scale = Math.min(CREST.size / crest.w, CREST.size / crest.h);
    const w = crest.w * scale, h = crest.h * scale;
    const cx = BAR.left + i * (CREST.size + CREST.gap) + CREST.size / 2;
    ctx.drawImage(crest.image, crest.x, crest.y, crest.w, crest.h, cx - w / 2, BAR.centerY - h / 2, w, h);
  });
}

const caps = (text) => String(text || '').replace(/\s+-\s+/g, ' – ').trim().toUpperCase();

/**
 * Renders a plate on `canvas` (resized to 1920x1080, transparent outside the plate).
 * plate = { headline, team, bet, odds, crests: [club ids, up to two], stake? }; the team and bet lines move with the crests.
 */
export async function renderPlate(canvas, plate) {
  const { base, template } = await loadPlateAssets();
  const crests = (await Promise.all((plate.crests || []).slice(0, 2).map((id) => loadCrest(base, id)))).filter(Boolean);
  canvas.width = SIZE.width;
  canvas.height = SIZE.height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, SIZE.width, SIZE.height);
  ctx.drawImage(template, 0, 0, SIZE.width, SIZE.height);
  drawCrests(ctx, crests);
  const lines = { x: textLeft(crests.length), maxWidth: textWidth(crests.length) };
  drawText(ctx, LAYOUT.headline, caps(plate.headline));
  drawText(ctx, { ...LAYOUT.team, ...lines }, caps(plate.team));
  drawText(ctx, { ...LAYOUT.bet, ...lines }, caps(plate.bet));
  if (plate.odds) {
    drawText(ctx, LAYOUT.odds, oddsText(plate.odds));
    const stake = plate.stake || STAKE;
    drawText(ctx, LAYOUT.profit, profitText(plate.odds, stake));
    drawText(ctx, LAYOUT.stake, `(ПРИ СТАВКЕ ${money(stake)} ${rubles(stake)})`);
  }
  return canvas;
}

/** The plate alone (CROP) from a rendered 1920x1080 canvas, onto `target` (or a new canvas). */
export function cropPlate(source, target = document.createElement('canvas')) {
  target.width = CROP.width;
  target.height = CROP.height;
  const ctx = target.getContext('2d');
  ctx.clearRect(0, 0, CROP.width, CROP.height);
  ctx.drawImage(source, CROP.x, CROP.y, CROP.width, CROP.height, 0, 0, CROP.width, CROP.height);
  return target;
}

export const toBlob = (canvas) => new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
