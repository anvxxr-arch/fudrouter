#!/usr/bin/env bash
# ops/cutover-p2b.sh — one-shot cutover for the moves that are bound to
# production: PM2 (ecosystem.config.cjs + ~/.pm2/dump.pm2), the host crontab and
# four systemd user units.
#
# WHY THIS IS A SCRIPT AND NOT A LIST OF COMMANDS
# Between the commit that moves the files and the reload of PM2 the fleet is
# live with a stale definition: ~/.pm2/dump.pm2 holds ABSOLUTE paths, so any
# restart in that window starts nothing. The window must be as short as one
# command, and the command must be the same every time.
#
#   ops/cutover-p2b.sh --check   # preconditions only. Changes NOTHING. Safe.
#   ops/cutover-p2b.sh --apply   # does the cutover.
#
# --check is the mode to run before trusting this script; --apply refuses to run
# if --check would have failed, so a half-migrated tree cannot be cut over.
#
# This script never edits dump.pm2 by hand. `pm2 start ecosystem.config.cjs`
# followed by `pm2 save` regenerates it from the config file, which is the only
# way the two stay consistent.
#
# Delete this file once the cutover is done and verified — it is migration
# scaffolding, not an operational tool.
set -uo pipefail

REPO=/home/dwizzy/fudrouter
cd "$REPO" || { echo "FATAL: $REPO missing"; exit 1; }

MODE="${1:-}"
case "$MODE" in
	--check|--apply) ;;
	*) echo "Usage: ops/cutover-p2b.sh --check|--apply"; exit 2 ;;
esac

FAILS=0
ok()  { printf '  ok    %s\n' "$*"; }
bad() { printf '  FAIL  %s\n' "$*"; FAILS=$((FAILS + 1)); }
note(){ printf '  --    %s\n' "$*"; }

# ---------------------------------------------------------------- preconditions
echo "=== 1. files at their post-move paths ==="
# new-path:description — each must exist after the P2b-2 commit.
NEW_PATHS=(
	"apps/console/run.sh:console entrypoint"
	"apps/console/server/index.mjs:console server"
	"apps/router/run.sh:router entrypoint"
	"apps/workers/run.sh:worker fleet entrypoint"
	"apps/scheduler/run.sh:scheduler entrypoint"
	"packages/platform/ts-hooks.mjs:TS loader"
	"ops/migrate.sh:migration runner"
	"ops/backup-db.sh:nightly backup"
	"db/migrations:SQL migrations"
)
for spec in "${NEW_PATHS[@]}"; do
	p="${spec%%:*}"; d="${spec#*:}"
	[ -e "$p" ] && ok "$p ($d)" || bad "$p missing ($d)"
done

echo
echo "=== 2. old paths must be GONE (a half-move is the dangerous state) ==="
for p in apps/react-web services/router scripts/run-workers.sh scripts/run-scheduler.sh \
         scripts/migrate.sh scripts/backup-db.sh infra/migrations scripts/ts-hooks.mjs; do
	[ -e "$p" ] && bad "$p still exists — the move is incomplete" || ok "$p gone"
done

echo
echo "=== 3. ecosystem.config.cjs points at the new paths ==="
ECO=ecosystem.config.cjs
grep -q "apps/console" "$ECO" && ok "console cwd/script updated" || bad "console still on apps/react-web"
grep -q "apps/router"  "$ECO" && ok "router cwd/script updated"  || bad "router still on services/router"
grep -q "apps/workers" "$ECO" && ok "workers script updated"     || bad "workers still on scripts/run-workers.sh"
grep -q "apps/scheduler" "$ECO" && ok "scheduler script updated" || bad "scheduler still on scripts/run-scheduler.sh"

echo
echo "=== 4. external references -- the ones --apply rewrites ==="
# These must still hold the OLD path: the seds in steps 6 and 7 are what change
# them. Testing for the NEW path here would deadlock the script -- --check would
# fail until --apply had run, and --apply refuses while --check fails.
CT="$(crontab -l 2>/dev/null || true)"
if echo "$CT" | grep -q 'fudrouter/scripts/backup-db.sh'; then
	ok "crontab: scripts/backup-db.sh found -> will rewrite to ops/"
