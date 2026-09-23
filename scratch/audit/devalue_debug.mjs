// Debug the fetchCatalog action payload: why does the devalue decode fail?
import { readFileSync } from 'node:fs';

const BASE = 'https://ai.karepmuwes.my.id';
const PID = process.argv[2] ?? 'googleai';
const token = readFileSync('/tmp/fr_session.txt', 'utf8').trim();

const res = await fetch(`${BASE}/admin/providers/${PID}?/fetchCatalog`, {
  method: 'POST',
  headers: {
    cookie: `__Secure-better-auth.session_token=${token}`,
    Origin: BASE,
    'x-sveltekit-action': 'true',
    'content-type': 'application/x-www-form-urlencoded'
  },
  body: new URLSearchParams({ tier: 'all' })
});
const text = await res.text();
console.log(`http=${res.status} bytes=${text.length}`);

const parsed = JSON.parse(text);
console.log(`type=${parsed.type} status=${parsed.status}`);
const arr = JSON.parse(parsed.data);
console.log(`arr length=${arr.length}`);
console.log(`arr[0]=${JSON.stringify(arr[0])}`);
console.log(`arr[1]=${JSON.stringify(arr[1]).slice(0, 200)}`);
console.log(`arr[5]=${JSON.stringify(arr[5])}  arr[6] type=${Array.isArray(arr[6]) ? 'array len ' + arr[6].length : typeof arr[6]}`);
console.log(`arr[7]=${JSON.stringify(arr[7])}`);
console.log(`arr[8]=${JSON.stringify(arr[8])}`);
console.log(`arr[9]=${JSON.stringify(arr[9])}`);
console.log(`arr[11]=${JSON.stringify(arr[11])}`);
console.log(`arr[189]=${JSON.stringify(arr[189])}`);

// Does any array contain its own index (which would make a naive resolver loop)?
let selfRef = [];
for (let i = 0; i < arr.length; i++) {
  if (Array.isArray(arr[i]) && arr[i].includes(i)) selfRef.push(i);
}
console.log(`arrays containing their own index: ${JSON.stringify(selfRef)}`);

// How many elements are containers vs primitives
let containers = 0, prims = 0;
for (const el of arr) (el && typeof el === 'object' ? containers++ : prims++);
console.log(`containers=${containers} primitives=${prims}`);

// The app's own output: every slug it emitted, so blank ones are unambiguous.
const arr2 = JSON.parse(parsed.data);
function resolve(v, a) {
  if (typeof v === 'number') {
    const r = v < 0 ? v : a[v];
    return r && typeof r === 'object' ? resolve(r, a) : r;
  }
  if (Array.isArray(v)) return v.map((x) => resolve(x, a));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = resolve(val, a);
    return o;
  }
  return v;
}
const payload = resolve(arr2[0], arr2);
const models = payload.fetched.models;
console.log(`app emitted ${models.length} models`);
const blanks = models.filter((m) => !m.slug || !String(m.slug).trim());
console.log(`app emitted blank slugs: ${blanks.length}`);
console.log(`slugs: ${models.map((m) => JSON.stringify(m.slug)).join(' ')}`);
console.log(`blank entries: ${JSON.stringify(blanks.slice(0, 5))}`);
