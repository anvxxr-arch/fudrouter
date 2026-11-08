# Fudrouter — Economic Layer: Desain Final (Arbitrase Ronde 1+2)

Dokumen desain yang dapat langsung dieksekusi. Semua klaim teknis memiliki rujukan `path:line` yang diverifikasi ke `~/fudrouter` (tidak diedit). Keputusan tidak ada yang mengambang.

---

## 1. Ringkasan keputusan

| # | Keputusan | Pilihan | Yang menang | Alasan |
|---|---|---|---|---|
| K1 | Arsitektur | Hybrid: A sekarang, C nanti | Konsensus r2 (OptA/OptB/DevA/DevB/SeniorA/SeniorB) | Revenue flat-fee jalan hari ini; katalog 3× belum butuh |
| K2 | Kanonik `bucket` | Precedence 3 lapis | SeniorA + OptA | Subscription live → key → account → `frpayg` |
| K3 | Guard supply | Join table, bukan kolom | SeniorA (OptB-2/OptA-2 setuju) | 1 mapping boleh multi-bucket tanpa duplikasi 728 baris |
| K4 | `provider_cost` | NULL + 3 nilai (`cost_basis`) | OptB-2 (tiga-nilai) + SeniorB (NULL, bukan alias) | `=cost` (lifecycle.go:1312) adalah kebohongan; 0 vs NULL punya makna beda |
| K5 | Markup | Hanya di atas COGS riil | SeniorA + DevA | Margin atas retail = imajiner (0/549k `charged>cost` artefak alias) |
| K6 | `row.Cost` | Pasca-markup = debit customer | SeniorB (DevB-2 cabut keberatan) | Ledger menagih `-r.Cost` (billing.go:233), `cost`=customer charge (0006:362) |
| K7 | Retail-equivalent | Kolom terpisah `quota_usage_micro` | OptA (kolom meter) | flat-fee `cost=0` tak boleh menghilangkan meter |
| K8 | Supply NULL frcheap | Prefer + cap COGS sekarang; hard-reject gated | OptB (prefer+cap) | Reject day-0 = outage + triase 7,2 jam |
| K9 | Denominator kuota frsubs | Retail-equivalent (`pricing_rule`) | SeniorB | COGS frsubs flat; retail-equivalent satu-satunya fair-use cap |
| K10 | `credential.acquisition` | `credential.acquisition` + `provider_model_supply` (dua sumbu) | SeniorA | Supply-routing vs provenance-COGS berbeda |
| K11 | Prefix publik | Tunda; buka `frcheap/` dgn syarat | OptB (timing) + OptA (bentuk 1 prefix) | Publikasi daftar target drain tanpa key = risiko |
| K12 | CHECK aritmetika | Bentuk koreksi `IS NOT NULL` eksplisit | Parent-koreksi (SeniorA/SeniorB CHECK diperbaiki) | NULL propagation loloskan CHECK |

---

## 2. Intent & non-goals

**Intent.** Memungut uang dari 3 kelas ekonomi (`frcheap` flat-fee 100k IDR/28d, `frpayg` prabayar ter-meter per token, `frsubs` langganan flat 150–500k IDR/28d) dengan atribusi biaya yang jujur: tanpa daftar harga provider, margin tidak boleh dihitung.

**Dibangun sekarang (fase 1–3):** kolom bucket + snapshot, `provider_model_supply`, `provider_cost_rule`, `bucket_margin`, `bucket_quota`, kuota rolling `frsubs`, markup metered `frpayg`, guard supply frcheap, scrub anomali saldo.

**TIDAK dibangun sekarang (non-goal):** (a) katalog 3× / prefix publik `frcheap/` — ditunda ke K11; (b) gateway pembayaran otomatis — tetap QRIS manual + verifikasi admin (evidence §1, `payment.channel='admin|telegram|discord'`, 0025); (c) backfill harga pokok untuk seluruh 728 mapping sekaligus — hanya top-N provider aktif; (d) tabel `usage_daily`/`usage_hourly` tidak ditulis ulang histori (21.465 baris); kolom baru aditif.

