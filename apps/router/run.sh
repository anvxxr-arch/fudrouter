#!/usr/bin/env bash
# PM2 entrypoint for the data plane.
#
# The Go binary reads plain environment variables, so the shared control-plane
# .env is sourced here rather than copied into ecosystem.config.cjs.
set -euo pipefail
cd "$(dirname "$0")"

set -a
. ../../.env
set +a

exec ./bin/fudrouter-router
