import { fail } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { requireCap } from '$lib/server/roles';
import { writeAudit } from '$lib/server/audit';
import { db } from '$lib/server/db';
import { environment, project, routingPolicy, workspace } from '$lib/server/db/schema';
import { newId, ID_PREFIXES } from '$lib/server/id';
import { SIM_STRATEGIES, type SimStrategy } from '$lib/server/admin-simulate';
import {
	cleanField,
	parseIntField,
	parseBoolField,
	parseEnum,
	parseJsonField
} from '$lib/server/admin-vocab';

/** Policy scope: all three columns NULL = platform-scope (spec §9). */
const SCOPES = ['platform', 'workspace', 'project', 'environment'] as const;
type Scope = (typeof SCOPES)[number];

export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'admin.ops');
	const policies = await db.select().from(routingPolicy).orderBy(routingPolicy.name);
	const [workspaces, projects, envs] = await Promise.all([
		db.select({ id: workspace.id, name: workspace.name }).from(workspace).orderBy(workspace.name),
		db.select({ id: project.id, name: project.name }).from(project).orderBy(project.name),
		db
			.select({ id: environment.id, name: environment.name, projectId: environment.projectId })
			.from(environment)
			.orderBy(environment.name)
	]);
	return {
		policies,
		workspaces,
		projects,
		environments: envs,
		strategies: SIM_STRATEGIES as readonly string[],
		scopes: SCOPES as readonly string[]
	};
};

interface ScopeIds {
	workspaceId: string | null;
	projectId: string | null;
	environmentId: string | null;
}

/** The editable fields of a `routing_policy` row, already validated. */
interface PolicyPatch {
	name: string;
	strategy: string;
	enabled: boolean;
	maxAttempts: number;
	requestTimeoutMs: number;
	fallbackEnabled: boolean;
	providerPreferences: Record<string, unknown>;
	modelPreferences: Record<string, unknown>;
	constraints: Record<string, unknown>;
	weights: Record<string, unknown>;
}

/** Validate the scope pick and map it to the three nullable columns. */
async function resolveScope(scope: Scope | null, scopeId: string): Promise<ScopeIds | null> {
	const empty: ScopeIds = { workspaceId: null, projectId: null, environmentId: null };
	if (scope === 'platform') return empty;
	if (!scope || !scopeId) return null;
	if (scope === 'workspace') {
		const [row] = await db.select({ id: workspace.id }).from(workspace).where(eq(workspace.id, scopeId)).limit(1);
		return row ? { ...empty, workspaceId: row.id } : null;
	}
	if (scope === 'project') {
		const [row] = await db.select({ id: project.id }).from(project).where(eq(project.id, scopeId)).limit(1);
		return row ? { ...empty, projectId: row.id } : null;
	}
	const [row] = await db
		.select({ id: environment.id })
		.from(environment)
		.where(eq(environment.id, scopeId))
		.limit(1);
	return row ? { ...empty, environmentId: row.id } : null;
}

function jsonPatch(
	form: FormData
): Pick<PolicyPatch, 'providerPreferences' | 'modelPreferences' | 'constraints' | 'weights'> | { error: string } {
	const providerPreferences = parseJsonField(form.get('providerPreferences'));
	if (providerPreferences === null) return { error: 'providerPreferences must be a JSON object' };
	const modelPreferences = parseJsonField(form.get('modelPreferences'));
	if (modelPreferences === null) return { error: 'modelPreferences must be a JSON object' };
	const constraints = parseJsonField(form.get('constraints'));
	if (constraints === null) return { error: 'constraints must be a JSON object' };
	const weights = parseJsonField(form.get('weights'));
	if (weights === null) return { error: 'weights must be a JSON object' };
	return { providerPreferences, modelPreferences, constraints, weights };
}

function policyValues(form: FormData): { values: PolicyPatch } | { error: string } {
	const name = cleanField(form.get('name'));
	if (!name) return { error: 'Name is required' };
	const strategy = parseEnum(SIM_STRATEGIES as readonly string[], form.get('strategy'));
	if (!strategy) return { error: 'Invalid strategy' };
	const maxAttempts = parseIntField(form.get('maxAttempts'), { min: 1, max: 10 });
	if (maxAttempts === null) return { error: 'max_attempts must be 1–10' };
	const requestTimeoutMs = parseIntField(form.get('requestTimeoutMs'), { min: 1, max: 600_000 });
	if (requestTimeoutMs === null) return { error: 'request_timeout_ms must be 1–600000' };
	const json = jsonPatch(form);
	if ('error' in json) return json;
	return {
		values: {
			name,
			strategy: strategy as SimStrategy,
			enabled: parseBoolField(form.get('enabled')),
			maxAttempts,
			requestTimeoutMs,
			fallbackEnabled: parseBoolField(form.get('fallbackEnabled')),
			...json
		}
	};
}

