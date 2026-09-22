import { fail } from '@sveltejs/kit';
import { desc, eq, sql } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { requireCap } from '$lib/server/roles';
import { db } from '$lib/server/db';
import { apiKey, requestLog, user } from '$lib/server/db/schema';

const ROLES = ['user', 'finance_admin', 'ops_admin', 'admin'];

export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'admin.users');

	const users = await db
		.select({
			id: user.id,
			name: user.name,
			email: user.email,
			role: user.role,
			banned: user.banned,
			createdAt: user.createdAt
		})
		.from(user)
		.orderBy(desc(user.createdAt));

	const keys = await db
		.select({ userId: apiKey.userId, n: sql<number>`count(*)::int` })
		.from(apiKey)
		.groupBy(apiKey.userId);
	const keyMap = new Map(keys.map((k) => [k.userId, k.n]));

	const usage = await db
		.select({
			userId: requestLog.userId,
			n: sql<number>`count(*)::int`,
			cost: sql<string>`coalesce(sum(${requestLog.cost}), 0)::text`
		})
		.from(requestLog)
		.groupBy(requestLog.userId);
	const useMap = new Map(usage.map((u) => [u.userId, u]));

	return {
		users: users.map((u) => ({
			...u,
			keys: keyMap.get(u.id) ?? 0,
			requests: useMap.get(u.id)?.n ?? 0,
			cost: useMap.get(u.id)?.cost ?? '0'
		})),
		roles: ROLES
	};
};

export const actions: Actions = {
	setRole: async ({ locals, request }) => {
		requireCap(locals, 'admin.users');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		const role = String(form.get('role') ?? '').trim();
		if (!id || !ROLES.includes(role)) return fail(400, { error: 'Invalid role' });
		if (id === locals.user!.id && role !== 'admin')
			return fail(400, { error: 'You cannot demote yourself' });

		const updated = await db
			.update(user)
			.set({ role })
			.where(eq(user.id, id))
			.returning({ id: user.id });
		if (updated.length === 0) return fail(404, { error: 'User not found' });
		return { roleSet: id };
	},

	toggleBan: async ({ locals, request }) => {
		requireCap(locals, 'admin.users');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing user id' });
		if (id === locals.user!.id) return fail(400, { error: 'You cannot ban yourself' });

		const [target] = await db
			.select({ banned: user.banned })
			.from(user)
			.where(eq(user.id, id))
			.limit(1);
		if (!target) return fail(404, { error: 'User not found' });

		await db.update(user).set({ banned: !target.banned }).where(eq(user.id, id));
		return { bannedToggled: id };
	}
};
