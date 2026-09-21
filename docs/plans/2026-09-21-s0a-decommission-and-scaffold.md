# S0-A — Decommission & Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire the personal `fudrouter-app` service and stand up the `fudrouter` monorepo skeleton — SvelteKit control plane, Go data plane, Postgres/Valkey dev stack, CI — with both services building and the dev stack healthy.

**Architecture:** npm-workspaces monorepo at `/home/dwizzy/fudrouter`. `apps/web` is a SvelteKit app on adapter-node. `services/router` is a Go module. `infra/` holds docker-compose for Postgres 17 + Valkey 8. Decommission runs **first** so the new services own their ports and the box is left clean.

**Tech Stack:** SvelteKit 2 + Svelte 5, TypeScript, Tailwind 4, Drizzle ORM, Better Auth, Go 1.23, Postgres 17, Valkey 8, Docker Compose, GitHub Actions, PM2.

**Spec:** `docs/specs/2026-09-21-s0-foundation-design.md`

## Global Constraints

- Repo root: `/home/dwizzy/fudrouter`
- Toolchain present: Node 22.22.3, npm, bun 1.4.2, Go 1.23.3, Docker, `sudo` with NOPASSWD
- Reserved ports for this product: web `3000`, router `8100`, Postgres `5434`, Valkey `6379`
- **Never bind**: `8011`, `8012`, `443`, `5432`, `5433`, `8080`, `8443`, `9177` (already occupied)
- PM2 process names: `fudrouter-web`, `fudrouter-router`. Never `fudrouter` — that name is deleted in Task 2.
- **Never delete or recreate the Cloudflare tunnel** `39bdfeef-21a4-4152-a7ae-54cde951aa3b`. Only the `ai.karepmuwes.my.id` ingress rule is removed.
- Money is never a float: prices `numeric(12,6)`, amounts `bigint` minor units, every monetary row carries `currency`
- API keys are hash-only: store SHA-256(secret) + plaintext `prefix`, never the key
- Provider credentials: AES-256-GCM at rest
- Migrations are Drizzle Kit SQL files checked into `infra/migrations`; never `drizzle-kit push` against production
- Postgres data volume must be **fresh** — never reuse a volume written by a different PG major version

## Review Focus

Failure modes this plan's tasks must not leave open — each is pinned by a test in the task that owns it:

1. **Teardown ordering.** Stopping the MITM before removing `/etc/hosts` entries leaves 10 domains resolving to `127.0.0.1` with nothing listening — Copilot, Kiro, Cursor and Antigravity hang on connect. (Task 2 → 3)
2. **Tunnel over-deletion.** Removing the whole tunnel instead of one ingress rule strands `zura.dwirijal.my.id` with no route back. (Task 4)
3. **Stale ingress.** Editing `~/.cloudflared/config.yml` without restarting cloudflared leaves the old ingress live, so the removal appears to have worked when it has not. (Task 4)
4. **Lingering port holder.** `pm2 delete` can leave the MITM's `:443`/`:8011`/`:8012` held by an orphaned process, so the new service fails to bind later with a confusing error. (Task 2)
5. **Postgres volume version mismatch.** A reused data volume from a different PG major bricks startup with an unreadable-cluster error. (Task 9)
6. **Scaffold in the wrong directory.** Running `sv add` from the workspace root instead of `apps/web` writes config outside the app and breaks workspace resolution. (Task 7)

---

## Task 1: Back up before touching anything

**Files:**
- Create: `/home/dwizzy/backups/fudrouter-app-<timestamp>.tar.gz`
- Create: `/etc/hosts.pre-decommission`
- Create: `docs/decommission-log.md` (repo)

**Interfaces:**
- Consumes: nothing
- Produces: the recovery path every later task's rollback depends on

- [ ] **Step 1: Create the backup directory and archive**

```bash
mkdir -p /home/dwizzy/backups
cd /home/dwizzy
TS=$(date +%Y%m%d-%H%M%S)
tar czf "/home/dwizzy/backups/fudrouter-app-$TS.tar.gz" \
  fudrouter-app .fudrouter/db
echo "$TS" > /home/dwizzy/backups/.last-decommission-ts
```

- [ ] **Step 2: Verify the archive is intact and actually contains the source**

