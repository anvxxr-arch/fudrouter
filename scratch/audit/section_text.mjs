// Print the text of the usage / quota / rate-limit sections so the report
// describes what the page really says, not what it was meant to say.
import { readFileSync } from 'node:fs';
const BASE = 'https://ai.karepmuwes.my.id';
const PID = process.argv[2] ?? 'googleai';
const token = readFileSync('/tmp/fr_session.txt', 'utf8').trim();
const html = await (
  await fetch(`${BASE}/admin/providers/${PID}`, { headers: { cookie: `__Secure-better-auth.session_token=${token}` } })
).text();

const text = html
  .replace(/<script[\s\S]*?<\/script>/g, ' ')
  .replace(/<style[\s\S]*?<\/style>/g, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ');

for (const h of ['Statistik usage', 'Quota', 'Rate limit', 'Strategy routing']) {
  const i = text.indexOf(h);
  const next = ['Statistik usage', 'Quota', 'Rate limit', 'Strategy routing', 'Credentials']
    .map((x) => text.indexOf(x, i + h.length))
    .filter((x) => x > i)
    .sort((a, b) => a - b)[0];
  console.log(`\n=== ${h} ===`);
  console.log(text.slice(i + h.length, next ?? i + 700).trim().slice(0, 700));
}
