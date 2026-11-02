# A3 validation record

Branch: `feat/egr`; base commit: `8bc06381e1d7abab0c17cc62f5b4f407d9d36133`.
Database target: `127.0.0.1:55432/fr_egr` only (credentials not recorded).

Headline: **100 authenticated, DB-backed bearer-credential requests on fresh
TCP sockets used one distinct source IPv6 address.** The final scoped race run
also passed the anonymous 100-fresh-socket case and 429/402/403 burn rotations.
A separate credentialed integration case's explicit `sourceip.Burn` changed the
next source, rather than relying on keep-alive to look sticky.

Migration readback returned `0026_connection_egress` and
`ipv6_rotate | 3600 | NULL | 26`: all 26 existing connections retained the default.

## Verification boundaries

- Real local TCP: SQL/candidate policy propagation, authenticated and anonymous
  IPv6 source binding, fresh sockets, keep-alive attribution, direct stability,
  burn/TTL rotation, and inert pool. No imported provider token was used externally.
- Public routed IPv6: `https://api64.ipify.org` returned the same sticky /128 twice,
  a different /128 after burn, and the same direct /128 twice. This was an echo
  probe, not live provider inference.
- Local authenticated HTTP CONNECT and SOCKS5 fixtures: session affinity/rotation,
  TLS/provider headers, approved endpoint matching, SSRF/redirect refusal, and
  cancellation. These are automated socket tests, not operator-pool validation.
- CFP: configured dial and rejection hooks are unit-tested; a live Cloudflare
  WebSocket inference session was not exercised.
- Operator pool: TCP `127.0.0.1:3128` was reachable, but the consumer-key environment
  variable was absent. Authenticated operator-pool egress is **UNVERIFIED
  end-to-end**. No credentials were guessed or hardcoded.
- Own-IP and remote-session affinity are process-local; no cross-router/restart
  persistence or Valkey-backed affinity was implemented or claimed.

## Exact Go test commands and results

All listed Go commands ran from `/home/dwizzy/fr-egr/backend/go` through:

```sh
python3 "$TMPDIR/a3-run.py" <command below>
```

The runner checked the isolated database URL, set `GOTOOLCHAIN=auto`, and removed
production master keys, Valkey configuration, production-test opt-in, and pool
configuration from child environments. Public echo runs additionally set
`EGRESS_LIVE_ECHO_URL=https://api64.ipify.org`.

Result histories below are chronological exit codes: `0` means pass; `1` means
failure. They include development failures instead of overwriting them with a
later green result.

```sh
go test ./internal/sourceip ./internal/egress -count=1 -v
```
Exit codes: 1, 0.

```sh
go test ./internal/sourceip ./internal/egress ./internal/cfp ./internal/store ./internal/proxy -run 'Test(Affinity|StickyTTL|Egress|PoolStickySession|PoolTunnels|PoolSSRF|PoolCONNECT|ConnectionEgress|CFPUsesConfigured|CFPRejectReports|RotatingClient|IPTracker)' -count=1 -v
```
Exit codes: 1, 0.

```sh
go test ./internal/egress -run '^TestEgressLiveIPv6Affinity$' -count=1 -v
```
Exit codes: 0, 0.

```sh
go test ./internal/sourceip ./internal/egress ./internal/cfp -race -count=1
```
Exit codes: 0, 0.

```sh
go test ./internal/proxy -run '^TestEgressPolicy' -count=1 -v
```
Exit codes: 0.

```sh
go test ./internal/egress ./internal/proxy -run '^Test(EgressBurnRotatesNextRequest|IPTrackerAttributesKeepAliveReuse)$' -count=1 -v
```
Exit codes: 1, 0.

```sh
go test ./... -count=1
```
Exit codes: 1.

```sh
go test ./internal/store ./internal/proxy -run '^Test(ConnectionEgress|EgressPolicy|RotatingClient|IPTracker)' -race -count=1 -v
```
Exit codes: 0, 0.

```sh
go test ./... -count=1 -skip '^Test(VirtualRequestRewritesUpstreamModel|VirtualFanOutIsConstant|VirtualFanOutStillCoversEveryModel)$'
```
Exit codes: 1, 1.

