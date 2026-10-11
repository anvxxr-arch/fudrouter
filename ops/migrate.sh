#!/usr/bin/env bash
# ops/migrate.sh — apply backend/go/migrations/*.sql in lexical order.
#
# Replaces `drizzle-kit migrate`: the drizzle journal only knew 0000–0003 while
# 0004/0005 shipped as plain SQL, so the web plane silently skipped them
# (docs/specs/2026-09-30-platform-schema.md §13). This runner applies every file
# and records what it applied in `schema_migration`.
#
# Usage:
#   DATABASE_URL=postgres://... ops/migrate.sh          # apply pending
#   DATABASE_URL=postgres://... ops/migrate.sh status   # list pending
#
# Idempotent: a file recorded in `schema_migration` is skipped. `ON_ERROR_STOP`
# makes a failed file abort the run mid-transaction (each file is one BEGIN/
# COMMIT pair), so a partial migration is never recorded as applied.
set -euo pipefail

MODE="${1:-apply}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS="$ROOT/backend/go/migrations"
: "${DATABASE_URL:?DATABASE_URL is required}"

PSQL=(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q)

# The bookkeeping table predates the first backfill that uses it.
"${PSQL[@]}" -c 'CREATE TABLE IF NOT EXISTS "schema_migration" (
	"name" text PRIMARY KEY NOT NULL,
	"applied_at" timestamptz NOT NULL DEFAULT now()
)' >/dev/null

# Baseline: databases created before this runner existed (the live DB was
# shaped by `drizzle-kit push` and has no migration bookkeeping at all) already
# carry the S0 tables. Detecting `api_key` with an empty log means 0000–0005
# were applied by other means — record them rather than re-running them (0000
# would fail on existing tables). A truly fresh database has no `api_key` and
# applies the full sequence normally.
if [[ -z "$(psql "$DATABASE_URL" -At -c 'SELECT name FROM schema_migration LIMIT 1')" ]] &&
	[[ -n "$(psql "$DATABASE_URL" -At -c "SELECT to_regclass('public.api_key')")" ]]; then
	echo "baseline: existing S0 schema detected — recording migrations before 0006 as applied"
	for file in "$MIGRATIONS"/[0-9][0-9][0-9][0-5]_*.sql; do
		name="$(basename "$file" .sql)"
		"${PSQL[@]}" -c "INSERT INTO schema_migration (name) VALUES ('$name')
			ON CONFLICT (name) DO NOTHING" >/dev/null
	done
fi

applied=$("${PSQL[@]}" -At -c 'SELECT name FROM schema_migration')

for file in "$MIGRATIONS"/[0-9][0-9][0-9][0-9]_*.sql; do
	name="$(basename "$file" .sql)"
	if grep -qxF "$name" <<<"$applied"; then
		continue
	fi
	# GATED: a migration whose header carries `-- gated:` is staged in the tree
	# but MUST NOT be applied until its writer/predicate cutover lands in the
	# same commit (spec 2026-09-30-platform-schema §0010). This runner applies
	# every pending file, so without this check a push fires the half-cutover
	# against CI and every live database — the CHECK narrows while the writers
	# still emit the old literals, and every DB-backed test/daemon dies on
	# `check_violation`. The live DB already skipped 0010 for exactly this
	# reason; the gate makes that explicit and reproducible.
	if grep -qiE '^--[[:space:]]*gated:' "$file"; then
		[[ "$MODE" == "status" ]] && echo "gated    $name"
		continue
	fi
	if [[ "$MODE" == "status" ]]; then
		echo "pending  $name"
		continue
	fi
	echo "applying $name"
	"${PSQL[@]}" -f "$file" >/dev/null
	"${PSQL[@]}" -c "INSERT INTO schema_migration (name) VALUES ('$name')" >/dev/null
done

[[ "$MODE" == "status" ]] && echo "status: $(wc -l <<<"$applied") applied"
[[ "$MODE" == "status" ]] && exit 0

# Split S0 credential blobs into per-account rows. Needs the master key and the
# `postgres` npm package — skip cleanly (with a loud note) when the tooling is
# not present; 0009 refuses to drop the legacy blob until this has run.
if [[ -n "${CREDENTIALS_MASTER_KEY:-}" ]] && node -e "import('postgres')" 2>/dev/null; then
	node "$ROOT/ops/backfill-credentials.mjs"
else
	echo "note: skipping credential split (needs CREDENTIALS_MASTER_KEY and the postgres package)" >&2
fi
exit 0
