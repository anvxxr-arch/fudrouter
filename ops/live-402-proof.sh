#!/usr/bin/env bash
# Live per-account 402 failover proof — deterministic, through the real stack.
#
# Why a mock: the prv_zro free pool is FLAKY (every key alternates 200/402 —
# 14b4b720 measured 41x200 + 16x402 in 24h), so "shrink to a spent key" A/B can
# only prove the contract by luck. v2 of verify-cred402-live.sh reported
# NO_CONTRAST twice for that reason.
#
# What this does instead: point the REAL connection at a loopback mock that
# answers 402 INSUFFICIENT_CREDITS for the first bearer token it sees and 200 for
# any sibling. Pool shrunk to two accounts, so the head account is guaranteed to
# hit the 402 and the router must rotate — real picker, real pool table, real
# ledger, real parking path.
#
# Everything is restored by a trap, including the connection base_url, so a crash
# cannot leave the provider pointed at the mock.
set -u
cd /home/dwizzy/fudrouter
set -a; . ./.env; set +a
KEY=$(grep '^HERMES_CUSTOM_API_FUDROUTER_API_KEY=' /home/dwizzy/.hermes/.env | cut -d= -f2- | tr -d '"'"'"'')
CONN=con_prv_zro-default
MOCKPORT=59999
MODEL=zro/glm-5.3-flash
CAND=${1:-cred_prv_zro_14b4b7209f686bb3}
FUNDED=cred_prv_zro_2668f1714d9a010e
TS=$(date +%Y%m%d-%H%M%S)
SNAP=ops/backups/zro-pool-$TS.tsv

ORIG_URL=$(psql "$DATABASE_URL" -Atc "select base_url from connection where id='$CONN'")
echo "$ORIG_URL" > /tmp/conn_base_url.orig
echo "### original base_url = $ORIG_URL"

