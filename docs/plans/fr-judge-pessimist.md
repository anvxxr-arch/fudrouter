# FR-JUDGE-PESSIMIST — fudrouter fase perencanaan (stress-test terburuk)

Peran: PESSIMIST. Target: `fr-plan-brief.md` + `fr-plan-pm.md` + `fr-plan-tl.md`.
Verifikasi langsung ke repo `ssh://dwizzy/~/fudrouter` (HEAD `f718087`, branch `feat/economic-layer`). Semua klaim dirujuk `file:line` yang dibaca sendiri.

> Angka yang dipakai sebagai pijakan proporsi: revenue **$12.15/bln**, **4 user aktif**, **0 subscription**, `payment` table 0 baris, `provider_cost_rule` 0 baris, 728 mapping butuh COGS, request_log 549.869 baris.

---

## 1. Serangan (≥8, paling fatal dulu)

### 1.1 A1 "scrub" adalah SELECT read-only; "eksekusi" asli = DELETE manual yang tidak punya rollback → DoD "idempoten 2×" kosong

**Bukti.** `ops/scrub-balance-anomaly.sql` header tertulis eksplisit: *"READ-ONLY. Every statement below produces a SELECT report. The repair commands are present but COMMENTED OUT: an operator must review the report, run the fixes by hand..."*. Akun korup `bac_wrk_usr_VjOnC8IZktzGBVXBagJkGJPEhoocKe5L` punya **2 baris** `credit_purchase` senilai `5.55e18`, DAN cache `balance_micro` sudah drift satu posting di belakang ledger (`5555555987766272800` = clean sum `432211272800` + tepat satu posting korup).

**Kenapa fatal.** Rencana menulis A1 = *"SUDAH ADA — verifikasi/eksekusi saja: scrub 2 baris... idempoten 2×, hingga G1–G5 hijau"*. Padahal *menjalankan* file SQL itu tidak mengubah apa-apa (selalu 0 baris berubah, karena semuanya SELECT). Jadi "scrub 2× = 0 baris berubah" (DoD sprint 1.1) terpenuhi oleh operasi kosong — ia **tidak membuktikan korupsi hilang**, tidak menghapus 2 baris mana pun. Perbaikan asli adalah operator mengetik `DELETE` manual terhadap daftar akun yang sudah direview; itu adalah mutasi data yang:

- **tidak idempoten secara nyata** (DELETE yang salah-ulang menghapus baris berbeda),
- **tidak punya rollback** (writer yang membentuk baris itu sudah hilang; baris `credit_purchase` yang dihapus tak bisa dikembalikan persis),
- dan berinteraksi dengan `reconcileAll`: jika operator menghapus *satu* dari dua baris lalu menjalankan reconcile sebelum menghapus kedua, cache malah di-*re-derive* ke sum yang masih-mengandung-satu-korupsi, memperlama drift (diakui di runbook: "reconcileAll ... MUST NOT run before the balance-anomaly scrub").

Tidak ada `ops/rollback/` untuk scrub data ini — `ops/rollback/` hanya berisi `0030..0035` (skema). Langkah pertama dalam rantai uang yang paling tinggi risikonya justru yang paling manual dan paling ireversibel.

### 1.2 A2 "reconcileAll overflow" punya dua resep yang saling eksklusif; cabang "skip akun" meninggalkan cache korup = saldo tak-habis pasca-flip

**Bukti.** `packages/platform/server/billing.ts:275` memang `coalesce(d.total,0)::bigint`, dan sum akun korup `1.11e19` melampaui int64 (`9.22e18`) sehingga seluruh job `billing_aggregation` gagal. Rencana A2 menawarkan dua alternatif dalam satu sel: *"`numeric(40,0)` guard* **atau** *tangkap-error-lanjut-akun"*.

**Kenapa fatal.** Dua alternatif itu bukan ekivalen. "Tangkap-error-lanjut-akun" (skip akun yang overflow) berarti baris `billing_account` korup **tidak pernah di-`UPDATE`**, jadi `balance_micro` tetap `5555555987766272800` selamanya. Setelah B4 (`FreeAccessNoPaymentGateway=false`), gerbang admission (`backend/go/internal/proxy/budget.go:63`) membaca `acct.BalanceMicro` dan `HardStopThresholdMicro`; dengan saldo `>5.55e18`, hard-stop **tidak akan pernah tercapai** → akun benchmark itu jadi credit/token gratis tak terbatas. "Skip silently" = mengubah bug overflow menjadi lubang uang permanen. Yang benar: sum di `numeric`, lalu **paksa repair cache ke clean sum** (atau tandai akun `status != active`), bukan melewatinya diam-diam. Rencana tidak memutuskan mana yang dipilih — dan ini keputusan yang menyentuh uang.

