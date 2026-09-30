import { fail } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { microToUsd, usdToMicro } from '$lib/server/admin';
import { parseIntField, parseEnum } from '$lib/server/admin-vocab';
import { writeAudit } from '$lib/server/audit';
import { db } from '$lib/server/db';
import { budget, rateLimit } from '$lib/server/db/schema';
import { ID_PREFIXES, newId } from '$lib/server/id';
import { requireCap } from '$lib/server/roles';
// Rate limits by scope (PRD §40–41, §65): one row per workspace, project,
// environment or api_key. Unset fields (empty form input) inherit from the
// scope above; the effective limit is the min over the chain.
const SCOPES = ['workspace', 'project', 'environment', 'api_key'] as const;
const INT_BOUNDS = { min: 0, max: 1_000_000_000_000 };
/** Nullable bounded integer; empty = inherit (null). */
function optInt(raw: FormDataEntryValue | null): number | null | 'invalid' {
	const v = String(raw ?? '').trim();
	if (!v) return null;
	const n = parseIntField(v, INT_BOUNDS);
	return n === null ? 'invalid' : n;
}
/** Nullable money field (USD in, micro string out); empty = inherit (null). */
function optMoney(raw: FormDataEntryValue | null): string | null | 'invalid' {
	const v = String(raw ?? '').trim();
	if (!v) return null;
	const micro = usdToMicro(v);
	return micro === null ? 'invalid' : micro;
}
type Limits = {
	rpm: number | null;
	tpm: number | null;
	rpd: number | null;
	tpd: number | null;
	concurrency: number | null;
	// Micro-units as strings here — the audit payload is JSON, where a bigint
	// cannot be serialized. Converted to BigInt only at the insert boundary.
	dailySpendMicro: string | null;
	monthlySpendMicro: string | null;
};
function readLimits(form: FormData): Limits | null {
	const rpm = optInt(form.get('rpm'));
	const tpm = optInt(form.get('tpm'));
	const rpd = optInt(form.get('rpd'));
	const tpd = optInt(form.get('tpd'));
	const concurrency = optInt(form.get('concurrency'));
	const daily = optMoney(form.get('dailySpendUsd'));
	const monthly = optMoney(form.get('monthlySpendUsd'));
	if (
		rpm === 'invalid' ||
		tpm === 'invalid' ||
		rpd === 'invalid' ||
		tpd === 'invalid' ||
		concurrency === 'invalid' ||
		daily === 'invalid' ||
		monthly === 'invalid'
	) {
		return null;
	}
	return {
		rpm,
		tpm,
		rpd,
		tpd,
		concurrency,
		dailySpendMicro: daily,
		monthlySpendMicro: monthly
	};
}
export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'admin.ops');
	const rows = await db.select().from(rateLimit).orderBy(rateLimit.scope, rateLimit.scopeId);
	const budgets = await db
		.select()
		.from(budget)
		.orderBy(budget.scope, budget.scopeId, budget.period);
	return {
		limits: rows.map((r) => ({
			id: r.id,
			scope: r.scope,
			scopeId: r.scopeId,
			rpm: r.rpm,
			tpm: r.tpm,
			rpd: r.rpd,
			tpd: r.tpd,
			concurrency: r.concurrency,
			// The money columns are bigint; the page formats from strings so the
			// payload never carries a bigint into the devalue serializer.
			dailySpendUsd: microToUsd(r.dailySpendMicro),
			monthlySpendUsd: microToUsd(r.monthlySpendMicro)
		})),
		budgets: budgets.map((b) => ({
			id: b.id,
			scope: b.scope,
			scopeId: b.scopeId,
			period: b.period,
			amountMicro: b.amountMicro.toString(),
			warnPercent: b.warnPercent,
			criticalPercent: b.criticalPercent,
			actionAt100: b.actionAt100
		})),
		scopes: SCOPES
	};
};
export const actions: Actions = {
	create: async ({ locals, request }) => {
		requireCap(locals, 'admin.ops');
		const form = await request.formData();
		const scope = parseEnum(SCOPES, form.get('scope'));
		const scopeId = String(form.get('scopeId') ?? '').trim();
		if (!scope || !scopeId || scopeId.length > 200) {
			return fail(400, { error: 'Scope and scope id are required' });
		}
		const limits = readLimits(form);
		if (!limits) return fail(400, { error: 'Limits must be whole numbers; caps in USD' });
		const id = newId(ID_PREFIXES.rateLimit);
		try {
			await db.transaction(async (tx) => {
				await tx.insert(rateLimit).values({
					id,
					scope,
					scopeId,
					rpm: limits.rpm,
					tpm: limits.tpm,
					rpd: limits.rpd,
					tpd: limits.tpd,
					concurrency: limits.concurrency,
					dailySpendMicro: limits.dailySpendMicro === null ? null : BigInt(limits.dailySpendMicro),
					monthlySpendMicro:
						limits.monthlySpendMicro === null ? null : BigInt(limits.monthlySpendMicro)
				});
				await writeAudit(tx, {
					actorUserId: locals.user?.id ?? null,
					action: 'rate_limit.create',
					resource: 'rate_limit',
					resourceId: id,
					after: { scope, scopeId, ...limits }
				});
			});
		} catch (err) {
			// Unique (scope, scope_id): a duplicate would silently shadow the
			// existing row rather than tighten it.
			const msg = err instanceof Error ? err.message : 'insert failed';
			return fail(400, { error: `Could not create rate limit: ${msg}` });
		}
		return { created: scopeId };
	},
	update: async ({ locals, request }) => {
		requireCap(locals, 'admin.ops');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing rate limit id' });
		const limits = readLimits(form);
		if (!limits) return fail(400, { error: 'Limits must be whole numbers; caps in USD' });
		const [before] = await db.select().from(rateLimit).where(eq(rateLimit.id, id)).limit(1);
		if (!before) return fail(404, { error: 'Rate limit not found' });
		await db.transaction(async (tx) => {
			await tx
				.update(rateLimit)
				.set({
					rpm: limits.rpm,
					tpm: limits.tpm,
					rpd: limits.rpd,
					tpd: limits.tpd,
					concurrency: limits.concurrency,
					dailySpendMicro: limits.dailySpendMicro === null ? null : BigInt(limits.dailySpendMicro),
					monthlySpendMicro:
						limits.monthlySpendMicro === null ? null : BigInt(limits.monthlySpendMicro),
					updatedAt: new Date()
				})
				.where(eq(rateLimit.id, id));
			await writeAudit(tx, {
				actorUserId: locals.user?.id ?? null,
				action: 'rate_limit.update',
				resource: 'rate_limit',
				resourceId: id,
				before: {
					rpm: before.rpm,
					tpm: before.tpm,
					rpd: before.rpd,
					tpd: before.tpd,
					concurrency: before.concurrency,
					dailySpendMicro: before.dailySpendMicro?.toString() ?? null,
					monthlySpendMicro: before.monthlySpendMicro?.toString() ?? null
				},
				after: limits
			});
		});
		return { updated: id };
	},
	delete: async ({ locals, request }) => {
		requireCap(locals, 'admin.ops');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing rate limit id' });
		const [before] = await db.select().from(rateLimit).where(eq(rateLimit.id, id)).limit(1);
		if (!before) return fail(404, { error: 'Rate limit not found' });
		await db.transaction(async (tx) => {
			await tx.delete(rateLimit).where(eq(rateLimit.id, id));
			await writeAudit(tx, {
				actorUserId: locals.user?.id ?? null,
				action: 'rate_limit.delete',
				resource: 'rate_limit',
				resourceId: id,
				before: { scope: before.scope, scopeId: before.scopeId }
			});
		});
		return { deleted: id };
	}
};
