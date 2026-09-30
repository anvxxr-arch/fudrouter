import { and, desc, eq } from 'drizzle-orm';
import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { invoice } from '$lib/server/db/schema';
import { writeAudit } from '$lib/server/audit';
import { usageChargedMicro } from '$lib/server/billing';
import { ID_PREFIXES, newId } from '$lib/server/id';
import { requireCap } from '$lib/server/roles';
import { billingContext } from '../billing-context.server';

/**
 * Invoices (PRD §47). Generation is IMMEDIATE DIRECT COMPUTATION here (not a
 * `job` row): the amount is the ledger's billed usage for the previous UTC
 * calendar month, computed and inserted in one request. The `invoice_generation`
 * job + worker is the later-wave path for scheduled runs; nothing on this page
 * waits for a worker to exist.
 *
 * Payment processing is out of scope — `mark paid` is an operator attesting an
 * offline payment, and `void` cancels an invoice that should not be collected.
 */
export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'member');
	const ctx = await billingContext(locals);
	const rows = await db
		.select()
		.from(invoice)
		.where(eq(invoice.billingAccountId, ctx.account.id))
		.orderBy(desc(invoice.periodStart), desc(invoice.createdAt))
		.limit(100);
	return {
		currency: ctx.account.currency.trim(),
		canWrite: ctx.canWrite,
		rows: rows.map((r) => ({
			id: r.id,
			number: r.number,
			periodStart: r.periodStart.toISOString(),
			periodEnd: r.periodEnd.toISOString(),
			amountMicro: r.amountMicro.toString(),
			currency: r.currency.trim(),
			status: r.status,
			issuedAt: r.issuedAt ? r.issuedAt.toISOString() : null,
			paidAt: r.paidAt ? r.paidAt.toISOString() : null
		}))
	};
};

export const actions: Actions = {
	generate: async ({ locals }) => {
		requireCap(locals, 'member');
		const ctx = await billingContext(locals);
		if (!ctx.canWrite) return fail(403, { error: 'You need billing.write to generate invoices.' });

		// Previous UTC calendar month — the same window the ledger bills in.
		const now = new Date();
		const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
		const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

		const [existing] = await db
			.select({ id: invoice.id, number: invoice.number })
			.from(invoice)
			.where(
				and(
					eq(invoice.billingAccountId, ctx.account.id),
					eq(invoice.periodStart, periodStart),
					eq(invoice.periodEnd, periodEnd)
				)
			)
			.limit(1);
		if (existing) return { already: true, number: existing.number };

		const period = await usageChargedMicro(ctx.account.id, periodStart, periodEnd, db);
		const ym = `${periodStart.getUTCFullYear()}${String(periodStart.getUTCMonth() + 1).padStart(2, '0')}`;
		const id = newId(ID_PREFIXES.invoice);
		// Unique on `number` (index backstop) — the suffix is the id's tail, so a
		// collision cannot happen for two distinct invoices.
		const number = `INV-${ym}-${id.slice(-6)}`;
		await db.insert(invoice).values({
			id,
			billingAccountId: ctx.account.id,
			number,
			periodStart,
			periodEnd,
			amountMicro: period.amountMicro,
			currency: ctx.account.currency.trim(),
			status: 'open',
			issuedAt: new Date()
		});
		await writeAudit(db, {
			actorUserId: locals.user?.id ?? null,
			action: 'invoice.generate',
			resource: 'invoice',
			resourceId: id,
			workspaceId: ctx.workspaceId,
			after: {
				number,
				amountMicro: period.amountMicro.toString(),
				periodStart: periodStart.toISOString(),
				periodEnd: periodEnd.toISOString()
			}
		});
		return { generated: true, number };
	},
	markPaid: async ({ locals, request }) => {
		requireCap(locals, 'member');
		return transition(locals, request, 'paid', 'invoice.mark_paid');
	},
	void: async ({ locals, request }) => {
		requireCap(locals, 'member');
		return transition(locals, request, 'void', 'invoice.void');
	}
};

/** Shared status transition: only this account's invoices, never another's. */
async function transition(
	locals: App.Locals,
	request: Request,
	status: 'paid' | 'void',
	action: string
) {
	const ctx = await billingContext(locals);
	if (!ctx.canWrite) return fail(403, { error: 'You need billing.write to change invoices.' });
	const form = await request.formData();
	const id = String(form.get('id') ?? '').trim();
	if (!id) return fail(400, { error: 'Missing invoice id.' });
	const [updated] = await db
		.update(invoice)
		.set(
			status === 'paid'
				? { status: 'paid', paidAt: new Date() }
				: { status: 'void', paidAt: null }
		)
		.where(and(eq(invoice.id, id), eq(invoice.billingAccountId, ctx.account.id)))
		.returning({ id: invoice.id, number: invoice.number, status: invoice.status });
	if (!updated) return fail(404, { error: 'Invoice not found.' });
	await writeAudit(db, {
		actorUserId: locals.user?.id ?? null,
		action,
		resource: 'invoice',
		resourceId: updated.id,
		workspaceId: ctx.workspaceId,
		after: { status: updated.status }
	});
	return status === 'paid'
		? { paid: true, number: updated.number }
		: { voided: true, number: updated.number };
}
