import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq, inArray } from 'drizzle-orm';
import type { Actions, PageServerLoad } from '../../routes/admin/providers/[id]/connections/$types';
import type { PageServerLoad as CredentialsLoad } from '../../routes/admin/providers/[id]/credentials/$types';
import { load as connectionsLoad, actions as connectionsActions } from '../../routes/admin/providers/[id]/connections/+page.server';
import { load as credentialsLoad, actions as credentialsActions } from '../../routes/admin/providers/[id]/credentials/+page.server';
import { db } from './db';
import { auditLog, connection, credential, provider } from './db/schema';
import { ID_PREFIXES, newId } from './id';
// Hermetic setup, same convention as credentials.test.ts: the envelope reads
// CREDENTIALS_MASTER_KEY from process.env at call time and throws without it.
process.env.CREDENTIALS_MASTER_KEY ??= Buffer.alloc(32, 8).toString('base64');

/**
 * The three claims that are easy to lose and hard to see (PRD §52–56):
 *
 *   1. a connection write aimed at a private/metadata address is refused with
 *      the guard's own reason — the request-forgery primitive closes here, not
 *      somewhere downstream;
 *   2. the create response is the ONE shape that ever carries plaintext;
 *   3. the page's own load query cannot leak a secret afterwards, because the
 *      ciphertext is not among its columns at all.
 *
 * The second half of (3) is asserted against the returned data itself: a string
 * search for the plaintext through the serialised load result.
 */

const locals = {
	user: { id: 'usr_test_smoke', role: 'admin', email: 'smoke@example.test' }
} as unknown as App.Locals;

/** The `create` action's call shape — SvelteKit's generated type needs a request event. */
type CreateAction = (event: {
	locals: App.Locals;
	request: Request;
	params: { id: string };
}) => Promise<unknown>;

/** `ActionFailure` on the way out of an action: `{ status, data }`. */
function isFailure(value: unknown): boolean {
	return typeof value === 'object' && value !== null && 'status' in value && 'data' in value;
}
function failureError(value: unknown): string | null {
	if (typeof value !== 'object' || value === null || !('data' in value)) return null;
	const data = value.data;
	if (typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string') {
		return data.error;
	}
	return null;
}
function createdName(value: unknown): string | null {
	if (typeof value === 'object' && value !== null && 'created' in value && typeof value.created === 'string') {
		return value.created;
	}
	return null;
}
/** The single secret-bearing shape, when the result carries one. */
function secretOnceOf(value: unknown): {
	shownOnce: boolean;
	id: string;
	name: string;
	secret: string;
} | null {
	if (typeof value !== 'object' || value === null || !('secretOnce' in value)) return null;
	const once: unknown = value.secretOnce;
	if (typeof once !== 'object' || once === null || !('secret' in once) || !('id' in once)) return null;
	if (typeof once.secret !== 'string' || typeof once.id !== 'string') return null;
	return once as unknown as { shownOnce: boolean; id: string; name: string; secret: string };
}

// The app reads its env through SvelteKit's `$env`; a bare vitest run needs the
// same values on `process.env`. The dev .env is the deployment's local truth.
for (const line of readFileSync(new URL('../../../.env', import.meta.url), 'utf8').split('\n')) {
	const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
	if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

function post(fields: Record<string, string>): Request {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) fd.set(k, v);
	return new Request('http://localhost/admin', { method: 'POST', body: fd });
}

const created: { providerId: string; connectionIds: string[] } = {
	providerId: '',
	connectionIds: []
};

beforeEach(async () => {
	created.providerId = newId(ID_PREFIXES.provider);
	created.connectionIds = [];
	await db.insert(provider).values({
		id: created.providerId,
		name: `smoke-${created.providerId.slice(-8)}`,
		slug: `smoke-${created.providerId.slice(-8)}`,
		baseUrl: '',
		credentialsEnc: '',
		status: 'operational'
	});
});

afterEach(async () => {
	// Children first: connection cascades its credentials and audit rows.
	const connRows = await db
		.select({ id: connection.id })
		.from(connection)
		.where(eq(connection.providerId, created.providerId));
	const ids = connRows.map((c) => c.id).concat('con_none_for_empty_in');
	await db.delete(credential).where(inArray(credential.connectionId, ids));
	await db.delete(auditLog).where(eq(auditLog.resourceId, created.providerId));
	await db.delete(auditLog).where(inArray(auditLog.resourceId, ids));
	await db.delete(connection).where(eq(connection.providerId, created.providerId));
	await db.delete(provider).where(eq(provider.id, created.providerId));
});

