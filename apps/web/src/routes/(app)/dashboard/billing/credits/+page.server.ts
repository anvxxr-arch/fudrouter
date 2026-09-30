import { desc, eq, sql } from 'drizzle-orm';
import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { creditLedger } from '$lib/server/db/schema';
import { balanceMicro, isLedgerType, parseAmountToMicro, postLedger } from '$lib/server/billing';
import { ID_PREFIXES, newId } from '$lib/server/id';
import { requireCap } from '$lib/server/roles';
import { billingContext } from '../billing-context.server';

/** The six ledger types (spec §10) as filter chips, in PRD §48 order. */
const TYPES = [
	'credit_purchase',
	'usage_charge',
	'adjustment',
	'refund',
	'promotion',
	'expiration'
] as const;
const PAGE = 100;

/**
 * Credits ledger (PRD §48): every posting for the account with the running
 * balance it left behind. The running balance is a window sum over the WHOLE
 * ledger (ordered chronologically), then filtered — so a filtered view still
 * shows each row's true balance-at-that-moment, not a subtotal of the filter.
 */
export const load: PageServerLoad = async ({ locals, url }) => {
	requireCap(locals, 'member');
	const ctx = await billingContext(locals);

	const raw = url.searchParams.get('type');
	const filter = raw && raw !== 'all' && isLedgerType(raw) ? raw : null;

	// Inner query: the full ledger with a running sum. Outer: filter + page.
	const ledger = db
		.select({
			id: creditLedger.id,
			type: creditLedger.type,
			amountMicro: creditLedger.amountMicro,
			currency: creditLedger.currency,
			requestId: creditLedger.requestId,
			description: creditLedger.description,
			createdBy: creditLedger.createdBy,
			createdAt: creditLedger.createdAt,
			runningBalance: sql<string>`sum(${creditLedger.amountMicro}) over (order by ${creditLedger.createdAt}, ${creditLedger.id})::text`.as('running_balance')
		})
		.from(creditLedger)
		.where(eq(creditLedger.billingAccountId, ctx.account.id))
		.as('ledger');

	const rows = await db
		.select({
			id: ledger.id,
			type: ledger.type,
			amountMicro: ledger.amountMicro,
			currency: ledger.currency,
			requestId: ledger.requestId,
			description: ledger.description,
			createdBy: ledger.createdBy,
			createdAt: ledger.createdAt,
			runningBalance: ledger.runningBalance
		})
		.from(ledger)
		.where(filter ? eq(ledger.type, filter) : undefined)
		.orderBy(desc(ledger.createdAt), desc(ledger.id))
		.limit(PAGE);

	const balance = await balanceMicro(ctx.account.id, db);
	return {
		currency: ctx.account.currency.trim(),
		canWrite: ctx.canWrite,
		balanceMicro: balance.toString(),
		filter,
		types: TYPES as readonly string[],
		addCreditKey: `purchase:${newId(ID_PREFIXES.creditLedger)}`,
		rows: rows.map((r) => ({
			id: r.id,
			type: r.type,
			amountMicro: r.amountMicro.toString(),
			currency: r.currency.trim(),
			requestId: r.requestId,
			description: r.description,
			createdAt: r.createdAt.toISOString(),
			runningBalance: r.runningBalance
		}))
	};
};

export const actions: Actions = {
	add: async ({ locals, request }) => {
		requireCap(locals, 'member');
		const ctx = await billingContext(locals);
		if (!ctx.canWrite) return fail(403, { error: 'You need billing.write to add credits.' });

		const form = await request.formData();
		const amount = parseAmountToMicro(String(form.get('amount') ?? ''));
		if (amount === null || amount <= 0n) {
			return fail(400, { error: 'Enter a positive dollar amount, e.g. 100 or 25.50.' });
		}
		const key = String(form.get('key') ?? '').trim();
		if (!key) return fail(400, { error: 'Missing idempotency key — reload and try again.' });
		const description = String(form.get('description') ?? '').trim() || 'Credit purchase';

		// The idempotency key makes a double-submit a single purchase (PRD §118).
		const posting = await postLedger(db, {
			billingAccountId: ctx.account.id,
			type: 'credit_purchase',
			amountMicro: amount,
			currency: ctx.account.currency.trim(),
			idempotencyKey: key,
			description,
			createdBy: locals.user?.id ?? null
		});
		if (!posting.applied) {
			return { already: true, id: posting.id };
		}
		return { added: true, id: posting.id };
	}
};
