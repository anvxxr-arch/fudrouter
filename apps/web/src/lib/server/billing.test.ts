import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db } from './db';
import { auditLog, billingAccount, creditLedger, workspace } from './db/schema';
import {
	balanceMicro,
	chargeRequest,
	ensureBillingAccount,
	parseAmountToMicro,
	postLedger,
	reconcile
} from './billing';
import { ID_PREFIXES, newId } from './id';

/**
 * Ledger integrity tests against the real schema (spec §10, PRD §118/§128).
 *
 * The three properties this file defends are the ones a billing bug destroys:
 *   1. one request, one charge — a retried `chargeRequest` never double-charges
 *   2. balanceMicro() is always the ledger sum, whatever was posted
 *   3. `reconcile()` repairs a drifted balance_micro cache from the ledger
 *
 * Fixtures are throwaway workspaces (workspace + its cascade) cleaned up per
 * test; audit rows are cleaned by workspace_id because audit_log keeps no FK —
 * the ledger outlives its subject, by design.
 */

let workspaceId: string;
let accountId: string;

beforeEach(async () => {
	workspaceId = newId(ID_PREFIXES.workspace);
	await db.insert(workspace).values({ id: workspaceId, name: 'billing-test', slug: workspaceId });
	accountId = (await ensureBillingAccount(db, workspaceId)).id;
});

afterEach(async () => {
	await db.delete(auditLog).where(eq(auditLog.workspaceId, workspaceId));
	await db.delete(creditLedger).where(eq(creditLedger.billingAccountId, accountId));
	await db.delete(billingAccount).where(eq(billingAccount.id, accountId));
	await db.delete(workspace).where(eq(workspace.id, workspaceId));
});

const ledgerSum = async (): Promise<bigint> => {
	const [row] = await db
		.select({ total: sql<string>`coalesce(sum(${creditLedger.amountMicro}), 0)::text` })
		.from(creditLedger)
		.where(eq(creditLedger.billingAccountId, accountId));
	return BigInt(row.total);
};

describe('chargeRequest idempotency (PRD §118)', () => {
	it('charges exactly ONCE for a requestId, however many times it is called', async () => {
		const requestId = newId(ID_PREFIXES.request);
		const first = await chargeRequest(db, {
			billingAccountId: accountId,
			requestId,
			amountMicro: 4_210n
		});
		const retry = await chargeRequest(db, {
			billingAccountId: accountId,
			requestId,
			amountMicro: 4_210n
		});
		expect(first.applied).toBe(true);
		expect(retry.applied).toBe(false);
		expect(retry.id).toBe(first.id);
		const rows = await db
			.select()
			.from(creditLedger)
			.where(
				and(
					eq(creditLedger.billingAccountId, accountId),
					eq(creditLedger.type, 'usage_charge'),
					eq(creditLedger.requestId, requestId)
				)
			);
		expect(rows, 'a retried charge must never create a second ledger row').toHaveLength(1);
		expect(rows[0].idempotencyKey).toBe(`usage:${requestId}`);
		expect(rows[0].amountMicro, 'a charge is a negative delta').toBe(-4_210n);
		expect(await balanceMicro(accountId)).toBe(-4_210n);
		// One posting, one audit row: the retry wrote nothing anywhere.
		const audits = await db
			.select()
			.from(auditLog)
			.where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.action, 'billing.adjustment')));
		expect(audits).toHaveLength(1);
	});
	it('rejects a negative or non-bid amount before touching the ledger', async () => {
		await expect(
			chargeRequest(db, { billingAccountId: accountId, requestId: 'req_x', amountMicro: -1n })
		).rejects.toThrow(RangeError);
		await expect(
			// @ts-expect-error deliberately wrong type — floats must never reach the ledger
			chargeRequest(db, { billingAccountId: accountId, requestId: 'req_x', amountMicro: 4.21 })
		).rejects.toThrow(TypeError);
	});
});

