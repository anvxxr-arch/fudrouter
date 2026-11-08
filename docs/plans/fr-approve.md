# FR-APPROVE — Tech Lead verdict atas fr-revised.md

## 1. Verdict

**APPROVE (bersyarat satu amandemen wajib: task eskalasi approval harus ditambahkan ke §4 dan menjadi gate B4 sebelum §4 dieksekusi).**

---

## 2. Peta penutupan (temuan P0/P1 → status)

| Temuan (judge) | Status | Bukti dari `fr-revised.md` (diverifikasi ke repo `ssh://dwizzy/~/fudrouter`) |
|---|---|---|
| **S1 / P1.2** `reconcileAll` overflow | **DITUTUP** | §0: A2 = isolate-exclude (exclude total > int64, `status='quarantine'` + `alert_event`), bukan cast; §7 inv#4; A2 di-gate A1 (§4). Terverifikasi: `billing.ts:275` `coalesce(d.total,0)::bigint` memang meletus di 1.11e19 > int64; `scrub-balance-anomaly.sql` menyatakan cast hanya aman SETELAH baris korup di-null. Exclude via WHERE set-based menjaga atomic fleet-repair; isolasi quarantine + `checkBudgets` (`status != active → 402`, `budget.go`) mencegah saldo tak-habis (tak jadi lubang uang a la P1.2). |
| **S2** subscription-gate nol call-site | **DITUTUP** | §0 menambah task baru **B0** (wire `entitlement.CheckSubscription`/`LiveSubscription` ke admission), gate B4 = salah satu B0 (§4); inv#2: "sehat" = `live_subscription OR balance>threshold`. Terverifikasi: `guard.go:199-208` punya `CheckSubscription`/`Live` tapi `checkBudgets` (`budget.go`) hanya baca `acct.BalanceMicro`; B0lah yang menutup celah self-lockout. |
| **S3** grant tak tulis `economic_bucket` | **DITUTUP** | §0: grant writer (B2/B3) wajib set `economic_bucket='frsubs'`, acceptance "beli 7d → `BucketSubs` bukan `frpayg`"; inv#3. Terverifikasi: `resolveGrant` (`payments.ts`) hanya set `expiresAt`, `GrantSubscription` (`subscription.go`) tak set bucket; `subscription.economic_bucket` nullable (CHECK 0035 `IS NULL OR …`), precedence `ResolveBucket` jatuh ke `frpayg` bila tak ditulis. |
| **S4** inbound webhook dibangun dari nol | **DITUTUP (jujur)** | §0 pecah B3 → **B3a** (inbound receiver: HMAC verify + anti-replay + idempoten `gateway_ref` + SSRF-inbound, dibangun dari nol) + B3b (confirm→grant); estimasi usaha naik. Terverifikasi `webhooks.ts` murni outbound (`dispatchEvent`/`deliverWebhook`); tidak ada receiver inbound. Idempotensi didukung `payment_gateway_ref_uniq` (0025). |
| **S5** namespace idempotensi bentrok | **DITUTUP** | §0: placeholder lama di-rename `purchase:<uuid>` → `admin_credit:<uuid>` (migrasi data + writer); `purchase:<ref>` dicadangkan gateway. Terverifikasi `postLedger` `onConflictDoNothing(idempotency_key)` = silent-drop nyata tanpa rename. |
| **S6 / P1.4** kuota seed + overshoot konkuren | **DITUTUP (via defer)** | §0: "Kuota = meter (post-hoc), bukan pagar — jujur"; D4 deferred sampai ada subscriber frsubs; kalibrasi + fix 5h window sebelum live. §1 defer D1–D5 dengan gate "sinyal revenue ≥1". Terverifikasi `quotaIncomingMicro` dipaku 0 (`lifecycle.go`) dan dray hanya `used`; defer menghapus risiko dari jalur walking-skeleton (kuota dormant saat 0 subscriber frsubs). |
| **S7** "adapter bot tipis" salah | **DITUTUP** | §0: C1/C2 bergantung B2/B3 (handler claim/grant/publish dibangun dulu sebagai shared-TS), adapter hanya panggil handler. |
| **S8** RICE quick-win tanpa gate | **DITUTUP** | §0 + §4: backlog ditulis ulang dengan kolom **gate prasyarat**; kanban §5 tambah kolom **Blocked**. |
| **S9 / P1.3** SPOF satu admin | **SEBAGIAN** | §0: "B4 ditunda sampai eskalasi approval diputuskan"; §2 persona: "secondary approver via env (bukan hardcode)"; §3: "eskalasi = prasyarat flip". **Tetapi** §4 backlog (§4 no task) TIDAK memuat task eskalasi yang deliverable, dan gate B4 di §4 (§0 kolom) tidak mencantumkannya. Mitigasi dinyatakan, belum terjadwal — setengah terkirim (instance subscription-aware sudah via B0; instance admin-fallback belum punya task/DoD). |
| **P1.1** scrub read-only, DELETE tanpa rollback | **DITUTUP** | §0: A1 = scrub eksekutif (bukan read-only) + snapshot pre-image `credit_ledger` untuk undo + repair idempoten (`UPDATE amount=0` ber-description provenance, bukan DELETE). Terverifikasi `scrub-balance-anomaly.sql` sudah menyediakan template `UPDATE` re-run-safe; A1 menambahkan snapshot pre-image sebagai undo. |
| **P1.5** clock-skew 5h antar replika | **DITUTUP (via defer)** | §0: D4 deferred; saat live, period key pakai blok UTC fixed (bukan `Truncate`), pin test read/write beda replika. |
| **P1.6** D1+D3 insert-check-violation | **DITUTUP (via defer)** | §0: D3 (markup>1.0) wajib didahului D2 backfill + runtime guard assert `cost_basis`/`markup` konsisten (fail request, bukan fail ledger); deferred bersama D-economics. |
| **P1.7** over-engineering 16 task/28h | **DITUTUP** | §1 rescope besar → walking-skeleton (A/B/C/E + flip), D1–D5 defer sampai sinyal revenue. Rescope TIDAK mengecilkan objective #9/#10 (lihat §terpisah di bawah). |
| **P1.8** rollback langkah uang | **DITUTUP** | §0: tiap langkah uang punya pre-image/undo; flip jadi runtime feature-flag (env), revert = restart/flag bukan rebuild. inv#5. |
| **P1.9** DoD bot tak terukur | **DITUTUP** | §0 + §6 S4: DoD = "`payment.status='confirmed' AND channel='telegram'\|'discord'` > 0 dalam 48 jam". |
| **P1.10** threshold $1M buta drift kecil | **DITUTUP** | §0: REPORT scrub menampilkan semua `drift_micro != 0`, bukan hanya out-of-range. |

