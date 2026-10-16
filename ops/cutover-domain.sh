#!/usr/bin/env bash
# Canonical-domain cutover: https://ai.karepmuwes.my.id -> https://fudrouter.my.id
#
#   ops/cutover-domain.sh [new-origin]      default: https://fudrouter.my.id
#
# STEP 1 IS A GUARD, AND THE GUARD IS THE WHOLE POINT.
# better-auth derives the Discord redirectURI from ORIGIN
# (apps/web/server/index.mjs: `${ORIGIN}/api/auth/callback/discord`) and Discord
# validates that URI against the application's *registered* redirect list. That
# list is NOT writable through the API: PATCH /applications/@me -- and
# /applications/{id} -- answers 200 while silently dropping `redirect_uris`
# (measured: `description` in the same body applied normally, the URI list did
# not move). It is a Developer-Portal-only field. Flipping ORIGIN before the new
# URI is registered makes Discord answer "invalid redirect_uri", which breaks
# login on EVERY hostname, including the one that works today.
#
# Idempotent: re-running after a successful cutover changes nothing and exits 0.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NEW="${1:-https://fudrouter.my.id}"
NEW="${NEW%/}"
CALLBACK="/api/auth/callback/discord"

# ------------------------------------------------------------------ guard ----
set -a; . ./.env; set +a
: "${FLEXYROUTE_BOT_TOKEN:?FLEXYROUTE_BOT_TOKEN missing from .env}"

registered="$(curl -sS -H "Authorization: Bot $FLEXYROUTE_BOT_TOKEN" \
  https://discord.com/api/v10/applications/@me \
  | python3 -c 'import json,sys; print(" ".join(json.load(sys.stdin).get("redirect_uris") or []))')"

if [[ " $registered " != *" $NEW$CALLBACK "* ]]; then
  cat >&2 <<EOF
BLOCKED: $NEW$CALLBACK is not registered on the Discord application.
Nothing has been changed.

Registered right now:
  $registered

Add the missing URI at
  https://discord.com/developers/applications -> the app -> OAuth2 -> Redirects
and re-run this script.
EOF
  exit 2
fi

printf 'guard OK: %s is registered\n' "$NEW$CALLBACK"

# ------------------------------------------------------------------- .env ----
python3 - "$NEW" <<'PY'
import re, sys
new = sys.argv[1]
keys = {'ORIGIN', 'BETTER_AUTH_URL', 'PUBLIC_API_BASE_URL'}
out, changed = [], []
for line in open('.env', encoding='utf-8'):
    m = re.match(r'^([A-Z0-9_]+)=(.*)$', line.rstrip('\n'))
    if m and m.group(1) in keys and m.group(2) != new:
        changed.append((m.group(1), m.group(2), new))
        out.append(f'{m.group(1)}={new}\n')
    else:
        out.append(line)
if changed:
    open('.env', 'w', encoding='utf-8').write(''.join(out))
for k, was, now in changed:
    print(f'  .env {k}: {was} -> {now}')
if not changed:
    print(f'  .env already points at {new}')
PY

# ------------------------------------------------- frontend display default --
python3 - "$NEW" <<'PY'
import sys
p, new = 'apps/web/src/lib/api.ts', sys.argv[1]
s = open(p, encoding='utf-8').read()
old = "export const API_BASE_DISPLAY = import.meta.env?.VITE_PUBLIC_API_BASE_URL ?? 'https://ai.karepmuwes.my.id';"
new_line = f"export const API_BASE_DISPLAY = import.meta.env?.VITE_PUBLIC_API_BASE_URL ?? '{new}';"
if old in s:
    open(p, 'w', encoding='utf-8').write(s.replace(old, new_line))
    print(f'  {p}: API_BASE_DISPLAY default -> {new}')
elif new_line in s:
    print(f'  {p}: already {new}')
else:
    print(f'  WARNING {p}: default line not found, fix by hand', file=sys.stderr)
PY

# ---------------------------------------------------------------- rebuild ----
# NODE_ENV must be unset: `run.sh` exports production, and npm prunes
# devDependencies (vite, the react plugin) when it sees that, so the build dies.
# The bundle inlines API_BASE_DISPLAY, hence a rebuild is part of the cutover.
( cd apps/web && env -u NODE_ENV npm run build )

# ----------------------------------------------------------------- restart ---
# Through systemd, never `pm2 start|restart` from an operator shell: PM2 copies
# the calling shell's whole env into the process and into dump.pm2, and that
# shell carries agent provider keys.
sudo systemctl restart pm2-dwizzy
sleep 6

# ------------------------------------------------------------------ verify ---
rc=0
for u in "$NEW/" "$NEW/health" "$NEW/v1/models" "$NEW/docs"; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 "$u")"
  printf '  %-34s %s\n' "$u" "$code"
  [[ "$code" == 200 ]] || rc=1
done
echo "  --- console app status ---"
pm2 jlist 2>/dev/null | python3 -c "
import json,sys
for a in json.load(sys.stdin):
    if a['name'] == 'fudrouter-console':
        print('   ', a['name'], a['pm2_env']['status'], 'restarts=' + str(a['pm2_env']['restart_time']))
"
exit "$rc"
