/**
 * Audit rows as the admin audit-log page shows them (PRD §71, §137).
 *
 * `writeAudit` already redacts secret-looking keys at WRITE time (the value is
 * replaced with `[redacted]`), but its regex misses `api_key`, and the read
 * path cannot rely on every historical row having been written by the current
 * writer. So the display projection sanitises with its own, BROADER key list
 * and then drops the redacted keys entirely: an audit row is a support artifact
 * that gets exported and screenshotted, and a key literally named `secret` —
 * even carrying `[redacted]` — invites the reader to go looking for its value.
 * The page shows what changed, never the change to a secret.
 *
 * Pure and synchronous so the boundary is testable without a database.
 */
import { redactSecrets, REDACTED } from './audit';

export interface AuditRowView {
	id: string;
	actorUserId: string | null;
	actorKind: string;
	action: string;
	resource: string;
	resourceId: string | null;
	workspaceId: string | null;
	ip: string | null;
	before: Record<string, unknown> | null;
	after: Record<string, unknown> | null;
	metadata: Record<string, unknown> | unknown;
	createdAt: Date | string;
}

/**
 * Secret-VALUE keys, aligned with `audit.ts`'s write-time rule after WebCore's
 * fix: broad substrings (`secret|token|password|credentials?|key_hash`) plus an
 * exact-match layer for `api_key`/`apikey`/`authorization`. The exact layer
 * exists so reference keys (`api_key_id`, `authorization_url`) survive — which
 * key acted is audit content, not a secret.
 */
const SECRET_SUBSTRING_RE = /secret|token|password|credentials?|key_hash/i;
const SECRET_EXACT_RE = /^(api_?key|authorization)$/i;

function sanitize<T>(value: T): T {
	if (Array.isArray(value)) return value.map((v) => sanitize(v)) as T;
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] =
				SECRET_SUBSTRING_RE.test(k) || SECRET_EXACT_RE.test(k.toLowerCase())
					? REDACTED
					: sanitize(v);
		}
		return out as T;
	}
	return value;
}

/** Recursively drop entries whose value is a redaction marker. */
function dropRedacted<T>(value: T): T {
	if (Array.isArray(value)) return value.map((v) => dropRedacted(v)) as T;
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (v === REDACTED) continue;
			out[k] = dropRedacted(v);
		}
		return out as T;
	}
	return value;
}

/** Sanitise one audit row: redact any secret that slipped in, then drop the keys. */
export function auditRowForDisplay<T extends AuditRowView>(row: T): T {
	return {
		...row,
		before: row.before ? dropRedacted(sanitize(redactSecrets(row.before))) : null,
		after: row.after ? dropRedacted(sanitize(redactSecrets(row.after))) : null,
		metadata: dropRedacted(sanitize(redactSecrets(row.metadata ?? {})))
	};
}

/** Sanitise a page of audit rows. */
export function auditRowsForDisplay<T extends AuditRowView>(rows: readonly T[]): T[] {
	return rows.map((r) => auditRowForDisplay(r));
}
