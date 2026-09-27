import { fail } from '@sveltejs/kit';
import { desc, eq, sql } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { requireCap, canAdminister } from '$lib/server/roles';
import { db } from '$lib/server/db';
import { apiKey, requestLog, user } from '$lib/server/db/schema';
import { session as sessionTable } from '$lib/server/db/auth.schema';

const ROLES = ['user', 'finance_admin', 'ops_admin', 'admin'];

/** The acting user's role, or null when unauthenticated. */
function actorRole(locals: App.Locals): string | null {
	return (locals.user as { role?: string | null } | null)?.role ?? null;
}

/**
 * Guard a role/ban mutation by privilege ORDER, not by identity alone.
 *
 * `admin.users` is held by `finance_admin` too, so a check that only blocked
 * self-demotion let a billing-only account promote ITSELF to `admin` (full
 * `ALL_CAPS`, including provider-credential access). Returns the refusal message,
 * or null when the action is permitted. See `canAdminister` in `$lib/server/roles`.
 */
function guardMayAct(
	locals: App.Locals,
	targetRole: string | null,
	grantedRole?: string
): string | null {
	if (canAdminister(actorRole(locals), targetRole, grantedRole))
		return null;
	return grantedRole !== undefined && grantedRole !== targetRole
		? 'You cannot grant a role above your own level'
		: 'You cannot modify a user at or above your own level';
}

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

		// Changing your OWN role is always refused: with only a self-demotion
		// guard, an actor whose cap set includes `admin.users` could promote
		// itself. Reading the current role is required for the ordering check.
		if (id === locals.user!.id) return fail(400, { error: 'You cannot change your own role' });

		const [target] = await db
			.select({ role: user.role })
			.from(user)
			.where(eq(user.id, id))
			.limit(1);
		if (!target) return fail(404, { error: 'User not found' });

		const refusal = guardMayAct(locals, target.role, role);
		if (refusal) return fail(403, { error: refusal });

		await db.update(user).set({ role }).where(eq(user.id, id));
		return { roleSet: id };
	},

	toggleBan: async ({ locals, request }) => {
		requireCap(locals, 'admin.users');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing user id' });
		if (id === locals.user!.id) return fail(400, { error: 'You cannot ban yourself' });

		const [target] = await db
			.select({ banned: user.banned, role: user.role })
			.from(user)
			.where(eq(user.id, id))
			.limit(1);
		if (!target) return fail(404, { error: 'User not found' });

		// Same ordering rule as setRole: an actor must not be able to ban a peer
		// or a superior (e.g. finance_admin banning an admin).
		const refusal = guardMayAct(locals, target.role);
		if (refusal) return fail(403, { error: refusal });

		const nowBanned = !target.banned;
		await db.update(user).set({ banned: nowBanned }).where(eq(user.id, id));

		// Revoke every live session when banning. better-auth only consults
		// `banned` when a session is CREATED (its `session.create.before` hook),
		// so an already-issued session keeps full access until it expires — up to
		// seven days. Measured live: a banned user's session stayed valid until
		// 2026-09-30. A ban that does not take effect immediately is not a ban.
		if (nowBanned) {
			await db.delete(sessionTable).where(eq(sessionTable.userId, id));
		}

		return { bannedToggled: id };
	}
};
