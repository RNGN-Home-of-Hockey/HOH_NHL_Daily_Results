#!/bin/sh
# One line per run in /var/lib/hoh-clips/disk-watch.csv: when, how big the disk is, how much is used and free (GB).
# Once a day (03 UTC) it also adds the size of the big folders, so growth can be traced to its source.
# Read-only for everything except that one file: nothing is ever deleted here.
set -eu
out=/var/lib/hoh-clips/disk-watch.csv
mkdir -p /var/lib/hoh-clips
[ -f "$out" ] || echo "utc,total_gb,used_gb,free_gb,clips_live_gb,clips_vod_gb,other_mb" > "$out"
read -r total used free <<EOT
$(df -B1G --output=size,used,avail /opt/hoh-highlights | tail -1)
EOT
live=""; vod=""; other=""
if [ "$(date -u +%H)" = "03" ]; then
  live=$(du -s -B1G /opt/hoh-highlights/clips_live 2>/dev/null | cut -f1)
  vod=$(du -s -B1G /opt/hoh-highlights/clips_vod 2>/dev/null | cut -f1)
  other=$(du -s -B1M /opt/hoh-highlights/public_clips 2>/dev/null | cut -f1)
fi
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ),$total,$used,$free,$live,$vod,$other" >> "$out"
