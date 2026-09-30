import type { Actions, PageServerLoad } from './$types';
import { fail } from '@sveltejs/kit';
import { and, eq, or, type SQL } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { apiKey, environment, rateLimit } from '$lib/server/db/schema';
import { newId, ID_PREFIXES } from '$lib/server/id';
import { writeAudit } from '$lib/server/audit';
import { requireCap } from '$lib/server/roles';
import { microsToInput, parseMicros } from '$lib/money';
import { getSetting } from '$lib/server/settings';
import { observeGate } from '$lib/server/observe/scope';
import {
	effectiveLimits,
	isSpendMetric,
	NO_LIMITS,
	LIMIT_LABELS,
	LIMIT_LEVEL_LABELS,
	type LimitChainEntry,
	type LimitLevel,
	type LimitValues
} from '$lib/server/observe/limits';

/**
 * Limits (PRD §41): edit `rate_limit` rows per scope (workspace/project/
 * environment) and show the effective chain (platform → workspace → project →
 * environment → api_key) with the level that binds (spec §7).
 *
 * Platform defaults come from `system_setting['platform_hard_limits']` — read
 * only here (platform settings are the admin surface's). A blank form field is
 * NULL = inherit (spec §7): a level may tighten, never widen the chain.
 */
export const load: PageServerLoad = async ({ locals, params }) => {
	requireCap(locals, 'member');
	const gate = await observeGate(locals, params.projectId, 'limit.read');
	const shell = {
		labels: LIMIT_LABELS,
		levelLabels: LIMIT_LEVEL_LABELS
	};
	if (gate.denied) return { denied: true, queryError: null, projectId: params.projectId, ...shell, chain: [], editors: [], keyRows: [] };

	const [envs, keys, hard, rows] = await Promise.all([
		db
			.select({ id: environment.id, name: environment.name })
			.from(environment)
			.where(eq(environment.projectId, gate.project.id))
			.orderBy(environment.name),
		db
			.select({ id: apiKey.id, name: apiKey.name, prefix: apiKey.prefix })
			.from(apiKey)
			.where(eq(apiKey.projectId, gate.project.id))
			.orderBy(apiKey.name),
		getSetting('platform_hard_limits'),
		db
			.select()
			.from(rateLimit)
			.where(
				or(
					eq(rateLimit.scope, 'workspace'),
					eq(rateLimit.scope, 'project'),
					eq(rateLimit.scope, 'environment'),
					eq(rateLimit.scope, 'api_key')
				) as SQL
			)
	]);

	const envIds = new Set(envs.map((e) => e.id));
	const keyIds = new Set(keys.map((k) => k.id));
	const workspaceRow = rows.find((r) => r.scope === 'workspace' && r.scopeId === gate.workspaceId) ?? null;
	const projectRow = rows.find((r) => r.scope === 'project' && r.scopeId === gate.project.id) ?? null;
	const envRows = rows.filter((r) => r.scope === 'environment' && envIds.has(r.scopeId));
	const keyLimitRows = rows.filter((r) => r.scope === 'api_key' && keyIds.has(r.scopeId));

	// The chain: platform hard limits (settings) then the scopes. Environments
	// and keys are FOLDED to their tightest value per metric — a project has N of
	// each — and every real row is listed below the chain so "edit there" is a
	// concrete form, not a guess.
	const chain: LimitChainEntry[] = [
		{ level: 'platform', values: platformValues(hard) },
		{ level: 'workspace', values: valuesOf(workspaceRow) },
		{ level: 'project', values: valuesOf(projectRow) },
		{ level: 'environment', values: tightest(envRows.map(valuesOf)) },
		{ level: 'api_key', values: tightest(keyLimitRows.map(valuesOf)) }
	];
	const resolved = effectiveLimits(chain).map((l) => ({
		metric: l.metric,
		label: LIMIT_LABELS[l.metric],
		spend: isSpendMetric(l.metric),
		// Spend metrics are bigint micro-units; the page shows plain amounts
		// (the same text a form takes), so format them HERE before the value
		// reaches the form.
		effective: l.effective == null ? null : isSpendMetric(l.metric) ? microsToInput(l.effective as bigint) : String(l.effective),
		boundAt: l.boundAt,
		boundAtLabel: l.boundAt ? LIMIT_LEVEL_LABELS[l.boundAt] : null,
		byLevel: Object.fromEntries(
			Object.entries(l.byLevel).map(([lvl, v]) => [
				lvl,
				v == null ? null : isSpendMetric(l.metric) ? microsToInput(v as bigint) : String(v)
			])
		)
	}));

	return {
		denied: false,
		queryError: null,
		projectId: gate.project.id,
		projectName: gate.project.name,
		...shell,
		chain: resolved,
		editors: [
			editorView('workspace', gate.workspaceId, 'Workspace (all projects)', workspaceRow),
			editorView('project', gate.project.id, `${gate.project.name} (project)`, projectRow),
			...envs.map((e) => editorView('environment', e.id, `${e.name} (environment)`, envRows.find((r) => r.scopeId === e.id) ?? null))
		],
		keyRows: keys.map((k) => ({
			id: k.id,
			name: k.name ?? k.prefix ?? k.id,
			values: viewValues(valuesOf(keyLimitRows.find((r) => r.scopeId === k.id) ?? null))
		}))
	};
};

