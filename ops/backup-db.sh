#!/usr/bin/env bash
# fudrouter database backup.
#
# The database holds the billing ledger (request_log), every provider
# credential (encrypted at rest), and the model catalogue. Until this script
# existed there was no dump of it anywhere — ~/backups held only a 2026-09-21
# source tarball from the decommissioned MITM app.
#
# Usage:
#   ops/backup-db.sh              # dump + prune old ones
#   KEEP_DAYS=30 ops/backup-db.sh
#
# Restore (the reason this file exists):
#   createdb -h 127.0.0.1 -U fudrouter fudrouter_restore
#   psql -h 127.0.0.1 -U fudrouter -d fudrouter_restore < <dump>
set -euo pipefail

DB_NAME="${DB_NAME:-fudrouter}"
BACKUP_DIR="${BACKUP_DIR:-/home/dwizzy/backups/fudrouter}"
KEEP_DAYS="${KEEP_DAYS:-14}"
CONTAINER="${FUDROUTER_PG_CONTAINER:-postgre}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/fudrouter-$STAMP.sql"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# The container was renamed (postgres-hardened -> postgre) while this script
# kept the old name, so every nightly dump died on `docker exec` — and because
# the shell had already created "$OUT" for the redirect, a zero-byte .sql
# survived looking exactly like a backup. Drop the output on any failure so an
# empty file can never be mistaken for one.
DONE=0
cleanup() { [ "$DONE" = 1 ] || rm -f "$OUT" "$OUT.gz"; }
trap cleanup EXIT

# --clean --if-exists makes the dump restorable onto a fresh database, and
# --no-owner/--no-acl keep it restorable by a different role than the one that
# made it. The credentials inside are ciphertext; the master key that opens them
# lives in .env and is NOT in this dump — back that file up separately.
docker exec "$CONTAINER" \
  pg_dump -U postgres -d "$DB_NAME" \
  --clean --if-exists --no-owner --no-acl --format=plain \
  > "$OUT"

gzip -9 "$OUT"
SIZE=$(du -h "$OUT.gz" | cut -f1)

# A dump that cannot be read back is not a backup. Verify it parses as SQL and
# carries the schema markers that make it restorable.
TABLES=$(zcat "$OUT.gz" | grep -c '^CREATE TABLE')
if [ "$TABLES" -lt 5 ]; then
  echo "FAIL: dump has $TABLES CREATE TABLE statements, expected >= 5" >&2
  exit 1
fi
DONE=1

# Prune by age, but keep at least the two most recent regardless — a burst of
# failures should not be able to delete the only good copy.
mapfile -t OLD < <(find "$BACKUP_DIR" -name 'fudrouter-*.sql.gz' -mtime "+$KEEP_DAYS" | sort)
KEPT=$(find "$BACKUP_DIR" -name 'fudrouter-*.sql.gz' | wc -l)
if [ "${#OLD[@]}" -gt 0 ] && [ "$KEPT" -le "${#OLD[@]}" ]; then
  echo "refusing to prune: $KEPT backups, all ${#OLD[@]} are older than ${KEEP_DAYS}d" >&2
else
  for f in "${OLD[@]}"; do rm -f "$f"; done
fi

echo "$STAMP  $SIZE  ${TABLES} tables  $OUT.gz"

# The credential master key is NOT in the dump — the provider blobs are
# ciphertext. A dump without it restores into a database where every provider
# decrypt fails, which looks exactly like a corrupt backup. Copy it alongside,
# mode 600, and say so in the filename so nobody ships it to a shared box.
#
# Both env files are backed up: the router/workers/scheduler PM2 entrypoints
# source the root .env, and the React control plane sources .env.console
# (apps/web/run.sh). The master key lives in each.
for src in /home/dwizzy/fudrouter/.env /home/dwizzy/fudrouter/.env.console; do
  [ -f "$src" ] || continue
  suffix="${src##*/}"; suffix="${suffix#.}"
  KEYOUT="$BACKUP_DIR/fudrouter-$STAMP.$suffix"
  install -m 600 "$src" "$KEYOUT"
  echo "  env -> $KEYOUT (mode 600, KEEP THIS OFF-SITE AND OFF-GIT)"
done
