#!/bin/sh
# One cycle on the server (hoh-epl-lines.service): Winline lines -> site data -> hoh-epl worker.
# Layout: /opt/hoh-epl/repo = copy of this repo's EPL files, data in repo/local-data/epl,
# key in /opt/hoh-epl/secrets/ingest.key (0600). Statistics (normalized/) arrive from the PC
# (tools/epl_refresh_stats.py): the Premier League and Fantasy sites refuse Russian IPs.
set -eu
BASE=/opt/hoh-epl
cd "$BASE/repo"
export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="${PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH:-$(ls -d /root/.cache/ms-playwright/chromium-*/chrome-linux64/chrome | tail -1)}"
export EPL_INGEST_KEY_FILE="$BASE/secrets/ingest.key"
PY=/usr/bin/python3.14

node tools/winline_football/capture.mjs --limit 20 --pause 2000
# the build and the swap of normalized/ by the PC upload must not overlap
flock -w 900 "$BASE/epl.lock" sh -c "$PY -I tools/epl_site_data.py && $PY -I tools/epl_publish.py"
