import { eq, and, asc } from 'drizzle-orm';
import { error } from '@sveltejs/kit';
import { getRequestEvent } from '$app/server';
import { db } from '$lib/server/db';
import { workspace, workspaceMember, workspaceRole } from '$lib/server/db/schema';

/**
 * Workspace RBAC (spec §2, PRD §46).
 *
 * A role is a COLLECTION OF PERMISSION CODES stored as a jsonb array — custom
 * roles are rows in `workspace_role`, never a schema change. Builtin templates
 * carry `workspace_id NULL`; `workspace_member.role_id` points at either a
 * builtin template or a workspace-custom row.
 *
 * Pages gate on permission codes, never on a literal role string, so a custom
 * role works everywhere without touching a single gate.
 */

export type WorkspacePermission =
	| 'workspace.read'
	| 'workspace.write'
	| 'workspace.delete'
	| 'member.read'
	| 'member.invite'
	| 'member.remove'
	| 'project.read'
	| 'project.write'
	| 'project.delete'
	| 'key.read'
	| 'key.create'
	| 'key.rotate'
	| 'key.revoke'
	| 'routing.read'
	| 'routing.write'
	| 'alias.read'
	| 'alias.write'
	| 'request.read'
	| 'analytics.read'
	| 'usage.read'
	| 'budget.read'
	| 'budget.write'
	| 'limit.read'
	| 'limit.write'
	| 'alert.read'
	| 'alert.write'
	| 'webhook.read'
	| 'webhook.write'
	| 'billing.read'
	| 'billing.write';

export const ALL_WORKSPACE_PERMISSIONS: WorkspacePermission[] = [
	'workspace.read',
	'workspace.write',
	'workspace.delete',
	'member.read',
	'member.invite',
	'member.remove',
	'project.read',
	'project.write',
	'project.delete',
	'key.read',
	'key.create',
	'key.rotate',
	'key.revoke',
	'routing.read',
	'routing.write',
	'alias.read',
	'alias.write',
	'request.read',
	'analytics.read',
	'usage.read',
	'budget.read',
	'budget.write',
	'limit.read',
	'limit.write',
	'alert.read',
	'alert.write',
	'webhook.read',
	'webhook.write',
	'billing.read',
	'billing.write'
];

/**
 * Builtin role matrix (spec §2). `owner` is the only role with
 * `workspace.delete` and the owner-scoped `member.remove`.
 */
export const WORKSPACE_ROLES: Record<string, WorkspacePermission[]> = {
	owner: ALL_WORKSPACE_PERMISSIONS,
	admin: ALL_WORKSPACE_PERMISSIONS.filter((p) => p !== 'workspace.delete'),
	developer: [
		'workspace.read',
		'member.read',
		'project.read',
		'project.write',
		'key.read',
		'key.create',
		'key.rotate',
		'key.revoke',
		'routing.read',
		'routing.write',
		'alias.read',
		'alias.write',
		'request.read',
		'analytics.read',
		'usage.read',
		'budget.read',
		'limit.read',
		'alert.read',
		'alert.write',
		'webhook.read',
		'webhook.write'
	],
	billing: [
		'workspace.read',
		'member.read',
		'project.read',
		'usage.read',
		'analytics.read',
		'billing.read',
		'billing.write'
	],
	viewer: [
		'workspace.read',
		'member.read',
		'project.read',
		'key.read',
		'routing.read',
		'alias.read',
		'request.read',
		'analytics.read',
		'usage.read',
		'budget.read',
		'limit.read',
		'alert.read',
		'webhook.read',
		'billing.read'
	]
};

export interface MemberContext {
	member: { id: string; roleId: string; status: string };
	workspace: { id: string; name: string; slug: string; ownerUserId: string | null; status: string };
	caps: Set<WorkspacePermission>;
}

/**
 * The member row + its role's permission codes, or null when `userId` is not
 * an ACTIVE member of `workspaceId` (invited/suspended members have no caps).
 */