```bash
TS=$(cat /home/dwizzy/backups/.last-decommission-ts)
tar tzf "/home/dwizzy/backups/fudrouter-app-$TS.tar.gz" | grep -c 'fudrouter-app/internal/'
```
Expected: a count **> 0** (the reusable Go packages are in the archive). A count of `0` means the archive is wrong — stop and re-run Step 1.

- [ ] **Step 3: Back up the hosts file**

```bash
sudo cp /etc/hosts /etc/hosts.pre-decommission
```

- [ ] **Step 4: Verify the hosts backup**

```bash
diff <(sudo cat /etc/hosts) <(sudo cat /etc/hosts.pre-decommission) && echo "HOSTS BACKUP OK"
```
Expected: `HOSTS BACKUP OK` and no diff output.

- [ ] **Step 5: Start the decommission log and commit it**

```bash
cd /home/dwizzy/fudrouter
TS=$(cat /home/dwizzy/backups/.last-decommission-ts)
cat > docs/decommission-log.md <<EOF
# Decommission log — fudrouter-app

Backup timestamp: $TS
Archive: /home/dwizzy/backups/fudrouter-app-$TS.tar.gz
Hosts backup: /etc/hosts.pre-decommission

| Step | Status | Notes |
|---|---|---|
| 1. Backup | done | archive + hosts copy verified |
EOF
git add docs/decommission-log.md
git commit -m "docs(decommission): record pre-teardown backup"
```

---

## Task 2: Stop and delete the PM2 process `fudrouter`

**Files:**
- Modify: `docs/decommission-log.md`

**Interfaces:**
- Consumes: Task 1's archive (rollback path)
- Produces: ports `8011`, `8012`, `443` free for later tasks

- [ ] **Step 1: Confirm what is actually running before stopping it**

```bash
pm2 describe fudrouter | grep -E 'status|script path'
ss -ltnp 2>/dev/null | grep -E ':(8011|8012|443)\b'
```
Expected: `status online`, script path `/home/dwizzy/fudrouter-app/bin/fudrouter`, and three listening ports. If `fudrouter` is not in the PM2 list, skip to Step 4.

- [ ] **Step 2: Stop and delete the process**

```bash
pm2 delete fudrouter
pm2 save
```

- [ ] **Step 3: Verify the ports are actually free, not just the PM2 entry**

```bash
sleep 2
for p in 8011 8012 443; do
  if ss -ltn 2>/dev/null | grep -q ":$p\b"; then
    echo "PORT $p STILL HELD"
  else
    echo "port $p free"
  fi
done
```
Expected: three `port N free` lines.

If any port is still held, find and kill the orphan — **do not proceed with a held port**:

```bash
sudo ss -ltnp | grep -E ':(8011|8012|443)\b'
# then, for the offending PID only:
sudo kill <PID>
```

- [ ] **Step 4: Confirm nothing else regressed**

```bash
pm2 list
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8012/ --max-time 3 || echo "8012 down as intended"
```
Expected: no `fudrouter` in the PM2 list.

- [ ] **Step 5: Log it**

```bash
cd /home/dwizzy/fudrouter
printf '| 2. PM2 stop/delete | done | ports 8011/8012/443 free |\n' >> docs/decommission-log.md
git add docs/decommission-log.md
git commit -m "docs(decommission): record PM2 teardown"
```

---

## Task 3: Remove the 10 MITM entries from `/etc/hosts`

**Files:**
- Modify: `/etc/hosts`
- Modify: `docs/decommission-log.md`

**Interfaces:**
- Consumes: Task 2 (MITM already stopped — this ordering is required, see Review Focus 1)
- Produces: a clean hosts file; IDE tooling no longer routed to a dead port

- [ ] **Step 1: Confirm the MITM is already down (ordering guard)**

```bash
ss -ltn 2>/dev/null | grep -q ':443\b' && echo "MITM STILL UP — do not clean hosts yet" || echo "safe to clean hosts"
```
Expected: `safe to clean hosts`. If the MITM is still up, return to Task 2.

- [ ] **Step 2: Count the entries that will be removed**

```bash
grep -cE 'daily-cloudcode-pa\.googleapis\.com|cloudcode-pa\.googleapis\.com|api\.individual\.githubcopilot\.com|runtime\.us-east-1\.kiro\.dev|q\.us-east-1\.amazonaws\.com|codewhisperer\.us-east-1\.amazonaws\.com|api2\.cursor\.sh|api3\.cursor\.sh|agent\.api5\.cursor\.sh|agentn\.api5\.cursor\.sh' /etc/hosts
```
Expected: `10`.

