#!/usr/bin/env bash
# PM2 entrypoint for the worker fleet (PRD §75–76).
#
# Same secret-handling rule: source the root .env at every
# start so credentials are never copied into ecosystem.config.cjs or snapshotted
# into ~/.pm2/dump.pm2. workers.mjs resolves its own $lib graph, so any cwd works.
set -euo pipefail
cd "$(dirname "$0")/../.."

set -a
. ./.env
set +a

# node --experimental-strip-types is not required: workers.mjs installs module
# hooks (registerHooks + stripTypeScriptTypes) to load the TS graph itself.
exec node apps/workers/workers.mjs
