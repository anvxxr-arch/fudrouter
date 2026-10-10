// apps/react-web/server/lib/shared-ts.mjs — runtime bridge from the plain-JS
// Express server to the TypeScript modules in shared/control-lib/server/.
//
// Why this exists: the server is untyped .mjs (tsconfig covers src/ only) while
// the canonical security logic (SSRF guard, AES credential envelope, id
// prefixes, validators) lives in shared/*.ts. Node >= 22 strips types natively
// (verified: `node --input-type=module < import('shared/.../id.ts')` resolves),
// and scripts/ts-hooks.mjs already uses the same mechanism for workers — so
// the server can import the canonical modules instead of carrying local copies.
//
// The bridge re-exports the shared symbols under the `_`-prefixed names the
// server already uses, so call sites do not change. Where the shared API
// differs in shape (tokenAt/headersFor live in provider-credentials.ts, not
// credentials.ts), the bridge adapts — the adaptation is HERE, in one place,
// not smeared across four server files.
import { installTsHooks } from '../../../../scripts/ts-hooks.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptRoot = fileURLToPath(new URL('../../../../scripts/', import.meta.url));
const { libRoot } = installTsHooks(scriptRoot);
const libUrl = (sub) => pathToFileURL(fileURLToPath(new URL(`../../../../shared/control-lib/${sub}`, import.meta.url))).href;

const ssrf = await import(libUrl('server/ssrf.ts'));
const creds = await import(libUrl('server/credentials.ts'));
const provCreds = await import(libUrl('server/provider-credentials.ts'));
const ids = await import(libUrl('server/id.ts'));
const audit = await import(libUrl('server/audit.ts'));

// SSRF: shared isBlockedLiteral + assertPublicUpstream carry the same rule as
// the local _isBlockedLiteral/_assertPublic (IANA special-use + intranet TLDs
// + every-record DNS check). The local copy additionally trims brackets and
// trailing dots; normalize here so behavior is identical.
import net from 'node:net';
export function _isBlockedLiteral(host) {
  const h = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h) return true;
  // DNS-name bar (shared isBlockedLiteral is IP-only by design; names resolve
  // in assertPublicUpstream). localhost / intranet TLDs never reach DNS.
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa')) return true;
  const bare = h.includes('%') ? h.slice(0, h.indexOf('%')) : h;
  if (net.isIP(bare)) return ssrf.isBlockedLiteral(bare);
  return false;
}
export async function _assertPublic(rawUrl, allowPrivate = false) {
	const r = await ssrf.assertPublicUpstream(rawUrl, allowPrivate);
	return r.ok ? { ok: true } : { ok: false, reason: r.reason };
}

// Credentials: byte-identical AES-256-GCM envelope (iv[12]||ct||tag[16]).
export const _encCred = (plain) => creds.encryptCredentials(plain);
export const _decCred = (enc) => creds.decryptCredentials(enc);
// Token/header helpers live in provider-credentials.ts (flat + pooled forms).
export const _tokenAt = (cred, i) => provCreds.tokenAt(cred, i);
export function _headersFor(cred, token) {
	const h = { ...((cred.default_headers ?? {})) };
	if (token) h.authorization = `Bearer ${token}`;
	return h;
}

// IDs: single canonical prefix table.
export const ID_PREFIXES = ids.ID_PREFIXES;
export const newId = (prefix) => ids.newId(prefix);

// Audit redaction: shared redactSecrets covers the same key vocabulary
// (secret|token|password|key_hash|credentials? + exact api_key/authorization).
export const _sanitizeAudit = (v) => audit.redactSecrets(v);
export function _dropRedacted(v) {
	if (Array.isArray(v)) return v.map(_dropRedacted);
	if (v && typeof v === 'object') {
		const out = {};
		for (const [k, x] of Object.entries(v)) {
			if (x === '[redacted]') continue;
			out[k] = _dropRedacted(x);
		}
		return out;
	}
	return v;
}

export { libRoot };
void net;
