/**
 * Request status vocabulary and content-retention state (spec §8, PRD §93–94).
 *
 * Pure rules only — no db, no env. The spec §8 taxonomy is canonical; rows the
 * S0 router wrote carry `success`/`error`/`upstream_error` and those values are
 * still in the live tables (measured 2026-09-30 in `fudrouter_scratch`: 3
 * `error`, 13 `upstream_error`, 14 `success`), so every read maps them for
 * display and every filter expands to its stored forms. `request_log` is never
 * rewritten here — its value migration belongs to a later migration (spec §0).
 */

/** Spec §8 taxonomy — the only statuses new rows may carry. */
export const REQUEST_STATUSES = [
	'success',
	'client_error',
	'provider_error',
	'timeout',
	'rate_limited',
	'cancelled',
	'internal_error'
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** Values `request_log.status` may hold in the wild besides the taxonomy. */
export const LEGACY_STATUS_VALUES = ['error', 'upstream_error'] as const;
export type StoredStatus = RequestStatus | (typeof LEGACY_STATUS_VALUES)[number];

const STATUS_MAP: Record<StoredStatus, RequestStatus> = {
	success: 'success',
	client_error: 'client_error',
	provider_error: 'provider_error',
	timeout: 'timeout',
	rate_limited: 'rate_limited',
	cancelled: 'cancelled',
	internal_error: 'internal_error',
	// S0 `error` was any terminal failure logged before the taxonomy existed;
	// the non-upstream ones were credential/config failures on our side.
	// `upstream_error` is by definition the upstream's fault.
	error: 'internal_error',
	upstream_error: 'provider_error'
};

const UNKNOWN_STATUS: RequestStatus = 'internal_error';

/** Map any stored status to its taxonomy value. Unknown strings fail closed. */
export function normalizeStatus(stored: string): RequestStatus {
	return STATUS_MAP[stored as StoredStatus] ?? UNKNOWN_STATUS;
}

/**
 * Every stored form of a taxonomy status — what a filter must match. Selecting
 * `provider_error` must surface the `upstream_error` rows that mean the same
 * thing; `internal_error` likewise covers legacy `error`.
 */
export function statusFilterValues(s: RequestStatus): StoredStatus[] {
	switch (s) {
		case 'provider_error':
			return ['provider_error', 'upstream_error'];
		case 'internal_error':
			return ['internal_error', 'error'];
		default:
			return [s];
	}
}

export type BadgeTone = 'success' | 'danger' | 'warning' | 'neutral';

/** Badge tone per taxonomy status. Colour + word, never colour alone. */
export function statusTone(s: RequestStatus): BadgeTone {
	switch (s) {
		case 'success':
			return 'success';
		case 'timeout':
		case 'rate_limited':
			return 'warning';
		case 'cancelled':
			return 'neutral';
		default:
			return 'danger';
	}
}

// ------------------------------------------------------- error taxonomy ---

/** Spec §8 error codes, exactly. Raw upstream text goes in `error`, never here. */
export const ERROR_CODES = [
	'AUTHENTICATION_ERROR',
	'AUTHORIZATION_ERROR',
	'RATE_LIMITED',
	'INSUFFICIENT_CREDITS',
	'INVALID_REQUEST',
	'MODEL_NOT_FOUND',
	'CONTEXT_TOO_LONG',
	'UNSUPPORTED_PARAMETER',
	'CONTENT_REJECTED',
	'PROVIDER_TIMEOUT',
	'PROVIDER_UNAVAILABLE',
	'CIRCUIT_OPEN',
	'UPSTREAM_ERROR',
	'INTERNAL_ERROR'
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Retryability of a normalized error (spec §9): transient upstream trouble may
 * retry/fallback; a rejected request never does. `UPSTREAM_ERROR` retries only
 * on 5xx/429/401/403 — `httpStatus` disambiguates, absent status fails closed
 * to retryable=false so a bare `UPSTREAM_ERROR` never triggers a retry storm.
 */
export function errorRetryable(code: string | null, httpStatus: number | null): boolean {
	switch (code) {
		case 'RATE_LIMITED':
		case 'PROVIDER_TIMEOUT':
		case 'PROVIDER_UNAVAILABLE':
		case 'CIRCUIT_OPEN':
			return true;
		case 'UPSTREAM_ERROR':
			return httpStatus != null && [401, 403, 429].includes(httpStatus) || (httpStatus != null && httpStatus >= 500);
		default:
			return false;
	}
}

// --------------------------------------------------------- retention gate ---

export type RetentionPolicy = {
	request_metadata_days: number;
	request_content_days: number;
	system_events_days: number;
	audit_logs_days: number;
} | null;

/**
 * May raw prompt/response bodies be SHOWN (PRD §93–94)? Content capture is
 * opt-in: `request_content_days <= 0` means content is never retained, and a
 * row can only show content while it is inside the retention window. Metadata
 * is unaffected — this gate is about the two body columns only.
 */
export function contentRetained(
	policy: RetentionPolicy,
	body: { requestBody: string | null; responseBody: string | null },
	rowCreatedAt: Date,
	now: Date
): boolean {
	if (!policy) return false;
	const days = policy.request_content_days;
	if (!(days > 0)) return false;
	if (!body.requestBody && !body.responseBody) return false;
	return rowCreatedAt.getTime() > now.getTime() - 86_400_000 * days;
}

/** Explicit UI states for the content block — never a silent blank. */
export type ContentState = 'shown' | 'not_retained' | 'not_captured';

export function contentState(
	policy: RetentionPolicy,
	row: { requestBody: string | null; responseBody: string | null; createdAt: Date },
	now: Date
): ContentState {
	if (!row.requestBody && !row.responseBody) {
		// Nothing was stored for this row either because capture is off or because
		// the writer did not send bodies — both render as "not captured", while a
		// policy that forbids content must still say why the block is empty.
		return policy && policy.request_content_days > 0 ? 'not_captured' : 'not_retained';
	}
	return contentRetained(policy, row, row.createdAt, now) ? 'shown' : 'not_retained';
}