/** The editable form state for one scope row (or inherit-everything). */
function editorView(scope: 'workspace' | 'project' | 'environment', scopeId: string, label: string, row: typeof rateLimit.$inferSelect | null) {
	return { scope, scopeId, label, row: row ? { id: row.id, values: viewValues(valuesOf(row)) } : null };
}

function viewValues(v: LimitValues): Record<string, string> {
	return {
		rpm: v.rpm == null ? '' : String(v.rpm),
		tpm: v.tpm == null ? '' : String(v.tpm),
		rpd: v.rpd == null ? '' : String(v.rpd),
		tpd: v.tpd == null ? '' : String(v.tpd),
		concurrency: v.concurrency == null ? '' : String(v.concurrency),
		// Spend metrics leave as PLAIN amounts ("12.5"), the text the form takes
		// back — never raw bigints over the wire.
		dailySpendMicro: v.dailySpendMicro == null ? '' : microsToInput(v.dailySpendMicro),
		monthlySpendMicro: v.monthlySpendMicro == null ? '' : microsToInput(v.monthlySpendMicro)
	};
}

function valuesOf(row: typeof rateLimit.$inferSelect | null): LimitValues {
	if (!row) return { ...NO_LIMITS };
	return {
		rpm: row.rpm,
		tpm: row.tpm,
		rpd: row.rpd,
		tpd: row.tpd,
		concurrency: row.concurrency,
		dailySpendMicro: row.dailySpendMicro,
		monthlySpendMicro: row.monthlySpendMicro
	};
}

function platformValues(hard: { rpm: number; tpm: number; concurrency: number } | null): LimitValues {
	if (!hard) return { ...NO_LIMITS };
	return { ...NO_LIMITS, rpm: hard.rpm, tpm: hard.tpm, concurrency: hard.concurrency };
}

/** Tightest value per metric across several scope rows; NULL ignores (inherit). */
function tightest(values: LimitValues[]): LimitValues {
	const out: LimitValues = { ...NO_LIMITS };
	for (const v of values) {
		for (const metric of Object.keys(NO_LIMITS) as (keyof LimitValues)[]) {
			const value = v[metric];
			if (value == null) continue;
			const current = out[metric];
			if (current == null || (value as bigint) < (current as bigint)) out[metric] = value as never;
		}
	}
	return out;
}

type LimitForm = { ok: true; values: LimitValues } | { ok: false; error: string };

/** One scope's form: a blank field is NULL (inherit), never zero. */
function parseLimitForm(form: FormData): LimitForm {
	const out: LimitValues = { ...NO_LIMITS };
	const count = (name: keyof LimitValues): string | null => {
		const raw = String(form.get(name) ?? '').trim();
		if (!raw) return null;
		if (!/^\d{1,12}$/.test(raw)) return `${name} must be a whole number`;
		out[name] = Number(raw) as never;
		return null;
	};
	for (const name of ['rpm', 'tpm', 'rpd', 'tpd', 'concurrency'] as const) {
		const err = count(name);
		if (err) return { ok: false, error: err };
	}
	for (const [name, label] of [
		['dailySpendMicro', 'Daily spend'],
		['monthlySpendMicro', 'Monthly spend']
	] as const) {
		const raw = String(form.get(name) ?? '').trim();
		if (!raw) continue;
		const micros = parseMicros(raw);
		if (micros == null) return { ok: false, error: `${label} must be a plain amount like 12.50` };
		out[name] = micros;
	}
	return { ok: true, values: out };
}

