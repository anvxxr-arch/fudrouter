#!/usr/bin/env node
/**
 * End-to-end acceptance smoke over real HTTP (PRD §144).
 *
 * Talks to the running control plane and data plane exactly like a customer
 * would: sign up -> create project -> mint a key -> call the router -> inspect
 * the request -> inspect usage/cost. No module imports and no mocks, so a pass
 * means the deployed pair actually works together, not that the units do.
 *
 *   node scripts/e2e-smoke.mjs [webBase] [routerBase]
 *
 * Env:
 *   E2E_WEB_URL / E2E_ROUTER_URL — same as the positional args
 *   E2E_MODEL                    — model id the data plane serves (default gemini-3.1-flash-lite)
 *   E2E_ORIGIN                   — Origin header to claim (see "0." below; usually
 *                                  auto-detected, so you rarely need to set it)
 *
 * Exit 0 only when every acceptance step passes.
 */
const WEB = process.argv[2] || process.env.E2E_WEB_URL || 'http://127.0.0.1:3000';
const ROUTER = process.argv[3] || process.env.E2E_ROUTER_URL || 'http://127.0.0.1:8100';
// A currently-routable model. Override with E2E_MODEL to exercise a specific
// one — but a model whose provider/credential pool is down (e.g. grok-4.6 while
// the xai OAuth walk times out) will 502 PROVIDER_UNAVAILABLE, which is the
// router's correct answer, not an app fault.
const MODEL = process.env.E2E_MODEL || 'gemini-3.1-flash-lite';

// ---------------------------------------------------------------------------
// 0. Discover which Origin the control plane trusts.
//
// better-auth's CSRF guard compares the request's Origin header against the
// server's configured baseURL (auth.ts also empties trustedOrigins in
// production, so nothing else is accepted there). Connecting to 127.0.0.1 while
// the server's baseURL is the public origin therefore fails EVERY control-plane
// POST with 403 "Cross-site POST form submissions are forbidden" — a harness
// artefact, not a product fault: a real customer's browser posts from the public
// origin, and that path is fine.
//
// So "where we connect" and "which Origin we claim" are separate concerns. We
// probe candidates with a request that has no side effects — a sign-in whose
// credentials cannot succeed (403 = the CSRF guard rejected the Origin; any
// other status = it got past the guard and was judged on its credentials, which
// is all we asked) — and claim the first trusted one while still connecting to
// WEB.
// ---------------------------------------------------------------------------
// The app emits its own baseURL as every page's canonical/og:url, so the served
// HTML reveals the origin the CSRF guard trusts even when this script runs
// without the app's .env loaded.
async function discoverOrigin() {
	try {
		const res = await fetch(`${WEB}/`);
		if (!res.ok) return null;
		const html = await res.text();
		const m =
			/<link[^>]+rel="canonical"[^>]+href="(https?:\/\/[^/"]+)/i.exec(html) ??
			/<meta[^>]+property="og:url"[^>]+content="(https?:\/\/[^/"]+)/i.exec(html);
		return m ? m[1] : null;
	} catch {
		return null;
	}
}

const ORIGIN_CANDIDATES = [
	process.env.E2E_ORIGIN,
	process.env.ORIGIN,
	await discoverOrigin(),
	WEB
].filter((v, i, a) => v && a.indexOf(v) === i);

async function trustedOrigin() {
	for (const candidate of ORIGIN_CANDIDATES) {
		try {
			const res = await fetch(`${WEB}/api/auth/sign-in/email`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', origin: candidate },
				body: JSON.stringify({
					email: `origin-probe-${Date.now().toString(36)}@example.com`,
					password: 'not-a-real-password'
				})
			});
			if (res.status !== 403) return { origin: candidate, status: res.status };
		} catch {
			/* unreachable candidate — try the next */
		}
	}
	return { origin: WEB, status: 0 };
}
const { origin: CSRF_ORIGIN, status: originProbeStatus } = await trustedOrigin();

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
console.log(`\nweb=${WEB}  router=${ROUTER}  model=${MODEL}  origin=${CSRF_ORIGIN}\n`);
if (CSRF_ORIGIN !== WEB) {
	console.log(
		`  note: control plane trusts Origin ${CSRF_ORIGIN}, not ${WEB} (probe HTTP ${originProbeStatus}) —\n` +
			`        claiming ${CSRF_ORIGIN} for control-plane POSTs while connecting to ${WEB}.\n`
	);
}

