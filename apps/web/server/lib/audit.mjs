// The /api/admin/audit view shaper and the raw-SQL audit writer.
//
// Redaction is the platform's canonical `redactSecrets`, re-exported through
// ./platform-ts.mjs: one rule for the write path, the read path and the workers.
// This file used to carry TWO local copies of the regex and they had already
// drifted from each other -- `makeAudit` matched a bare lowercase
// `api_key`/`authorization`, so a metadata key spelled `Authorization` was
// PERSISTED unredacted while the same value was hidden on read. The canonical
// rule is case-insensitive and still leaves reference keys (`api_key_id`,
// `authorization_url`) intact, because which key acted is audit content.
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { _sanitizeAudit, _dropRedacted } from './platform-ts.mjs';

export { _sanitizeAudit, _dropRedacted };

export const _auditView = (row) => ({ ...row, before: row.before ? _dropRedacted(_sanitizeAudit(row.before)) : null, after: row.after ? _dropRedacted(_sanitizeAudit(row.after)) : null, metadata: _dropRedacted(_sanitizeAudit(row.metadata ?? {})) });

// makeAudit(ipStore) returns the _audit writer with the same (dbx, entry)
// signature the admin handlers already use, so no call site changes. ipStore
// is the request-scoped AsyncLocalStorage holding the client IP.
export function makeAudit(ipStore) {
	return async (dbx, entry) => {
		const redact = _sanitizeAudit;
		await dbx.execute(sql`insert into audit_log (id, actor_user_id, actor_kind, action, resource, resource_id, ip, before, after, metadata) values (${'aud_' + uuidv7()}, ${entry.actorUserId ?? null}, ${entry.actorUserId ? 'user' : 'system'}, ${entry.action}, ${entry.resource}, ${entry.resourceId ?? null}, ${entry.ip ?? ipStore?.getStore?.() ?? null}, ${entry.before ? JSON.stringify(redact(entry.before)) : null}::jsonb, ${entry.after ? JSON.stringify(redact(entry.after)) : null}::jsonb, ${JSON.stringify(redact(entry.metadata ?? {}))}::jsonb)`);
	};
}
