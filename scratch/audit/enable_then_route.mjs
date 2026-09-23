// End-to-end: enable a model discovered by "fetch catalog" that is NOT yet in the
// catalog, then route a real request through the router with it, then clean up.
// This is the exact loop an admin runs, so it must work without a deploy.
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const BASE = 'https://ai.karepmuwes.my.id';
const PID = 'googleai';
const NEW_SLUG = process.argv[2] ?? 'models/gemini-2.5-flash';
const token = readFileSync('/tmp/fr_session.txt', 'utf8').trim();
const devKey = readFileSync('/tmp/ukey2.key', 'utf8').trim();

const sql = postgres(process.env.DATABASE_URL);

async function action(name, fields = {}) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  const res = await fetch(`${BASE}/admin/providers/${PID}?/${name}`, {
    method: 'POST',
    headers: {
      cookie: `__Secure-better-auth.session_token=${token}`,
      Origin: BASE,
      'x-sveltekit-action': 'true',
      'content-type': 'application/x-www-form-urlencoded'
    },
    body
  });
  return { status: res.status, text: await res.text() };
}

async function advertised() {
  const r = await fetch('http://127.0.0.1:8100/v1/models', { headers: { authorization: `Bearer ${devKey}` } });
  const j = await r.json();
  return (j.data ?? []).map((m) => m.id);
}

const before = await advertised();
console.log(`advertised before: ${before.length}`);
console.log(`already advertised? ${before.includes(NEW_SLUG)}`);
const [existing] = await sql`select slug, status from model where slug = ${NEW_SLUG}`;
console.log(`row in catalog before: ${existing ? JSON.stringify(existing) : 'none'}`);

// 1. enable it straight from a gallery payload
const en = await action('enable', {
  payload: JSON.stringify({ slug: NEW_SLUG, name: 'Gemini 2.5 Flash', context: 1048576, inputUsd: 0.3, outputUsd: 2.5 })
});
console.log(`enable http=${en.status}`);
const [row] = await sql`select slug, status, input_price, output_price from model where slug = ${NEW_SLUG}`;
console.log(`row after enable: ${JSON.stringify(row)}`);

const mid = await advertised();
console.log(`advertised after: ${mid.length} (+${mid.length - before.length}) contains=${mid.includes(NEW_SLUG)}`);

// 2. route a real request through the router with the newly enabled slug
const t0 = Date.now();
const chat = await fetch('http://127.0.0.1:8100/v1/chat/completions', {
  method: 'POST',
  headers: { authorization: `Bearer ${devKey}`, 'content-type': 'application/json' },
  body: JSON.stringify({ model: NEW_SLUG, messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 512 })
});
const chatBody = await chat.text();
console.log(`route ${NEW_SLUG} http=${chat.status} ${Date.now() - t0}ms`);
console.log(`  body: ${chatBody.slice(0, 200)}`);

// 3. clean up so the catalog is exactly as it was. `request_log` references the
// model row, so the test's own log lines go first.
const logs = await sql`delete from request_log where model_id in (select id from model where slug = ${NEW_SLUG}) returning id`;
const del = await sql`delete from model where slug = ${NEW_SLUG} returning slug`;
const after = await advertised();
console.log(`deleted ${logs.length} request_log row(s) and ${del.length} model row(s); advertised after cleanup: ${after.length} (was ${before.length})`);
await sql.end();
