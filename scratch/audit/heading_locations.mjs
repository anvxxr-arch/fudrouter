// Where does each section heading actually appear in the HTML?
import { readFileSync } from 'node:fs';
const BASE = 'https://ai.karepmuwes.my.id';
const PID = process.argv[2] ?? 'googleai';
const token = readFileSync('/tmp/fr_session.txt', 'utf8').trim();
const html = await (await fetch(`${BASE}/admin/providers/${PID}`, { headers: { cookie: `__Secure-better-auth.session_token=${token}` } })).text();

for (const h of ['Statistik usage', 'Quota', 'Rate limit', 'Strategy routing', 'Credentials', 'Fetch models', 'Catalog', 'Playground']) {
  const idxs = [];
  let i = -1;
  while ((i = html.indexOf(h, i + 1)) !== -1) idxs.push(i);
  console.log(`${h.padEnd(18)} occurrences=${idxs.length} at ${idxs.join(', ')}`);
}
console.log('\n--- context 5480..5900 ---');
console.log(html.slice(5480, 5900).replace(/\s+/g, ' '));
