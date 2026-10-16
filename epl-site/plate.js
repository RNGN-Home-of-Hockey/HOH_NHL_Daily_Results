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
  team: { font: 'boldItalic', size: 40, x: 211, baseline: 921, maxWidth: 300, minSize: 26, tracking: -0.01, color: '#ffffff' },
  bet: { font: 'regular', size: 29.45, x: 211, baseline: 954, maxWidth: 300, minSize: 20, tracking: -0.01, color: '#ffffff' },
  odds: { font: 'bold', size: 63.14, center: 861, baseline: 947, maxWidth: 165, minSize: 40, color: '#ffffff' },
  profit: { font: 'boldItalic', size: 34.15, right: 913.5, baseline: 1005, maxWidth: 225, minSize: 24, color: '#ff6a13' },
  stake: { font: 'light', size: 23.91, right: 911, baseline: 1027, maxWidth: 225, minSize: 18, color: '#ffffff' },
};
// The crest slot: the left end of the black bar (its bottom-left corner is rounded). One crest is drawn big and cut by
// the bar like in the example; two crests (a bet on the match) are drawn whole, side by side.
const SLOT = { left: 69, top: 877, right: 205, bottom: 972, radius: 12 };
const ONE_CREST = { size: 170, right: 205, centerY: 924.5 };
const WHOLE_CREST = { size: 86, centerX: 137, centerY: 924.5 };  // the operator's alternative: the crest uncut inside the bar
const TWO_CRESTS = { size: 78, centers: [104, 170], centerY: 924.5 };
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

function slotPath(ctx) {
  const { left, top, right, bottom, radius } = SLOT;
  ctx.beginPath();
  ctx.moveTo(left, top);
  ctx.lineTo(right, top);
  ctx.lineTo(right, bottom);
  ctx.lineTo(left + radius, bottom);
  ctx.arcTo(left, bottom, left, bottom - radius, radius);
  ctx.closePath();
}

function drawContained(ctx, image, cx, cy, size) {
  const scale = Math.min(size / image.naturalWidth, size / image.naturalHeight);
  const w = image.naturalWidth * scale, h = image.naturalHeight * scale;
  ctx.drawImage(image, cx - w / 2, cy - h / 2, w, h);
}

async function drawCrests(ctx, base, crests, whole = false) {
  const list = (await Promise.all((crests || []).slice(0, 2).map((id) => loadImage(`${base}badges/${id}.png`)))).filter(Boolean);
  if (!list.length) return;
  ctx.save();
  slotPath(ctx);
  ctx.clip();
  if (list.length === 1 && whole) drawContained(ctx, list[0], WHOLE_CREST.centerX, WHOLE_CREST.centerY, WHOLE_CREST.size);
  else if (list.length === 1) drawContained(ctx, list[0], ONE_CREST.right - ONE_CREST.size / 2, ONE_CREST.centerY, ONE_CREST.size);
  else list.forEach((image, i) => drawContained(ctx, image, TWO_CRESTS.centers[i], TWO_CRESTS.centerY, TWO_CRESTS.size));
  ctx.restore();
}

const caps = (text) => String(text || '').replace(/\s+-\s+/g, ' – ').trim().toUpperCase();

/**
 * Renders a plate on `canvas` (resized to 1920x1080, transparent outside the plate).
 * plate = { headline, team, bet, odds, crests: [club ids], crestWhole?: one crest uncut instead of big, stake? }
 */
export async function renderPlate(canvas, plate) {
  const { base, template } = await loadPlateAssets();
  canvas.width = SIZE.width;
  canvas.height = SIZE.height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, SIZE.width, SIZE.height);
  ctx.drawImage(template, 0, 0, SIZE.width, SIZE.height);
  await drawCrests(ctx, base, plate.crests, plate.crestWhole);
  drawText(ctx, LAYOUT.headline, caps(plate.headline));
  drawText(ctx, LAYOUT.team, caps(plate.team));
  drawText(ctx, LAYOUT.bet, caps(plate.bet));
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
