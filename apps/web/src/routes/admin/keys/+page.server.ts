import { fail } from '@sveltejs/kit';
import { desc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { Actions, PageServerLoad } from './$types';
import { microToUsd, usdToMicro } from '$lib/server/admin';
import { requireCap } from '$lib/server/roles';
import { db } from '$lib/server/db';
import { apiKey, requestLog, user } from '$lib/server/db/schema';
import { generateApiKey } from '$lib/server/keys';

type Limits = { rpm: number | null; monthly_cost_micro: string | null };

function readLimits(form: FormData): Limits {
	const rpmRaw = String(form.get('rpm') ?? '').trim();
	const rpm = rpmRaw ? Number(rpmRaw) : null;
	return {
		rpm: rpm !== null && Number.isFinite(rpm) && rpm >= 0 ? rpm : null,
		monthly_cost_micro: usdToMicro(String(form.get('monthlyCap') ?? ''))
	};
}

export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'admin.keys');

	const users = await db
		.select({ id: user.id, email: user.email, name: user.name, role: user.role })
		.from(user)
		.orderBy(user.email);

	const keys = await db
		.select({
			id: apiKey.id,
			name: apiKey.name,
			prefix: apiKey.prefix,
			limits: apiKey.limits,
			lastUsedAt: apiKey.lastUsedAt,
			revokedAt: apiKey.revokedAt,
			createdAt: apiKey.createdAt,
			userId: apiKey.userId,
			email: user.email
		})
		.from(apiKey)
		.innerJoin(user, eq(user.id, apiKey.userId))
		.orderBy(desc(apiKey.createdAt));

	// Per-key totals — the raw material for "total usage" and "top consumer".
	const usage = await db
		.select({
			apiKeyId: requestLog.apiKeyId,
			requests: sql<number>`count(*)::int`,
			tokensIn: sql<number>`coalesce(sum(${requestLog.tokensIn}), 0)::int`,
			tokensOut: sql<number>`coalesce(sum(${requestLog.tokensOut}), 0)::int`,
			cost: sql<string>`coalesce(sum(${requestLog.cost}), 0)::text`
		})
		.from(requestLog)
		.groupBy(requestLog.apiKeyId);
	const byKey = new Map(usage.map((u) => [u.apiKeyId, u]));

	const empty = { requests: 0, tokensIn: 0, tokensOut: 0, cost: '0' };
	const rows = keys
		.map((k) => {
			const limits = (k.limits ?? {}) as Partial<Limits>;
			return {
				...k,
				usage: byKey.get(k.id) ?? empty,
				rpm: limits.rpm ?? null,
				monthlyCapUsd: limits.monthly_cost_micro ? microToUsd(limits.monthly_cost_micro) : ''
			};
		})
		.sort((a, b) => Number(BigInt(b.usage.cost) - BigInt(a.usage.cost)));

	return { users, keys: rows };
};

export const actions: Actions = {
	create: async ({ locals, request }) => {
		requireCap(locals, 'admin.keys');
		const form = await request.formData();
		const userId = String(form.get('userId') ?? '').trim();
		const name = String(form.get('name') ?? '').trim() || 'default';
		if (!userId) return fail(400, { error: 'Pick an owner for the key' });

		const limits = readLimits(form);
		const { key, prefix, keyHash } = generateApiKey();

		try {
			await db.insert(apiKey).values({
				id: uuidv7(),
				userId,
				name,
				prefix,
				keyHash,
				limits
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'insert failed';
			return fail(400, { error: `Could not create key: ${msg}` });
		}

		// Plaintext exists only in this response; only sha256(secret) is stored.
		return { created: key, name };
	},

	updateLimits: async ({ locals, request }) => {
		requireCap(locals, 'admin.keys');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing key id' });

		const updated = await db
			.update(apiKey)
			.set({ limits: readLimits(form) })
			.where(eq(apiKey.id, id))
			.returning({ id: apiKey.id });
		if (updated.length === 0) return fail(404, { error: 'Key not found' });
		return { limitsSaved: id };
	},

	revoke: async ({ locals, request }) => {
		requireCap(locals, 'admin.keys');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing key id' });

		const revoked = await db
			.update(apiKey)
			.set({ revokedAt: new Date() })
			.where(eq(apiKey.id, id))
			.returning({ id: apiKey.id });
		if (revoked.length === 0) return fail(404, { error: 'Key not found' });
		return { revoked: id };
	}
};
