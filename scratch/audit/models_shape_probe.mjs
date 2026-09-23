// What does an upstream /models payload actually look like? Prints the raw
// entries so the parser can be matched to reality instead of to a guess.
import { createDecipheriv } from 'node:crypto';
import postgres from 'postgres';

const PID = process.argv[2] ?? 'tokenharbor';
const key = Buffer.from(process.env.CREDENTIALS_MASTER_KEY, 'base64');
function decrypt(enc) {
  const buf = Buffer.from(enc, 'base64');
  const d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]).toString('utf8'));
}

const sql = postgres(process.env.DATABASE_URL);
const [p] = await sql`select id, base_url, credentials_enc from provider where id = ${PID}`;
await sql.end();
const cred = decrypt(p.credentials_enc);
const acct = (cred.accounts ?? [])[0] ?? {};
const token = acct.access_token || acct.api_key || cred.api_key;

const res = await fetch(`${p.base_url.replace(/\/$/, '')}/models`, {
  headers: { ...(cred.default_headers ?? {}), authorization: `Bearer ${token}` }
});
const payload = await res.json();
const data = payload.data ?? payload.models ?? payload;
console.log(`http=${res.status} top-level keys=${Object.keys(payload).join(',')}`);
console.log(`entries=${Array.isArray(data) ? data.length : 'not-an-array'}`);
if (Array.isArray(data)) {
  for (const [i, e] of data.slice(0, 6).entries()) {
    console.log(`  [${i}] id=${JSON.stringify(e?.id)} model=${JSON.stringify(e?.model)} slug=${JSON.stringify(e?.slug)} label=${JSON.stringify(e?.label)}`);
  }
  const noId = data.filter((e) => !(e && (e.id ?? e.model ?? e.slug)));
  console.log(`entries with NO truthy id/model/slug: ${noId.length}`);
  const blank = data.filter((e) => typeof e?.id === 'string' && e.id.trim() === '');
  console.log(`entries with BLANK (whitespace) id: ${blank.length}`);
  const nullId = data.filter((e) => e?.id === null || e?.id === undefined);
  console.log(`entries with null/undefined id: ${nullId.length}`);
  console.log(`FULL entry[1]: ${JSON.stringify(data[1])}`);
}
