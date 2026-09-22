import { fail } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { profile, user } from '$lib/server/db/schema';

export const load: PageServerLoad = async ({ locals }) => {
	const userId = locals.user!.id;
	const [account] = await db
		.select({
			id: user.id,
			name: user.name,
			email: user.email,
			role: user.role,
			createdAt: user.createdAt
		})
		.from(user)
		.where(eq(user.id, userId))
		.limit(1);
	const [prof] = await db
		.select({ timezone: profile.timezone })
		.from(profile)
		.where(eq(profile.userId, userId))
		.limit(1);
	return { account, timezone: prof?.timezone ?? '' };
};

export const actions: Actions = {
	save: async ({ locals, request }) => {
		const userId = locals.user!.id;
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		const timezone = String(form.get('timezone') ?? '').trim();

		if (!name) return fail(400, { error: 'Name is required' });

		await db.update(user).set({ name }).where(eq(user.id, userId));
		await db
			.insert(profile)
			.values({ userId, timezone })
			.onConflictDoUpdate({ target: profile.userId, set: { timezone } });

		return { saved: true };
	}
};
