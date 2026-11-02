# Per-connection inference egress

Migration: `backend/go/migrations/0026_connection_egress.sql`, applied only through
`ops/migrate.sh`. Policy is read by both `Candidates` and `CandidatesBatch` and
carried separately from decrypted account secrets. No management route or public
API contract changes. Configure connection rows through existing operator SQL;
this change does not add console controls.

## Modes and compatibility

- `ipv6_rotate` is the NOT NULL default for existing and new rows. It preserves
  the historical dispatch: anonymous/keyless HTTP and CFP use random assigned
  global IPv6 on a new dial; keyed HTTP keeps the original upstream client.
  Keep-alive is still allowed. Applying the migration does not opt a provider
  into sticky, direct, or the operator pool.
- `sticky_own` binds one assigned global IPv6 to a credential row ID. All models
  and refreshed tokens belonging to that row share the affinity. A fresh socket
  still binds that address. A burn or absolute lease expiry causes reacquisition.
- `direct` pins one source for the handler's lifetime, independent of credential
  and burns. `ROUTER_DIRECT_SOURCE_IP` can select an assigned IPv4 or IPv6; absent
  that setting, the first discovered global IPv6 is retained. A host with no such
  source must configure one. Direct does not retry anonymous IP rejections from
  the same fixed source three times.
- `pool` uses HTTP CONNECT or SOCKS5 on an operator-approved endpoint. It is inert
  without all three environment settings below: dispatch falls back to the
  historical keyed/keyless default. A fully configured pool fails closed on
  invalid configuration, failed authentication, or connection failure; it never
  silently sends an opted-in request directly.

Explicit direct/sticky binding does not fall back to an unbound socket. Thus an
IPv4-only upstream cannot use `sticky_own` with this IPv6 pool; use a configured
IPv4 direct source or the operator pool instead. `SOURCE_ROTATE=0` also disables
own-IPv6 affinity; it does not change an explicit direct source.

Example (psql connection_id variable supplied by the operator):

```sql
UPDATE connection
SET egress_mode = 'sticky_own', sticky_ttl_seconds = 3600, proxy_url = NULL
WHERE id = :'connection_id';
```

## Lease lifetime and key shape

`sticky_ttl_seconds` defaults to 3600 and the database permits 1..86400 seconds.
One hour spans sixty of the current 60-second IP-throttle windows, rather than
making a credential appear from hundreds of /128s within a minute. The 24-hour
cap bounds abandoned state. Hits do not slide expiry; changing the configured
TTL reacquires the lease. Unused entries are swept lazily once a minute.

Own-IP affinity is a process-local `credential.id -> {IP, expiry, TTL}` map,
protected across concurrent first picks. It deliberately shares the host-local
assigned-IP snapshot and burn table, not a bare shared Valkey value. A different
host cannot bind this host's /128s; correct cross-process/host persistence would
need a host-qualified atomic lease and shared burn invalidation, not a racing
GetJSON/SetJSON pair. Restarting the handler resets affinity. There is no claim
of cross-router or restart persistence. The measured host has 1,027 assigned
addresses in `2404:c0:b204:a199::/64`; the picker still uses assigned addresses,
not arbitrary unassigned addresses in the routed prefix.

The pool session map is keyed by approved endpoint plus credential row ID. Its
username is `fr-<64-bit credential-ID digest>-<96-bit random generation>`.
Credentials, caller API keys, models, and bearer/refresh tokens never become
cache keys or usernames. The generation lasts for the same absolute TTL and is
replaced after a rejection. A stale rejection cannot delete a newer generation.
The pool operator owns allocation of the actual remote IP; replacing a username
requests a new pool identity, not a guarantee about the operator's allocator.
Pool sessions also reset on process restart.

Transports are shared by local /128 or remote sticky session, not by destination
alone. Otherwise a correct affinity map could still send credential B over
credential A's already-bound keep-alive/HTTP2 socket. The cache is capped at 256
transports and evicts idle sockets only, so 74,242 imported credentials do not
create 74,242 retained transport pools. Active responses/streams are not closed
by eviction.

## Burns and socket attribution

HTTP 429 burns for 60 seconds; HTTP 402 and explicit sticky/pool 403 bans burn for
15 minutes. These are separate from credential quota/cooldown accounting. A
buffered HTTP-200 rate-limit/auth refusal also invalidates an explicit sticky
identity. Direct stays fixed on rejection. HTTP burns include the last retry,
not only retries that have another attempt remaining.