async function makeConnection(base: string, slug: string): Promise<unknown> {
	const result = await (connectionsActions.create as CreateAction)({
		locals,
		request: post({
			name: `conn ${slug}`,
			slug,
			baseUrl: base,
			authType: 'bearer',
			timeoutMs: '30000',
			priority: '100',
			enabled: 'on',
			config: '{}'
		}),
		params: { id: created.providerId }
	});
	const id = createdName(result);
	if (id) {
		const [row] = await db
			.select({ id: connection.id })
			.from(connection)
			.where(eq(connection.providerId, created.providerId));
		if (row) created.connectionIds.push(row.id);
	}
	return result;
}

describe('connection writes guard base_url (SSRF)', () => {
	it.each([
		['http://169.254.169.254/latest/meta-data', 'metadata'],
		['http://127.0.0.1:5432/', 'loopback'],
		['http://10.0.0.5/v1', 'private']
	])('rejects %s with fail(400) carrying the guard reason', async (base) => {
		const result = await makeConnection(base, 'bad');
		expect(isFailure(result)).toBe(true);
		expect(failureError(result)).toBeTruthy();
		// The reason is the guard's own, not a generic "invalid URL".
		expect(String(failureError(result)).toLowerCase()).toMatch(
			/non-public|private|loopback|link-local|metadata|routable|reserv/i
		);
		// Nothing was stored.
		const rows = await db
			.select({ id: connection.id })
			.from(connection)
			.where(eq(connection.providerId, created.providerId));
		expect(rows).toHaveLength(0);
	});
	it('accepts a public base_url', async () => {
		// 203.0.113.10 (RFC 5737 documentation space) is a PUBLIC IP literal:
		// `assertPublicUpstream` short-circuits DNS for literals and
		// `isBlockedLiteral` passes it, so this assertion is deterministic in
		// any sandbox. This is the positive half of the contract — a guard that
		// refused EVERYTHING would pass the three rejections above.
		const result = await makeConnection('https://203.0.113.10/v1', 'ok');
		expect(isFailure(result)).toBe(false);
		expect(createdName(result)).toBeTruthy();
		const rows = await db
			.select({ id: connection.id })
			.from(connection)
			.where(eq(connection.providerId, created.providerId));
		expect(rows).toHaveLength(1);
	});
});

describe('credential secret is shown exactly once and never re-readable', () => {
	it('returns the plaintext in the action result only', async () => {
		// The connection row is written directly: this test is about the secret
		// projection, and the create action resolves the base_url host first.
		const connId = newId(ID_PREFIXES.connection);
		await db.insert(connection).values({
			id: connId,
			providerId: created.providerId,
			name: 'pool',
			slug: 'pool',
			baseUrl: 'https://api.example.com/v1',
			authType: 'bearer'
		});
		const secret = 'sk-smoke-plaintext-31415';
		const result = await (credentialsActions.create as CreateAction)({
			locals,
			request: post({
				name: 'smoke account',
				connectionId: connId,
				secret,
				priority: '100',
				weight: '100',
				metadata: '{}'
			}),
			params: { id: created.providerId }
		});
		// The one secret-bearing shape, minted by the create response.
		const once = secretOnceOf(result);
		expect(once).not.toBeNull();
		expect(once!.shownOnce).toBe(true);
		expect(once!.secret).toBe(secret);

		// The stored row is ciphertext, not plaintext.
		const [stored] = await db
			.select({ secretEnc: credential.secretEnc })
			.from(credential)
			.where(eq(credential.id, once!.id));
		expect(stored.secretEnc).not.toContain(secret);

		// A reload's page data carries no secret material at all.
		const data = await (credentialsLoad as CredentialsLoad)({
			locals,
			params: { id: created.providerId },
			url: new URL('http://localhost/admin/providers/x/credentials')
		} as never);
		if (!data) throw new Error('credentials load returned no data');
		expect(JSON.stringify(data)).not.toContain(secret);
		expect(JSON.stringify(data)).not.toContain(stored.secretEnc);
		expect(data.pool).toMatchObject({ total: 1 });
	});
});
