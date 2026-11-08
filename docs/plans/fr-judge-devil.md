# FR-JUDGE-DEVIL — Devil Advocate: judge brutal atas rencana fudrouter

> Fase: HARD GATE planning. Tidak ada kode repo yang diubah.
> Base: `local://fr-plan-brief.md`, `local://fr-plan-pm.md`, `local://fr-plan-tl.md`.
> Verifikasi klaim langsung ke `ssh://dwizzy/~/fudrouter` (HEAD f718087, branch feat/economic-layer).

---

## 1. Serangan (≥8, diurut fatal dulu)

### S1 — `reconcileAll` guard A2 cuma pindah coreng, tidak menyelesaikan overflow (P0)
**Rujukan**: PM §1 A2 (`packages/platform/server/billing.ts ~L275-290`), Sprint 1 DoD "reconcileAll tidak lagi bigint out of range"; TL K6(1).

Fakta yang saya baca langsung dari `billing.ts:275-290`: query sudah `sum(c.amount_micro) as total` lalu `coalesce(d.total, 0)::bigint`. Kolom `credit_ledger.amount_micro` adalah `bigint` (`schema.ts:625`), `billing_account.balance_micro` juga `bigint` (`schema.ts:608`). Dua baris korup bernilai `5.55e18` µUSD **masing-masing** — jumlahnya `1.11e19`, yang **melebihi int64 max (9.22e18)**.

Guard yang diusulkan ("sum di numeric(40,0)" atau "cast tersembunyi/out-of-range disisihkan") **tidak mengubah apa pun**: PostgreSQL `sum(bigint)` sudah mengembalikan `numeric`; letusan ada di `::bigint` DAN di `UPDATE ... SET balance_micro = w.total` karena kolom tujuan bigint tidak bisa menampung `1.11e19`. Mau di-cast di CTE, mau di `SET`, nilainya tetap harus jadi bigint. Satu-satunya cara mengisolasi akun adalah **mengecualikan/men-clamp total yang > int64 pada sisi SQL** (mis. `FILTER (WHERE ...)` atau `NULLIF` total absurd) atau benar-benar loop per-akun dengan tangkap-error — dan opsi kedua itu regresi properti atomic fleet-repair yang justru dirayakan di komentar `billing.ts:257-277`.

Konsekuensi: Sprint 1 DoD yang ditulis ("tidak lagi out of range") tidak bisa dipenuhi oleh guard yang diusulkan. Kerja berat yang sebenarnya menyelesaikan insiden adalah **A1 scrub**, sementara A2 menyumbang ilusi bahwa sistem sekarang tahan terhadap akun korup berikutnya — ia tidak.

### S2 — Tidak ada subscription gate di data plane; flip B4 = self-lockout akun "sehat" yang tidak tertangkal (P0)
**Rujukan**: PM §5 "tidak ada akun sehat self-lockout"; TL T-J DoD; brief F1 #3.

Saya baca `entitlement/guard.go` — `CheckSubscription` (`guard.go:199-208`) dan `RuleNoSubscription`/`RuleExpired` **didefinisikan**, tapi grep ke seluruh `backend/go/internal/` menegaskan **tidak ada satu pun call-site** yang memanggil `CheckSubscription`/`LiveSubscription` dari hot path. Hadir di `store/subscription.go` hanya dipakai `economic_resolve.go` untuk **preferensi bucket**, bukan untuk menolak admission.

Satu-satunya gerbang uang data plane adalah `checkBudgets` (`proxy/budget.go:37-53`): `balanceMicro <= hardStopThresholdMicro` → 402, dengan `hardStopThresholdMicro` default **0** (`schema.ts:607`). Gateway langganan tidak dilibatkan sedikit pun.

