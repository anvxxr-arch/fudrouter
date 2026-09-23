// Live probe of /admin/providers/[id]: every action exercised against the
// running app, reporting real status codes and upstream replies.
import { readFileSync } from 'node:fs';

const BASE = 'https://ai.karepmuwes.my.id';
const PID = process.argv[2] ?? 'googleai';
const SLUG = process.argv[3] ?? 'gemini-3.6-flash';
const token = readFileSync('/tmp/fr_session.txt', 'utf8').trim();
const cookie = `__Secure-better-auth.session_token=${token}`;

async function post(action, fields = {}) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  const res = await fetch(`${BASE}/admin/providers/${PID}?/${action}`, {
    method: 'POST',
    headers: {
      cookie,
      Origin: BASE,
      'x-sveltekit-action': 'true',
      'content-type': 'application/x-www-form-urlencoded'
    },
    body
  });
  const text = await res.text();
  return { status: res.status, text };
}

// The action response is devalue-serialized: {"type","status","data":"[…]"} where
// `data` is a JSON array whose first element is the payload and whose numbers are
// INDICES into that same array. Resolve them recursively.
function resolve(v, arr) {
	// A number is an index into `arr`. Recurse only when the looked-up value is
	// itself a container — a primitive at that index IS the final value, and
	// re-resolving it would loop forever.
	if (typeof v === 'number') {
		const r = v < 0 ? v : arr[v];
		return r && typeof r === 'object' ? resolve(r, arr) : r;
	}
	if (Array.isArray(v)) return v.map((x) => resolve(x, arr));
	if (v && typeof v === 'object') {
		const out = {};
		for (const [k, val] of Object.entries(v)) out[k] = resolve(val, arr);
		return out;
	}
	return v;
}

function data(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed.type === 'failure') return { error: parsed.error ?? parsed.data };
    return resolve(JSON.parse(parsed.data)[0], JSON.parse(parsed.data));
  } catch {
    return null;
  }
}

function report(name, res, extra = '') {
  const d = data(res.text);
  const err = d?.error ?? (res.text.includes('"type":"failure"') ? res.text.slice(0, 160) : null);
  console.log(
    `${res.status === 200 && !err ? 'OK  ' : 'FAIL'} ${name.padEnd(18)} http=${res.status}${
      err ? ` err=${String(err).slice(0, 140)}` : ''
    }${extra ? ` ${extra}` : ''}`
  );
  return d;
}

// 1. page render
const page = await fetch(`${BASE}/admin/providers/${PID}`, { headers: { cookie } });
const html = await page.text();
const headings = [
  'Statistik usage',
  'Quota',
  'Rate limit',
  'Strategy routing',
  'Credentials',
  'Fetch models',
  'Catalog',
  'Playground'
];
console.log(`page http=${page.status} bytes=${html.length}`);
for (const h of headings) {
  console.log(`  ${html.includes(h) ? '✓' : '✗'} ${h}`);
}
console.log('');

// 2. fetch catalog
const fetchRes = await post('fetchCatalog', { tier: 'all' });
const fetched = data(fetchRes.text)?.fetched;
const models = fetched?.models ?? [];
const tiers = models.reduce((a, m) => ((a[m.tier] = (a[m.tier] ?? 0) + 1), a), {});
report('fetchCatalog', fetchRes, `models=${models.length} tiers=${JSON.stringify(tiers)}`);
const sample = models.slice(0, 3).map((m) => `${m.slug}(${m.tier})`);
console.log(`     sample: ${sample.join(', ')}`);

// 2b. the tier filter the admin clicks through
for (const tier of ['free', 'paid', 'unknown']) {
	const r = await post('fetchCatalog', { tier });
	const f = data(r.text)?.fetched;
	const list = f?.models ?? [];
	const leaked = list.filter((m) => m.tier !== tier).length;
	console.log(
		`     tier=${tier.padEnd(7)} total=${f?.total ?? '?'} shown=${list.length} leakedOtherTier=${leaked}`
	);
}

// 3. single credential test
report('testCredential', await post('testCredential', { index: '0' }));

// 4. bulk credential test
const all = await post('testAll');
const allData = data(all.text);
report('testAll', all, `probed=${allData?.credentialTests?.length ?? 0} ok=${(allData?.credentialTests ?? []).filter((t) => t.ok).length}`);

// 5. test model
const tm = await post('testModel', { slug: SLUG });
const tmData = data(tm.text);
report('testModel', tm, tmData?.modelTest ? `${tmData.modelTest.latencyMs}ms tokens=${tmData.modelTest.tokensIn}/${tmData.modelTest.tokensOut} reply=${JSON.stringify(String(tmData.modelTest.content ?? tmData.modelTest.error ?? '').slice(0, 60))}` : '');

// 6. playground
const chat = await post('chat', { slug: SLUG, message: 'Say OK and nothing else.' });
const chatData = data(chat.text);
report('chat', chat, chatData?.chat ? `${chatData.chat.latencyMs}ms tokens=${chatData.chat.tokensIn}/${chatData.chat.tokensOut} reply=${JSON.stringify(String(chatData.chat.content ?? chatData.chat.error ?? '').slice(0, 80))}` : '');

// 7. disable / enable round trip on a slug
const dis = await post('disable', { slug: SLUG });
report('disable', dis);

const en = await post('enable', {
  payload: JSON.stringify({ slug: SLUG, name: SLUG, context: 1000000, inputUsd: 0, outputUsd: 0 })
});
report('enable', en);

// 8. strategy — change it, then put it back so the probe is not destructive.
const originalPriority = html.match(/Priority<\/dt>\s*<dd>(\d+)<\/dd>/)?.[1] ?? null;
const next = String((Number(originalPriority ?? '100') || 100) + 1);
report('strategy', await post('strategy', { priority: next }), `set=${next}`);
if (originalPriority !== null) {
  const back = await post('strategy', { priority: originalPriority });
  console.log(`     restored priority to ${originalPriority}: http=${back.status}`);
}