```sh
go test ./internal/proxy -run '^TestLoadLedgerSurvivesPoolOversubscription$' -count=1 -v
```
Exit codes: 1, 0, 0.

### Failure interpretation

- The initial deterministic socket fixture failed because it had not opted into
  local/private test upstreams. Its final full-package and race runs pass without
  weakening the production guard.
- The initial broad A3 run hit the existing 75-rpm caller-account gate on request
  76. The final fixture alternates two callers resolving ONE provider credential;
  both the anonymous and authenticated 100-fresh-socket probes pass.
- The burn/keep-alive command was deliberately made red by removing affinity's
  burned-address usability check and suppressing tracking for reused sockets.
  Those mutations were restored, and the identical command passed.
- Unfiltered `go test ./... -count=1` fails
  `TestVirtualRequestRewritesUpstreamModel`, `TestVirtualFanOutIsConstant`, and
  `TestVirtualFanOutStillCoversEveryModel` against the imported catalogue.
- Filtering those three did NOT produce a passing full suite. One filtered run's
  existing `TestLoadLedgerSurvivesPoolOversubscription` rejected 179/2,000 requests
  with 429. An isolated run rejected 140/2,000. Two isolated reruns subsequently
  passed all 2,000 requests and ledger assertions; the first of those included a
  temporary rejection diagnostic, which was removed before the second rerun.
  The final filtered run served all 2,000 but recorded only 1,938 request logs and
  usage charges before its 60-second drain deadline. No causal attribution to
  egress or to another workstream was established. The load test was not changed
  in the commit. **Neither unfiltered nor filtered full-suite success is claimed.**
- The opt-in public echo test skips in ordinary runs. Its explicit opt-in runs
  actually passed; those skips are not substituted for live verification.

## Other exact checks

```sh
go vet ./...
go build ./...
```
Both passed through the same isolated runner (exit 0).

```sh
NODE_ENV=development npm ci
NODE_ENV=development npm run check
NODE_ENV=development npm run check --workspaces
NODE_ENV=development npm run build --workspace apps/web
```

`npm ci` passed (144 packages installed; audit reported 2 moderate and 2 high
vulnerabilities; no audit fix was attempted). The first root check failed before
local dependencies were installed. After install, all workspace typechecks and
contract-staleness checks passed, but the root check still failed its existing
structure allowlist on eight command directories already tracked in the base:
`blobshape`, `cfpprobe`, `credcanary`, `credshape`, `limprobe`, `poolcount`,
`poolrebuild`, `rotprobe`. The workspace-only check and web production build
passed separately. No allowlist or unrelated command was changed to hide this.

`git diff --check` passed. No deployment, service restart, PM2 operation,
subagent, cron job, or Hermes memory/configuration change was performed.

## Files changed

- `backend/go/go.mod`
- `backend/go/go.sum`
- `backend/go/internal/cfp/cfp.go`
- `backend/go/internal/cfp/egress_test.go`
- `backend/go/internal/cfp/export_test.go`
- `backend/go/internal/egress/egress.go`
- `backend/go/internal/egress/egress_test.go`
- `backend/go/internal/egress/export_test.go`
- `backend/go/internal/egress/live_test.go`
- `backend/go/internal/egress/pool.go`
- `backend/go/internal/egress/pool_test.go`
- `backend/go/internal/proxy/cfp_bridge.go`
- `backend/go/internal/proxy/egress_policy_test.go`
- `backend/go/internal/proxy/lifecycle.go`
- `backend/go/internal/proxy/proxy.go`
- `backend/go/internal/proxy/sourceip_client.go`
- `backend/go/internal/proxy/sourceip_client_test.go`
- `backend/go/internal/proxy/targets.go`
- `backend/go/internal/sourceip/affinity.go`
- `backend/go/internal/sourceip/affinity_test.go`
- `backend/go/internal/sourceip/sourceip.go`
- `backend/go/internal/store/catalog.go`
- `backend/go/internal/store/egress_test.go`
- `backend/go/migrations/0026_connection_egress.sql`
- `docs/architecture/egress-policy.md`
- `docs/architecture/egress-validation.md`
- `packages/platform/server/db/schema.ts`
