import { fail } from '@sveltejs/kit';
import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { Actions, PageServerLoad } from './$types';
import { parseHeaderLines } from '$lib/server/admin';
import { requireCap } from '$lib/server/roles';
import { encryptCredentials } from '$lib/server/credentials';
import { db } from '$lib/server/db';
import { model, provider } from '$lib/server/db/schema';

const STATUSES = ['active', 'dev', 'disabled'];

export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'admin.providers');

	// Never select credentials_enc: the ciphertext must not leave the server.
	const rows = await db
		.select({
			id: provider.id,
			name: provider.name,
			baseUrl: provider.baseUrl,
			status: provider.status,
			priority: provider.priority,
			createdAt: provider.createdAt
		})
		.from(provider)
		.orderBy(provider.priority, provider.name);

	const counts = await db
		.select({ providerId: model.providerId, n: sql<number>`count(*)::int` })
		.from(model)
		.groupBy(model.providerId);
	const byProvider = new Map(counts.map((c) => [c.providerId, c.n]));

	const models = await db
		.select({ id: model.id, providerId: model.providerId, slug: model.slug, status: model.status })
		.from(model)
		.orderBy(model.slug);

	return {
		providers: rows.map((r) => ({ ...r, modelCount: byProvider.get(r.id) ?? 0 })),
		models,
		statuses: STATUSES
	};
};

function credentialBlob(apiKey: string, headersText: string): string {
	const headers = parseHeaderLines(headersText);
	const payload: Record<string, unknown> = { api_key: apiKey };
	if (Object.keys(headers).length > 0) payload.default_headers = headers;
	return encryptCredentials(payload);
}

export const actions: Actions = {
	create: async ({ locals, request }) => {
		requireCap(locals, 'admin.providers');
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		const baseUrl = String(form.get('baseUrl') ?? '').trim();
		const apiKey = String(form.get('apiKey') ?? '').trim();
		const headers = String(form.get('headers') ?? '');
		const status = String(form.get('status') ?? 'active');
		const priority = Number(form.get('priority') ?? 100);

		if (!name || !baseUrl || !apiKey) {
			return fail(400, { error: 'Name, base URL and API key are all required' });
		}
		if (!STATUSES.includes(status)) return fail(400, { error: 'Invalid status' });

		try {
			await db.insert(provider).values({
				id: uuidv7(),
				name,
				baseUrl,
				credentialsEnc: credentialBlob(apiKey, headers),
				status,
				priority: Number.isFinite(priority) ? priority : 100
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'insert failed';
			return fail(400, { error: `Could not create provider: ${msg}` });
		}
		return { created: name };
	},

	// Update metadata, and optionally rotate the credential (api_key re-encrypts).
	update: async ({ locals, request }) => {
		requireCap(locals, 'admin.providers');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		const baseUrl = String(form.get('baseUrl') ?? '').trim();
		const status = String(form.get('status') ?? '');
		const priority = Number(form.get('priority') ?? 100);
		const apiKey = String(form.get('apiKey') ?? '').trim();
		const headers = String(form.get('headers') ?? '');

		if (!id) return fail(400, { error: 'Missing provider id' });
		if (!STATUSES.includes(status)) return fail(400, { error: 'Invalid status' });

		const patch: Record<string, unknown> = {
			status,
			priority: Number.isFinite(priority) ? priority : 100
		};
		if (baseUrl) patch.baseUrl = baseUrl;
		if (apiKey) patch.credentialsEnc = credentialBlob(apiKey, headers);

		const updated = await db
			.update(provider)
			.set(patch)
			.where(eq(provider.id, id))
			.returning({ id: provider.id });
		if (updated.length === 0) return fail(404, { error: 'Provider not found' });
		return { updated: id };
	},

	delete: async ({ locals, request }) => {
		requireCap(locals, 'admin.providers');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing provider id' });

		try {
			const deleted = await db
				.delete(provider)
				.where(eq(provider.id, id))
				.returning({ id: provider.id });
			if (deleted.length === 0) return fail(404, { error: 'Provider not found' });
		} catch {
			// request_log.provider_id has no cascade: a referenced provider is kept.
			return fail(409, { error: 'Provider has request history — disable it instead' });
		}
		return { deleted: id };
	}
};
