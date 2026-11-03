#!/usr/bin/env bash
# Live A/B for the 429-balance contract (deterministic), the freemodel sibling
# of verify-cred402-live-v2.sh.
#
# Defect: freemodel.in answers an exhausted free-tier balance with HTTP 429
# ("Token balance exhausted. You have 0 tokens remaining and insufficient
# credit balance."). 429 is a per-account THROTTLE in the router, so the row
# was parked 'rate_limited' for the 60s default and the picker re-served it
# forever: measured 51 attempts/hour of 429 while 146 freshly-imported healthy
# credentials in the same pool recorded ZERO uses.
#
# Contract asserted here, from the LEDGER (not the HTTP code):
#   1. a drained credential served in the window gets status='invalid'
#      (the only status the candidate filter excludes)
#   2. the client still gets a success, from the funded sibling
#   3. a fresh credential is PICKED (its last_used_at advances), i.e. the walk
#      is no longer stuck re-serving the drained head
#
# Before the fix (1) ends 'rate_limited' with a ~60s cooldown and the drained
# head is re-picked after the bench; the ledger "before" is the 32-attempt
# credential this script selects as its candidate.
set -u
cd /home/dwizzy/fudrouter
set -a; . ./.env; set +a
KEY=$(grep '^HERMES_CUSTOM_API_FUDROUTER_API_KEY=' /home/dwizzy/.hermes/.env | cut -d= -f2- | tr -d '"'"'"'')
TS=$(date +%Y%m%d-%H%M%S)
SNAP="ops/backups/fm-pool-429-$TS.tsv"
MODEL=deepseek-v4.1-flash
CONNLIKE='con_prv_freemodel%'

