#!/usr/bin/env bash
# PM2 entrypoint for the periodic scheduler (PRD §75–76).
#
# Same secret-handling rule as apps/web/run.sh and run-workers.sh: source
# apps/web/.env at every start so credentials are never copied into
# ecosystem.config.cjs or snapshotted into ~/.pm2/dump.pm2. scheduler.mjs
# resolves its own $lib graph, so any cwd works.
set -euo pipefail
cd "$(dirname "$0")/.."

set -a
. ./apps/web/.env
set +a

exec node scripts/scheduler.mjs
