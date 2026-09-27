// Usage: node --experimental-strip-types --env-file=.env scripts/verify-inferhub.mjs
//
// End-to-end gate for the inferhub provider. InferHub is a plain
// [OI]-compatible marketplace (providers bid per-mtok), so the data plane treats
// it as a passthrough — there is no private protocol to exercise. This script
// therefore verifies the provider row + decrypted static-key blob, the attached
// catalog, and that the RUNNING router actually forwards to the upstream.
//
// Because an unfunded account answers 402 insufficient_balance (and a
// saturated market answers 503 no_capacity), a non-200 is only a failure when it
// is NOT one of those two typed upstream errors: reaching them proves the whole
// chain (key accepted, model routed) works.
//
// Exits non-zero on any mismatch so it is usable as a gate.
import postgres from 'postgres';
import { execFileSync } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decryptCredentials } from '../src/lib/server/credentials.ts';

const PROVIDER = process.env.INFERHUB_PROVIDER_ID || 'inferhub';
const BASE_URL = (process.env.INFERHUB_BASE_URL || 'https://api.inferhub.dev/v1').replace(
	/\/+$/,
	''
);
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
	const out = join(tmpdir(), `ih-verify-key-${process.pid}.txt`);
	try {
		execFileSync(
			process.execPath,
			[
				'--experimental-strip-types',
				'--env-file=.env',
				'scripts/dev-api-key.mjs',
				'inferhub-verify'
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
		console.log(`\n${failed} CHECK(S) FAILED — onboard first: npm run onboard:inferhub`);
		process.exit(1);
	}
	const p = rows[0];
	check('status is active or dev', p.status === 'active' || p.status === 'dev', p.status);
	check('base_url is the InferHub host', p.base_url.replace(/\/+$/, '') === BASE_URL, p.base_url);

	// 2. the stored blob decrypts and is a static-key pool
	let creds;
	try {
		creds = decryptCredentials(p.credentials_enc);
		check('credentials_enc decrypts', true);
	} catch (e) {
		check('credentials_enc decrypts', false, String(e.message));
		console.log(`\n${failed} CHECK(S) FAILED`);
		process.exit(1);
	}
	check('auth_kind is apikey', creds.auth_kind === 'apikey', String(creds.auth_kind));
	check('no protocol shim (plain [OI] passthrough)', !creds.protocol, String(creds.protocol));
	check(
		'account pool non-empty',
		Array.isArray(creds.accounts) && creds.accounts.length > 0,
		`${creds.accounts?.length ?? 0} accounts`
	);
	check(
		'credential looks like an inferhub key',
		typeof creds.api_key === 'string' && creds.api_key.startsWith('sk-'),
		creds.api_key ? `${creds.api_key.slice(0, 7)}…` : 'none'
	);
	check(
		'accounts never refresh (static keys, far-future expiry)',
		(creds.accounts ?? []).every(
			(a) => a.refresh_token === null && String(a.expired).startsWith('2099')
		)
	);

	// 3. models attached
	const models = await sql`
		select m.slug from model m join provider p on p.id = m.provider_id
		where p.id = ${PROVIDER} and m.status = 'active' order by m.slug`;
	check('active models attached', models.length >= 100, `${models.length} models`);

	// 4. drive the RUNNING router: proves the chain reaches the upstream
	const key = devKey();
	check('dev key minted', key.startsWith('sk-ar-'), key ? `${key.slice(0, 9)}…` : 'none');

	const model = models[0]?.slug;
	check('picked a model to probe', !!model, String(model));
	const r = await chat(key, model);
	const type = r.body?.error?.type ?? '';
	const fundedRequired = r.res.status === 402 && type === 'insufficient_balance';
	const saturated = r.res.status === 503 && type === 'no_capacity';
	if (r.res.ok) {
		const text = r.body?.choices?.[0]?.message?.content ?? '';
		check('router served a completion (HTTP 200)', true, `${model}`);
		check('router returned content', text.trim().length > 0, JSON.stringify(text.slice(0, 40)));
		check('router reported usage', !!r.body?.usage);
	} else if (fundedRequired) {
		check('router reached inferhub (HTTP 402 — account needs USDC deposit)', true, type);
	} else if (saturated) {
		check('router reached inferhub (HTTP 503 — market has no capacity right now)', true, type);
	} else {
		check(
			'router reached inferhub',
			false,
			`HTTP ${r.res.status} ${JSON.stringify(r.body).slice(0, 160)}`
		);
	}
} finally {
	await sql.end();
}

console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
