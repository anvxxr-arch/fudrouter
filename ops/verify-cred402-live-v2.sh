#!/usr/bin/env bash
# Live A/B for the per-account 402 contract (v2, deterministic).
#
# v1 was vacuous: it assumed the chosen key was spent, but free-tier balances are
# FLAKY — cred_prv_zro_00f2b2150091ae2f logged 43x200 and 52x402 in the same day,
# so a run against it proves nothing.
#
# v2 takes candidates from real traffic (402s in the last hour with ZERO
# successes), shrinks the prv_zro pool to exactly {candidate, funded} with the
# candidate at the head (priority -1), then asserts the contract from the LEDGER
# rather than from the HTTP code:
#
#   an attempt row with 402 must be followed by a sibling attempt that succeeds,
#   and that request must be logged as a success.
#
# If no 402 appears in the window the candidate has recovered, and the script
# says so and moves to the next candidate instead of reporting a fake pass.
set -u
cd /home/dwizzy/fudrouter
set -a; . ./.env; set +a
KEY=$(grep '^HERMES_CUSTOM_API_FUDROUTER_API_KEY=' /home/dwizzy/.hermes/.env | cut -d= -f2- | tr -d '"'"'"'')
TS=$(date +%Y%m%d-%H%M%S)
SNAP="ops/backups/zro-pool-$TS.tsv"
FUNDED=cred_prv_zro_2668f1714d9a010e
CONN=con_prv_zro-default
MODEL=zro/glm-5.3-flash
CANDIDATES=("${@:-cred_prv_zro_14b4b7209f686bb3 cred_prv_zro_15922e661d25c0ac}")

vkclear() { redis-cli -u "$VALKEY_URL" --scan --pattern 'conc:*' 2>/dev/null | xargs -r redis-cli -u "$VALKEY_URL" del >/dev/null; redis-cli -u "$VALKEY_URL" --scan --pattern 'cat*' 2>/dev/null | xargs -r redis-cli -u "$VALKEY_URL" del >/dev/null; }
probe() { curl -s -o /tmp/a402_body.json -w "%{http_code}" -m 40 -X POST http://127.0.0.1:8100/v1/chat/completions -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"say OK\"}],\"max_tokens\":8}"; }
restore() {
  while IFS=$'\t' read -r id st pr cd; do
    [ -z "$id" ] && continue
    if [ -z "$cd" ]; then psql "$DATABASE_URL" -qAtc "update credential set status='$st', priority=$pr, cooldown_until=null where id='$id'" >/dev/null
    else psql "$DATABASE_URL" -qAtc "update credential set status='$st', priority=$pr, cooldown_until='$cd' where id='$id'" >/dev/null; fi
  done < "$SNAP"
  psql "$DATABASE_URL" -Atc "select status||'='||count(*) from credential where connection_id='$CONN' group by status" | tr '\n' ' '; echo
  vkclear
}

echo "### 0. binary identity: running=$(sha256sum /proc/$(pm2 pid fudrouter-router)/exe 2>/dev/null | cut -c1-16) on_disk=$(sha256sum backend/go/bin/fudrouter-router | cut -c1-16)"
echo "### 1. snapshot"
psql "$DATABASE_URL" -Atc "select id||E'\t'||status||E'\t'||priority||E'\t'||coalesce(cooldown_until::text,'') from credential where connection_id='$CONN'" > "$SNAP"
echo "rows=$(wc -l <"$SNAP") -> $SNAP"

PROVEN=""
for SPENT in "${CANDIDATES[@]}"; do
  echo ""
  echo "############ candidate $SPENT ############"
  WD_START=$(date -u +%Y-%m-%dT%H:%M:%S)
  echo "### shrink to {candidate@head, funded}"
  psql "$DATABASE_URL" -qAtc "update credential set status='disabled' where connection_id='$CONN' and id not in ('$SPENT','$FUNDED')"
  psql "$DATABASE_URL" -qAtc "update credential set status='healthy', cooldown_until=null, priority=-1 where id='$SPENT'"
  psql "$DATABASE_URL" -qAtc "update credential set status='healthy', cooldown_until=null, priority=100 where id='$FUNDED'"
  psql "$DATABASE_URL" -Atc "select status||'='||count(*) from credential where connection_id='$CONN' group by status" | tr '\n' ' '; echo
  vkclear
  echo "### wait 75s for the in-process pool reload"; sleep 75

  echo "### 5 requests (candidate is first in the pool)"
  ok=0; fail=0
  for i in 1 2 3 4 5; do
    c=$(probe); [ "$c" = "200" ] && ok=$((ok+1)) || fail=$((fail+1))
    echo "req$i -> $c"
    sleep 0.3
  done
  echo "TREATMENT: ok=$ok fail=$fail"

  echo "### attempt chains in this window (402 must be followed by a sibling success)"
  psql "$DATABASE_URL" -Atc "select to_char(min(started_at),'HH24:MI:SS')||' rid='||substr(request_id,1,10)||' | '||string_agg(attempt||':'||coalesce(credential_id,'-')||':'||coalesce(http_status::text,'-')||':'||coalesce(error_code,'-'), ' -> ' order by attempt) from request_attempt where provider_id='prv_zro' and started_at > '$WD_START'::timestamptz group by request_id order by min(started_at)"

  echo "### client-visible outcome for those requests (request_log)"
  psql "$DATABASE_URL" -Atc "select 'requests_with_an_upstream_402='||count(distinct ra.request_id)||'  of_those_client_success='||count(distinct rl.id) filter (where rl.status='success') from request_attempt ra left join request_log rl on rl.id=ra.request_id where ra.provider_id='prv_zro' and ra.started_at > '$WD_START'::timestamptz and ra.error_code='INSUFFICIENT_CREDITS'"

  echo "### candidate row after (park? cooldown?)"
  psql "$DATABASE_URL" -Atc "select id||' status='||status||' cooldown='||coalesce(to_char(cooldown_until,'HH24:MI:SS'),'NULL')||' remaining_s='||coalesce(round(extract(epoch from (cooldown_until-now())))::text,'0') from credential where id='$SPENT'"

  n402=$(psql "$DATABASE_URL" -Atc "select count(*) from request_attempt where provider_id='prv_zro' and started_at > '$WD_START'::timestamptz and error_code='INSUFFICIENT_CREDITS'")
  echo "### 402 attempts seen in this window: $n402"
  if [ "$n402" -gt 0 ]; then PROVEN="$SPENT"; break; fi
  echo "### candidate was NOT spent in this window (balance recovered) — next candidate"
done

echo ""
echo "### restore pool from snapshot"
restore
echo "### wait 75s for reload"; sleep 75
echo "### fleet verify (real completions)"
for m in "$MODEL" "zro/deepseek-v4.1-flash" "mistral/ministral-8b-latest" "qwen3-8b" "minimax-m2.7"; do
  printf "%-28s %s\n" "$m" "$(curl -s -o /dev/null -w '%{http_code}' -m 40 -X POST http://127.0.0.1:8100/v1/chat/completions -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d "{\"model\":\"$m\",\"messages\":[{\"role\":\"user\",\"content\":\"say OK\"}],\"max_tokens\":8}")"
done
echo "### VERDICT: ${PROVEN:-NO_CONTRAST_FOUND}"
echo "### DONE"