Skenario self-lockout akun sehat yang TIDAK tertangkap acceptance T-J:
- Pelanggan **frsubs** membeli 7 hari. B3 menulis `subscription` (entitlement) dan `credit_purchase` (balance). **Tapi** jika `subscription.economic_bucket` tidak di-set `frsubs` oleh grant writer (lihat S3), `resolveBucket` fall-through ke `billing_account.bucket` → default `frpayg` = **prepaid per-token**, saldo terkuras, saat 0 → 402 padahal "punya 7 hari" masih berjalan.
- Lebih fundamental: karena `Guard.CheckSubscription` tak pernah dipanggil, member yang punya `subscription` live tapi `balance_micro = 0` (habis di bucket prepaid, atau admin set threshold, atau drift) **tetap kena 402**. "Sehat" dalam DoD T-J didefinisikan cuma "ada top-up nyata" — bukan "punya entitlement live" — sehingga acceptance-nya lulus sementara bug memblokir pembayar nyata.

### S3 — Grant writer tidak diwajibkan menulis `economic_bucket='frsubs'`; janji "7 hari = flat" bisa jadi drain prepaid (P0/P1)
**Rujukan**: PM B2/B3, TL T-D ("payment.confirm → subscription row idempoten"); `resolveBucket` di `lifecycle.go:833-…`.

Precedence bucket (design §3.1, `lifecycle.go`): live subscription → **`subscription.economic_bucket`** → `api_key.economic_bucket` → `billing_account.bucket` → `frpayg`. Kolom `subscription.economic_bucket` nullable (kendala 0035 `subscription_bucket_check` membolehkan NULL). Plan B2/B3 menspesifikasikan grant = "status confirmed → subscription row (expires_at, price_idr)", **tanpa menyebut** kolom `economic_bucket`.

Jika grant writer tidak eksplisit menulis `economic_bucket='frsubs'`, kolom NULL → resolusi jatuh ke `frpayg`, dan member "7 hari" ditagih per-token. `resolveGrant` di `payments.ts` hanya menghitung `expiresAt` dari `days`, sama sekali tidak menyentuh bucket. Ini bug integrasi lintas-boundary yang persis ditangkap oleh aturan: tipe/nilai baru (`subscription` hasil grant) disilangkan ke consumer (`resolveBucket`) tanpa jaminan branch yang benar. DoD T-D harusnya menyebut "grant menulis economic_bucket='frsubs'" — tidak ada.

### S4 — B3 mengacu "pola `deliverWebhook`" padahal itu outbound; inbound webhook payment tidak ada (P1)
**Rujukan**: PM B3 (`webhooks.ts` pola `deliverWebhook` + `payments.ts`), TL K9(b), K11.

`packages/platform/server/webhooks.ts` yang saya baca **100% outbound**: `dispatchEvent` + `deliverWebhook` menandatangani (`X-FUD-Signature`) dan mengirim. Grep ke `index.mjs`/`admin.mjs` tidak menemukan **receiver inbound** apa pun. Jadi HMAC-verify, anti-replay, idempotensi, dan SSRF yang dijanjikan B3 harus **dibangun dari nol** — padahal rencana merujuk pola `deliverWebhook` seolah tinggal pakai. Lebih dari itu, SSRF `assertPublicUpstream` adalah guard **sisi pengirim** (blokir URL target privat); arah inbound (gateway memanggil kita) tidak dilindungi olehnya.

Konsekuensi: estimasi usaha B3 (RICE E=5, Strategic) meremehkan pekerjaan; risiko replay/double-grant dan signature yang salah lemah adalah risiko nyata saat gateway QRIS retransmit webhook. DoD "replay = no double-post" bergantung pada `payment.gateway_ref` UNIQUE (`0025`) — itu masih harus diimplementasikan di handler yang belum ada.

### S5 — Namespace idempotensi `purchase:<ref>` bentrok/beririsan dengan placeholder yang ada (P1)
**Rujukan**: PM B2 (`idempotency_key = purchase:<ref>`), `pages.mjs:513/522` (`purchase:${newId(prefixFor(...))}`).

Path add-credit yang ada (`pages.mjs:522`) memakai key `purchase:<uuid>` untuk `credit_purchase` placeholder, dan endpoint `/billing/credits` mengembalikan `addCreditKey: purchase:<uuid>`. Saat B2 mengklaim semua `credit_purchase` memakai `purchase:<ref>` (ref gateway = `qris_<channel>_<ts>_<hex>`, `pages.mjs:657`), dua skema klaim namespace `purchase:*` dengan sumber yang berbeda. `postLedger` menolak dengan `onConflictDoNothing` pada `idempotency_key`, jadi benturan key = pembayaran sah dibuang diam-diam (`applied:false`) atau, lebih buruk, placeholder lama "memenangkan" slot sebelum webhook tiba. Tidak ada migrasi/rename namespace lama (`purchase:` → `gateway:`/`payment:`) dalam rencana; ini celah idempotensi silent-drop.