/** Which scopes this project may edit: workspace, its project, its environments. */
async function editableScope(form: FormData, workspaceId: string, projectId: string): Promise<
	{ ok: true; scope: 'workspace' | 'project' | 'environment'; scopeId: string } | { ok: false; error: string }
> {
	const scope = String(form.get('scope') ?? '') as 'workspace' | 'project' | 'environment';
	const scopeId = String(form.get('scopeId') ?? '').trim();
	if (scope === 'workspace' && scopeId === workspaceId) return { ok: true, scope, scopeId };
	if (scope === 'project' && scopeId === projectId) return { ok: true, scope, scopeId };
	if (scope === 'environment') {
		const [env] = await db
			.select({ id: environment.id })
			.from(environment)
			.where(and(eq(environment.id, scopeId), eq(environment.projectId, projectId)))
			.limit(1);
		if (env) return { ok: true, scope, scopeId };
	}
	return { ok: false, error: 'Unknown scope for this project' };
}

export const actions: Actions = {
	save: async ({ locals, request, params }) => {
		requireCap(locals, 'member');
		const gate = await observeGate(locals, params.projectId, 'limit.write');
		if (gate.denied) return fail(403, { error: 'You do not manage limits for this project' });
		const form = await request.formData();
		const target = await editableScope(form, gate.workspaceId, gate.project.id);
		if (!target.ok) return fail(400, { error: target.error });
		const parsed = parseLimitForm(form);
		if (!parsed.ok) return fail(400, { error: parsed.error });

		const [existing] = await db
			.select({ id: rateLimit.id })
			.from(rateLimit)
			.where(and(eq(rateLimit.scope, target.scope), eq(rateLimit.scopeId, target.scopeId)))
			.limit(1);
		const id = existing?.id ?? newId(ID_PREFIXES.rateLimit);
		const values = {
			rpm: parsed.values.rpm,
			tpm: parsed.values.tpm,
			rpd: parsed.values.rpd,
			tpd: parsed.values.tpd,
			concurrency: parsed.values.concurrency,
			dailySpendMicro: parsed.values.dailySpendMicro,
			monthlySpendMicro: parsed.values.monthlySpendMicro
		};
		await db.transaction(async (tx) => {
			await tx
				.insert(rateLimit)
				.values({ id, scope: target.scope, scopeId: target.scopeId, ...values })
				.onConflictDoUpdate({
					target: [rateLimit.scope, rateLimit.scopeId],
					set: { ...values, updatedAt: new Date() }
				});
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: existing ? 'limit.update' : 'limit.create',
				resource: 'rate_limit',
				resourceId: id,
				workspaceId: gate.workspaceId,
				after: Object.fromEntries(
					Object.entries(values).map(([k, v]) => [k, v == null ? null : typeof v === 'bigint' ? v.toString() : v])
				)
			});
		});
		return { saved: id };
	},
	remove: async ({ locals, request, params }) => {
		requireCap(locals, 'member');
		const gate = await observeGate(locals, params.projectId, 'limit.write');
		if (gate.denied) return fail(403, { error: 'You do not manage limits for this project' });
		const form = await request.formData();
		const target = await editableScope(form, gate.workspaceId, gate.project.id);
		if (!target.ok) return fail(400, { error: target.error });
		const [row] = await db
			.select()
			.from(rateLimit)
			.where(and(eq(rateLimit.scope, target.scope), eq(rateLimit.scopeId, target.scopeId)))
			.limit(1);
		if (!row) return fail(404, { error: 'Limit row not found' });
		await db.transaction(async (tx) => {
			await tx.delete(rateLimit).where(eq(rateLimit.id, row.id));
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: 'limit.delete',
				resource: 'rate_limit',
				resourceId: row.id,
				workspaceId: gate.workspaceId,
				before: { scope: row.scope, scopeId: row.scopeId }
			});
		});
		return { removed: row.id };
	}
};
