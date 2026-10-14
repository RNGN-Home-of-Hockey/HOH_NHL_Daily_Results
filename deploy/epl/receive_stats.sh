#!/bin/sh
# Called over ssh by tools/epl_refresh_stats.py on the PC: swaps in the uploaded normalized/ data.
# Usage: receive_stats.sh /opt/hoh-epl/incoming/normalized.tar.gz
set -eu
BASE=/opt/hoh-epl
DATA="$BASE/repo/local-data/epl"
ARCHIVE="$1"
STAGE="$DATA/normalized.new"
rm -rf "$STAGE" && mkdir -p "$STAGE"
tar -xzf "$ARCHIVE" -C "$STAGE"
test -s "$STAGE/matches.json" && test -s "$STAGE/players.json"
flock -w 900 "$BASE/epl.lock" sh -c "rm -rf '$DATA/normalized.old'; if [ -d '$DATA/normalized' ]; then mv '$DATA/normalized' '$DATA/normalized.old'; fi; mv '$STAGE' '$DATA/normalized'"
rm -f "$ARCHIVE"
echo "stats swapped: $(ls "$DATA/normalized" | wc -l) files"
