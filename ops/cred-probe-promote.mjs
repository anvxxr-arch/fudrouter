#!/usr/bin/env node
// ops/cred-probe-promote.mjs — revive a dark credential pool: decrypt each
// stored credential, probe it against the provider's own host, and write the
// verdict back as status.
//
// Why this exists: `poolrebuild` only carries `credential.status='healthy'`
// rows into the routing blob, so a pool whose rows sit at `unknown` (an importer
// that never set a status) is invisible to the router while MORE THAN HALF of
// its keys can still answer 200. Measured on prv_dahl: 18 607 rows at `unknown`,
// live keys answering 200 from the newest harvested file — pool dark, keys alive.
//
// Usage:
//   set -a && . /home/dwizzy/fudrouter/.env && set +a
//   node ops/cred-probe-promote.mjs <provider_id> [--sample N] [--apply] [--concurrency N]
//
//   Default is a dry run that prints the verdict histogram (free — no writes).
//   --apply writes: 2xx -> healthy (cooldown_until null), 401/403 -> invalid,
//   anything else (429/5xx/timeout) -> left untouched (transient is not a verdict).
//   Then: cd backend/go && go run ./cmd/poolrebuild <provider_id> && pm2 restart fudrouter-router
//
// Probe is GET <base_url>/models with the Bearer header: free upstreams commonly
// 401 an unauthenticated catalog call, and /models answering 200 does NOT prove
// chat works — finish with `upchat <provider_id>` before quoting a number.
import { createDecipheriv } from 'node:crypto';
import postgres from 'postgres';

const argv = process.argv.slice(2);
const provider = argv.find((a) => !a.startsWith('--'));
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? def : argv[i + 1];
};
const SAMPLE = Number(flag('sample', 0)) || 0;
const CONC = Math.max(1, Number(flag('concurrency', 4)) || 4);
const DELAY = Math.max(0, Number(flag('delay', 0)) || 0);
const APPLY = argv.includes('--apply');
const MODE = flag('mode', 'models');
const MODEL = flag('model', '');
const STATUSES = (flag('statuses', 'unknown') || 'unknown').split(',').map((s) => s.trim());
if (!provider) {
  console.error('usage: cred-probe-promote.mjs <provider_id> [--sample N] [--apply] [--concurrency N] [--delay MS] [--statuses unknown,invalid] [--mode chat --model <upstream_id>]');
  process.exit(2);
}
if (MODE === 'chat' && !MODEL) throw new Error('--mode chat needs --model <upstream model id>');

const key = process.env.CREDENTIALS_MASTER_KEY;
if (!key) throw new Error('CREDENTIALS_MASTER_KEY is not set');
const master = Buffer.from(key, 'base64');
if (master.length !== 32) throw new Error('CREDENTIALS_MASTER_KEY must base64-decode to 32 bytes');