describe('balance = ledger sum', () => {
	it('holds after arbitrary postings of every type', async () => {
		const requestId = newId(ID_PREFIXES.request);
		const postings = [
			{ type: 'credit_purchase', amountMicro: 100_000_000n },
			{ type: 'promotion', amountMicro: 2_500_000n },
			{ type: 'adjustment', amountMicro: -1_234n },
			{ type: 'refund', amountMicro: 5_000_000n },
			{ type: 'expiration', amountMicro: -1_000_000n }
		] as const;
		for (const p of postings) {
			await postLedger(db, { billingAccountId: accountId, ...p });
		}
		await chargeRequest(db, { billingAccountId: accountId, requestId, amountMicro: 4_210n });
		const sum = await ledgerSum();
		expect(sum).toBe(100_000_000n + 2_500_000n - 1_234n + 5_000_000n - 1_000_000n - 4_210n);
		expect(await balanceMicro(accountId), 'balanceMicro must equal SUM(credit_ledger)').toBe(sum);
		// The cache moved in the same transactions and matches the sum too.
		const [account] = await db
			.select({ cached: billingAccount.balanceMicro })
			.from(billingAccount)
			.where(eq(billingAccount.id, accountId));
		expect(account.cached).toBe(sum);
	});
	it('honours an explicit idempotency key without a second posting', async () => {
		const input = {
			billingAccountId: accountId,
			type: 'credit_purchase',
			amountMicro: 100_000_000n,
			idempotencyKey: 'purchase:manual-test-1',
			description: 'manual purchase'
		} as const;
		const first = await postLedger(db, input);
		const retry = await postLedger(db, input);
		expect(first.applied).toBe(true);
		expect(retry.applied).toBe(false);
		expect(await balanceMicro(accountId)).toBe(100_000_000n);
	});
});

describe('reconcile', () => {
	it('repairs a drifted balance_micro cache from the ledger sum', async () => {
		await postLedger(db, { billingAccountId: accountId, type: 'credit_purchase', amountMicro: 75_000_000n });
		await chargeRequest(db, {
			billingAccountId: accountId,
			requestId: newId(ID_PREFIXES.request),
			amountMicro: 3_000n
		});
		// Simulate drift the ledger cannot account for — a bad writer, a manual
		// UPDATE, a restored backup.
		await db
			.update(billingAccount)
			.set({ balanceMicro: 999_999_999n })
			.where(eq(billingAccount.id, accountId));
		const repaired = await reconcile(accountId);
		expect(repaired.repaired, 'a drifted cache must be reported as repaired').toBe(true);
		expect(repaired.balanceMicro).toBe(await ledgerSum());
		const [account] = await db
			.select({ cached: billingAccount.balanceMicro })
			.from(billingAccount)
			.where(eq(billingAccount.id, accountId));
		expect(account.cached, 'reconcile must rewrite the cache').toBe(await ledgerSum());
		// A clean cache is left alone and reported honest.
		const again = await reconcile(accountId);
		expect(again.repaired).toBe(false);
		expect(again.balanceMicro).toBe(await ledgerSum());
	});
});

describe('parseAmountToMicro', () => {
	it('parses decimal dollars into exact micro-units by string arithmetic', () => {
		expect(parseAmountToMicro('10')).toBe(10_000_000n);
		expect(parseAmountToMicro('10.5')).toBe(10_500_000n);
		expect(parseAmountToMicro('0.00421')).toBe(4_210n);
		expect(parseAmountToMicro('0.004211')).toBe(4_211n);
		expect(parseAmountToMicro(' 12.34 ')).toBe(12_340_000n);
		expect(parseAmountToMicro('-5.5')).toBe(-5_500_000n);
		expect(parseAmountToMicro('0')).toBe(0n);
	});
	it('rejects sub-micro precision and unparseable input instead of rounding', () => {
		expect(parseAmountToMicro('0.0042111')).toBeNull();
		expect(parseAmountToMicro('1e3')).toBeNull();
		expect(parseAmountToMicro('abc')).toBeNull();
		expect(parseAmountToMicro('')).toBeNull();
		expect(parseAmountToMicro('.5')).toBeNull();
		expect(parseAmountToMicro('1,000')).toBeNull();
	});
});
