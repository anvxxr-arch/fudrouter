# Scrub Anomali Saldo — Checklist Eksekusi Operator (F1 / A1)

Checklist ini adalah **satu-satunya** jalur yang disetujui untuk mengeksekusi
`ops/scrub-balance-anomaly.sql` terhadap database mana pun. Tidak ada robot/CI
yang menjalankannya: setiap langkah diketik operator, dan setiap gate dibaca
operator. Bila ada langkah yang gagal, **berhenti** — jangan lanjut ke langkah
berikutnya.

Rujukan:
- Rencana: `docs/plans/fr-revised.md` §0 P1.1, §4 A1, §6 S1.
- Runbook: `docs/specs/2026-11-08-F1-balance-runbook.md`.
- Skrip: `ops/scrub-balance-anomaly.sql` (report + template), `ops/scrub-balance-anomaly.step1.sql` / `step2.sql` (ready-to-run), `ops/rollback/scrub-balance-anomaly.rollback.sql` (pre-image), `ops/rollback/scrub-balance-anomaly.undo.sql` (undo), `ops/verify/scrub-gates.sql` (G1–G5 + V6).

Design principle yang mengikat seluruh urutan ini: **ledger dulu, baru cache.**
`billing_account.balance_micro` hanyalah cache dari `SUM(credit_ledger.amount_micro)`.
Merekonstruksi cache sebelum ledger dibersihkan akan **menyalin** sampah ke cache
dan gagal `bigint out of range` untuk seluruh batch `billing_aggregation`
(`packages/platform/server/billing.ts`, `reconcileAll`).

---

## 0. Prasyarat (sekali, sebelum apa pun)

**Catatan urutan A1 ↔ A3 (migrasi 0036 `admin_credit:` rename).** A1 Step 1
dan gate G5 sengaja cocok `id` (PRIMARY KEY) + predikat overflow, dengan klausa
`idempotency_key` sebagai audit — bukan sebagai identitas. 0036 me-rename dua key
`purchase:` korup menjadi `admin_credit:` dan menyimpan nilai lama di
`metadata.idempotency_key_prev`. Oleh karena itu:

- Step 1 bisa jalan **sebelum ATAU sesudah** 0036: klausa key-nya menerima
  `purchase:...`, `admin_credit:...`, atau `metadata.idempotency_key_prev`.
- Gates G5 ikut menerima ketiga bentuk itu, jadi pemindaian setelah 0036 tetap
  `G5 = 2 PASS`.
- Undo A1 **mengembalikan tepat scope A1** — `amount_micro` + `description` — dan
  **tidak** mengembalikan rename 0036 (itu perubahan A3, bukan A1). Terbukti:
  undo setelah 0036 menghasilkan checksum `id|amount|description` identik dengan
  pre-image, sementara key tetap `admin_credit:`.

Urutan runbook tetap **A1 dulu, A3 kemudian** (gate A3 = A1); catatan ini hanya
membuat keduanya aman bila dieksekusi ulang / di-rehearsal dalam urutan bebas.
- [ ] Akses `psql` ke database target. Untuk produksi: via `docker exec postgre`
      (role superuser) atau DSN aplikasi.
- [ ] Database **staging/scratch** tersedia dan sudah diisi klon `user`,
      `billing_account`, `credit_ledger` dari target (`CREATE DATABASE ... ;
      pg_dump --schema-only -t '"user"' -t billing_account -t credit_ledger` →
      restore, lalu `--data-only` dalam urutan `user` → `billing_account` →
      `credit_ledger`).
- [ ] File `ops/backup-db.sh` ada dan bisa dijalankan (memakai `docker exec
      postgre pg_dump`).
- [ ] Baca REPORT 2 dan hafalkan/catat: **tepat 2 baris** `credit_purchase`,
      `idempotency_key` berawalan `purchase:`, akun `bac_wrk_usr_VjOnC8IZktzGBVXBagJkGJPEhoocKe5L`.
      Bila ada baris ketiga, jangan mulai.

---

## 1. Staging dulu, selalu

Ulangi **seluruh** checklist ini di staging sampai §7 hijau dua kali berturut,
baru ulangi di produksi. Jangan pernah melewati staging: ini satu-satunya disiplin
yang memastikan undo sudah terbukti bekerja pada data yang sama sebelum menyentuh
uang produksi.

```bash
export DSN="postgres://fudrouter:fudrouter@127.0.0.1:5432/<staging_db>"
```

---

