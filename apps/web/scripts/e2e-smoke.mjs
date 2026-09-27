#!/usr/bin/env node
/**
 * End-to-end smoke test over real HTTP.
 *
 * Talks to the running control plane and data plane exactly like a customer
 * would: sign up -> mint a key -> call the router -> see it in /usage. No module
 * imports and no mocks, so a pass means the deployed pair actually works
 * together, not that the units do.
 *
 *   node scripts/e2e-smoke.mjs [webBase] [routerBase]
 */
const WEB = process.argv[2] || process.env.E2E_WEB_URL || 'http://127.0.0.1:3000';
const ROUTER = process.argv[3] || process.env.E2E_ROUTER_URL || 'http://127.0.0.1:8100';
const MODEL = process.env.E2E_MODEL || 'grok-4.6';

let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
	if (ok) {
		passed++;
		console.log(`  ok   ${name}`);
	} else {
		failed++;
		console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`);
	}
}

const email = `e2e-${Date.now().toString(36)}@example.com`;
const password = 'E2eSmoke!2026x';
const name = 'E2E Smoke';

console.log(`\nweb=${WEB}  router=${ROUTER}  model=${MODEL}\n`);

// 1. Sign up through the real auth endpoint.
const signup = await fetch(`${WEB}/api/auth/sign-up/email`, {
	method: 'POST',
	headers: { 'content-type': 'application/json', origin: WEB },
	body: JSON.stringify({ email, password, name })
});
check('signup returns 200', signup.status === 200, `HTTP ${signup.status}`);

const cookies = signup.headers
	.getSetCookie()
	.map((c) => c.split(';')[0])
	.join('; ');
check('signup sets a session cookie', /session_token=/.test(cookies));

// 2. The protected route must reject an anonymous caller and accept this one.
const anon = await fetch(`${WEB}/keys`, { redirect: 'manual' });
check(
	'anonymous /keys is redirected',
	anon.status === 303 || anon.status === 302,
	`HTTP ${anon.status}`
);

const keysPage = await fetch(`${WEB}/keys`, { headers: { cookie: cookies } });
check('authenticated /keys renders', keysPage.status === 200, `HTTP ${keysPage.status}`);

// 3. Mint a key through the real form action.
const create = await fetch(`${WEB}/keys?/create`, {
	method: 'POST',
	headers: {
		cookie: cookies,
		origin: WEB,
		'content-type': 'application/x-www-form-urlencoded'
	},
	body: 'name=e2e-smoke'
});
const createBody = await create.text();
const minted = /sk-ar-[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]+/.exec(createBody);
check('key creation returns a plaintext key', Boolean(minted));
const apiKey = minted ? minted[0] : '';

// 4. The data plane must reject a bogus key and accept the minted one.
const bogus = await fetch(`${ROUTER}/v1/chat/completions`, {
	method: 'POST',
	headers: {
		'content-type': 'application/json',
		authorization: 'Bearer sk-ar-bogus_bogusbogusbogusbogus'
	},
	body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] })
});
check('router rejects an invalid key', bogus.status === 401, `HTTP ${bogus.status}`);

const completion = await fetch(`${ROUTER}/v1/chat/completions`, {
	method: 'POST',
	headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
	body: JSON.stringify({
		model: MODEL,
		messages: [{ role: 'user', content: 'Reply with exactly: E2E' }]
	})
});
const completionBody = await completion.text();
check(
	'router accepts the minted key',
	completion.status === 200,
	`HTTP ${completion.status} ${completionBody.slice(0, 120)}`
);

let usage = null;
try {
	usage = JSON.parse(completionBody).usage;
} catch {
	/* not json */
}
check(
	'completion returns token usage',
	Boolean(usage && usage.prompt_tokens > 0),
	JSON.stringify(usage)
);

// 5. The request must be billed and visible on /usage.
const usagePage = await fetch(`${WEB}/usage`, { headers: { cookie: cookies } });
const usageBody = await usagePage.text();
check('authenticated /usage renders', usagePage.status === 200, `HTTP ${usagePage.status}`);
check('/usage shows the model that was called', usageBody.includes(MODEL));

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
