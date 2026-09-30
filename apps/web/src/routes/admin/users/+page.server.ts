import { fail } from '@sveltejs/kit';
import { desc, eq, sql } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { requireCap, canAdminister } from '$lib/server/roles';
import { writeAudit } from '$lib/server/audit';
import { db } from '$lib/server/db';
import {
	apiKey,
	auditLog,
	project,
	requestLog,
	user,
	workspaceMember
} from '$lib/server/db/schema';
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
	if (canAdminister(actorRole(locals), targetRole, grantedRole)) return null;
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
	const userIds = users.map((u) => u.id);
	const zero = { requests: 0, cost: '0', lastRequest: null as Date | null };
	const usageByUser = new Map<string, { requests: number; cost: string; lastRequest: Date | null }>(
		userIds.map((id) => [id, { ...zero }])
	);
	const wsByUser = new Map<string, number>(userIds.map((id) => [id, 0]));
	const projByUser = new Map<string, number>(userIds.map((id) => [id, 0]));
	const keyByUser = new Map<string, number>(userIds.map((id) => [id, 0]));
	const lastByUser = new Map<string, Date | null>(userIds.map((id) => [id, null]));
	// NULL subject rows are anonymised history (user_id SET NULL) — they have no
	// account to attach to and are skipped rather than invented into totals.
	if (userIds.length > 0) {
		const usage = await db
			.select({
				userId: requestLog.userId,
				requests: sql<number>`count(*)::int`,
				cost: sql<string>`coalesce(sum(${requestLog.cost}), 0)::text`,
				lastRequest: sql<Date | null>`max(${requestLog.createdAt})`
			})
			.from(requestLog)
			.where(sql`${requestLog.userId} = any(${userIds})`)
			.groupBy(requestLog.userId);
		for (const u of usage) if (u.userId) usageByUser.set(u.userId, u);
		const ws = await db
			.select({ userId: workspaceMember.userId, n: sql<number>`count(*)::int` })
			.from(workspaceMember)
			.where(sql`${workspaceMember.userId} = any(${userIds})`)
			.groupBy(workspaceMember.userId);
		for (const w of ws) wsByUser.set(w.userId, w.n);
		const projs = await db
			.select({ userId: workspaceMember.userId, n: sql<number>`count(distinct ${project.id})::int` })
			.from(project)
			.innerJoin(workspaceMember, eq(workspaceMember.workspaceId, project.workspaceId))
			.where(sql`${workspaceMember.userId} = any(${userIds})`)
			.groupBy(workspaceMember.userId);
		for (const p of projs) projByUser.set(p.userId, p.n);
		const keys = await db
			.select({ userId: apiKey.userId, n: sql<number>`count(*)::int` })
			.from(apiKey)
			.where(sql`${apiKey.userId} = any(${userIds})`)
			.groupBy(apiKey.userId);
		for (const k of keys) keyByUser.set(k.userId, k.n);
		// Last activity: the newest of a request, a fresh session, an admin act,
		// or a key use — whichever happened last.
		const sess = await db
			.select({ userId: sessionTable.userId, at: sql<Date | null>`max(${sessionTable.createdAt})` })
			.from(sessionTable)
			.where(sql`${sessionTable.userId} = any(${userIds})`)
			.groupBy(sessionTable.userId);
		const aud = await db
			.select({
				actorUserId: auditLog.actorUserId,
				at: sql<Date | null>`max(${auditLog.createdAt})`
			})
			.from(auditLog)
			.where(sql`${auditLog.actorUserId} = any(${userIds})`)
			.groupBy(auditLog.actorUserId);
		const ku = await db
			.select({ userId: apiKey.userId, at: sql<Date | null>`max(${apiKey.lastUsedAt})` })
			.from(apiKey)
			.where(sql`${apiKey.userId} = any(${userIds})`)
			.groupBy(apiKey.userId);
		const sessionByUser = new Map(sess.map((s) => [s.userId, s.at]));
		const auditByUser = new Map(aud.map((a) => [a.actorUserId, a.at]));
		const keyUseByUser = new Map(ku.map((k) => [k.userId, k.at]));
		const latest = (dates: (Date | null | undefined)[]): Date | null => {
			const ds = dates.filter((d): d is Date => d instanceof Date);
			return ds.length > 0 ? new Date(Math.max(...ds.map((d) => d.getTime()))) : null;
		};
		for (const id of userIds) {
			lastByUser.set(
				id,
				latest([
					usageByUser.get(id)?.lastRequest,
					sessionByUser.get(id),
					auditByUser.get(id),
					keyUseByUser.get(id)
				])
			);
		}
	}
	return {
		users: users.map((u) => ({
			...u,
			workspaces: wsByUser.get(u.id) ?? 0,
			projects: projByUser.get(u.id) ?? 0,
			keys: keyByUser.get(u.id) ?? 0,
			requests: usageByUser.get(u.id)?.requests ?? 0,
			cost: usageByUser.get(u.id)?.cost ?? '0',
			lastActivity: lastByUser.get(u.id) ?? null
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
		await db.transaction(async (tx) => {
			await tx.update(user).set({ role }).where(eq(user.id, id));
			await writeAudit(tx, {
				actorUserId: locals.user?.id ?? null,
				action: 'user.role_set',
				resource: 'user',
				resourceId: id,
				before: { role: target.role },
				after: { role }
			});
		});
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
		await db.transaction(async (tx) => {
			await tx.update(user).set({ banned: nowBanned }).where(eq(user.id, id));
			// Revoke every live session when banning. better-auth only consults
			// `banned` when a session is CREATED (its `session.create.before` hook),
			// so an already-issued session keeps full access until it expires — up to
			// seven days. Measured live: a banned user's session stayed valid until
			// 2026-09-30. A ban that does not take effect immediately is not a ban.
			if (nowBanned) {
				await tx.delete(sessionTable).where(eq(sessionTable.userId, id));
			}
			await writeAudit(tx, {
				actorUserId: locals.user?.id ?? null,
				action: nowBanned ? 'user.ban' : 'user.unban',
				resource: 'user',
				resourceId: id,
				before: { banned: target.banned },
				after: { banned: nowBanned },
				metadata: nowBanned ? { sessionsRevoked: true } : {}
			});
		});
		return { bannedToggled: id };
	}
};
