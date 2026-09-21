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
  commit `1239d93`; the end-to-end gate (Task 11) was corrected in `e1b2c4d`.
- **Step 3 edit was performed by the controller, not a subagent.** The write needs a
  harness approval that a subagent cannot obtain. All 10 removals were user-approved.
- Full /etc/hosts diff against the backup: exactly 10 deletions, 0 additions.
