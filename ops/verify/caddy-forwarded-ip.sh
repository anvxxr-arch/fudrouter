#!/usr/bin/env bash
# Asserts Caddy forwards the REAL client IP to the console (:3002).
#
# Why this exists: cloudflared dials Caddy from loopback, so Caddy's default
# X-Forwarded-For is 127.0.0.1. better-auth treats 127.0.0.1 as a trusted proxy,
# strips it from the chain, and then resolves NO client IP at all. Its rate
# limiter then falls back to one shared per-path bucket -- so one abuser locks
# out every visitor. The data plane (:8100) always had the header_up override;
# the console blocks did not, and nothing failed loudly. Hence this check.
#
# The observable is not the log line (logged once per process) but the bucket:
# exhaust IP A, and IP B must still be served.
set -uo pipefail

HOST_HDR="Host: fudrouter.my.id"
BODY='{"provider":"discord"}'
URL="http://127.0.0.1/api/auth/sign-in/social"
fail=0

post() {
  curl -s -o /dev/null -w '%{http_code}' -X POST "$URL" \
    -H "$HOST_HDR" -H 'content-type: application/json' \
    -H 'origin: https://fudrouter.my.id' \
    -H "CF-Connecting-IP: $1" -d "$BODY"
}

echo "==> exhausting 198.51.100.10 through Caddy"
last=""
for _ in $(seq 1 10); do last=$(post 198.51.100.10); done
echo "    last status: $last"
if [ "$last" != "429" ]; then
  echo "FAIL: never rate-limited -- limiter is not keying on this IP at all"
  fail=1
fi

echo "==> a different client IP must still be served"
b=$(post 198.51.100.20)
echo "    198.51.100.20 -> $b"
if [ "$b" = "429" ]; then
  echo "FAIL: shared bucket -- Caddy is not forwarding CF-Connecting-IP to :3002"
  echo "      fix: in the :3002 blocks of the Caddyfile,"
  echo "           header_up X-Forwarded-For {http.request.header.CF-Connecting-IP}"
  fail=1
fi

echo "==> and the header_up override is actually present in both blocks"
n=$(grep -c 'X-Forwarded-For {http.request.header.CF-Connecting-IP}' \
      /etc/caddy/Caddyfile 2>/dev/null || true)
# data plane /v1, data plane /health, console /fonts, console catch-all
if [ "${n:-0}" -lt 4 ]; then
  echo "FAIL: expected >=4 header_up overrides in /etc/caddy/Caddyfile, found ${n:-0}"
  fail=1
fi

if [ "$fail" -eq 0 ]; then echo "PASS: client IP reaches the console per-IP"; fi
exit "$fail"
