#!/usr/bin/env bash
# Production drill for the fudrouter data plane, from zero:
#   fresh DB -> all migrations -> build -> boot as production (NO dev flag)
#   -> prove the spec §1 interlock fails closed -> boot with the flag -> prove
#   it opens -> positive control (active provider always served) -> clean up.
#
# Exits non-zero if any assertion fails, so it is usable as a gate.
# Always drops its scratch database, including on failure.
#
#   ./tools/prod-router-drill.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB=fudrouter_drill
ROUTER_DIR="$ROOT/services/router"
MIGRATIONS="$ROOT/infra/migrations"
ENV_FILE="$ROOT/.env"
PG_CONTAINER="${FUDROUTER_PG_CONTAINER:-postgres-hardened}"
PG_USER="${FUDROUTER_PG_SUPERUSER:-postgres}"
APP_USER="${FUDROUTER_PG_USER:-fudrouter}"
PG="docker exec -i $PG_CONTAINER psql -U $PG_USER"
QRY() { docker exec -i "$PG_CONTAINER" psql -U "$APP_USER" -d "$DB" -tAc "$1"; }
# Migrations run as the APP role, like CI and a real deploy — run them as the
# superuser instead and the tables end up owned by postgres, so the app role
# gets "permission denied for table" on its first write.
MIG() { docker exec -i "$PG_CONTAINER" psql -U "$APP_USER" -d "$DB" "$@"; }
PORT="${FUDROUTER_DRILL_PORT:-8199}"
BIN=/tmp/fudrouter-router-drill
PANIC=0
FAILURES=0

cleanup() { docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -q -c "drop database if exists $DB;" >/dev/null 2>&1; }
trap cleanup EXIT

pass() { echo "  PASS  $*"; }
fail() { echo "  FAIL  $*"; FAILURES=$((FAILURES + 1)); }
check() { # check <actual> <expected> <label>
	if [ "$1" = "$2" ]; then pass "$3 (= $2)"; else fail "$3 (got $1, want $2)"; fi
}

