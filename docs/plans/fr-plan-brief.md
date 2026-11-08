# GROUND TRUTH — fudrouter (AI router) state snapshot 2026-11-09

Repo: homeserver `dwizzy`, path `~/fudrouter`, branch `feat/economic-layer` (HEAD f718087). Ini produk yang SUDAH ada; rencana harus membangun di atasnya, tidak menulis ulang (kriteria #4: tidak redundant).

## Sudah ada & terverifikasi
- **Data plane** Go (`backend/go`, :8100): `/v1/chat/completions`, `/v1/messages`, `/v1/responses`, `/v1/embeddings`, `/v1/images`, `/v1/videos`, `/v1/models`, `/v1/models/{slug}`. Routing multi-provider dengan strategi (`routing/select.go`: balanced/lowest_cost/lowest_latency/highest_reliability/weighted/round_robin/random/smart), circuit breaker, failover, health probe per-family.
- **Control plane** React+Express (`apps/web`): auth, admin, billing, playground, pricing, dashboard, admin. Design system + tokens di `design-system/fudrouter/MASTER.md`, `DESIGN.md`. Audit **100/100** (`docs/audit/SCORE.md`, 28 findings fixed).
- **Billing/ledger** integer `math/big` no-float (`cost/cost.go`), `credit_ledger` + `billing_account.balance_micro` (cache, reconcilable), idempotency `usage:<id>`.
- **Entitlement** (`entitlement/guard.go`): 1 key/member, 3 IP, 5 concurrency, subscription window. Cache 60s, O(1) habitat.
- **Economic layer** (branch ini, commit da5e8f2): 3 bucket frcheap/frpayg/frsubs, `provider_cost_micro` tre-nilai, `bucket_margin`, `bucket_quota`, migrasi 0033/0034/0035 (0035 gated). Belum aktif di produksi; `provider_cost_rule` belum di-backfill.
- **Farming** `farmpolicy` (manual-trigger by design) + 26k credential.
- **Bots core** `packages/platform/server/bots.ts` (147 ln, murni/unit-testable) + adapter `apps/web/server/lib/discord.mjs` (55 ln). **Telegram adapter TIDAK ada**.
- **Payments** `payments.ts` (QRIS dinamis payload, `verssache/qris-dinamis`), `webhooks.ts`, `billing.ts`. Pembayaran manual QRIS + verifikasi admin via bot. **Belum ada gateway otomatis; `FreeAccessNoPaymentGateway=true`** (`store/limits.go:81`) jadi balance gate nonaktif.
- **Docs**: `docs/specs/*` (9 file), `docs/audit/*` (12 kategori), `docs/decisions/` ADR 0001–0007, `docs/architecture/`, `docs/plans/`, `docs/changelog/`.

## Gap yang DIKETAHUI (dari F1 forensik 2026-11-09)
1. `credit_ledger` 2 baris `credit_purchase` korup `5555555555555000000` µUSD (input placeholder admin via `apps/web/server/pages.mjs` add-credit, tanpa ceiling). Balance benar = 432.211.272.800 µUSD. Scrub ada: `ops/scrub-balance-anomaly.sql` + `docs/specs/2026-11-08-F1-balance-runbook.md` (perbaikan produksi = langkah manual operator).
2. `reconcileAll` (`billing.ts`) tidak tahan `bigint` overflow (>int64) → satu akun menggagalkan seluruh job aggregation.
3. Tidak ada writer `credit_purchase` produksi — tanpa jalur top-up nyata, flip `FreeAccessNoPaymentGateway=false` memblokir semua akun saat saldo abis.
4. Siklus `payment → credit_purchase → balance_micro` belum tertutup; tabel `payment` 0 baris.
5. Telegram bot adapter belum dibangun.
6. `pages.mjs` add-credit tanpa ceiling/guard.

## 13 kriteria objective (acuan)
1 kode rapi · 2 terstruktur · 3 app ringan · 4 tidak redundant · 5 terdokumentasi · 6 tidak ada bug · 7 cepat · 8 routing baik · 9 payment gateway fast · 10 telegram & discord bot untuk payment+info · 11 secure · 12 best practices industri · 13 tujuan lainnya.

## Tim (roster)
PM → [2 backend, 1 frontend, 1 QA, 1 devops, 1 marketing, 1 BI] → Tech Lead (approve/disapprove). Plus Devil Advocate + Pessimist untuk judge brutal.

## HARD GATE (penting)
JANGAN tulis/ubah kode apa pun sebelum rencana matang dibuat DAN di-judge brutal oleh devil advocate & pesimist. Fase ini output = rencana (breakdown, kanban, persona, pain point, backlog, sprint 4 jam, diagram), bukan implementasi.

## Keluaran fase perencanaan (sesuai workflow user)
1. Goals → subgoals → objektif → task (breakdown).
2. Kanban board delegasi.
3. User persona.
4. Pain point → masalah sebenarnya → fitur → validasi ("apakah kalau ini diatasi tidak ada masalah lain?").
5. Backlog prioritized → sprint plan timeline 4 jam → review/retrospective → loop.