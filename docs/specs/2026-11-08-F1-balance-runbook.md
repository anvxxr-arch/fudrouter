# F1 — Runbook Produksi: Scrub Anomali Saldo (`credit_ledger` / `balance_micro`)

Status: **prasyarat** sebelum `FreeAccessNoPaymentGateway=false` (`backend/go/internal/store/limits.go:81`).
Dokumen ini untuk operator. Tidak ada perintah di bawah yang boleh dijalankan oleh robot/CI tanpa review operator. Jangan flip flag sampai §5 (go/no-go) seluruhnya hijau.

Referensi desain: `docs/specs/2026-11-08-economic-layer-design.md` §8 invariant 4/5 dan §9 fase F1.
Skrip report/repair: `ops/scrub-balance-anomaly.sql`.

---

## 1. Ringkasan anomali

Fakta terverifikasi terhadap produksi `fudrouter` (read-only, 2026-11-08; lihat §6 bukti):

- `credit_ledger` punya **2 baris korup**, `type='credit_purchase'`, masing-masing
  `amount_micro = 5555555555555000000` (= `5555555555555 × 1e6`, ≈ $5.5 triliun):
  - `txn_01a178b8-3ef7-777e-9791-55c633a2b2d4`, `idempotency_key = purchase:txn_01a178b8-3ef5-7b87-8928-a8d37e537fe8`
  - `txn_01a178b8-3f00-70b4-9d1b-22f58628deb3`, `idempotency_key = purchase:txn_01a178b8-3eff-7d0a-8838-fb7c80a830f9`
  - keduanya `description 'Credit purchase'`, `created_at 2026-10-26`, pada satu akun
    `bac_wrk_usr_VjOnC8IZktzGBVXBagJkGJPEhoocKe5L` (user `usr_VjOnC8IZktzGBVXBagJkGJPEhoocKe5L`).
- `billing_account.balance_micro` akun itu **stale/drift**: nilainya `clean_sum + 1×korup`
  (bukan `clean_sum + 2×korup` = SUM ledger yang benar). Cache tertinggal satu posting.
- **Penyebab**: `5555555555555` adalah *placeholder input admin/test* (pola digit
  berulang 5), ditulis lewat jalur writer pra-bigint yang **sudah tidak ada**.
  `postLedger` kini menolak non-bigint (`packages/platform/server/billing.ts:133-135`,
  `throw TypeError`). Ini posting sampah satu-kali, bukan bug writer yang masih hidup.
- **Efek samping yang sedang berjalan hari ini**: `SUM(amount_micro)` akun itu = `1.11e19`,
  melebihi `int64`/bigint (maks `9.22e18`). `reconcileAll` (`billing.ts:275`) men-cast
  `::bigint`, jadi **job `billing_aggregation` per jam sedang error `bigint out of
  range`** dan tidak merekonsiliasi akun mana pun sampai Step 1 menghapus overflow.
  (Terverifikasi: CTE `coalesce(total,0)::bigint` pada akun ini → `ERROR: bigint out of range`.)
- **Bukan "balance jadi nol".** Akun korup juga memegang **6 pembelian sah** (2×$210k,
  2×$5,555, 2×$555) plus ~19.040 `usage_charge`. Setelah Step 1–2, saldo akun ini adalah
  dikenal **432.211.272.800** (= $432.211,27), bukan 0. Gate F1 yang benar (desain §9)
  adalah **Σledger == Σbalance dan `5.55e18` hilang**, bukan "saldo akun korup jadi nol".

Ringkas: **ledger kotor dulu, baru cache.** Step 1 meniadakan baris korup; baru Step 2
merekonstruksi cache dari ledger yang sudah bersih.

---

## 2. Urutan perintah persis

Disiplin aman: **ledger dulu, baru cache.** Sekali pun Anda hanya butuh cache betul,
jangan pernah menjalankan `reconcileAll` / Step 2 sebelum Step 1 selesai — kalau
dibalik, sampah `5.55e18` **disalin** ke `balance_micro` (lihat §4).

### 0. Prasyarat

- Akses `psql` ke `fudrouter` dan ke satu database **staging/scratch** (restore dari backup).
- `runbook` dijalankan **dulu di staging** dari awal sampai akhir; baris ini dipakai di produksi hanya setelah verifikasi di staging.
- `DATABASE_URL` ada di `.env` (repo). `ops/backup-db.sh` memakai `docker exec postgre pg_dump`.

