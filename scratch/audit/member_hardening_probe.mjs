// Verify the member surface's honest-truncation notes and the admin nav link.
//   over  — >50 rows and >50 models: both "capped" notes must render
//   under — 3 rows on 3 models: neither note may render
//   admin — the signed-in session must see the Admin link in the member nav
import { readFileSync } from 'node:fs';

const BASE = 'https://ai.karepmuwes.my.id';
const token = readFileSync('/tmp/fr_session.txt', 'utf8').trim();
const cookie = `__Secure-better-auth.session_token=${token}`;
const phase = process.argv[2] ?? 'over';

const get = async (path) => {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: 'manual' });
  return { status: res.status, html: res.status === 200 ? await res.text() : '' };
};

const strip = (s) => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const note = (html, needle) => {
  const m = new RegExp(`<p class="muted"[^>]*>([\\s\\S]*?)</p>`, 'g');
  for (const match of html.matchAll(m)) {
    const text = strip(match[1]);
    if (text.includes(needle)) return text;
  }
  return null;
};
const tableRows = (html, label) => {
  const m = new RegExp(`<table class="fr">([\\s\\S]*?)</table>`, 'g');
  const tables = [...html.matchAll(m)].map((x) => x[1]);
  for (const t of tables) {
    const rows = [...t.matchAll(/<tr>/g)].length - (/<thead>/.test(t) ? 1 : 0);
    return rows;
  }
  return 0;
};

const usage = await get('/dashboard/usage');
const billing = await get('/dashboard/billing');
console.log(`usage http=${usage.status}  billing http=${billing.status}`);

const usageNote = note(usage.html, 'this table is');
const billingNote = note(billing.html, 'highest-cost');
const usageRows = tableRows(usage.html);
const billingRows = tableRows(billing.html);
console.log(`  usage table rows=${usageRows}  note=${usageNote ? `"${usageNote}"` : 'none'}`);
console.log(`  billing table rows=${billingRows}  note=${billingNote ? `"${billingNote}"` : 'none'}`);

let ok = true;
if (phase === 'over') {
  ok = usageNote !== null && billingNote !== null;
  console.log(`  expect BOTH notes present: ${ok ? 'yes ✓' : 'NO ✗'}`);
} else if (phase === 'under') {
  ok = usageNote === null && billingNote === null;
  console.log(`  expect NEITHER note present: ${ok ? 'yes ✓' : 'NO ✗'}`);
} else if (phase === 'admin') {
  const dash = (await get('/dashboard')).html;
  const hasAdmin = dash.includes('href="/admin"');
  const hasBilling = dash.includes('href="/dashboard/billing"');
  console.log(`  admin link in member nav: ${hasAdmin ? 'yes ✓' : 'NO ✗'}`);
  console.log(`  billing link in member nav: ${hasBilling ? 'yes ✓' : 'NO ✗'}`);
  ok = hasAdmin && hasBilling;
}
process.exit(ok ? 0 : 1);
