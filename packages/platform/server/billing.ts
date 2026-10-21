import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { writeAudit, type DbTx } from './audit.ts';
import { db } from './db/index.ts';
import { billingAccount, creditLedger } from './db/schema.ts';
import { ID_PREFIXES, newId } from './id.ts';

/**
 * The credit ledger (spec §10, PRD §47–48, §118, §128).
 *
 * Balance = SUM(credit_ledger.amount_micro). `billing_account.balance_micro` is
 * only a cache of that sum, updated in the same transaction as every posting —
 * it is never the record. `reconcile()` repairs it, `balanceMicro()` always
 * recomputes from the ledger.
 *
 * Money never touches a float: every amount is a native bigint in micro-units
 * ($1 = 1_000_000), signed — a posting is the DELTA it applies to the balance.
 * Credits (purchase, refund, promotion) are positive; debits (usage_charge,
 * expiration, most adjustments) are negative. `chargeRequest` therefore posts
 * the customer cost as a negative delta while its `amountMicro` argument is the
 * positive customer cost, matching spec §10 ("amount = customer_cost_micro").
 *
 * Every write goes through `postLedger` (one insert + one cache update + one
 * audit row, PRD §71 "billing adjustment") so no caller can drift a balance
 * without a matching ledger row and audit entry.
 */

/**
 * The one handle type every ledger entry point takes (the shared `DbTx` from
 * `./audit`): the app `db` singleton or a `db.transaction` callback's `tx`.
 */
export type BillingHandle = DbTx;

export type LedgerType =
	| 'credit_purchase'
	| 'usage_charge'
	| 'adjustment'
	| 'refund'
	| 'promotion'
	| 'expiration';

export interface PostLedgerInput {
	billingAccountId: string;
	type: LedgerType;
	/** Signed delta in micro-units. Positive credits the account, negative debits it. */
	amountMicro: bigint;
	currency?: string;
	requestId?: string | null;
	idempotencyKey?: string | null;
	description?: string | null;
	metadata?: Record<string, unknown>;
	/** User id of the human behind the posting; absent = system/router. */
	createdBy?: string | null;
}

export interface LedgerPosting {
	id: string;
	/** False when an idempotency-key retry hit an existing row: nothing was posted. */
	applied: boolean;
}

export interface ChargeInput {
	billingAccountId: string;
	requestId: string;
	/** The positive customer cost in micro-units (request_log.cost). */
	amountMicro: bigint;
	currency?: string;
}

const LEDGER_TYPES: readonly LedgerType[] = [
	'credit_purchase',
	'usage_charge',
	'adjustment',
	'refund',
	'promotion',
	'expiration'
];

export function isLedgerType(v: unknown): v is LedgerType {
	return typeof v === 'string' && (LEDGER_TYPES as readonly string[]).includes(v);
}

/**
 * Parse a human-entered decimal amount ("10", "10.50", "0.00421") into signed
 * micro-units. String arithmetic only — Number("0.00421") * 1e6 is 4210.000000001
 * in a float, and a ledger must never depend on that.
 *
 * Accepts at most 6 decimal places (one micro-unit); anything else is a typo,
 * not something to silently round. Returns null for anything unparseable.
 */
export function parseAmountToMicro(input: string): bigint | null {
	const m = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(input.trim());
	if (!m) return null;
	const [, sign, whole, frac = ''] = m;
	const micro = BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, '0'));
	return sign === '-' ? -micro : micro;
}

/**
 * The account's billing account — the one `user_id` allows (unique index),
 * created on first touch so a user who predates the row still gets a working
 * billing page instead of a dead one. Insert-first with DO NOTHING on the
 * unique key: two racing requests both end up reading the same row.
 */
export async function ensureBillingAccount(
	dbtx: BillingHandle,
	userId: string
): Promise<typeof billingAccount.$inferSelect> {
	await dbtx
		.insert(billingAccount)
		.values({ id: newId(ID_PREFIXES.billingAccount), userId })
		.onConflictDoNothing({ target: billingAccount.userId });
	const [account] = await dbtx
		.select()
		.from(billingAccount)
		.where(eq(billingAccount.userId, userId))
		.limit(1);
	if (!account) throw new Error(`billing_account missing for user ${userId}`);
	return account;
}

