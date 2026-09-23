// Verify the member surface moved to /dashboard/* : new URLs serve, old ones are
// gone, nav hrefs are absolute again, titles resolve, and admin stays out of reach.
import { readFileSync } from 'node:fs';

const BASE = 'https://ai.karepmuwes.my.id';
const token = readFileSync('/tmp/fr_session.txt', 'utf8').trim();
const cookie = `__Secure-better-auth.session_token=${token}`;

const get = async (path) => {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: 'manual' });
  return { status: res.status, loc: res.headers.get('location'), html: res.status === 200 ? await res.text() : '' };
};

console.log('=== new member URLs ===');
for (const p of ['/dashboard', '/dashboard/keys', '/dashboard/usage', '/dashboard/account']) {
  const r = await get(p);
  const title = /<title>([^<]*)<\/title>/.exec(r.html)?.[1] ?? '?';
  const h1 = /<h1[^>]*>([^<]+)<\/h1>/.exec(r.html)?.[1] ?? '?';
  console.log(`  ${p.padEnd(19)} http=${r.status}  title="${title}"  h1="${h1}"`);
}

console.log('\n=== old URLs must be gone ===');
for (const p of ['/keys', '/usage', '/account']) {
  const r = await get(p);
  console.log(`  ${p.padEnd(19)} http=${r.status}${r.loc ? ` -> ${r.loc}` : ''}`);
}

console.log('\n=== nav hrefs (must be absolute now) ===');
const keysHtml = (await get('/dashboard/keys')).html;
for (const h of ['/dashboard', '/dashboard/keys', '/dashboard/usage', '/dashboard/account']) {
  console.log(`  href="${h}" ${keysHtml.includes(`href="${h}"`) ? 'present ✓' : 'MISSING ✗'}`);
}
const relative = [...keysHtml.matchAll(/href="(\.\.?\/[^"]*)"/g)].map((m) => m[1]);
console.log(`  relative hrefs in nav: ${relative.length === 0 ? 'none ✓' : JSON.stringify(relative)}`);
console.log(`  admin link: ${keysHtml.includes('href="/admin"') ? 'PRESENT ✗' : 'absent ✓'}`);

console.log('\n=== old-style relative link would have broken: prove resolution ===');
console.log('  from /dashboard/keys, "./usage" resolves to /dashboard/usage only by luck of siblings;');
console.log('  absolute hrefs remove the guesswork entirely.');

console.log('\n=== admin still out of reach for a member ===');
for (const p of ['/admin', '/admin/providers/googleai']) {
  const r = await get(p);
  console.log(`  ${p.padEnd(28)} http=${r.status}${r.loc ? ` -> ${r.loc}` : ''}`);
}

console.log('\n=== pages interacted with (session still valid) ===');
console.log(`  logout form present on /dashboard: ${(await get('/dashboard')).html.includes('?/logout') ? 'yes ✓' : 'no ✗'}`);