function slimPolicy(p: Record<string, unknown>): Record<string, unknown> {
	// JSON prefs go to audit as a size-capped copy; the row itself is small.
	return {
		id: p.id,
		name: p.name,
		strategy: p.strategy,
		enabled: p.enabled,
		maxAttempts: p.maxAttempts,
		requestTimeoutMs: p.requestTimeoutMs,
		fallbackEnabled: p.fallbackEnabled,
		workspaceId: p.workspaceId ?? null,
		projectId: p.projectId ?? null,
		environmentId: p.environmentId ?? null
	};
}

export const actions: Actions = {
	create: async ({ locals, request }) => {
		requireCap(locals, 'admin.ops');
		const form = await request.formData();
		const parsed = policyValues(form);
		if ('error' in parsed) return fail(400, parsed);
		const scope = parseEnum(SCOPES as readonly string[], form.get('scope')) as Scope | null;
		const scopeIds = await resolveScope(scope, String(form.get('scopeId') ?? '').trim());
		if (!scopeIds) return fail(400, { error: 'Invalid scope or scope id' });
		const id = newId(ID_PREFIXES.routingPolicy);
		const row: typeof routingPolicy.$inferInsert = { id, ...scopeIds, ...parsed.values };
		try {
			await db.transaction(async (tx) => {
				await tx.insert(routingPolicy).values(row);
				await writeAudit(tx, {
					actorUserId: locals.user?.id ?? null,
					action: 'routing_policy.create',
					resource: 'routing_policy',
					resourceId: id,
					before: null,
					after: slimPolicy(row as Record<string, unknown>)
				});
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'insert failed';
			return fail(400, { error: `Could not create policy: ${msg}` });
		}
		return { created: parsed.values.name };
	},
	update: async ({ locals, request }) => {
		requireCap(locals, 'admin.ops');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing policy id' });
		const parsed = policyValues(form);
		if ('error' in parsed) return fail(400, parsed);
		const scope = parseEnum(SCOPES as readonly string[], form.get('scope')) as Scope | null;
		const scopeIds = await resolveScope(scope, String(form.get('scopeId') ?? '').trim());
		if (!scopeIds) return fail(400, { error: 'Invalid scope or scope id' });
		const patch: Partial<typeof routingPolicy.$inferInsert> = {
			...parsed.values,
			...scopeIds
		};
		try {
			const updated = await db.transaction(async (tx) => {
				const [before] = await tx
					.select()
					.from(routingPolicy)
					.where(eq(routingPolicy.id, id))
					.limit(1);
				if (!before) return null;
				await tx.update(routingPolicy).set(patch).where(eq(routingPolicy.id, id));
				await writeAudit(tx, {
					actorUserId: locals.user?.id ?? null,
					action: 'routing_policy.update',
					resource: 'routing_policy',
					resourceId: id,
					before: slimPolicy(before as unknown as Record<string, unknown>),
					after: slimPolicy({ ...before, ...(patch as object) })
				});
				return before;
			});
			if (!updated) return fail(404, { error: 'Policy not found' });
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'update failed';
			return fail(400, { error: `Could not update policy: ${msg}` });
		}
		return { updated: id };
	},
	delete: async ({ locals, request }) => {
		requireCap(locals, 'admin.ops');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing policy id' });
		try {
			const deleted = await db.transaction(async (tx) => {
				const [before] = await tx
					.select()
					.from(routingPolicy)
					.where(eq(routingPolicy.id, id))
					.limit(1);
				if (!before) return false;
				await tx.delete(routingPolicy).where(eq(routingPolicy.id, id));
				await writeAudit(tx, {
					actorUserId: locals.user?.id ?? null,
					action: 'routing_policy.delete',
					resource: 'routing_policy',
					resourceId: id,
					before: slimPolicy(before as unknown as Record<string, unknown>),
					after: null
				});
				return true;
			});
			if (!deleted) return fail(404, { error: 'Policy not found' });
		} catch {
			// environment.routing_policy_id is SET NULL on delete; anything else
			// referencing a policy keeps it alive.
			return fail(409, { error: 'Policy is referenced — detach it instead' });
		}
		return { deleted: id };
	}
};
