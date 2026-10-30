#!/usr/bin/env node
/**
 * ops/verify/e2e-smoke.mjs — acceptance harness for a deployed fudrouter pair
 * (console + router), driven over real HTTP exactly like a customer.
 *
 * This replaces the pre-React `apps/web/scripts/e2e-smoke.mjs`, which was deleted
 * with the SvelteKit control plane. Two things changed in the product and are
 * reflected here:
 *
 *   - console signup is OAuth-only (`emailAuthEnabled` is false), so a script
 *     cannot create a user through the API. The harness starts from an existing
 *     user and mints a short-lived better-auth session row for it, then uses the
 *     REAL key endpoints from there. Everything after step 1 is the customer path.
 *   - there is no `projects` concept on this surface: a user owns keys directly.
 *
 * Chain, no mocks, no module imports:
 *
 *   1. session  → GET  /api/pages/dashboard           (who am I / shell loads)
 *   2. mint     → POST /api/pages/keys/create         (the customer's key)
 *   3. list     → GET  /api/pages/keys                (it appears, active)
 *   4. catalogue→ GET  /v1/models                     (public, key-independent)
 *   5. call     → POST /v1/chat/completions           (the real thing)
 *   6. ledger   → request_log row for THAT key, closed, with a price
 *   7. usage    → GET  /api/pages/usage               (account rollup sees it)
 *   8. per-key  → GET  /api/pages/keys                (usage30d.requests >= 1)
 *   9. revoke   → POST /api/pages/keys/revoke
 *  10. refused  → POST /v1/chat/completions           (401 after revoke)
 *  11. authed?  → GET  /api/pages/keys with no cookie (401)
 *
 * Usage:
 *   node ops/verify/e2e-smoke.mjs [model-slug]
 *   node ops/verify/e2e-smoke.mjs --public https://ai.karepmuwes.my.id
 *
 *   --public <origin>  send the console traffic to that origin instead of
 *                      127.0.0.1:3002 (the router stays on ROUTER_BASE unless
 *                      ROUTER_BASE is set). Use it to prove the tunnel + Caddy
 *                      path, not just loopback: better-auth's trustedOrigins is
 *                      empty in production, so a same-origin public run is the
 *                      only one that exercises the real cookie jar.
 *
 * Exit code 0 only when every check passes. The temp key is revoked on exit;
 * the session row is deleted.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const publicIdx = args.indexOf('--public');
const CONSOLE = publicIdx >= 0 ? args[publicIdx + 1] : (process.env.CONSOLE_BASE || 'http://127.0.0.1:3002');
const ROUTER = process.env.ROUTER_BASE || 'http://127.0.0.1:8100';
const USER_ID = process.env.VERIFY_USER_ID || 'usr_01a0f3f5-af5a-72a6-b8ae-3483d21a0ba3';
const MODEL = args.find((a, i) => !a.startsWith('--') && i !== publicIdx + 1) || 'deepseek-v4.1-flash';

function env(key) {
	const line = readFileSync('.env', 'utf8').split('\n').find((l) => l.startsWith(`${key}=`));
	if (!line) throw new Error(`${key} missing from .env (run from the repo root)`);
	return line.slice(key.length + 1).replace(/^"|"$/g, '');
}
const psql = (q) => execFileSync('docker', ['exec', 'postgre', 'psql', '-U', 'postgres', '-d', 'fudrouter', '-tAc', q], { encoding: 'utf8' }).trim();

// ---- fixtures ---------------------------------------------------------------
const sessionId = `ses_${randomBytes(8).toString('hex')}`;
const sessionToken = randomBytes(32).toString('base64url');
psql(`insert into session (id, expires_at, token, created_at, updated_at, user_id) values ('${sessionId}', now() + interval '20 minutes', '${sessionToken}', now(), now(), '${USER_ID}');`);
// better-auth: HMAC-SHA256(secret, token), signature as standard base64 (padded).
const sig = createHmac('sha256', env('BETTER_AUTH_SECRET')).update(sessionToken).digest('base64');
const signed = `${sessionToken}.${sig}`;
const cookie = `__Secure-better-auth.session_token=${signed}; better-auth.session_token=${signed}`;

let keyId = null;
let apiKey = null;
const cleanup = () => {
	try {
		if (keyId) psql(`update api_key set status='revoked', revoked_at=now() where id='${keyId}';`);
		psql(`delete from session where id='${sessionId}';`);
		console.log('\n[cleanup] temp key revoked, temp session deleted');
	} catch (e) { console.error('[cleanup] failed:', e.message); }
};
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

let failures = 0;
const check = (label, ok, detail = '') => {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures += 1;
};
const consoleCall = (path, body, withCookie = true) => fetch(`${CONSOLE}${path}`, {
	method: body ? 'POST' : 'GET',
	headers: { ...(withCookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
	body: body ? JSON.stringify(body) : undefined,
	redirect: 'manual',
}).then(async (r) => ({ status: r.status, text: await r.text() }));
const routerCall = (path, body, key, withHeaders = false) => fetch(`${ROUTER}${path}`, {
	method: body ? 'POST' : 'GET',
	headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
	body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({
	status: r.status,
	text: await r.text(),
	requestId: withHeaders ? r.headers.get('x-fudrouter-request-id') : null,
}));
const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };

console.log(`console ${CONSOLE} · router ${ROUTER} · model ${MODEL}\n`);

// ---- 1. session -------------------------------------------------------------
const dash = await consoleCall('/api/pages/dashboard');
const dashObj = parse(dash.text) ?? {};
check('session opens the dashboard API', dash.status === 200, `${dash.status} keys=${Object.keys(dashObj).join(',') || '-'}`);

// ---- 2. mint a key through the real endpoint -------------------------------
const mint = await consoleCall('/api/pages/keys/create', { name: `fox-e2e-${randomBytes(3).toString('hex')}`, expiresIn: 'never' });
const mintObj = parse(mint.text) ?? {};
keyId = mintObj.id ?? null;
apiKey = mintObj.created ?? null;
check('POST /api/pages/keys/create', mint.status === 200 && typeof apiKey === 'string' && apiKey.startsWith('sk-ar-'), `${mint.status} prefix=${String(apiKey).slice(0, 12)}…`);

// ---- 3. the key shows up, active -------------------------------------------
const list = await consoleCall('/api/pages/keys');
const listObj = parse(list.text) ?? {};
const row = (listObj.keys ?? []).find((k) => k.id === keyId);
check('GET /api/pages/keys lists it', list.status === 200 && !!row, `${list.status} ${row ? row.status : 'not found'}`);
check('new key is active, prefix only (no secret)', row?.status === 'active' && !!row?.prefix, `status=${row?.status} prefix=${row?.prefix}`);

// ---- 4. catalogue ----------------------------------------------------------
const models = await routerCall('/v1/models');
const modelsObj = parse(models.text) ?? {};
check('GET /v1/models', models.status === 200 && Array.isArray(modelsObj.data) && modelsObj.data.length > 0, `${models.status}, ${modelsObj.data?.length ?? 0} published`);

// ---- 5. a real completion --------------------------------------------------
const chat = await routerCall('/v1/chat/completions', {
	model: MODEL,
	max_tokens: 800,
	messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
}, apiKey, true);
const chatObj = parse(chat.text) ?? {};
const answer = (chatObj.choices?.[0]?.message?.content ?? '').trim();
check('POST /v1/chat/completions with the minted key', chat.status === 200 && !!answer, `${chat.status} ${answer ? JSON.stringify(answer.slice(0, 40)) : chat.text.slice(0, 120)}`);
check('usage is returned for billing', typeof chatObj.usage?.total_tokens === 'number', JSON.stringify(chatObj.usage));

// ---- 6. the ledger row -----------------------------------------------------
const logRow = psql(`select id || '|' || status || '|' || cost || '|' || coalesce(total_tokens,0) || '|' || coalesce(http_status,0) from request_log where api_key_id='${keyId}' order by created_at desc limit 1;`);
const [logId, logStatus, logCost, logTokens, logHttp] = String(logRow).split('|');
check('request_log row written for this key', !!logId, logId ? `id=${logId}` : 'no row');
check('row is closed with a status and a price', !!logStatus && logCost !== undefined && logCost !== '', `status=${logStatus} cost=${logCost}µ$ tokens=${logTokens} http=${logHttp}`);
check('response carries x-fudrouter-request-id', !!chat.requestId && chat.requestId.startsWith('req_'), String(chat.requestId));
check('the header id is the ledger row id', !!logId && chat.requestId === logId, `header=${chat.requestId} row=${logId}`);

// ---- 6b. the customer can read the request back ----------------------------
const detail = await consoleCall(`/api/pages/usage/requests?key=${keyId}&days=1`);
const detailObj = parse(detail.text) ?? {};
const logs = detailObj.requests ?? detailObj.rows ?? detailObj.data ?? [];
const mine = (Array.isArray(logs) ? logs : []).find((r) => (r.id ?? r.requestId) === logId);
check('GET /api/pages/usage/requests returns the logged request', detail.status === 200 && !!mine,
	`${detail.status} n=${Array.isArray(logs) ? logs.length : '?'} found=${!!mine}`);

// ---- 7. account usage rollup ----------------------------------------------
const usage = await consoleCall('/api/pages/usage?days=1');
const usageObj = parse(usage.text) ?? {};
check('GET /api/pages/usage', usage.status === 200 && !!usageObj, `${usage.status} keys=${Object.keys(usageObj).join(',') || '-'}`);

// ---- 8. per-key rollup -----------------------------------------------------
const list2 = await consoleCall('/api/pages/keys');
const row2 = (parse(list2.text)?.keys ?? []).find((k) => k.id === keyId);
check('per-key 30d usage counts the request', (row2?.usage30d?.requests ?? 0) >= 1, `requests=${row2?.usage30d?.requests} tokens=${row2?.usage30d?.tokens}`);

// ---- 9. revoke -------------------------------------------------------------
const revoke = await consoleCall('/api/pages/keys/revoke', { id: keyId });
check('POST /api/pages/keys/revoke', revoke.status === 200, `${revoke.status} ${revoke.text.slice(0, 80)}`);

// ---- 10. the router refuses it now ----------------------------------------
const after = await routerCall('/v1/chat/completions', { model: MODEL, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }, apiKey);
const afterObj = parse(after.text) ?? {};
check('revoked key is refused', after.status === 401, `${after.status} ${afterObj.error?.code ?? ''}`);

// ---- 11. the console API is not public ------------------------------------
const anon = await consoleCall('/api/pages/keys', null, false);
check('pages API without a session is 401', anon.status === 401, `${anon.status}`);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
