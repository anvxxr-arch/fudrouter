/**
 * Credential projection rules (PRD §55–56).
 *
 * `credential.secret_enc` is the only secret store on this table and there is
 * exactly ONE shape allowed to carry a plaintext secret: `SecretShownOnce`,
 * returned by the create action's response and never persisted or re-read.
 * Every read path goes through `credentialForDisplay`, which drops the
 * ciphertext entirely — not masks it, drops it — so no page, export or test
 * fixture can accidentally become a secret oracle.
 *
 * Pure so the projection rule is testable without a database.
 */
export interface CredentialRow {
	id: string;
	connectionId: string;
	name: string;
	secretEnc?: string | null;
	status: string;
	priority: number;
	weight: number;
	lastUsedAt?: Date | string | null;
	lastSuccessAt?: Date | string | null;
	lastErrorAt?: Date | string | null;
	cooldownUntil?: Date | string | null;
	metadata?: Record<string, unknown> | null;
	createdAt?: Date | string | null;
	updatedAt?: Date | string | null;
}

/** Everything on a credential EXCEPT its secret. */
export type CredentialDisplay = Omit<CredentialRow, 'secretEnc'>;

/**
 * The single secret-bearing shape: minted by the create action, shown once in
 * its response, and never derivable from stored state afterwards.
 */
export interface SecretShownOnce {
	shownOnce: true;
	id: string;
	name: string;
	secret: string;
}

export function secretShownOnce(id: string, name: string, secret: string): SecretShownOnce {
	return { shownOnce: true, id, name, secret };
}

/** Project a stored row for any display path: the ciphertext never survives. */
export function credentialForDisplay<T extends CredentialRow>(row: T): CredentialDisplay {
	const { secretEnc: _dropped, ...rest } = row;
	return rest;
}

/**
 * Credential Pool buckets (PRD §55): Total / Healthy / Rate Limited / Cooldown
 * / Invalid / Disabled. `auth_failed` and `invalid` both mean "the secret is
 * not working" and land in Invalid; `unknown` is kept apart rather than being
 * counted healthy, because an unproven credential must not look available.
 */
export const POOL_BUCKETS = [
	'Healthy',
	'Rate Limited',
	'Cooldown',
	'Invalid',
	'Disabled',
	'Unknown'
] as const;
export type PoolBucket = (typeof POOL_BUCKETS)[number];

const STATUS_TO_BUCKET: Record<string, PoolBucket> = {
	healthy: 'Healthy',
	rate_limited: 'Rate Limited',
	cooldown: 'Cooldown',
	auth_failed: 'Invalid',
	invalid: 'Invalid',
	disabled: 'Disabled',
	unknown: 'Unknown'
};

export interface PoolSummary {
	total: number;
	buckets: Record<PoolBucket, number>;
}

/** Bucket every credential status into the pool dashboard's counters. */
export function credentialPool(rows: readonly { status: string }[]): PoolSummary {
	const buckets = Object.fromEntries(POOL_BUCKETS.map((b) => [b, 0])) as Record<PoolBucket, number>;
	for (const row of rows) {
		buckets[STATUS_TO_BUCKET[row.status] ?? 'Unknown'] += 1;
	}
	return { total: rows.length, buckets };
}
