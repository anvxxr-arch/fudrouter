// Audit redaction, the /api/admin/audit view shaper, and the raw-SQL audit
// writer. Extracted verbatim from server/admin.mjs. The redaction regex is
// identical to index.mjs's redactSecrets — do not diverge them.
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

export function _sanitizeAudit(v) { if (Array.isArray(v)) return v.map(_sanitizeAudit); if (v && typeof v === 'object') { const out = {}; for (const [k, x] of Object.entries(v)) { out[k] = (/secret|token|password|credentials?|key_hash/i.test(k) || /^(api_?key|authorization)$/i.test(String(k).toLowerCase())) ? '[redacted]' : _sanitizeAudit(x); } return out; } return v; }
export function _dropRedacted(v) { if (Array.isArray(v)) return v.map(_dropRedacted); if (v && typeof v === 'object') { const out = {}; for (const [k, x] of Object.entries(v)) { if (x === '[redacted]') continue; out[k] = _dropRedacted(x); } return out; } return v; }
export const _auditView = (row) => ({ ...row, before: row.before ? _dropRedacted(_sanitizeAudit(row.before)) : null, after: row.after ? _dropRedacted(_sanitizeAudit(row.after)) : null, metadata: _dropRedacted(_sanitizeAudit(row.metadata ?? {})) });

// makeAudit(ipStore) returns the _audit writer with the same (dbx, entry)
// signature the admin handlers already use, so no call site changes. ipStore
// is the request-scoped AsyncLocalStorage holding the client IP.
export function makeAudit(ipStore) {
	const redact = (v) => {
		if (Array.isArray(v)) return v.map(redact);
		if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = (/secret|token|password|key_hash|credentials?/i.test(k) || k === 'api_key' || k === 'authorization') ? '[redacted]' : redact(x); return o; }
		return v;
	};
	return async (dbx, entry) => {
		await dbx.execute(sql`insert into audit_log (id, actor_user_id, actor_kind, action, resource, resource_id, workspace_id, ip, before, after, metadata) values (${'aud_' + uuidv7()}, ${entry.actorUserId ?? null}, ${entry.actorUserId ? 'user' : 'system'}, ${entry.action}, ${entry.resource}, ${entry.resourceId ?? null}, ${entry.workspaceId ?? null}, ${entry.ip ?? ipStore?.getStore?.() ?? null}, ${entry.before ? JSON.stringify(redact(entry.before)) : null}::jsonb, ${entry.after ? JSON.stringify(redact(entry.after)) : null}::jsonb, ${JSON.stringify(redact(entry.metadata ?? {}))}::jsonb)`);
	};
}