- [ ] **Step 3: Remove exactly those lines**

```bash
sudo sed -i -E '/^[[:space:]]*127\.0\.0\.1[[:space:]]+(daily-cloudcode-pa\.googleapis\.com|cloudcode-pa\.googleapis\.com|api\.individual\.githubcopilot\.com|runtime\.us-east-1\.kiro\.dev|q\.us-east-1\.amazonaws\.com|codewhisperer\.us-east-1\.amazonaws\.com|api2\.cursor\.sh|api3\.cursor\.sh|agent\.api5\.cursor\.sh|agentn\.api5\.cursor\.sh)[[:space:]]*$/d' /etc/hosts
```

- [ ] **Step 4: Verify they are gone and nothing else was touched**

```bash
echo "remaining MITM entries: $(grep -cE 'cloudcode-pa|githubcopilot|kiro\.dev|cursor\.sh|amazonaws\.com' /etc/hosts)"
# Everything except the 10 MITM lines must be byte-identical to the backup.
diff <(sudo grep -vE 'cloudcode-pa|githubcopilot|kiro\.dev|cursor\.sh|amazonaws\.com' /etc/hosts.pre-decommission) \
     <(sudo grep -vE 'cloudcode-pa|githubcopilot|kiro\.dev|cursor\.sh|amazonaws\.com' /etc/hosts) \
  && echo "NO COLLATERAL CHANGES"
```
Expected: `remaining MITM entries: 0` and `NO COLLATERAL CHANGES`.

Note: the `amazonaws\.com` term is what catches `q.us-east-1.amazonaws.com` and
`codewhisperer.us-east-1.amazonaws.com`. Without it this check reports `0 remaining`
while two hijacks stay live — a false green.

- [ ] **Step 5: Verify DNS now resolves publicly again**

```bash
getent hosts api2.cursor.sh | head -1 || echo "no A record (blocked upstream?)"
```
Expected: the resolved address is **not** `127.0.0.1`. A missing record is acceptable (upstream/ISP block). A `127.0.0.1` result means the hijack is still active — return to Step 3.

- [ ] **Step 6: Log it**

```bash
cd /home/dwizzy/fudrouter
printf '| 3. /etc/hosts cleaned | done | 10 MITM entries removed, 0 remaining |\n' >> docs/decommission-log.md
git add docs/decommission-log.md
git commit -m "docs(decommission): record hosts cleanup"
```

---

## Task 4: Remove the `ai.karepmuwes.my.id` ingress rule, keep the tunnel

**Files:**
- Modify: `/home/dwizzy/.cloudflared/config.yml`
- Modify: `docs/decommission-log.md`

**Interfaces:**
- Consumes: Task 2 (the service behind the rule is already gone)
- Produces: a tunnel serving only `zura.dwirijal.my.id`

**DANGER:** the tunnel is shared. `zura.dwirijal.my.id` → `:8084` is a second hostname on the same tunnel. Only the `ai.karepmuwes.my.id` block is removed. (Review Focus 2)

- [ ] **Step 1: Back up the tunnel config**

```bash
cp /home/dwizzy/.cloudflared/config.yml /home/dwizzy/.cloudflared/config.yml.pre-decommission
```

- [ ] **Step 2: Verify the config holds both hostnames before editing**

```bash
grep -n 'hostname:' /home/dwizzy/.cloudflared/config.yml
```
Expected: two lines — `ai.karepmuwes.my.id` and `zura.dwirijal.my.id`.

- [ ] **Step 3: Remove only the `ai.karepmuwes.my.id` ingress block**

```bash
python3 - <<'EOF'
import re, pathlib
p = pathlib.Path('/home/dwizzy/.cloudflared/config.yml')
text = p.read_text()
# Drop the ai.karepmuwes block: the two lines under "ingress:" that belong to it.
new = re.sub(
    r'\n[ \t]*- hostname: ai\.karepmuwes\.my\.id\n[ \t]*service: http://localhost:8012\n',
    '\n', text)
assert new != text, "ai.karepmuwes ingress block not found — inspect config manually"
assert 'zura.dwirijal.my.id' in new, "Zura hostname missing after edit — aborting"
p.write_text(new)
print(new)
EOF
```