## 2. Backup (WAJIB, sebelum menyentuh data apa pun)

```bash
cd ~/fudrouter
ops/backup-db.sh
# CATAT nama file yang dicetak: ~/backups/fudrouter/fudrouter-<STAMP>.sql.gz
# Ini titik restore terakhir. Tanpa ini, jangan lanjut.
```

Verifikasi backup bisa dibaca (skrip sudah gagal keras kalau `CREATE TABLE < 5`):

```bash
zcat ~/backups/fudrouter/fudrouter-<STAMP>.sql.gz | grep -c '^CREATE TABLE'
```

- [ ] Backup tercetak dan `>= 5` tabel.

---

## 3. REPORT (read-only, aman di produksi)

```bash
psql "$DSN" -v ON_ERROR_STOP=1 -f ops/scrub-balance-anomaly.sql
```

- [ ] **REPORT 2** berisi tepat 2 baris (keduanya `credit_purchase`, `amount_micro
      = 5555555555555000000`, `idempotency_key` = `purchase:txn_01a178b8-3ef5-7b87-8928-a8d37e537fe8`
      dan `purchase:txn_01a178b8-3eff-7d0a-8838-fb7c80a830f9`).
- [ ] **REPORT 1** berisi tepat 1 akun (`bac_wrk_usr_VjOnC8IZktzGBVXBagJkGJPEhoocKe5L`,
      `drift_micro = -5555555555555000000`, `balance_out_of_range = true`).
- [ ] Catat di lembar kerja: `sum_ledger`, `sum_balance`, `clean_sum` akun korup
      (harus `432211272800`), dan tanggal/jam.

**What-if:** REPORT 2 punya baris yang **bukan** dua `credit_purchase` di atas
(mis. `usage_charge` besar atau `adjustment`), ATAU REPORT 1 punya akun lain dengan
`balance_mismatch = true`. → **BERHENTI.** Anomali lebih lebar dari yang
diasumsikan repair ini; eskalasi ke Tech Lead. Jangan menambal baris yang tidak
dipahami.

---

## 4. Pre-image (WAJIB, sebelum repair)

Snapshot baris yang **akan** diubah dan cache akunnya, ke tabel arsip
`credit_ledger_scrub_preimage` + `billing_account_scrub_preimage`:

```bash
psql "$DSN" -v ON_ERROR_STOP=1 -1 -f ops/rollback/scrub-balance-anomaly.rollback.sql

# cek hasil capture: harus 2 baris ledger + 1 akun
psql "$DSN" -Atc "SELECT count(*) FROM credit_ledger_scrub_preimage;"          # 2
psql "$DSN" -Atc "SELECT count(*) FROM billing_account_scrub_preimage;"       # 1
psql "$DSN" -Atc "SELECT id, original_amount_micro, original_description FROM credit_ledger_scrub_preimage ORDER BY id;"
```

- [ ] 2 baris ledger tersimpan dengan `original_amount_micro = 5555555555555000000`
      dan `original_description = 'Credit purchase'`.
- [ ] 1 akun tersimpan dengan `original_balance_micro = 5555555987766272800`.
- [ ] Hitung checksum pre-image dan catat (dipakai di uji undo §8):

```bash
psql "$DSN" -Atc "
  SELECT md5(string_agg(id || '|' || original_amount_micro || '|' || coalesce(original_description,'<null>'), ',' ORDER BY id))
    FROM credit_ledger_scrub_preimage;" > /tmp/preimage.ck
cat /tmp/preimage.ck   # simpan nilainya di lembar kerja
```

**What-if:** capture menghasilkan 0 baris padahal REPORT 2 punya 2 baris →
**BERHENTI**: predikat capture dan predikat report tidak cocok, jangan ubah apa pun.

---

## 5. Repair — Step 1 (ledger) lalu Step 2 (cache)

**Tutup jalur tulis aplikasi lebih dulu** (hentikan worker `billing_aggregation`
dan gerbang pembayaran selama jendela ini) supaya tidak ada posting baru yang
bisa masuk di antara Step 1 dan Step 2. Catat waktu mulai/berhenti.

```bash
# Step 1 — null-out 2 posting korup, simpan provenance di description.
psql "$DSN" -v ON_ERROR_STOP=1 -1 -f ops/scrub-balance-anomaly.step1.sql
# output harus: UPDATE 1 (baris 1), UPDATE 1 (baris 2)

# Step 2 — re-derive cache dari ledger yang sudah bersih.
psql "$DSN" -v ON_ERROR_STOP=1 -1 -f ops/scrub-balance-anomaly.step2.sql
# output harus: UPDATE 1 (akun korup saja)
```

