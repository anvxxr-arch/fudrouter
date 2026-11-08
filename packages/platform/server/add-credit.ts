/**
 * Manual add-credit (top-up) validation and idempotency namespace.
 *
 * The two manual top-up surfaces — the member's self-serve
 * `/api/pages/billing/credits/add` and the admin's `/api/admin/billing/credit`
 * — must agree on one rule for "is this a real, sane credit amount". This module
 * is that rule; the two .mjs writers call it through the platform-ts bridge so a
 * drift cannot re-introduce the pre-bigint placeholder that minted 5.55e18 µUSD
 * on a single posting (ops/scrub-balance-anomaly.sql §Root cause).
 *
 * Why a bound exists at all: the amount reaches `credit_ledger.amount_micro
 * bigint`, and one account's SUM(amount_micro) is cast to bigint in
 * reconcileAll (billing.ts). An unbounded manual credit is the exact vector that
 * produced the two corrupt postings whose account SUM exceeded int64 (1.11e19).
 * The ceiling keeps a single account's balance plausible and, more importantly,
 * keeps the ledger sum castable.
 *
 * Why the ceiling is a shared constant rather than two inline literals: the same
 * threshold decides the scrub report (ops/scrub-balance-anomaly.sql REPORT 1/2,
 * `amount_micro > 1000000000000`). One constant, imported by both writers, is the
 * single source of truth in code; the SQL keeps the literal because it cannot
 * import TypeScript, and this header is the cross-reference that keeps them equal.
 */
import { parseAmountToMicro } from './money.ts';

/** $1M in micro-USD. Must equal the scrub threshold `1000000000000`. */
export const MAX_ADD_CREDIT_MICRO = 1_000_000_000_000n;

/**
 * Idempotency namespace for manual top-ups. `purchase:` is reserved for the
 * payment gateway (FR-revised §S5), so the admin/member placeholder that used to
 * write `purchase:<uuid>` now writes `admin_credit:<uuid>`. Backfill of the old
 * rows lives in backend/go/migrations/0036_admin_credit_namespace.sql.
 */
export const ADD_CREDIT_KEY_PREFIX = 'admin_credit:';

/** The durable idempotency key for a manual top-up ledger entry. */
export function addCreditKey(entryId: string): string {
	return `${ADD_CREDIT_KEY_PREFIX}${entryId}`;
}

/**
 * Idempotency namespaces a manual top-up must not claim. `purchase:` belongs to
 * the payment gateway and `usage:` to the metered charge path; a client-supplied
 * key under either could collide with their durable unique index and silently
 * drop a real posting.
 */
export const RESERVED_IDEMPOTENCY_NAMESPACES = ['purchase:', 'usage:'] as const;

export type AddCreditAmountError = 'invalid_amount' | 'not_positive' | 'ceiling_exceeded';

export type AddCreditAmountResult =
	| { ok: true; amountMicro: bigint }
	| { ok: false; error: AddCreditAmountError };

const ADD_CREDIT_ERRORS: Record<AddCreditAmountError, { code: string; message: string }> = {
	invalid_amount: {
		code: 'ADD_CREDIT_INVALID_AMOUNT',
		message: 'Enter a positive dollar amount, e.g. 100 or 25.50.'
	},
	not_positive: {
		code: 'ADD_CREDIT_NOT_POSITIVE',
		message: 'Amount must be greater than zero.'
	},
	ceiling_exceeded: {
		code: 'ADD_CREDIT_CEILING_EXCEEDED',
		message: 'Amount exceeds the $1,000,000 manual credit ceiling.'
	}
};

/** The machine-readable code + human message for a rejected add-credit amount. */
export function addCreditError(error: AddCreditAmountError): { code: string; message: string } {
	return ADD_CREDIT_ERRORS[error];
}

/**
 * Validate a human-entered top-up amount. Returns the parsed micro-units on
 * success, or a typed reason on failure. A NULL parse, a non-positive amount and
 * an over-ceiling amount are three distinct rejections so both surfaces report
 * the same code and never fall back to a default 0.
 */
export function validateAddCreditAmount(input: unknown): AddCreditAmountResult {
	const amountMicro = parseAmountToMicro(input);
	if (amountMicro === null) return { ok: false, error: 'invalid_amount' };
	if (amountMicro <= 0n) return { ok: false, error: 'not_positive' };
	if (amountMicro > MAX_ADD_CREDIT_MICRO) return { ok: false, error: 'ceiling_exceeded' };
	return { ok: true, amountMicro };
}

export type AddCreditKeyError = 'reserved_namespace';

export type AddCreditKeyResult =
	| { ok: true; key: string }
	| { ok: false; error: AddCreditKeyError };

const ADD_CREDIT_KEY_ERRORS: Record<AddCreditKeyError, { code: string; message: string }> = {
	reserved_namespace: {
		code: 'ADD_CREDIT_RESERVED_KEY',
		message: 'That idempotency key namespace is reserved for another writer.'
	}
};

/** The machine-readable code + human message for a rejected add-credit key. */
export function addCreditKeyError(error: AddCreditKeyError): { code: string; message: string } {
	return ADD_CREDIT_KEY_ERRORS[error];
}

/**
 * A manual top-up may mint only its own namespace. Reject a caller-supplied key
 * claiming a reserved one, so the gateway/usage writers never silently drop.
 */
export function validateAddCreditKey(key: string): AddCreditKeyResult {
	if (RESERVED_IDEMPOTENCY_NAMESPACES.some((ns) => key.startsWith(ns))) {
		return { ok: false, error: 'reserved_namespace' };
	}
	return { ok: true, key };
}