# Retrospective — Sprint 1–7 (fondasi uang + payment loop)

> Ditulis pasca eksekusi. Bukan plan; catatan residu & metrik go/no-go untuk flip prod.

## Apa yang dikirim (per sprint)

| Sprint | Deliverable | Commit |
|---|---|---|
| S1 | A1 scrub eksekutif + pre-image/undo; A2 reconcileAll isolate-exclude + quarantine (0037); A3 ceiling add-credit + rename `admin_credit:` (0036) | `d970ce2`, `5ebf686` |
| S2 | B0 entitlement gate (subscription-aware); B1 gateway interface + ADR-0008; B2 grant writer (+`economic_bucket=frsubs`, 0038) | `68df09d`, `3159a5d` |
| S3 | B3a inbound webhook receiver; B3b confirm→grant loop | `2975b87` |
| S4 | C1 Telegram + C2 Discord adapter | `1f613ca` |
| S5 | E1 (ADR selesai di S2); E2 runbook flip+revert | uncommitted (docs) |
| S6 | B5 eskalasi approval + contract lock regen | `9a10f3f` |
| S7 | B4 konversi `FreeAccessNoPaymentGateway` → env feature-flag (default OFF) | uncommitted (`limits.go`) |

## Defect / judge yang mengubah arah

- **Verdict REVISE** (Devil + Pessimist): 19 temuan P0/P1. Dua P0 tidak bisa dijawab rencana v1 — `reconcileAll` overflow (`::bigint` > int64) dan subscription-gate nol call-site (flip = self-lockout).
- **Over-engineering**: rescope ke walking-skeleton (tutup loop uang dulu) — D-economics (COGS/markup/kuota/prefix) DEFERRED ke sinyal revenue.
- **CHECK NULL propagation**: dua constrain DB (markup-basis + farm-zero) lolos diam-diam bila kolom NULL; diperbaiki `IS NOT NULL`/`IS NOT DISTINCT FROM 0` + test.
- **B2 price_idr unit**: komentar 0025 bilang "×100" tapi seluruh jalur rupiah utuh; diputus = rupiah utuh, komentar dikoreksi.
- **Contract drift**: route B3a/B3b tidak ikut `routes.json` lock; regen kontrak = gate hijau.

## Risiko tersisa (diterima, terukur)

1. **A1 scrub PROD belum dijalankan** — prod masih 34 migrasi (berhenti 0032) + 2 baris korup `5.55e18`. Flip = prasyarat operator manual via `ops/scrub-balance-anomaly.step1/2.sql` + pre-image.
2. **Migrasi 0038 belum di-apply prod** — `GrantSubscription` `ON CONFLICT` gagal tanpa index unik; WAJIB `ops/migrate.sh` sebelum grant writer live.
3. **`recordClaim` seam** (C1/C2) belum di-wire ke jalur claim nyata (`pages.mjs`) → `payment.status='claimed'` belum ditulis dari bot.
4. **Transport persist timer** (B5) belum ada job yang memanggil `escalate`/`approvalRoute` — escalation spec-complete, belum live.
5. **Writer `credit_purchase` produksi** belum ada (flat subscription tidak perlu, tapi frpayg metered nanti butuh).
6. **D-economics deferred** (D1–D5): gate = sinyal revenue (≥1 `payment` confirmed / ≥1 `subscription` aktif non-admin).

## Bugfix kecil hasil QA

- `webhook.mjs` komentar "503 (misconfigured)" → kode aktual 401; diperbaiki (fail-closed).
- `nextApprover` hardcode `approvers[1]` (bukan ordered walk); transport wajib prefer `escalate`.

## Flip prod go/no-go (dari runbook E2 §2, G1–G5)

| # | Metrik | Syarat |
|---|---|---|
| G1 | balance out-of-range | 0 akun |
| G2 | drift `balance != Σledger` | 0 akun |
| G3 | baris implausible (`abs > 1e12`) | 0 |
| G4 | `Σledger == Σbalance` global | selisih 0 |
| G5 | idempoten scrub 2× | 0 baris berubah |
| — | migrasi 0038 applied | `schema_migration` berisi 0038 |
| — | B2/B3/C1/C2/B5/E2 committed + smoke | hijau |
| — | env `FUDROUTER_BILLING_ENFORCE` semantic | unset=OFF, truthy=ON (terbukti) |

**Status**: kode S7 siap; flip prod **TIDAK dilakukan** karena G1–G5 + 0038 belum terpenuhi di produksi. Ini by design — bukan defect.