---

## 3. Model ekonomi

### 3.1 Tiga bucket — siapa bayar apa

| Bucket | Supply (asal biaya) | Member bayar | Kita bayar | Biaya per token |
|---|---|---|---|---|
| `frcheap` | akun farm/gratis (`credential.acquisition='farmed'`) | 100.000 IDR / 28d (flat) | ~0 + churn akun | `provider_cost_micro = 0` (terverifikasi farmed) |
| `frpayg` | provider metered (OpenRouter dll) | saldo prabayar, debit per token | per-token ke provider | `provider_cost_micro` riil dari `provider_cost_rule` |
| `frsubs` | subscription/OAuth flat-fee | 150–500k IDR / 28d (flat) | langganan flat + risiko throttle | `provider_cost_micro = NULL` (flat sudah dibayar; TIDAK 0) |

Precedence bucket efektif: **subscription live → `api_key.economic_bucket` → `billing_account.bucket` → `'frpayg'`**. Dihitung sekali di admission, cache 60s bersama key (pola `LiveSubscription`, subscription.go:38-50), dipakai identik di admission & charge.

### 3.2 Aritmetika kuota frsubs (angka nyata, bukan klaim)

FX = **16.000 IDR/USD** (asumsi eksplisit semua paper; disimpan `bucket_quota.fx_idr_per_usd`, seed sekali).

```
limit_micro_usd(5h) = 50.000 IDR  × 1e6 / 16.000 = 50.000.000.000 / 16.000 = 3.125.000 µUSD
limit_micro_usd(7d) = 500.000 IDR × 1e6 / 16.000 = 500.000.000.000 / 16.000 = 31.250.000 µUSD
```

Konversi ke token (harga retail blended **asumsi $0.30/1M = 300.000 µUSD/1M**):

```
token(5h) = 3.125.000 µUSD ÷ 300.000 µUSD/1M × 1e6 = 10.416.666 ≈ 10,4M token
token(7d) = 31.250.000 µUSD ÷ 300.000 µUSD/1M × 1e6 = 104.166.666 ≈ 104M token
```

**Konsistensi dengan harga plan 150–500k IDR/28d:** plan 150k = 150.000×1e6/16.000 = **9.375.000 µUSD retail-equivalent per 28d**. Kuota 7d (31,25M) mengizinkan ≈ **3,3× nilai retail plan per minggu** (≈13,3× per 28d). Ini **bukan nilai yang dijual**, dan itu benar: `subscription` berbasis WAKTU, bukan token (0025: `plan` check `sub_1d..sub_28d`, metering "feeds abuse detection", 0025:6-9). Kuota adalah **fair-use stop-loss** terhadap arbitrase (key frsubs mem-front traffic frpayg dengan biaya marjinal nol), bukan denominasi nilai. Denominator retail-equivalent (bukan COGS) karena COGS frsubs adalah langganan flat sehingga tidak bisa jadi satuan meter.

**Floor anti-arbitrase (invariant, bukan kuota):** `meter_price = max(pricing_rule_retail, floor)`; `floor = ceil(provider_plan_cost_micro_30d × 1e6 / effective_allowance)`. Angka `effective_allowance` & `throttle_headroom_bps` adalah default operator di `bucket_quota`, bukan invariant.

---

## 4. Skema (DDL final)

### 4.1 `0033_economic_bucket.sql` (aditif, tidak gated)

