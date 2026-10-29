#!/usr/bin/env bash
# Nightly backup of the Timecard production data.
# Install at /usr/local/bin/timecard-backup.sh and run from root's crontab at 01:20 (after aracari's).
#
# The whole data set is one JSON file. The app writes it atomically (temp file + rename), so a
# plain copy always sees a complete file: no online-backup dance like the sqlite apps need.
# Kept 30 days locally and on the NAS.
#
# Not covered, on purpose: the container image (CI rebuilds it), compose.yml (in the repo) and
# .env.prod (secret — password manager).
set -euo pipefail

src=/srv/timecard/data/timecard.json
out=/srv/timecard/backups
nas=/mnt/backups/timecard
keep=30
stamp=$(date +%Y%m%dT%H%M%S)

mkdir -p "$out"
tmp="$out/timecard-$stamp.json"

cp "$src" "$tmp"

# an unverified backup is not a backup: it has to parse
python3 -c 'import json, sys; json.load(open(sys.argv[1]))' "$tmp"

gzip -9 "$tmp"
ln -sfn "$tmp.gz" "$out/latest.json.gz"

# off the box. a backup on the same disk does not survive the failure it exists for
if mountpoint -q /mnt/backups; then
	mkdir -p "$nas"
	cp "$tmp.gz" "$nas/"
	find "$nas" -maxdepth 1 -name 'timecard-*.json.gz' -mtime +$keep -delete
else
	echo "WARNING: /mnt/backups is not mounted - local copy only" >&2
fi

find "$out" -maxdepth 1 -name 'timecard-*.json.gz' -mtime +$keep -delete

# the monthly check reads this. a stale timestamp means the job has been failing quietly
date +%FT%T >"$out/last-success"
echo "ok $tmp.gz"
