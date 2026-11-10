# Sprint-2 prep — merge, security, cleanup (pre-sprint-2 gate)

> Ditulis oleh integration owner pasca eksekusi. Catatan keputusan + residual untuk agents berikutnya.

## Security audit (dijalankan DULU, sebelum merge/cleanup)
Verdict **SECRET-CLEAN** (tracked tree): 0 `.env`/pem/private-key/JWT di source ter-commit. Laporan lengkap: `local://fr-s2-security-audit.md`.

- No P0/P1. Tiga P2 + satu hygiene: (P2-1) `admin.mjs` testModel/chat bare-fetch → DNS-rebind pin gap; (P2-2) `/api/webhook/payment` + `/api/discord/interactions` tanpa IP rate-limit; (P2-3) `extract-routes.mjs` regex miss array-form → `routes.json` under-count.
- **JWT `conn_zai` (iat 2026-11-08)** ditemukan dalam git object store via **stash commit** `aa06092` (untracked-files stash; TIDAK reachable dari branch atau remote; `git branch --contains` kosong, `ls-remote` 0). File live `ops/zcode-bridge/accounts.jsonl` juga ada di worktree (gitignored). **Rotasi operator wajib** sebelum go-live (lihat residual).

## Merge (semua cabang outstanding")
- **MERGED**: `hack/uxia` (`cb1df92`, hapus member self-credit form W4/W5) → `31d6881`; `fix/a11y-scroll-regions` (`ee408cd`, scrollport keyboard 15→0) → `6ad2da4`.
- **CONTENT-SUDAda di tip (bukan pending)**: `hack/netsec` (undici pin + literalOrNull + 72-line test semua sudah di tip), `hack/be-routercore` (acc8935), `hack/fe-motion`/`hack/designsys`/`hack/be-*` (merged Sprint-1).
- **ARCHIVED (bukan pending)**: `fudrouter-opt` (path `services/router/*`/`apps/react-web/*` sudah di-restructure ke `backend/go`/`apps/web` — stale), `migration/green-tailwind` (TL decision: satu sistem warna, orange `DESIGN.md` = source of truth), `hack/netsec` + `hack/be-routercore` (content sudh di tip). Semua di-tag `archived/*` + didokumentasikan di sini.
- `feat/mayar-gateway` sudah merged Sprint-1 (`0460724`).

## Security fixes (commit `a140215`, merged ff)
- P2-1: `testModel`/`chat` → `guardedUpstreamFetch` (pin validated IPs, tutup DNS-rebind).
- P2-2: `ipLimit` (120/min, clientIp) sebelum `express.raw` di kedua webhook surface.
- P2-3: `extract-routes.mjs` `RE_ROUTE_ARRAY` parse array-form → regen contract. **COUNT 176 → 226** (koreksi under-count; route array subscription/billing/keys/usage yang selama ini tersembunyi kini tercatat).
- DEL-1: hapus dead bridge `confirmPayment` + tipe mati + blok test (0 production importer; produksi pakai `confirmAndGrant`).

## Cleanup (hapus file/script/logic membingungkan)
- Untracked junk dihapus: `.env.console.bak-prehack`, `backend/go/internal/store/store.go.orig`, `apps/web/tsconfig.tsbuildinfo`, `scratch/` (kosong).
- Branch ter-merge dihapus: `hack/s2-harden`.
- Branch stale/dup di-tag `archived/*` (preserve history, mark disposition).
- `payment-confirm.mjs` (W8) diverifikasi benar-benar hilang.

## Gate akhir
235 test pass (platform 202 + web 27 + FE 6), platform/web tsc clean, contract `--check` 226 match (15 inference + 226 management), go vet clean, worktree clean. HEAD `a140215` di `feat/economic-layer`.

## Residual untuk agents berikutnya (sprint-2)
1. **Rotasi JWT `conn_zai` + `businessAccessToken`** di sisi zcode (live di stash `aa06092` + worktree `ops/zcode-bridge/accounts.jsonl`). Operator.
2. **G6 sandbox probe Mayar** masih MERAH (kredensial sandbox absen) — `local://fr-s1-g6.md`.
3. **Prod flip** (scrub 2 baris `5.55e18` + migrasi 0033–0039 + env + G1–G5) — `local://fr-s1-t11.md`.
4. **Revenue instrumentation** (`payment_confirmed`/`subscription_active` 0-match) — `local://fr-s1-t12.md`.
5. **D-economics** tetap DEFERRED (gate = sinyal revenue).