```sql
-- Bucket pembeli kanonik + join supply + provenance COGS. Semua kolom aditif.
ALTER TABLE billing_account ADD COLUMN IF NOT EXISTS bucket text DEFAULT 'frpayg';
ALTER TABLE api_key          ADD COLUMN IF NOT EXISTS economic_bucket text;   -- override PAYG per-key, nullable
ALTER TABLE subscription     ADD COLUMN IF NOT EXISTS economic_bucket text;
ALTER TABLE credential       ADD COLUMN IF NOT EXISTS acquisition text DEFAULT 'unknown';
ALTER TABLE credential       ADD COLUMN IF NOT EXISTS cost_basis_micro_per_day bigint;

CREATE TABLE IF NOT EXISTS provider_model_supply (
  provider_model_id text NOT NULL REFERENCES provider_model(id) ON DELETE CASCADE,
  bucket            text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_model_id, bucket)
);

-- Snapshot per-baris: debit vs meter vs COGS terpisah.
ALTER TABLE request_log ADD COLUMN IF NOT EXISTS bucket text;
ALTER TABLE request_log ADD COLUMN IF NOT EXISTS supply_bucket text;
ALTER TABLE request_log ADD COLUMN IF NOT EXISTS billing_basis text NOT NULL DEFAULT 'retail';
ALTER TABLE request_log ADD COLUMN IF NOT EXISTS cost_basis text NOT NULL DEFAULT 'retail';
ALTER TABLE request_log ADD COLUMN IF NOT EXISTS markup_millionths bigint NOT NULL DEFAULT 1000000;
ALTER TABLE request_log ADD COLUMN IF NOT EXISTS quota_usage_micro bigint;   -- meter retail frsubs (NULL=belum dimeter)
ALTER TABLE request_log ADD COLUMN IF NOT EXISTS cogs_estimated_micro bigint;

-- backfill legacy (hanya snapshot; tidak menyentuh cost/usage_daily)
UPDATE request_log SET bucket='frpayg', billing_basis='retail', cost_basis='retail'
       , markup_millionths=1000000 WHERE bucket IS NULL;
UPDATE billing_account SET bucket='frpayg' WHERE bucket IS NULL;
UPDATE credential SET acquisition='unknown' WHERE acquisition IS NULL;

CREATE INDEX IF NOT EXISTS request_log_bucket_created_idx ON request_log (bucket, created_at);
CREATE INDEX IF NOT EXISTS request_log_user_quota_idx ON request_log (user_id, created_at)
  INCLUDE (quota_usage_micro) WHERE quota_usage_micro IS NOT NULL;
```

### 4.2 `0034_economic_cost.sql` (tabel harga + margin + kuota, aditif)

```sql
-- Harga pokok riil per mapping, mirror pricing_rule (specific-beats-wide, newest wins).
CREATE TABLE IF NOT EXISTS provider_cost_rule (
  provider_model_id text NOT NULL REFERENCES provider_model(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1,
  currency char(3) NOT NULL DEFAULT 'USD',
  input_price numeric(18,6) NOT NULL,
  cached_input_price numeric(18,6),
  output_price numeric(18,6) NOT NULL,
  reasoning_price numeric(18,6),
  source text NOT NULL,          -- 'farm_zero' | 'subscription_flat' | 'invoice' | 'declared'
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_until timestamptz,
  PRIMARY KEY (provider_model_id, version)
);
CREATE INDEX IF NOT EXISTS provider_cost_rule_live_idx ON provider_cost_rule
  (provider_model_id, version) WHERE effective_until IS NULL;

-- Markup per (bucket, model, provider_model), integer; 1_000_000 = 1.0.
CREATE TABLE IF NOT EXISTS bucket_margin (
  id text PRIMARY KEY,
  bucket text NOT NULL,
  model_id text NOT NULL REFERENCES model(id) ON DELETE CASCADE,
  provider_model_id text,
  markup_millionths bigint NOT NULL DEFAULT 1000000,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_until timestamptz,
  CONSTRAINT bucket_margin_markup_check CHECK (markup_millionths >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS bucket_margin_version_idx ON bucket_margin
  (bucket, model_id, COALESCE(provider_model_id,''), effective_from);

-- Kuota rolling frsubs + knob operator.
CREATE TABLE IF NOT EXISTS bucket_quota (
  bucket text NOT NULL, quota_window text NOT NULL, version integer NOT NULL DEFAULT 1,
  limit_micro_usd bigint NOT NULL, fx_idr_per_usd integer NOT NULL,
  allowance_token_30d bigint, throttle_headroom_bps integer,
  min_sample_attempts integer DEFAULT 100, min_sample_credentials integer DEFAULT 10,
  effective_from timestamptz NOT NULL DEFAULT now(), effective_until timestamptz,
  PRIMARY KEY (bucket, quota_window, version),
  CONSTRAINT bucket_quota_window_check CHECK (quota_window IN ('5h','7d')),
  CONSTRAINT bucket_quota_limit_check CHECK (limit_micro_usd > 0)
);
INSERT INTO bucket_quota (bucket,quota_window,version,limit_micro_usd,fx_idr_per_usd)
VALUES ('frsubs','5h',1,3125000,16000), ('frsubs','7d',1,31250000,16000)
ON CONFLICT DO NOTHING;
-- `window` adalah reserved word di Postgres: kolomnya WAJIB `quota_window`.
-- Diverifikasi: DDL dengan `window` gagal `syntax error at or near "window"`.
```