/**
 * Post one ledger row and move the balance cache by the same signed delta.
 *
 * Idempotency is durable (PRD §118): the unique `idempotency_key` index is the
 * stopper. A retry returns the ORIGINAL posting with `applied: false` and moves
 * neither the cache nor the audit trail — the second call must never double-charge.
 */
export async function postLedger(
	dbtx: BillingHandle,
	input: PostLedgerInput
): Promise<LedgerPosting> {
	const { billingAccountId, type, amountMicro } = input;
	if (typeof amountMicro !== 'bigint') {
		throw new TypeError('amountMicro must be a bigint of micro-units, never a float');
	}
	if (!isLedgerType(type)) {
		throw new TypeError(`unknown ledger type: ${JSON.stringify(type)}`);
	}
	const currency = (input.currency ?? 'USD').toUpperCase();
	if (!/^[A-Z]{3}$/.test(currency)) {
		throw new TypeError(`currency must be a 3-letter code, got ${JSON.stringify(input.currency)}`);
	}
	// One posting = one atomic unit (spec §10): insert + cache move + audit row
	// commit or roll back together even when a caller hands us the bare `db`
	// handle. Handed an open transaction already, `.transaction` degrades to a
	// savepoint — still atomic with the caller's request_log insert (PRD §128).
	const idempotencyKey = input.idempotencyKey ?? null;
	return dbtx.transaction(async (tx) => {
		const id = newId(ID_PREFIXES.creditLedger);
		const rows = await tx
			.insert(creditLedger)
			.values({
				id,
				billingAccountId,
				type,
				amountMicro,
				currency,
				requestId: input.requestId ?? null,
				idempotencyKey,
				description: input.description ?? null,
				metadata: input.metadata ?? {},
				createdBy: input.createdBy ?? null
			})
			.onConflictDoNothing({ target: creditLedger.idempotencyKey })
			.returning({ id: creditLedger.id });
		if (rows.length === 0) {
			// Retry of a posting that already landed. Nothing is written again.
			// Only a non-null key can conflict (NULLs are distinct in the unique
			// index), so an empty result without one is an invariant break.
			if (!idempotencyKey) {
				throw new Error('ledger insert affected no rows without an idempotency key');
			}
			const [existing] = await tx
				.select({ id: creditLedger.id })
				.from(creditLedger)
				.where(eq(creditLedger.idempotencyKey, idempotencyKey))
				.limit(1);
			if (!existing) throw new Error(`ledger conflict on ${idempotencyKey} but no existing row`);
			return { id: existing.id, applied: false };
		}
		// Cache update in the SAME transaction as the insert (spec §10). The ledger
		// sum stays authoritative; this row only saves the next reader the sum.
		await tx
			.update(billingAccount)
			.set({
				balanceMicro: sql`${billingAccount.balanceMicro} + ${amountMicro}`,
				updatedAt: new Date()
			})
			.where(eq(billingAccount.id, billingAccountId));
		await writeAudit(tx, {
			actorUserId: input.createdBy ?? null,
			action: 'billing.adjustment',
			resource: 'credit_ledger',
			resourceId: id,
			before: null,
			after: {
				type,
				amountMicro: amountMicro.toString(),
				currency,
				requestId: input.requestId ?? null
			},
			metadata: {
				billingAccountId,
				description: input.description ?? null,
				...(input.metadata ?? {})
			}
		});
		return { id, applied: true };
	});
}

/**
 * Charge one request (PRD §128): one `usage_charge` posting keyed
 * `usage:<requestId>`. `amountMicro` is the positive customer cost; the ledger
 * row carries it as a negative delta, because a charge shrinks the balance.
 *
 * Callers run this inside the same transaction as the `request_log` insert so
 * the request and its charge land or roll back together. The idempotency key
 * makes a retried call a no-op (PRD §118) — one request, one charge, ever.
 */