- [ ] **Step 4: Verify the tunnel still serves Zura and no longer serves fudrouter**

```bash
grep -c 'ai.karepmuwes' /home/dwizzy/.cloudflared/config.yml || true
grep -c 'zura.dwirijal.my.id' /home/dwizzy/.cloudflared/config.yml
grep -c 'tunnel:' /home/dwizzy/.cloudflared/config.yml
```
Expected: `0`, `1`, `1` — fudrouter gone, Zura present, tunnel id untouched.

- [ ] **Step 5: Validate the config and restart cloudflared**

```bash
sudo cloudflared --config /home/dwizzy/.cloudflared/config.yml tunnel ingress validate
sudo systemctl restart cloudflared
sleep 5
systemctl is-active cloudflared
```
Expected: `OK` from validate, then `active`.

- [ ] **Step 6: Verify the tunnel came back and the tunnel ID is unchanged**

```bash
grep 'tunnel:' /home/dwizzy/.cloudflared/config.yml
systemctl is-active cloudflared
```
Expected: tunnel id still `39bdfeef-21a4-4152-a7ae-54cde951aa3b`, service `active`. If cloudflared failed to start, restore `config.yml.pre-decommission`, restart, and stop.

- [ ] **Step 7: Log it**

```bash
cd /home/dwizzy/fudrouter
printf '| 4. Tunnel ingress | done | ai.karepmuwes removed; tunnel + zura intact |\n' >> docs/decommission-log.md
git add docs/decommission-log.md
git commit -m "docs(decommission): record tunnel ingress removal"
```

---

## Task 5: Retired-service remnant sweep

**Files:**
- Modify: `docs/decommission-log.md`

**Interfaces:**
- Consumes: Task 2
- Produces: no stray capability on a binary that no longer runs; no stale credential copies left behind by the retired service

Two remnants, both from the retired service: the low-port capability on its binary, and
PM2's own backup of the pre-delete dump — which still carries the retired process's
inherited environment, including live API keys.

- [ ] **Step 1: Show the current capability**

```bash
getcap /home/dwizzy/fudrouter-app/bin/fudrouter
```
Expected: `... cap_net_bind_service=ep`.

- [ ] **Step 2: Remove it**

```bash
sudo setcap -r /home/dwizzy/fudrouter-app/bin/fudrouter
```

- [ ] **Step 3: Verify it is gone**

```bash
getcap /home/dwizzy/fudrouter-app/bin/fudrouter || echo "NO CAPABILITY — clean"
```
Expected: `NO CAPABILITY — clean`.

- [ ] **Step 4: Shred PM2's stale dump backup**

```bash
ls -la /home/dwizzy/.pm2/dump.pm2.bak && shred -u -v /home/dwizzy/.pm2/dump.pm2.bak
ls -la /home/dwizzy/.pm2/dump.pm2.bak 2>/dev/null || echo "GONE — clean"
cat /home/dwizzy/.pm2/dump.pm2   # must still be []
```
`dump.pm2.bak` is PM2's own backup of the pre-delete dump. It is not read by any PM2 code
path (the authoritative dump is `dump.pm2`), so it is a pure stale copy — but it holds the
retired `fudrouter` entry's full inherited env, including API keys, at mode 664.

**This does not close the exposure.** `shred` is best-effort on ext4-over-LVM: journal
replay or an LVM/root snapshot can retain the blocks. **Any credential that appeared in that
file must be rotated**, not merely deleted. Record the affected key names in the log and
surface them for rotation — the log must not imply that shredding made them safe.

- [ ] **Step 5: Log it**

```bash
cd /home/dwizzy/fudrouter
printf '| 5. setcap removed | done | binary no longer carries cap_net_bind_service |\n' >> docs/decommission-log.md
printf '| 5b. Stale credentials | done | dump.pm2.bak shredded (keys REQUIRE ROTATION) |\n' >> docs/decommission-log.md
git add docs/decommission-log.md
git commit -m "docs(decommission): record capability removal and remnant sweep"
```

---

## Task 6: Monorepo root

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `README.md`

**Interfaces:**
- Consumes: nothing
- Produces: npm workspace root; `apps/*` and `packages/*` workspace globs that Task 7 relies on. `services/*` is deliberately NOT a workspace (see the note below) — the Go module is not a Node package.

