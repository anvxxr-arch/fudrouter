#!/usr/bin/env node
// scripts/probe-credentials.mjs — report what each connection's credentials
// actually do upstream.
//
// This deliberately probes through the SAME path the worker uses
// (`guardedUpstreamFetch` + `headersFor`/`tokenAt`), not a re-implementation, so
// its verdict is authoritative about the credential-probe behaviour. A
// re-implementation would keep working after the real helper regressed, which is
// exactly the class of bug this exists to catch: `tokenAt()` once read only
// `accounts[]` and returned an empty token for every row in the table, so every
// probe ran unauthenticated and `credential.status` described the endpoint
// instead of the credential.
//
// Output is HTTP status plus a short body snippet, with anything key-shaped
// redacted. It never prints a key, token, or decrypted secret.
//
// Usage:
//   node scripts/probe-credentials.mjs                 # every connection, 3 rows each
//   node scripts/probe-credentials.mjs prv-tokenharbor # one provider, 6 rows
//   PER_CONN=10 node scripts/probe-credentials.mjs     # widen the sample
//
// Run it with the root .env loaded (it reads DATABASE_URL and
// CREDENTIALS_MASTER_KEY):
//   set -a && . .env && set +a && node scripts/probe-credentials.mjs
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installTsHooks, libUrl } from './ts-hooks.mjs';

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const { libRoot } = installTsHooks(scriptRoot);

const { db } = await import(libUrl(libRoot, 'server/db/index.ts'));
const { credential, connection, provider } = await import(libUrl(libRoot, 'server/db/schema.ts'));
const { decryptCredentials } = await import(libUrl(libRoot, 'server/credentials.ts'));
const { headersFor, tokenAt } = await import(libUrl(libRoot, 'server/provider-credentials.ts'));
const { guardedUpstreamFetch } = await import(libUrl(libRoot, 'server/ssrf.ts'));
const { allowPrivateUpstreams } = await import(libUrl(libRoot, 'server/publish-env.ts'));
const { eq, asc } = await import('drizzle-orm');

const providerFilter = process.argv[2] ?? '';
const perConn = Number(process.env.PER_CONN ?? 3);

const rows = await db
	.select({
		credId: credential.id,
		status: credential.status,
		secretEnc: credential.secretEnc,
		baseUrl: connection.baseUrl,
		timeoutMs: connection.timeoutMs,
		connId: connection.id,
		provSlug: provider.slug
	})
	.from(credential)
	.innerJoin(connection, eq(connection.id, credential.connectionId))
	.innerJoin(provider, eq(provider.id, connection.providerId))
	.where(providerFilter ? eq(provider.slug, providerFilter) : undefined)
	.orderBy(asc(connection.id), asc(credential.id));

// Group by connection id, not slug: every connection in this table carries the
// slug `default`, so grouping by slug would merge every provider into one bucket
// and the per-connection sample would be meaningless.
const byConn = new Map();
for (const r of rows) {
	if (!byConn.has(r.connId)) byConn.set(r.connId, []);
	byConn.get(r.connId).push(r);
}

// Sample the interesting statuses first, so a connection whose credentials are
// mostly `unknown` still shows what its failures look like.
function pick(list) {
	const out = [];
	for (const want of ['auth_failed', 'invalid', 'unknown', 'healthy']) {
		for (const r of list) {
			if (r.status === want && out.length < perConn) out.push(r);
		}
	}
	return out;
}

if (byConn.size === 0) {
	console.error(providerFilter ? `no credentials for provider ${providerFilter}` : 'no credentials found');
	await db.$client.end({ timeout: 1 });
	process.exit(1);
}

console.log(`${rows.length} credentials across ${byConn.size} connection(s); ${perConn} sampled each\n`);
console.log('provider'.padEnd(18), 'conn'.padEnd(40), 'stored'.padEnd(12), 'http', 'detail');
console.log('-'.repeat(140));

let probes = 0;
const tally = {};
for (const [connId, list] of byConn) {
	for (const r of pick(list)) {
		let http = '-';
		let detail = '';
		try {
			const plain = decryptCredentials(r.secretEnc);
			const probed = await guardedUpstreamFetch(r.baseUrl, allowPrivateUpstreams(), '/models', {
				method: 'GET',
				headers: headersFor(plain, tokenAt(plain, 0)),
				timeoutMs: Math.min(r.timeoutMs || 15_000, 15_000)
			});
			if (probed.ok) {
				http = String(probed.response.status);
				const body = await probed.response.text().catch(() => '');
				// A body snippet can echo the key on some providers; strip
				// anything key-shaped before it reaches a terminal or a log.
				detail = body
					.replace(/[A-Za-z0-9_-]{20,}/g, '<redacted>')
					.replace(/\s+/g, ' ')
					.slice(0, 110);
			} else {
				detail = `FETCH-FAILED: ${String(probed.message).slice(0, 90)}`;
			}
		} catch (e) {
			detail = `THREW: ${String(e instanceof Error ? e.message : e).slice(0, 90)}`;
		}
		probes += 1;
		tally[http] = (tally[http] ?? 0) + 1;
		console.log(
			String(r.provSlug).padEnd(18),
			connId.padEnd(40),
			String(r.status).padEnd(12),
			http.padEnd(4),
			detail
		);
	}
}

console.log(`\n${probes} probe(s):`, Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(' '));
await db.$client.end({ timeout: 1 });
