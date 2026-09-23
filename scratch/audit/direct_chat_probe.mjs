// Time a direct chat against a provider's upstream, using the real stored
// credential. Answers "is the sandbox slow, or is the upstream slow?".
import { createDecipheriv } from 'node:crypto';
import postgres from 'postgres';

const PID = process.argv[2] ?? 'googleai';
const SLUG = process.argv[3] ?? 'gemini-3.6-flash';

const key = Buffer.from(process.env.CREDENTIALS_MASTER_KEY, 'base64');
function decrypt(enc) {
  const buf = Buffer.from(enc, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(12, buf.length - 16);
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8'));
}

const sql = postgres(process.env.DATABASE_URL);
const [p] = await sql`select id, base_url, credentials_enc from provider where id = ${PID}`;
await sql.end();
if (!p) {
  console.log('no such provider');
  process.exit(1);
}

const cred = decrypt(p.credentials_enc);
const accounts = Array.isArray(cred.accounts) ? cred.accounts : [];
const token = accounts[0]?.access_token || accounts[0]?.api_key || cred.api_key;
console.log(`provider=${PID} base=${p.base_url} accounts=${accounts.length} auth_kind=${cred.auth_kind} protocol=${cred.Protocol ?? cred.protocol ?? '-'}`);
console.log(`token present=${Boolean(token)} token length=${String(token).length}`);

const url = `${p.base_url.replace(/\/$/, '')}/chat/completions`;
const body = JSON.stringify({ model: SLUG, messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 16 });

for (const attempt of [1, 2]) {
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...(cred.default_headers ?? {}), authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body,
      signal: ctrl.signal
    });
    clearTimeout(timer);
    const text = await res.text();
    console.log(`attempt ${attempt}: http=${res.status} ${Date.now() - t0}ms body=${text.slice(0, 220)}`);
  } catch (e) {
    console.log(`attempt ${attempt}: threw ${Date.now() - t0}ms ${e.name}: ${e.message}`);
  }
}
