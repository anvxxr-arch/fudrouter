// What a member (role=user, capability `member`) actually gets: every page, the nav
// it renders, whether admin is truly out of reach, and the logout action.
import { readFileSync } from 'node:fs';

const BASE = 'https://ai.karepmuwes.my.id';
const token = readFileSync('/tmp/fr_session.txt', 'utf8').trim();
const cookie = `__Secure-better-auth.session_token=${token}`;

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: 'manual' });
  return { status: res.status, loc: res.headers.get('location'), html: res.status === 200 ? await res.text() : '' };
}

const titles = (html) => [...html.matchAll(/<h1[^>]*>([^<]+)<\/h1>|<h2[^>]*>([^<]+)<\/h2>/g)]
  .map((m) => (m[1] ?? m[2]).trim())
  .filter(Boolean);

console.log('=== member pages ===');
for (const path of ['/dashboard', '/keys', '/usage', '/account']) {
  const r = await get(path);
  console.log(`  ${path.padEnd(11)} http=${r.status}${r.loc ? ` -> ${r.loc}` : ''}`);
  if (r.status === 200) {
    console.log(`      h1/h2: ${JSON.stringify(titles(r.html))}`);
    const nav = ['/dashboard', '/keys', '/usage', '/account'].filter((h) => r.html.includes(`href="${h}"`));
    console.log(`      nav links: ${nav.length}/4 ${nav.length === 4 ? '✓' : JSON.stringify(nav)}`);
    console.log(`      admin link: ${r.html.includes('href="/admin"') ? 'PRESENT (unexpected for member)' : 'absent ✓'}`);
  }
}

console.log('\n=== admin is out of reach ===');
for (const path of ['/admin', '/admin/models', '/admin/providers', '/admin/providers/googleai']) {
  const r = await get(path);
  console.log(`  ${path.padEnd(28)} http=${r.status}${r.loc ? ` -> ${r.loc}` : ''}`);
}

console.log('\n=== public pages reached while signed in ===');
for (const path of ['/', '/models', '/pricing', '/docs', '/status']) {
  const r = await get(path);
  console.log(`  ${path.padEnd(11)} http=${r.status}`);
}

console.log('\n=== logout action (POST /?/logout) — last, it ends the session ===');
const out = await fetch(`${BASE}/?/logout`, {
  method: 'POST',
  headers: { cookie, Origin: BASE, 'x-sveltekit-action': 'true', 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(),
  redirect: 'manual'
});
const body = await out.text();
console.log(`  http=${out.status} type=${/"type":"(\w+)"/.exec(body)?.[1] ?? 'none'}`);

// After logout the member pages must no longer render.
const after = await get('/dashboard');
console.log(`  /dashboard after logout: http=${after.status}${after.loc ? ` -> ${after.loc}` : ''}`);
