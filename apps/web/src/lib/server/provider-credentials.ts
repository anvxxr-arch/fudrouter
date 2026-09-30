/**
 * Credential handling for the admin console.
 *
 * A provider's credential blob is decrypted server-side and never sent to the
 * page. What the page may see is a label per credential — enough to tell accounts
 * apart in a dropdown — and nothing else. Everything that touches a secret lives
 * here so that invariant has one home instead of being re-derived at each call
 * site.
 *
 * The blob is not a fixed shape: a single-key provider carries `api_key`, a
 * multi-credential (pooled) provider carries `accounts[]` where each entry has
 * either `access_token` (OAuth, refreshed by the data plane) or `api_key`
 * (static). The data plane's own reader is
 * `services/router/internal/proxy/pool.go`; these helpers mirror just enough of
 * it for the console to talk to an upstream the same way the router would.
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
	if (accounts.length === 0) return [{ label: 'single key', index: 0 }];
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
	return String(account?.access_token || account?.api_key || cred.api_key || '');
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
