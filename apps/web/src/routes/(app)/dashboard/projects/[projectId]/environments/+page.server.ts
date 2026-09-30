import { fail, redirect, error } from '@sveltejs/kit';
import { and, eq, or, sql } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { environment, project, rateLimit, routingPolicy } from '$lib/server/db/schema';
import { currentWorkspaceId, requireMemberPermission } from '$lib/server/rbac';
import { slugify } from '$lib/server/provision';
import { parseMicros, microsToInput } from '$lib/money';
import { newId, ID_PREFIXES } from '$lib/server/id';
import { writeAudit } from '$lib/server/audit';
import { requireCap } from '$lib/server/roles';
// Environments (PRD §23): the three defaults plus any custom ones, each with
// its routing policy, monthly budget and environment-scoped rate limits.
// A null/empty limit field means "inherit", stored as SQL NULL. The
// discriminated result avoids the `typeof null === 'object'` trap a bare
// `number | null | { error }` union would carry.
type LimitParse = { ok: true; value: number | null } | { ok: false; error: string };
function parseLimitInt(raw: FormDataEntryValue | null): LimitParse {
	const s = String(raw ?? '').trim();
	if (!s) return { ok: true, value: null };
	if (!/^\d+$/.test(s)) {
		return { ok: false, error: 'Rate limits must be whole numbers (or empty to inherit)' };
	}
	return { ok: true, value: Number(s) };
}
export const load: PageServerLoad = async ({ locals, params }) => {
	requireCap(locals, 'member');
	const workspaceId = await currentWorkspaceId(locals);
	if (!workspaceId) redirect(303, '/dashboard');
	await requireMemberPermission(locals, workspaceId, 'project.read');
	const [proj] = await db
		.select({ id: project.id, name: project.name })
		.from(project)
		.where(and(eq(project.id, params.projectId), eq(project.workspaceId, workspaceId)))
		.limit(1);
	if (!proj) error(404, 'Project not found');
	const envs = await db
		.select({
			id: environment.id,
			name: environment.name,
			slug: environment.slug,
			type: environment.type,
			status: environment.status,
			routingPolicyId: environment.routingPolicyId,
			routingPolicyName: routingPolicy.name,
			monthlyBudgetMicro: environment.monthlyBudgetMicro,
			rpm: rateLimit.rpm,
			tpm: rateLimit.tpm,
			concurrency: rateLimit.concurrency
		})
		.from(environment)
		.leftJoin(routingPolicy, eq(environment.routingPolicyId, routingPolicy.id))
		.leftJoin(
			rateLimit,
			and(eq(rateLimit.scope, 'environment'), eq(rateLimit.scopeId, environment.id))
		)
		.where(eq(environment.projectId, proj.id))
		.orderBy(environment.createdAt);
	const policies = await db
		.select({ id: routingPolicy.id, name: routingPolicy.name })
		.from(routingPolicy)
		.where(
			or(
				eq(routingPolicy.workspaceId, workspaceId),
				eq(routingPolicy.projectId, proj.id),
				sql`${routingPolicy.workspaceId} IS NULL AND ${routingPolicy.projectId} IS NULL AND ${routingPolicy.environmentId} IS NULL`
			)
		);
	return {
		project: proj,
		environments: envs.map((e) => ({
			...e,
			budgetInput: e.monthlyBudgetMicro === null ? '' : microsToInput(e.monthlyBudgetMicro)
		})),
		policies
	};
};
export const actions: Actions = {
	create: async ({ locals, request, params }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) redirect(303, '/dashboard');
		await requireMemberPermission(locals, workspaceId, 'project.write');
		const [proj] = await db
			.select({ id: project.id })
			.from(project)
			.where(and(eq(project.id, params.projectId), eq(project.workspaceId, workspaceId)))
			.limit(1);
		if (!proj) error(404, 'Project not found');
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		if (!name) return fail(400, { error: 'Environment name is required' });
		const envId = await db.transaction(async (tx) => {
			// Unique per project: collisions append -2, -3 like `createProject`.
			let slug = slugify(name);
			for (let n = 2; ; n++) {
				const [taken] = await tx
					.select({ id: environment.id })
					.from(environment)
					.where(and(eq(environment.projectId, proj.id), eq(environment.slug, slug)))
					.limit(1);
				if (!taken) break;
				slug = `${slugify(name)}-${n}`;
			}
			const id = newId(ID_PREFIXES.environment);
			await tx.insert(environment).values({
				id,
				projectId: proj.id,
				name,
				slug,
				type: 'custom',
				status: 'active'
			});
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: 'environment.create',
				resource: 'environment',
				resourceId: id,
				workspaceId,
				after: { name, slug, type: 'custom', status: 'active', projectId: proj.id }
			});
			return id;
		});
		return { created: name, environmentId: envId };
	},
	update: async ({ locals, request, params }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) redirect(303, '/dashboard');
		await requireMemberPermission(locals, workspaceId, 'project.write');
		const form = await request.formData();
		const envId = String(form.get('environmentId') ?? '').trim();
		const [env] = await db
			.select({
				id: environment.id,
				name: environment.name,
				routingPolicyId: environment.routingPolicyId,
				monthlyBudgetMicro: environment.monthlyBudgetMicro
			})
			.from(environment)
			.innerJoin(project, eq(project.id, environment.projectId))
			.where(
				and(
					eq(environment.id, envId),
					eq(environment.projectId, params.projectId),
					eq(project.workspaceId, workspaceId)
				)
			)
			.limit(1);
		if (!env) error(404, 'Environment not found');
		const policyInput = String(form.get('routing_policy_id') ?? '').trim();
		let routingPolicyId: string | null = null;
		if (policyInput) {
			const [policy] = await db
				.select({ id: routingPolicy.id })
				.from(routingPolicy)
				.where(
					and(
						eq(routingPolicy.id, policyInput),
						or(
							eq(routingPolicy.workspaceId, workspaceId),
							eq(routingPolicy.projectId, params.projectId),
							sql`${routingPolicy.workspaceId} IS NULL AND ${routingPolicy.projectId} IS NULL AND ${routingPolicy.environmentId} IS NULL`
						)
					)
				)
				.limit(1);
			if (!policy) return fail(400, { error: 'Unknown routing policy' });
			routingPolicyId = policy.id;
		}
		const budgetRaw = String(form.get('monthly_budget_micro') ?? '').trim();
		let monthlyBudgetMicro: bigint | null = null;
		if (budgetRaw) {
			monthlyBudgetMicro = parseMicros(budgetRaw);
			if (monthlyBudgetMicro === null) {
				return fail(400, { error: 'Monthly budget must be a plain decimal amount, e.g. 40 or 12.50' });
			}
		}
		const rpm = parseLimitInt(form.get('rpm'));
		const tpm = parseLimitInt(form.get('tpm'));
		const concurrency = parseLimitInt(form.get('concurrency'));
		if (!rpm.ok) return fail(400, { error: rpm.error });
		if (!tpm.ok) return fail(400, { error: tpm.error });
		if (!concurrency.ok) return fail(400, { error: concurrency.error });
		const [limits] = await db
			.select({ id: rateLimit.id, rpm: rateLimit.rpm, tpm: rateLimit.tpm, concurrency: rateLimit.concurrency })
			.from(rateLimit)
			.where(and(eq(rateLimit.scope, 'environment'), eq(rateLimit.scopeId, env.id)))
			.limit(1);
		await db.transaction(async (tx) => {
			await tx
				.update(environment)
				.set({ routingPolicyId, monthlyBudgetMicro, updatedAt: new Date() })
				.where(eq(environment.id, env.id));
			if (limits) {
				await tx
					.update(rateLimit)
					.set({ rpm: rpm.value, tpm: tpm.value, concurrency: concurrency.value, updatedAt: new Date() })
					.where(eq(rateLimit.id, limits.id));
			} else {
				await tx.insert(rateLimit).values({
					id: newId(ID_PREFIXES.rateLimit),
					scope: 'environment',
					scopeId: env.id,
					rpm: rpm.value,
					tpm: tpm.value,
					concurrency: concurrency.value
				});
			}
			// money is bigint; jsonb rows must not carry one (JSON.stringify throws).
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: 'environment.update',
				resource: 'environment',
				resourceId: env.id,
				workspaceId,
				before: {
					routingPolicyId: env.routingPolicyId,
					monthlyBudgetMicro: env.monthlyBudgetMicro === null ? null : env.monthlyBudgetMicro.toString(),
					rpm: limits?.rpm ?? null,
					tpm: limits?.tpm ?? null,
					concurrency: limits?.concurrency ?? null
				},
				after: {
					routingPolicyId,
					monthlyBudgetMicro: monthlyBudgetMicro === null ? null : monthlyBudgetMicro.toString(),
					rpm: rpm.value,
					tpm: tpm.value,
					concurrency: concurrency.value
				}
			});
		});
		return { saved: env.name };
	},
	enable: async ({ locals, request, params }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) redirect(303, '/dashboard');
		await requireMemberPermission(locals, workspaceId, 'project.write');
		return setEnvStatus(locals, workspaceId, params.projectId, request, 'active');
	},
	disable: async ({ locals, request, params }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) redirect(303, '/dashboard');
		await requireMemberPermission(locals, workspaceId, 'project.write');
		return setEnvStatus(locals, workspaceId, params.projectId, request, 'disabled');
	}
};
// Shared by enable/disable: one scoped lookup, one audit trail, one shape.
// NOT a route handler — the gate count rule counts handler shapes only.
async function setEnvStatus(
	locals: App.Locals,
	workspaceId: string,
	projectId: string,
	request: Request,
	status: 'active' | 'disabled'
) {
	const form = await request.formData();
	const envId = String(form.get('environmentId') ?? '').trim();
	const [env] = await db
		.select({ id: environment.id, name: environment.name, status: environment.status })
		.from(environment)
		.innerJoin(project, eq(project.id, environment.projectId))
		.where(
			and(
				eq(environment.id, envId),
				eq(environment.projectId, projectId),
				eq(project.workspaceId, workspaceId)
			)
		)
		.limit(1);
	if (!env) error(404, 'Environment not found');
	await db.transaction(async (tx) => {
		await tx
			.update(environment)
			.set({ status, updatedAt: new Date() })
			.where(eq(environment.id, env.id));
		await writeAudit(tx, {
			actorUserId: locals.user!.id,
			action: status === 'active' ? 'environment.enable' : 'environment.disable',
			resource: 'environment',
			resourceId: env.id,
			workspaceId,
			before: { status: env.status },
			after: { status }
		});
	});
	return status === 'active' ? { enabled: env.name } : { disabled: env.name };
}