### 4.3 `0035_economic_enforce.sql` (gated: writer emit bucket dulu)

Pola runner `-- gated:` ditahan sampai writer cutover satu commit (`ops/migrate.sh:62-65`).

```sql
-- gated: writers must emit bucket/basis before tightening.
ALTER TABLE billing_account ALTER COLUMN bucket SET NOT NULL;
ALTER TABLE billing_account ADD CONSTRAINT billing_account_bucket_check
  CHECK (bucket IN ('frcheap','frpayg','frsubs'));
ALTER TABLE api_key      ADD CONSTRAINT api_key_bucket_check
  CHECK (economic_bucket IS NULL OR economic_bucket IN ('frcheap','frpayg','frsubs'));
ALTER TABLE subscription ADD CONSTRAINT subscription_bucket_check
  CHECK (economic_bucket IS NULL OR economic_bucket IN ('frcheap','frpayg','frsubs'));
ALTER TABLE credential   ADD CONSTRAINT credential_acquisition_check
  CHECK (acquisition IN ('farmed','payg','oauth','unknown'));
ALTER TABLE request_log  ADD CONSTRAINT request_log_billing_basis_check
  CHECK (billing_basis IN ('retail','provider'));
ALTER TABLE request_log  ADD CONSTRAINT request_log_cost_basis_check
  CHECK (cost_basis IN ('farm_zero','subscription_flat','provider','retail','unknown'));

-- MARKUP ARITMETIKA — bentuk KOREKSI (IS NOT NULL eksplisit).
-- Versi tanpa IS NOT NULL BUG: NULL * x = NULL, dan CHECK hanya gagal pada FALSE,
-- sehingga markup>1.0 + provider_cost NULL lolos diam-diam (parent membuktikan di PG17).
ALTER TABLE request_log ADD CONSTRAINT request_log_markup_basis_check CHECK (
  markup_millionths <= 1000000
  OR (
    billing_basis = 'provider'
    AND cost_basis = 'provider'
    AND provider_cost_micro IS NOT NULL
    AND currency = 'USD'
    AND cost = (provider_cost_micro * markup_millionths + 500000) / 1000000
  )
);

-- Tiga-nilai provider_cost: 0 (farmed) vs NULL (flat) wajib konsisten.
-- IS NOT DISTINCT FROM, BUKAN `= 0`: `provider_cost_micro = 0` bernilai NULL
-- saat kolomnya NULL, dan CHECK hanya gagal pada FALSE — sehingga baris
-- farm_zero TANPA bukti COGS nol diterima. Dibuktikan di PG17: baris t4 lolos
-- dengan versi `= 0`, dan ditolak dengan versi ini.
ALTER TABLE request_log ADD CONSTRAINT request_log_farm_zero_check
  CHECK (cost_basis <> 'farm_zero' OR provider_cost_micro IS NOT DISTINCT FROM 0);
ALTER TABLE request_log ADD CONSTRAINT request_log_subscription_flat_check
  CHECK (cost_basis <> 'subscription_flat' OR provider_cost_micro IS NULL);

-- 'retail'/'unknown' tidak boleh mengklaim COGS nol (itu klaim farm_zero).
ALTER TABLE request_log ADD CONSTRAINT request_log_unknown_cogs_check
  CHECK (cost_basis NOT IN ('retail','unknown') OR provider_cost_micro IS NULL);
```

