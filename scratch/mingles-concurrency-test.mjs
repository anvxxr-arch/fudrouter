// Concurrency control for merge-mingles-keys.mjs: two merges race on the blob.
// Without the row lock the slower writer clobbers the other's key (lost
// update); with `for update` both land. Uses REAL farmed keys.
//
//   node --env-file=apps/web/.env scratch/mingles-concurrency-test.mjs [n]
//
// Takes the last `n` (default 2) accounts from mingles_keys.json, splits them
// into n single-key files, runs n merges in parallel, then re-reads the blob.
import postgres from 'postgres';
import { createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';

const N = Number(process.argv[2] || 2);
const REPO = '/home/dwizzy/fudrouter';
const KEYS = '/home/dwizzy/mingles-router-farmer/mingles_keys.json';

const master = Buffer.from(process.env.CREDENTIALS_MASTER_KEY, 'base64');
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const dec = (b64) => {
  const b = Buffer.from(b64, 'base64');
  const d = createDecipheriv('aes-256-gcm', master, b.subarray(0, 12));
  d.setAuthTag(b.subarray(-16));
  return JSON.parse(Buffer.concat([d.update(b.subarray(12, -16)), d.final()]).toString());
};
const pool = async () => JSON.parse(JSON.stringify((await sql`select credentials_enc from provider where id = 'mingles'`)[0])).credentials_enc;

const before = dec(await pool());
const have = new Set(before.accounts.map((a) => a.api_key));

const all = JSON.parse(readFileSync(KEYS, 'utf8'));
const fresh = all.filter((a) => !have.has(a.key));
console.log(`pool before: ${before.accounts.length} | file: ${all.length} | unpooled: ${fresh.length}`);
if (fresh.length < N) { console.log(`need ${N} unpooled keys — run a farm round first (farmer.py --count ${N})`); await sql.end(); process.exit(2); }

const batch = fresh.slice(-N);
const files = batch.map((a, i) => {
  const f = `/home/dwizzy/.hermes/cache/scratch/mingles-race-${i}.json`;
  writeFileSync(f, JSON.stringify([a]));
  return f;
});

// fire all merges at once — spawn (not execFileSync, which blocks per call and
// would serialise them before they could race)
const run = (f) => new Promise((res) => {
  const p = spawn('bash', ['-lc',
    `cd ${REPO} && unset DATABASE_URL CREDENTIALS_MASTER_KEY; node --env-file=apps/web/.env apps/web/scripts/merge-mingles-keys.mjs ${f}`],
    { env: process.env });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  p.on('close', (code) => res({ f, code, out }));
});
const results = await Promise.all(files.map(run));
results.forEach((r, i) => console.log(`merge ${i} (exit ${r.code}):`, r.out.split('\n').slice(1, 4).join(' / ')));

const after = dec(await pool());
const keysAfter = new Set(after.accounts.map((a) => a.api_key));
const landed = batch.filter((a) => keysAfter.has(a.key));
console.log(`pool after: ${after.accounts.length} (expected ${before.accounts.length + N})`);
console.log(`new keys landed: ${landed.length}/${N} ${landed.length === N ? '✅ no lost update' : '✗ LOST UPDATE'}`);
for (const f of files) rmSync(f, { force: true });
await sql.end();
process.exit(landed.length === N ? 0 : 1);
