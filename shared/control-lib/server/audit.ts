import type { PgDatabase } from 'drizzle-orm/pg-core';
import type { PostgresJsQueryResultHKT } from 'drizzle-orm/postgres-js';
import { auditLog } from './db/schema';
import { newId, ID_PREFIXES } from './id';

/**
 * Anything that can run queries: the drizzle `db` singleton or a transaction
 * handle (PgTransaction extends PgDatabase). Shared so every audit/billing
 * writer takes one consistent type.
 */
export type DbTx = PgDatabase<PostgresJsQueryResultHKT, any, any>;

/**
 * Audit log writer (spec §11, PRD §71/§137).
 *
 * Append-only in application code. Secrets are NEVER stored in
 * before/after/metadata — every key that looks like a secret is redacted at
 * write time, because an audit row is a support artifact that gets exported,
 * screenshotted and pasted into tickets.
 */

export type ActorKind = 'user' | 'system' | 'api_key';

export interface AuditEntry {
	actorUserId?: string | null;
	actorKind?: ActorKind;
	action: string;
	resource: string;
	resourceId?: string | null;
	workspaceId?: string | null;
	ip?: string | null;
	before?: Record<string, unknown> | null;
	after?: Record<string, unknown> | null;
	metadata?: Record<string, unknown>;
}

/**
 * Spec §11: keys matching /secret|token|password|key_hash|credentials?/i are
 * redacted (nested objects and arrays included). The exact-match additions
 * cover secret-bearing keys the spec regex names no substring of — a raw
 * `api_key`/`authorization` value must never persist — while leaving
 * REFERENCE keys (`api_key_id`, `authorization_url`) intact, since which key
 * acted is audit content, not a secret.
 */
const SECRET_KEY_RE = /secret|token|password|key_hash|credentials?/i;
const SECRET_KEY_EXACT_RE = /^(api_?key|authorization)$/i;
export const REDACTED = '[redacted]';

export function redactSecrets<T>(value: T): T {
	if (Array.isArray(value)) return value.map((v) => redactSecrets(v)) as T;
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] = SECRET_KEY_RE.test(k) || SECRET_KEY_EXACT_RE.test(k) ? REDACTED : redactSecrets(v);
		}
		return out as T;
	}
	return value;
}

/**
 * Write one audit row. The IP comes from `entry.ip` only — the caller owns it
 * (the Express layer reads `clientIp(req)`; jobs/system actors have none), so
 * there is no ambient request scope to fall back on here.
 */
export async function writeAudit(dbtx: DbTx, entry: AuditEntry): Promise<void> {
	const ip = entry.ip ?? null;
	await dbtx.insert(auditLog).values({
		id: newId(ID_PREFIXES.auditLog),
		actorUserId: entry.actorUserId ?? null,
		actorKind: entry.actorKind ?? (entry.actorUserId ? 'user' : 'system'),
		action: entry.action,
		resource: entry.resource,
		resourceId: entry.resourceId ?? null,
		workspaceId: entry.workspaceId ?? null,
		ip,
		before: entry.before ? redactSecrets(entry.before) : null,
		after: entry.after ? redactSecrets(entry.after) : null,
		metadata: redactSecrets(entry.metadata ?? {})
	});
}
