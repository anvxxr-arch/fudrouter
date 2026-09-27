// Deterministic proof that merge-mingles-keys.mjs actually takes the row lock:
// hold `for update` on the provider row for 6s in a separate transaction, then
// time the merge. With the lock it must WAIT (~6s); without it the read would
// hit the MVCC snapshot and finish in ~1s whether or not a writer is holding.
import postgres from 'postgres';
import { spawn } from 'node:child_process';

const REPO = '/home/dwizzy/fudrouter';
const HOLD_MS = 6000;

const holder = postgres(process.env.DATABASE_URL, { max: 1 });
const t0 = Date.now();
let releasedAt = null;
const holdPromise = holder.begin(async (tx) => {
  await tx`select credentials_enc from provider where id = 'mingles' for update`;
  console.log(`[holder] row locked at +${Date.now() - t0}ms, holding ${HOLD_MS}ms`);
  await new Promise((r) => setTimeout(r, HOLD_MS));
}).then(() => { releasedAt = Date.now(); console.log(`[holder] released at +${releasedAt - t0}ms`); });

await new Promise((r) => setTimeout(r, 600)); // let the lock land first

const merge = new Promise((res) => {
  const p = spawn('bash', ['-lc',
    `cd ${REPO} && unset DATABASE_URL CREDENTIALS_MASTER_KEY; node --env-file=apps/web/.env apps/web/scripts/merge-mingles-keys.mjs`],
    { env: process.env });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  p.on('close', (code) => res({ code, out, ms: Date.now() - t0 }));
});

const [m] = await Promise.all([merge, holdPromise]);
const summary = m.out.split('\n').filter((l) => /new:|nothing new|pool now/.test(l)).join(' / ');
console.log(`[merge] exit ${m.code} after +${m.ms}ms  (${summary})`);
const blocked = m.ms >= HOLD_MS;
console.log(blocked
  ? '✅ merge waited for the row lock — for update is engaged'
  : '✗ merge did NOT wait — the transaction is not taking the lock');
await holder.end();
process.exit(blocked ? 0 : 1);
