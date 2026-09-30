import { eq, sql } from 'drizzle-orm';
import { newId, ID_PREFIXES } from './id';
import type { DbTx } from './audit';
import { writeAudit } from './audit';
import {
	billingAccount,
	environment,
	project,
	workspace,
	workspaceMember,
	workspaceRole
} from '$lib/server/db/schema';

/**
 * Provisioning for the workspace hierarchy (spec §2 backfill shape, PRD §44).
 *
 * A fresh signup ends up with the same tree the 0007 backfill built for
 * existing users: workspace + owner membership on the builtin `owner`
 * template + default project + the three default environments + billing
 * account. Signup, invite acceptance and the create forms all call the SAME
 * helpers here, so the two paths can never drift.
 */

const DEFAULT_ENVIRONMENTS = [
	{ name: 'Development', slug: 'development', type: 'development' },
	{ name: 'Staging', slug: 'staging', type: 'staging' },
	{ name: 'Production', slug: 'production', type: 'production' }
] as const;

/** URL-safe slug; never empty, never leading/trailing dash. */
export function slugify(input: string): string {
	const s = input
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return s || 'workspace';
}

/** The three default environments for a project (PRD §22). */
export async function createDefaultEnvironments(dbtx: DbTx, projectId: string): Promise<string[]> {
	const ids: string[] = [];
	for (const env of DEFAULT_ENVIRONMENTS) {
		const id = newId(ID_PREFIXES.environment);
		await dbtx.insert(environment).values({ id, projectId, ...env });
		ids.push(id);
	}
	return ids;
}

/**
 * Create a project with its default environments. Slug collisions append
 * `-2`, `-3`, …; the unique index is the final arbiter.
 */
export async function createProject(
	dbtx: DbTx,
	opts: { workspaceId: string; name: string; slug?: string; description?: string | null }
): Promise<{ id: string; slug: string }> {
	let slug = opts.slug ?? slugify(opts.name);
	for (let n = 2; ; n++) {
		const [taken] = await dbtx
			.select({ id: project.id })
			.from(project)
			.where(eq(project.slug, slug))
			.limit(1);
		if (!taken) break;
		slug = `${slugify(opts.name)}-${n}`;
	}
	const id = newId(ID_PREFIXES.project);
	await dbtx.insert(project).values({
		id,
		workspaceId: opts.workspaceId,
		name: opts.name,
		slug,
		description: opts.description ?? null
	});
	await createDefaultEnvironments(dbtx, id);
	return { id, slug };
}

/**
 * Full new-workspace tree (PRD §44): workspace, owner membership on the
 * builtin `owner` role, `<Name>'s Project` + 3 environments, billing account.
 * Returns the ids so the caller can audit/redirect.
 */

export async function provisionWorkspace(
	dbtx: DbTx,
	opts: { name: string; ownerUserId: string; slug?: string }
): Promise<{
	workspaceId: string;
	projectId: string;
	environmentIds: string[];
	memberId: string;
	billingAccountId: string;
	slug: string;
}> {
	let slug = opts.slug ?? slugify(opts.name);
	for (let n = 2; ; n++) {
		const [taken] = await dbtx
			.select({ id: workspace.id })
			.from(workspace)
			.where(eq(workspace.slug, slug))
			.limit(1);
		if (!taken) break;
		slug = `${slugify(opts.name)}-${n}`;
	}
	const workspaceId = newId(ID_PREFIXES.workspace);
	await dbtx.insert(workspace).values({
		id: workspaceId,
		name: opts.name,
		slug,
		ownerUserId: opts.ownerUserId
	});
	// The builtin role templates are seeded rows (workspace_id NULL): look the
	// owner role up, never hardcode 'rol_owner' — 0007's backfill ids are a
	// migration detail.
	const ownerRole = await dbtx
		.select({ id: workspaceRole.id })
		.from(workspaceRole)
		.where(
			sql`${workspaceRole.workspaceId} IS NULL AND ${workspaceRole.name} = 'owner'`
		)
		.limit(1);
	if (!ownerRole.length) throw new Error('builtin owner workspace_role row is missing');
	const memberId = newId(ID_PREFIXES.workspaceMember);
	await dbtx.insert(workspaceMember).values({
		id: memberId,
		workspaceId,
		userId: opts.ownerUserId,
		roleId: ownerRole[0].id,
		status: 'active'
	});
	const { id: projectId } = await createProject(dbtx, {
		workspaceId,
		name: `${opts.name.split("'")[0]}'s Project`
	});
	const environmentIds = await dbtx
		.select({ id: environment.id })
		.from(environment)
		.where(eq(environment.projectId, projectId))
		.then((rows) => rows.map((r) => r.id));
	const billingAccountId = newId(ID_PREFIXES.billingAccount);
	await dbtx.insert(billingAccount).values({ id: billingAccountId, workspaceId });
	// The tree's creation is itself auditable (PRD §71), with the created ids
	// as metadata — before/after stay plain (audit redacts secret-looking keys).
	await writeAudit(dbtx, {
		actorUserId: opts.ownerUserId,
		action: 'workspace.create',
		resource: 'workspace',
		resourceId: workspaceId,
		workspaceId,
		after: { name: opts.name, slug },
		metadata: { projectId, billingAccountId, environmentIds }
	});
	return { workspaceId, projectId, environmentIds, memberId, billingAccountId, slug };
}

/**
 * Idempotent per-user provisioning (PRD §44): a user who somehow has no
 * workspace yet gets the full default tree on their next authenticated load.
 * Signup's Better Auth hook is the primary path; this is the backstop that
 * makes "every user has a workspace" unconditionally true.
 */
export async function ensureUserWorkspace(
	dbtx: DbTx,
	opts: { userId: string; name: string }
): Promise<{ workspaceId: string } | null> {
	const [existing] = await dbtx
		.select({ workspaceId: workspaceMember.workspaceId })
		.from(workspaceMember)
		.where(eq(workspaceMember.userId, opts.userId))
		.limit(1);
	if (existing) return { workspaceId: existing.workspaceId };
	const provisioned = await provisionWorkspace(dbtx, {
		name: `${opts.name.split("'")[0]}'s Workspace`,
		ownerUserId: opts.userId
	});
	return { workspaceId: provisioned.workspaceId };
}
