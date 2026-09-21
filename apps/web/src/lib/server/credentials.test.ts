import { beforeAll, describe, expect, it } from 'vitest';
import { decryptCredentials, encryptCredentials } from './credentials';

// Hermetic setup. The module reads CREDENTIALS_MASTER_KEY from process.env at
// call time, so a test that relies on the ambient shell having sourced .env
// passes locally and fails in CI. Pin it explicitly instead.
const TEST_KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64');

beforeAll(() => {
	process.env.CREDENTIALS_MASTER_KEY = TEST_KEY;
});

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

	// A key of the wrong size is a configuration error, and silently accepting
	// it would produce ciphertext the Go data plane cannot decrypt.
	it('refuses a master key that is not 32 bytes', () => {
		const saved = process.env.CREDENTIALS_MASTER_KEY;
		process.env.CREDENTIALS_MASTER_KEY = Buffer.alloc(16, 1).toString('base64');
		expect(() => encryptCredentials({ api_key: 'x' })).toThrow(/32 bytes/);
		process.env.CREDENTIALS_MASTER_KEY = saved;
	});

	it('refuses to run with no master key at all', () => {
		const saved = process.env.CREDENTIALS_MASTER_KEY;
		delete process.env.CREDENTIALS_MASTER_KEY;
		expect(() => encryptCredentials({ api_key: 'x' })).toThrow(/not set/);
		process.env.CREDENTIALS_MASTER_KEY = saved;
	});
});
