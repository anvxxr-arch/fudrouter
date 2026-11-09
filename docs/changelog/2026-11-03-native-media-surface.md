# Phase log — native media surface (2026-11-03)

Target: close the `docs/specs/2026-09-25-endpoint-surface.md` §8 gap that declared
`/v1/images/*` a **non-goal** ("not requested, not designed, and currently
indistinguishable from the supported surface because of the catch-all").

That gap stopped being academic the moment a real image/video upstream was
onboarded: `muse2api` is a loopback bridge that answers six media shapes, four of
which the router could not serve at any setting.

Every phase: implement → adversarial test → verify against the real bridge →
skeptical re-read of the route table.

## What shipped

| Phase | Deliverable | Evidence |
|---|---|---|
| Surface | `internal/proxy/media.go` — image gen/edit, image+video task poll, unbilled byte fetch | 6 tests, all pass |
| Store | `internal/store/media.go` — `MediaBridge`: connection + first usable credential in ONE round trip, `pgx.ErrNoRows` → `store.ErrNotFound` | `TestMediaFetchIsUnbilled` |
| Routes | 6 patterns registered ahead of the `/v1/` catch-all, with explicit methods | `TestMediaRouteIsNotTheCatchAll`, `TestPublicSurfaceIsPinned` (6 new rows) |
| Onboard | `ops/onboard-muse2api.mjs` — `muse-image`/`muse-video` rows with the bridge's real model ids | `node --check` + 2 rows live |
| Test DB | `fudrouter_test` rebuilt from S0 → 30 migrations applied | full `internal/proxy` + `internal/store` suite |

## The three bugs the design had to answer

### 1. A media URL that points at loopback

The bridge mints its media URLs from the **Host header of the request it
received** (`config.py:31`, `public_base` default `""`), and the deployed bridge
has `MUSE2API_PUBLIC_BASE=` — empty. So every generation answered:

```json
{"data":[{"url":"http://127.0.0.1:18610/v1/media/img_abc.png"}]}
```

That URL is correct only for a client sitting on the homeserver. For every other
client it is unreachable, and no amount of routing fixes it: the address the
router must hand out is **its own**, because it is the only hop in the exchange
the client can actually reach.

`rewriteMediaURLs` walks the decoded JSON and swaps the **origin** of any string
whose path starts `/v1/media/`, leaving the path — and therefore the media name —
untouched. Recursive rather than a byte-level substitution, because the same URL
appears at different depths (`data[].url` on an image answer, `result.url` on a
video task) and a raw-bytes regex would also rewrite a prompt the model echoed
back. Rewriting is applied **only to 2xx bodies**: an error envelope must reach
the client as the error it is, not as a 200 with a rewritten URL inside.

`PUBLIC_API_BASE_URL` is the source of truth (already set to
`https://fudrouter.my.id`); the `X-Forwarded-Proto`+`Host` fallback exists for a
direct-to-router deployment, because trusting a client-supplied Host to mint a
URL is acceptable only when nothing authoritative is configured.

### 2. The GET paths could not be reached at all

`POST /v1/images/generations` fell into the `/v1/` catch-all, which only forwards
when the operator raised the passthrough hatch — survivable. The GET forms were
not: **the catch-all reads a JSON body**, so `GET /v1/videos/{task_id}` answered
`400 {"error":"invalid JSON body"}` at *any* hatch setting. A task poll that
cannot be polled is a generation that never completes.

The four generation/poll routes are therefore registered with **explicit
methods** instead of as bare patterns, so a wrong verb is a mux-level `405`
rather than a silent forward to an upstream that would answer for a different
resource.

### 3. The byte fetch must not bill

`GET /v1/media/{name}` is the **one** `/v1` handler that never calls `begin()` —
no model, no ledger row, no budget gate, no concurrency slot. The reasoning is
load-bearing, not stylistic: the image was billed when it was *generated*.
Charging the fetch that delivers it would make retrieving what you already bought
cost extra, and a balance another request drained would make an already-generated
image undownloadable. `TestMediaFetchIsUnbilled` asserts the ledger delta is
**0** across a fetch.

The route is public for the same reason a media URL has to be embeddable in an
`<img>` tag. Its honesty comes from validation instead of auth: the name is
checked against `mediaNameRe`, which mirrors the bridge's own `_SAFE_NAME`
(`core/media.py`), and the fetch is the router's own outbound request — a client
names a *name the bridge could have minted*, never an arbitrary URL. Three
traversal shapes (`..%2fetc%2fpasswd`, empty, no-extension) are asserted to 404
**without opening an upstream connection**.

## Model ids are the bridge's, not ours

The bridge's `resolve_model` (`core/models.py:51`) rejects a kind mismatch:

```python
if spec.kind != kind:
    raise InvalidRequest(f"model '{name}' is a {spec.kind} model, expected {kind}")
```

with only three real models — `muse-chat`, `muse-image`, `muse-video` — and
`dall-e-3`/`gpt-image-1`/`sora` as aliases. So the routing key and the upstream id
are **not interchangeable**: an image call must name `muse-image`. The
`provider_model` rows for the media keys were inserted with
`provider_model_id = 'muse-image' / 'muse-video'`, and
`ops/onboard-muse2api.mjs` now creates them with `modality`/`capabilities`
matching (`{"type":"image"}`, `{"chat":false}`) instead of inheriting the chat
defaults. Its header comment claiming a media call "needs the generic passthrough
hatch" is now false and was corrected — that comment was describing the state
before this file existed.

## Two more gaps found by running the drill and the hash check

**1. `ops/verify/prod-router-drill.sh` had rotted (again).** The drill failed
`active provider served` AND `dev provider served once opted in` — both `0`,
which reads like a broken dev-flag interlock. It was not. The drill's seed was
written against the pre-0027 catalogue join and inserted only
`provider → model → provider_model`; migration `0027_connection_egress` put
`connection` and `credential` in the chain, so a `provider_model` with a NULL
`connection_id` fails the `exists (select 1 from connection ...)` clause no matter
how healthy the provider row is. Every catalogue assertion went to 0 for a
reason unrelated to what the drill exists to test — the exact rot its own
comment already warned about from the last time.

The seed now writes the whole four-hop chain (`model → provider_model →
connection → credential`) and prints the counts of all five tables, so a future
schema change that adds a hop shows up as a smaller count instead of a bare
`FAIL`. Probe both directions, as the drill's own philosophy demands:
`bash ops/verify/prod-router-drill.sh` → **ALL CHECKS PASSED — production
posture correct**, against a build of *this* tree.

**2. The deployed binary does not match the tree.** On-disk/running
`bin/fudrouter-router` is `b22155b75fe6f09b…`, built 2026-11-03 13:38 UTC; a
fresh `go build` of this tree is `52ae230bfd8ed8fe…`. So **none of this work is
live yet** — the curl evidence above (media paths answering `401` from the
catch-all) is the *before* state, not a bug in the new code.

That is a known, documented gap and not a new one: `AGENTS.md` forbids
`pm2 start` / `pm2 restart --update-env` from an agent shell, because PM2
captures the creating client's environment into `dump.pm2` and replays it
forever (it has burned this repo twice). Deploy is therefore the operator's
step, and the sequence is:

```bash
cd /home/dwizzy/fudrouter/backend/go && go build -o bin/fudrouter-router ./cmd/gateway
# restart through the operator's own deploy path, then:
ops/verify/pm2-env-hygiene.sh
sha256sum bin/fudrouter-router /proc/$(pm2 pid fudrouter-router)/exe   # must match
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8100/v1/media/x.png   # not 401
```

The last line is the one that distinguishes "restarted" from "restarted and
actually serving the new surface" — `pm2 list` reporting `online` proves neither.

## The contract gate caught a real gap

`AGENTS.md` says a new inference route **fails the build** until it is added to
`INFERENCE_PATH_MAP` in `packages/contracts/test/surface.test.mjs`, and the media
work did not do that — `npm run check -w @fudrouter/contracts` failed with:

```
extract-routes --check: routes.json is STALE
  + inference GET  /v1/images/generations/ -> p.ServeImages
  + inference GET  /v1/media/              -> p.ServeMedia
  + inference GET  /v1/videos/             -> p.ServeVideos
  + inference POST /v1/images/edits        -> p.ServeImages
  + inference POST /v1/images/generations  -> p.ServeImages
  + inference POST /v1/videos              -> p.ServeVideos
```

Six routes served with no documented contract is exactly the drift the gate
exists to catch, so the gate was right and the work was incomplete. Three files
follow, all mechanical except the OpenAPI prose:

- `routes.json` regenerated via `npm run extract -w @fudrouter/contracts`
  (inference 9 → 15; management unchanged at 172, so nothing else moved).
- `INFERENCE_PATH_MAP` gained the six rows. The two task polls map to
  `/v1/images/generations/{task_id}` and `/v1/videos/{task_id}` and carry an
  `x-route-pattern` note in the YAML because they are ServeMux **prefix**
  patterns, not the literals the OpenAPI document can express — the same
  treatment `GET /v1/models/` already had.
- `inference.yaml` documents all six, including the one thing a reader cannot
  guess from the path: `/v1/media/{name}` is public and **unbilled**, and why a
  fetch of already-purchased bytes must not be a second charge.

`npm run check -w @fudrouter/contracts` → OK (15 inference + 172 management);
`npm test -w @fudrouter/contracts` → 8/8 pass; root `npm run check` → exit 0.

## A flaky test found on the way (unrelated to media)

Running the full `internal/proxy` suite surfaced exactly one failure:
`TestClassify402DailyCapFallsBackToUTCReset`. It was **not** caused by this work
(`targets.go` and `classify402_test.go` were untouched) — it is time-of-day
dependent and had been failing silently for the last 15 minutes of every UTC day.

The test asserts a daily-cap 402 is parked *until the wall-clock reset* rather
than the generic 15-minute bench, via `got <= 900 → fail`. But
`secondsUntilUTCReset` correctly answers **55 seconds** at 23:59:05Z, and 55 is
legitimately below 900. The equality check against `want` was right; the extra
`> 900` assertion was only valid while UTC midnight was more than 15 minutes out.

The invariant is conditional, so the assertion now is too: when the boundary is
**further** than the bench, a bench-sized park is the bug; when it is **closer**,
a shorter park is the answer and the equality check already covers it. Verified
across four positions in the day (00:05, 12:00, 23:44, 23:59) — all pass.

## Test-database note

`fudrouter_test` was a **stale S0 schema with an empty `schema_migration`** (44
backing tables, none recorded). Two symptoms, one cause:

- every proxy test failed with `500 unknown model: <slug>` — `ResolveModel`'s
  UNION joins `model_slug_alias`, which migration 0026 creates and the database
  did not have;
- `TestStreamNotCutByClientTimeout` — pre-existing, unrelated to this work —
  failed the same way, which is what proved the cause was the database and not
  the new code.

Rebuilt with `drop database` + `ops/migrate.sh` → 30 migrations, 0 pending.
`ops/migrate.sh` cannot repair a database in that state on its own: it detects
"existing S0 schema", baselines everything before 0006 as applied, then aborts on
0006 because those tables already exist. A `fudrouter_test` that has gone stale
must be dropped, not migrated.

## Verification

```
go build ./...                                    OK
go vet ./internal/proxy/ ./internal/store/        clean
go test ./internal/proxy/ -run 'TestMedia|...'    6/6 pass
go test ./internal/store/                           ok
```

Live bridge cross-check (the contract the code was written against):

```
GET  http://127.0.0.1:18610/openapi.json
  /v1/images/generations        POST   ← served by ServeImages
  /v1/images/generations/{id}   GET    ← served by ServeImages
  /v1/images/edits              POST   ← served by ServeImages
  /v1/videos                    POST   ← served by ServeVideos
  /v1/videos/{id}               GET    ← served by ServeVideos
  /v1/media/{name}              GET    ← served by ServeMedia

provider muse2api  slug=muse2api  status=active  connection healthy
credential cred_muse2api_2acc1a407b2676a6  healthy
model rows: muse-image -> muse-image (available), muse-video -> muse-video (available)
```

## Not done

- **Not deployed.** `bin/fudrouter-router` is built at run time by PM2 from the
  repo; the new binary is not yet through `ops/verify/pm2-env-hygiene.sh`.
- **No live end-to-end media call.** The bridge's `driver` is `browser`, so a
  real generation drives a headless browser against muse.ai and takes minutes
  (image) to tens of minutes (video). The upstream contract was verified from the
  bridge's own OpenAPI + `resolve_model` source, not from a completed generation.
- `muse-image`/`muse-video` are priced at 0 (free) — deliberate for now, but it
  means a media generation writes a ledger row at zero cost rather than a real
  charge.