### 1.3 B4 flip hanya menyalakan *enforcement*; top-up tetap manual QRIS + verifikasi satu admin → anggota yang habis saldo = deadlock, dan ini yang akan terjadi pada 4 user aktif

**Bukti.** `packages/platform/server/payments.ts` berheader *"MANUAL — a QRIS dynamic payment that an operator confirms"*, `FreeAccessNoPaymentGateway=true` (`backend/go/internal/store/limits.go:81`), dan `resolveGrant` hanya menerima `status === 'confirmed'`. Sementara `apps/web/server/pages.mjs:659-660` menulis payment `status='pending'`, lalu claim di :678 menulis `'claimed'` — **tidak ada satu pun yang menulis `'confirmed'` hari ini**. Tidak ada gateway otomatis (brief: "Belum ada gateway otomatis"; `payment` 0 baris). B3 harus *membangun* jalur confirm itu, dan confirm-nya tetap operator manusia (anti-fraud screenshot), lewat bot yang belum ada (C1/C2).

**Kenapa fatal.** Flip bukan "payment jadi otomatis"; flip hanya menyalakan `402 INSUFFICIENT_CREDITS`. Dengan top-up satu-satunya = QRIS manual + tombol approve satu admin `@zupaxx` (SPOF yang diakui rencana §5), setiap anggota yang saldonya menyentuh hard-stop langsung berhenti bekerja sampai satu admin online dan memverifikasi bukti. Pada skala nyata (4 user aktif, saldo clean terbesar `$432`), saldo akan habis dalam hitungan hari–minggu pemakaian AI, dan tidak ada auto-isi ulang. Rencana **honest menyebut SPOF ini** tetapi tetap memilih membalik flag di sprint 7 — tanpa menyelesaikan eskalasi/fallback admin. Ini menukar "semua gratisan" jadi "semua terkunci oleh antrean manual".

### 1.4 D4 kuota frsubs 5h/7d bukan *pre-flight* cap — `quotaIncomingMicro` dipaku 0 → burst konkuren bisa overshoot N× tanpa ditahan

**Bukti.** `backend/go/internal/proxy/lifecycle.go:99-107`: *"quotaIncomingMicro ... is 0 at admission: usage is only known after the upstream answers... the pre-flight gate checks the durable used sum alone"*. Di `budget.go:430` gate hanya menghitung `used + incoming` dengan `incoming := lc.quotaIncomingMicro` yang selalu 0. Artinya pada admission yang diperiksa hanya `SpendQuotaMicro` historis (already-spent), bukan request yang sedang berjalan.

**Kenapa fatal.** Momen antara check dan tulis (finish → `quotaSpendAdd`, `budget.go:467-473`) membuka jendela: N request frsubs paralel semuanya masuk saat `used` masih statis, semuanya lolos gate, semuanya kemudian menulis meter. Overshoot = `N × retail` dalam satu instan, melampaui batas 5h/7d yang dimaksud sebagai stop-loss fair-use. DoD sprint 5.1 (*"counter-miss → DB fail-closed teruji"*) hanya menguji fallback durable, **tidak** menguji overshoot konkurensi karena `incoming` memang 0. Ini berarti "kuota live" sesungguhnya adalah meter post-hoc, bukan pagar — dan saat seseorang mau meng-arbitrage langganan flat via konkurensi, pagarnya bergeser satu request kemudian.

### 1.5 Jendela rolling "5h" salah-sejajar dan rentan clock-skew; harganya adalah silent miss antar counter → Postgres per-request (langgar K7) atau under-count

**Bukti.** `budget.go:510-520` `quotaPeriodTTL`: `now.Truncate(5*time.Hour)` — Go `Truncate` membulatkan ke kelipatan d **sejak zero-time** (0001-01-01), bukan sejak UTC-midnight, sedangkan komentar di kode mengklaim *"5h blocks at 00:00, 05:00, ... UTC"*. Karena `24 mod 5 = 4`, blok 5h **hanyut** relatif tengah-malam tiap hari. Kontrak kode sendiri (komentar `budget.go:395`) menyebut *"spell the SAME key or every write silently misses every read"*.

