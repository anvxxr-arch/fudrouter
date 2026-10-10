#!/usr/bin/env bash
# PM2 entrypoint for the React control plane.
# Sources .env.react-web so secrets stay out of ecosystem.config.cjs.
#
# Self-locating like services/router/run.sh: the repo path is derived from this
# script, never hardcoded, so a checkout outside /home/dwizzy/fudrouter (or a
# moved tree) still starts.
set -euo pipefail
cd "$(dirname "$0")"
set -a
. ../../.env.react-web
set +a
: "${NODE_ENV:=production}"
export NODE_ENV
exec node server/index.mjs