### S6 — D4 (kuota frsubs) & retry-storm 1 Nov: kuota seeded terlalu kecil dan baru hidup bila ada subscriber `frsubs` (P1/P2)
**Rujukan**: PM D4, brief insiden 172k, `0034` seed `bucket_quota` (5h=3125000, 7d=31250000 micro-USD, FX 16000), `budget.go:checkFrsubsQuota`.

`checkFrsubsQuota` langsung `return nil` untuk bucket ≠ `frsubs` (`budget.go:405-407`). Artinya seluruh lapisan fair-use **baru aktif jika ada subscriber yang resolve ke frsubs**. Rencana menempatkan D4 "paralel" dengan D1–D3 tanpa gate eksplisit "ada ≥1 subscription bernilai frsubs", padahal produsen nilai itu (grant writer yang menulis `economic_bucket`) belum ada di D4 sendiri (lihat S3). Akibat: pada momen flip, lapisan kuota bisa **diam-diam berstatus no-op** dan dianggap "live" oleh DoD.

Kedua, seed limit sangat rendah: 5h = `3125000` micro-USD ≈ $3.13, 7d = $31.25. Insiden 1 Nov 170.556/172.541 request (spec economic-layer §rate_limited) dengan retry-storm akan menembus jendela itu dalam hitungan menit untuk satu member frsubs. Guard menulis `quotaSpendAdd` **di `finish()` setelah ChargeRequest sukses** — retry 429 yang gagal sebelum finish *tidak* dihitung (kata spec), tapi permintaan **berhasil** dalam storm yang sama tetap dihitung penuh. Belum ada simulasi/ujian beban yang memvalidasi angka seed $3.13/$31.25 terhadap profil member nyata; rencana hanya bilang "injection test counter-miss", bukan validasi kalibrasi limit terhadap 172k.

### S7 — Ketergantungan berlebih bahwa "adapter bot tipis benar-benar tipis" disangkal oleh kenyataan `discord.mjs` & ketiadaan payload (P1)
**Rujukan**: PM C1/C2, TL K10, `discord.mjs` (55 ln, `joinFudcourt` guild-join), `bots.ts:20`.

Asumsi yang diulang ("C1/C2 transport saja, 0 duplikasi, call `bots.ts`") menganggap decision core sudah lengkap dan hanya menunggu I/O. Nyatanya `bots.ts` murni **tanpa status akun, tanpa persistensi claim, tanpa antrean approve, tanpa sumber bukti gambar**. Endpoint web yang saya baca di `pages.mjs:660-686` membuktikan seluruh orbit nyata — `payment` insert (`checkout`), `payment.claim` (simpan `proofUrl`), `status='confirmed'` — **belum tersedia sebagai callable shared-TS** untuk bot. Tidak ada `grantSubscription`/writer `subscription`/publish-key yang bisa dipanggil adapter (grep kosong). Jadi adapter "tipis" harus menulis sendiri: (a) penyimpanan claim `payment`, (b) resolusi bukti gambar, (c) pemanggilan writer yang belum ada, (d) handling antrean `@zupaxx` offline. Itu bukan transport 55 ln; itu fitur inti pembayaran yang dibajak ke dalam file bernama "adapter" — melanggar aturan anti-redundant §3.3 yang sama.

### S8 — RICE "quick-win" menggantung tanpa gate; rencana mengeksekusi leverage palsu (P2)
**Rujukan**: PM §6 tabel RICE + "urutan yang benar", `flowchart` dependency.