---

## 3. Defect tersisa (jujur)

**Satu, terukur, wajib ditutup sebelum B4:** *eskalasi approval (secondary approver) dinyatakan (§2, §3) tapi tidak punya task/DoD/gate di §4*. Konsekuensi: mitigasi self-lockout S9/P1.3 baru setengah — B0 menutup sisi "live-subscription lolos", tapi sisi "admin offline → ada fallback" tidak terjadwal sehingga bisa lolos tanpa deliverable.

Wajib ditambahkan ke `fr-revised.md` §4 (satu baris) dan ke gate B4:

> **B5 — eskalasi/fallback approval**: `≥2 approver dikonfigurasi via env` (bukan hardcode `@zupaxx`); eskalasi ke approver cadangan saat primary tak merespons dalam ttl; DoD = approval queue terproses saat primary offline (test terinjeksi). Gate B4 kini: `A1,A2,A3,B0,B3b,C1/C2,E2,B5`.

Amandemen non-aristektural: sisanya tidak ada temuan yang masih TERBUKA.

**Catatan periferal (bukan pengerem):** (a) A3 perlu memastikan migrasi namespace juga merename idempotency_key baris lama yang sudah di-null A1 (bebaskan namespace `purchase:` seluruhnya); (b) `FreeAccessNoPaymentGateway` yang dijadikan env/feature-flag pada B4 tetap butuh *restart* biner Go (bukan hot-reload) — tetap murah vs rebuild, tapi runbook E2 harus menuliskan batas "downtime restart" secara eksplisit.

