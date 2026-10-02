#!/usr/bin/env bash
# Build + deploy Go failover for fudrouter (no Node path).
# All files stay under /home/dwizzy/fudrouter-app
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/bin/failover"
ECO="$ROOT/scripts/ecosystem.failover.config.cjs"
ENV_FILE="$ROOT/scripts/.env-failover"
GO_BIN="${GO_BIN:-/usr/bin/go}"

MODE="passthrough"
for arg in "$@"; do
  case "$arg" in
    --race|race) MODE=race ;;
    --passthrough|passthrough) MODE=passthrough ;;
    --help|-h)
      echo "usage: $0 [--passthrough|--race]"
      exit 0
      ;;
    *)
      echo "unknown arg: $arg"
      echo "usage: $0 [--passthrough|--race]"
      exit 1
      ;;
  esac
done

cd "$ROOT"
mkdir -p "$ROOT/bin"

echo "[setup] go test..."
CGO_ENABLED=0 "$GO_BIN" test ./cmd/failover -count=1

echo "[setup] go build..."
CGO_ENABLED=0 "$GO_BIN" build -trimpath -ldflags '-s -w' -o "$BIN" ./cmd/failover
chmod +x "$BIN"

if [[ ! -f "$ENV_FILE" ]]; then
  cat >"$ENV_FILE" <<'EOF'
FAILOVER_PORT=20126
FAILOVER_MODE=passthrough
FAILOVER_BACKEND=http://127.0.0.1:20128
DATA_DIR=/home/dwizzy/.fudrouter
FAILOVER_DB_PATH=/home/dwizzy/.fudrouter/db/data.sqlite
MITM_ROUTER_BASE=http://127.0.0.1:20128
EOF
fi

if grep -q '^FAILOVER_MODE=' "$ENV_FILE"; then
  sed -i "s/^FAILOVER_MODE=.*/FAILOVER_MODE=$MODE/" "$ENV_FILE"
else
  echo "FAILOVER_MODE=$MODE" >>"$ENV_FILE"
fi

python3 - <<PY
from pathlib import Path
import re
p = Path("$ECO")
text = p.read_text()
text2 = re.sub(r'FAILOVER_MODE:\s*"[^"]*"', 'FAILOVER_MODE: "$MODE"', text)
p.write_text(text2)
print("[setup] ecosystem mode=$MODE")
PY

export DATA_DIR="${DATA_DIR:-/home/dwizzy/.fudrouter}"
python3 - <<'PY'
import json, os, sqlite3
db=os.path.join(os.environ.get("DATA_DIR","/home/dwizzy/.fudrouter"),"db","data.sqlite")
c=sqlite3.connect(db)
row=c.execute("SELECT data FROM settings WHERE id=1").fetchone()
data=json.loads(row[0]) if row and row[0] else {}
changed=False
if data.get("fallbackStrategy") not in ("fill-first","round-robin"):
    data["fallbackStrategy"]="fill-first"; changed=True
if not data.get("sticky"):
    data["sticky"]=1; changed=True
if data.get("mitmRouterBase") and "20126" in str(data.get("mitmRouterBase")) and os.environ.get("FORCE_MITM_FAILOVER")!="1":
    data["mitmRouterBase"]="http://127.0.0.1:20128"; changed=True
if changed:
    c.execute("UPDATE settings SET data=? WHERE id=1", (json.dumps(data),))
    c.commit()
print("[setup] settings:", {k:data.get(k) for k in ("fallbackStrategy","sticky","mitmRouterBase")})
c.close()
PY

pm2 delete fudrouter-failover >/dev/null 2>&1 || true
fuser -k 20126/tcp >/dev/null 2>&1 || true
sleep 0.3

pm2 start "$ECO"
pm2 save >/dev/null 2>&1 || true
sleep 0.8

PORT="$(python3 - <<'PY'
import re
from pathlib import Path
t=Path("/home/dwizzy/fudrouter-app/scripts/ecosystem.failover.config.cjs").read_text()
m=re.search(r'FAILOVER_PORT:\s*"(\d+)"', t)
print(m.group(1) if m else "20126")
PY
)"

echo "[setup] health check :$PORT"
curl -sf "http://127.0.0.1:${PORT}/_failover_health" | tee /tmp/fudrouter-failover-health.json
echo
python3 - <<'PY'
import json
h=json.load(open("/tmp/fudrouter-failover-health.json"))
assert h.get("runtime")=="go", h
assert h.get("status")=="ok", h
print("[setup] OK runtime=go mode=%s" % h.get("mode"))
PY

pm2 list | grep -E 'fudrouter|name' || true
