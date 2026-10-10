#!/usr/bin/env bash
# PM2 entrypoint for the React control plane.
# Sources .env.console so secrets stay out of ecosystem.config.cjs.
#
# Self-locating like apps/router/run.sh: the repo path is derived from this
# script, never hardcoded, so a checkout outside /home/dwizzy/fudrouter (or a
# moved tree) still starts.
set -euo pipefail
cd "$(dirname "$0")"
# Shared values come from the root .env; this app's own file is sourced SECOND so
# app-scoped keys (PORT) override, and a shared secret lives in exactly one place --
# a rotation in .env can no longer be shadowed by a stale copy in here (M7).
set -a
. ../../.env
. ../../.env.console
set +a
: "${NODE_ENV:=production}"
export NODE_ENV
exec node server/index.mjs
