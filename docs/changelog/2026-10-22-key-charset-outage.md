# Half of every minted API key could not authenticate

## What happened

`apps/web/server/pages.mjs:22` mints the key prefix and secret with
`randomBytes(N).toString('base64url')`. The base64url alphabet is
`[A-Za-z0-9_-]`. The Go data plane's `keys.Parse` accepted only `[A-Za-z0-9]`
for both halves and answered `malformed api key` — a 401 with no diagnostic —
for anything else.

`-` appears in a base64url prefix with probability `1 - (63/64)^8`, about 12%
per key, and in a 43-character secret about half the time. Measured on the live
table before the fix: **5 of 69 active keys had a `-` in the prefix and could not
authenticate at all.** Their keys were minted by us and were valid; the parser
rejected them.

The rejecting code carried the comment *"The wire format is ids.New output, so
this rejects nothing legitimate."* That claim was false. `ids.New` formats
`<prefix>_<uuidv7>` for entity ids; API key prefixes are minted by
`randomBytes`, not `ids.New`, and the two have different alphabets.

## Why it surfaced now

The check was added as a DoS/control-character guard (M-b) and shipped without a
test that fed it a key the minter actually produces. The existing tests used
`abcdefgh` / `0123456789abcdef…`, both alphanumeric, so the guard passed while
breaking real keys.

## Fix

`keys.Parse` now mirrors the minter exactly, splitting the charset by half
because the two halves differ for a real reason:

- **prefix** — `[A-Za-z0-9-]`. `_` is excluded because the minter loops until
  the prefix excludes it (`while (prefix.includes('_'))`); the first `_` is the
  delimiter.
- **secret** — `[A-Za-z0-9_-]`, the full base64url alphabet.

Length bounds and the control-character rejection are unchanged, so the guard
still does its job.

## Verification

- `go test ./internal/keys/` passes, and the new table rows pin both halves:
  `sk-ar-ab-cd-efg_…` (hyphen prefix) and `…abcde_…` (underscore secret) must
  parse; `sk-ar-abc_def_…` (underscore in prefix) and `…/` (slash in secret)
  must not.
- Mutation: reverting to the alphanumeric-only check turns the new table red.
- Live: a request carrying a hyphen-prefix key now answers `invalid api key`
  (lookup ran, hash mismatched) instead of `malformed api key`.
- `go vet ./...` clean; `go test ./...` 13/13 packages.

## Lesson

A charset guard on a value another component mints must be tested with a sample
that component actually produces. A hand-written literal is a different
alphabet until proven otherwise.
