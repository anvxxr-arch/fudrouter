#!/usr/bin/env bash
# PM2 entrypoint for the control plane.
#
# Secrets stay in apps/web/.env and are sourced here at every start, so they are
# never duplicated into ecosystem.config.cjs or snapshotted into ~/.pm2/dump.pm2.
set -euo pipefail
cd "$(dirname "$0")"

set -a
. ./.env
set +a

exec node build/index.js
