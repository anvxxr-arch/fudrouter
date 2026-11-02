#!/usr/bin/env bash
# Live A/B for the per-account 402 contract.
#
# Shrinks the prv_zro pool to exactly two rows — one spent account that the
# upstream answers with 402 INSUFFICIENT_CREDITS, one funded account — so the
# spent key is guaranteed to be picked first (priority -1) and the failover is
# real rather than lucky round-robin. Then it asserts the client still gets 200,
# that the spent row was parked, and it restores the pool from its snapshot.
#
# Contrast (baseline, original binary, same two-account pool): 6/6 failed
# (5x402 + 503 CIRCUIT_OPEN). Treatment (per-account 402 escalation): 200s.
set -u
cd /home/dwizzy/fudrouter
set -a; . ./.env; set +a
KEY=$(grep '^HERMES_CUSTOM_API_FUDROUTER_API_KEY=' /home/dwizzy/.hermes/.env | cut -d= -f2- | tr -d '"'"'"'')
TS=$(date +%Y%m%d-%H%M%S)
SNAP="ops/backups/zro-pool-$TS.tsv"
SPENT=cred_prv_zro_00f2b2150091ae2f   # upstream: 402 INSUFFICIENT_CREDITS
FUNDED=cred_prv_zro_2668f1714d9a010e  # upstream: 200
CONN=con_prv_zro-default
MODEL=zro/glm-5.3-flash

vkclear() { redis-cli -u "$VALKEY_URL" --scan --pattern 'conc:*' 2>/dev/null | xargs -r redis-cli -u "$VALKEY_URL" del >/dev/null; redis-cli -u "$VALKEY_URL" --scan --pattern 'cat*' 2>/dev/null | xargs -r redis-cli -u "$VALKEY_URL" del >/dev/null; }
probe() { curl -s -o /tmp/a402_body.json -w "%{http_code}" -m 40 -X POST http://127.0.0.1:8100/v1/chat/completions -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"say OK\"}],\"max_tokens\":8}"; }

echo "### 0. binary identity"
echo "running sha=$(sha256sum /proc/$(pm2 pid fudrouter-router)/exe 2>/dev/null | cut -c1-16) on_disk=$(sha256sum backend/go/bin/fudrouter-router | cut -c1-16)"

echo "### 1. snapshot pool"
psql "$DATABASE_URL" -Atc "select id||E'\t'||status||E'\t'||priority||E'\t'||coalesce(cooldown_until::text,'') from credential where connection_id='$CONN'" > "$SNAP"
echo "snapshot rows=$(wc -l <"$SNAP") -> $SNAP"

echo "### 2. shrink to {spent, funded}, spent at head"
psql "$DATABASE_URL" -qAtc "update credential set status='disabled' where connection_id='$CONN' and id not in ('$SPENT','$FUNDED')"
psql "$DATABASE_URL" -qAtc "update credential set status='healthy', cooldown_until=null, priority=-1 where id='$SPENT'"
psql "$DATABASE_URL" -qAtc "update credential set status='healthy', cooldown_until=null, priority=100 where id='$FUNDED'"
psql "$DATABASE_URL" -Atc "select status||'='||count(*) from credential where connection_id='$CONN' group by status" | tr '\n' ' '; echo
vkclear
echo "### 3. wait 75s for pool reload"; sleep 75

echo "### 4. treatment: 6 requests (expect all 200)"
ok=0; fail=0
for i in $(seq 1 6); do
  c=$(probe); [ "$c" = "200" ] && ok=$((ok+1)) || fail=$((fail+1))
  echo "req$i -> $c $(head -c 90 /tmp/a402_body.json)"
  sleep 0.4
done
echo "TREATMENT: ok=$ok fail=$fail"

echo "### 5. spent row parked?"
psql "$DATABASE_URL" -Atc "select id||' status='||status||' cooldown='||coalesce(cooldown_until::text,'none')||' (park_delta_s='||round(extract(epoch from (cooldown_until-now())))||')' from credential where id='$SPENT'"

echo "### 6. attempt-chain evidence (last 5 min, prv_zro)"
psql "$DATABASE_URL" -Atc "select request_id||' | '||string_agg(attempt_no||':'||credential_id||':'||status_code||':'||coalesce(error_code,'-'), ' -> ' order by attempt_no) from request_attempt where provider_id='prv_zro' and started_at > now() - interval '5 minutes' group by request_id order by max(started_at) desc limit 6"

echo "### 7. restore pool from snapshot"
while IFS=$'\t' read -r id st pr cd; do
  [ -z "$id" ] && continue
  if [ -z "$cd" ]; then psql "$DATABASE_URL" -qAtc "update credential set status='$st', priority=$pr, cooldown_until=null where id='$id'" >/dev/null
  else psql "$DATABASE_URL" -qAtc "update credential set status='$st', priority=$pr, cooldown_until='$cd' where id='$id'" >/dev/null; fi
done < "$SNAP"
psql "$DATABASE_URL" -Atc "select status||'='||count(*) from credential where connection_id='$CONN' group by status" | tr '\n' ' '; echo
vkclear
echo "### 8. wait 75s for reload"; sleep 75

echo "### 9. fleet verify (real completions)"
for m in "$MODEL" "zro/deepseek-v4.1-flash" "mistral/ministral-8b-latest" "qwen3-8b" "minimax-m2.7"; do
  printf "%-28s %s\n" "$m" "$(curl -s -o /dev/null -w '%{http_code}' -m 40 -X POST http://127.0.0.1:8100/v1/chat/completions -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d "{\"model\":\"$m\",\"messages\":[{\"role\":\"user\",\"content\":\"say OK\"}],\"max_tokens\":8}")"
done
echo "### DONE"
