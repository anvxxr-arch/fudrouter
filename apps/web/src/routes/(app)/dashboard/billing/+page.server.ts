import { fail } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { billingAccount } from '$lib/server/db/schema';
import { writeAudit } from '$lib/server/audit';
import {
	balanceMicro,
	parseAmountToMicro,
	usageChargedMicro,
	type BillingHandle
} from '$lib/server/billing';
import { requireCap } from '$lib/server/roles';
import { billingContext, ensureLowBalanceAlert, lowBalanceEvents } from './billing-context.server';

/**
 * Billing overview (PRD §47, §128–129): the account balance, its currency and
 * status, the low-balance thresholds the router enforces (spec §10), and what
 * the current period has spent. The balance is always read back from the ledger
 * sum (`balanceMicro`), never the cache.
 */
export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'member');
	const ctx = await billingContext(locals);
	const balance = await balanceMicro(ctx.account.id, db);

	// Current period = the current UTC calendar month. UTC on purpose: the usage
	// chart and every other billing window bucket by UTC, and two different
	// "months" on one account is a bug report waiting to happen.
	const now = new Date();
	const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
	const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
	const period = await usageChargedMicro(ctx.account.id, periodStart, periodEnd, db);
	const events = await lowBalanceEvents(ctx, 20);

	return {
		currency: ctx.account.currency.trim(),
		status: ctx.account.status,
		workspaceName: ctx.workspace.name,
		canWrite: ctx.canWrite,
		balanceMicro: balance.toString(),
		warningThresholdMicro: ctx.account.warningThresholdMicro.toString(),
		hardStopThresholdMicro: ctx.account.hardStopThresholdMicro.toString(),
		period: {
			start: periodStart.toISOString(),
			end: periodEnd.toISOString(),
			spentMicro: period.amountMicro.toString(),
			requests: period.requests
		},
		events: events.map((e) => ({
			id: e.id,
			triggeredAt: e.triggeredAt.toISOString(),
			valueMicro: e.value,
			message: e.message,
			state: e.state,
			resolvedAt: e.resolvedAt ? e.resolvedAt.toISOString() : null
		}))
	};
};

export const actions: Actions = {
	thresholds: async ({ locals, request }) => {
		requireCap(locals, 'member');
		const ctx = await billingContext(locals);
		if (!ctx.canWrite) return fail(403, { error: 'You need billing.write to change thresholds.' });

		const form = await request.formData();
		const warningRaw = String(form.get('warning') ?? '').trim();
		const hardStopRaw = String(form.get('hard_stop') ?? '').trim();
		const warning = parseAmountToMicro(warningRaw);
		const hardStop = parseAmountToMicro(hardStopRaw);
		if (warning === null || hardStop === null) {
			return fail(400, { error: 'Thresholds must be dollar amounts, e.g. 10 or 0.50.' });
		}
		if (warning < 0n || hardStop < 0n) {
			return fail(400, { error: 'Thresholds cannot be negative.' });
		}
		if (hardStop > warning) {
			return fail(400, {
				error: 'The hard-stop threshold must be at or below the warning threshold.'
			});
		}

		const handle: BillingHandle = db;
		const before = {
			warning_threshold_micro: ctx.account.warningThresholdMicro.toString(),
			hard_stop_threshold_micro: ctx.account.hardStopThresholdMicro.toString()
		};
		await db
			.update(billingAccount)
			.set({ warningThresholdMicro: warning, hardStopThresholdMicro: hardStop, updatedAt: new Date() })
			.where(eq(billingAccount.id, ctx.account.id));
		// Keep the router's low-balance alert row in sync so its threshold lookup
		// reflects what the operator just set (PRD §129).
		const account = { ...ctx.account, warningThresholdMicro: warning, hardStopThresholdMicro: hardStop };
		await ensureLowBalanceAlert(handle, { workspaceId: ctx.workspaceId, account });

		await writeAudit(db, {
			actorUserId: locals.user?.id ?? null,
			action: 'billing.thresholds.update',
			resource: 'billing_account',
			resourceId: ctx.account.id,
			workspaceId: ctx.workspaceId,
			before,
			after: {
				warning_threshold_micro: warning.toString(),
				hard_stop_threshold_micro: hardStop.toString()
			}
		});
		return { saved: true };
	}
};

