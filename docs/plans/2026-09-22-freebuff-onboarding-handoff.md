# Freebuff (Codebuff free tier) → fudrouter — handoff

**Date:** 2026-09-22
**Status:** implementation COMPLETE & deployed · **activation PENDING a Bearer token from the user**
**Owner decision:** implement the protocol **natively in the Go data plane**, not as a sidecar gateway.

## Where it lives

| Artifact | Path |
|---|---|
| Protocol package | `services/router/internal/freebuff/` (`client.go`, `manager.go`, `models.go`, `models.json`, `util.go`, `freebuff_test.go`) |
| Dispatch | `services/router/internal/proxy/proxy.go` — `cred.Protocol == ProtocolFreebuff` |
| Credential field | `services/router/internal/proxy/pool.go` — `credentials.Protocol` (persisted through `pool.save()`) |
| Onboard | `apps/web/scripts/onboard-freebuff.mjs` (`npm run onboard:freebuff`) |
| Verify gate | `apps/web/scripts/verify-freebuff.mjs` (`npm run verify:freebuff`) |
| Test seeding | `services/router/tests/helpers.go` — `SeedEnvFreebuff`, `SeedEnvFreebuffAccounts` |
| Skill | `fudrouter-provider-onboarding` + `references/freebuff-protocol.md` |

## The ONE pending step

Supply a **codebuff.com Bearer token** (NOT a web Cookie), then:

```bash
cd /home/dwizzy/fudrouter/apps/web
FREEBUFF_TOKEN='<bearer>' npm run onboard:freebuff
npm run verify:freebuff          # must print: ALL CHECKS PASSED
```

Restart the router (`pm2 restart fudrouter-router`) only when **re-onboarding with a
different token** — the pool is cached in memory. A first onboard needs no restart
(the pool builds lazily on first request).

If the user only has a web Cookie (`__Secure-next-auth.session-token`): that needs
the separate web-protocol bridge (`web_protocol.rs` in the Rust reference, ~59KB),
which is **not ported**. Port it before onboarding a cookie.

## What is already proven (no token required)

- **Live upstream handshake** reached the real `www.codebuff.com` and came back
  `HTTP 401: Invalid API key` → classified `auth_expired`. Wire format
  (paths, headers, session/run handshake) is correct.
- **Through the running router**: `request_log` row = `upstream_error`,
  `upstream 401 on every account`, `provider_id=freebuff`, ~388 ms. Full chain
  exercised end to end.
- **Tests**: 15 unit (`internal/freebuff`) + 4 integration (`internal/proxy`:
  `TestFreebuffProtocolDispatched`, `TestFreebuffStreamsSSE`,
  `TestFreebuffFailsOverBetweenAccounts`, `TestFreebuffWaitingRoomReturns503`).
  Suite green, race-clean, `gofmt`/`go vet` clean.
- Binary `services/router/bin/fudrouter-router` is newer than all production source.

## Not yet proven (needs the token)

- A real HTTP 200 completion and real streamed content/usage through the router.
- The live gate: `FREEBUFF_TOKEN=<bearer> go test ./internal/freebuff/ -run TestLiveUpstreamHandshake -v`

## Defaults chosen

- `status='dev'` (spec §1) — invisible unless `ROUTER_ALLOW_DEV_PROVIDERS=1`
  (already set in `ecosystem.config.cjs`). Promote with
  `FREEBUFF_PROVIDER_STATUS=active`.
- Prices 0 (free tier). `context` null (upstream publishes no window for these ids).
- 15 of 19 model slugs seeded; 4 collide with UniKey table-wide and are skipped
  with a warning by the onboard script's `where model.provider_id='freebuff'` guard.

## If verify fails

```bash
tail -20 ~/.pm2/logs/fudrouter-router-error.log   # [proxy] provider=freebuff … status=<code>
```
Send that + the `verify:freebuff` output.
