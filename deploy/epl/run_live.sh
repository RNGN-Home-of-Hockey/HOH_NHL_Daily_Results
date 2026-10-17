#!/bin/sh
# Live lines of the matches being played (kicked off in the last 3 hours) -> site data -> worker, every few minutes
# (hoh-epl-live.timer). The plates of a match being played keep their pre-match facts and get the live price of the
# same bet (tools/epl_site_data.py apply_live). Nothing to do when no match is being played.
set -eu
BASE=/opt/hoh-epl
cd "$BASE/repo"
export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="${PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH:-$(ls -d /root/.cache/ms-playwright/chromium-*/chrome-linux64/chrome | tail -1)}"
export EPL_INGEST_KEY_FILE="$BASE/secrets/ingest.key"
PY=/usr/bin/python3.14

IDS=$($PY -I tools/epl_site_data.py --live-ids)
[ -n "$IDS" ] || exit 0
node tools/winline_football/capture.mjs --events "$IDS" --pause 1500 --out local-data/epl/winline-live
flock -w 900 "$BASE/epl.lock" sh -c "$PY -I tools/epl_site_data.py && $PY -I tools/epl_publish.py"