- [ ] Step 1 mencetak `UPDATE 1` dua kali. Jika `UPDATE 0` → baik (sudah pernah
      di-scrub) atau predikat tidak cocok; periksa REPORT 2 sebelum lanjut.
- [ ] Step 2 mencetak `UPDATE 1`. Jika `bigint out of range` → **BERHENTI**: Step 1
      belum menghapus overflow (cek baris `amount_micro` masih 5.55e18?).
- [ ] (Opsional tapi disarankan) bungkus keduanya dalam satu transaksi manual bila
      operator ingin bisa memisah rollback per langkah:

```sql
BEGIN;
\i ops/scrub-balance-anomaly.step1.sql
\i ops/scrub-balance-anomaly.step2.sql
-- periksa gate di dalam transaksi ini, COMMIT hanya bila hijau
COMMIT;
```

**Jangan `DELETE` baris.** Baris tetap ada dengan `amount_micro = 0` dan provenance
di `description`; `idempotency_key` unik tetap utuh sehingga retry posting lama
tidak bisa menulis ulang sampah.

---

## 6. Re-report + gate G1–G5

```bash
psql "$DSN" -v ON_ERROR_STOP=1 -f ops/scrub-balance-anomaly.sql
# REPORT 1 dan REPORT 2 harus 0 baris

psql "$DSN" -v ON_ERROR_STOP=1 -f ops/verify/scrub-gates.sql
# setiap baris gate harus PASS
```

- [ ] REPORT 1 = 0 baris.
- [ ] REPORT 2 = 0 baris.
- [ ] G1 `G1_accounts_out_of_range ... 0 PASS`
- [ ] G2 `G2_accounts_with_drift ... 0 PASS`
- [ ] G3 `G3_implausible_ledger_rows ... 0 PASS`
- [ ] G4 `G4_global_diff_micro ... 0 PASS`
- [ ] G5 `G5_scrubbed_rows_intact ... 2 PASS`
- [ ] Akun korup: `balance_micro = 432211272800` (bukan 0 — akun ini punya 6
      pembelian sah + puluhan ribu `usage_charge`):

```bash
psql "$DSN" -Atc "SELECT balance_micro FROM billing_account
  WHERE id = 'bac_wrk_usr_VjOnC8IZktzGBVXBagJkGJPEhoocKe5L';"   # 432211272800
```

**What-if G2 atau G5 gagal → JANGAN LANJUT.** Jangan flip apa pun, jangan
hapus pre-image, jangan abaikan "hanya satu akun". G2 gagal berarti cache masih
menyimpang dari ledger: jalankan §7 (idempotensi) dulu — bila Step 2 kedua kali
masih mengubah baris, penyimpangan itu hidup (ada penulis lain) dan scrub bukan
obatnya. Eskalasi. G5 gagal berarti salah satu baris korup tidak berada di
`amount_micro = 0` ber-provenance: jangan tutup tiket.

---

## 7. Uji idempotensi (G5, "scrub 2×")

Ulangi **Step 1 + Step 2** persis:

```bash
psql "$DSN" -v ON_ERROR_STOP=1 -1 -f ops/scrub-balance-anomaly.step1.sql
psql "$DSN" -v ON_ERROR_STOP=1 -1 -f ops/scrub-balance-anomaly.step2.sql
```

- [ ] Putaran kedua: Step 1 = `UPDATE 0` dua kali, Step 2 = `UPDATE 0`.
- [ ] Re-report: REPORT 1 & 2 = 0 baris; `scrub-gates.sql` = semua PASS.

**Ini gate go/no-go.** Bila putaran kedua mengubah baris apa pun, scrub **tidak
idempoten**: **BERHENTI**, jangan flip `FreeAccessNoPaymentGateway`, jangan hapus
pre-image, eskalasi.

---

## 8. Uji undo (wajib di staging; opsional di produksi bila belum ada tulisan baru)

Membuktikan bahwa pre-image benar-benar bisa mengembalikan data persis. Dilakukan
di staging setelah §7 hijau, sebelum menyentuh produksi:

```bash
# 1. Undo: restore ledger amount+description and the cached balance from the
#    pre-image captured in §4. Output must be: UPDATE 2 (ledger), UPDATE 1 (cache).
psql "$DSN" -v ON_ERROR_STOP=1 -1 -f ops/rollback/scrub-balance-anomaly.undo.sql

# 2. Data harus PERSIS kembali ke snapshot:
psql "$DSN" -v ON_ERROR_STOP=1 -f ops/verify/scrub-gates.sql
# V6_ledger_preimage_mismatch = 0 PASS
# V6_cache_preimage_mismatch  = 0 PASS
# (G1..G5 kini FAIL lagi — itu BENAR: anomali lama kembali, dan itulah bukti
#  bahwa undo mengembalikan keadaan SEBELUM scrub, bukan keadaan bersih.)
#
# Catatan: V6 membaca FAIL di antara Step 1/2 dan undo (baris hidup sengaja
# berbeda dari pre-image). Itu normal; baca V6 hanya SETELAH undo.

# 3. Checksum baris hidup vs pre-image harus identik:
psql "$DSN" -Atc "
  SELECT md5(string_agg(c.id || '|' || c.amount_micro || '|' || coalesce(c.description,'<null>'), ',' ORDER BY c.id))
    FROM credit_ledger c JOIN credit_ledger_scrub_preimage p ON p.id = c.id;
" > /tmp/live.ck
diff /tmp/preimage.ck /tmp/live.ck && echo "UNDO RESTORES IDENTICAL"

# 4. Undo idempoten: jalankan sekali lagi, harus UPDATE 0 / UPDATE 0.
psql "$DSN" -v ON_ERROR_STOP=1 -1 -f ops/rollback/scrub-balance-anomaly.undo.sql
```

- [ ] `V6_ledger_preimage_mismatch = 0 PASS`, `V6_cache_preimage_mismatch = 0 PASS`.
- [ ] checksum pre-image == checksum live (baris terscrub kembali persis).
- [ ] `balance_micro` akun kembali ke `5555555987766272800`.

Setelah undo terbukti, **ulangi §4 (capture) tidak perlu** — pre-image tidak
dihapus oleh undo, jadi jalankan lagi §5–§7 untuk meninggalkan staging dalam
keadaan bersih, atau biarkan staging dalam keadaan ber-anomali (itu pun benar:
staging menunjukkan undo bekerja). Untuk bukti ke Tech Lead, simpan output
`undo` + `V6` + `diff`.

---

## 9. Tanda tangan & serah terima

- [ ] Lampirkan: output REPORT 1/2 pra-scrub, checksum pre-image, output Step 1/2
      (putaran 1 & 2), output `scrub-gates.sql` (semua PASS), bukti undo di staging.
- [ ] Catat durasi jendela tulis tertutup dan Siapa (operator) + reviewer (TL + Q).
- [ ] Pre-image TIDAK dihapus. Hapus hanya setelah: backup melewati retensi
      (`KEEP_DAYS`, default 14), dan Tech Lead menandatangani bahwa anomali tidak
      perlu dipulihkan. Drop manual (bukan bagian checklist harian):

```sql
-- DROP TABLE credit_ledger_scrub_preimage;
-- DROP TABLE billing_account_scrub_preimage;
```

---

## 10. Untuk produksi — perintah eksak (operator lain yang mengeksekusi)

Ganti `<staging_db>` → `fudrouter` **hanya** pada langkah akhir, setelah staging
hijau. Semua path relatif ke `~/fudrouter`.

```bash
cd ~/fudrouter
export DSN="postgres://fudrouter:<password>@127.0.0.1:5432/fudrouter"

# 0. Backup — wajib, catat nama file
ops/backup-db.sh

# 1. Report (read-only)
psql "$DSN" -v ON_ERROR_STOP=1 -f ops/scrub-balance-anomaly.sql

# 2. Review — HANYA lanjut bila REPORT 2 = tepat 2 baris & REPORT 1 = tepat 1 akun

# 3. Pre-image (snapshot sebelum repair)
psql "$DSN" -v ON_ERROR_STOP=1 -1 -f ops/rollback/scrub-balance-anomaly.rollback.sql

# 4. Repair — ledger dulu, cache kemudian (tutup jalur tulis dulu)
psql "$DSN" -v ON_ERROR_STOP=1 -1 -f ops/scrub-balance-anomaly.step1.sql
psql "$DSN" -v ON_ERROR_STOP=1 -1 -f ops/scrub-balance-anomaly.step2.sql

# 5. Re-report + gate
psql "$DSN" -v ON_ERROR_STOP=1 -f ops/scrub-balance-anomaly.sql
psql "$DSN" -v ON_ERROR_STOP=1 -f ops/verify/scrub-gates.sql

# 6. Idempotensi (G5): ulangi Step 1+2, harus UPDATE 0
psql "$DSN" -v ON_ERROR_STOP=1 -1 -f ops/scrub-balance-anomaly.step1.sql
psql "$DSN" -v ON_ERROR_STOP=1 -1 -f ops/scrub-balance-anomaly.step2.sql

# 7. Bila ada yang gagal di 5/6 → JANGAN flip. Eskalasi.
```