**Test yang WAJIB ditulis** — sudah dijalankan di PG17 (scratch DB `frddl_test2`, migrasi penuh 0000→0035). Hasil aktual:

| # | Kasus | Harus | Hasil nyata |
|---|---|---|---|
| T1 | `markup=1.3` + `provider_cost=NULL` | tolak | **ditolak** `request_log_markup_basis_check` |
| T2 | `markup=1.3` + `pc=1000` + `cost=1300` | terima | diterima |
| T3 | `farm_zero` + `pc=0` | terima | diterima |
| T4 | `farm_zero` + `pc=NULL` | tolak | **ditolak** `request_log_farm_zero_check` |
| T5 | `subscription_flat` + `pc=NULL` | terima | diterima |
| T6 | `markup=1.3` + `cost=9999` (aritmetika salah) | tolak | **ditolak** `request_log_markup_basis_check` |
| T7 | `markup=1.3` + `billing_basis='retail'` | tolak | **ditolak** `request_log_markup_basis_check` |

Dua defect ditemukan justru karena test ini dieksekusi, bukan diklaim:

1. **`bucket_quota.window`** — `window` reserved word di Postgres; DDL gagal `syntax error at or near "window"`. Diganti `quota_window` (lihat §4.2).
2. **`request_log_farm_zero_check` versi pertama** (`provider_cost_micro = 0`) **meloloskan T4**, karena `NULL = 0` bernilai NULL dan CHECK hanya gagal pada FALSE. Diganti `IS NOT DISTINCT FROM 0` (lihat §4.3).

Dua hal ini membuktikan aturan yang harus dipegang saat implementasi: **CHECK constraint harus diuji dengan baris NULL, bukan hanya baris sah.** Tanpa T1/T4/T6/T7, ketiga constraint akan lolos code review dan baru ketahuan saat produksi menagih salah.

---

## 5. Hot path

Urutan: **admission → resolve → charge** (titik edit persis).

1. **Admission** — `proxy/lifecycle.go` `finish()` dipanggil di akhir request; gate ada di `proxy/budget.go:38` `checkBudgets`. Tambahkan di sini: (a) resolve `bucket` (K2 precedence), cache 60s; (b) hard-stop saldo bila `FreeAccessNoPaymentGateway=false` (`budget.go:63`); (c) baca kuota frsubs (K6) `used + meter > limit` → 402.

2. **Resolve harga** — `proxy/lifecycle.go:1289-1312` `buildRow`. Pisahkan debit vs meter:
   - `row.Cost` = debit customer. `frpayg`: `pc = cost.ComputeUsage(provider_cost_rule prices)`; `cost = (pc × markup_millionths + 500000)/1000000` bila `pc` non-NULL; bila NULL (`cost_basis IN ('retail','unknown')`) passthrough `cost = ComputeUsage(retailPrices)`. `frcheap`/`frsubs`: `cost = 0`.
   - `row.ProviderCostMicro` = COGS (3 nilai): `farm_zero→0`, `subscription_flat→NULL`, `provider→pc`, `retail/unknown→NULL`. Ganti `row.ProviderCostMicro = row.Cost` (`lifecycle.go:1312`).
   - `row.QuotaUsageMicro` = `ComputeUsage(retailPrices)` HANYA untuk `frsubs` (meter fair-use); NULL untuk bucket lain.
   - `row.MarkupMillionths`, `row.BillingBasis`, `row.CostBasis` di-set buildRow.

3. **Charge** — `store/billing.go:154-155` mirror `CreditChargedMicro = Cost` tetap; `ChargeRequest` menagih `-r.Cost` (`billing.go:233`). Flat-fee (`cost=0`) tetap menulis `usage_charge` idempoten `-0` (idempotency `usage:<request_id>`, billing.go:116). Revenue flat terjadi SEKALI via `credit_purchase`/`payment` (bukan per request).