**Kenapa fatal.** Dengan lebih dari satu replika Go di belakang load balancer (atau sekadar beda beberapa detik `now` antara admission dan finish), reader dan writer di sisi boundary window bisa membaca `periodKey` yang berbeda → counter miss. Konsekuensi miss bukan "aman", tapi (sesuai komentar) jatuh ke `SpendQuotaMicro` = **satu Postgres round-trip ekstra per request** — persis pelanggaran K7 yang rencana klaim sudah nol. Lebih buruk, pada kasus read-write beda periode, meter under-count dan quota dieksploitasi lebih mudah. Rencana tidak menyebut sinkronisasi jam multi-replika sama sekali.

### 1.6 D1 buka gate 0035 + D3 markup >1.0 = kandidat *insert-check-violation* pada hot path `usage_charge` → request dijawab 200 tapi tak tertagih

**Bukti.** `0035_economic_enforce.sql` menambahkan `request_log_markup_basis_check`: `markup_millionths <= 1000000 OR (billing_basis='provider' AND cost_basis='provider' AND provider_cost_micro IS NOT NULL AND ... cost = (provider_cost_micro*markup+500000)/1000000)`. Saat ini writer emit `billing_basis='retail', markup=1_000_000` → lolos cabang `<= 1000000`. Begitu D3 mengaktifkan `markup > 1e6` untuk baris yang `cost_basis`-nya masih `'retail'` (karena backfill D2 belum menyentuh provider itu), CHECK jadi FALSE/`check_violation`, dan `ChargeRequest` di `finish()` gagal — termasuk fallback-nya, karena fallback menulis baris yang sama ke tabel yang sama di bawah constraint yang sama.

**Kenapa fatal.** Kegagalan itu terjadi **setelah** 200 dikirim ke klien (finish menulis ledger *post*-response). Akibat: request jalan normal tetapi `usage_charge` tak pernah tercatat → revenue hilang diam-diam, `balance_micro` tak terdebit, dan tidak ada alert. DoD sprint 6.1 (*"0 violation `markup_basis_check`"*) adalah sinyal CI terhadap baris test, **bukan** penjaga runtime di jalur charge. Ini kasus lintas-batas: consumer-nya adalah DB constraint yang baru aktif setelah D1, dan producer-nya adalah D3 — gagal di satu sisi diam-diam mematikan pendapatan di sisi lain.

### 1.7 Over-engineering terukur: 16 task / 7 sprint (≥28 jam kerja) + backfill tanpa batas untuk 4 user / $12.15 / 0 subscription — proporsi tidak lulus akal

**Bukti.** Ground truth brief mencatat revenue **$12.15/bln**, **4 active**, **0 subscription**. Rencana menjadwalkan 16 task dalam 7 sprint 4-jam. Sebagian besar task (D2 backfill 728→top-N, D3 markup, D4 kuota, D5 prefix, E1 ADR, E2 runbook) tidak menambah satu sen pun sampai B4 dibalik; dan bahkan setelah dibalik, pemasukan tetap item QRIS manual.

**Kenapa ini serangan, bukan sekadar catatan.** Yang berubah-uang hanyalah rantai `A1→A2→A3→B2→B4` (plus jalur confirm B3). Ekonomi-layer (D1–D5) adalah investasi *keakuratan margin* yang ongkosnya (entry data COGS nyata per provider, tidak ada sumber data siap, tidak ada owner) jauh melampaui nilai margin yang bisa dihasilkan skala saat ini. Menunda D5 saja tidak cukup; rantai D2→D3 bisa memakan waktu orang-minggu untuk mengejar "margin jujur" atas revenue $12/bln. Ini bukan mengecilkan produk, ini menantang proporsi: rencana membangun infrastruktur margin kelas enterprise di atas dasar user yang belum divalidasi membayar sama sekali.

### 1.8 Tidak ada jalur mundur untuk langkah yang menyentuh uang (scrub DELETE, webhook B2/B3, flip B4) — hanya 0033–0035 yang punya rollback

**Bukti.** `ops/rollback/` berisi `0030..0035` (semua skema). Tidak ada rollback untuk: (a) `DELETE` ledger scrub (data irreversibel, §1.1); (b) webhook/confirm B3 yang sudah ter-deploy menerima pembayaran hidup — tidak bisa "di-un-deploy" bersih saat ada pembayaran in-flight tanpa risiko double-grant/missed-grant; (c) B4 flip adalah `var FreeAccessNoPaymentGateway = true` (satu baris, `limits.go:81`) yang butuh **rebuild + deploy binary Go** untuk dibalik — bukan runtime flag, bukan feature-flag.

