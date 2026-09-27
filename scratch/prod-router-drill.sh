#!/usr/bin/env bash
# Production drill for the fudrouter data plane, from zero:
#   fresh DB -> all migrations -> build -> boot as production (NO dev flag)
#   -> prove the spec §1 interlock fails closed -> boot with the flag -> prove
#   it opens -> positive control (active provider always served) -> clean up.
set -uo pipefail

DB=fudrouter_drill
ROUTER_DIR=/home/dwizzy/fudrouter/services/router
PG="docker exec -i postgres-hardened psql -U postgres"
QRY() { docker exec -i postgres-hardened psql -U fudrouter -d "$DB" -tAc "$1"; }
# Migrations run as the APP role, like CI and a real deploy — run them as the
# superuser instead and the tables end up owned by postgres, so the app role
# gets "permission denied for table" on its first write.
MIG() { docker exec -i postgres-hardened psql -U fudrouter -d "$DB" "$@"; }
PORT=8199
PANIC=0

echo "### 1. fresh database"
$PG -q -c "drop database if exists $DB;" -c "create database $DB owner fudrouter;"

echo "### 2. migrations (on empty DB)"
for f in /home/dwizzy/fudrouter/infra/migrations/*.sql; do
  out=$(MIG -q -v ON_ERROR_STOP=1 < "$f" 2>&1)
  rc=$?
  printf '  %-45s %s\n' "$(basename "$f")" "$([ $rc -eq 0 ] && echo OK || echo "FAILED: $out")"
  [ $rc -ne 0 ] && PANIC=1
done
[ $PANIC -ne 0 ] && exit 1

echo "### 3. seed a dev + an active provider (dummy blob: listing never decrypts)"
QRY "insert into provider (id,name,base_url,credentials_enc,status,priority) values
 ('drill-dev','Drill Dev','https://example.invalid/v1','ZHVtbXk=','dev',100),
 ('drill-active','Drill Active','https://example.invalid/v1','ZHVtbXk=','active',100);
 insert into model (id,slug,name,provider_id,input_price,output_price,context,status) values
 ('drill-m-dev','drill-dev-model','Drill Dev Model','drill-dev',0,0,1000,'active'),
 ('drill-m-active','drill-active-model','Drill Active Model','drill-active',0,0,1000,'active');" || { echo "  SEED FAILED"; exit 1; }
echo "  dev/active rows seeded: $(QRY 'select count(*) from provider') providers, $(QRY 'select count(*) from model') models"

echo "### 4. boot production (ROUTER_ALLOW_DEV_PROVIDERS unset)"
set -a; . /home/dwizzy/fudrouter/apps/web/.env; set +a
export DATABASE_URL="${DATABASE_URL%/*}/$DB"
export ROUTER_ADDR=127.0.0.1:$PORT
unset ROUTER_ALLOW_DEV_PROVIDERS

# Build to a SCRATCH path: outputting to bin/ would silently replace the
# binary production is deployed from (with whatever is in the working tree).
BIN=/tmp/fudrouter-router-drill
cd "$ROUTER_DIR"
go build -o "$BIN" . || { echo "  BUILD FAILED"; exit 1; }
echo "  go build OK -> $BIN"

"$BIN" >/tmp/drill-router.log 2>&1 &
PID=$!
for i in $(seq 1 15); do curl -s -o /dev/null -m 2 "http://127.0.0.1:$PORT/health" && break; sleep 1; done
H=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:$PORT/health")
echo "  /health -> $H"
MODELS=$(curl -s -m 10 "http://127.0.0.1:$PORT/v1/models")
echo "$MODELS" | grep -q 'drill-active-model' && A_OK=1 || A_OK=0
echo "$MODELS" | grep -q 'drill-dev-model' && D_VISIBLE=1 || D_VISIBLE=0
echo "  active provider served: $A_OK (must be 1)"
echo "  dev provider served with flag OFF: $D_VISIBLE (must be 0 — §1 fails closed)"
[ "$A_OK" = 1 ] && [ "$D_VISIBLE" = 0 ] && echo "  PASS: production posture correct" || echo "  FAIL: production posture WRONG"
kill $PID 2>/dev/null; wait $PID 2>/dev/null

echo "### 5. boot with ROUTER_ALLOW_DEV_PROVIDERS=1 (opt-in opens it)"
export ROUTER_ALLOW_DEV_PROVIDERS=1
"$BIN" >/tmp/drill-router2.log 2>&1 &
PID=$!
for i in $(seq 1 15); do curl -s -o /dev/null -m 2 "http://127.0.0.1:$PORT/health" && break; sleep 1; done
MODELS=$(curl -s -m 10 "http://127.0.0.1:$PORT/v1/models")
echo "$MODELS" | grep -q 'drill-dev-model' && echo "  dev provider NOW served: PASS" || echo "  dev provider still hidden: FAIL"
kill $PID 2>/dev/null; wait $PID 2>/dev/null

echo "### 6. cleanup"
docker exec -i postgres-hardened psql -U postgres -q -c "drop database if exists $DB;" && echo "  drill DB dropped"
echo "### drill done"
