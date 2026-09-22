import { fail } from '@sveltejs/kit';
import { desc, eq, sql } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { requireCap } from '$lib/server/roles';
import { decryptCredentials } from '$lib/server/credentials';
import { db } from '$lib/server/db';
import { provider, requestLog } from '$lib/server/db/schema';

export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'admin.ops');

	// Never select credentials_enc — only the aggregate traffic view.
	const providers = await db
		.select({
			id: provider.id,
			name: provider.name,
			baseUrl: provider.baseUrl,
			status: provider.status,
			priority: provider.priority
		})
		.from(provider)
		.orderBy(provider.priority, provider.name);

	const agg = await db
		.select({
			providerId: requestLog.providerId,
			requests: sql<number>`count(*)::int`,
			errors: sql<number>`count(*) filter (where ${requestLog.status} <> 'success')::int`,
			avgLatency: sql<number>`coalesce(round(avg(${requestLog.latencyMs})), 0)::int`,
			lastAt: sql<string | null>`max(${requestLog.createdAt})::text`
		})
		.from(requestLog)
		.groupBy(requestLog.providerId);
	const byProvider = new Map(agg.map((a) => [a.providerId, a]));

	// The provider that served the most recent request is the "currently in use"
	// connection, since routing picks one provider per request.
	const [latest] = await db
		.select({ providerId: requestLog.providerId, at: requestLog.createdAt })
		.from(requestLog)
		.orderBy(desc(requestLog.createdAt))
		.limit(1);

	return {
		providers: providers.map((p) => ({
			...p,
			requests: byProvider.get(p.id)?.requests ?? 0,
			errors: byProvider.get(p.id)?.errors ?? 0,
			avgLatency: byProvider.get(p.id)?.avgLatency ?? 0,
			lastAt: byProvider.get(p.id)?.lastAt ?? null,
			inUse: latest?.providerId === p.id
		})),
		lastRequestAt: latest?.at?.toISOString() ?? null
	};
};

export const actions: Actions = {
	// Live reachability probe: decrypt the credential server-side and call
	// `<baseUrl>/models`. The plaintext never leaves this function.
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

		let cred: Record<string, unknown>;
		try {
			cred = decryptCredentials(p.credentialsEnc);
		} catch {
			return { test: { ...result, message: 'cannot decrypt credentials' } };
		}

		const headers: Record<string, string> = {
			...((cred.default_headers as Record<string, string>) ?? {})
		};
		const apiKey = String(cred.api_key ?? '');
		if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;

		const url = `${p.baseUrl.replace(/\/$/, '')}/models`;
		const started = Date.now();
		try {
			const ctrl = new AbortController();
			const timer = setTimeout(() => ctrl.abort(), 8000);
			const res = await fetch(url, { headers, signal: ctrl.signal });
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
