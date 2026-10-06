# Decommission log — fudrouter-app

## Backups (taken before any teardown)

| What | Path |
|---|---|
| Repo + database archive | `/home/dwizzy/backups/fudrouter-app-20260921-112609.tar.gz` |
| Hosts file | `/etc/hosts.pre-decommission` |
| Tunnel config | `/home/dwizzy/.cloudflared/config.yml.pre-decommission` |

## Steps

| Step | Status | Notes |
|---|---|---|
| 1. Backup | done | archive + hosts copy verified |
| 2. PM2 stop/delete | done | ports 8011/8012/443 free |
| 3. /etc/hosts cleaned | done | 10 MITM entries removed, 0 remaining |
| 4. Tunnel ingress | done | `ai.karepmuwes` rule removed; tunnel + zura routing intact |
| 5. setcap removed | done | binary no longer carries `cap_net_bind_service` |
| 5b. Stale credentials | done | `~/.pm2/dump.pm2.bak` shredded (held 8 secret env keys) |
| 7. SvelteKit scaffold | done | apps/web builds on adapter-node |

## Rollback

- **Hosts:** `sudo cp /etc/hosts.pre-decommission /etc/hosts`
- **Tunnel:** `cp /home/dwizzy/.cloudflared/config.yml.pre-decommission /home/dwizzy/.cloudflared/config.yml`
  then `sudo systemctl restart cloudflared`
- **Repo + database:** `tar xzf /home/dwizzy/backups/fudrouter-app-20260921-112609.tar.gz -C /home/dwizzy`
  — extract with `-C /home/dwizzy`, **not** `-C /`: the archive stores `.fudrouter/db`
  relative, so `-C /` would land the database in the wrong place. Then re-apply
  `sudo setcap 'cap_net_bind_service=+ep' <binary>` and `pm2 start <ecosystem config>`,
  followed by `pm2 save --force` (`pm2 save` refuses on an empty process list).

## Notes

- **Steps 3, 4 and 5 were performed by the controller, not a subagent.** Those writes —
  system config edits, a service restart, and `setcap -r` — need a harness approval that a
  subagent cannot obtain. All removals were user-approved.
- **Step 3 count corrected 8 → 10.** The plan originally named 8 MITM hostnames; the real
  `# fudrouter mitm` block has 10. `q.us-east-1.amazonaws.com` and
  `codewhisperer.us-east-1.amazonaws.com` were missed by the original discovery grep, which
  also left the plan's verification step blind to them. Corrected at source in commit
  `1239d93`; the end-to-end gate (Task 11) was corrected in `e3b6244`.
- **Step 4: zura is routed but its origin is down.** `zura.dwirijal.my.id` returns 502
  because nothing is listening on `127.0.0.1:8084` — pre-existing and unrelated to this
  teardown. Routing itself is intact, which is what this step changed.
- **Stale credential copy shredded — KEYS REQUIRE ROTATION.** `~/.pm2/dump.pm2.bak` (PM2's
  own backup of the pre-delete dump) still held the retired `fudrouter` entry with 8 secret
  env keys (`HINDSIGHT_LLM_API_KEY`, `HERMES_CUSTOM_API_TYPESAFE_AI_API_KEY`,
  `HERMES_CUSTOM_API_CLINE_BOT_API_KEY`, `HERMES_CUSTOM_LOCALHOST_20129_API_KEY`,
  `HERMES_CUSTOM_LOCALHOST_20128_API_KEY`, `HERMES_SESSION_KEY`,
  `TERMINAL_DOCKER_SHARED_CONTAINER_KEY`, `HERMES_CUSTOM_API_SEKAIGATEWAY_XYZ_API_KEY`),
  at mode 664 (world-readable). No PM2 code path reads that file; removed with `shred -u`.
  Flagged by the Task 2 review, cleaned as part of the retired-service remnant sweep.

  **Shredding is not remediation.** `shred` is best-effort on ext4-over-LVM — journal replay
  or an LVM/root snapshot can retain the blocks. Every key listed above should be treated as
  exposed and **rotated**. Until then the exposure stands.
- Full `/etc/hosts` diff against the backup: exactly 10 deletions, 0 additions.
- **NODE_ENV=production is exported in the homeserver shell.** `npm` treats it as `omit=dev`; every `apps/web` dependency is a devDependency. Always prefix `npm install`/`ci` with `NODE_ENV=development` or `node_modules` silently empties while exiting 0.

## S0-A verification

All acceptance checks passed: old service retired (PM2, hosts, ports,
capability), tunnel intact with Zura ingress, dev stack healthy,
web + router build and test green, backups verified restorable.

## Folded into the monorepo (2026-10-02)

Spec §4 planned to **delete** `fudrouter-app` outright (Phase C, after the S0-C
lift). Instead the source was folded into this repository at
`legacy/fudrouter-app/` with `git subtree add` — history preserved, all 5
commits — and the standalone repository was retired. The product is a monorepo;
the retired generation belongs in the same history rather than in a stray second
repo.

Nothing under `legacy/` is built or deployed: CI is scoped to `apps/react-web` and
`services/router`, and the root npm workspaces cover only `apps/*` and
`packages/*`. The tarball backup above is untouched and remains the rollback
source.