Label quick-win dipakai untuk A1/A2/A3/C1/C2/E1/E2/D1. Tetapi: A1 (score 90) adalah **operasi manual staging→prod dengan rollback**, bukan kode; A2 (42.8) guard-nya hampa (S1); C1/C2 (14.9/13.1) diblokir oleh B (gateway/payment loop) yang DICLAIM bisa paralel padahal membutuhkan `bots.ts`+writer yang belum ada (S7); D1 "quick-win verifikasi" digate oleh writer-cutover yang belum terjadi; B4 scored 70 tapi gated. Menjejerkan label quick-win tanpa kolom "gate prasyarat" membuat pemilik task menarik C1 ke Sprint dan menemukan 80% dependensi tersembunyi — persis "quick win that isn't". Kanban WIP (Sprint=6) tidak punya kolom dependency-block, hanya pull-order.

### S9 — Satu operator/SPOF tidak berkurang, malah bertambah permukaan & tiket (P2)
**Rujukan**: PM pain point 5 + §5 validasi; TL A/E/I.

Rencana mengaku mengurangi "3 kelas tiket manual" lewat B1/B3, tapi validasi §5 sendiri mengakui: anti-fraud screenshot tetap manual, farm tetap manual, dan approval bot bergantung **satu admin `@zupaxx`** tanpa eskalasi. Alih-alih mengurangi SPOF, rencana **menambah** 2 adapter bot, 1 gateway, inbound webhook, dan editor lan operasional yang semuanya tetap menyempit ke `@zupaxx` untuk tombol Yes/No. Tidak ada task untuk on-call rotation, delegasi approve, atau fallback jika admin offline. Klaim pain-point-5 ("gateway kurangi verifikasi manual") tidak punya acceptance yang mengukur turunnya tiket; ia cuma memindahkan letak bottleneck.

---

## 2. Asumsi berbahaya

| # | Asumsi tersirat | Sinyal bahwa ia salah | Yang harus dipersiapkan bila benar |
|---|---|---|---|
| 1 | `reconcileAll` cukup didempul `numeric` agar tahan overflow | Kolom korup `5.55e18 ×2 > int64`; kolom tujuan `balance_micro bigint` tak bisa tampung | Desain ulang query: `FILTER`/exclude total > int64, atau saturate+flag akun untuk triase manual — bukan cuma `::bigint` |
| 2 | Grant = cukup `expires_at`+`price_idr`; bucket otomatis benar | `subscription.economic_bucket` nullable; `resolveGrant` tak sentuh bucket | Grant writer WAJIB set `economic_bucket='frsubs'`; test integrasi: beli 7d → resolve ke `BucketSubs`, bukan `frpayg` |
| 3 | Adapter Discord/Telegram tinggal "render reply" | `discord.mjs` hanya guild-join; tak ada shared-TS untuk claim/grant/publish | Samakan acceptance: adapter memanggil handler pembayaran yang dibangun lebih dulu; jangan misclass logic inti sebagai transport |
| 4 | Inbound webhook payment bisa meniru pola `deliverWebhook` | `webhooks.ts` murni outbound; tak ada receiver inbound | Bangun inbound verify (HMAC, anti-replay, `gateway_ref` idempotent, SSRF-inbound) sebagai task eksplisit, bukan referensi pola |
| 5 | Flip B4 aman bila "ada top-up nyata" | Balance-gate `<=0` tak melihat subscription; subscription gate tak di-wire | Sebelum flip: wire `entitlement` ke hot path, atau set threshold/subscription-aware; uji akun `balance=0`+live-subscription |
| 6 | Retry-storm 172k tak meledakkan kuota frsubs karena `quotaSpendAdd` di `finish()` | Seed $3.13/$31.25; permintaan sukses dihitung penuh; tak ada uji beban | Kalibrasi `bucket_quota` ke profil nyata; uji storm dengan hitungan request berhasil |
| 7 | Satu admin `@zupaxx` cukup untuk approval | Rencana sendiri mengakui "antrean mandek bila offline" | Rancang delegasi/eskalasi approve sebelum sprint bot, atau terima dan dokumentasikan batas SPOF (bukan klaim "mengurangi") |
| 8 | Semua korupsi terbatas 2 baris & 1 akun drift | Titik injeksi placeholder (`pages.mjs` raw SQL, tanpa ceiling) masih hidup sampai A3 selesai | Bekukan/block add-credit placeholder bersamaan A1 (bukan setelah); anggap bisa ada >2 baris |

---

## 3. Keputusan yang kurang (harus diputus sebelum eksekusi)