// Fail fast and legibly: without this, an unreachable plane surfaces as an
// unhandled fetch rejection and buries the cause in a stack trace.
for (const [label, base] of [
	['control plane', WEB],
	['data plane', ROUTER]
]) {
	try {
		await fetch(`${base}/`, { method: 'HEAD' });
	} catch (err) {
		// Node wraps a connection refusal in an AggregateError (one entry per
		// resolved address), so the useful code lives one level deeper than
		// err.cause.code on its own.
		const code =
			err.cause?.code ?? err.cause?.errors?.[0]?.code ?? err.cause?.message ?? err.message;
		console.error(`\nFAIL: ${label} ${base} is unreachable — ${code}\n`);
		process.exit(1);
	}
}

// ---------------------------------------------------------------------------
// 1. Register (PRD §144 "Developer dapat: register").
//    Signup auto-provisions workspace + default project + 3 environments +
//    billing account (lib/server/provision.ts).
// ---------------------------------------------------------------------------
const signup = await fetch(`${WEB}/api/auth/sign-up/email`, {
	method: 'POST',
	headers: { 'content-type': 'application/json', origin: CSRF_ORIGIN },
	body: JSON.stringify({ email, password, name })
});
check(
	'signup returns 200',
	signup.status === 200,
	signup.status === 403
		? `HTTP 403 — control plane rejected Origin ${CSRF_ORIGIN}; set E2E_ORIGIN to the origin it trusts (its ORIGIN / baseURL)`
		: `HTTP ${signup.status}`
);
const cookies = signup.headers
	.getSetCookie()
	.map((c) => c.split(';')[0])
	.join('; ');
check('signup sets a session cookie', /session_token=/.test(cookies));
const auth = { cookie: cookies, origin: CSRF_ORIGIN };

// ---------------------------------------------------------------------------
// 2. Create project (PRD §144 "create project"). POST the real form action;
//    success redirects 303 to /dashboard/projects/{prj_…}.
// ---------------------------------------------------------------------------
const projectName = `E2E Project ${Date.now().toString(36)}`;
const createProject = await fetch(`${WEB}/dashboard/projects/new?/create`, {
	method: 'POST',
	redirect: 'manual',
	headers: {
		...auth,
		accept: 'text/html', // form action: text/html → real 303+Location; */* → SvelteKit devalue body
		'content-type': 'application/x-www-form-urlencoded'
	},
	body: new URLSearchParams({ name: projectName, description: 'e2e smoke' }).toString()
});
check('project create returns 303', createProject.status === 303, `HTTP ${createProject.status}`);
const projectId = /prj_[A-Za-z0-9_-]+/.exec(createProject.headers.get('location') ?? '')?.[0] ?? '';
check('project create redirects to the new project', Boolean(projectId), createProject.headers.get('location') ?? '');

// ---------------------------------------------------------------------------
// 3. Mint a key (PRD §144 "create API key"). Needs an environment id from the
//    keys page load; the plaintext key is returned exactly once, here.
// ---------------------------------------------------------------------------
const keysPage = await fetch(`${WEB}/dashboard/projects/${projectId}/keys`, { headers: auth });
check('keys page renders', keysPage.status === 200, `HTTP ${keysPage.status}`);
const keysHtml = await keysPage.text();
// The key-create form's own environment <select name="environmentId"> carries
// exactly this project's environments. The page also renders a shell env
// switcher (id="feid-switch") plus other projects' rows — a bare `env_` scrape
// or a first `name="environmentId"` match grabs one of those, which the create
// action rejects ("Pick an environment of this project"). Scope to the form.
const createForm = /<form[^>]*action="\?\/create"[^>]*>([\s\S]*?)<\/form>/.exec(keysHtml);
const envSelect = createForm
	? /<select[^>]*name="environmentId"[^>]*>([\s\S]*?)<\/select>/.exec(createForm[1])
	: null;
