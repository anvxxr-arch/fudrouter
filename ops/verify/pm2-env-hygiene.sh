#!/usr/bin/env bash
# PM2 env hygiene check.
#
# Why this exists: PM2 captures the environment of whichever *client* created a
# process and writes it to ~/.pm2/dump.pm2, which `pm2 resurrect` replays at
# every boot. Create a service from an agent/CI shell and that shell's entire
# environment — provider API keys included — becomes part of the service
# definition, surviving restarts, `pm2 save`, and reboots. It has happened here
# twice (see docs/changelog/2026-10-10-pm2-env-capture.md).
#
# ecosystem.config.cjs declares `filter_env` so it cannot recur; this script is
# the assertion that it held. Run after any deploy.
#
# Usage: ops/verify/pm2-env-hygiene.sh [--quiet]
set -uo pipefail

# Depth matters: this file sits at ops/verify/, two levels under the repo root.
# It used to sit at tools/, one level. A stale `/..` here silently sets
# FUDROUTER_ROOT=ops/ and every path below resolves to nothing.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# PM2_DUMP_DIR lets the dump checks run against a fixture without moving
# PM2_HOME — pointing PM2_HOME elsewhere would also redirect `pm2 jlist` to a
# daemon that does not exist, and the live-env check would then read nothing.
PM2_DIR="${PM2_DUMP_DIR:-${PM2_HOME:-$HOME/.pm2}}"
QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1

fails=0
say() { [ "$QUIET" = 1 ] || printf '%s\n' "$*"; }
bad() { printf 'FAIL: %s\n' "$*"; fails=$((fails + 1)); }

# Both checks read the expected filter list from ecosystem.config.cjs, so this
# script cannot drift away from the configuration it verifies.
export FUDROUTER_ROOT="$ROOT"

say "=== dump files ==="
for f in "$PM2_DIR/dump.pm2" "$PM2_DIR/dump.pm2.bak"; do
	[ -f "$f" ] || continue
	perms=$(stat -c '%a' "$f")
	# The dump legitimately holds service credentials (DATABASE_URL, VALKEY_URL,
	# CREDENTIALS_MASTER_KEY) for apps that carry them in their env, so it must
	# never be group/world readable.
	[ "$perms" = "600" ] || bad "$f is mode $perms — must be 600 (it can contain service credentials)"
	say "  $f mode=$perms"
done

say
say "=== dump.pm2: filtered key names ==="
python3 - "$PM2_DIR/dump.pm2" <<'PY' || fails=$((fails + 1))
import json, os, subprocess, sys

root = os.environ["FUDROUTER_ROOT"]
filters = json.loads(subprocess.run(
    ["node", "-e",
     "const c=require('./ecosystem.config.cjs');"
     "if(!c.apps.every(a=>a.filter_env&&a.filter_env.length)){console.error('an app declares no filter_env');process.exit(3)};"
     "console.log(JSON.stringify(Object.fromEntries(c.apps.map(a=>[a.name,a.filter_env]))))"],
    cwd=root, capture_output=True, text=True, check=True).stdout)
allf = sorted({s for v in filters.values() for s in v})

try:
    dump = json.load(open(sys.argv[1]))
except Exception as e:
    print(f"FAIL: cannot parse dump: {e}")
    sys.exit(1)

total = 0
for app in dump:
    f = filters.get(app["name"], allf)
    keys = set(app) | set(app.get("env") or {})
    hits = sorted(k for k in keys if any(s in k for s in f))
    if hits:
        print(f"FAIL: {app['name']} dump entry carries {len(hits)} filtered key(s): {hits[:6]}")
    total += len(hits)
print(f"  entries={len(dump)} filtered_keys_present={total}")
sys.exit(1 if total else 0)
PY

say
say "=== live service envs ==="
python3 - <<'PY' || fails=$((fails + 1))
import json, os, subprocess, sys

root = os.environ["FUDROUTER_ROOT"]
filters = json.loads(subprocess.run(
    ["node", "-e",
     "const c=require('./ecosystem.config.cjs');"
     "console.log(JSON.stringify(Object.fromEntries(c.apps.map(a=>[a.name,a.filter_env||[]]))))"],
    cwd=root, capture_output=True, text=True, check=True).stdout)
allf = sorted({s for v in filters.values() for s in v})

try:
    apps = json.loads(subprocess.run(["pm2", "jlist"], capture_output=True, text=True).stdout or "[]")
except Exception as e:
    print(f"FAIL: `pm2 jlist` did not return JSON ({e}) — is the daemon up?")
    sys.exit(1)
if not apps:
    print("FAIL: pm2 reports no processes")
    sys.exit(1)

bad = 0
for app in apps:
    pid = app.get("pid")
    if not pid:
        print(f"FAIL: {app['name']} has no pid (not running)")
        bad += 1
        continue
    raw = open(f"/proc/{pid}/environ", "rb").read().decode("utf8", "ignore")
    keys = [kv.split("=", 1)[0] for kv in raw.split("\0") if "=" in kv]
    f = filters.get(app["name"], allf)
    hits = sorted(k for k in keys if any(s in k for s in f))
    if hits:
        print(f"FAIL: {app['name']} env carries {len(hits)} filtered key(s): {hits[:6]}")
        bad += 1
    else:
        print(f"  {app['name']}: clean ({len(keys)} keys)")
sys.exit(1 if bad else 0)
PY

say
if [ "$fails" -eq 0 ]; then
	say "pm2 env hygiene: PASS"
	exit 0
fi
printf 'pm2 env hygiene: %d FAILURE(S)\n' "$fails"
exit 1