export async function chargeRequest(
	dbtx: BillingHandle,
	input: ChargeInput
): Promise<LedgerPosting> {
	const { billingAccountId, requestId, amountMicro } = input;
	if (!requestId) throw new TypeError('chargeRequest needs a requestId');
	if (typeof amountMicro !== 'bigint') {
		throw new TypeError('amountMicro must be a bigint of micro-units, never a float');
	}
	if (amountMicro < 0n) {
		throw new RangeError(
			'chargeRequest takes the positive customer cost; the ledger applies it as a debit'
		);
	}
	return postLedger(dbtx, {
		billingAccountId,
		type: 'usage_charge',
		amountMicro: -amountMicro,
		currency: input.currency,
		requestId,
		idempotencyKey: `usage:${requestId}`,
		description: `Request usage ${requestId}`
	});
}

/** The true balance: SUM(credit_ledger.amount_micro) for the account. */
export async function balanceMicro(accountId: string, dbtx: BillingHandle = db): Promise<bigint> {
	const rows = await dbtx
		.select({ total: sql<string>`coalesce(sum(${creditLedger.amountMicro}), 0)::text` })
		.from(creditLedger)
		.where(eq(creditLedger.billingAccountId, accountId));
	return BigInt(rows[0]?.total ?? '0');
}

/**
 * Repair `billing_account.balance_micro` for EVERY account in ONE statement and
 * return the ids whose cache had actually drifted. Safe to run at any time —
 * the ledger is the record, this only re-derives the cache from it.
 *
 * This replaces the loop that called `reconcile(accountId)` per account: three
 * round trips each (read the cached value, sum the ledger, write it back), so
 * the `billing_aggregation` job's N accounts cost 3N sequential round trips
 * every hour. One set-based statement does the same work in one round trip and
 * has a second, stronger property — the whole fleet is either repaired or not,
 * where the loop could be killed halfway and leave the caches half-old.
 *
 * The rule itself is still written exactly once (the `derived` CTE below), and
 * only rows whose value actually changes are written, so a steady-state run
 * updates nothing and does not churn `updated_at` across every account.
 *
 * The sum is `sum(bigint) -> numeric`, cast back to bigint: micro-unit amounts
 * are integers, so the cast is lossless, and it is the same figure
 * `balanceMicro()` returns (it goes through `::text` and `BigInt`, same value).
 */
export async function reconcileAll(dbtx: BillingHandle = db): Promise<string[]> {
	const rows = await dbtx.execute(sql`
		with derived as (
			select c.billing_account_id as account_id, sum(c.amount_micro) as total
			from credit_ledger c
			group by c.billing_account_id
		),
		wanted as (
			select b2.id, coalesce(d.total, 0)::bigint as total
			from billing_account b2
			left join derived d on d.account_id = b2.id
		)
		update billing_account b
		set balance_micro = w.total, updated_at = now()
		from wanted w
		where w.id = b.id and w.total <> b.balance_micro
		returning b.id
	`);
	return (rows as unknown as { id: string }[]).map((r) => r.id);
}

/** The usage charges (customer cost, positive) billed in [since, until). */
export async function usageChargedMicro(
	accountId: string,
	since: Date,
	until: Date,
	dbtx: BillingHandle = db
): Promise<{ amountMicro: bigint; requests: number }> {
	const rows = await dbtx
		.select({
			total: sql<string>`coalesce(-sum(${creditLedger.amountMicro}), 0)::text`,
			requests: sql<number>`count(*)::int`
		})
		.from(creditLedger)
		.where(
			and(
				eq(creditLedger.billingAccountId, accountId),
				eq(creditLedger.type, 'usage_charge'),
				gte(creditLedger.createdAt, since),
				lt(creditLedger.createdAt, until)
			)
		);
	return { amountMicro: BigInt(rows[0]?.total ?? '0'), requests: rows[0]?.requests ?? 0 };
}
