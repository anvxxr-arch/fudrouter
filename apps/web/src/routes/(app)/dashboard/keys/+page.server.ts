import { fail } from '@sveltejs/kit';
import { and, desc, eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { apiKey } from '$lib/server/db/schema';
import { generateApiKey } from '$lib/server/keys';
import { requireCap } from '$lib/server/roles';

export const load: PageServerLoad = async ({ locals }) => {
	// The hook gates this route; this is the second layer, as on /admin.
	requireCap(locals, 'member');
	const userId = locals.user!.id;

	const keys = await db
		.select({
			id: apiKey.id,
			name: apiKey.name,
			prefix: apiKey.prefix,
			lastUsedAt: apiKey.lastUsedAt,
			revokedAt: apiKey.revokedAt,
			createdAt: apiKey.createdAt
		})
		.from(apiKey)
		.where(eq(apiKey.userId, userId))
		.orderBy(desc(apiKey.createdAt));

	return { keys };
};

export const actions: Actions = {
	create: async ({ locals, request }) => {
		requireCap(locals, 'member');
		const userId = locals.user!.id;
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim() || 'default';

		const { key, prefix, keyHash } = generateApiKey();

		await db.insert(apiKey).values({
			id: uuidv7(),
			userId,
			name,
			prefix,
			keyHash
		});

		// The plaintext key exists only in this response. Only sha256(secret) is
		// stored, so a lost key can be revoked and reissued but never recovered.
		return { created: key, name };
	},

	revoke: async ({ locals, request }) => {
		requireCap(locals, 'member');
		const userId = locals.user!.id;
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing key id' });

		// Scope the update by userId: an id alone must never revoke someone
		// else's key, and this returns 0 rows instead of leaking existence.
		const revoked = await db
			.update(apiKey)
			.set({ revokedAt: new Date() })
			.where(and(eq(apiKey.id, id), eq(apiKey.userId, userId)))
			.returning({ id: apiKey.id });

		if (revoked.length === 0) return fail(404, { error: 'Key not found' });
		return { revoked: id };
	}
};
