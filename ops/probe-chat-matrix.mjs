#!/usr/bin/env node
// ops/probe-chat-matrix.mjs — for one provider, try several upstream model ids
// with a REAL chat completion (not GET /models) and report status + TTFB per
// model, plus a second key for the winners.
//
// Why: /models lists what an aggregator sells, not what a free/farmed key may
// call. A catalogue full of frontier models is worthless if every key 402s on
// them, and a short timeout turns a queued 200 into a fake `000` (see the
// tokenharbor-farm skill: TTFB of 27-86s under load is normal there).
//
// Usage:
//   set -a && . /home/dwizzy/fudrouter/.env && set +a
//   node ops/probe-chat-matrix.mjs <provider_id> <model1,model2,...> \
//        [--sample 1] [--timeout 150000] [--keys 2] [--statuses healthy]
import { createDecipheriv } from 'node:crypto';
import postgres from 'postgres';

const argv = process.argv.slice(2);
const pos = argv.filter((a) => !a.startsWith('--'));
const provider = pos[0];
const models = (pos[1] || '').split(',').map((s) => s.trim()).filter(Boolean);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const TIMEOUT = Number(flag('timeout', 150000)) || 150000;
const KEYS = Math.max(1, Number(flag('keys', 2)) || 2);
const STATUSES = (flag('statuses', 'healthy') || 'healthy').split(',');
const MAXTOK = Number(flag('max_tokens', 4)) || 4;
if (!provider || !models.length) { console.error('usage: probe-chat-matrix.mjs <provider_id> <model1,model2,...>'); process.exit(2); }

const master = Buffer.from(process.env.CREDENTIALS_MASTER_KEY || '', 'base64');
if (master.length !== 32) throw new Error('CREDENTIALS_MASTER_KEY must base64-decode to 32 bytes');
const dec = (enc) => {
  const raw = Buffer.from(enc, 'base64');
  const d = createDecipheriv('aes-256-gcm', master, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString('utf8'));
};

const sql = postgres(process.env.DATABASE_URL, { max: 2 });
const [conn] = await sql`
  select p.base_url from connection cn join provider p on p.id = cn.provider_id
   where cn.provider_id = ${provider} limit 1`;
if (!conn) throw new Error(`no connection for ${provider}`);
const base = String(conn.base_url).replace(/\/+$/, '');

const rows = await sql`
  select cr.id, cr.secret_enc from credential cr join connection cn on cn.id = cr.connection_id
   where cn.provider_id = ${provider} and cr.status = any(${STATUSES}) and cr.secret_enc is not null
   order by cr.updated_at desc nulls last limit ${KEYS}`;
if (!rows.length) throw new Error('no candidate credentials');
const keys = rows.map((r) => ({ id: r.id, apiKey: dec(r.secret_enc).api_key || dec(r.secret_enc).access_token })).filter((k) => k.apiKey);

async function chat(apiKey, model) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT);
  const t0 = Date.now();
  try {
    const resp = await fetch(`${base}/chat/completions`, {
      method: 'POST', signal: ac.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: MAXTOK }),
    });
    const ms = Date.now() - t0;
    const body = await resp.text().catch(() => '');
    clearTimeout(t);
    return { status: resp.status, ms, snippet: body.slice(0, 140).replace(/\s+/g, ' ') };
  } catch (e) { clearTimeout(t); return { status: 0, ms: Date.now() - t0, snippet: String(e?.name || e) }; }
}

console.log(`provider=${provider} base=${base} timeout=${TIMEOUT}ms keys=${keys.length}`);
for (const model of models) {
  const line = [];
  for (const k of keys) {
    const r = await chat(k.apiKey, model);
    line.push(`${r.status}@${r.ms}ms`);
    if (!r.status || r.status >= 400) line.push(`«${r.snippet}»`);
    else line.push(`«${r.snippet.slice(0, 60)}»`);
  }
  console.log(`\n${model}`);
  console.log(`  ${line.join('  ')}`);
  for (const k of keys) console.log(`    key=${k.id}`);
}
await sql.end();
