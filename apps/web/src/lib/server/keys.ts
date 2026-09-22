import { createHash, randomBytes } from 'node:crypto';

// Wire format: sk-ar-<prefix>_<secret>. Only sha256(secret) is stored.
// This MUST stay byte-compatible with the Go data plane's internal/keys
// package — it re-parses and re-hashes every key this module mints.
const MARKER = 'sk-ar-';
const PREFIX_LEN = 8;
const SECRET_MIN = 16;

export function hashSecret(secret: string): string {
	return createHash('sha256').update(secret).digest('hex');
}

/**
 * 8-char key prefix, drawn from the base64url alphabet.
 *
 * base64url INCLUDES '_', which is the prefix/secret separator. A prefix that
 * contains one makes `parseApiKey` (and the Go data plane, which re-parses every
 * key this module mints) split at the wrong underscore — the prefix comes back
 * truncated — or reject the key outright when the underscore lands at index < 4.
 * That silently broke ~12% of minted keys, so redraw until the prefix is clean.
 * `randomBytes(6)` is exactly 8 base64url chars, so the length is fixed.
 */
function randomPrefix(): string {
	let prefix: string;
	do {
		prefix = randomBytes(6).toString('base64url');
	} while (prefix.includes('_'));
	// Loud, not silent: if the encoding ever changes length, fail here instead of
	// minting keys the data plane cannot parse.
	if (prefix.length !== PREFIX_LEN) {
		throw new Error(`key prefix length drifted: got ${prefix.length}, want ${PREFIX_LEN}`);
	}
	return prefix;
}

export function generateApiKey(): { key: string; prefix: string; keyHash: string } {
	const prefix = randomPrefix();
	const secret = randomBytes(32).toString('base64url');
	return { key: `${MARKER}${prefix}_${secret}`, prefix, keyHash: hashSecret(secret) };
}

export function parseApiKey(key: string): { prefix: string; secret: string } | null {
	if (!key.startsWith(MARKER)) return null;
	const rest = key.slice(MARKER.length);
	const i = rest.indexOf('_');
	if (i < 4) return null;
	const prefix = rest.slice(0, i);
	const secret = rest.slice(i + 1);
	if (secret.length < SECRET_MIN) return null;
	return { prefix, secret };
}