**Rumus integer (tanpa float, `math/big`):**
```
ComputeUsage(tin_cached, tin, tout_reason, reason, pIn, pCached, pOut, pReason)  # cost.go:66
divRound(a,b) = (a*b + 1e12/2) / 1e12                                          # cost.go:71 (half-up)
markup(a, mm) = (a*mm + 500000) / 1000000                                       # half-up, bigint
```

---

## 6. Kuota frsubs

- **Counter**: Valkey period-keyed `quota:frsubs:{acct}:{5h|7d}:{floor(now/period)}`, TTL `5h+Δ` / `7d+Δ`, satuan **micro-USD** (nol konversi per request). Key period-named persis pola `budget.go:121,129-131`.
- **Baca**: di admission (`checkBudgets`) satu `GetJSON` 2s (pola `budget.go:134`); miss → fallback `SUM(coalesce(credit_charged_micro,cost))`... **tetapi untuk frsubs debit=0**, jadi fallback yang benar: `SpendMicro`-style atas `quota_usage_micro` (kueri baru di `store/billing.go`, pola `billing.go:321`), filter `status IN ('success','cancelled') AND quota_usage_micro IS NOT NULL`.
- **Tulis**: di `finish()` SETELAH `ChargeRequest` sukses (pola `budgetSpendAdd`, budget.go:146), dari `quota_usage_micro` aktual — **bukan INCRBY saat admission** (menghindari overcount retry storm `limits.go:583-584`). Retry 429 tanpa `total_tokens` tidak ikut.
- **Fail mode**: Valkey down → counter miss → re-verifikasi DB (`SpendMicro`). **Error DB → REFUSE 503/402 (fail-closed), tidak open** — beda dari `limits.allowTokens` yang degradasi ke in-process (limits.go:583-590), karena kuota ini membatasi SPEND berbayar, bukan rate. `provider_cost`/ledger tetap idempoten.
- **Charge fallback**: tidak pernah membaca `balance_micro` (cache korup 5,55e18).

---

## 7. Katalog & prefix

- **Prefix publik: ditunda sekarang (OptB menang).** `/v1/models` tanpa auth (`models.go:30`) → mempublikasikan model farm-backed = daftar target drain gratis; juga harga yang dirender publik (`pricing.input/output`) adalah harga retail, bukan penawaran flat-fee (klien mengira frcheap metered). Guard supply sudah jalan tanpa prefix lewat `provider_model_supply` di resolver.
- **Bentuk saat dibuka (OptA menang): SATU prefix `frcheap/<canonical-slug>`, bukan katalog 3×.** Resolver strip prefix → filter `provider_model_supply.bucket='frcheap'` → key non-frcheap 403. Capacity `len(models)*2` tidak berubah signifikan (≤383 entri tambahan, bukan ×6). Tidak menambah target probe: sweep per-`family` dari `cachedModels` (health.go:216-228), prefix dirender bukan di-sweep (OptB-2 cabut argumen probe).
- **Syarat buka (go/no-go K11):** (a) ≥1 subscription frcheap aktif terjual; (b) `credential.acquisition='farmed'` coverage ≥X% + invalid rate < 0,10; (c) circuit breaker `θ_rate_limited=0.02` terpasang. Tanpa ketiganya prefix tetap off.

---

## 8. Invariant

