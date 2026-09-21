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

export function generateApiKey(): { key: string; prefix: string; keyHash: string } {
	const prefix = randomBytes(6).toString('base64url').slice(0, PREFIX_LEN);
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