const envIds = envSelect
	? [...envSelect[1].matchAll(/env_[A-Za-z0-9_-]+/g)].map((m) => m[0])
	: [];
const environmentId = envIds[0] ?? '';
check('project has environments', envIds.length > 0, `found ${envIds.length}`);

const createKey = await fetch(`${WEB}/dashboard/projects/${projectId}/keys?/create`, {
	method: 'POST',
	headers: {
		...auth,
		accept: 'text/html', // form action: render the page carrying `form.created` (the one-time key)
		'content-type': 'application/x-www-form-urlencoded'
	},
	body: new URLSearchParams({ name: 'e2e-smoke', environmentId }).toString()
});
const createKeyBody = await createKey.text();
check('key create returns 200', createKey.status === 200, `HTTP ${createKey.status}`);
const minted = /sk-ar-[A-Za-z0-9-]{8}_[A-Za-z0-9_-]+/.exec(createKeyBody);
check('key creation returns a plaintext key', Boolean(minted), createKeyBody.slice(0, 120));
const apiKey = minted ? minted[0] : '';
// ---------------------------------------------------------------------------
// 3.5. Fund the account (PRD §63 credits). Payment processing is out of scope,
//      so the ledger's add-credits action is how an account gets balance. A
//      fresh signup starts at zero and the router hard-stops at or below the
//      threshold with 402 INSUFFICIENT_CREDITS, so a paid call needs a
//      credit_purchase posting first. The idempotency `key` must be unique.
// ---------------------------------------------------------------------------
const addCredits = await fetch(`${WEB}/dashboard/billing/credits?/add`, {
	method: 'POST',
	headers: {
		...auth,
		accept: 'text/html',
		'content-type': 'application/x-www-form-urlencoded'
	},
	body: new URLSearchParams({
		amount: '100.00',
		description: 'e2e smoke funding',
		key: `purchase:e2e-${Date.now().toString(36)}`
	}).toString()
});
const addCreditsBody = await addCredits.text();
check(
	'add credits succeeds',
	addCredits.status === 200 && addCreditsBody.includes('Credit purchase recorded'),
	`HTTP ${addCredits.status}`
);

