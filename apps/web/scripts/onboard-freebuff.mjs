#!/usr/bin/env node
// Onboard Freebuff (the Codebuff free tier) to fudrouter as a NATIVE-protocol
// provider: the Go data plane speaks the Codebuff private protocol itself
// (internal/freebuff — session → root agent run → chat with codebuff_metadata),
// so there is no sidecar gateway.
//
// Usage:
//   FREEBUFF_TOKEN=<bearer> node --experimental-strip-types --env-file=apps/web/.env \
//     apps/web/scripts/onboard-freebuff.mjs
//   FREEBUFF_TOKEN_FILE=tokens.txt   # one Bearer token per line (multi-account pool)
//   ... --dry-run                    # report only, write nothing
//
// The credential must be a codebuff.com **Bearer token**, NOT a web Cookie. The
// native path authenticates with `Authorization: Bearer <token>` against the
// Codebuff API; a `__Secure-next-auth.session-token` cookie needs the separate
// web-protocol bridge, which this port does not implement.
//
// The canonical model list lives in services/router/internal/freebuff/models.json
// and is embedded into the Go binary — this script reads the same file so the
// two can never drift.
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { encryptCredentials } from '../src/lib/server/credentials.ts';
import {
	resolveStatus,
	assertValidStatus,
	providerUpsertConflict,
	statusLogSuffix
} from '../src/lib/server/provider-status.ts';

const PROVIDER_ID = process.env.FREEBUFF_PROVIDER_ID || 'freebuff';
const PROVIDER_NAME = 'Freebuff';
const BASE_URL = process.env.FREEBUFF_BASE_URL || 'https://www.codebuff.com';
// 'active' by default: every onboarded upstream is a commercial arrangement
// (confirmed 2026-09-26). Set FREEBUFF_PROVIDER_STATUS=dev to onboard this one
// behind the spec §1 interlock instead.
const PRIORITY = Number(process.env.FREEBUFF_PROVIDER_PRIORITY || 160);
const DRY = process.argv.includes('--dry-run');

const MODELS_URL = new URL(
	'../../../services/router/internal/freebuff/models.json',
	import.meta.url
);

function loadTokens() {
	const out = [];
	const file = process.env.FREEBUFF_TOKEN_FILE;
	if (file) {
		out.push(
			...readFileSync(file, 'utf8')
				.split(/\r?\n/)
				.map((s) => s.trim())
				.filter(Boolean)
		);
	}
	for (const v of [process.env.FREEBUFF_TOKEN, process.env.FREEBUFF_TOKENS]) {
		if (v)
			out.push(
				...v
					.split(/[\s,]+/)
					.map((s) => s.trim())
					.filter(Boolean)
			);
	}
	return [...new Set(out)];
}

// A web Cookie is the wrong credential for this path — catch it early with a
// clear message instead of a confusing 401 from the upstream.
function looksLikeCookie(tok) {
	return tok.includes('__Secure-next-auth') || (tok.includes('=') && !tok.startsWith('ey'));
}

const tokens = loadTokens();
if (tokens.length === 0) {
	console.error('No credential. Set FREEBUFF_TOKEN (Bearer) or FREEBUFF_TOKEN_FILE.');
	process.exit(1);
}
const cookieish = tokens.filter(looksLikeCookie);
if (cookieish.length === tokens.length) {
	console.error(
		`All ${tokens.length} value(s) look like a web Cookie, not a Bearer token.\n` +
			'The native freebuff path authenticates with `Authorization: Bearer <token>` against\n' +
			'the Codebuff API. A __Secure-next-auth.session-token cookie needs the web-protocol\n' +
			'bridge, which is not implemented here. Supply a codebuff.com Bearer token.'
	);
	process.exit(1);
}
if (cookieish.length) {
	console.warn(`warning: skipping ${cookieish.length} cookie-shaped value(s)`);
}

const usable = tokens.filter((t) => !looksLikeCookie(t));
console.log(`loaded ${usable.length} Bearer token(s)`);

