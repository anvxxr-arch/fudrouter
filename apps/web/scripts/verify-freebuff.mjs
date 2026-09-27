// Usage: node --experimental-strip-types --env-file=.env scripts/verify-freebuff.mjs
//
// End-to-end gate for the freebuff provider. Unlike verify-xai, the upstream is
// NOT [OI] — the request must go through the Go data plane, which speaks the
// Codebuff private protocol (session → root run → chat with codebuff_metadata).
// So this script verifies the provider row + decrypted blob, then drives the
// RUNNING router, which is what actually proves the Go implementation.
//
// Exits non-zero on any mismatch so it is usable as a gate.
import postgres from 'postgres';
import { execFileSync } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decryptCredentials } from '../src/lib/server/credentials.ts';

const PROVIDER = process.env.FREEBUFF_PROVIDER_ID || 'freebuff';
const ROUTER = (process.env.ROUTER_BASE_URL || 'http://127.0.0.1:8100').replace(/\/+$/, '');
const DSN = process.env.DATABASE_URL;
if (!DSN) {
	console.error('missing env: DATABASE_URL');
	process.exit(1);
}

const sql = postgres(DSN);
let failed = 0;
const check = (label, ok, extra = '') => {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
	if (!ok) failed++;
};

// Mint a dev key through the repo's own tool (it redacts key-shaped stdout, so
// it must write to a file — see the note in dev-api-key.mjs).
function devKey() {
	const out = join(tmpdir(), `fb-verify-key-${process.pid}.txt`);
	try {
		execFileSync(
			process.execPath,
			[
				'--experimental-strip-types',
				'--env-file=.env',
				'scripts/dev-api-key.mjs',
				'freebuff-verify'
			],
			{ env: { ...process.env, DEV_KEY_OUT: out }, stdio: 'pipe' }
		);
		return readFileSync(out, 'utf8').trim();
	} finally {
		try {
			unlinkSync(out);
		} catch {
			// best-effort temp cleanup; a leftover file must not fail the gate
		}
	}
}

async function chat(key, model) {
	const res = await fetch(`${ROUTER}/v1/chat/completions`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
		body: JSON.stringify({
			model,
			messages: [{ role: 'user', content: 'reply with exactly: PONG' }],
			max_tokens: 24
		}),
		signal: AbortSignal.timeout(120000)
	});
	let body = null;
	try {
		body = await res.json();
	} catch {
		// non-JSON error body: the status line still tells the story
	}
	return { res, body };
}

try {
	// 1. provider row + base_url
	const rows = await sql`
		select id, name, base_url, status, credentials_enc
		from provider where id = ${PROVIDER}`;
	check('provider row exists', rows.length === 1);
	if (rows.length !== 1) {
		console.log(`\n${failed} CHECK(S) FAILED — onboard first: npm run onboard:freebuff`);
		process.exit(1);
	}
	const p = rows[0];
	check('status is active or dev', p.status === 'active' || p.status === 'dev', p.status);
	check(
		'base_url is the Codebuff host',
		p.base_url.replace(/\/+$/, '') === 'https://www.codebuff.com',
		p.base_url
	);

	// 2. the stored blob decrypts and declares the native protocol
	let creds;
	try {
		creds = decryptCredentials(p.credentials_enc);
		check('credentials_enc decrypts', true);
	} catch (e) {
		check('credentials_enc decrypts', false, String(e.message));
		console.log(`\n${failed} CHECK(S) FAILED`);
		process.exit(1);
	}
	check('protocol is freebuff', creds.protocol === 'freebuff', String(creds.protocol));
	check('auth_kind is apikey', creds.auth_kind === 'apikey', String(creds.auth_kind));
	check(
		'account pool non-empty',
		Array.isArray(creds.accounts) && creds.accounts.length > 0,
		`${creds.accounts?.length ?? 0} accounts`
	);
	// A web Cookie here would authenticate nothing on the Bearer path.
	check(
		'credential is a Bearer token, not a web Cookie',
		typeof creds.api_key === 'string' && !creds.api_key.includes('__Secure-next-auth')
	);
	check(
		'accounts never refresh (static tokens, far-future expiry)',
		(creds.accounts ?? []).every(
			(a) => a.refresh_token === null && String(a.expired).startsWith('2099')
		)
	);

	// 3. models attached
	const models = await sql`
		select m.slug from model m join provider p on p.id = m.provider_id
		where p.id = ${PROVIDER} and m.status = 'active' order by m.slug`;
	check('active models attached', models.length >= 10, `${models.length} models`);
	check(
		'free tier is priced at zero',
		await (async () => {
			const priced = await sql`
			select count(*)::int as n from model m join provider p on p.id = m.provider_id
			where p.id = ${PROVIDER} and (m.input_price <> 0 or m.output_price <> 0)`;
			return priced[0].n === 0;
		})()
	);

	// 4. drive the RUNNING router: this is the real proof the Go protocol works
	const key = devKey();
	check('dev key minted', key.startsWith('sk-ar-'), key ? `${key.slice(0, 9)}…` : 'none');

	const direct = await chat(key, 'z-ai/glm-5.3-flash');
	check(`router ${'z-ai/glm-5.3-flash'} HTTP 200`, direct.res.ok, `HTTP ${direct.res.status}`);
	const text = direct.body?.choices?.[0]?.message?.content ?? '';
	check('router returned content', text.trim().length > 0, JSON.stringify(text.slice(0, 40)));
	check(
		'router reported usage',
		!!direct.body?.usage,
		direct.body?.usage
			? `in ${direct.body.usage.prompt_tokens} / out ${direct.body.usage.completion_tokens}`
			: 'none'
	);

	// A paused model must be transparently served by its fallback (Resolve).
	const fb = await chat(key, 'google/gemini-3.8-flash');
	check('paused model resolves to fallback (HTTP 200)', fb.res.ok, `HTTP ${fb.res.status}`);
} finally {
	await sql.end();
}

console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
