# Retrospective — Sprint-1 (team-driven product build, AI router)

> Ditulis oleh integration owner pasca eksekusi. Bukan plan; catatan deliverable + residu untuk sprint berikutnya.

## Proses yang dijalankan (sesuai goal: rencana matang → judge brutal → eksekusi)
1. **Discovery** — audit repo (HEAD, cabang, kerja tercecer). Ground truth: `local://fr-ground-truth.md`.
2. **PM master plan v1** → `docs/plans/fr-master-workstream.md` (13 kriteria → goal tree, kanban, persona, pain-tracing, backlog, sprint-1 4h, design direction).
3. **Judge brutal** (devil + pessimist, parallel) → keduanya REVISE. Devil judge bekerja di clone stale (`8b2f738`, 4 commit di belakang) — beberapa temple finding salah (netguard B1), mayoritas valid.
4. **Tech-lead adjudikasi** (APPROVE-v2-after-revision, 12 mandat) → PM revisi v2 (12/12) → **re-judge v2** (devil + pessimist, ACCEPT-v2) → approve.
5. **Sprint-1 eksekusi** (4 jam) dengan role agents: BE A (G6+T8), BE B (T9), QA (T5), DevOps (T11), Marketing (T13), BI (T12), FE (T2/T4).

## Deliverable + commit
| Task | Deliverable | Hasil |
|---|---|---|
| G6 (BE A) | `local://fr-s1-g6.md` | **MERAH** — sandbox Mayar credential absen; kode mati sampai G6 hijau. Binding (`create.transactionId == getTransaction(id).id` + amount IDR + status paid) BELUM terbukti live. |
| T8 (BE A) | middleware order fix | `c53e880` — enabledGate→ipLimit→raw body-parse; 8/8 route + 27/27 web test. |
| T5 (QA) | ADR settlement | `d4b315d` — hint-only no-auth, amplification, simulate-[UNVERIFIED]. |
| T9 (BE B) | claim path smoke | `dadc174` — status=claimed CAS 4/4, replay idempoten, no downgrade. |
| T11 (DevOps) | runbook operator | `local://fr-s1-t11.md` — env canon `FUDROUTER_BILLING_ENFORCE`, scrub+migrasi+flip G1-G5. |
| T13 (Marketing) | funnel | `local://fr-s1-t13.md` — funnel berhenti di pendaftaran (gate revenue belum terbuka). |
| T12 (BI) | revenue metrik v0 | `local://fr-s1-t12.md` — 2 sinyal + SQL + lokasi instrumentasi (payment-confirm.ts:186, grant.ts + subscription.go dua-write gap). |
| T2/T4 (FE) | checkout UX | `dcbc876` — render Mayar `checkoutUrl` vs legacy `qris`; harga 90000 (kode), a11y token orange. |

## Merge & gate (integration owner)
- `feat/mayar-gateway` → `feat/economic-layer` (merge `0460724`, non-ff, deklarasi G6-MERAH).
- contract regen 175→176 (route `/api/mayar/webhook`) → `822c8d8`.
- FE `dcbc876` → ff merge.
- Final HEAD `dcbc876`.
- **Gate hijau**: 235 test (platform+web) + 6 FE test; platform tsc + apps/web tsc clean; contract `extract-routes --check`/`gen-openapi-management --check` = 176 match.

## Residu / keluar sprint (untuk sprint berikutnya)
1. **G6 masih MERAH** — operator wajib jalankan probe sandbox Mayar (lihat `local://fr-s1-g6.md` runbook) sebelum gateway dapat disebut live.
2. **Prod flip BLOCKED-operator** — scrub 2 baris `5.55e18` + migrasi 0033–0039 (0036/0038 WAJIB) + env `FUDROUTER_BILLING_ENFORCE`/`*_APPROVER_USERS` + G1–G5. Runbook ready di `local://fr-s1-t11.md`.
3. **Price inconsistency** — plan §3 persona "100k/28d" vs kode `PLANS.sub_28d=90000` (`payments.ts:38`). FE + BI pakai 90000 (kode). Persona doc perlu patch.
4. **D-economics DEFERRED** — tetap di belakang sinyal revenue (belum terbuka; 0 confirmed / 0 subs aktif non-admin).
5. **`hack/s1-fe` branch housekeeping** — breng sudah merged (dcbc876), branch source masih ada (aman delete, atau simpan).
6. **Revenue instrumentation gap** — `payment_confirmed` (1 write point: payment-confirm.ts:186) + `subscription_active` (2 write points: TS grant.ts:150 + Go subscription.go:115-120) belum diinstrumentasi. T12 menandai lokasi; sprint berikutnya bila revenue gate dibuka.

## Target sprint-2 (draft — TIDAK dieksekusi tanpa judge brutal)
1. **G6 live probe** (operator) → GREEN → buka Mayar live (fail-open secara kontrol, bukan nol grant).
2. **Prod flip runbook eksekusi** (operator) — scrub + migrasi + env + G1–G5.
3. **Instrumentasi revenue-gate** (BI/BE) — `payment_confirmed`/`subscription_active` di 3 write-point.
4. **Bot → payment status timeline** — bot menulis `claimed`/`confirmed` end-to-end (smoke integration, bukan seam test).
5. **D-economics** — HANYA setelah revenue gate terbuka (≥1 confirmed / ≥1 subs non-admin).

## Verifikasi gate yang dijalankan (bukan diklaim)
```
node --test packages/platform/test/*.test.mjs apps/web/server/*.test.mjs  # 235 pass
node --test apps/web/src/lib/subscription-checkout.test.mjs               # 6 pass
packages/platform tsc --noEmit                                            # clean
apps/web tsc --noEmit                                                     # clean
packages/contracts extract-routes --check                                 # 176 OK
packages/contracts gen-openapi-management --check                         # 176 OK
```
