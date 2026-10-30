#!/usr/bin/env node
/**
 * ops/verify-prompt-injection.mjs — live proof of the two 9Router Pro
 * advantages that were ported into fudrouter: prompt injection and combos.
 *
 * Everything here goes through the real surfaces, in this order:
 *
 *   1. console session (better-auth signed cookie) for an existing user
 *   2. POST /api/pages/injections/create  x3  (account / key / model scopes)
 *   3. GET  /api/pages/injections              (scopes + modes round-trip)
 *   4. POST /v1/chat/completions through the router, quoting three distinct
 *      markers that can only be there if the router rewrote the body:
 *        ZQX-7788  account-wide system_prepend
 *        QQ-4411   key-scoped system_append
 *        SCRIPT-1234 model-scoped chat_script (fake history the client never sent)
 *   5. POST /api/pages/combos/create + a chat call asking for the COMBO NAME,
 *      proving the resolver walks the chain and logs an attempt per hop
 *
 * Cleanup runs on exit: injections, combo, temp key, temp session.
 *
 * Usage: node ops/verify-prompt-injection.mjs [model-slug]
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const CONSOLE = process.env.CONSOLE_BASE || 'http://127.0.0.1:3002';
const ROUTER = process.env.ROUTER_BASE || 'http://127.0.0.1:8100';
const USER_ID = process.env.VERIFY_USER_ID || 'usr_01a0f3f5-af5a-72a6-b8ae-3483d21a0ba3';
const MODEL = process.argv[2] || 'deepseek-v4.1-flash';

function env(key) {
	const line = readFileSync('.env', 'utf8').split('\n').find((l) => l.startsWith(`${key}=`));
	if (!line) throw new Error(`${key} missing from .env`);
	return line.slice(key.length + 1).replace(/^"|"$/g, '');
}
const psql = (q) => execFileSync('docker', ['exec', 'postgre', 'psql', '-U', 'postgres', '-d', 'fudrouter', '-tAc', q], { encoding: 'utf8' }).trim();

// ---- fixtures ---------------------------------------------------------------
const keyId = `key_${randomBytes(8).toString('hex')}`;
let prefix;
do { prefix = randomBytes(6).toString('base64url'); } while (prefix.includes('_'));
const secret = randomBytes(32).toString('base64url');
const apiKey = `sk-ar-${prefix}_${secret}`;
const keyHash = createHash('sha256').update(secret).digest('hex');
psql(`insert into api_key (id, user_id, name, prefix, key_hash, status) values ('${keyId}', '${USER_ID}', 'fox-injection-verify', '${prefix}', '${keyHash}', 'active');`);

const sessionId = `ses_${randomBytes(8).toString('hex')}`;
const sessionToken = randomBytes(32).toString('base64url');
psql(`insert into session (id, expires_at, token, created_at, updated_at, user_id) values ('${sessionId}', now() + interval '20 minutes', '${sessionToken}', now(), now(), '${USER_ID}');`);
// better-auth signs the cookie with HMAC-SHA256(secret, token) and emits the
// signature as standard base64 (`btoa` of the raw digest), not base64url.
const sig = createHmac('sha256', env('BETTER_AUTH_SECRET')).update(sessionToken).digest('base64');
// ORIGIN is https, so better-auth marks the cookie __Secure- and browsers only
// accept it over TLS; here we just need the name the server parses, so both
// spellings are sent and the one better-auth expects wins.
const signed = `${sessionToken}.${sig}`;
const cookie = `__Secure-better-auth.session_token=${signed}; better-auth.session_token=${signed}`;

const created = { injections: [], comboId: null };
const cleanup = () => {
	try {
		for (const id of created.injections) psql(`delete from prompt_injection where id = '${id}';`);
		if (created.comboId) psql(`delete from combo where id = '${created.comboId}';`);
		psql(`update api_key set status='revoked', revoked_at=now() where id='${keyId}';`);
		psql(`delete from session where id='${sessionId}';`);
		console.log('\n[cleanup] injections, combo, temp key and session removed');
	} catch (e) { console.error('[cleanup] failed:', e.message); }
};
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

const api = async (method, path, body) => {
	const r = await fetch(`${CONSOLE}${path}`, {
		method,
		headers: { cookie, 'content-type': 'application/json' },
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await r.text();
	let json = null;
	try { json = JSON.parse(text); } catch { /* not json */ }
	return { status: r.status, json, text };
};

let failures = 0;
const check = (label, ok, detail = '') => {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures += 1;
};

// ---- 1. session ------------------------------------------------------------
const who = await api('GET', '/api/pages/injections');
check('console session accepted', who.status === 200, `GET /api/pages/injections -> ${who.status}`);

