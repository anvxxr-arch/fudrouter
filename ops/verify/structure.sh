#!/usr/bin/env bash
# ops/verify/structure.sh — the layout gate.
#
# The top level of this repo IS the layout decision (docs/decisions/0001). A new
# top-level entry is a layout change, and layout changes belong in an ADR, not in
# a commit that quietly adds `utils/` at the root. This gate makes that failure
# loud instead of a thing you notice six months later.
#
# Why `git ls-files` and not `ls`: the working tree legitimately holds untracked
# scratch and build directories, so `ls` would need an exception list that grows
# forever. The gate asserts what the REPO says, which is what CI and every other
# machine sees.
#
# It checks in both directions on purpose. A gate that only rejects unknown names
# silently stops checking anything the moment someone adds a name to the
# allowlist, so an allowlisted entry that no longer exists is also a failure.
#
# Usage: ops/verify/structure.sh
set -uo pipefail

# Depth matters: this file sits at ops/verify/, two levels under the repo root.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || { echo "FAIL: cannot cd to $ROOT"; exit 1; }

ALLOWED_DIRS=( .github .omp apps backend docs infra ops packages )
ALLOWED_FILES=( .env.console.example .gitignore DESIGN.md README.md
                ecosystem.config.cjs package-lock.json package.json )
# apps/* are runnable units, so each must carry its PM2 entrypoint. The Go data
# plane moved to backend/go (Target A, ADR-0006) and is checked separately.
APPS=( web workers scheduler )
# backend/go is the Go module; its command lives in cmd/<name>.
GO_CMDS=( gateway )

fails=0
say() { printf '%s\n' "$*"; }
ok()  { printf '  ok    %s\n' "$*"; }
bad() { printf 'FAIL: %s\n' "$*"; fails=$((fails + 1)); }
note(){ printf '  --    %s\n' "$*"; }
contains() { local x="$1"; shift; local e; for e in "$@"; do [ "$e" = "$x" ] && return 0; done; return 1; }

mapfile -t TOPS < <(git ls-files | awk -F/ 'NF==1 {print $1}' | sort -u)
mapfile -t DIRS < <(git ls-files | awk -F/ 'NF>1  {print $1}' | sort -u)

say "=== top-level directories ==="
for d in "${DIRS[@]}"; do
	if contains "$d" "${ALLOWED_DIRS[@]}"; then ok "$d/"; else
		bad "unexpected top-level directory: $d/ — a layout change needs an ADR in docs/decisions/"
	fi
done

say
say "=== top-level files ==="
for f in "${TOPS[@]}"; do
	if contains "$f" "${ALLOWED_FILES[@]}"; then ok "$f"; else
		bad "unexpected top-level file: $f — a layout change needs an ADR in docs/decisions/"
	fi
done

say
say "=== allowlist is not stale ==="
for d in "${ALLOWED_DIRS[@]}"; do
	contains "$d" "${DIRS[@]}" || bad "allowlisted directory $d/ does not exist — remove it from this script"
done
for f in "${ALLOWED_FILES[@]}"; do
	contains "$f" "${TOPS[@]}" || bad "allowlisted file $f does not exist — remove it from this script"
done
[ "$fails" -eq 0 ] && note "every allowlisted entry exists"

say
say "=== apps/ are runnable units ==="
for a in "${APPS[@]}"; do
	if [ ! -d "apps/$a" ]; then
		bad "apps/$a is missing — the role-first layout names these four"
	elif [ ! -f "apps/$a/run.sh" ]; then
		bad "apps/$a/run.sh is missing — every app is a PM2-launchable unit"
	else
		ok "apps/$a/run.sh"
	fi
done
while IFS= read -r d; do
	[ -n "$d" ] || continue
	contains "$d" "${APPS[@]}" || bad "unexpected app: apps/$d — add it to APPS here and to the ADR"
done < <(git ls-files | awk -F/ 'NF>2 && $1=="apps" {print $2}' | sort -u)

say
say "=== backend/go is the Go module ==="
if [ ! -f "backend/go/go.mod" ]; then
	bad "backend/go/go.mod is missing — the data plane lives at backend/go (Target A, ADR-0006)"
else
	ok "backend/go/go.mod"
fi
for c in "${GO_CMDS[@]}"; do
	if [ -f "backend/go/cmd/$c/main.go" ]; then ok "backend/go/cmd/$c/main.go"; else
		bad "backend/go/cmd/$c/main.go is missing — every command is a real main package"
	fi
done
while IFS= read -r c; do
	[ -n "$c" ] || continue
	contains "$c" "${GO_CMDS[@]}" || bad "unexpected Go command: backend/go/cmd/$c — add it to GO_CMDS here and to the ADR"
done < <(git ls-files | awk -F/ 'NF>4 && $1=="backend" && $2=="go" && $3=="cmd" {print $4}' | sort -u)

say
say "=== packages/ are real packages ==="
while IFS= read -r d; do
	[ -n "$d" ] || continue
	if [ -f "packages/$d/package.json" ]; then ok "packages/$d/package.json"; else
		bad "packages/$d has no package.json — a directory under packages/ is a published boundary"
	fi
done < <(git ls-files | awk -F/ 'NF>2 && $1=="packages" {print $2}' | sort -u)

say
if [ "$fails" -eq 0 ]; then
	say "structure: PASS"
	exit 0
fi
printf 'structure: %d FAILURE(S)\n' "$fails"
exit 1