---

## 4. Persetujuan eksekusi (urutan boleh mulai SEKARANG)

Reviewer: **TL** = Tech Lead (arsitektur/invariant); **Q** = QA/DevilAdvocate (langkah uang & idempotensi).

1. **A1** scrub eksekutif (staging→prod, pre-image+undo) — reviewer: TL + Q
2. **A2** reconcileAll isolate-exclude (gate A1) — TL
3. **A3** ceiling add-credit (>1e12 ditolak) + rename `admin_credit:` (gate A1) — TL + Q (idempotensi)
4. **B0** wire `entitlement` → admission (gate A2) — TL
5. **B1** gateway interface + ADR-0008 — TL
6. **B2** grant writer (+ wajib `economic_bucket='frsubs'`) (gate B1) — TL + Q
7. **B3a** inbound webhook (ganti "pola deliverWebhook") (gate B1) — TL + Q (HMAC/replay/SSRF)
8. **B3b** confirm→grant loop (gate B2+B3a) — TL + Q
9. **C1/C2** adapter tele/discord (gate B2+B3b), DoD 48h confirmed>0 — TL
10. **E1 + E2** ADR gateway + runbook flip/revert (gate B1 / B0+B3b) — TL + Q
11. **B5** eskalasi/fallback approval *(amandemen §3 di atas)* — TL + Q
12. **B4** flip feature-flag + smoke (gate A1,A2,A3,B0,B3b,C1/C2,E2,**B5**) — TL + Q/DevilAdvocate final

## 5. Gate yang menahan (BLOCKED)

| Task | Tertahan oleh (prasyarat terukur) |
|---|---|
| **B4 flip** | A1,A2,A3,B0,B3b,C1/C2,E2,**B5** belum hijau; definisi "sehat" (inv#2) diuji; feature-flag terpasang; rever-runbook E2 siap. |
| **D1..D5** (aktivasi economic layer) | Sinyal revenue: `≥1 payment.status='confirmed'` pelanggan nyata ATAU `≥1 subscription` aktif non-admin. Sebelum itu tetap dormant (inv#6). |
| **B3b** | B2 (grant writer) + B3a (inbound receiver). |
| **C1/C2** | B2 + B3b (handler claim/grant/publish shared-TS). |
| **B0** | A2 (reconcile isolate-exclude). |

---

## Bukti baca (verifikasi repo, HEAD f718087, branch feat/economic-layer)
- `packages/platform/server/billing.ts` — `reconcileAll` `coalesce(d.total,0)::bigint` (baris ~275).
- `ops/scrub-balance-anomaly.sql` — READ-ONLY; repair `UPDATE amount=0` commented; menyatakan `::bigint` aman hanya setelah baris korup di-null; threshold `1e12` vs 2×5.55e18 = 1.11e19 > int64 (9.22e18).
- `backend/go/internal/proxy/budget.go` — `checkBudgets` gate hanya `BalanceMicro <= HardStopThresholdMicro`, `Status != active → ErrInsufficientCredits`.
- `backend/go/internal/entitlement/guard.go` — `CheckSubscription`/`Live` ada, nol call-site di hot path.
- `backend/go/internal/store/subscription.go` — `GrantSubscription` tak set `economic_bucket`; `ResolveBucket` precedence live-sub → api_key → billing_account → `frpayg`.
- `packages/platform/server/payments.ts` — `resolveGrant` hanya `expiresAt`; `webhooks.ts` outbound-only.
- `backend/go/migrations/0025_subscription_platform.sql` — `payment.gateway_ref` UNIQUE (idempoten); `backend/go/migrations/0035_economic_enforce.sql` — `subscription.economic_bucket` nullable (`IS NULL OR IN(…)`).