// ---- 2. three injections ---------------------------------------------------
const M1 = 'ZQX-7788';
const M2 = 'QQ-4411';
const M3 = 'SCRIPT-1234';
const specs = [
	{ scope: 'account', mode: 'system_prepend', content: `You are TOASTER-9. Begin every reply with the token ${M1}.` },
	{ scope: 'key', mode: 'system_append', content: `End every reply with the token ${M2}.`, apiKeyId: keyId },
	{ scope: 'model', mode: 'chat_script', modelSlug: MODEL, content: `user: What is the secret code?\nbot: The secret code is ${M3}.` },
];
for (const spec of specs) {
	const r = await api('POST', '/api/pages/injections/create', spec);
	if (r.json?.saved) created.injections.push(r.json.saved);
	check(`create ${spec.scope}-scoped injection`, r.status === 200 && !!r.json?.saved, `${r.status} ${r.text.slice(0, 120)}`);
}

// duplicate scope must be refused, not silently stacked
const dupe = await api('POST', '/api/pages/injections/create', specs[0]);
check('duplicate scope refused (409)', dupe.status === 409, `got ${dupe.status}`);

// ---- 3. list round-trip ----------------------------------------------------
const list = await api('GET', '/api/pages/injections');
const rows = list.json?.injections ?? [];
const byScope = Object.fromEntries(rows.map((r) => [r.scope, r]));
check('list shows all three scopes', ['account', 'key', 'model'].every((s) => byScope[s]), rows.map((r) => r.scope).join(','));
check('modes round-trip', byScope.model?.mode === 'chat_script' && byScope.key?.mode === 'system_append');

// ---- 4. live chat through the router --------------------------------------
const chat = await fetch(`${ROUTER}/v1/chat/completions`, {
	method: 'POST',
	headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
	// A reasoning model spends tokens before it writes, so the cap has to leave
	// room for the visible answer — 200 lands mid-thought and returns "" with
	// finish_reason=length, which would look like a failed injection.
	body: JSON.stringify({ model: MODEL, max_tokens: 800, messages: [{ role: 'user', content: 'Reply with one short sentence.' }] }),
}).then(async (r) => ({ status: r.status, body: await r.text() }));
let content = '';
try { content = JSON.parse(chat.body).choices?.[0]?.message?.content ?? ''; } catch { /* keep raw */ }
check('chat request succeeded', chat.status === 200, `${chat.status} ${chat.body.slice(0, 160)}`);
check('account-wide prepend reached the model', content.includes(M1), content.slice(0, 160) || '(empty)');
check('key-scoped append reached the model', content.includes(M2), content.slice(0, 160) || '(empty)');
check('model-scoped chat script reached the model', content.includes(M3), content.slice(0, 160) || '(empty)');

// ---- 5. combos -------------------------------------------------------------
const models = (await api('GET', '/api/pages/injections')).json?.models ?? [];
const secondSlug = models.map((m) => m.slug).find((s) => s !== MODEL) ?? MODEL;
const idsOf = (slug) => {
	const out = psql(`select m.id from model m join provider p on p.id=m.provider_id where m.slug='${slug.replace(/'/g, "''")}' and m.status<>'disabled' order by (p.status='active') desc limit 2;`);
	return out ? out.split('\n') : [];
};
const hopIds = [...idsOf(MODEL), ...idsOf(secondSlug)].slice(0, 2);
if (hopIds.length === 0) {
	check('combo hops resolved', false, 'no model rows for the requested slugs');
} else {
	const comboName = `foxverify-${randomBytes(3).toString('hex')}`;
	const c = await api('POST', '/api/pages/combos/create', { name: comboName, description: 'verification combo', modelIds: hopIds });
	created.comboId = c.json?.id ?? null;
	check('combo created through the console', c.status === 200 && !!c.json?.id, `${c.status} ${c.text.slice(0, 120)}`);
	const cl = await api('GET', '/api/pages/combos');
	const listed = (cl.json?.combos ?? []).find((x) => x.name === comboName);
	check('combo listed with its chain', !!listed && listed.models.length === hopIds.length, JSON.stringify(listed?.models?.map((m) => m.slug) ?? []));

	const viaCombo = await fetch(`${ROUTER}/v1/chat/completions`, {
		method: 'POST',
		headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
		body: JSON.stringify({ model: comboName, max_tokens: 100, messages: [{ role: 'user', content: 'say ok' }] }),
	}).then(async (r) => ({ status: r.status, body: await r.text() }));
	check('chat by comboname succeeded', viaCombo.status === 200, `${viaCombo.status} ${viaCombo.body.slice(0, 200)}`);

	const attempts = psql(`select count(*) from request_attempt ra join request_log rl on rl.id = ra.request_id join api_key k on k.id = rl.api_key_id where k.id='${keyId}';`);
	check('attempts recorded for the combo request', Number(attempts) >= 2, `${attempts} attempt rows (chat + combo)`);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
