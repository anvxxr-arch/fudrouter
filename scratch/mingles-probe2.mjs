// Sequential re-probe of the Mingles slugs — the parallel pass tripped the
// gateway's own 429, and Gonka routing is time-varying, so each slug gets 3
// tries 4s apart.
import { readFileSync, writeFileSync } from 'node:fs';

const key = JSON.parse(readFileSync('/home/dwizzy/mingles-router-farmer/mingles_keys.json', 'utf8'))[0].key;
const base = 'https://router.mingles.ai/v1';
const slugs = JSON.parse(readFileSync('/home/dwizzy/.hermes/cache/scratch/mingles-slugs.json', 'utf8'));
const out = {};
for (const slug of slugs) {
  const tries = [];
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    try {
      const res = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: slug, messages: [{ role: 'user', content: 'Reply with exactly: OK' }], max_tokens: 24 }),
        signal: AbortSignal.timeout(75000),
      });
      const body = (await res.text()).replace(/\s+/g, ' ');
      tries.push({ status: res.status, ms: Date.now() - t0, snip: body.slice(0, 110) });
    } catch (e) {
      tries.push({ status: 0, ms: Date.now() - t0, snip: String(e).slice(0, 90) });
    }
    if (tries.at(-1).status === 200) break;
    await new Promise((r) => setTimeout(r, 4000));
  }
  out[slug] = tries;
  console.log(slug);
  for (const t of tries) console.log('  ', t.status, t.ms + 'ms', t.snip);
}
writeFileSync('/home/dwizzy/.hermes/cache/scratch/mingles-probe2.json', JSON.stringify(out, null, 1));
