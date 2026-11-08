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

// Pure money arithmetic lives in ./money.ts so parse/ceiling rules have no DB
// dependency (this module imports db/index.ts, which throws without a DSN).
// Re-exported here so existing callers keep the historical name.
export { parseAmountToMicro } from './money.ts';

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
 * The sum is `sum(bigint) -> numeric`, kept numeric until the write. An account
 * whose total is OUTSIDE int64 cannot be written: `balance_micro` is bigint, so
 * `::bigint` on it raises `bigint out of range` and — with the old single
 * statement — aborted the WHOLE `billing_aggregation` job for every account
 * (the runbook records the corrupt 5.55e18×2 account). Isolation is the fix,
 * not cast and not silent skip (FR-revised §S1/P1.2, §7 invariant 4): overflow
 * accounts are moved to `status='quarantine'` and get an audit row for manual
 * triage, while every in-range account still reconciles. The Go admission gate
 * (`checkBudgets`) already refuses any `status <> 'active'`, so a quarantined
 * account cannot spend its unbounded balance.
 *
 * The `::bigint` cast sits in its own `inrange` CTE so Postgres only ever casts
 * a sum it has already proven in-range; reading `w.total::bigint` inside the
 * `updated`'s WHERE would let the executor cast overflow rows before the range
 * predicate filters them, reproducing the very `bigint out of range` this
 * change removes. `status='quarantine'` is written with the same statement
 * (still one round trip); the audit insert rides along so a quarantine is never
 * invisible.
 */
export async function reconcileAll(dbtx: BillingHandle = db): Promise<string[]> {
	const rows = await dbtx.execute(sql`
		with derived as (
			select c.billing_account_id as account_id, sum(c.amount_micro) as total
			from credit_ledger c
			group by c.billing_account_id
		),
		wanted as (
			select b2.id, coalesce(d.total, 0) as total
			from billing_account b2
			left join derived d on d.account_id = b2.id
		),
		inrange as (
			select id, total::bigint as total
			from wanted
			where total <= 9223372036854775807
			  and total >= -9223372036854775808
		),
		overflow as (
			select id, total
			from wanted
			where total > 9223372036854775807
			   or total < -9223372036854775808
		),
		updated as (
			update billing_account b
			set balance_micro = w.total, updated_at = now()
			from inrange w
			where w.id = b.id and w.total <> b.balance_micro
			returning b.id
		),
		quarantined as (
			update billing_account b
			set status = 'quarantine', updated_at = now()
			from overflow o
			where o.id = b.id and b.status <> 'quarantine'
			returning b.id, o.total
		),
		audited as (
			insert into audit_log (id, actor_kind, action, resource, resource_id, metadata)
			select 'aud_' || gen_random_uuid(), 'system', 'billing.quarantine',
			       'billing_account', q.id,
			       jsonb_build_object(
			         'reason', 'credit ledger sum exceeds int64',
			         'ledger_sum_micro', q.total::text
			       )
			from quarantined q
			returning id
		)
		select 'repaired' as kind, id as account_id from updated
		union all
		select 'quarantined' as kind, id as account_id from quarantined
	`);
	const seen = rows as unknown as { kind: string; account_id: string }[];
	return seen.filter((r) => r.kind === 'repaired').map((r) => r.account_id);
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