### 1. Backup (wajib, sebelum menyentuh apa pun)

```bash
cd ~/fudrouter
ops/backup-db.sh                 # dump fudrouter + .env + .env.console ke ~/backups/fudrouter/
# catat nama file .sql.gz yang dicetak; inilah titik restore/rollback (lihat §3)
```

Simpan juga `idempotency_key` kedua baris korup ke catatan operator (keluar dari REPORT 2 di langkah 4).

### 2. Jalankan REPORT (read-only, aman di produksi)

```bash
cd ~/fudrouter
psql "$DATABASE_URL" -f ops/scrub-balance-anomaly.sql
```

Dua hasil yang Anda cari:
- **REPORT 1** — akun dengan cache out-of-range / drift / mismatch (`ledger_sum` kolom NUMERIC, bukan bigint, supaya overflow tidak menyembunyikan baris).
- **REPORT 2** — baris ledger implausible dengan `id`, `idempotency_key`, `description`, `created_at`.

### 3. Review

- **REPORT 2 harus berisi tepat 2 baris `credit_purchase`** dengan `idempotency_key` `purchase:…` yang tercantum di §1. Kalau ada baris lain (mis. `usage_charge` besar), **berhenti** dan eskalasi — jangan null-out posting lain tanpa memahami asalnya.
- **REPORT 1 harus berisi tepat 1 akun** (`bac_wrk_…`, drift = satu posting korup). Kalau ada akun lain dengan `balance_mismatch=t`, catat dan eskalasi; jangan difix dengan menutup mata.

### 4. Jalankan Step 1 (LEDGER: null-out, pertahankan provenance)

Edit template Step 1 di `ops/scrub-balance-anomaly.sql`, ganti `txn_…` / `purchase:…`
dengan nilai persis dari REPORT 2, lalu jalankan **per baris** (satu `UPDATE` per
baris korup, dua baris total). Salin `id`, `idempotency_key`, dan pertahankan predikat
overflow agar typo review tidak bisa menulis posting sah:

```sql
UPDATE credit_ledger
   SET amount_micro = 0,
       description = coalesce(description, '') ||
                     ' [scrub-balance-anomaly: corrupt placeholder, was ' ||
                     amount_micro::text || ']'
 WHERE id = 'txn_01a178b8-3ef7-777e-9791-55c633a2b2d4'
   AND idempotency_key = 'purchase:txn_01a178b8-3ef5-7b87-8928-a8d37e537fe8'
   AND (amount_micro > 1000000000000 OR amount_micro < -1000000000000);
```

```sql
UPDATE credit_ledger
   SET amount_micro = 0,
       description = coalesce(description, '') ||
                     ' [scrub-balance-anomaly: corrupt placeholder, was ' ||
                     amount_micro::text || ']'
 WHERE id = 'txn_01a178b8-3f00-70b4-9d1b-22f58628deb3'
   AND idempotency_key = 'purchase:txn_01a178b8-3eff-7d0a-8838-fb7c80a830f9'
   AND (amount_micro > 1000000000000 OR amount_micro < -1000000000000);
```

**Jangan `DELETE`.** Baris tetap ada dengan `amount_micro=0` dan provenance lama
tersimpan di `description`. `idempotency_key` unik tetap utuh, jadi retry posting lama
tidak bisa menulis ulang sampah.

**Jangan gabungkan dua `UPDATE` jadi satu statement ber-`OR`.** `AND (amount_micro >
1e12 …)` mengikat lebih erat daripada `OR`, sehingga disjunct pertama kehilangan
guard overflow dan re-run akan menambah suffix provenance dua kali pada baris yang
`amount_micro`-nya sudah 0. Tetap bentuk per-baris (satu `UPDATE` per `txn_…`);
idempotensi (re-run = `UPDATE 0`) adalah bagian dari go/no-go G5, dan guard yang lepas
merusaknya. Kalau terpaksa menggabung, parenthesize seluruh klausa `OR`.

**Stack SQL.** Setiap `UPDATE` harus dibungkus transaksi kalau Anda ingin bisa memisah
dua baris:

```sql
BEGIN;
UPDATE credit_ledger ... (baris 1);
-- `SELECT ...` periksa `amount_micro=0` sebelum COMMIT.
COMMIT;
```

### 5. Jalankan Step 2 (CACHE: re-derive dari ledger bersih)

```bash
cd ~/fudrouter
psql "$DATABASE_URL" -f ops/scrub-balance-anomaly.sql   # sekali lagi: REPORT 1 & 2 sekarang harus 0 baris
```

Step 2 adalah `UPDATE billing_account` set-based berikut (sama dengan aturan
`reconcileAll`, tapi dieksekusi manual setelah Step 1):

```sql
WITH derived AS (
    SELECT billing_account_id AS account_id, sum(amount_micro) AS total
      FROM credit_ledger
     GROUP BY billing_account_id
),
wanted AS (
    SELECT b2.id, coalesce(d.total, 0)::bigint AS total
      FROM billing_account b2
      LEFT JOIN derived d ON d.account_id = b2.id
)
UPDATE billing_account b
   SET balance_micro = w.total, updated_at = now()
  FROM wanted w
 WHERE w.id = b.id
   AND w.total <> b.balance_micro;
```

`::bigint` sekarang aman karena sudah tidak ada akun yang SUM-nya melebihi int64
(setelah Step 1). Alternatif: jalankan `reconcileAll` lewat worker — tapi jangan,
supaya alurnya eksplisit dan tersanksi urutan ledgernya.

### 6. Re-report + verifikasi invariant (a–e)

Jalankan ulang `ops/scrub-balance-anomaly.sql`. REPORT 1 dan REPORT 2 keduanya **0 baris**,
lalu cek lima invariant:

```sql
-- (a) 0 baris ledger implausible (|amount_micro| > 1e12)
SELECT count(*) FROM credit_ledger
 WHERE amount_micro > 1000000000000 OR amount_micro < -1000000000000;   -- harus 0

-- (b) 0 akun out-of-range (|balance_micro| >= 1e12)
SELECT count(*) FROM billing_account
 WHERE balance_micro >= 1000000000000 OR balance_micro <= -1000000000000; -- harus 0

-- (c) 0 drift per-akun (cache != SUM(ledger))
SELECT count(*) FROM billing_account ba
  LEFT JOIN (SELECT billing_account_id a, sum(amount_micro) s
               FROM credit_ledger GROUP BY 1) l ON l.a = ba.id
 WHERE ba.balance_micro <> coalesce(l.s, 0);                             -- harus 0

-- (d) Σledger == Σbalance (global)
SELECT (SELECT sum(amount_micro) FROM credit_ledger)
     - (SELECT sum(balance_micro) FROM billing_account) AS global_diff; -- harus 0

-- (e) idempoten 2x: dua baris korup sudah null (amount_micro=0, provenance utuh)
SELECT id, amount_micro, description FROM credit_ledger
 WHERE id IN ('txn_01a178b8-3ef7-777e-9791-55c633a2b2d4',
              'txn_01a178b8-3f00-70b4-9d1b-22f58628deb3');               -- amount_micro=0
```

**Uji idempoten (wajib, "scrub 2×"):** ulangi seluruh §2 langkah 4–6 sekali lagi.
Perulangan kedua harus **tidak mengubah satu baris pun** — Step 1 `UPDATE` menarget 0
baris (amount sudah 0), Step 2 `UPDATE` menarget 0 baris (cache sudah sama), dan semua
invariant tetap 0. Kalau ada baris yang berubah pada putaran kedua, scrub **belum**
idempoten dan Anda harus berhenti.

---

## 3. Rollback / undo

Status sewaktu-waktu bisa dikembalikan karena semua yang kita ubah adalah baris data,
bukan schema, dan `idempotency_key` tidak dihapus. Dua mekanisme:

### 3.1 Restore dari backup (paling aman, sebelum/tanpa reverse-UPDATE)

```bash
cd ~/fudrouter
# database restorasi segar dari dump yang dicatat di langkah 1
createdb -h 127.0.0.1 -U <role> fudrouter_restore
gzip -dc ~/backups/fudrouter/<STAMP>.sql.gz \
  | psql -h 127.0.0.1 -U <role> -d fudrouter_restore
# lalu tukar/point ulang aplikasi ke fudrouter_restore ATAU dump ulang & replace:
# pg_dump fudrouter_restore | psql fudrouter
```

