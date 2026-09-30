import { error, fail } from '@sveltejs/kit';
import { eq, sql } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { requireCap, canAdminister } from '$lib/server/roles';
import { writeAudit } from '$lib/server/audit';
import { balanceMicro } from '$lib/server/billing';
import { db } from '$lib/server/db';
import {
	apiKey,
	billingAccount,
	project,
	requestLog,
	user,
	workspace,
	workspaceMember,
	workspaceRole
} from '$lib/server/db/schema';
import { session as sessionTable } from '$lib/server/db/auth.schema';
/** The acting user's role, or null when unauthenticated. */
function actorRole(locals: App.Locals): string | null {
	return (locals.user as { role?: string | null } | null)?.role ?? null;
}
/**
 * Privilege ORDER guard (mirror of the list page): an actor may only touch an
 * account whose capability set it dominates. See `canAdminister` in
 * `$lib/server/roles`. Returns the refusal message, or null when permitted.
 */
function guardMayAct(locals: App.Locals, targetRole: string | null): string | null {
	if (canAdminister(actorRole(locals), targetRole)) return null;
	return 'You cannot modify a user at or above your own level';
}
export const load: PageServerLoad = async ({ locals, params }) => {
	requireCap(locals, 'admin.users');
	const [account] = await db
		.select({
			id: user.id,
			name: user.name,
			email: user.email,
			role: user.role,
			banned: user.banned,
			banReason: user.banReason,
			emailVerified: user.emailVerified,
			createdAt: user.createdAt,
			updatedAt: user.updatedAt
		})
		.from(user)
		.where(eq(user.id, params.id))
		.limit(1);
	if (!account) error(404, 'User not found');
	const id = account.id;
	const memberships = await db
		.select({
			memberId: workspaceMember.id,
			workspaceId: workspace.id,
			workspaceName: workspace.name,
			workspaceSlug: workspace.slug,
			workspaceStatus: workspace.status,
			role: workspaceRole.name,
			status: workspaceMember.status
		})
		.from(workspaceMember)
		.innerJoin(workspace, eq(workspace.id, workspaceMember.workspaceId))
		.innerJoin(workspaceRole, eq(workspaceRole.id, workspaceMember.roleId))
		.where(eq(workspaceMember.userId, id))
		.orderBy(workspace.name);
	const projects = await db
		.select({
			id: project.id,
			name: project.name,
			slug: project.slug,
			status: project.status,
			workspaceName: workspace.name
		})
		.from(project)
		.innerJoin(workspaceMember, eq(workspaceMember.workspaceId, project.workspaceId))
		.innerJoin(workspace, eq(workspace.id, project.workspaceId))
		.where(eq(workspaceMember.userId, id))
		.orderBy(workspace.name, project.name);
	const [usage] = await db
		.select({
			requests: sql<number>`count(*)::int`,
			tokensIn: sql<number>`coalesce(sum(${requestLog.tokensIn}), 0)::int`,
			tokensOut: sql<number>`coalesce(sum(${requestLog.tokensOut}), 0)::int`,
			cost: sql<string>`coalesce(sum(${requestLog.cost}), 0)::text`,
			lastRequest: sql<Date | null>`max(${requestLog.createdAt})`
		})
		.from(requestLog)
		.where(eq(requestLog.userId, id));
	// Billing: one account per workspace. `balance_micro` is only a cache of the
	// ledger sum (PRD §48) — the live figure comes from the ledger; the cached
	// column is shown alongside so drift is visible.
	const accounts = await db
		.select({
			workspaceId: billingAccount.workspaceId,
			workspaceName: workspace.name,
			accountId: billingAccount.id,
			currency: billingAccount.currency,
			status: billingAccount.status,
			cachedBalanceMicro: billingAccount.balanceMicro
		})
		.from(billingAccount)
		.innerJoin(workspaceMember, eq(workspaceMember.workspaceId, billingAccount.workspaceId))
		.innerJoin(workspace, eq(workspace.id, billingAccount.workspaceId))
		.where(eq(workspaceMember.userId, id))
		.orderBy(workspace.name);
	const billing = await Promise.all(
		accounts.map(async (a) => ({
			...a,
			balanceMicro: await balanceMicro(a.accountId)
		}))
	);
	// API key METADATA only: never `key_hash`, never a secret.
	const keys = await db
		.select({
			id: apiKey.id,
			name: apiKey.name,
			prefix: apiKey.prefix,
			status: apiKey.status,
			lastUsedAt: apiKey.lastUsedAt,
			revokedAt: apiKey.revokedAt,
			createdAt: apiKey.createdAt
		})
		.from(apiKey)
		.where(eq(apiKey.userId, id))
		.orderBy(apiKey.createdAt);
	// Last activity: a request, a fresh session, or a key use, whichever is newer.
	const [sess] = await db
		.select({ at: sql<Date | null>`max(${sessionTable.createdAt})` })
		.from(sessionTable)
		.where(eq(sessionTable.userId, id));
	const [keyUse] = await db
		.select({ at: sql<Date | null>`max(${apiKey.lastUsedAt})` })
		.from(apiKey)
		.where(eq(apiKey.userId, id));
	const latest = (usage?.lastRequest ? [usage.lastRequest] : [])
		.concat(sess?.at ? [sess.at] : [])
		.concat(keyUse?.at ? [keyUse.at] : []);
	const lastActivity =
		latest.length > 0 ? new Date(Math.max(...latest.map((d) => d.getTime()))) : null;
	const sessions = await db
		.select({ id: sessionTable.id, createdAt: sessionTable.createdAt })
		.from(sessionTable)
		.where(eq(sessionTable.userId, id))
		.orderBy(sessionTable.createdAt);
	return {
		account,
		memberships,
		projects,
		usage: usage ?? { requests: 0, tokensIn: 0, tokensOut: 0, cost: '0', lastRequest: null },
		billing,
		keys,
		sessionCount: sessions.length,
		lastActivity
	};
};
export const actions: Actions = {
	suspend: async ({ locals, request }) => {
		requireCap(locals, 'admin.users');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing user id' });
		if (form.get('confirm') !== 'on') return fail(400, { error: 'Confirm to suspend this account' });
		if (id === locals.user!.id) return fail(400, { error: 'You cannot suspend yourself' });
		const [target] = await db
			.select({ banned: user.banned, role: user.role })
			.from(user)
			.where(eq(user.id, id))
			.limit(1);
		if (!target) return fail(404, { error: 'User not found' });
		const refusal = guardMayAct(locals, target.role);
		if (refusal) return fail(403, { error: refusal });
		await db.transaction(async (tx) => {
			await tx.update(user).set({ banned: true }).where(eq(user.id, id));
			// Mirror the toggleBan cleanup: better-auth only checks `banned` at
			// session creation, so live sessions must die with the suspension.
			await tx.delete(sessionTable).where(eq(sessionTable.userId, id));
			await writeAudit(tx, {
				actorUserId: locals.user?.id ?? null,
				action: 'user.suspend',
				resource: 'user',
				resourceId: id,
				before: { banned: target.banned },
				after: { banned: true },
				metadata: { sessionsRevoked: true }
			});
		});
		return { suspended: id };
	},
	unsuspend: async ({ locals, request }) => {
		requireCap(locals, 'admin.users');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing user id' });
		if (form.get('confirm') !== 'on')
			return fail(400, { error: 'Confirm to unsuspend this account' });
		const [target] = await db
			.select({ banned: user.banned, role: user.role })
			.from(user)
			.where(eq(user.id, id))
			.limit(1);
		if (!target) return fail(404, { error: 'User not found' });
		const refusal = guardMayAct(locals, target.role);
		if (refusal) return fail(403, { error: refusal });
		await db.transaction(async (tx) => {
			await tx.update(user).set({ banned: false }).where(eq(user.id, id));
			await writeAudit(tx, {
				actorUserId: locals.user?.id ?? null,
				action: 'user.unsuspend',
				resource: 'user',
				resourceId: id,
				before: { banned: target.banned },
				after: { banned: false }
			});
		});
		return { unsuspended: id };
	},
	disableAccess: async ({ locals, request }) => {
		requireCap(locals, 'admin.users');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing user id' });
		if (form.get('confirm') !== 'on')
			return fail(400, { error: 'Confirm to disable access for this account' });
		if (id === locals.user!.id) return fail(400, { error: 'You cannot disable your own access' });
		const [target] = await db
			.select({ banned: user.banned, role: user.role })
			.from(user)
			.where(eq(user.id, id))
			.limit(1);
		if (!target) return fail(404, { error: 'User not found' });
		const refusal = guardMayAct(locals, target.role);
		if (refusal) return fail(403, { error: refusal });
		await db.transaction(async (tx) => {
			// Access cut without a ban: the role stays (history, ownership), the
			// account is not marked banned — sessions die and every key goes dark.
			await tx.update(user).set({ banned: false }).where(eq(user.id, id));
			await tx.delete(sessionTable).where(eq(sessionTable.userId, id));
			const disabled = await tx
				.update(apiKey)
				.set({ status: 'disabled' })
				.where(eq(apiKey.userId, id))
				.returning({ id: apiKey.id });
			await writeAudit(tx, {
				actorUserId: locals.user?.id ?? null,
				action: 'user.access_disabled',
				resource: 'user',
				resourceId: id,
				before: { banned: target.banned },
				after: { banned: false, keyStatus: 'disabled' },
				metadata: { sessionsRevoked: true, keysDisabled: disabled.length }
			});
		});
		return { accessDisabled: id };
	}
};