export async function memberContext(
	locals: App.Locals,
	workspaceId: string
): Promise<MemberContext | null> {
	const userId = locals.user?.id;
	if (!userId) return null;
	const [row] = await db
		.select({
			memberId: workspaceMember.id,
			memberRoleId: workspaceMember.roleId,
			memberStatus: workspaceMember.status,
			workspaceId: workspace.id,
			workspaceName: workspace.name,
			workspaceSlug: workspace.slug,
			workspaceOwnerUserId: workspace.ownerUserId,
			workspaceStatus: workspace.status,
			permissions: workspaceRole.permissions
		})
		.from(workspaceMember)
		.innerJoin(workspace, eq(workspace.id, workspaceMember.workspaceId))
		.innerJoin(workspaceRole, eq(workspaceRole.id, workspaceMember.roleId))
		.where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, userId)))
		.limit(1);
	if (!row) return null;
	return {
		member: { id: row.memberId, roleId: row.memberRoleId, status: row.memberStatus },
		workspace: {
			id: row.workspaceId,
			name: row.workspaceName,
			slug: row.workspaceSlug,
			ownerUserId: row.workspaceOwnerUserId,
			status: row.workspaceStatus
		},
		caps: new Set((row.permissions ?? []).filter(isWorkspacePermission))
	};
}

/** The permission codes `locals.user` holds in `workspaceId` (empty for a non-member). */
export async function memberCaps(
	locals: App.Locals,
	workspaceId: string
): Promise<Set<WorkspacePermission>> {
	const ctx = await memberContext(locals, workspaceId);
	if (!ctx || ctx.member.status !== 'active') return new Set();
	return ctx.caps;
}

/**
 * Gate a load/action on a workspace permission. Throws 401 (no session) or
 * 403 (not an active member / missing code) — the taxonomy pages surface as
 * friendly error pages.
 */
export async function requireMemberPermission(
	locals: App.Locals,
	workspaceId: string,
	perm: WorkspacePermission
): Promise<{ member: MemberContext['member']; workspace: MemberContext['workspace'] }> {
	if (!locals.user) error(401, 'Authentication required');
	const ctx = await memberContext(locals, workspaceId);
	if (!ctx || ctx.member.status !== 'active') error(403, 'Not a member of this workspace');
	if (!ctx.caps.has(perm)) error(403, 'Missing permission: ' + perm);
	return { member: ctx.member, workspace: ctx.workspace };
}

/**
 * The workspace the shell is pointed at: cookie `fwid`, but only while the
 * user is still an ACTIVE member of it (a stale cookie after a removal must
 * never pin them to a workspace they left). Falls back to their first
 * workspace by join order; null when they belong to none.
 */
export async function currentWorkspaceId(locals: App.Locals): Promise<string | null> {
	const userId = locals.user?.id;
	if (!userId) return null;
	// The cookie jar is reachable from the request event (same trick as
	// auth.ts's sveltekitCookies plugin), so this keeps the shared
	// `currentWorkspaceId(locals)` contract without widening App.Locals.
	let cookieWid: string | undefined;
	try {
		cookieWid = getRequestEvent().cookies.get('fwid');
	} catch {
		cookieWid = undefined; // no request context (tests, jobs) — fall through
	}
	if (cookieWid) {
		const [row] = await db
			.select({ id: workspaceMember.workspaceId })
			.from(workspaceMember)
			.where(
				and(
					eq(workspaceMember.workspaceId, cookieWid),
					eq(workspaceMember.userId, userId),
					eq(workspaceMember.status, 'active')
				)
			)
			.limit(1);
		if (row) return row.id;
	}
	const [first] = await db
		.select({ id: workspaceMember.workspaceId })
		.from(workspaceMember)
		.where(and(eq(workspaceMember.userId, userId), eq(workspaceMember.status, 'active')))
		.orderBy(asc(workspaceMember.createdAt))
		.limit(1);
	return first?.id ?? null;
}

/** Type guard over the closed permission list — a typo in a jsonb array can't grant. */
export function isWorkspacePermission(v: unknown): v is WorkspacePermission {
	return typeof v === 'string' && (ALL_WORKSPACE_PERMISSIONS as string[]).includes(v);
}
