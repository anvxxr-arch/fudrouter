import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function masterKey(): Buffer {
	const k = process.env.CREDENTIALS_MASTER_KEY;
	if (!k) throw new Error('CREDENTIALS_MASTER_KEY is not set');
	const buf = Buffer.from(k, 'base64');
	if (buf.length !== 32) throw new Error('CREDENTIALS_MASTER_KEY must be base64 of 32 bytes');
	return buf;
}

/**
 * Previous master key, set only during a rotation window
 * (CREDENTIALS_MASTER_KEY_PREV). Null is the steady state, not an error; a
 * malformed value throws loudly, because quietly ignoring it would leave the
 * old rows undecryptable with no signal pointing at the cause.
 */
function previousMasterKey(): Buffer | null {
	const k = process.env.CREDENTIALS_MASTER_KEY_PREV;
	if (!k) return null;
	const buf = Buffer.from(k, 'base64');
	if (buf.length !== 32) throw new Error('CREDENTIALS_MASTER_KEY_PREV must be base64 of 32 bytes');
	return buf;
}

/**
 * Wire format: base64(iv[12] || ciphertext || authTag[16]) — matches the Go data plane.
 *
 * The payload is an arbitrary JSON object, not just a flat string map: a provider
 * may carry a single `api_key` (commercial upstreams) or an `accounts` pool
 * (multi-credential upstreams). The AES-GCM envelope is identical either way, so
 * the Go side decrypts and reads whichever field it needs.
 */
export type Credentials = Record<string, unknown>;

export function encryptCredentials(plain: Credentials): string {
	const iv = randomBytes(12);
	const c = createCipheriv('aes-256-gcm', masterKey(), iv);
	const ct = Buffer.concat([c.update(JSON.stringify(plain), 'utf8'), c.final()]);
	return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
}

/**
 * Decrypt tries the ACTIVE key first, then the previous one during a rotation
 * window (CREDENTIALS_MASTER_KEY_PREV). This is the canonical envelope for the
 * whole fleet — the React control plane (via server/lib/platform-ts.mjs), the
 * workers and the scheduler — and it must carry the rotation seam, not just
 * the Go data plane: a rotation that only the router understands leaves the
 * control plane unable to decrypt its own rows.
 */
export function decryptCredentials(enc: string): Credentials {
	return decryptWith(enc, masterKey(), previousMasterKey());
}

function decryptWith(enc: string, active: Buffer, prev: Buffer | null): Credentials {
	const buf = Buffer.from(enc, 'base64');
	if (buf.length < 12 + 16) throw new Error('ciphertext too short');
	const iv = buf.subarray(0, 12);
	const tag = buf.subarray(buf.length - 16);
	const ct = buf.subarray(12, buf.length - 16);
	const open = (key: Buffer) => {
		const d = createDecipheriv('aes-256-gcm', key, iv);
		d.setAuthTag(tag);
		return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
	};
	try {
		return JSON.parse(open(active)) as Credentials;
	} catch (err) {
		if (!prev) throw err;
		// The previous key is only consulted when the active one fails, so a
		// healthy steady state never pays for the fallback.
		return JSON.parse(open(prev)) as Credentials;
	}
}