**Jangan** jalankan `undo` di produksi kecuali memang memutuskan membatalkan scrub,
dan hanya bila belum ada posting baru yang bergantung pada keadaan bersih.

---

## 11. Lampiran A — apa yang diubah, dan apa yang tidak

| Objek | Diubah? | Catatan |
|---|---|---|
| `credit_ledger` 2 baris korup | `amount_micro` → 0, `description` += suffix provenance | baris TIDAK dihapus; `id`/`idempotency_key` utuh |
| `billing_account` akun korup | `balance_micro` → `SUM(ledger)` = 432211272800 | cache selalu bisa di-derive ulang dari ledger |
| `user` | tidak disentuh | — |
| schema | tidak disentuh | pre-image = tabel baru, bukan migrasi |

---

## 12. Lampiran B — perintah persis membuat staging clone (yang dipakai QA 2026-11-09)

Dijalankan di host `dwizzy`. Kontainer Postgres produksi: `postgre`; database
produksi: `fudrouter` (hanya dibaca, tidak pernah ditulis).

```bash
SCRATCH=frf1_scrub_qa

# 0) buat scratch (superuser di dalam kontainer, bukan role aplikasi)
docker exec postgre psql -U postgres -c "DROP DATABASE IF EXISTS $SCRATCH;"
docker exec postgre psql -U postgres -c "CREATE DATABASE $SCRATCH;"

# 1) skema saja untuk 3 tabel (KONSEN murni dari produksi — tak ada tabel baru)
docker exec postgre pg_dump -U postgres -d fudrouter --schema-only --no-owner --no-acl \
  --table='"user"' --table=billing_account --table=credit_ledger > /tmp/schema3.sql
docker exec -i postgre psql -U postgres -v ON_ERROR_STOP=1 -d $SCRATCH < /tmp/schema3.sql

# 2) data saja, per tabel dalam urutan FK (user -> billing_account -> credit_ledger)
docker exec postgre pg_dump -U postgres -d fudrouter --data-only --no-owner --no-acl --table='"user"'          > /tmp/u.dmp
docker exec postgre pg_dump -U postgres -d fudrouter --data-only --no-owner --no-acl --table=billing_account   > /tmp/ba.dmp
docker exec postgre pg_dump -U postgres -d fudrouter --data-only --no-owner --no-acl --table=credit_ledger     > /tmp/cl.dmp
docker exec -i postgre psql -U postgres -v ON_ERROR_STOP=1 -d $SCRATCH < /tmp/u.dmp
docker exec -i postgre psql -U postgres -v ON_ERROR_STOP=1 -d $SCRATCH < /tmp/ba.dmp
docker exec -i postgre psql -U postgres -v ON_ERROR_STOP=1 -d $SCRATCH < /tmp/cl.dmp

# 3) serahkan kepemilikan ke role aplikasi supaya psql dengan DSN aplikasi bisa dipakai
docker exec postgre psql -U postgres -d $SCRATCH -c "
  ALTER TABLE \"user\" OWNER TO fudrouter;
  ALTER TABLE billing_account OWNER TO fudrouter;
  ALTER TABLE credit_ledger OWNER TO fudrouter;"

# 4) verifikasi clone == produksi
psql "postgres://fudrouter:fudrouter@127.0.0.1:5432/$SCRATCH" -Atc "
 SELECT 'users='||(SELECT count(*) FROM \"user\")||' accounts='||(SELECT count(*) FROM billing_account)||' ledger='||(SELECT count(*) FROM credit_ledger);"
```

Catatan urutan: `--table` mengambil baris SETIAP tabel terpisah, jadi muat
`"user"` lebih dulu lalu `billing_account` baru `credit_ledger` — memuat
`credit_ledger` sebelum `billing_account` melanggar FK
`credit_ledger_billing_account_id_billing_account_id_fk` (pg_dump
alphabetizes; jangan mengandalkan satu dump gabungan berurutan abjad).
