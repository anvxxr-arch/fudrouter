import { and, eq, inArray, or, type SQL } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { budget, environment } from '$lib/server/db/schema';
import { newId, ID_PREFIXES } from '$lib/server/id';
import { writeAudit } from '$lib/server/audit';
import { requireCap } from '$lib/server/roles';
import { parseMicros } from '$lib/money';
import { observeGate } from '$lib/server/observe/scope';
import { usageTotals } from '$lib/server/observe/usage-queries';
import {
	BUDGET_ACTIONS,
	BUDGET_PERIODS,
	BUDGET_PERIOD_LABELS,
	BUDGET_ACTION_LABELS,
	budgetPercent,
	budgetState,
	periodWindow,
	type BudgetAction,
	type BudgetPeriod
} from '$lib/server/observe/budgets';

/**
 * Budgets (PRD §40): daily/weekly/monthly rows per scope (this project and its
 * environments), each with warn/critical percentages and the action that fires
 * at 100%. Consumption is measured over the period's UTC window (PRD §120).
 */
export const load: PageServerLoad = async ({ locals, params }) => {
	requireCap(locals, 'member');
	const gate = await observeGate(locals, params.projectId, 'budget.read');
	const shell = {
		periods: BUDGET_PERIODS,
		actions: BUDGET_ACTIONS,
		periodLabels: BUDGET_PERIOD_LABELS,
		actionLabels: BUDGET_ACTION_LABELS,
		environments: [] as { id: string; name: string }[],
		budgets: [] as never[]
	};
	if (gate.denied) return { denied: true, queryError: null, projectId: params.projectId, ...shell };

	const envs = await db
		.select({ id: environment.id, name: environment.name })
		.from(environment)
		.where(eq(environment.projectId, gate.project.id))
		.orderBy(environment.name);
	const scopeIds = [gate.project.id, ...envs.map((e) => e.id)];
	const rows = await db
		.select()
		.from(budget)
		.where(
			or(
				inArray(budget.scopeId, scopeIds) as SQL,
				eq(budget.scopeId, gate.workspaceId)
			) as SQL
		);

	const now = new Date();
	try {
		const withConsumption = await Promise.all(
			rows.map(async (b) => {
				const window = periodWindow(b.period as BudgetPeriod, now);
				const scope =
					b.scope === 'environment'
						? { workspaceId: gate.workspaceId, projectId: gate.project.id, environmentId: b.scopeId }
						: { workspaceId: gate.workspaceId, projectId: b.scopeId === gate.workspaceId ? null : b.scopeId };
				const { totals } = await usageTotals(db, scope, window.from, window.to);
				const consumedMicro = totals.costMicro;
				return {
					id: b.id,
					scope: b.scope,
					scopeLabel: scopeName(b, gate.project.name, envs),
					period: b.period as BudgetPeriod,
					amountMicro: b.amountMicro.toString(),
					warnPercent: b.warnPercent,
					criticalPercent: b.criticalPercent,
					actionAt100: b.actionAt100 as BudgetAction,
					windowFrom: window.from.toISOString(),
					windowTo: window.to.toISOString(),
					consumedMicro: consumedMicro.toString(),
					percent: budgetPercent(consumedMicro, b.amountMicro),
					state: budgetState(consumedMicro, b.amountMicro, b.warnPercent, b.criticalPercent)
				};
			})
		);
		return {
			denied: false,
			queryError: null,
			projectId: gate.project.id,
			projectName: gate.project.name,
			...shell,
			environments: envs,
			budgets: withConsumption
		};
	} catch (err) {
		console.error('[budgets] load failed', err);
		return {
			denied: false,
			queryError: 'Budget consumption could not be computed.',
			projectId: gate.project.id,
			projectName: gate.project.name,
			...shell,
			environments: envs
		};
	}
};

function scopeName(
	b: { scope: string; scopeId: string },
	projectName: string,
	envs: { id: string; name: string }[]
): string {
	if (b.scope === 'project') return `${projectName} (project)`;
	if (b.scope === 'environment') {
		const env = envs.find((e) => e.id === b.scopeId);
		return `${env?.name ?? b.scopeId} (environment)`;
	}
	return `Workspace (all projects)`;
}

type BudgetForm = {
	scope: 'project' | 'environment';
	environmentId: string | null;
	period: BudgetPeriod;
	amountMicro: bigint;
	warnPercent: number;
	criticalPercent: number;
	actionAt100: BudgetAction;
};