Q() { psql "$DATABASE_URL" -qAtc "$1"; }
vkc() { redis-cli -u "$VALKEY_URL" --scan --pattern "$1" 2>/dev/null | xargs -r redis-cli -u "$VALKEY_URL" del >/dev/null; }
probe() { curl -s -o /tmp/q429_body.json -w '%{http_code}' -m 150 -X POST http://127.0.0.1:8100/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"say OK\"}],\"max_tokens\":8}"; }

echo "### 0. binary: running=$(sha256sum /proc/$(pm2 pid fudrouter-router)/exe 2>/dev/null | cut -c1-16) disk=$(sha256sum backend/go/bin/fudrouter-router | cut -c1-16)"

# --- pick the drained candidate (429s in the last 3h, no success) and a funded sibling
SPENT=$(Q "select credential_id from request_attempt where provider_id='prv_freemodel' and http_status=429
           and started_at>now()-interval '3 hours' group by 1 order by count(*) desc limit 1")
# a fresh (imported in the last 12h) credential that has never been used
FRESH=$(Q "select id from credential where connection_id like '$CONNLIKE' and status='healthy'
           and created_at>now()-interval '12 hours' and last_used_at is null order by created_at desc limit 1")
echo "candidate(drained)=$SPENT"
echo "sibling(fresh)   =$FRESH"
if [ -z "$SPENT" ] || [ -z "$FRESH" ]; then echo "### ABORT: could not select a candidate pair"; exit 2; fi

echo "### 1. snapshot"
Q "select id||E'\t'||status||E'\t'||priority||E'\t'||coalesce(cooldown_until::text,'') from credential where connection_id like '$CONNLIKE'" > "$SNAP"
echo "rows=$(wc -l <"$SNAP") -> $SNAP"

echo "### 2. shrink pool to {candidate@head, fresh}"
Q "update credential set status='disabled' where connection_id like '$CONNLIKE' and id not in ('$SPENT','$FRESH')" >/dev/null
Q "update credential set status='healthy', cooldown_until=null, priority=-1 where id='$SPENT'" >/dev/null
Q "update credential set status='healthy', cooldown_until=null, priority=100 where id='$FRESH'" >/dev/null
Q "select status||'='||count(*) from credential where connection_id like '$CONNLIKE' group by status" | tr '\n' ' '; echo
vkc 'conc:*'; vkc 'cat*'
WD=$(date -u +%Y-%m-%dT%H:%M:%S)
echo "### wait 75s for the in-process pool reload"; sleep 75

echo "### 3. five requests (drained credential is first in the pool)"
ok=0; fail=0
for i in 1 2 3 4 5; do
  c=$(probe); [ "$c" = "200" ] && ok=$((ok+1)) || fail=$((fail+1))
  echo "req$i -> $c"
  sleep 0.3
done
echo "### TREATMENT ok=$ok fail=$fail"

echo "### 4. attempt chains in this window"
Q "select to_char(min(started_at),'HH24:MI:SS')||' rid='||substr(request_id,1,10)||' | '||
     string_agg(attempt||':'||coalesce(substr(credential_id,1,24),'-')||':'||coalesce(http_status::text,'-')||':'||coalesce(error_code,'-'),' -> ' order by attempt)
   from request_attempt where provider_id='prv_freemodel' and started_at > '$WD'::timestamptz group by request_id order by min(started_at)"

echo "### 5. client-visible outcomes in window"
Q "select coalesce(http_status::text,'-')||' n='||count(*) from (select http_status from request_log where requested_model='$MODEL' and created_at > '$WD'::timestamptz) t group by http_status order by 2 desc"

echo "### 6. the drained candidate row after (must be invalid, no cooldown)"
Q "select id||' status='||status||' cooldown='||coalesce(to_char(cooldown_until,'HH24:MI:SS'),'NULL') from credential where id='$SPENT'"

echo "### 7. did the fresh sibling get picked?"
Q "select id||' last_used='||coalesce(to_char(last_used_at,'HH24:MI:SS'),'NULL')||' uses_in_window='||coalesce((
     select count(*) from request_attempt a where a.credential_id=c.id and a.started_at>'$WD'::timestamptz)::text,'0') from credential c where id='$FRESH'"

echo "### 8. how many times was the drained cred served AFTER it was parked?"
Q "select 'attempts_on_drained_in_window='||count(*) from request_attempt where credential_id='$SPENT' and started_at>'$WD'::timestamptz"

# --- verdict
ST=$(Q "select status from credential where id='$SPENT'")
USED=$(Q "select count(*) from request_attempt where credential_id='$FRESH' and started_at>'$WD'::timestamptz")
if [ "$ST" = "invalid" ] && [ "$USED" -gt 0 ] && [ "$ok" -gt 0 ]; then
  echo "### VERDICT: PROVEN (drained parked invalid, fresh sibling served, client ok=$ok)"
else
  echo "### VERDICT: NOT_PROVEN (drained status=$ST sibling_uses=$USED client_ok=$ok)"
fi

echo "### 9. restore pool from snapshot"
while IFS=$'\t' read -r id st pr cd; do
  [ -z "$id" ] && continue
  if [ -z "$cd" ]; then Q "update credential set status='$st', priority=$pr, cooldown_until=null where id='$id'" >/dev/null
  else Q "update credential set status='$st', priority=$pr, cooldown_until='$cd' where id='$id'" >/dev/null; fi
done < "$SNAP"
Q "select status||'='||count(*) from credential where connection_id like '$CONNLIKE' group by status" | tr '\n' ' '; echo
vkc 'conc:*'; vkc 'cat*'
echo "### wait 75s for reload"; sleep 75
echo "### 10. fleet verify (real completions)"
for m in "$MODEL" deepseek-v4-flash-0731; do
  printf '%-26s %s\n' "$m" "$(curl -s -o /dev/null -w '%{http_code}' -m 150 -X POST http://127.0.0.1:8100/v1/chat/completions \
    -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
    -d "{\"model\":\"$m\",\"messages\":[{\"role\":\"user\",\"content\":\"say OK\"}],\"max_tokens\":8}")"
done
echo "### DONE"