function decrypt(enc) {
  const raw = Buffer.from(enc, 'base64');
  const iv = raw.subarray(0, 12);
  const ct = raw.subarray(12, raw.length - 16);
  const tag = raw.subarray(raw.length - 16);
  const d = createDecipheriv('aes-256-gcm', master, iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8'));
}

const sql = postgres(process.env.DATABASE_URL, { max: 4 });
const [conn] = await sql`
  select cn.id, p.base_url
    from connection cn join provider p on p.id = cn.provider_id
   where cn.provider_id = ${provider} limit 1`;
if (!conn) throw new Error(`no connection for provider ${provider}`);
const base = String(conn.base_url).replace(/\/+$/, '');
console.log(`[promote] provider=${provider} base=${base} statuses=${STATUSES.join(',')} apply=${APPLY}`);

const rows = await sql`
  select cr.id, cr.secret_enc
    from credential cr join connection cn on cn.id = cr.connection_id
   where cn.provider_id = ${provider}
     and cr.status = any(${STATUSES})
     and cr.secret_enc is not null`;
console.log(`[promote] candidate rows: ${rows.length}`);

let todo = rows;
if (SAMPLE > 0 && rows.length > SAMPLE) {
  // Evenly spaced sample across the table so file-order / insert-order bias
  // cannot hide a whole dead batch behind a live head.
  const step = rows.length / SAMPLE;
  todo = Array.from({ length: SAMPLE }, (_, i) => rows[Math.floor(i * step)]);
  console.log(`[promote] sampling ${todo.length} (every ~${step.toFixed(0)}th row)`);
}

const verdict = { live: [], invalid: [], unfunded: [], transient: [], undecryptable: 0 };
let done = 0;
async function probeOne(row, attempt = 1) {
  let secret;
  try { secret = decrypt(row.secret_enc); } catch { verdict.undecryptable++; return; }
  const apiKey = secret.api_key || secret.access_token;
  if (!apiKey) { verdict.undecryptable++; return; }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 20000);
  try {
    // chat mode proves the key can actually serve a completion, not just read the
    // catalogue. Free upstreams 402/429 on chat when the account has no credits even
    // though /models answers 200 — those are "unfunded", not invalid (key is real).
    const resp = MODE === 'chat'
      ? await fetch(`${base}/chat/completions`, {
          method: 'POST', signal: ac.signal,
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
        })
      : await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: ac.signal });
    clearTimeout(t);
    if (resp.ok) { verdict.live.push(row.id); verdict.transient = verdict.transient.filter((x) => x !== row.id); }
    else if (resp.status === 401 || resp.status === 403) verdict.invalid.push(row.id);
    else if (resp.status === 402) { verdict.unfunded.push(row.id); verdict.transient = verdict.transient.filter((x) => x !== row.id); }
    else if (!verdict.transient.includes(row.id)) verdict.transient.push(row.id);
  } catch {
    if (!verdict.transient.includes(row.id)) verdict.transient.push(row.id);
  } finally {
    if (DELAY) await new Promise((r) => setTimeout(r, DELAY));
  }
  if (++done % 200 === 0) console.log(`[promote] probed ${done}/${todo.length} live=${verdict.live.length} invalid=${verdict.invalid.length} unfunded=${verdict.unfunded.length} transient=${verdict.transient.length} (pass ${attempt})`);
}
for (let pass = 1; pass <= 2; pass++) {
  const batch = pass === 1 ? todo : todo.filter((r) => verdict.transient.includes(r.id));
  if (pass === 2) {
    verdict.transient = [];
    console.log(`[promote] pass 2: retrying ${batch.length} transient rows at half concurrency`);
  }
  const conc = pass === 1 ? CONC : Math.max(1, Math.floor(CONC / 2));
  for (let i = 0; i < batch.length; i += conc) await Promise.all(batch.slice(i, i + conc).map((r) => probeOne(r, pass)));
  if (batch.length === 0) break;
}

const pct = (n) => `${((n / Math.max(1, todo.length)) * 100).toFixed(1)}%`;
console.log(`[promote] VERDICT live=${verdict.live.length} (${pct(verdict.live.length)}) invalid=${verdict.invalid.length} (${pct(verdict.invalid.length)}) transient=${verdict.transient.length} undecryptable=${verdict.undecryptable}`);

if (!APPLY) {
  console.log('[promote] dry run — no writes. Re-run with --apply to persist.');
} else {
  for (let i = 0; i < verdict.live.length; i += 500) {
    const n = await sql`update credential set status='healthy', cooldown_until=null, updated_at=now()
                         where id = any(${verdict.live.slice(i, i + 500)}) and status <> 'healthy'`;
    console.log(`  healthy: ${n.count}`);
  }
  for (let i = 0; i < verdict.invalid.length; i += 500) {
    const n = await sql`update credential set status='invalid', updated_at=now()
                         where id = any(${verdict.invalid.slice(i, i + 500)}) and status <> 'invalid'`;
    console.log(`  invalid: ${n.count}`);
  }
  // 402 = real key, zero credits. Park at rate_limited + cooldown so poolrebuild
  // (which only carries healthy) drops them from the blob and the router stops
  // returning INSUFFICIENT_CREDITS up to the caller.
  const unfunded = verdict.unfunded.filter((id) => !verdict.live.includes(id) && !verdict.invalid.includes(id));
  for (let i = 0; i < unfunded.length; i += 500) {
    const n = await sql`update credential set status='rate_limited',
                         cooldown_until = now() + interval '6 hours', updated_at=now()
                         where id = any(${unfunded.slice(i, i + 500)})`;
    console.log(`  unfunded(->rate_limited): ${n.count}`);
  }
  const hist = await sql`
    select cr.status, count(*)::int n from credential cr join connection cn on cn.id = cr.connection_id
     where cn.provider_id = ${provider} group by 1 order by 2 desc`;
  console.log('[promote] status now:', JSON.stringify(hist));
  console.log(`[promote] next: cd backend/go && go run ./cmd/poolrebuild ${provider} && pm2 restart fudrouter-router`);
}
await sql.end();
