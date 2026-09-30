import { error, fail } from '@sveltejs/kit';
import { and, asc, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { environment, model, project, provider, routingPolicy } from '$lib/server/db/schema';
import { currentWorkspaceId, requireMemberPermission } from '$lib/server/rbac';
import { writeAudit } from '$lib/server/audit';
import { bumpVersion } from '$lib/server/vk';
import { ID_PREFIXES, newId } from '$lib/server/id';
import { STRATEGIES, parsePolicyForm, type ParsedPolicy } from '$lib/routing-form';
import { requireCap } from '$lib/server/roles';
/** Policy scope as the form posts it. Environment-scoped rows are preserved on
 *  update (created by the environments page), never minted here (PRD §32). */
type PolicyScope = 'project' | 'workspace' | 'environment';
export interface PolicyRow {
	id: string;
	name: string;
	strategy: string;
	enabled: boolean;
	maxAttempts: number;
	requestTimeoutMs: number;
	fallbackEnabled: boolean;
	scope: PolicyScope;
	providerPreferences: Record<string, unknown>;
	modelPreferences: Record<string, unknown>;
	constraints: Record<string, unknown>;
	weights: Record<string, unknown>;
	boundEnvironments: string[];
}
export interface BindingRow {
	environmentId: string;
	environmentName: string;
	policyId: string | null;
	policyName: string | null;
}
/** The project this page is scoped to, or 404 — params alone never authorize. */
async function requireProject(params: { projectId: string }, workspaceId: string) {
	const [proj] = await db
		.select({ id: project.id, name: project.name, slug: project.slug })
		.from(project)
		.where(and(eq(project.id, params.projectId), eq(project.workspaceId, workspaceId)))
		.limit(1);
	if (!proj) error(404, 'Project not found');
	return proj;
}
/**
 * The policies visible to a project (spec §9): its own, the workspace's, and any
 * bound to one of its environments. The same predicate guards update/delete, so
 * an id alone never edits a policy this page would not have shown.
 */
function visibleWhere(projectId: string, workspaceId: string, envIds: string[]) {
	return or(
		eq(routingPolicy.projectId, projectId),
		and(eq(routingPolicy.workspaceId, workspaceId), isNull(routingPolicy.projectId)),
		envIds.length > 0 ? inArray(routingPolicy.environmentId, envIds) : sql`false`
	);
}
function scopeField(form: FormData, allowEnvironment: boolean): PolicyScope | { error: string } {
	const raw = String(form.get('scope') ?? '');
	if (raw === 'project' || raw === 'workspace') return raw;
	if (allowEnvironment && raw === 'environment') return raw;
	return { error: 'Scope must be project or workspace' };
}
/** Name collisions are scoped (spec §9): two scopes may share a policy name. */
async function collisionScope(
	scope: PolicyScope,
	name: string,
	projectId: string,
	workspaceId: string,
	environmentId: string | null,
	excludeId: string | null
) {
	const scopeClause =
		scope === 'project'
			? and(eq(routingPolicy.projectId, projectId), isNull(routingPolicy.environmentId))
			: scope === 'workspace'
				? and(
						eq(routingPolicy.workspaceId, workspaceId),
						isNull(routingPolicy.projectId),
						isNull(routingPolicy.environmentId)
					)
				: eq(routingPolicy.environmentId, environmentId ?? '');
	const where = excludeId
		? and(scopeClause, eq(routingPolicy.name, name), ne(routingPolicy.id, excludeId))
		: and(scopeClause, eq(routingPolicy.name, name));
	const [hit] = await db
		.select({ id: routingPolicy.id })
		.from(routingPolicy)
		.where(where)
		.limit(1);
	return hit ?? null;
}
/** The values one policy stores — exactly what the audit entry and the write carry. */
function rowValues(value: ParsedPolicy, scope: PolicyScope) {
	return {
		name: value.name,
		strategy: value.strategy,
		enabled: value.enabled,
		maxAttempts: value.maxAttempts,
		requestTimeoutMs: value.requestTimeoutMs,
		fallbackEnabled: value.fallbackEnabled,
		providerPreferences: value.providerPreferences,
		modelPreferences: value.modelPreferences,
		constraints: value.constraints,
		weights: value.weights,
		scope
	};
}
export const load: PageServerLoad = async ({ locals, params }) => {
	// The hook gates this route; this is the second layer, as on /admin.
	requireCap(locals, 'member');
	const workspaceId = await currentWorkspaceId(locals);
	if (!workspaceId) error(404, 'Project not found');
	await requireMemberPermission(locals, workspaceId, 'routing.read');
	const proj = await requireProject(params, workspaceId);
	const [envs, providerOpts, modelOpts] = await Promise.all([
		db
			.select({
				id: environment.id,
				name: environment.name,
				routingPolicyId: environment.routingPolicyId
			})
			.from(environment)
			.where(eq(environment.projectId, proj.id))
			.orderBy(asc(environment.createdAt)),
		db
			.select({ slug: provider.slug, name: provider.name })
			.from(provider)
			.where(isNotNull(provider.slug))
			.orderBy(asc(provider.slug)),
		db
			.select({ slug: model.slug, name: model.name })
			.from(model)
			.where(isNotNull(model.slug))
			.orderBy(asc(model.slug))
	]);
	const envIds = envs.map((e) => e.id);
	const rows = await db
		.select({
			id: routingPolicy.id,
			name: routingPolicy.name,
			strategy: routingPolicy.strategy,
			enabled: routingPolicy.enabled,
			maxAttempts: routingPolicy.maxAttempts,
			requestTimeoutMs: routingPolicy.requestTimeoutMs,
			fallbackEnabled: routingPolicy.fallbackEnabled,
			workspaceId: routingPolicy.workspaceId,
			projectId: routingPolicy.projectId,
			environmentId: routingPolicy.environmentId,
			providerPreferences: routingPolicy.providerPreferences,
			modelPreferences: routingPolicy.modelPreferences,
			constraints: routingPolicy.constraints,
			weights: routingPolicy.weights
		})
		.from(routingPolicy)
		.where(visibleWhere(proj.id, workspaceId, envIds))
		.orderBy(asc(routingPolicy.name));
	const boundNames = new Map<string, string[]>();
	for (const e of envs) {
		if (!e.routingPolicyId) continue;
		const list = boundNames.get(e.routingPolicyId) ?? [];
		list.push(e.name);
		boundNames.set(e.routingPolicyId, list);
	}
	const policies: PolicyRow[] = rows.map((r) => ({
		id: r.id,
		name: r.name,
		strategy: r.strategy,
		enabled: r.enabled,
		maxAttempts: r.maxAttempts,
		requestTimeoutMs: r.requestTimeoutMs,
		fallbackEnabled: r.fallbackEnabled,
		scope: r.environmentId ? 'environment' : r.projectId ? 'project' : 'workspace',
		providerPreferences: r.providerPreferences,
		modelPreferences: r.modelPreferences,
		constraints: r.constraints,
		weights: r.weights,
		boundEnvironments: boundNames.get(r.id) ?? []
	}));
	const policyNameById = new Map(rows.map((r) => [r.id, r.name]));
	// The binding section is READ-ONLY here — the link itself is edited on the
	// environments page (one writer per fact).
	const bindings: BindingRow[] = envs.map((e) => ({
		environmentId: e.id,
		environmentName: e.name,
		policyId: e.routingPolicyId,
		policyName: e.routingPolicyId ? (policyNameById.get(e.routingPolicyId) ?? null) : null
	}));
	return {
		project: proj,
		policies,
		bindings,
		strategies: STRATEGIES,
		providers: providerOpts,
		models: modelOpts
	};
};
export const actions: Actions = {
	create: async ({ locals, request, params }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) error(404, 'Project not found');
		await requireMemberPermission(locals, workspaceId, 'routing.write');
		const form = await request.formData();
		const parsed = parsePolicyForm((k) => form.get(k));
		if (!parsed.ok) return fail(400, { error: parsed.error });
		const scopeResult = scopeField(form, false);
		// typeof narrows (not `in`): PolicyScope is a string union, and `in`
		// demands an object right-hand side.
		if (typeof scopeResult !== 'string') return fail(400, { error: scopeResult.error });
		const scope = scopeResult;
		await requireProject(params, workspaceId);
		const hit = await collisionScope(scope, parsed.values.name, params.projectId, workspaceId, null, null);
		if (hit) {
			return fail(409, {
				error: `A policy named “${parsed.values.name}” already exists in this ${scope}.`
			});
		}
		const policyId = newId(ID_PREFIXES.routingPolicy);
		const values = rowValues(parsed.values, scope);
		await db.transaction(async (tx) => {
			await tx.insert(routingPolicy).values({
				id: policyId,
				workspaceId,
				projectId: scope === 'project' ? params.projectId : null,
				environmentId: null,
				name: values.name,
				strategy: values.strategy,
				enabled: values.enabled,
				maxAttempts: values.maxAttempts,
				requestTimeoutMs: values.requestTimeoutMs,
				fallbackEnabled: values.fallbackEnabled,
				providerPreferences: values.providerPreferences,
				modelPreferences: values.modelPreferences,
				constraints: values.constraints as unknown as Record<string, unknown>,
				weights: values.weights as unknown as Record<string, unknown>
			});
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: 'routing.create',
				resource: 'routing_policy',
				resourceId: policyId,
				workspaceId,
				after: values
			});
		});
		await bumpVersion('routing_policy');
		return { created: values.name };
	},
	update: async ({ locals, request, params }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) error(404, 'Project not found');
		await requireMemberPermission(locals, workspaceId, 'routing.write');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing policy id' });
		const proj = await requireProject(params, workspaceId);
		const envIds = (
			await db
				.select({ id: environment.id })
				.from(environment)
				.where(eq(environment.projectId, proj.id))
		).map((e) => e.id);
		const [existing] = await db
			.select({
				id: routingPolicy.id,
				name: routingPolicy.name,
				strategy: routingPolicy.strategy,
				enabled: routingPolicy.enabled,
				maxAttempts: routingPolicy.maxAttempts,
				requestTimeoutMs: routingPolicy.requestTimeoutMs,
				fallbackEnabled: routingPolicy.fallbackEnabled,
				workspaceId: routingPolicy.workspaceId,
				projectId: routingPolicy.projectId,
				environmentId: routingPolicy.environmentId,
				providerPreferences: routingPolicy.providerPreferences,
				modelPreferences: routingPolicy.modelPreferences,
				constraints: routingPolicy.constraints,
				weights: routingPolicy.weights
			})
			.from(routingPolicy)
			.where(and(eq(routingPolicy.id, id), visibleWhere(proj.id, workspaceId, envIds)))
			.limit(1);
		if (!existing) return fail(404, { error: 'Policy not found' });
		const parsed = parsePolicyForm((k) => form.get(k));
		if (!parsed.ok) return fail(400, { error: parsed.error });
		const scopeResult = scopeField(form, true);
		if (typeof scopeResult !== 'string') return fail(400, { error: scopeResult.error });
		const scope = scopeResult;
		// Environment scope is only a statement about an environment-bound row
		// (created on the environments page); it cannot be granted to a
		// project/workspace policy through this form.
		if (scope === 'environment' && !existing.environmentId) {
			return fail(400, { error: 'Scope must be project or workspace' });
		}
		const environmentId = scope === 'environment' ? existing.environmentId : null;
		const hit = await collisionScope(
			scope,
			parsed.values.name,
			params.projectId,
			workspaceId,
			environmentId,
			id
		);
		if (hit) {
			return fail(409, {
				error: `A policy named “${parsed.values.name}” already exists in this ${scope}.`
			});
		}
		const before = rowValues(
			{
				name: existing.name,
				strategy: existing.strategy as ParsedPolicy['strategy'],
				enabled: existing.enabled,
				maxAttempts: existing.maxAttempts,
				requestTimeoutMs: existing.requestTimeoutMs,
				fallbackEnabled: existing.fallbackEnabled,
				providerPreferences: existing.providerPreferences as ParsedPolicy['providerPreferences'],
				modelPreferences: existing.modelPreferences as ParsedPolicy['modelPreferences'],
				constraints: existing.constraints as ParsedPolicy['constraints'],
				weights: existing.weights as ParsedPolicy['weights']
			},
			existing.environmentId ? 'environment' : existing.projectId ? 'project' : 'workspace'
		);
		const values = rowValues(parsed.values, scope);
		await db.transaction(async (tx) => {
			await tx
				.update(routingPolicy)
				.set({
					workspaceId,
					projectId: scope === 'project' ? params.projectId : null,
					environmentId,
					name: values.name,
					strategy: values.strategy,
					enabled: values.enabled,
					maxAttempts: values.maxAttempts,
					requestTimeoutMs: values.requestTimeoutMs,
					fallbackEnabled: values.fallbackEnabled,
					providerPreferences: values.providerPreferences,
					modelPreferences: values.modelPreferences,
					constraints: values.constraints as unknown as Record<string, unknown>,
					weights: values.weights as unknown as Record<string, unknown>,
					updatedAt: new Date()
				})
				.where(eq(routingPolicy.id, id));
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: 'routing.update',
				resource: 'routing_policy',
				resourceId: id,
				workspaceId,
				before,
				after: values
			});
		});
		await bumpVersion('routing_policy');
		return { updated: values.name };
	},
	delete: async ({ locals, request, params }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) error(404, 'Project not found');
		await requireMemberPermission(locals, workspaceId, 'routing.write');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing policy id' });
		const proj = await requireProject(params, workspaceId);
		const envIds = (
			await db
				.select({ id: environment.id })
				.from(environment)
				.where(eq(environment.projectId, proj.id))
		).map((e) => e.id);
		const [existing] = await db
			.select({
				id: routingPolicy.id,
				name: routingPolicy.name,
				strategy: routingPolicy.strategy,
				enabled: routingPolicy.enabled,
				maxAttempts: routingPolicy.maxAttempts,
				requestTimeoutMs: routingPolicy.requestTimeoutMs,
				fallbackEnabled: routingPolicy.fallbackEnabled,
				workspaceId: routingPolicy.workspaceId,
				projectId: routingPolicy.projectId,
				environmentId: routingPolicy.environmentId,
				providerPreferences: routingPolicy.providerPreferences,
				modelPreferences: routingPolicy.modelPreferences,
				constraints: routingPolicy.constraints,
				weights: routingPolicy.weights
			})
			.from(routingPolicy)
			.where(and(eq(routingPolicy.id, id), visibleWhere(proj.id, workspaceId, envIds)))
			.limit(1);
		if (!existing) return fail(404, { error: 'Policy not found' });
		const before = rowValues(
			{
				name: existing.name,
				strategy: existing.strategy as ParsedPolicy['strategy'],
				enabled: existing.enabled,
				maxAttempts: existing.maxAttempts,
				requestTimeoutMs: existing.requestTimeoutMs,
				fallbackEnabled: existing.fallbackEnabled,
				providerPreferences: existing.providerPreferences as ParsedPolicy['providerPreferences'],
				modelPreferences: existing.modelPreferences as ParsedPolicy['modelPreferences'],
				constraints: existing.constraints as ParsedPolicy['constraints'],
				weights: existing.weights as ParsedPolicy['weights']
			},
			existing.environmentId ? 'environment' : existing.projectId ? 'project' : 'workspace'
		);
		await db.transaction(async (tx) => {
			// environment.routing_policy_id is ON DELETE SET NULL, so a delete
			// silently unbinds — the audit row is the record of what was bound.
			const bound = await tx
				.select({ name: environment.name })
				.from(environment)
				.where(eq(environment.routingPolicyId, id));
			await tx.delete(routingPolicy).where(eq(routingPolicy.id, id));
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: 'routing.delete',
				resource: 'routing_policy',
				resourceId: id,
				workspaceId,
				before: { ...before, unboundEnvironments: bound.map((b) => b.name) }
			});
		});
		await bumpVersion('routing_policy');
		return { deleted: existing.name };
	}
};
