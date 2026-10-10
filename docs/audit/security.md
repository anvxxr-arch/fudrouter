# Security (weight 7% → 7.0)

All 5/5: rotated secret live-verified (process/file hash match, placeholder absent, auth smoke 401 clean); ORIGIN-anchored auth URL; headers + fingerprint off; JSON errors + NODE_ENV=production in process; auth + public limiters (single-instance boundary documented); changeRole dominance; SSRF bridge-tested; SQL parameterized; gating verified; XSS sink escaped + repo-controlled; no hardcoded secrets.
