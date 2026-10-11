// apps/web/server/lib/platform-ts.mjs — runtime bridge from the plain-JS
// Express server to the TypeScript modules in packages/platform/server/.
//
// Why this exists: the server is untyped .mjs (tsconfig covers src/ only) while
// the canonical security logic (SSRF guard, AES credential envelope, id
// prefixes, validators) lives in packages/platform/*.ts. Node >= 22 strips the
// types natively, so the server imports the canonical modules instead of
// carrying local copies.
//
// The bridge re-exports the shared symbols under the `_`-prefixed names the
// server already uses, so call sites do not change. Where the shared API
// differs in shape (tokenAt/headersFor live in provider-credentials.ts, not
// credentials.ts), the bridge adapts — the adaptation is HERE, in one place,
// not smeared across four server files.
// The imports below go through the package's exports map, not a relative path:
// @fudrouter/platform is a real workspace package, so plain node resolves it the
// same way it resolves any other dependency.
const ssrf = await import('@fudrouter/platform/server/ssrf.ts');
const creds = await import('@fudrouter/platform/server/credentials.ts');
const provCreds = await import('@fudrouter/platform/server/provider-credentials.ts');
const ids = await import('@fudrouter/platform/server/id.ts');
const audit = await import('@fudrouter/platform/server/audit.ts');
const rbac = await import('@fudrouter/platform/rbac');
const vkmod = await import('@fudrouter/platform/server/vk.ts');

// SSRF: the platform module OWNS the rule, including the literal blocklist --
// isBlockedIp and the range arithmetic are re-exported below for the request
// path (server/lib/ip.mjs) and the tests. An earlier version of this comment
// claimed the shared rule and the console's local copy were equivalent; they
// were not. The shared list was the shorter one and accepted 23 addresses the
// console's refused, NAT64/6to4 spellings of the metadata address among them.
// The console's list is now IN the platform module, so there is one rule and
// nothing to keep in sync.
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
// The literal blocklist itself, re-exported so the request path and the tests
// reach exactly the implementation the guard uses.
export const isBlockedIp = ssrf.isBlockedIp;
export const _parseV6 = ssrf.parseV6;
export const _ipv4ToBig = ssrf.ipv4ToBig;
export const _ipv4BlockedBig = ssrf.ipv4BlockedBig;
export const _ipv6BlockedBig = ssrf.ipv6BlockedBig;

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

// Valkey: the shared ioredis client (packages/platform/server/vk.ts). It owns
// VALKEY_URL, lazy connect and the degrade-open policy; vk() returns null when
// Valkey is not deployed, which is the "disabled" branch the call sites want.
// The console adds only the per-call deadline the client deliberately does not
// set (a shared commandTimeout would change the workers' and scheduler's too).
export const _vk = () => vkmod.vk();

// RBAC: the role -> capability table is the platform's (@fudrouter/platform/rbac),
// the same object the SPA's route guards import. Re-exported under the plain names
// server/lib/rbac.mjs has always exported, so admin.mjs, index.mjs and
// src/lib/caps.ts all read one table -- a UI that gates on a table the API does
// not enforce shows controls that 403.
export const ROLE_CAPS = rbac.ROLE_CAPS;
export const capsFor = rbac.capsFor;

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
void net;
