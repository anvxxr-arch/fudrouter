// Shared onboarding helpers.
//
// Every `onboard-*.mjs` script upserts a provider row. They used to each write
// their own `on conflict ... do update set status = excluded.status`, which
// silently re-enabled a provider an operator had deliberately disabled in the
// console: re-running onboarding flipped status back to whatever the script's
// default happened to be, with no log line saying so.
//
// The rule this module encodes: **`provider.status` belongs to the operator,
// not to the script.** A script may set it when it *creates* the row, and may
// set it on an existing row only when the operator asks for that explicitly
// with a `*_PROVIDER_STATUS` env var. Re-running onboarding is a credential
// refresh, not a policy change.

const VALID_STATUSES = ['active', 'dev', 'disabled'];

export type ProviderStatus = (typeof VALID_STATUSES)[number];

/**
 * Resolve the status an onboarding script should apply.
 *
 * @param envVar  e.g. `INFERHUB_PROVIDER_STATUS`. When set (and non-empty), the
 *   operator is explicitly overriding status, so the script writes it even onto
 *   an existing row. When unset, `isExplicit` is false and the caller must keep
 *   the stored status, while `value` still seeds a brand-new row.
 * @param insertStatus  status for a row that does not exist yet. Matches the
 *   `provider.status` column default so a fresh row is identical either way.
 */
export function resolveStatus(
	envVar: string,
	insertStatus: string = 'active'
): { value: string; isExplicit: boolean } {
	const raw = process.env[envVar];
	if (raw === undefined) return { value: insertStatus, isExplicit: false };
	const trimmed = raw.trim();
	if (!trimmed) return { value: insertStatus, isExplicit: false };
	return { value: trimmed, isExplicit: true };
}

/**
 * Validate a status before it reaches SQL, so a typo fails loudly instead of
 * writing a value the router does not understand. `provider.status` is a plain
 * `text` column with no CHECK constraint, which is why this has to happen here.
 */
export function assertValidStatus(value: string, envVar: string): string {
	if (!VALID_STATUSES.includes(value)) {
		throw new Error(
			`${envVar}="${value}" is not a valid provider status. Use one of: ${VALID_STATUSES.join(', ')}`
		);
	}
	return value;
}

/**
 * Build the `on conflict ... do update` clause for a provider upsert.
 *
 * `id` and `name` differ across scripts (some key on a stable slug, some on a
 * generated UUID with `on conflict (name)`), so the caller passes the conflict
 * target. Only `status` is conditional: every other field is owned and refreshed
 * by the script.
 */
export function providerUpsertConflict(
	conflictTarget: 'id' | 'name',
	status: string,
	isExplicit: boolean
): string {
	const sets = [
		'name = excluded.name',
		'base_url = excluded.base_url',
		'credentials_enc = excluded.credentials_enc',
		'priority = excluded.priority'
	];
	// Only an explicit operator override may rewrite an existing status.
	if (isExplicit) sets.push('status = excluded.status');
	return `on conflict (${conflictTarget}) do update set ${sets.join(', ')}`;
}

/**
 * Log suffix stating plainly whether the run touched status, so a status change
 * is never silent — the exact failure this module exists to prevent.
 */
export function statusLogSuffix(status: string, isExplicit: boolean): string {
	return `status=${status} (${isExplicit ? 'explicit override' : 'preserved'})`;
}