elif echo "$CT" | grep -q 'fudrouter/ops/backup-db.sh'; then
	note "crontab: already on ops/backup-db.sh (re-run, no change)"
else
	bad "crontab: no backup-db.sh entry at all -- nightly DB backup is NOT configured"
fi
UNITS=(gonka24-merge tt-merge freeai-merge mingles-merge)
for u in "${UNITS[@]}"; do
	f="$HOME/.config/systemd/user/$u.service"
	if [ ! -f "$f" ]; then note "$u.service absent, skipping"; continue; fi
	if grep -q 'fudrouter/scripts/onboard-' "$f"; then
		ok "$u.service: scripts/onboard-* found -> will rewrite to ops/"
	elif grep -q 'fudrouter/ops/onboard-' "$f"; then
		note "$u.service: already on ops/ (re-run, no change)"
	else
		bad "$u.service: no onboard-* ExecStart -- was the unit ever rewired?"
	fi
done

echo
if [ "$FAILS" -gt 0 ]; then
	echo "PRECONDITIONS FAILED ($FAILS)."
	echo "--check: nothing was changed."
	echo "--apply would refuse. Finish the move/rewiring first."
	[ "$MODE" = "--apply" ] && exit 1
	echo
	echo "(expected while the P2b-2 commit has not landed yet — this is the"
	echo " 'guard works' result, not a failure of the script)"
	exit 1
fi

[ "$MODE" = "--check" ] && { echo "PRECONDITIONS OK — --apply is safe to run."; exit 0; }

# ------------------------------------------------------------------- apply
echo "=== 5. reload PM2 from the config file ==="
# delete+start (not `pm2 reload`): reload re-uses each process's EXISTING
# definition, which is the stale one this cutover exists to replace.
pm2 delete all
pm2 start ecosystem.config.cjs || { echo "FATAL: pm2 start failed."; exit 1; }
pm2 save || { echo "FATAL: pm2 save failed — dump.pm2 still holds old paths."; exit 1; }

echo
echo "=== 6. crontab (keep the old copy, and a timestamped one) ==="
printf '%s\n' "$CT" > /tmp/fudrouter-crontab.bak
cp /tmp/fudrouter-crontab.bak "/tmp/fudrouter-crontab.bak.$(date -u +%Y%m%d-%H%M%S)"
printf '%s\n' "$CT" | sed 's|fudrouter/scripts/backup-db.sh|fudrouter/ops/backup-db.sh|' | crontab -
crontab -l | grep backup-db.sh

echo
echo "=== 7. systemd user units ==="
for u in "${UNITS[@]}"; do
	f="$HOME/.config/systemd/user/$u.service"
	[ -f "$f" ] || continue
	sed -i 's|fudrouter/scripts/onboard-|fudrouter/ops/onboard-|g' "$f"
done
systemctl --user daemon-reload
for u in "${UNITS[@]}"; do
	systemctl --user restart "$u" 2>/dev/null && echo "  restarted $u";
done

echo
echo "=== 8. verify ==="
# The console pins its port from .env.console; if the rename missed, it starts on
# the index.mjs default (3000) instead of 3002 and the public host breaks. Check
# the file exists before trusting the curl below.
[ -f .env.console ] && ok ".env.console present" || bad ".env.console missing -- console would start on the wrong port"
bash ops/verify/pm2-env-hygiene.sh
sleep 3
curl -fsS -o /dev/null -w '  router  /health -> %{http_code}\n' http://127.0.0.1:8100/health || echo "  router /health FAILED"
curl -fsS -o /dev/null -w '  console /       -> %{http_code}\n' http://127.0.0.1:3002/ || echo "  console FAILED"

echo
cat <<'ROLLBACK'
=== ROLLBACK (if any step above failed) ===
  git revert --no-edit <p2b-2 commit>
  pm2 delete all && pm2 start ecosystem.config.cjs && pm2 save
  crontab /tmp/fudrouter-crontab.bak
  sed -i 's|fudrouter/ops/onboard-|fudrouter/scripts/onboard-|g' ~/.config/systemd/user/*-merge.service
  systemctl --user daemon-reload && systemctl --user restart gonka24-merge tt-merge freeai-merge mingles-merge
  bash ops/verify/pm2-env-hygiene.sh
ROLLBACK
