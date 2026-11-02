#!/usr/bin/env bash
# revive-provider.sh <provider_id> [--sample N] [--concurrency N]
#
# Revive a DARK credential pool: probe every stored credential (decrypt ->
# GET <base>/models) and write the verdict back as status, then rebuild the
# routing blob and prove the provider with per-model chat calls.
#
# Why: `poolrebuild` only carries credential.status='healthy' rows into the
# router's blob, so a pool parked at `unknown` is invisible even when every key
# still answers 200 (measured: prv_dahl 18 856 rows at `unknown`, sample 80/80
# LIVE — the provider was dark, not dead).
#
# Usage: set -a && . /home/dwizzy/fudrouter/.env && set +a
#        ops/revive-provider.sh prv_dahl [--sample 80]
set -uo pipefail
PROV=${1:?usage: revive-provider.sh <provider_id> [--sample N] [--concurrency N]}
shift || true
FR=/home/dwizzy/fudrouter
cd "$FR" || exit 1
echo "==================== $(date -u +%FT%TZ) revive $PROV $*"

node ops/cred-probe-promote.mjs "$PROV" --apply "$@"
echo "----- probe done rc=$?"

cd "$FR/backend/go" || exit 1
if [ -x ./bin/poolrebuild ]; then ./bin/poolrebuild "$PROV"; else go run ./cmd/poolrebuild "$PROV"; fi
echo "----- poolrebuild rc=$?"

pm2 restart fudrouter-router >/dev/null 2>&1
sleep 10

if [ -x ./bin/upchat ]; then ./bin/upchat "$PROV" 2>&1 | tail -20; else go run ./cmd/upchat "$PROV" 2>&1 | tail -20; fi
echo "==== $(date -u +%FT%TZ) revive $PROV done"
