#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path
from statistics import median

from PIL import ImageFont

TARGET_WIDTH_PX = 232
FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
]


def load_font(size: int):
    for path in FONT_CANDIDATES:
        if Path(path).exists():
            return ImageFont.truetype(path, size=size)
    return ImageFont.load_default()


def text_width(font, text: str) -> float:
    box = font.getbbox(text)
    return float(box[2] - box[0])


def main() -> int:
    names = json.loads(Path("ru_full_names.json").read_text(encoding="utf-8"))
    values = sorted({str(v).strip() for v in names.values() if str(v).strip()})
    if not values:
        raise SystemExit("ru_full_names.json is empty")

    lengths = sorted(len(x) for x in values)
    chosen = None
    audits = []
    for size in range(22, 11, -1):
        font = load_font(size)
        widths = [(text_width(font, name), name) for name in values]
        widths.sort(reverse=True)
        max_width, max_name = widths[0]
        fits = sum(1 for w, _ in widths if w <= TARGET_WIDTH_PX)
        audits.append({"size": size, "max_width": round(max_width, 1), "max_name": max_name, "fits": fits, "total": len(values)})
        if max_width <= TARGET_WIDTH_PX and chosen is None:
            chosen = size

    print(json.dumps({
        "names": len(values),
        "target_width_px": TARGET_WIDTH_PX,
        "length_min": lengths[0],
        "length_median": median(lengths),
        "length_p95": lengths[max(0, int(len(lengths) * .95) - 1)],
        "length_max": lengths[-1],
        "longest_by_chars": sorted(values, key=lambda x: (len(x), x), reverse=True)[:10],
        "recommended_universal_font_px": chosen,
        "audit": audits,
    }, ensure_ascii=False, indent=2))
    if chosen is None:
        raise SystemExit("No tested font size fits all names in the target width")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