1. `markup_millionths > 1000000` ⇒ `billing_basis='provider' ∧ cost_basis='provider' ∧ provider_cost_micro IS NOT NULL ∧ currency='USD' ∧ cost=divRound(pc×markup)`. **CHECK `request_log_markup_basis_check`** + test (section 4.3). Tidak ada markup di atas retail/alias.
2. `provider_cost_micro` tiga-nilai eksplisit: `farm_zero→0` bila terbukti `credential.acquisition='farmed'`; `subscription_flat→NULL`. **CHECK `farm_zero_check` + `subscription_flat_check`**; 0 tidak pernah dibaca "gratis" tanpa bukti farmed.
3. `provider_cost_rule.source='farm_zero'` wajib memverifikasi `credential.acquisition='farmed'`. **Runtime** di resolver biaya; null→fallback retail passthrough.
4. Ledger/billing tidak pernah membaca `balance_micro`. **Runtime** — penerima uang adalah SUM(ledger), `billing.go:116-122`; `reconcileAll` (billing.ts:279-290) TIDAK dijalankan sebelum scrub anomali.
5. Sebelum `FreeAccessNoPaymentGateway=false` (`limits.go:81`): scrub + reconcile `balance_micro` dua kali di staging; `credit_ledger` anomali (5,55e18) dibersihkan dgn provenance `idempotency_key` asli. **Prosedur operasi** (bukan CHECK).
6. `frsubs` meter = retail-equivalent `pricing_rule`, bukan `provider_cost_rule`. **Runtime** — kolom `quota_usage_micro` ditulis dari `resolvePricing()` (`pricing.go:131`).
7. Resolusi & billing tetap slug MENTAH; alias hanya presentasi (`catalog.go:60`, displayFamilyCTE). Anti-arbitrase: allowlist `model_alias_target` mengecualikan varian `:free`, plus `meter_price=max(retail,floor)`. **Runtime + test**.
8. Kuota counter hilang ⇒ DB fallback; DB error ⇒ refuse. **Runtime fail-closed** (berbeda dari rate-limiter fail-open vk.go:8-13).

---

## 9. Rollout

| Fase | Isi | Go/no-go numerik |
|---|---|---|
| F0 | Migrasi 0033 aditif + 0034 (tabel) terpasang; backfill snapshot legacy `bucket='frpayg'` | 0 error `migrate.sh`; 549.869 baris ter-backfill `billing_basis='retail'` |
| F1 | Scrub anomali `balance_micro`/`credit_ledger` di staging; reconcile 2× | Σledger == Σbalance; anomali 5,55e18 hilang |
| F2 | Writer emit bucket + basis; **0035 gated dibuka** | CHECK lulus; 0 `check_violation` di CI/prod; test §4.3 hijau |
| F3 | `provider_cost_rule` backfill top-N provider aktif frpayg | cakupan ≥80% request berbayar 30d punya `cost_basis='provider'`; frpayg passthrough markup=1.0 bila di bawah |
| F4 | Markup frpayg nyala (markup>1.0) | hanya setelah F3; `billing_basis='provider'` baris >0 dan 0 `markup_basis_check` violation |
| F5 | Kuota frsubs live | ≥1 subscription frsubs aktif; counter miss→DB fail-closed teruji injeksi |
| F6 | Prefix `frcheap/` (K11) | ≥1 frcheap sub aktif + invalid<0,10 + circuit breaker hidup |
| Rollback | 0035 di-drop -> passthrough; tidak ada rewrite histori | — |

Metrik go/no-go panjangan: `charged>cost` harus naik dari 0 hanya di bucket/provider dgn COGS riil; `rate_limited` ratio < 0,02 (fenomena 170.556/172.541 insiden 1 Nov tidak terulang).

---

## 10. Risiko terbuka

1. **`provider_cost_rule` tak pernah terisi** → frpayg stuck passthrough, layer ekonomi dekoratif (SeniorB risiko-diri). Mitigasi F3/F4, tapi tidak ada kepastian operator mengisi tanpa tekanan pendapatan.
2. **CHURN akun frcheap** = biaya tak terukur (`cogs_estimated_micro` belum terisi; 25.997 unknown / 1.476 invalid). COGS frcheap tetap estimasi sampai operator triase credential.
3. **Satu operator** (3 kelas tiket: verifikasi QRIS, farming manual-only `farmpolicy.go:8-9`, triase insiden) adalah single point of failure; desain ini tidak menghilangkan beban itu.
4. **Harga pokok FRSUBS flat** (biaya langganan provider riil per bulan) belum punya kolom; `floor_price` memakai `provider_plan_cost_micro_30d` yang masih placeholder sampai operator mengisi angka plan nyata.
5. **FX statis 16.000** jadi basi bila rupiah bergerak signifikan; `bucket_quota` berversi untuk bump, tapi tidak ada autorefresh.