#!/usr/bin/env python3
"""Put the Winline EPL plate assets into epl-site/assets/ (git-ignored: licensed fonts and partner artwork stay
out of the public repository; the folder is deployed to the worker and the server as it is).

  python -I tools/epl_plate_assets.py --fonts-zip "PF DIN (семьей).zip" --template plate.png [--badges]

- fonts: the four PF DIN Text Compressed Pro cuts the plate uses (Bold Italic, Regular, Bold, Light);
- template: the empty 1920x1080 plate (orange bar, black bar with the WINLINE logo, blue odds box, tab);
- badges: the 20 current clubs' crests from the Premier League's own badge server (200 px PNG), named by
  our club id, from the opta codes in local-data/epl/raw/pulselive/teams-<season>.json.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import epl_collect as epl  # noqa: E402

ASSETS = Path(__file__).resolve().parents[1] / "epl-site" / "assets"
FONT_FILES = ("PFDinTextCompPro-BoldItal.ttf", "PFDinTextCompPro-Regular.ttf", "PFDinTextCompPro-Bold.ttf", "PFDinTextCompPro-Light.ttf")
BADGE_URL = "https://resources.premierleague.com/premierleague/badges/100/{opta}@x2.png"


def copy_fonts(archive: Path) -> list[str]:
    target = ASSETS / "fonts"
    target.mkdir(parents=True, exist_ok=True)
    found = []
    with zipfile.ZipFile(archive) as bundle:
        for info in bundle.infolist():
            name = info.filename.replace("\\", "/").rsplit("/", 1)[-1]  # folder names inside may be in a legacy code page
            if name in FONT_FILES:
                (target / name).write_bytes(bundle.read(info))
                found.append(name)
    missing = sorted(set(FONT_FILES) - set(found))
    if missing:
        raise SystemExit(f"not in the archive: {', '.join(missing)}")
    return found


def download_badges() -> int:
    teams_file = epl.RAW / "pulselive" / f"teams-{epl.CURRENT_SEASON}.json"
    teams = json.loads(teams_file.read_text(encoding="utf-8"))
    teams = teams.get("content", teams) if isinstance(teams, dict) else teams
    target = ASSETS / "badges"
    target.mkdir(parents=True, exist_ok=True)
    count = 0
    for team in teams:
        opta = (team.get("altIds") or {}).get("opta")
        path = target / f"{int(team['id'])}.png"
        if not opta or path.exists():
            continue
        request = urllib.request.Request(BADGE_URL.format(opta=opta), headers={"User-Agent": epl.UA})
        with urllib.request.urlopen(request, timeout=30) as response:
            path.write_bytes(response.read())
        count += 1
        time.sleep(0.5)
    return count


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--fonts-zip", type=Path, help="the PF DIN family archive")
    parser.add_argument("--template", type=Path, help="the empty plate PNG (1920x1080)")
    parser.add_argument("--badges", action="store_true", help="download missing club crests")
    args = parser.parse_args(argv)
    ASSETS.mkdir(parents=True, exist_ok=True)
    if args.fonts_zip:
        print("fonts:", ", ".join(copy_fonts(args.fonts_zip)))
    if args.template:
        shutil.copyfile(args.template, ASSETS / "plate-template.png")
        print("template copied")
    if args.badges:
        print(f"badges downloaded: {download_badges()}, now {len(list((ASSETS / 'badges').glob('*.png')))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
