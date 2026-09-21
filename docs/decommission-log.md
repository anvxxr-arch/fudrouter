# Decommission log — fudrouter-app

Backup timestamp: 20260921-112609
Archive: /home/dwizzy/backups/fudrouter-app-20260921-112609.tar.gz
Hosts backup: /etc/hosts.pre-decommission

| Step | Status | Notes |
|---|---|---|
| 1. Backup | done | archive + hosts copy verified |
| 2. PM2 stop/delete | done | ports 8011/8012/443 free |
| 3. /etc/hosts cleaned | done | 10 MITM entries removed, 0 remaining |

## Notes

- **Step 3 count corrected 8 → 10.** The plan originally named 8 MITM hostnames; the
  real `# fudrouter mitm` block has 10. `q.us-east-1.amazonaws.com` and
  `codewhisperer.us-east-1.amazonaws.com` were missed by the original discovery grep,
  which also left the plan's verification step blind to them. Corrected at source in
  commit `1239d93`; the end-to-end gate (Task 11) was corrected in `e3b6244`.
- **Step 3 edit was performed by the controller, not a subagent.** The write needs a
  harness approval that a subagent cannot obtain. All 10 removals were user-approved.
- Full /etc/hosts diff against the backup: exactly 10 deletions, 0 additions.
| 4. Tunnel ingress | done | ai.karepmuwes removed; tunnel + zura intact |
| 5. setcap removed | done | binary no longer carries cap_net_bind_service |
- **Stale credential copy shredded.** `~/.pm2/dump.pm2.bak` (PM2's own backup of the
  pre-delete dump) still held the retired `fudrouter` entry with 8 secret env keys
  (`HINDSIGHT_LLM_API_KEY`, `HERMES_CUSTOM_API_*_API_KEY`, `HERMES_SESSION_KEY`,
  `TERMINAL_DOCKER_SHARED_CONTAINER_KEY`). No PM2 code path reads that file; removed
  with `shred -u`. Flagged by the Task 2 review, cleaned here as part of the retired-
  service remnant sweep.