- [ ] **Step 1: Write the workspace root manifest**

`package.json`:

```json
{
  "name": "fudrouter",
  "private": true,
  "version": "0.1.0",
  "workspaces": [
    "apps/*",
    "packages/*"
  ],
  "scripts": {
    "build": "npm run build --workspaces --if-present",
    "check": "npm run check --workspaces --if-present",
    "test": "npm run test --workspaces --if-present"
  },
  "engines": {
    "node": ">=22.5"
  }
}
```

Note: `services/*` is deliberately **not** an npm workspace — the Go module is not a Node package.

- [ ] **Step 2: Write `.gitignore`**

```gitignore
node_modules/
.svelte-kit/
build/
dist/
.env
.env.*
!.env.example
*.log
.DS_Store
infra/data/
*.tar.gz
```

- [ ] **Step 3: Write `README.md`**

```markdown
# fudrouter

Commercial AI router — one API key, many model providers.

- `apps/web` — SvelteKit control plane (UI, auth, billing, admin)
- `services/router` — Go data plane (`/v1/chat/completions` hot path)
- `packages/contracts` — shared types for the web ↔ router contract
- `infra/` — docker-compose (Postgres 17 + Valkey) and migrations
- `docs/specs` — design specs

Dev stack: `docker compose -f infra/docker-compose.yml up -d`
```

- [ ] **Step 4: Verify the workspace root is valid**

```bash
cd /home/dwizzy/fudrouter
node -e "const p=require('./package.json'); if(!p.private) throw new Error('must be private'); console.log('workspaces:', p.workspaces.join(','))"
```
Expected: `workspaces: apps/*,packages/*`.

- [ ] **Step 5: Commit**

```bash
cd /home/dwizzy/fudrouter
git add package.json .gitignore README.md
git commit -m "chore: monorepo workspace root"
```

---

## Task 7: SvelteKit app with add-ons

**Files:**
- Create: `apps/web/**` (scaffolded)
- Create: `apps/web/.env.example`
- Modify: `apps/web/package.json` (name)
- Modify: `docs/decommission-log.md`

**Interfaces:**
- Consumes: Task 6's workspace globs
- Produces: a buildable SvelteKit app on adapter-node; `apps/web/src/lib/auth.ts` and the Drizzle client that S0-B extends

**Note:** run every `sv` command with cwd inside `apps/web`. Running from the repo root writes config outside the app and breaks workspace resolution (Review Focus 6).

- [ ] **Step 1: Scaffold the app**

```bash
cd /home/dwizzy/fudrouter
npx --yes sv@latest create apps/web \
  --template minimal \
  --types ts \
  --no-add-ons \
  --no-dir-check \
  --install npm
```
Expected: `apps/web` exists with `package.json`, `svelte.config.js`, `src/routes/+page.svelte`.

- [ ] **Step 2: Verify the scaffold landed in the right place**

```bash
test -f /home/dwizzy/fudrouter/apps/web/package.json && echo "APP OK"
test ! -f /home/dwizzy/fudrouter/svelte.config.js && echo "NO LEAK TO ROOT"
```
Expected: `APP OK` then `NO LEAK TO ROOT`.

> **Note on Step 2's expected output.** The `sv create` CLI (v0.17.1, SvelteKit
> 2.63) no longer generates `apps/web/svelte.config.js`; adapter config lives
> inline in `apps/web/vite.config.ts` via `sveltekit({ adapter: adapter(), ... })`.
> The expected output still holds because `svelte.config.js` does not exist at
> workspace root. The `test ! -f ...` check is the correct validation for the
> current CLI version.

- [ ] **Step 3: Add the add-ons**

```bash
cd /home/dwizzy/fudrouter/apps/web
npx --yes sv@latest add \
  'drizzle=database:postgresql+client:postgres.js' \
  better-auth \
  tailwindcss \
  'sveltekit-adapter=adapter:node' \
  vitest \
  eslint \
  prettier
```
If the CLI prompts interactively, accept the documented defaults shown by `npx sv add --help`; do not choose `docker:yes` for drizzle — the compose file lives in `infra/` (Task 9).

- [ ] **Step 4: Verify the add-ons are actually present**

