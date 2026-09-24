// Verify /dashboard/billing against real rows: mint a key + two request_log rows for the
// probe user with known costs, then assert the page's arithmetic matches.
import { readFileSync } from 'node:fs';

const BASE = 'https://ai.karepmuwes.my.id';
const token = readFileSync('/tmp/fr_session.txt', 'utf8').trim();
const cookie = `__Secure-better-auth.session_token=${token}`;

const res = await fetch(`${BASE}/dashboard/billing`, { headers: { cookie }, redirect: 'manual' });
const html = await res.text();
console.log(`GET /dashboard/billing -> http=${res.status}`);
if (res.status !== 200) process.exit(1);

const h1 = /<h1[^>]*>([^<]+)<\/h1>/.exec(html)?.[1];
const title = /<title>([^<]*)<\/title>/.exec(html)?.[1];
console.log(`  title="${title}"  h1="${h1}"`);

const h2s = [...html.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map((m) => m[1].trim());
console.log(`  sections: ${JSON.stringify(h2s)}`);

// Stat cards render label + value pairs.
const stats = [...html.matchAll(/<span class="label[^"]*">([^<]+)<\/span>\s*<span class="value[^"]*">([^<]+)<\/span>/g)]
  .map((m) => `${m[1]} = ${m[2]}`);
if (stats.length === 0) {
  const loose = [...html.matchAll(/(Spend to date|This month|Requests|Tokens)[\s\S]{0,160}?<\/span>/g)].length;
  console.log(`  (pattern stat-card beda, fallback count=${loose})`);
} else {
  console.log('  stat cards:');
  for (const s of stats) console.log(`    ${s}`);
}

console.log(`  honest "does not bill" alert present: ${html.includes('does not bill') ? 'yes ✓' : 'NO ✗'}`);
console.log(`  guide section rendered: ${html.includes('What is not billed') ? 'yes ✓' : 'NO ✗'}`);
console.log(`  nav Billing link: ${html.includes('href="/dashboard/billing"') ? 'yes ✓' : 'NO ✗'}`);

const rows = [...html.matchAll(/<tr>[\s\S]*?<\/tr>/g)].map((m) => m[0]);
const cellText = (r) => [...r.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) =>
  c[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
);
const byModel = rows.map(cellText).filter((c) => c.length === 5);
const charges = rows.map(cellText).filter((c) => c.length === 6);
console.log(`  usage-by-model rows: ${byModel.length}`);
for (const r of byModel.slice(0, 3)) console.log(`    ${r.join(' | ')}`);
console.log(`  recent-charge rows: ${charges.length}`);
for (const r of charges.slice(0, 3)) console.log(`    ${r.join(' | ')}`);

// The arithmetic the DB was seeded with: 1,500,000 + 500,000 micro = $2.00 over two calls.
const spendOk = html.includes('$2.00');
console.log(`  seeded total $2.00 present: ${spendOk ? 'yes ✓' : 'NO ✗'}`);
process.exit(spendOk && html.includes('What is not billed') ? 0 : 1);