// ---------------------------------------------------------------------------
// 4. Call the compatible API (PRD §144 "call compatible API / receive model
//    response"). A bogus key must 401 first.
// ---------------------------------------------------------------------------
const bogus = await fetch(`${ROUTER}/v1/chat/completions`, {
	method: 'POST',
	headers: {
		'content-type': 'application/json',
		authorization: 'Bearer sk-ar-bogusbogus_bogusbogusbogusbogusbogus'
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
const requestId = completion.headers.get('x-fudrouter-request-id') ?? '';
check('response carries x-fudrouter-request-id', Boolean(requestId));

// ---------------------------------------------------------------------------
// 4.5. Call the Anthropic Messages surface (POST /v1/messages).
//
// The router serves the Anthropic Messages API natively — same auth, routing,
// limits and billing, different wire shape — so an Anthropic client (e.g. the
// [CC] CLI) needs no translator in front. This asserts the inbound surface
// really answers a native request, not just that the handler compiles.
// ---------------------------------------------------------------------------
const anthropicUnauth = await fetch(`${ROUTER}/v1/messages`, {
	method: 'POST',
	headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
	body: JSON.stringify({
		model: MODEL,
		max_tokens: 16,
		messages: [{ role: 'user', content: 'Reply with exactly: E2E' }]
	})
});
const anthropicUnauthBody = await anthropicUnauth.text();
let anthropicErr = null;
try {
	anthropicErr = JSON.parse(anthropicUnauthBody);
} catch {
	/* not json */
}
check(
	'/v1/messages rejects a missing key',
	anthropicUnauth.status === 401,
	`HTTP ${anthropicUnauth.status}`
);
check(
	'/v1/messages error is Anthropic-shaped',
	anthropicErr?.type === 'error' && anthropicErr?.error?.type === 'authentication_error',
	anthropicUnauthBody.slice(0, 120)
);

const messages = await fetch(`${ROUTER}/v1/messages`, {
	method: 'POST',
	headers: {
		'content-type': 'application/json',
		'anthropic-version': '2023-06-01',
		'x-api-key': apiKey
	},
	body: JSON.stringify({
		model: MODEL,
		max_tokens: 32,
		messages: [{ role: 'user', content: 'Reply with exactly: E2E' }]
	})
});
const messagesBody = await messages.text();
check(
	'/v1/messages accepts the minted key',
	messages.status === 200,
	`HTTP ${messages.status} ${messagesBody.slice(0, 160)}`
);
let message = null;
try {
	message = JSON.parse(messagesBody);
} catch {
	/* not json */
}
check(
	'/v1/messages answers in Anthropic shape',
	message?.type === 'message' &&
		Array.isArray(message?.content) &&
		message.content.some((b) => b.type === 'text'),
	JSON.stringify(message?.content)?.slice(0, 160) ?? messagesBody.slice(0, 160)
);
check(
	'/v1/messages reports usage',
	Boolean(message?.usage?.input_tokens >= 0 && message?.usage?.output_tokens > 0),
	JSON.stringify(message?.usage)
);
check(
	'/v1/messages carries x-fudrouter-request-id',
	Boolean(messages.headers.get('x-fudrouter-request-id'))
);

// count_tokens: the Anthropic tokeniser endpoint. It must answer without a
// provider round-trip and never bill.
const countTokens = await fetch(`${ROUTER}/v1/messages/count_tokens`, {
	method: 'POST',
	headers: {
		'content-type': 'application/json',
		'anthropic-version': '2023-06-01',
		'x-api-key': apiKey
	},
	body: JSON.stringify({
		model: MODEL,
		messages: [{ role: 'user', content: 'Count these tokens please.' }]
	})
});
const countTokensBody = await countTokens.text();
let counted = null;
try {
	counted = JSON.parse(countTokensBody);
} catch {
	/* not json */
}
check(
	'/v1/messages/count_tokens returns a positive count',
	countTokens.status === 200 && counted?.input_tokens > 0,
	`HTTP ${countTokens.status} ${countTokensBody.slice(0, 120)}`
);

// ---------------------------------------------------------------------------
// 5. Inspect the request (PRD §144 "inspect request", PRD §28–29 detail page).
// ---------------------------------------------------------------------------
const requestDetail = await fetch(
	`${WEB}/dashboard/projects/${projectId}/requests/${requestId}`,
	{ headers: auth }
);
const requestDetailBody = await requestDetail.text();
const hasReq = Boolean(requestId);
check('request detail renders', hasReq && requestDetail.status === 200, `HTTP ${requestDetail.status}`);
check('request detail shows the request id', hasReq && requestDetailBody.includes(requestId));

// ---------------------------------------------------------------------------
// 6. Inspect usage + cost (PRD §144 "inspect usage / inspect cost").
// ---------------------------------------------------------------------------
const usagePage = await fetch(`${WEB}/dashboard/usage`, { headers: auth });
const usageBody = await usagePage.text();
check('usage page renders', usagePage.status === 200, `HTTP ${usagePage.status}`);
check('usage page shows the model that was called', usageBody.includes(MODEL));

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
