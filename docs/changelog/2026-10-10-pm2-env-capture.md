# PM2 was snapshotting the operator's shell into the services

A PM2 process definition is not just a script and an `env` block. When an app is
created, PM2 captures the environment of the **client that created it** and
writes it into `~/.pm2/dump.pm2`; `pm2 resurrect` then replays that stored
environment at every boot. The `run*.sh` entrypoints source the real config
(`.env`, `.env.react-web`) at start, which was taken to mean credentials could
never reach the dump. That assumption was wrong in two ways at once, and both
were live in production.

## What was actually stored

`~/.pm2/dump.pm2` held, as top-level keys of the `fudrouter-workers` and
`fudrouter-react` entries, the full environment of the agent shell those
processes had originally been created from:

`HERMES_CUSTOM_API_{TYPESAFE_AI,CLINE_BOT,SEKAIGATEWAY_XYZ,LOCALHOST_20128,LOCALHOST_20129,JEROUTER_WEB_ID}_API_KEY`,
`HINDSIGHT_LLM_API_KEY`, `HERMES_SESSION_KEY`, and ~35 more `HERMES_*` /
`TERMINAL_*` variables — **values included**, and the file was mode `664`
(world-readable). Every child process inherited the same variables, so a
service that had no business holding them carried them in `/proc/<pid>/environ`.

The names are the same set `docs/decommission-log.md` recorded on 2026-09-21,
when the same file was shredded and every key was flagged for rotation. The
rotation was never done, so this is a recurrence of an unresolved exposure, not
a new one.

## The second, quieter casualty

The router's process environment carried `ROUTER_ALLOW_DEV_PROVIDERS=1` while
`.env` has that variable **commented out** and `ecosystem.config.cjs` never set
it. It arrived the same way — a shell that had it exported, followed by
`pm2 restart --update-env`. That variable is the spec §1 interlock: a provider
onboarded as `dev` is a personal-OAuth layer the design forbids shipping, and it
is meant to be invisible unless an operator explicitly opts in. In production
the gate was open, so the next `dev` provider onboarded would have been served
publicly with no config change and nothing in the logs to say why. No `dev`
provider exists today, so nothing leaked — the guarantee was simply not in force.

## The control

`ecosystem.config.cjs` now declares `filter_env` on all four apps. PM2 matches
these strings as **key-name substrings** and drops matching keys from the
environment it hands the app, so they can no longer enter a child process env or
the dump, no matter what shell created the process.

`filter_env: true` looks like the obvious spelling and is a no-op: `Common.js`
tests `app.filter_env.length`, which is `undefined` for a boolean, so the filter
branch is skipped entirely and the full client env is used. Only an array
filters anything.

`TMPDIR` is filtered alongside the secrets. It pointed into the agent scratch
directory, which is pruned after 72h — a poor place for a long-running service's
temporary files.

## Verified

- Create all four apps from a shell carrying 39 `HERMES_*` and 27 `TERMINAL_*`
  variables, with no `env -i`: every child env and both dump files come out with
  **zero** filtered keys. The control is what makes this safe, not launch
  hygiene.
- `fudrouter-router` env: `ROUTER_ALLOW_DEV_PROVIDERS` **absent** — the §1
  interlock fails closed again. Cache key written by the live router is
  `rt:<ns>:models:v2:dev=0`.
- Filtering removed nothing the services read: all four apps still have every
  variable they consume, and all endpoints (loopback, Caddy, public host)
  return 200. Workers kept draining — 18,695 `completed`, 1 `failed`.
- `~/.pm2/dump.pm2` and `dump.pm2.bak` are mode `600` and contain no
  filtered keys.
- `tools/pm2-env-hygiene.sh` asserts all of the above. Its failure path is
  exercised against a synthetic dump: it names each offending key and exits
  non-zero. It derives the expected filter list from `ecosystem.config.cjs`, so
  it cannot drift from the configuration it checks.

## Still outstanding

**The exposed keys require rotation.** `shred` is best-effort on ext4-over-LVM —
journal replay or a snapshot can retain the blocks — and the file was readable by
any local user for as long as it sat at mode `664`. Treat every key named above
as compromised and rotate it. Until then the exposure stands.