echo "### 0. preflight"
[ -f "$ENV_FILE" ] || { echo "  missing $ENV_FILE — copy .env.example first"; exit 1; }
[ -d "$ROUTER_DIR" ] || { echo "  missing $ROUTER_DIR"; exit 1; }
shopt -s nullglob
MIG_FILES=("$MIGRATIONS"/*.sql)
shopt -u nullglob
[ ${#MIG_FILES[@]} -gt 0 ] || { echo "  no migrations found in $MIGRATIONS"; exit 1; }
echo "  ${#MIG_FILES[@]} migrations, router at $ROUTER_DIR, port $PORT"

echo "### 1. fresh database"
$PG -q -c "drop database if exists $DB;" -c "create database $DB owner $APP_USER;" || { fail "could not create $DB"; exit 1; }

echo "### 2. migrations (on empty DB)"
for f in "${MIG_FILES[@]}"; do
	out=$(MIG -q -v ON_ERROR_STOP=1 < "$f" 2>&1)
	rc=$?
	printf '  %-45s %s\n' "$(basename "$f")" "$([ $rc -eq 0 ] && echo OK || echo "FAILED: $out")"
	[ $rc -ne 0 ] && PANIC=1
done
[ $PANIC -ne 0 ] && { fail "migrations did not apply"; exit 1; }

echo "### 3. seed a dev + an active provider (dummy blob: listing never decrypts)"
QRY "insert into provider (id,name,base_url,credentials_enc,status,priority) values
 ('drill-dev','Drill Dev','https://example.invalid/v1','ZHVtbXk=','dev',100),
 ('drill-active','Drill Active','https://example.invalid/v1','ZHVtbXk=','active',100);
 insert into model (id,slug,name,provider_id,input_price,output_price,context,status) values
 ('drill-m-dev','drill-dev-model','Drill Dev Model','drill-dev',0,0,1000,'active'),
 ('drill-m-active','drill-active-model','Drill Active Model','drill-active',0,0,1000,'active');" \
	|| { fail "seed failed"; exit 1; }
echo "  seeded: $(QRY 'select count(*) from provider') providers, $(QRY 'select count(*) from model') models"

echo "### 3b. status constraints are enforced (migration 0005)"
# The seed above only proves the valid values are ACCEPTED. A CHECK that was
# added but never proven is a hope: the router matches `status` on exact string
# literals, so a value outside the set does not error — the row just silently
# stops being served. Probe both directions.
if QRY "insert into provider (id,name,base_url,credentials_enc,status,priority)
 values ('drill-bad','Drill Bad','https://example.invalid/v1','ZHVtbXk=','acitve',100);" >/dev/null 2>&1; then
	fail "provider_status_check accepted a typo status"
else
	pass "provider typo status rejected"
fi
if QRY "insert into model (id,slug,name,provider_id,input_price,output_price,context,status)
 values ('drill-bad-m','drill-bad-slug','Drill Bad','drill-active',0,0,1000,'published');" >/dev/null 2>&1; then
	fail "model_status_check accepted a typo status"
else
	pass "model typo status rejected"
fi
CONSTRAINTS=$(QRY "select count(*) from pg_constraint where conname in ('provider_status_check','model_status_check');")
check "$CONSTRAINTS" "2" "both status constraints present"

echo "### 4. boot production (ROUTER_ALLOW_DEV_PROVIDERS unset)"
set -a; . "$ENV_FILE"; set +a
export DATABASE_URL="${DATABASE_URL%/*}/$DB"
export ROUTER_ADDR=127.0.0.1:$PORT
unset ROUTER_ALLOW_DEV_PROVIDERS

# Build to a SCRATCH path: outputting to bin/ would silently replace the
# binary production is deployed from (with whatever is in the working tree).
(cd "$ROUTER_DIR" && go build -o "$BIN" .) || { fail "go build"; exit 1; }
echo "  go build OK -> $BIN"

"$BIN" >/tmp/drill-router.log 2>&1 &
PID=$!
for _ in $(seq 1 15); do curl -s -o /dev/null -m 2 "http://127.0.0.1:$PORT/health" && break; sleep 1; done
H=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:$PORT/health")
check "$H" "200" "/health"
MODELS=$(curl -s -m 10 "http://127.0.0.1:$PORT/v1/models")
echo "$MODELS" | grep -q 'drill-active-model' && A_OK=1 || A_OK=0
echo "$MODELS" | grep -q 'drill-dev-model' && D_VISIBLE=1 || D_VISIBLE=0
check "$A_OK" "1" "active provider served"
check "$D_VISIBLE" "0" "dev provider hidden with flag OFF (spec §1 fails closed)"
kill $PID 2>/dev/null
wait $PID 2>/dev/null

echo "### 5. boot with ROUTER_ALLOW_DEV_PROVIDERS=1 (opt-in opens it)"
export ROUTER_ALLOW_DEV_PROVIDERS=1
"$BIN" >/tmp/drill-router2.log 2>&1 &
PID=$!
for _ in $(seq 1 15); do curl -s -o /dev/null -m 2 "http://127.0.0.1:$PORT/health" && break; sleep 1; done
MODELS=$(curl -s -m 10 "http://127.0.0.1:$PORT/v1/models")
echo "$MODELS" | grep -q 'drill-dev-model' && D2=1 || D2=0
check "$D2" "1" "dev provider served once opted in"
kill $PID 2>/dev/null
wait $PID 2>/dev/null

echo "### 6. summary"
if [ "$FAILURES" -eq 0 ]; then
	echo "  ALL CHECKS PASSED — production posture correct"
else
	echo "  $FAILURES CHECK(S) FAILED"
fi
exit $((FAILURES > 0 ? 1 : 0))
