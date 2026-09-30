import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { creditLedger } from '$lib/server/db/schema';
import { requireCap } from '$lib/server/roles';
import { billingContext } from '../billing-context.server';
import { decodeCursor, encodeCursor } from '../billing-format';

const PAGE = 50;

/**
 * Transactions (PRD §48): the raw ledger as a cursor-paginated list built for
 * export — one flat row per posting with every column an export needs (id, when,
 * type, amount, currency, request, description). The table is sorted
 * (created_at desc, id desc), which is also the CSV order.
 *
 * Pagination uses the ledger's natural keyset (created_at, id) under
 * `< ISO|id >`-shaped cursors... which is why the cursor is the exact ISO
 * timestamp: `timestamptz` stores microseconds, and truncating that to Date's
 * millisecond precision would both skip and repeat rows on a busy ledger. The
 * row boundary is carried by the id (uuidv7), so `ORDER BY created_at, id` never
 * dangles between rows.
 */
export const load: PageServerLoad = async ({ locals, url }) => {
	requireCap(locals, 'member');
	const ctx = await billingContext(locals);

	const cursor = decodeCursor(url.searchParams.get('cursor') ?? '');

	// Keyset over (created_at, id) in (created_at desc, id desc) order. The
	// created_at comparison uses the row's OWN timestamptz text (microsecond
	// precision) cast back to timestamptz — a JS Date cursor would truncate to
	// milliseconds and both repeat and skip rows that share a millisecond.
	const afterCursor = cursor
		? or(
				sql`${creditLedger.createdAt} < ${cursor.createdAtKey}::timestamptz`,
				and(
					sql`${creditLedger.createdAt} = ${cursor.createdAtKey}::timestamptz`,
					lt(creditLedger.id, cursor.id)
				)
			)
		: undefined;

	const rows = await db
		.select({
			id: creditLedger.id,
			type: creditLedger.type,
			amountMicro: creditLedger.amountMicro,
			currency: creditLedger.currency,
			requestId: creditLedger.requestId,
			idempotencyKey: creditLedger.idempotencyKey,
			description: creditLedger.description,
			createdBy: creditLedger.createdBy,
			createdAt: creditLedger.createdAt,
			createdAtKey: sql<string>`${creditLedger.createdAt}::text`
		})
		.from(creditLedger)
		.where(and(eq(creditLedger.billingAccountId, ctx.account.id), afterCursor))
		.orderBy(desc(creditLedger.createdAt), desc(creditLedger.id))
		.limit(PAGE + 1);

	const page = rows.slice(0, PAGE);
	const next = rows.length > PAGE ? page[page.length - 1] : null;

	return {
		currency: ctx.account.currency.trim(),
		// The canonical export shape: these headers name the CSV columns in the
		// same order the table renders, so a download cannot drift from the view.
		csvHeaders: [
			'id',
			'created_at',
			'type',
			'amount_micro',
			'currency',
			'request_id',
			'idempotency_key',
			'description',
			'created_by'
		],
		rows: page.map((r) => ({
			id: r.id,
			type: r.type,
			amountMicro: r.amountMicro.toString(),
			currency: r.currency.trim(),
			requestId: r.requestId,
			idempotencyKey: r.idempotencyKey,
			description: r.description,
			createdBy: r.createdBy,
			createdAt: r.createdAt.toISOString()
		})),
		nextCursor: next ? encodeCursor(next.createdAtKey, next.id) : null
	};
};
