#!/usr/bin/env bash
# Route-integrity drill: prove the fudrouter data plane's credential behaviour
# on a THROWAWAY database + a local mock upstream. Zero writes to prod.
#
#   T0 control   pool=[live]          -> expect 200  (the mock really serves)
#   T1 failover  pool=[dead, live]    -> expect 200  (401 -> next account)
#   T2 failover  pool=[429,  live]    -> expect 200  (429 -> next account)
#   T3 failover  pool=[503,  live]    -> expect 200  (503 -> next account)
#   T4 all-dead  pool=[dead, dead]    -> clean bounded failure, not a hang
#   T5 failover  pool=[drop, live]    -> expect 200  (transport error -> next)
#
# Every scenario is an assertion now: the 429/503 failover that used to reach
# the client is fixed in the router, so a non-200 there is a REGRESSION and
# fails the run (it used to be reported as a non-fatal "gap").
#
#   ./tools/route-integrity/run.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB=fudrouter_ftest
RPORT=8198
MPORT=8201
BIN=/tmp/ftest-router
LOG=/tmp/ftest-upstream.log
RLOG=/tmp/ftest-router.log
WT=/tmp/fr-ftest
KEYFILE=/tmp/ftest.key
PG="docker exec -i postgres-hardened psql -U postgres"
Q() { docker exec -i postgres-hardened psql -U fudrouter -d "$DB" -tAc "$1"; }
FAILS=0
pass() { echo "  PASS  $*"; }
fail() { echo "  FAIL  $*"; FAILS=$((FAILS+1)); }