probe() { curl -s -o /tmp/live402_body.json -w "%{http_code}" -m 30 -X POST http://127.0.0.1:8100/v1/chat/completions -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"say OK\"}],\"max_tokens\":8}"; }
restore_all() {
  echo ""
  echo "### RESTORE (trap): base_url + pool + restart"
  psql "$DATABASE_URL" -qAtc "update connection set base_url='$ORIG_URL' where id='$CONN'"
  pkill -f 'ops/mock-402-upstream.py' 2>/dev/null
  while IFS=$'\t' read -r id st pr cd; do
    [ -z "$id" ] && continue
    if [ -z "$cd" ]; then psql "$DATABASE_URL" -qAtc "update credential set status='$st', priority=$pr, cooldown_until=null where id='$id'" >/dev/null
    else psql "$DATABASE_URL" -qAtc "update credential set status='$st', priority=$pr, cooldown_until='$cd' where id='$id'" >/dev/null; fi
  done < "$SNAP"
  pm2 restart fudrouter-router >/dev/null 2>&1
  sleep 6
  echo "health=$(curl -s -o /dev/null -w '%{http_code}' -m 10 http://127.0.0.1:8100/health)  base_url_now=$(psql "$DATABASE_URL" -Atc "select base_url from connection where id='$CONN'")"
  echo "pool: $(psql "$DATABASE_URL" -Atc "select status||'='||count(*) from credential where connection_id='$CONN' group by status" | tr '\n' ' ')"
  redis-cli -u "$VALKEY_URL" --scan --pattern 'conc:*' 2>/dev/null | xargs -r redis-cli -u "$VALKEY_URL" del >/dev/null
}
trap restore_all EXIT

echo "### 0. binary: running=$(sha256sum /proc/$(pm2 pid fudrouter-router)/exe 2>/dev/null | cut -c1-16) disk=$(sha256sum backend/go/bin/fudrouter-router | cut -c1-16)"
echo "### 1. snapshot pool"
psql "$DATABASE_URL" -Atc "select id||E'\t'||status||E'\t'||priority||E'\t'||coalesce(cooldown_until::text,'') from credential where connection_id='$CONN'" > "$SNAP"
echo "rows=$(wc -l <"$SNAP")"

echo "### 2. plant spent head + funded sibling, disable the rest"
rm -f /tmp/mock402.state
psql "$DATABASE_URL" -qAtc "update credential set status='disabled' where connection_id='$CONN' and id not in ('$CAND','$FUNDED')"
psql "$DATABASE_URL" -qAtc "update credential set status='healthy', cooldown_until=null, priority=-1 where id='$CAND'"
psql "$DATABASE_URL" -qAtc "update credential set status='healthy', cooldown_until=null, priority=100 where id='$FUNDED'"
echo "pool: $(psql "$DATABASE_URL" -Atc "select status||'='||count(*) from credential where connection_id='$CONN' group by status" | tr '\n' ' ')"

echo "### 3. start mock 402 upstream on 127.0.0.1:$MOCKPORT"
nohup python3 ops/mock-402-upstream.py --port $MOCKPORT --state /tmp/mock402.state > /tmp/mock402.log 2>&1 &
sleep 2
curl -s -o /dev/null -w "mock /v1/models -> %{http_code}\n" -m 5 http://127.0.0.1:$MOCKPORT/v1/models

echo "### 4. point the connection at the mock + restart (base_url is read at boot)"
psql "$DATABASE_URL" -qAtc "update connection set base_url='http://127.0.0.1:$MOCKPORT/v1' where id='$CONN'"
pm2 restart fudrouter-router >/dev/null 2>&1
sleep 7
echo "health=$(curl -s -o /dev/null -w '%{http_code}' -m 10 http://127.0.0.1:8100/health)"

WD_START=$(date -u +%Y-%m-%dT%H:%M:%S)
echo "### 5. fire 6 requests — head account answers 402, router must rotate"
ok=0; fail=0
for i in 1 2 3 4 5 6; do
  c=$(probe); [ "$c" = "200" ] && ok=$((ok+1)) || { fail=$((fail+1)); echo "  body: $(head -c 200 /tmp/live402_body.json)"; }
  echo "req$i -> $c"
  sleep 1
done
echo "### TREATMENT ok=$ok fail=$fail"

echo "### 6. mock upstream log (who got 402, who got 200)"
cat /tmp/mock402.log | tail -20

echo "### 7. attempt chains (the proof: 402 on head, then 200 on sibling)"
psql "$DATABASE_URL" -Atc "select to_char(min(started_at),'HH24:MI:SS')||' | '||string_agg(attempt||':'||coalesce(credential_id,'-')||':'||coalesce(http_status::text,'-')||':'||coalesce(error_code,'-'), ' -> ' order by attempt) from request_attempt where provider_id='prv_zro' and started_at > '$WD_START'::timestamptz group by request_id order by min(started_at)"

echo "### 8. client-visible outcome (window-bounded; counts must reconcile)"
psql "$DATABASE_URL" -Atc "select 'requests_in_window='||count(distinct ra.request_id)||' of_which_had_upstream_402='||count(distinct ra.request_id) filter (where ra.error_code='INSUFFICIENT_CREDITS')||' client_success='||count(distinct rl.id) filter (where rl.status='success')||' client_402='||count(distinct rl.id) filter (where rl.http_status=402) from request_attempt ra left join request_log rl on rl.id=ra.request_id where ra.provider_id='prv_zro' and ra.started_at > '$WD_START'::timestamptz"

echo "### 9. head row after (must be parked with a cooldown)"
psql "$DATABASE_URL" -Atc "select id||' status='||status||' cooldown_s='||coalesce(round(extract(epoch from (cooldown_until-now())))::text,'NULL') from credential where id='$CAND'"

echo "### 10. VERDICT"
n402=$(psql "$DATABASE_URL" -Atc "select count(*) from request_attempt where provider_id='prv_zro' and started_at > '$WD_START'::timestamptz and error_code='INSUFFICIENT_CREDITS'")
nrot=$(psql "$DATABASE_URL" -Atc "select count(distinct request_id) from request_attempt where provider_id='prv_zro' and started_at > '$WD_START'::timestamptz and error_code='INSUFFICIENT_CREDITS'")
echo "upstream_402_attempts=$n402 requests_that_rotated=$nrot client_ok=$ok client_fail=$fail"
if [ "$n402" -gt 0 ] && [ "$ok" -eq 6 ]; then echo "VERDICT: PROVEN — upstream 402 absorbed, client saw 200 every time"; else echo "VERDICT: INCONCLUSIVE (see numbers above)"; fi
echo "### DONE"
