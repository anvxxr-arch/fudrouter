/**
 * Credential handling for the admin console.
 *
 * A provider's credential blob is decrypted server-side and never sent to the
 * page. What the page may see is a label per credential — enough to tell accounts
 * apart in a dropdown — and nothing else. Everything that touches a secret lives
 * here so that invariant has one home instead of being re-derived at each call
 * site.
 *
 * The blob is not a fixed shape. A single-key provider carries `api_key`. A
 * pooled provider carries `accounts[]`. But the common case in this table is a
 * ONE-ACCOUNT blob stored FLAT at the top level —
 * `{email,access_token,refresh_token,id_token,expired}` — because spec §4
 * defines one account = one credential row, and that flat form is exactly what
 * the data plane writes (`pool.go` `marshalAccount`) and reads back
 * (`targets.go` `accountFromSecret`). Every reader here must therefore accept
 * both the flat and the pooled form; a reader that only understands
 * `accounts[]` silently produces an empty token for the entire table.
 *
 * The data plane's own reader is `services/router/internal/proxy/pool.go`;
 * these helpers mirror just enough of it for the console to talk to an upstream
 * the same way the router would.
 */
import type { Credentials } from '$lib/server/credentials';

/** One credential inside a pooled blob. */
export interface Account {
	email?: string;
	api_key?: string;
	access_token?: string;
}

/**
 * A label per credential, safe to render.
 *
 * The page needs to distinguish accounts in a selector, and an account is
 * identified by its email. Where there is no email (a static key), the index is
 * the label. A blob with no `accounts` is a single key and gets exactly one
 * entry, so a selector built from this always has something to show.
 */
export function credentialLabels(cred: Credentials): { label: string; index: number }[] {
	const accounts = Array.isArray(cred.accounts) ? (cred.accounts as Account[]) : [];
	if (accounts.length === 0) {
		// A one-account row is stored flat, so its identity is the top-level
		// email; "single key" is only right for a blob with nothing but `api_key`.
		const email = cred.email;
		return [{ label: email ? String(email) : 'single key', index: 0 }];
	}
	return accounts.map((a, i) => ({ label: String(a.email ?? `key #${i + 1}`), index: i }));
}

/**
 * The token a given credential index authenticates with.
 *
 * `access_token` first because an OAuth pool's live credential is the token, not
 * the key. Falls back to the blob's single `api_key` so a static provider still
 * works through the same index-0 path as a pool.
 */
export function tokenAt(cred: Credentials, index: number): string {
	const accounts = Array.isArray(cred.accounts) ? (cred.accounts as Account[]) : [];
	const account = accounts[index];
	// A credential row is ONE account stored FLAT — spec §4
	// {email,access_token,refresh_token,id_token,expired} — which is what the data
	// plane writes (pool.go marshalAccount) and reads back (targets.go
	// accountFromSecret). Reading only `accounts[]` returned an empty token for
	// every row in this table, so the console test, the catalog fetch and the
	// credential probe all sent NO Authorization header. A pooled blob still wins
	// when the index exists; the flat fields are the fallback.
	return String(account?.access_token || account?.api_key || cred.access_token || cred.api_key || '');
}

/**
 * True when the blob is an OAuth account whose access token is past its expiry.
 *
 * A probe cannot judge such a credential: the data plane refreshes it from
 * `refresh_token` on demand (see `poolAccount.token` in
 * `services/router/internal/proxy/pool.go`), so a 401 here means "the stale
 * access token was rejected", not "the account is dead". Recording that as
 * `auth_failed` is a false negative — and anything that skips parked
 * credentials would then skip a perfectly live account.
 */
export function isExpiredOAuth(cred: Credentials): boolean {
	const refresh = cred.refresh_token;
	if (!refresh) return false;
	const at = Date.parse(String(cred.expired ?? ''));
	return Number.isFinite(at) && at < Date.now();
}

/**
 * Headers for an upstream call: the stored `default_headers` plus auth.
 *
 * `default_headers` carries upstream requirements that are not auth — e.g. the
 * xAI Grok CLI proxy rejects every completion without `x-grok-client-version`.
 * The data plane folds them in the same way (see `reservedHeaders` in
 * `services/router/internal/proxy/proxy.go`, which also refuses to let a stored
 * header override Authorization).
 */
export function headersFor(cred: Credentials, token: string): Record<string, string> {
	const headers: Record<string, string> = {
		...((cred.default_headers as Record<string, string>) ?? {})
	};
	if (token) headers.authorization = `Bearer ${token}`;
	return headers;
}

/**
 * The native protocol this blob declares, or null for the plain [OI] wire.
 *
 * `openai` means "no special protocol" and is normalised away so callers can test
 * for null. Anything else (`freebuff`) needs a protocol-specific client the
 * sandbox does not have, so the page must say so rather than send a plain chat
 * the upstream will reject.
 */
export function nativeProtocol(cred: Credentials): string | null {
	const protocol = cred.Protocol ?? cred.protocol;
	return protocol && protocol !== 'openai' ? String(protocol) : null;
}
