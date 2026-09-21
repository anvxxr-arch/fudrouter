import { describe, expect, it } from 'vitest';
import { decryptCredentials, encryptCredentials } from './credentials';

describe('AES-256-GCM credentials', () => {
	it('round-trips', () => {
		const plain = { api_key: 'sk-test-0123456789abcdef' };
		const enc = encryptCredentials(plain);
		expect(enc).not.toContain('sk-test-0123456789abcdef');
		expect(decryptCredentials(enc)).toEqual(plain);
	});

	it('produces different ciphertexts per call (random IV)', () => {
		const a = encryptCredentials({ api_key: 'x' });
		const b = encryptCredentials({ api_key: 'x' });
		expect(a).not.toBe(b);
	});

	it('is 12-byte IV + ct + 16-byte tag, base64', () => {
		const enc = encryptCredentials({ api_key: 'x' });
		const buf = Buffer.from(enc, 'base64');
		// {"api_key":"x"} = 15 bytes plaintext; 12 + 15 + 16 = 43
		expect(buf.length).toBe(43);
	});

	it('rejects tampered ciphertext', () => {
		const enc = encryptCredentials({ api_key: 'x' });
		const buf = Buffer.from(enc, 'base64');
		buf[buf.length - 1] ^= 0xff;
		expect(() => decryptCredentials(buf.toString('base64'))).toThrow();
	});

	// Multi-credential providers (e.g. an OAuth account pool) store nested
	// structures, not just a flat string map. Same wire format either way.
	it('round-trips a nested account pool', () => {
		const plain = {
			api_key: 'first-token',
			auth_kind: 'oauth',
			accounts: [{ email: 'a@example.test', access_token: 'tok-1' }]
		};
		expect(decryptCredentials(encryptCredentials(plain))).toEqual(plain);
	});
});
