#!/usr/bin/env bash
# Production deploy: Go-only fudrouter (no Node, no sidecar)
# API :8011 · UI :8012 · MITM :443
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
CGO_ENABLED=0 /usr/bin/go build -trimpath -ldflags '-s -w' -o bin/fudrouter ./cmd/fudrouter
# low-port bind for MITM :443 (needs root once)
if command -v setcap >/dev/null 2>&1; then
  sudo setcap 'cap_net_bind_service=+ep' "$ROOT/bin/fudrouter" || true
fi
pm2 delete fudrouter fudrouter-go fudrouter-failover 2>/dev/null || true
# free app ports only (do not touch unrelated listeners)
fuser -k 20128/tcp 20126/tcp 8011/tcp 8012/tcp 2>/dev/null || true
sleep 0.3
pm2 start "$ROOT/scripts/ecosystem.fudrouter-go.config.cjs"
pm2 save
sleep 1
curl -sf http://127.0.0.1:8011/api/health
echo
curl -sf http://127.0.0.1:8012/api/health
echo
curl -sf http://127.0.0.1:8011/api/mitm/status
echo
echo "OK production go-only :8011/:8012 + MITM"
pm2 list | grep fudrouter || true