`httptrace.GotConn` attributes the actual chosen socket, including keep-alive
reuse and kernel fallback. Looking only at DialContext misses reuse and can
attribute a losing parallel dial. Anonymous rotation drops idle sockets after
closing the rejected response; sticky source/session selection prevents reuse of
a rejected identity. CFP carries the same policy into each Chrome-TLS/WebSocket
dial and reports its actual raw socket source before returning a rejection.

## Operator pool configuration

The deployment environment must supply:

```text
ROUTER_EGRESS_POOL_ENABLED=1
ROUTER_EGRESS_POOL_URL=http://127.0.0.1:3128
ROUTER_EGRESS_POOL_CONSUMER_KEY=<injected by the operator's secret mechanism>
```

The consumer key is the password; the generated sticky session is the username.
The placeholder above is documentation, never a default credential. No consumer
key is stored in `connection.proxy_url`, logs, or repository configuration.

`ROUTER_EGRESS_POOL_URL` requires a literal IP and explicit port. A connection's
optional `proxy_url` may select `http://` or `socks5://` on that SAME approved
socket (the operator's outbound frontends share port 3128), not another internal
endpoint. URL userinfo, queries, fragments, and non-root paths are rejected.
Missing gate, URL, or key does not parse/contact a connection-supplied proxy.

No client inherits `HTTP_PROXY`/`HTTPS_PROXY`. Local direct/rotate/sticky dials
carry `internal/netguard`'s post-resolution Control hook. Pool requests resolve
upstream DNS locally, apply that same public-IP rule, and tunnel only a verified
numeric target. The proxy cannot re-resolve a hostname. Original HTTP Host and
TLS SNI remain intact. Redirects repeat validation. The local proxy bypass is
limited to the explicitly approved socket; it does not grant access to arbitrary
private upstreams. Header/tunnel phases are bounded; successful SSE bodies are
not buffered.

## Verification boundaries

The tests include real bound TCP sockets, fresh-dial credential affinity,
keep-alive attribution, 402/429/403 rotation, TTL/concurrent-first-pick behavior,
SQL defaults/constraints and both candidate queries, direct stability, inert
pool behavior, authenticated local HTTP CONNECT/SOCKS5 tunnels, TLS/provider
header preservation, private target/redirect refusal, and cancellation.

`TestEgressPolicyStickyOwnIPv6` uses the imported isolated database and a LOCAL
upstream. It sends 100 requests over fresh sockets through one provider
credential row, using two caller accounts to preserve the existing 75-rpm
account gate. Host IPv6 absence skips that optional integration probe; the
ordinary deterministic TCP tests remain independent of interface configuration.
An authenticated bearer-credential integration case also covers 100 fresh
sockets and an external `sourceip.Burn`. No imported provider secret is sent
to an external provider by these tests.

Public routed-IP verification is separately opt-in, with no inference secret:

```sh
EGRESS_LIVE_ECHO_URL=https://api64.ipify.org \
  GOTOOLCHAIN=auto go test ./internal/egress \
  -run '^TestEgressLiveIPv6Affinity$' -count=1 -v
```

That public echo path was exercised successfully: sticky repeated the same /128,
burning it changed the next echo, and direct repeated its fixed /128. CFP's
policy/rejection hooks are unit-tested, not verified against a live Cloudflare
WebSocket session. The operator pool's TCP port was reachable, but no consumer
key was available in this environment: authenticated operator HTTP/SOCKS5 egress
is UNVERIFIED end-to-end. Local proxy fixtures are not evidence to the contrary.

The imported catalogue also exposes pre-existing full-suite fixture failures:
`TestVirtualRequestRewritesUpstreamModel`, `TestVirtualFanOutIsConstant`, and
`TestVirtualFanOutStillCoversEveryModel` assume an empty/routable-only catalogue
or select imported credentials unavailable to their synthetic test master key.
They failed before the egress edits. Do not present a filtered or unit-only run
as an unfiltered full-suite pass.

The later filtered suite also exposed an unstable existing load gate,
`TestLoadLedgerSurvivesPoolOversubscription`: one run rejected 179 requests with
429; its unchanged isolated rerun passed all 2,000 requests and ledger assertions;
another filtered run answered 2,000 requests but recorded only 1,938 charges
within its drain deadline. The cause was not established in this workstream.
Do not describe that filtered suite as passing either. Root `npm run check`
also fails the existing layout allowlist on eight command directories already
tracked in the base commit; workspace typechecks/contracts and the web build pass.
The exact command/result history is in [egress-validation.md](egress-validation.md).
