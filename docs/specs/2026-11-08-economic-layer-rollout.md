# Rollout — Lapisan Ekonomi (F0–F2)

Catatan operasional singkat. Desain lengkap, alasan, dan DDL final:
[`2026-11-08-economic-layer-design.md`](./2026-11-08-economic-layer-design.md).
Fase F3–F6 (backfill harga pokok, markup nyala, kuota frsubs live, prefix
publik) TIDAK termasuk di sini — ini hanya yang dibangun sekarang.

---

## Fase

| Fase | Isi | Go / no-go numerik |
|---|---|---|
| **F0** | Migrasi `0033_economic_bucket.sql` (aditif: kolom bucket + snapshot + `provider_model_supply` + backfill legacy) dan `0034_economic_cost.sql` (tabel `provider_cost_rule`, `bucket_margin`, `bucket_quota` + seed) terpasang. | `ops/migrate.sh` keluar 0 error; 549.869 baris request_log ter-backfill `billing_basis='retail'`. |
| **F1** | Scrub anomali `balance_micro`/`credit_ledger` di **staging**, lalu `reconcileAll` 2×. | `Σ balance_micro == Σ credit_ledger.amount_micro`; anomali `5,55e18` hilang dari report scrub. |
| **F2** | Writer emit `bucket` + `billing_basis`/`cost_basis`; `0035_economic_enforce.sql` (gated) dibuka. | CHECK constraint lulus; 0 `check_violation` di CI/prod; 7 test DDL §4.3 (T1–T7) hijau. |

**Urutan mutlak:** F1 (scrub) **sebelum** `FreeAccessNoPaymentGateway=false`
(`limits.go:81`). Alasan: `balance_micro` hanyalah cache dari
`SUM(credit_ledger.amount_micro)`, dan cache korup `5,55e18` bisa berasal dari
*baris ledger* yang ikut korup. Menjalankan `reconcileAll` sebelum baris ledger
dibersihkan justru menyalin `5,55e18` ke cache, bukan menghapusnya
(invariant 4, §8 desain). Scr: `ops/scrub-balance-anomaly.sql`.

**Rollback:** drop `0035` → semua kembali passthrough markup 1.0 / basis
`retail`; tidak ada rewrite histori (kolom aditif, snapshot tidak disentuh).

---

## File

**Migrasi (baru):**
- `backend/go/migrations/0033_economic_bucket.sql`
- `backend/go/migrations/0034_economic_cost.sql`
- `backend/go/migrations/0035_economic_enforce.sql` (gated)

**Data plane Go:**
- `backend/go/internal/store/economic.go` — kontrak tipe `Bucket`/`BillingBasis`/`CostBasis` + `MarkupMicro` (big.Int).
- `backend/go/internal/store/catalog.go` — `HasSupply` (guard supply, non-hot-path).
- `backend/go/internal/store/pricing.go` — `ResolveProviderCost` (mirror `ResolvePricing`, tiga-nilai).
- `backend/go/internal/store/billing.go` — `ChargeRequest` (flat-fee `cost=0` tetap idempoten) + `SpendQuotaMicro`.
- `backend/go/internal/proxy/lifecycle.go` — `buildRow`/`finish`: set bucket, basis, markup, `provider_cost_micro` (jadi `*int64`), `quota_usage_micro`, `cost`.
- `backend/go/internal/proxy/budget.go` — `checkBudgets`: resolve bucket + kuota frsubs + hard-stop saldo.

**Operasi / dokumen:**
- `ops/scrub-balance-anomaly.sql` — report read-only + perintah repair terkomentar.
- `docs/specs/2026-11-08-economic-layer-design.md` — desain final (rujukan).
- `docs/specs/2026-11-08-economic-layer-rollout.md` — file ini.

---

## Prefix publik ditunda

`/v1/models` publik (tanpa kunci) + `frcheap/` **tidak dibuka di rollout ini**
(K11). Dua alasan, keduanya dari desain §7:

1. **Drain tanpa kunci.** Mempublikasikan daftar model farm-backed lewat
   `/v1/models` tanpa auth sama dengan membocorkan daftar target pemakaian
   gratis; guard supply sudah jalan tanpa prefix lewat `provider_model_supply`
   di resolver.
2. **Harga yang tampil menyesatkan.** `pricing.input/output` yang dirender
   publik adalah harga **retail** metered, bukan penawaran flat-fee `frcheap`;
   klien akan mengira frcheap ditagih per token.

Bentuk saat nanti dibuka (F6): **satu prefix** `frcheap/<canonical-slug>`
(bukan katalog 3×). Syarat go/no-go K11: (a) ≥1 subscription `frcheap` aktif
terjual; (b) coverage `credential.acquisition='farmed'` ≥ X% dengan invalid
rate < 0,10; (c) circuit breaker `θ_rate_limited=0.02` terpasang. Tanpa ketiga
syarat itu prefix tetap off.

---

## Metrik go/no-go lanjutan (perlu diamati F1–F2)

- `charged > cost` harus **naik dari 0 hanya** di bucket/provider dengan COGS
  riil (markup di atas retail/alias = imajiner, invariant 1).
- `rate_limited` ratio < 0,02 (insiden 1 Nov: 170.556/172.541 tidak terulang).
- 0 baris `request_log` melanggar CHECK `request_log_markup_basis_check` /
  `request_log_farm_zero_check` (aritmetika markup & tiga-nilai `provider_cost`
  konsisten — inilah yang membuat uang tidak pernah float).