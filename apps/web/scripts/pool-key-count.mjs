#!/usr/bin/env node
// Print the number of keys held in each provider's credential blob.
import postgres from 'postgres';
import { createDecipheriv } from 'node:crypto';

const master = Buffer.from(process.env.CREDENTIALS_MASTER_KEY, 'base64');
const sql = postgres(process.env.DATABASE_URL);

function decrypt(b64) {
  const buf = Buffer.from(b64, 'base64');
  const d = createDecipheriv('aes-256-gcm', master, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(-16));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(12, -16)), d.final()]).toString('utf8'));
}

try {
  const rows = await sql`select id, credentials_enc from provider order by id`;
  for (const r of rows) {
    let n = '?';
    try {
      const cred = decrypt(r.credentials_enc);
      n = (cred.accounts || []).length;
    } catch (e) {
      n = 'decrypt-fail';
    }
    console.log(`${r.id.padEnd(40)} keys=${n}`);
  }
} finally {
  await sql.end();
}
