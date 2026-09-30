import { fail } from '@sveltejs/kit';
import { eq, sql } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { requireCap } from '$lib/server/roles';
import { decryptCredentials } from '$lib/server/credentials';
import { db } from '$lib/server/db';
import { connection, credential, provider } from '$lib/server/db/schema';
import { assertPublicUpstream } from '$lib/server/ssrf';

export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'admin.ops');
	// Never select secret_enc / credentials_enc — only routing shape and counts.
	const rows = await db
		.select({
			id: connection.id,
			name: connection.name,
			slug: connection.slug,
			baseUrl: connection.baseUrl,
			region: connection.region,
			authType: connection.authType,
			timeoutMs: connection.timeoutMs,
			priority: connection.priority,
			enabled: connection.enabled,
			healthStatus: connection.healthStatus,
			providerId: provider.id,
			providerName: provider.name
		})
		.from(connection)
		.innerJoin(provider, eq(provider.id, connection.providerId))
		.orderBy(provider.name, connection.priority, connection.name);
	const counts = await db
		.select({
			connectionId: credential.connectionId,
			total: sql<number>`count(*)::int`,
			healthy: sql<number>`count(*) filter (where ${credential.status} = 'healthy')::int`
		})
		.from(credential)
		.groupBy(credential.connectionId);
	const byConn = new Map(counts.map((c) => [c.connectionId, c]));
	return {
		connections: rows.map((r) => ({
			...r,
			credentialTotal: byConn.get(r.id)?.total ?? 0,
			credentialHealthy: byConn.get(r.id)?.healthy ?? 0
		}))
	};
};

export const actions: Actions = {
	// Live reachability probe: decrypt a credential server-side and call
	// `<baseUrl>/models`. The plaintext never leaves this function. `id` is the
	// provider id (unchanged contract); the endpoint and secret come from that
	// provider's first connection + credential rows now that `provider.credentialsEnc`
	// is legacy.
	test: async ({ locals, request }) => {
		requireCap(locals, 'admin.ops');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		// Every branch returns this exact shape so the page can render any result.
		const result = {
			id,
			ok: false,
			status: null as number | null,
			latencyMs: 0,
			url: '',
			message: null as string | null
		};
		const [p] = await db.select().from(provider).where(eq(provider.id, id)).limit(1);
		if (!p) return fail(404, { test: { ...result, message: 'provider not found' } });
		const [conn] = await db
			.select({ baseUrl: connection.baseUrl })
			.from(connection)
			.where(eq(connection.providerId, p.id))
			.orderBy(connection.priority, connection.name)
			.limit(1);
		if (!conn) return { test: { ...result, message: 'provider has no connection rows' } };
		const [cred] = await db
			.select({ secretEnc: credential.secretEnc })
			.from(credential)
			.innerJoin(connection, eq(connection.id, credential.connectionId))
			.where(eq(connection.providerId, p.id))
			.orderBy(credential.priority, credential.name, credential.id)
			.limit(1);
		if (!cred) return { test: { ...result, message: 'provider has no credential rows' } };
		let payload: Record<string, unknown>;
		try {
			payload = decryptCredentials(cred.secretEnc);
		} catch {
			return { test: { ...result, message: 'cannot decrypt credentials' } };
		}
		const headers: Record<string, string> = {
			...((payload.default_headers as Record<string, string>) ?? {})
		};
		const apiKey = String(payload.api_key ?? '');
		if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
		const url = `${conn.baseUrl.replace(/\/$/, '')}/models`;
		// base_url is admin-supplied, so this fetch is a request-forgery
		// primitive until the target is checked: 169.254.169.254 hands over the
		// cloud instance's credentials, and anything on 127.0.0.1 turns this
		// page into a port scanner for the box. The router applies the same rule
		// at the socket (internal/proxy/guard.go); this is the web-side check,
		// because global fetch has no dial hook to hang it on.
		const guard = await assertPublicUpstream(conn.baseUrl);
		if (!guard.ok) {
			return { test: { ...result, url, message: guard.reason } };
		}
		const started = Date.now();
		try {
			const ctrl = new AbortController();
			const timer = setTimeout(() => ctrl.abort(), 8000);
			// manual, not follow: a redirect is a second request to an address
			// nothing has checked yet, which is the whole attack. The router
			// re-guards every hop at the socket; fetch cannot, so it does not
			// follow at all.
			const res = await fetch(url, { headers, signal: ctrl.signal, redirect: 'manual' });
			clearTimeout(timer);
			return {
				test: { ...result, ok: res.ok, status: res.status, latencyMs: Date.now() - started, url }
			};
		} catch (err) {
			return {
				test: {
					...result,
					latencyMs: Date.now() - started,
					url,
					message: err instanceof Error ? err.message : 'request failed'
				}
			};
		}
	}
};