Peringatan: dump dari `backup-db.sh` memuat kredensial sebagai *ciphertext*; master key
ada di file `.env` (tidak di dalam dump) dengan mode 600 — di-copy terpisah oleh skrip.

### 3.2 Reverse-UPDATE (hanya untuk membatalkan Step 1, jika masih segar)

Step 2 tidak perlu "di-undo" sendiri — `reconcileAll` selalu mere-derive dari ledger,
jadi mengembalikan ledger otomatis mengembalikan cache pada run berikutnya. Untuk
membatalkan Step 1, kembalikan nilai asli dan provenance:

```sql
-- satu baris (ulangi untuk baris kedua)
UPDATE credit_ledger
   SET amount_micro = 5555555555555000000,
       description = 'Credit purchase'
 WHERE id = 'txn_01a178b8-3ef7-777e-9791-55c633a2b2d4';
-- lalu jalankan Step 2 lagi untuk menurunkan cache ke nilai lama.
```

Ini mengembalikan keadaan anomali lama; gunakan hanya jika Anda ingin keluar dari
perubahan dan belum ada restart/migrasi lain.

---

## 4. Peringatan: reconcile TANPA scrub menyalin anomali ke cache

`reconcileAll` (`billing.ts:279-290`) adalah `UPDATE billing_account SET balance_micro
= derived.total` murni dari `SUM(credit_ledger.amount_micro)`. Ia **tidak** menilai
apakah nilai masuk akal; ia menyalin apapun yang ada di ledger ke cache.

- Kalau Step 1 belum dijalankan, `reconcileAll` akan menulis `balance_micro =
  1.11e19` ke akun korup (bukan menghapus), sehingga dompet $5.5T yang salah itu
  justru direncanakan di cache dan siap dibaca gate.
- Lebih buruk lagi, **hari ini** `reconcileAll` bahkan tidak bisa jalan: `SUM` akun
  korup melampaui int64, `::bigint` di CTR-nya melempar `bigint out of range`, dan
  satu statement yang gagal menggagalkan **seluruh** batch — jadi job aggregation
  sedang error dan tidak merekonsiliasi akun sehat pun.

Karena itu urutan **ledger-dulu-baru-cache** bukan preferensi gaya: ini satu-satunya
urutan yang (1) tidak menyebarkan sampah dan (2) membuat Step 2 / job berjalan.
Ini sejalan dengan desain §8 invariant 4: *"`reconcileAll` TIDAK dijalankan sebelum
scrub anomali."*

---

## 5. Go/no-go untuk flip `FreeAccessNoPaymentGateway=false`

Flag tinggal di `backend/go/internal/store/limits.go:81` (`var FreeAccessNoPaymentGateway
= true`); prod boot selalu pakai nilai itu (bukan env/config), jadi flip adalah edit
kode + rebuild + deploy router Go. **Jangan flip sekarang.**

### 5.1 Kondisi numerik (semua harus `0`/`true`, diverifikasi dua kali berturut)

| # | Kriteria | Query | Target |
|---|---|---|---|
| G1 | Akun out-of-range | §2 invariant (b) | `0` |
| G2 | Drift per-akun | §2 invariant (c) | `0` |
| G3 | Baris ledger implausible | §2 invariant (a) | `0` |
| G4 | Σledger == Σbalance | §2 invariant (d) | `0` |
| G5 | Scrub idempoten | ulangi §2 langkah 4–6 | `2×` bersih, putaran kedua mengubah `0` baris |

G1–G5 adalah *gate* F1. Kalau semuanya hijau, scrub selesai dan aman untuk lanjut.

### 5.2 Prasyarat fungsional sebelum flag benar-benar dibalik (di luar scrub)

Flag ini mengaktifkan gerbang saldo: `checkBudgets` menolak `402 INSUFFICIENT_CREDITS`
saat `balance_micro <= hard_stop_threshold_micro` (default `0`) — `proxy/budget.go:63`,
`store/billing.go:270` — dan `raiseLowBalance` menyala lagi (`proxy/lifecycle.go:1412`).
Konsekuensi yang harus dipastikan **sebelum** flip:

1. **Ada jalur top-up nyata.** Hari ini tidak ada penulis produksi untuk
   `credit_purchase`; `postLedger` hanya dipanggil oleh jalur `usage_charge` (debit).
   Membalik flag tanpa jalur kredit berarti setiap akun yang saldonya mencapai
   `0` akan langsung diblokir dan tidak pernah bisa diisi ulang → seluruh pengguna
   mati. Gateway pembayaran + handler `credit_purchase` harus live dulu.
2. **`invoice` dan `payment` konsisten.** `invoice_generation` (`workers.ts:220`)
   menagih `-SUM(usage_charge)` per bulan; `payment` (migrasi 0025) adalah tabel
   percobaan gateway (`amount_idr`, `status`, `gateway_ref` unik). Pastikan alur
   `payment`→konfirmasi→`credit_purchase`→`balance_micro` sudah satu siklus tertutup
   sebelum gerbang saldo menegakkan apa pun.
3. **Threshold direview.** `hard_stop_threshold_micro` default `0` dan
   `warning_threshold_micro` default `10000000` (schema `billingAccount`). Pastikan
   angka itu disengaja untuk akun berbayar sebelum gerbang aktif.

Flip hanya boleh setelah **§5.1 hijau DAN §5.2 terpenuhi**.

---

## 6. Bukti (read-only, produksi `fudrouter`, 2026-11-08)

```
REPORT 1 (sum numeric, bukan ::bigint):
bac_wrk_usr_VjOnC8IZktzGBVXBagJkGJPEhoocKe5L|5555555987766272800|11111111543321272800|-5555555555555000000|t|t|t

REPORT 2 (baris implausible):
txn_01a178b8-3ef7-777e-9791-55c633a2b2d4|bac_wrk_...|credit_purchase|5555555555555000000|purchase:txn_01a178b8-3ef5-7b87-8928-a8d37e537fe8
txn_01a178b8-3f00-70b4-9d1b-22f58628deb3|bac_wrk_...|credit_purchase|5555555555555000000|purchase:txn_01a178b8-3eff-7d0a-8838-fb7c80a830f9

Global: Σledger 11111111646274379706 - Σbalance 5555556090719379706 = 5555555555555000000 (persis 1 posting korup)
Akun korup: credit_purchase 8 baris (min 555000000, max 5555555555555000000); usage_charge 19013 baris (min -131767); clean sum = 432211272800
reconcileAll CTE `::bigint` pada akun korup: ERROR: bigint out of range
```

`count(billing_account)` = 80, `count(credit_ledger)` = 50.836 saat diverifikasi.

---

## 7. Defect / residu & rekomendasi

1. **`reconcileAll` tidak tahan overflow.** `billing.ts:279-290` men-cast
   `SUM(bigint)` → `::bigint`; satu akun yang melampaui int64 menggagalkan seluruh
   batch dan membuat job `billing_aggregation` per jam diam-diam error. Rekomendasi
   (di luar scope scrub, jangan ubah runtime sekarang): jadikan Step 2 robust terhadap
   overflow (mis. `CASE WHEN` atau tipe `numeric(40,0)` → guard) atau tangkap error
   dan lanjutkan akun berikutnya. Ini bukan blocker untuk scrub, tapi wajib dievaluasi
   sebelum gateway live.
2. **`ops/scrub-balance-anomaly.sql` (versi lama) memakai `::bigint` di REPORT 1**
   sehingga report gagal `bigint out of range` tepat saat dibutuhkan; sudah dikoreksi
   ke SUM numeric di versi baru (lihat `ssh://dwizzy/~/fudrouter/ops/scrub-balance-anomaly.sql`).
3. **Provenance lama step di SQL lama menyebut "float round-trip".** Koreksi: penyebab
   adalah *placeholder input admin/test* digit-berulang-5; description scrub sekarang
   bertuliskan `corrupt placeholder`, bukan `float round-trip`.
4. **Tidak ada writer `credit_purchase` produksi** (hanya tipe di `billing.ts` + komentar
   di `quota.go`/`lifecycle.go`). Ini gap fungsional §5.2(1), bukan defect scrub; harus
   dibangun sebelum flip.