```bash
cd /home/dwizzy/fudrouter/apps/web
node -e "
const p=require('./package.json');
const need=['better-auth','drizzle-orm','drizzle-kit','@sveltejs/adapter-node','tailwindcss','vitest'];
const have=Object.keys({...p.dependencies,...p.devDependencies});
const missing=need.filter(n=>!have.includes(n));
if(missing.length) throw new Error('missing: '+missing.join(', '));
console.log('ALL ADD-ONS PRESENT');
"
```
Expected: `ALL ADD-ONS PRESENT`.

- [ ] **Step 5: Write `.env.example`**

`apps/web/.env.example`:

```dotenv
# Postgres (dev stack from infra/docker-compose.yml)
DATABASE_URL=postgres://fudrouter:fudrouter@127.0.0.1:5434/fudrouter

# Better Auth
BETTER_AUTH_SECRET=replace-me-with-openssl-rand-base64-32
BETTER_AUTH_URL=http://localhost:3000

# SvelteKit origin (read by src/lib/server/auth.ts via env.ORIGIN)
ORIGIN=http://localhost:3000

# Go data plane
ROUTER_BASE_URL=http://127.0.0.1:8100
```

- [ ] **Step 6: Verify the app typechecks and builds**

```bash
cd /home/dwizzy/fudrouter/apps/web
npm run check
npm run build
```
Expected: both exit `0`; `build/` contains `index.js` (adapter-node output).

- [ ] **Step 7: Log and commit**

```bash
cd /home/dwizzy/fudrouter
printf '| 7. SvelteKit scaffold | done | apps/web builds on adapter-node |\n' >> docs/decommission-log.md
# The root lockfile must be committed too — CI runs `npm ci` at the workspace root.
git add apps/web package-lock.json docs/decommission-log.md
git commit -m "feat(web): scaffold SvelteKit app with drizzle, better-auth, tailwind, node adapter"
```

---

## Task 8: Go data plane module

**Files:**
- Create: `services/router/go.mod`
- Create: `services/router/main.go`
- Create: `services/router/health_test.go`

**Interfaces:**
- Consumes: nothing
- Produces: module `github.com/anvxxr-arch/fudrouter/services/router`, and `newHealthHandler() http.Handler` that S0-B's router service builds on

- [ ] **Step 1: Write the failing test**

`services/router/health_test.go`:

```go
package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHealthReportsServiceIdentity(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/health", nil)

	newHealthHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}

	var body struct {
		OK      bool   `json:"ok"`
		Service string `json:"service"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if !body.OK {
		t.Error("ok = false, want true")
	}
	if body.Service != "fudrouter-router" {
		t.Errorf("service = %q, want %q", body.Service, "fudrouter-router")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /home/dwizzy/fudrouter/services/router
go mod init github.com/anvxxr-arch/fudrouter/services/router
go test ./... 2>&1 | head -5
```
Expected: FAIL — `undefined: newHealthHandler`.

- [ ] **Step 3: Write the minimal implementation**

`services/router/main.go`:

```go
package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
)

const serviceName = "fudrouter-router"

// newHealthHandler reports service identity. The data plane must be
// independently identifiable so the control plane can tell it apart from
// the web app in health checks and logs.
func newHealthHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":      true,
			"service": serviceName,
		})
	})
}

