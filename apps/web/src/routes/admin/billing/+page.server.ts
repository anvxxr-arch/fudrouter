import { fail } from '@sveltejs/kit';
import { desc, eq, sql } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { usdToMicro } from '$lib/server/admin';
import { cleanField, parseEnum } from '$lib/server/admin-vocab';
import { writeAudit } from '$lib/server/audit';
import { parseAmountToMicro, postLedger } from '$lib/server/billing';
import { db } from '$lib/server/db';
import { billingAccount, creditLedger, invoice, workspace } from '$lib/server/db/schema';
import { ID_PREFIXES, newId } from '$lib/server/id';
import { requireCap } from '$lib/server/roles';
/**
 * Platform revenue console (PRD §47–48, §128–129): every billing account with
 * its threshold policy, the credit ledger as the record of money, and invoices.
 *
 * Money is bigint micro-units end to end and is shipped to the page as strings
 * (devalue cannot serialise a bigint); `formatCost(BigInt(value))` renders it.
 * `billing_account.balance_micro` is shown but LABELLED as a cache — the
 * recomputed ledger sum next to it is the truth, and a visible gap between the
 * two is drift to repair, not a display bug.
 */
const ADJUST_TYPES = ['adjustment', 'refund', 'promotion', 'credit_purchase'] as const;
const INVOICE_STATUSES = ['draft', 'open', 'paid', 'void', 'uncollectible'] as const;
const ACCOUNT_STATUSES = ['active', 'suspended', 'closed'] as const;
const PAGE = 100;
export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'admin.billing');
	const accounts = await db
		.select({
			id: billingAccount.id,
			workspaceId: billingAccount.workspaceId,
			workspaceName: workspace.name,
			currency: billingAccount.currency,
			status: billingAccount.status,
			warningThresholdMicro: billingAccount.warningThresholdMicro,
			hardStopThresholdMicro: billingAccount.hardStopThresholdMicro,
			balanceMicro: billingAccount.balanceMicro
		})
		.from(billingAccount)
		.innerJoin(workspace, eq(workspace.id, billingAccount.workspaceId))
		.orderBy(workspace.name);
	// The ledger sum per account — the record the balance column only caches.
	const sums = await db
		.select({
			billingAccountId: creditLedger.billingAccountId,
			total: sql<string>`coalesce(sum(${creditLedger.amountMicro}), 0)::text`
		})
		.from(creditLedger)
		.groupBy(creditLedger.billingAccountId);
	const sumByAccount = new Map(sums.map((s) => [s.billingAccountId, s.total]));
	// Platform totals: the whole ledger summed by posting type.
	const totals = await db
		.select({
			type: creditLedger.type,
			total: sql<string>`coalesce(sum(${creditLedger.amountMicro}), 0)::text`
		})
		.from(creditLedger)
		.groupBy(creditLedger.type)
		.orderBy(creditLedger.type);
	const recent = await db
		.select({
			id: creditLedger.id,
			billingAccountId: creditLedger.billingAccountId,
			type: creditLedger.type,
			amountMicro: creditLedger.amountMicro,
			currency: creditLedger.currency,
			requestId: creditLedger.requestId,
			description: creditLedger.description,
			createdBy: creditLedger.createdBy,
			createdAt: creditLedger.createdAt
		})
		.from(creditLedger)
		.orderBy(desc(creditLedger.createdAt), desc(creditLedger.id))
		.limit(PAGE);
	const invoices = await db
		.select({
			id: invoice.id,
			billingAccountId: invoice.billingAccountId,
			number: invoice.number,
			periodStart: invoice.periodStart,
			periodEnd: invoice.periodEnd,
			amountMicro: invoice.amountMicro,
			currency: invoice.currency,
			status: invoice.status,
			issuedAt: invoice.issuedAt,
			paidAt: invoice.paidAt
		})
		.from(invoice)
		.orderBy(desc(invoice.createdAt), desc(invoice.id))
		.limit(PAGE);
	const accountInfo = new Map(
		accounts.map((a) => [a.id, { workspaceName: a.workspaceName, currency: a.currency.trim() }])
	);
	return {
		accounts: accounts.map((a) => ({
			id: a.id,
			workspaceName: a.workspaceName,
			currency: a.currency.trim(),
			status: a.status,
			warningThresholdMicro: a.warningThresholdMicro.toString(),
			hardStopThresholdMicro: a.hardStopThresholdMicro.toString(),
			balanceMicro: a.balanceMicro.toString(),
			ledgerSumMicro: sumByAccount.get(a.id) ?? '0'
		})),
		totals: totals.map((t) => ({ type: t.type, totalMicro: t.total })),
		recent: recent.map((r) => ({
			id: r.id,
			workspaceName: accountInfo.get(r.billingAccountId)?.workspaceName ?? '—',
			type: r.type,
			amountMicro: r.amountMicro.toString(),
			currency: r.currency.trim(),
			requestId: r.requestId,
			description: r.description,
			createdBy: r.createdBy,
			createdAt: r.createdAt
		})),
		invoices: invoices.map((iv) => ({
			id: iv.id,
			workspaceName: accountInfo.get(iv.billingAccountId)?.workspaceName ?? '—',
			number: iv.number,
			periodStart: iv.periodStart,
			periodEnd: iv.periodEnd,
			amountMicro: iv.amountMicro.toString(),
			currency: iv.currency.trim(),
			status: iv.status,
			issuedAt: iv.issuedAt,
			paidAt: iv.paidAt
		})),
		adjustTypes: ADJUST_TYPES as readonly string[],
		invoiceStatuses: INVOICE_STATUSES as readonly string[],
		accountStatuses: ACCOUNT_STATUSES as readonly string[]
	};
};
/** A date input's `YYYY-MM-DD` (or full ISO) to a Date, or null. */
function parseDate(raw: FormDataEntryValue | null | undefined): Date | null {
	const v = String(raw ?? '').trim();
	if (!v) return null;
	const d = new Date(v);
	return Number.isFinite(d.getTime()) ? d : null;
}
export const actions: Actions = {
	adjust: async ({ locals, request }) => {
		requireCap(locals, 'admin.billing');
		const form = await request.formData();
		const billingAccountId = String(form.get('billing_account') ?? '').trim();
		const type = parseEnum(ADJUST_TYPES, form.get('type'));
		const amount = parseAmountToMicro(String(form.get('amount') ?? ''));
		const description = cleanField(form.get('description'));
		const idempotencyKey = String(form.get('idempotencyKey') ?? '').trim() || null;
		if (!billingAccountId) return fail(400, { error: 'Pick a billing account.' });
		if (!type) return fail(400, { error: 'Invalid adjustment type.' });
		if (amount === null) {
			return fail(400, { error: 'Enter a dollar amount like 25.50 or -10 (max 6 decimals).' });
		}
		if (!description) return fail(400, { error: 'A description is required.' });
		const [account] = await db
			.select({ currency: billingAccount.currency })
			.from(billingAccount)
			.where(eq(billingAccount.id, billingAccountId))
			.limit(1);
		if (!account) return fail(404, { error: 'Billing account not found.' });
		// postLedger is the one ledger writer: its transaction posts the row,
		// moves the balance cache and writes the audit entry together, and a
		// repeated idempotency key posts NOTHING (`applied: false`).
		const posting = await db.transaction((tx) =>
			postLedger(tx, {
				billingAccountId,
				type,
				amountMicro: amount,
				currency: account.currency,
				description,
				createdBy: locals.user?.id ?? null,
				idempotencyKey
			})
		);
		if (!posting.applied) {
			return { already: true, message: 'already posted (idempotent retry)', id: posting.id };
		}
		return { posted: true, id: posting.id };
	},
	createInvoice: async ({ locals, request }) => {
		requireCap(locals, 'admin.billing');
		const form = await request.formData();
		const billingAccountId = String(form.get('billing_account') ?? '').trim();
		const number = cleanField(form.get('number'));
		const periodStart = parseDate(form.get('period_start'));
		const periodEnd = parseDate(form.get('period_end'));
		const amount = usdToMicro(String(form.get('amount') ?? ''));
		const status = parseEnum(INVOICE_STATUSES, form.get('status')) ?? 'draft';
		if (!billingAccountId) return fail(400, { error: 'Pick a billing account.' });
		if (!number) return fail(400, { error: 'An invoice number is required.' });
		if (!periodStart || !periodEnd || periodEnd.getTime() <= periodStart.getTime()) {
			return fail(400, { error: 'Give a valid billing period (end after start).' });
		}
		if (amount === null) return fail(400, { error: 'Enter a dollar amount like 120.00.' });
		const [account] = await db
			.select({ currency: billingAccount.currency, workspaceId: billingAccount.workspaceId })
			.from(billingAccount)
			.where(eq(billingAccount.id, billingAccountId))
			.limit(1);
		if (!account) return fail(404, { error: 'Billing account not found.' });
		const id = newId(ID_PREFIXES.invoice);
		try {
			await db.transaction(async (tx) => {
				await tx.insert(invoice).values({
					id,
					billingAccountId,
					number,
					periodStart,
					periodEnd,
					amountMicro: BigInt(amount),
					currency: account.currency,
					status
				});
				await writeAudit(tx, {
					actorUserId: locals.user?.id ?? null,
					action: 'invoice.create',
					resource: 'invoice',
					resourceId: id,
					workspaceId: account.workspaceId,
					after: {
						number,
						status,
						amountMicro: amount,
						currency: account.currency.trim(),
						periodStart: periodStart.toISOString(),
						periodEnd: periodEnd.toISOString()
					}
				});
			});
		} catch (err) {
			// `invoice_number_idx` is unique: a duplicate number lands here.
			const msg = err instanceof Error ? err.message : 'insert failed';
			return fail(400, { error: `Could not create invoice: ${msg}` });
		}
		return { invoiceCreated: number };
	},
	setInvoiceStatus: async ({ locals, request }) => {
		requireCap(locals, 'admin.billing');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		const status = parseEnum(INVOICE_STATUSES, form.get('status'));
		if (!id) return fail(400, { error: 'Missing invoice id.' });
		if (!status) return fail(400, { error: 'Invalid invoice status.' });
		const [before] = await db.select().from(invoice).where(eq(invoice.id, id)).limit(1);
		if (!before) return fail(404, { error: 'Invoice not found.' });
		const [account] = await db
			.select({ workspaceId: billingAccount.workspaceId })
			.from(billingAccount)
			.where(eq(billingAccount.id, before.billingAccountId))
			.limit(1);
		await db.transaction(async (tx) => {
			await tx
				.update(invoice)
				// Marking paid attests an offline payment (PRD §129): paid sets paidAt.
				.set({ status, ...(status === 'paid' ? { paidAt: new Date() } : {}) })
				.where(eq(invoice.id, id));
			await writeAudit(tx, {
				actorUserId: locals.user?.id ?? null,
				action: 'invoice.set_status',
				resource: 'invoice',
				resourceId: id,
				workspaceId: account?.workspaceId ?? null,
				before: { status: before.status },
				after: { status }
			});
		});
		return { invoiceStatus: `${before.number} → ${status}` };
	},
	setAccountStatus: async ({ locals, request }) => {
		requireCap(locals, 'admin.billing');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		const status = parseEnum(ACCOUNT_STATUSES, form.get('status'));
		if (!id) return fail(400, { error: 'Missing billing account id.' });
		if (!status) return fail(400, { error: 'Invalid account status.' });
		const [before] = await db.select().from(billingAccount).where(eq(billingAccount.id, id)).limit(1);
		if (!before) return fail(404, { error: 'Billing account not found.' });
		await db.transaction(async (tx) => {
			await tx
				.update(billingAccount)
				.set({ status, updatedAt: new Date() })
				.where(eq(billingAccount.id, id));
			await writeAudit(tx, {
				actorUserId: locals.user?.id ?? null,
				action: 'billing_account.set_status',
				resource: 'billing_account',
				resourceId: id,
				workspaceId: before.workspaceId,
				before: { status: before.status },
				after: { status }
			});
		});
		return { accountStatus: status };
	}
};