const modelRows = JSON.parse(readFileSync(MODELS_URL, 'utf8'));
const models = modelRows.filter((m) => !m.namespace);
console.log(
	`loaded ${models.length} models from ${MODELS_URL.pathname.split('/').slice(-3).join('/')}`
);

// Static Bearer tokens never refresh: `expired` must be far future so the pool
// treats them as permanently valid (a null/absent value triggers a refresh that
// cannot succeed and parks the account).
const accounts = usable.map((t, i) => ({
	email: `freebuff-token-${i + 1}@codebuff.com`,
	api_key: t,
	access_token: t,
	refresh_token: null,
	expired: '2099-01-01T00:00:00Z'
}));

const cred = {
	api_key: usable[0],
	auth_kind: 'apikey',
	protocol: 'freebuff',
	default_headers: {},
	accounts
};

if (DRY) {
	console.log('\n--dry-run: no writes.');
	console.log(
		`provider: ${PROVIDER_ID} (${PROVIDER_NAME}) base_url=${BASE_URL} status=${STATUS} priority=${PRIORITY}`
	);
	console.log(`models:   ${models.length}`);
	for (const m of models) {
		console.log(
			`  ${m.id.padEnd(38)} agent=${m.agent.padEnd(16)} available=${m.available}${m.fallback ? ' fallback=' + m.fallback : ''}`
		);
	}
	process.exit(0);
}

const sql = postgres(process.env.DATABASE_URL);

// `provider.status` is the operator's call: this only seeds a NEW row, and
// rewrites an existing one when FREEBUFF_PROVIDER_STATUS is set explicitly.
const { value: STATUS, isExplicit: STATUS_EXPLICIT } = resolveStatus('FREEBUFF_PROVIDER_STATUS');
assertValidStatus(STATUS, 'FREEBUFF_PROVIDER_STATUS');

try {
	const enc = encryptCredentials(cred);
	await sql`
		insert into provider (id, name, base_url, credentials_enc, status, priority)
		values (${PROVIDER_ID}, ${PROVIDER_NAME}, ${BASE_URL}, ${enc}, ${STATUS}, ${PRIORITY})
		${providerUpsertConflict('id', STATUS, STATUS_EXPLICIT)}`;
	console.log(`provider ${PROVIDER_ID} upserted (${statusLogSuffix(STATUS, STATUS_EXPLICIT)})`);

	// The free tier is free: price every model at 0. `context` stays null — the
	// upstream does not publish a window for these ids in the measured table.
	//
	// `model.slug` is UNIQUE across the whole table, so several freebuff ids
	// (deepseek/deepseek-v4-flash, minimax/minimax-m3, …) collide with another
	// provider's catalog. The `where` clause makes the upsert a no-op for a row
	// owned by a different provider — without it this script silently REASSIGNS
	// those models to freebuff and a later provider delete cascades them away.
	let upserted = 0;
	const skipped = [];
	for (const m of models) {
		const rows = await sql`
			insert into model (id, slug, name, provider_id, input_price, output_price, context)
			values (${randomUUID()}, ${m.id}, ${m.id}, ${PROVIDER_ID}, 0, 0, null)
			on conflict (slug) do update set
				name = excluded.name,
				input_price = excluded.input_price,
				output_price = excluded.output_price
			where model.provider_id = ${PROVIDER_ID}
			returning id
		`;
		if (rows.length) upserted++;
		else skipped.push(m.id);
	}
	console.log(`${upserted} models upserted`);
	if (skipped.length) {
		console.warn(
			`skipped ${skipped.length} model(s) already owned by another provider ` +
				`(slug is UNIQUE table-wide): ${skipped.join(', ')}`
		);
	}

	console.log('\n✅ Freebuff onboarded (native protocol). Restart the router to load the pool:');
	console.log('   pm2 restart fudrouter-router');
} finally {
	await sql.end();
}
