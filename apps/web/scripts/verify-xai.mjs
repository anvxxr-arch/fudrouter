// Usage: node --experimental-strip-types --env-file=.env scripts/verify-xai.mjs
//
// End-to-end proof for the xAI Grok provider, using the SAME decrypt path the
// Go data plane implements:
//   provider row -> credentials_enc -> decrypt -> api_key + default_headers
//   -> POST {base_url}/chat/completions -> real completion
//
// Exits non-zero on any mismatch so it is usable as a gate.
import postgres from 'postgres';
import { decryptCredentials } from '../src/lib/server/credentials.ts';

const PROVIDER = process.env.XAI_PROVIDER_NAME || 'xai-grok';
const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('missing env: DATABASE_URL'); process.exit(1); }

const sql = postgres(DSN);
let failed = 0;
const check = (label, ok, extra = '') => {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
	if (!ok) failed++;
};

try {
	// 1. provider row exists, active, correct base_url
	const rows = await sql`
		select id, name, base_url, status, credentials_enc
		from provider where name = ${PROVIDER}`;
	check('provider row exists', rows.length === 1);
	if (rows.length !== 1) throw new Error('no provider row');
	const p = rows[0];
	check('status active', p.status === 'active');
	check('base_url ends with /v1', p.base_url.endsWith('/v1'), p.base_url);

	// 2. the stored blob decrypts with the TS module
	let creds;
	try {
		creds = decryptCredentials(p.credentials_enc);
		check('credentials_enc decrypts', true);
	} catch (e) {
		check('credentials_enc decrypts', false, String(e.message));
		throw e;
	}
	check('has api_key', typeof creds.api_key === 'string' && creds.api_key.length > 20);
	check('auth_kind is oauth', creds.auth_kind === 'oauth');
	check('account pool non-empty', Array.isArray(creds.accounts) && creds.accounts.length > 0,
		`${creds.accounts?.length ?? 0} accounts`);
	check('default_headers carries the CLI version gate',
		!!creds.default_headers?.['x-grok-client-version'],
		creds.default_headers?.['x-grok-client-version']);

	// 3. models are attached and priced
	const models = await sql`
		select m.slug, m.input_price, m.output_price, m.currency
		from model m join provider p on p.id = m.provider_id
		where p.name = ${PROVIDER} and m.status = 'active' order by m.slug`;
	check('active models attached', models.length >= 2, models.map((m) => m.slug).join(', '));
	check('prices are non-zero', models.every((m) => Number(m.input_price) > 0 && Number(m.output_price) > 0));

	// 4. the decrypted credential actually works against the live upstream
	for (const m of models) {
		const url = p.base_url.replace(/\/+$/, '') + '/chat/completions';
		let body;
		try {
			const res = await fetch(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${creds.api_key}`,
					...creds.default_headers
				},
				body: JSON.stringify({
					model: m.slug,
					messages: [{ role: 'user', content: 'reply with exactly: PONG' }],
					max_tokens: 24
				}),
				signal: AbortSignal.timeout(90000)
			});
			body = await res.json();
			check(`live upstream ${m.slug} HTTP 200`, res.ok, `HTTP ${res.status}`);
		} catch (e) {
			check(`live upstream ${m.slug} HTTP 200`, false, String(e.message));
			continue;
		}
		const text = body?.choices?.[0]?.message?.content ?? '';
		check(`live upstream ${m.slug} returned content`, text.trim().length > 0,
			JSON.stringify(text.slice(0, 40)));
		check(`live upstream ${m.slug} reported usage`, !!body?.usage,
			body?.usage ? `in ${body.usage.prompt_tokens} / out ${body.usage.completion_tokens}` : 'none');
	}
} finally {
	await sql.end();
}

console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
