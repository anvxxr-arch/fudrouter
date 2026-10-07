#!/usr/bin/env node
// scripts/onboard-mingles.mjs — sync the Mingles farm's keys into fudrouter.
//
// Replaces the deleted apps/web/scripts/merge-mingles-keys.mjs (mingles-merge
// .service has been failing with `.env: not found` since the apps/web refactor,
// 1000+ times, so nothing has landed since 2026-09-30 — the 408 credentials in
// the pool are all GuerrillaMail-era and all `auth_failed`).
//
// Source of truth: mingles_keys.json, the farm's JSON list (email/password/key/
// working/created_at). Only rows the farmer smoke-tested as live are imported.
//
// Idempotent: credential id is cred_mingles_<sha256(key)[:16]>, written once.
// A key that is dead at probe time is flipped to 'invalid' so the pool stops
// retrying it. provider/connection rows already exist (prv_mingles,
// con_prv_mingles-default) and are upserted without clobbering operator status.
//
// Usage:  set -a && . .env && set +a && node scripts/onboard-mingles.mjs [--dry-run]
// Knobs:  MINGLES_KEY_FILE, MINGLES_PROBE_CONCURRENCY
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const DRY = process.argv.includes('--dry-run');
const KEY_FILE = process.env.MINGLES_KEY_FILE ?? '/home/dwizzy/mingles-router-farmer/mingles_keys.json';
const PROVIDER_ID = 'prv_mingles';
const CONNECTION_ID = 'con_prv_mingles-default';
const BASE_URL = 'https://router.mingles.ai/v1';
const PROBE_CONC = Number(process.env.MINGLES_PROBE_CONCURRENCY ?? 12);

const masterKey = () => {
  const k = process.env.CREDENTIALS_MASTER_KEY;
  if (!k) throw new Error('CREDENTIALS_MASTER_KEY is not set');
  const buf = Buffer.from(k, 'base64');
  if (buf.length !== 32) throw new Error('CREDENTIALS_MASTER_KEY must be base64 of 32 bytes');
  return buf;
};

const encryptJson = (plain) => {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', masterKey(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(plain), 'utf8'), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
};

function loadKeys() {
  let rows = [];
  try {
    rows = JSON.parse(readFileSync(KEY_FILE, 'utf8'));
  } catch (e) {
    throw new Error(`cannot parse ${KEY_FILE}: ${e.message}`);
  }
  if (!Array.isArray(rows)) throw new Error(`${KEY_FILE} is not a JSON array`);
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const key = String(r?.key ?? '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, email: String(r?.email ?? '').trim(), working: r?.working === true });
  }
  return out;
}

const credId = (key) => 'cred_mingles_' + createHash('sha256').update(key).digest('hex').slice(0, 16);
const idOf = (k) => credId(k.key);

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  }));
  return out;
}

async function probeKey(key) {
  try {
    const res = await fetch(`${BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(25_000)
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function main() {
  const dsn = process.env.DATABASE_URL;
  if (!dsn) throw new Error('DATABASE_URL is required');
  const sql = postgres(dsn, { max: 1 });
  try {
    const all = loadKeys();
    if (all.length === 0) throw new Error(`no keys in ${KEY_FILE}`);
    // Rows the farmer marked working:false are `pending` (the upstream 503s in
    // waves) — still probe them, they flip live on their own.
    console.log(`keys in file: ${all.length} (farmer-marked live: ${all.filter((k) => k.working).length})`);

    const live = await mapLimit(all, PROBE_CONC, async (k) => ((await probeKey(k.key)) ? k : null));
    const liveKeys = live.filter(Boolean);
    const deadKeys = all.filter((k) => !liveKeys.includes(k));
    console.log(`live now: ${liveKeys.length}  dead now: ${deadKeys.length}`);
    if (liveKeys.length === 0) throw new Error('no live keys — upstream rejected every key');

    const [models] = await sql`select count(*)::int n from model where provider_id = ${PROVIDER_ID}`;
    console.log(`models already registered for ${PROVIDER_ID}: ${models.n}`);

    if (DRY) {
      console.log('--dry-run: no writes');
      return;
    }

    await sql.begin(async (tx) => {
      // provider: credentials_enc keeps the legacy single-key blob in sync with
      // the newest live key; operator-owned `status` is preserved.
      const legacyBlob = encryptJson({
        api_key: liveKeys[0].key,
        auth_kind: 'apikey',
        default_headers: {},
        accounts: liveKeys.map((k) => ({
          email: k.email || 'mingles-key',
          access_token: k.key,
          refresh_token: null,
          expired: '2099-01-01T00:00:00Z'
        }))
      });
      await tx`
        update provider set credentials_enc = ${legacyBlob}, base_url = ${BASE_URL}, updated_at = now()
        where id = ${PROVIDER_ID}`;
      await tx`
        update connection set base_url = ${BASE_URL}, enabled = true, updated_at = now()
        where id = ${CONNECTION_ID}`;

      let newCreds = 0;
      let revived = 0;
      for (const k of liveKeys) {
        const id = credId(k.key);
        const secret = encryptJson({ api_key: k.key, email: k.email });
        const r = await tx`
          insert into credential (id, connection_id, name, secret_enc, status, metadata)
          values (${id}, ${CONNECTION_ID}, ${k.email || id}, ${secret}, 'unknown', ${tx.json(k.email ? { email: k.email } : {})})
          on conflict (id) do update set
            secret_enc = excluded.secret_enc,
            updated_at = now()
          returning (xmax = 0) as inserted, status`;
        if (r.length > 0 && r[0].inserted) newCreds += 1;
        if (r.length > 0 && r[0].status !== 'unknown' && r[0].status !== 'active') revived += 1;
      }
      console.log(`credentials: ${newCreds} new, ${liveKeys.length - newCreds} refreshed, ${revived} revived from a failed status`);

      // Dead at probe time: stop the pool from trying them (they are the 408
      // GuerrillaMail-era rows for most of the list).
      let invalidated = 0;
      for (const k of deadKeys) {
        const r = await tx`
          update credential set status = 'invalid', updated_at = now()
          where id = ${idOf(k)} and status <> 'invalid' returning id`;
        if (r.length > 0) invalidated += 1;
      }
      console.log(`marked invalid: ${invalidated}`);

      // Re-enable the provider models so the router can route once live creds exist.
      const pm = await tx`
        update provider_model set enabled = true, status = 'available', updated_at = now()
        where provider_id = ${PROVIDER_ID} returning id`;
      const md = await tx`
        update model set status = 'active', updated_at = now()
        where provider_id = ${PROVIDER_ID} and status <> 'active' returning id`;
      console.log(`provider_models enabled: ${pm.length}, models activated: ${md.length}`);
    });

    const [cc] = await sql`
      select count(*)::int n,
             count(*) filter (where cr.status = 'invalid')::int inv,
             count(*) filter (where cr.status = 'auth_failed')::int af
      from credential cr join connection cn on cn.id = cr.connection_id
      where cn.provider_id = ${PROVIDER_ID}`;
    console.log(`pool now: ${cc.n} credentials (invalid=${cc.inv}, auth_failed=${cc.af})`);
  } finally {
    await sql.end({ timeout: 1 });
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
