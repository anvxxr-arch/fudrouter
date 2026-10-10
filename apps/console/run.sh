#!/usr/bin/env bash
# PM2 entrypoint for the React control plane.
# Sources .env.console so secrets stay out of ecosystem.config.cjs.
#
# Self-locating like apps/router/run.sh: the repo path is derived from this
# script, never hardcoded, so a checkout outside /home/dwizzy/fudrouter (or a
# moved tree) still starts.
set -euo pipefail
cd "$(dirname "$0")"
set -a
. ../../.env.console
set +a
: "${NODE_ENV:=production}"
export NODE_ENV
exec node server/index.mjs