**Kenapa fatal.** Tidak ada definisi metrik ambang "flip ternyata salah → revert". Jika setelah flip ternyata semua user terkunci (misal writer `credit_purchase` gagal di produksi), rollback = build baru + deploy ulang dengan latensi deploy penuh, sementara 402 memblokir seluruh permukaan inference. Rencana punya runbook *go/no-go* flip tapi tidak punya runbook *who/which-metric/within-how-long* untuk revert.

### 1.9 Keterlacakan "done" bot (C1/C2) tidak terukur — lulus 4-case test ≠ ada pembayaran lewat bot

**Bukti.** DoD sprint 4.1: *"Kedua adapter reuse bots.ts (0 duplikasi); 4-case test per adapter; pesan harga identik antar channel"*. Seluruhnya sinyal struktural, nol metrik hasil.

**Kenapa fatal.** Sebuah bot bisa lolos 4 unit test dan tetap tak pernah mengonversi satu pembayaran pun (payload QRIS salah-render di lapangan, webhook Telegram tak ter-register, alignment command salah platform). Kriteria #10 ("telegram & discord bot utk payment+info") selesainya = ada *payment.status='confirmed'* ber-`channel='telegram'|'discord'` > 0 dalam N hari pasca-deploy — metrik yang bisa diukur dan belum tertulis di manapun.

### 1.10 Scrub threshold $1M bisa membutakan barang-rongsokan lain; "2 baris korup" adalah temuan, bukan batas atas

**Bukti.** `scrub-balance-anomaly.sql` memakai threshold *"lebih dari $1M (1e12 µUSD)"*, dan REPORT 1 seharusnya menampilkan semua akun dengan drift/out-of-range. Tapi fokus DoD sprint 1.1 hanya *"REPORT 1&2 = 0 baris"*.

**Kenapa fatal.** Jika setelah DELETE dua baris 5.55e18 itu REPORT 1 masih menampilkan akun lain dengan drift kecil (korupsi placeholder lain yang di bawah 1e12, atau entri `adjustment` yang salah nilai tapi tak melewati ambang), "0 baris" tak akan tercapai *atau* — lebih buruk — dipaksa tercapai dengan menaikkan threshold. Rencana tidak menetapkan apa arti "REPORT kosong" ketika akun ber-`drift_micro` kecil (cache under-report, disebut "real, but still a cache bug" di script) justru sah untuk diperbaiki juga. Ini celah keputusan yang bisa menunda flip tanpa batas atau menyembunyikan akun cacat.

---

## 2. Asumsi berbahaya

| Asumsi tersirat | Sinyal bahwa ia salah | Siapkan bila benar |
|---|---|---|
| Data COGS nyata (`invoice`/`declared`) untuk top-N provider bisa dikumpulkan cepat; backfill D2 = task 4 jam. | `provider_cost_rule` 0 baris; tidak ada script backfill; `source` butuh invoice vendor/declared pricing yang belum tersedia di repo. | Backfill adalah entri-data berkelanjutan dengan owner + deadline, bukan task sekali. Siapkan keputusan "markup tetap 1.0 (passthrough) sampai %X" sebagai status terminal yang sah, bukan kegagalan. |
| Satu admin (SPOF) cukup selama dan setelah flip. | `bots.ts` bind ke satu approve; tidak ada eskalasi; rencana sendiri mengakui SPOF di §5. | Tetapkan admin fallback + antrean eskalasi sebelum B4, bukan sesudah. Kalau tidak, flip = lockout kolektif saat admin offline. |
| Router Go berjalan satu replika (tidak ada clock-skew antar instans). | Kontrak period-key di `budget.go` sangat fragile terhadap miss; alur `quotaPeriod` bergantung `time.Now()` lokal. | Tentukan NTP/sinkronisasi jam dan uji boundary-window antar replika sebelum D4 "live". |
| Korupsi hanya 2 baris / 1 akun. | Scrub adalah read-only; REPORT 1 belum dijalankan di staging pada saat rencana ditulis. | Anggap daftar akun korup = output REVIEW, bukan konstanta 1. Scope A1 bisa tumbuh. |
| Jalur penulis `status='confirmed'` sepele / sudah ada. | `pages.mjs` hanya menulis `pending`/`claimed`; `resolveGrant` butuh `confirmed`; tidak ada endpoint confirm hari ini (B3 harus membangunnya). | Jika B3 tertunda, B4 tertunda; seluruh "loop uang" bergantung pada sesuatu yang belum ada bentuknya, bukan sekadar "menyambung". |
| Skala saat ini membenarkan kekakuan ekonomi-layer penuh. | 0 subscription, revenue flat $12/bln, D5 sengaja ditunda, frcheap belum laku. | Restruktur scope: kirim walking-skeleton (A→B2→B4) dulu; tunda D-economics sampai ada pelanggan membayar yang membenarkan biaya pengukuran margin. |