func main() {
	addr := os.Getenv("ROUTER_ADDR")
	if addr == "" {
		addr = "0.0.0.0:8100"
	}

	mux := http.NewServeMux()
	mux.Handle("GET /health", newHealthHandler())

	log.Printf("[%s] listening on %s", serviceName, addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("[%s] server failed: %v", serviceName, err)
	}
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /home/dwizzy/fudrouter/services/router
go vet ./...
go test ./... -v
```
Expected: PASS — `TestHealthReportsServiceIdentity`, vet silent.

- [ ] **Step 5: Verify the binary builds and serves**

```bash
cd /home/dwizzy/fudrouter/services/router
go build -o /tmp/router-check .
/tmp/router-check & PID=$!
sleep 1
curl -s http://127.0.0.1:8100/health
kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null
```
Expected: `{"ok":true,"service":"fudrouter-router"}`.

- [ ] **Step 6: Commit**

```bash
cd /home/dwizzy/fudrouter
git add services/router
git commit -m "feat(router): scaffold Go data plane with health endpoint"
```

---

## Task 9: Dev stack — Postgres 17 + Valkey

**Files:**
- Create: `infra/docker-compose.yml`
- Create: `infra/.env.example`
- Create: `infra/migrations/.gitkeep`

**Interfaces:**
- Consumes: nothing
- Produces: `postgres://fudrouter:fudrouter@127.0.0.1:5434/fudrouter` and `redis://127.0.0.1:6379`, the connection targets in `apps/web/.env.example`

**Note:** the volume is created fresh. Never point this at a volume written by a different PG major (Review Focus 5).

- [ ] **Step 1: Write the compose file**

`infra/docker-compose.yml`:

```yaml
name: fudrouter

services:
  db:
    image: postgres:17
    container_name: fudrouter-db
    restart: unless-stopped
    environment:
      POSTGRES_USER: fudrouter
      POSTGRES_PASSWORD: fudrouter
      POSTGRES_DB: fudrouter
    ports:
      - "127.0.0.1:5434:5432"
    volumes:
      - fudrouter-pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U fudrouter -d fudrouter"]
      interval: 5s
      timeout: 3s
      retries: 10

  cache:
    image: valkey/valkey:8
    container_name: fudrouter-cache
    restart: unless-stopped
    ports:
      - "127.0.0.1:6379:6379"
    healthcheck:
      test: ["CMD", "valkey-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 10

volumes:
  fudrouter-pgdata:
```

Binding to `127.0.0.1` only — the dev database is never exposed off-host.

- [ ] **Step 2: Write `infra/.env.example`**

```dotenv
POSTGRES_USER=fudrouter
POSTGRES_PASSWORD=fudrouter
POSTGRES_DB=fudrouter
```

- [ ] **Step 3: Create the migrations directory**

```bash
mkdir -p /home/dwizzy/fudrouter/infra/migrations
touch /home/dwizzy/fudrouter/infra/migrations/.gitkeep
```

- [ ] **Step 4: Start the stack**

```bash
cd /home/dwizzy/fudrouter
docker compose -f infra/docker-compose.yml up -d
```

- [ ] **Step 5: Verify both services are healthy — not merely started**

```bash
cd /home/dwizzy/fudrouter
for i in $(seq 1 30); do
  h=$(docker inspect --format '{{.State.Health.Status}}' fudrouter-db 2>/dev/null)
  [ "$h" = "healthy" ] && break
  sleep 2
done
echo "db: $(docker inspect --format '{{.State.Health.Status}}' fudrouter-db)"
echo "cache: $(docker inspect --format '{{.State.Health.Status}}' fudrouter-cache)"
```
Expected: `db: healthy` and `cache: healthy`.

- [ ] **Step 6: Verify the version and that the port is the intended one**

```bash
docker exec fudrouter-db psql -U fudrouter -d fudrouter -tAc 'show server_version;'
ss -ltn 2>/dev/null | grep -E ':(5434|6379)\b'
```
Expected: `17.x`, and both ports listening.

- [ ] **Step 7: Verify the app can actually reach it**

```bash
docker exec fudrouter-db psql -U fudrouter -d fudrouter -c 'select 1;' >/dev/null && echo "PG REACHABLE"
docker exec fudrouter-cache valkey-cli ping
```
Expected: `PG REACHABLE` and `PONG`.

- [ ] **Step 8: Commit**

```bash
cd /home/dwizzy/fudrouter
git add infra
git commit -m "feat(infra): postgres 17 + valkey dev stack on 5434/6379"
```

---

## Task 10: CI

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: Tasks 6–9 (workspace scripts, Go module, compose file)
- Produces: the gate that keeps S0-B's work honest

- [ ] **Step 1: Write the workflow**

`.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  web:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: npm
      - run: npm ci
      - run: npm run check --workspace apps/web
      - run: npm run test --workspace apps/web

  router:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: "1.23"
          cache-dependency-path: services/router/go.sum
      - run: go vet ./...
        working-directory: services/router
      - run: go test ./... -race
        working-directory: services/router
```

- [ ] **Step 2: Verify the workflow is valid YAML**

```bash
cd /home/dwizzy/fudrouter
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml')); print('YAML OK')"
```
Expected: `YAML OK`.

- [ ] **Step 3: Verify the same commands pass locally (CI must not be the first place they run)**

```bash
cd /home/dwizzy/fudrouter
npm run check --workspace apps/web
(cd services/router && go vet ./... && go test ./... -race)
```
Expected: all exit `0`.

- [ ] **Step 4: Commit**

```bash
cd /home/dwizzy/fudrouter
git add .github
git commit -m "ci: typecheck web, vet and test router"
```

---

## Task 11: Verify S0-A end to end

**Files:**
- Modify: `docs/decommission-log.md`

**Interfaces:**
- Consumes: every prior task
- Produces: the acceptance evidence S0-A is complete

- [ ] **Step 1: Confirm the old service is fully retired**

```bash
pm2 jlist 2>/dev/null | python3 -c "import sys,json;print('old PM2 fudrouter present:', sum(1 for a in json.load(sys.stdin) if a.get('name')=='fudrouter'))" 2>/dev/null || echo "old PM2 fudrouter present: 0"
echo "hosts MITM entries: $(grep -cE 'cloudcode-pa|githubcopilot|kiro\.dev|cursor\.sh|amazonaws\.com' /etc/hosts || true)"
echo "8011/8012/443: $(ss -ltn 2>/dev/null | grep -cE ':(8011|8012|443)\b')"
getcap /home/dwizzy/fudrouter-app/bin/fudrouter 2>/dev/null || echo "no capability"
```
Expected: `old PM2 fudrouter present: 0`, `hosts MITM entries: 0`, `0` listening on the old ports, `no capability`.

Two deliberate refinements over a naive check:
- The PM2 check matches the **exact** name `fudrouter`, not a substring. `grep -c fudrouter`
  would also match `fudrouter-web` and `fudrouter-router` — the new product's processes —
  and report a false failure once they exist.
- The hosts pattern includes `amazonaws\.com`, without which the two AWS hijacks
  (`q.us-east-1.amazonaws.com`, `codewhisperer.us-east-1.amazonaws.com`) are invisible to
  this gate — the same blind spot Task 3 corrected.

- [ ] **Step 2: Confirm the tunnel is alive and still serves Zura**

```bash
systemctl is-active cloudflared
grep -c 'zura.dwirijal.my.id' /home/dwizzy/.cloudflared/config.yml
grep -c 'ai.karepmuwes' /home/dwizzy/.cloudflared/config.yml || true
```
Expected: `active`, `1`, `0`.

- [ ] **Step 3: Confirm the dev stack is healthy**

```bash
docker compose -f /home/dwizzy/fudrouter/infra/docker-compose.yml ps
```
Expected: both `healthy`.

- [ ] **Step 4: Confirm both services build and test**

```bash
cd /home/dwizzy/fudrouter
npm run check --workspace apps/web && npm run build --workspace apps/web
(cd services/router && go vet ./... && go test ./...)
```
Expected: all exit `0`.

- [ ] **Step 5: Confirm the backup is present and restorable**

```bash
TS=$(cat /home/dwizzy/backups/.last-decommission-ts)
ls -lh "/home/dwizzy/backups/fudrouter-app-$TS.tar.gz"
tar tzf "/home/dwizzy/backups/fudrouter-app-$TS.tar.gz" >/dev/null && echo "ARCHIVE INTACT"
sudo test -f /etc/hosts.pre-decommission && echo "HOSTS BACKUP PRESENT"
```
Expected: the archive listed, `ARCHIVE INTACT`, `HOSTS BACKUP PRESENT`.

- [ ] **Step 6: Final log commit**

```bash
cd /home/dwizzy/fudrouter
cat >> docs/decommission-log.md <<'EOF'

## S0-A verification

All acceptance checks passed: old service retired (PM2, hosts, ports,
capability), tunnel intact with Zura ingress, dev stack healthy,
web + router build and test green, backups verified restorable.
EOF
git add docs/decommission-log.md
git commit -m "docs(decommission): record S0-A verification"
```

---

## What this plan does NOT cover

Deferred to **S0-B** (separate plan): Drizzle schema (9 tables), Better Auth
wiring and the 4-role RBAC, API-key issue/hash/revoke, the minimal provider and
model seed, the router data plane, and the walking skeleton end-to-end path.

Deferred to **S0-C / later**: lifting the ~2,343 LOC Go core into
`services/router/`, and the Phase C deletion of `fudrouter-app` (spec §4.3) —
which by design cannot happen until that lift is verified.
