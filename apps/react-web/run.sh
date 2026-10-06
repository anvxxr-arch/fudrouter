#!/usr/bin/env bash
# PM2 entrypoint for the React control plane.
# Sources .env.react-web so secrets stay out of ecosystem.config.cjs.
set -euo pipefail
cd /home/dwizzy/fudrouter/apps/react-web
set -a
. /home/dwizzy/fudrouter/.env.react-web
set +a
exec node server/index.mjs
