// Recon for onboarding `mingles`: (a) conventions from an existing static-key
// provider (TokenHarbor), (b) probe all 5 Mingles slugs live.
import postgres from 'postgres';
import { createDecipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';

const km = Buffer.from(process.env.CREDENTIALS_MASTER_KEY, 'base64');
const dec = (w) => {
  const r = Buffer.from(w, 'base64');
  const d = createDecipheriv('aes-256-gcm', km, r.subarray(0, 12));
  d.setAuthTag(r.subarray(r.length - 16));
  return Buffer.concat([d.update(r.subarray(12, r.length - 16)), d.final()]).toString();
};

const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const [th] = await sql`select id, name, base_url, status, priority, credentials_enc from provider where name = 'TokenHarbor'`;
const cap = JSON.parse(dec(th.credentials_enc));
console.log('TH provider:', th.base_url, '| status=' + th.status, '| priority=' + th.priority);
console.log('TH blob keys:', Object.keys(cap).sort().join(','), '| auth_kind:', cap.auth_kind, '| headers:', JSON.stringify(cap.default_headers));
console.log('TH account[0]:', JSON.stringify({ ...cap.accounts[0], access_token: '***', api_key: '***' }));
const rows = await sql`select slug, name, input_price, output_price, context, status from model where provider_id = ${th.id} order by slug limit 2`;
for (const r of rows) console.log('TH model:', JSON.stringify(r));
await sql.end();

// --- live probe of the 5 Mingles slugs ---
const key = JSON.parse(readFileSync('/home/dwizzy/mingles-router-farmer/mingles_keys.json', 'utf8'))[0].key;
const base = 'https://router.mingles.ai/v1';
const mr = await fetch(base + '/models', { headers: { Authorization: 'Bearer ' + key } });
const models = (await mr.json()).data;
const results = await Promise.all(models.map(async (m) => {
  const t0 = Date.now();
  try {
    const res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: m.id, messages: [{ role: 'user', content: 'Reply with exactly: OK' }], max_tokens: 24 }),
      signal: AbortSignal.timeout(60000),
    });
    const body = await res.text();
    return { id: m.id, ctx: m.context_window, status: res.status, ms: Date.now() - t0, snippet: body.slice(0, 160) };
  } catch (e) { return { id: m.id, ctx: m.context_window, status: 0, ms: Date.now() - t0, snippet: String(e).slice(0, 120) }; }
}));
for (const r of results) console.log('PROBE', r.status, r.ms + 'ms', 'ctx=' + r.ctx, r.id, '|', r.snippet.replace(/\s+/g, ' '));
