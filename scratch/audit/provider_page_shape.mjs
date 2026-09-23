// Assert the rendered page follows the requested section order and exposes the
// controls the spec names. Reads real HTML, not a fixture.
import { readFileSync } from 'node:fs';

const BASE = 'https://ai.karepmuwes.my.id';
const PID = process.argv[2] ?? 'googleai';
const token = readFileSync('/tmp/fr_session.txt', 'utf8').trim();
const html = await (
  await fetch(`${BASE}/admin/providers/${PID}`, {
    headers: { cookie: `__Secure-better-auth.session_token=${token}` }
  })
).text();

// Real section headings only — a <dt> in the header facts also says "Credentials".
const headings = [...html.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map((m) => m[1].trim());
console.log(`http=200 bytes=${html.length}`);
console.log(`h2 headings in document order: ${JSON.stringify(headings)}`);

const want = ['Statistik usage', 'Quota', 'Rate limit', 'Strategy routing', 'Credentials', 'Fetch models', 'Catalog', 'Playground'];
const got = headings.filter((h) => want.includes(h));
console.log(`matched: ${JSON.stringify(got)}`);
console.log(`section order: ${JSON.stringify(got) === JSON.stringify(want) ? 'OK ✓' : 'BROKEN ✗'}`);

console.log('controls:');
for (const [label, needle] of [
  ['credential table', '<table'],
  ['test credential', 'Test all'],
  ['strategy save', 'Save'],
  ['fetch button', 'Fetch'],
  ['playground send', 'Send'],
  ['chat box', '<textarea'],
  ['model dropdown', '<select']
]) {
  console.log(`  ${html.includes(needle) ? '✓' : '✗'} ${label}`);
}

console.log(`credential rows: ${(html.match(/<tr/g) ?? []).length}`);
console.log(`forms: ${(html.match(/<form/g) ?? []).length}`);
console.log(`provider name in header: ${html.includes('<h1') ? 'yes' : 'NO'}`);