ROUTER_PID=""; MOCK_PID=""
cleanup() {
  [ -n "$ROUTER_PID" ] && kill "$ROUTER_PID" 2>/dev/null
  [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null
  docker exec -i postgres-hardened psql -U postgres -q -c "drop database if exists $DB;" >/dev/null 2>&1
  git -C "$ROOT" worktree remove --force "$WT" >/dev/null 2>&1
  rm -f "$BIN"
}
trap cleanup EXIT

cd "$ROOT"
echo "### preflight"
ss -ltn | grep -q ":$RPORT " && { echo "port $RPORT busy"; exit 1; }
ss -ltn | grep -q ":$MPORT " && { echo "port $MPORT busy"; exit 1; }
KM=$(grep '^CREDENTIALS_MASTER_KEY=' .env | cut -d= -f2-)
BASE=$(grep '^DATABASE_URL=' .env | cut -d= -f2-)
FTEST_DSN="${BASE%/*}/$DB"
[ -n "$KM" ] && [ -n "$BASE" ] || { echo "env parse failed"; exit 1; }

echo "### 1. fresh database"
$PG -q -c "drop database if exists $DB;" -c "create database $DB owner fudrouter;" || exit 1

echo "### 2. migrations (as the app role; gated files skipped like scripts/migrate.sh)"
shopt -s nullglob; MIGS=("$ROOT"/infra/migrations/*.sql); shopt -u nullglob
napplied=0
for f in "${MIGS[@]}"; do
  # Mirror scripts/migrate.sh's gate — it is the single source of truth. A file
  # whose header carries `-- gated:` is staged in the tree but MUST NOT be
  # applied until its writer/predicate cutover lands in the same commit. 0010
  # narrows the status CHECKs while the code still writes `active`, so applying
  # it here makes every seeded row die on check_violation; the drill has to
  # mirror prod, where 0010 is skipped.
  if grep -qiE '^--[[:space:]]*gated:' "$f"; then
    echo "  gated    $(basename "$f")"
    continue
  fi
  out=$(docker exec -i postgres-hardened psql -U fudrouter -d "$DB" -q -v ON_ERROR_STOP=1 < "$f" 2>&1) \
    || { echo "  migration failed: $(basename "$f"): $out"; exit 1; }
  napplied=$((napplied+1))
done
echo "  $napplied migrations OK"

echo "### 3. build router from the working tree (what is about to ship)"
(cd "$ROOT/services/router" && GOTOOLCHAIN=auto go build -trimpath -o "$BIN" .) || { echo "build failed"; exit 1; }
echo "  build: walk-bound=$(strings "$BIN" | grep -c 'pool walk stopped') failover=$(strings "$BIN" | grep -c shouldFailover) | deployed: walk-bound=$(strings "$ROOT/services/router/bin/fudrouter-router" 2>/dev/null | grep -c 'pool walk stopped') failover=$(strings "$ROOT/services/router/bin/fudrouter-router" 2>/dev/null | grep -c shouldFailover)"

echo "### 4. seed key + providers + connections + credentials + models"
# seed.mjs is self-contained: it mints the drill API key (the Svelte-era
# dev-api-key.mjs it used to restore from git was deleted with apps/web) and
# writes the provider/connection/credential/model/provider_model rows the
# router's candidate query actually walks.
DATABASE_URL="$FTEST_DSN" DEV_KEY_OUT="$KEYFILE" node "$SELF/seed.mjs" || exit 1
KEY=$(cat "$KEYFILE")
[ ${#KEY} -eq 47 ] || { echo "key length ${#KEY} != 47"; exit 1; }
echo "  key minted (47 chars), providers seeded"

echo "### 5. mock upstream + router"
python3 "$SELF/mock_upstream.py" "$MPORT" "$LOG" >/tmp/ftest-mock.log 2>&1 &
MOCK_PID=$!
for i in $(seq 1 60); do
  curl -s -o /dev/null "http://127.0.0.1:$MPORT/v1/models" && break
  sleep 0.5
done
curl -s -o /dev/null "http://127.0.0.1:$MPORT/v1/models" \
  || { echo "mock never came up"; cat /tmp/ftest-mock.log; exit 1; }
touch "$LOG"
DATABASE_URL="$FTEST_DSN" CREDENTIALS_MASTER_KEY="$KM" ALLOW_PRIVATE_UPSTREAMS=1 \
  ROUTER_ADDR=127.0.0.1:$RPORT "$BIN" >"$RLOG" 2>&1 &
ROUTER_PID=$!
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$RPORT/v1/models" || true)
  [ "$code" = "200" ] && break
  sleep 0.5
done
[ "$code" = "200" ] || { echo "router never became ready"; tail -5 "$RLOG"; exit 1; }
echo "  mock pid $MOCK_PID, router pid $ROUTER_PID ready"

req() { # req <model> <timeout_s> -> "code time_total"
  curl -s -o "/tmp/ftest-out-$1.json" -w '%{http_code} %{time_total}' --max-time "$2" \
    -X POST "http://127.0.0.1:$RPORT/v1/chat/completions" \
    -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
    -d "{\"model\":\"$1\",\"messages\":[{\"role\":\"user\",\"content\":\"say OK\"}],\"max_tokens\":8}"
}
mock_slice() { # mock_slice <from_line>
  tail -n +"$1" "$LOG" | sed 's/^[0-9]* //'
}

echo "### 6. tests"
N0=$(wc -l < "$LOG")
r=$(req ftest-ok 30); c=${r%% *}
[ "$c" = "200" ] && pass "T0 control: ftest-ok -> 200" || fail "T0 control: got $c"
echo "      mock saw: $(mock_slice $((N0+1)) | tr '\n' ';')"

N1=$(wc -l < "$LOG")
r=$(req ftest-dl 30); c=${r%% *}
[ "$c" = "200" ] && pass "T1 failover past 401: dead-first pool still served ($r)" \
  || fail "T1 failover past 401: got $c (the pool had a live account!)"
echo "      mock saw: $(mock_slice $((N1+1)) | tr '\n' ';')"

N2=$(wc -l < "$LOG")
r=$(req ftest-rl 30); c=${r%% *}
[ "$c" = "200" ] && pass "T2 failover past 429: served ($r)" \
  || fail "T2 429 did NOT fail over: client got $c while a live account sat in the pool"
echo "      mock saw: $(mock_slice $((N2+1)) | tr '\n' ';')"

N3=$(wc -l < "$LOG")
r=$(req ftest-br 30); c=${r%% *}
[ "$c" = "200" ] && pass "T3 failover past 503: served ($r)" \
  || fail "T3 503 did NOT fail over: client got $c while a live account sat in the pool"
echo "      mock saw: $(mock_slice $((N3+1)) | tr '\n' ';')"

r=$(req ftest-dead 30); c=${r%% *}; t=${r##* }
bounded=$(awk -v t="$t" 'BEGIN{print (t<5)?1:0}')
[ "$c" != "200" ] && [ "$bounded" = "1" ] && pass "T4 all-dead: clean failure $c in ${t}s (bounded)" \
  || fail "T4 all-dead: code=$c elapsed=${t}s (want non-200 in <5s)"

N4=$(wc -l < "$LOG")
r=$(req ftest-drop 30); c=${r%% *}
[ "$c" = "200" ] && pass "T5 failover past a transport error: served ($r)" \
  || fail "T5 transport error did not fail over: got $c (the pool had a live account!)"
echo "      mock saw: $(mock_slice $((N4+1)) | tr '\n' ';')"

echo "### 7. router log (credential lines)"
grep -E "account=|no usable|attempt" "$RLOG" | tail -12 || true
echo
echo "### summary: $FAILS failure(s)"
echo "  logs: $LOG  $RLOG"
[ "$FAILS" -eq 0 ] || exit 1