---

## 3. Keputusan yang kurang (harus diputus sebelum eksekusi)

1. **Strategi reconcileAll A2** — `numeric` + paksa-repair cache, atau skip akun? Skip = meninggalkan saldo tak-habis (§1.2). Harus dipilih satu, dan yang "skip" ditolak.
2. **Backfill D2** — siapa owner-nya, sumber data COGS-nya (invoice vs declared), definisi "top-N provider aktif", dan **deadline jika 80% tak tercapai** (apakah markup=1.0 selamanya diterima?).
3. **Revert flip B4** — metrik ambang apa yang memicu revert, siapa yang boleh memicu, dan apakah `FreeAccessNoPaymentGateway` diubah jadi runtime/feature-flag (bukan compile var + rebuild Go).
4. **Fallback approval bot** — siapa admin pengganti `@zupaxx`, dan jalur eskalasi saat admin offline (SPOF yang diakui tapi tidak diputus).
5. **Model langganan saat flip** — flip sekaligus tiga bucket (frcheap/frpayg/frsus) atau bertahap dimulai frsubs (flat, paling sederhana)? Saat ini rencana membalik semua.
6. **Korekness quota** — terima overshoot post-hoc (kuota = meter) atau wajib pre-flight estimate (isi `quotaIncomingMicro`)? Ini mengubah arti "live" D4.
7. **Definisi selesai ekonomi-layer** — apakah "passthrough markup 1.0 + COGS riil menyusul" adalah state selesai yang sah, atau harus markup>1.0 untuk dianggap menghidupkan ekonomi? (DoD sprint 5.1/6.1 saat ini membiarkan keduanya "hijau".)
8. **Arti "REPORT kosong" scrub** — apakah drift-kecil (bukan overflow) juga harus nol, atau threshold `$1M` adalah garis pemisah final?

---

## 4. Verdict — REVISE

Rencana ini secara arsitektural dan jujur jauh di atas rata-rata: urutan dependensinya benar (scrub→reconcile-safe→writer→loop→flip), gap-nya diakui terus-terang (manual SPOF, COGS estimasi, anti-fraud manual), dan ia membangun di atas yang sudah ada alih-alih menulis ulang. Namun sebagai rencana untuk **4 user aktif, $12.15/bln, dan 0 subscription**, ia over-engineered dan menyembunyikan beberapa lubang uang di balik DoD yang tampak "hijau": scrub sebenarnya read-only dengan perbaikan DELETE manual tanpa rollback (§1.1); fix reconcileAll punya cabang yang meninggalkan saldo tak-habis (§1.2); flip hanya menyalakan enforcement sementara top-up tetap manual satu-admin (§1.3); kuota frsubs ternyata post-hoc, bukan pagar konkuren (§1.4); dan gate 0035 + markup bisa mematikan pencatatan pendapatan diam-diam (§1.6). Agar layak APPROVE, minimal: (a) potong scope ke walking-skeleton `A1→A2→A3→B2→B3-confirm→B4` sebagai satu-satunya rantai yang menyentuh uang, dengan rollback/runtime-flag flip dan fallback admin yang diputuskan; (b) tunda D1–D5 (ekonomi-layer) sampai ada pelanggan membayar yang membenarkan biaya backfill COGS; (c) ganti setiap DoD "hijau/0-violation" yang merujuk CI dengan metrik hasil terukur (payment confirmed via bot > 0, saldo menyusut sesuai charge, tidak ada insert-check-violation di charge path). Verdict tetap REVISE, bukan APPROVE atau REJECT: kerangka dan urutannya bisa dipakai, tetapi proporsi dan empat keputusan uang di atas belum diputus.