1. **Bentuk guard overflow yang benar** — numeric-isolate vs exclude vs saturate+flag; angka cutoff; dan siapa men-triase akun yang terisolasi. (Saat ini ambivalen antara "numeric(40,0)" dan "tangkap-error-lanjut-akun" yang saling kontradiktif terhadap properti set-based.)
2. **Siapa/skema mana menulis `subscription.economic_bucket` saat grant**, dan nilai default untuk subscriber supaya tidak jatuh ke `frpayg`.
3. **Namespace idempotensi `credit_purchase`** — `purchase:<ref>` vs placeholder `purchase:<uuid>`; rename/migrasi namespace lama dan aturan konflik.
4. **Apakah subscription gate (`entitlement.CheckSubscription`/`LiveSubscription`) di-wire sebelum flip**, atau balance-gate dibuat subscription-aware; tanpa ini definisi "akun sehat" tidak terdefinisi.
5. **Kalibrasi `bucket_quota`** seed terhadap insiden 172k; kriteria go-live kuota (berapa request/anggota/jendela), bukan cuma "counter-miss injection test".
6. **Ruang lingkup "adapter" bot** — batas tegas antara transport dan claim/grant/publish; apakah handler pembayaran dibangun sebagai shared-TS dulu sebelum C1/C2.
7. **Arsitektur inbound webhook payment** (endpoint, signature, replay window, secret management) — belum ada keputusan, hanya "pola deliverWebhook".
8. **Escalation/delegasi approval** bila `@zupaxx` offline, dan definisi-done "SPOF berkurang" yang terukur (bukan naratif).
9. **Urutan A1–A2–A3**: A2 tak menyelesaikan tanpa A1, dan A3 (hentikan placebo) harus berbarengan A1 agar tidak ada regresi; urutan "A1→A2→A3" saat ini menempatkan A2 yang dependen di antara A1 dan A3 secara runut tapi tidak menyatakan bahwa A2 useless tanpa A1 lebih dulu.

---

## 4. Verdict — **REVISE**

Rencana ini membaca ground-truth dengan jujur (membedakan SUDAH ADA vs gap, menghormati kriteria #4, dan menggantung flip flag pada prasyarat), tetapi dua klaim sentralnya — "reconcileAll dibuat tahan overflow" dan "tidak ada akun sehat yang self-lockout" — **tidak didukung oleh mekanisme yang diusulkan**: guard `numeric` tidak bisa menahan jumlah yang melebihi int64 di kolom `bigint` (S1), dan tidak ada subscription gate yang ter-wire ke hot path sehingga flip B4 didefinisikan melampaui apa yang data plane benar-benar junjung (S2). Ditambah tiga celah lintas-boundary yang belum diputus (bucket `frsubs` yang tak ditulis grant writer → drain prepaid; inbound webhook yang tak ada; bentrok namespace idempotensi), rencana ini berisiko meloloskan Sprint 1 dan Sprint 7 DoD yang "hijau" di kertas tapi gagal saat uang benar hidup.

**Perbaikan minimal agar layak (APPROVE):**
1. Definisikan ulang A2 dengan mekanisme isolate-exclude yang konkret dan bisa diuji terhadap total `>int64` (bukan `numeric` saja); jadikan A2 **tergantung A1** secara eksplisit.
2. Tambahkan ke grant writer (B2/B3/T-D) satu keharusan: tulis `subscription.economic_bucket='frsubs'` saat grant, dengan acceptance test "beli 7d → resolve ke `BucketSubs`".
3. Wire `entitlement.CheckSubscription`/`LiveSubscription` ke hot path (atau buat balance-gate subscription-aware) **sebelum** B4, dan definisikan "akun sehat" = live-subscription OR balance>0, bukan "ada top-up".
4. Putuskan namespace idempotensi `credit_purchase` dan rename placeholder lama sebelum B2 live.
5. Ganti "pola `deliverWebhook`" untuk B3 menjadi task inbound-webhook eksplisit (HMAC verify + anti-replay + `gateway_ref` idempotent), dengan estimasi usaha yang jujur.
6. Tambah kolom "gate prasyarat" pada backlog RICE agar label quick-win tidak menyesatkan pull survivor ke sprint.