function parseBudgetForm(form: FormData): { ok: true; value: BudgetForm } | { ok: false; error: string } {
	const scopeRaw = String(form.get('scope') ?? 'project');
	if (scopeRaw !== 'project' && scopeRaw !== 'environment') {
		return { ok: false, error: 'Scope must be project or environment' };
	}
	const environmentId = scopeRaw === 'environment' ? String(form.get('environmentId') ?? '').trim() : null;
	if (scopeRaw === 'environment' && !environmentId) return { ok: false, error: 'Pick an environment' };

	const period = String(form.get('period') ?? '') as BudgetPeriod;
	if (!(BUDGET_PERIODS as readonly string[]).includes(period)) {
		return { ok: false, error: 'Period must be daily, weekly or monthly' };
	}
	const amountMicro = parseMicros(String(form.get('amount') ?? ''));
	if (amountMicro == null || amountMicro <= 0n) {
		return { ok: false, error: 'Amount must be a positive amount like 25.00' };
	}
	const percent = (name: string, fallback: number): number | null => {
		const raw = String(form.get(name) ?? '').trim();
		if (!raw) return fallback;
		if (!/^\d{1,3}$/.test(raw)) return null;
		const n = Number(raw);
		return n >= 0 && n <= 100 ? n : null;
	};
	const warnPercent = percent('warnPercent', 70);
	const criticalPercent = percent('criticalPercent', 90);
	if (warnPercent == null || criticalPercent == null) {
		return { ok: false, error: 'Warn and critical must be whole percentages 0-100' };
	}
	if (criticalPercent < warnPercent) {
		return { ok: false, error: 'Critical must be at or above the warning percentage' };
	}
	const actionAt100 = String(form.get('actionAt100') ?? 'block') as BudgetAction;
	if (!(BUDGET_ACTIONS as readonly string[]).includes(actionAt100)) {
		return { ok: false, error: 'Action must be notify, restrict or block' };
	}
	return {
		ok: true,
		value: { scope: scopeRaw, environmentId, period, amountMicro, warnPercent, criticalPercent, actionAt100 }
	};
}

export const actions: Actions = {
	save: async ({ locals, request, params }) => {
		requireCap(locals, 'member');
		const gate = await observeGate(locals, params.projectId, 'budget.write');
		if (gate.denied) return fail(403, { error: 'You do not manage budgets for this project' });
		const form = await request.formData();
		const parsed = parseBudgetForm(form);
		if (!parsed.ok) return fail(400, { error: parsed.error });
		const v = parsed.value;

		if (v.scope === 'environment') {
			const [env] = await db
				.select({ id: environment.id })
				.from(environment)
				.where(eq(environment.id, v.environmentId as string));
			if (!env || !(await envBelongsToProject(env.id, gate.project.id))) {
				return fail(400, { error: 'Pick an environment of this project' });
			}
		}
		const scopeId = v.scope === 'project' ? gate.project.id : (v.environmentId as string);

		// One budget per (scope, scopeId, period) — the schema's unique index is
		// the contract, so save is an upsert and never a duplicate row.
		const [existing] = await db
			.select({ id: budget.id })
			.from(budget)
			.where(and(eq(budget.scope, v.scope), eq(budget.scopeId, scopeId), eq(budget.period, v.period)))
			.limit(1);
		const id = existing?.id ?? newId(ID_PREFIXES.budget);
		await db.transaction(async (tx) => {
			await tx
				.insert(budget)
				.values({
					id,
					scope: v.scope,
					scopeId,
					period: v.period,
					amountMicro: v.amountMicro,
					warnPercent: v.warnPercent,
					criticalPercent: v.criticalPercent,
					actionAt100: v.actionAt100
				})
				.onConflictDoUpdate({
					target: [budget.scope, budget.scopeId, budget.period],
					set: {
						amountMicro: v.amountMicro,
						warnPercent: v.warnPercent,
						criticalPercent: v.criticalPercent,
						actionAt100: v.actionAt100,
						updatedAt: new Date()
					}
				});
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: existing ? 'budget.update' : 'budget.create',
				resource: 'budget',
				resourceId: id,
				workspaceId: gate.workspaceId,
				after: {
					scope: v.scope,
					scopeId,
					period: v.period,
					amountMicro: v.amountMicro.toString(),
					warnPercent: v.warnPercent,
					criticalPercent: v.criticalPercent,
					actionAt100: v.actionAt100
				}
			});
		});
		return { saved: id };
	},
	remove: async ({ locals, request, params }) => {
		requireCap(locals, 'member');
		const gate = await observeGate(locals, params.projectId, 'budget.write');
		if (gate.denied) return fail(403, { error: 'You do not manage budgets for this project' });
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing budget id' });
		const scopeIds = await projectScopeIds(gate.project.id);
		const [row] = await db.select().from(budget).where(eq(budget.id, id)).limit(1);
		if (!row || !scopeIds.has(row.scopeId)) return fail(404, { error: 'Budget not found' });
		await db.transaction(async (tx) => {
			await tx.delete(budget).where(eq(budget.id, id));
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: 'budget.delete',
				resource: 'budget',
				resourceId: id,
				workspaceId: gate.workspaceId,
				before: { scope: row.scope, scopeId: row.scopeId, period: row.period }
			});
		});
		return { removed: id };
	}
};

async function envBelongsToProject(environmentId: string, projectId: string): Promise<boolean> {
	const ids = await projectScopeIds(projectId);
	return ids.has(environmentId);
}

/** The scope ids this project's budgets may live on: itself + its environments. */
async function projectScopeIds(projectId: string): Promise<Set<string>> {
	const envs = await db
		.select({ id: environment.id })
		.from(environment)
		.where(eq(environment.projectId, projectId));
	return new Set([projectId, ...envs.map((e) => e.id)]);
}
