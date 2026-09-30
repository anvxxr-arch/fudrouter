import { describe, expect, it } from 'vitest';
import { decryptJson, encryptJson, splitBlob } from '../../../../../scripts/backfill-credentials.mjs';
import { decryptCredentials, encryptCredentials } from './credentials';

// The credential envelope is implemented three times — TS control plane,
// Go data plane, and this plain-node migration script — because none of the
// three can import the others. Exactly like the API-key format, every side must
// re-parse what the others mint. This test pins the TS <-> script direction;
// the Go direction is pinned by internal/crypt's round-trip test.

const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.CREDENTIALS_MASTER_KEY ??= MASTER_KEY;

describe('credential envelope compatibility', () => {
	it('script ciphertext decrypts in the control plane', () => {
		const plain = { api_key: 'sk-live-abc', extra: { n: 1 } };
		expect(decryptCredentials(encryptJson(plain))).toEqual(plain);
	});

	it('control-plane ciphertext decrypts in the script', () => {
		const plain = { email: 'a@b.c', access_token: 'tok', refresh_token: 'r', id_token: '', expired: '' };
		expect(decryptJson(encryptCredentials(plain))).toEqual(plain);
	});

	it('rejects a foreign key rather than returning garbage', () => {
		process.env.CREDENTIALS_MASTER_KEY = Buffer.alloc(32, 8).toString('base64');
		const enc = encryptJson({ api_key: 'x' });
		process.env.CREDENTIALS_MASTER_KEY = MASTER_KEY;
		// Both sides read the key at call time, so the ciphertext above was made
		// with a DIFFERENT key than the one now in the env.
		expect(() => decryptCredentials(enc)).toThrow();
	});
});

describe('splitBlob', () => {
	it('turns each S0 account into its own credential row', () => {
		const { rows, connectionConfig } = splitBlob({
			protocol: 'freebuff',
			default_headers: { 'x-grok-client-version': '1' },
			accounts: [
				{ email: 'one@x', access_token: 'a1', refresh_token: 'r1', id_token: 'i1', expired: '' },
				{ email: 'two@x', access_token: 'a2', refresh_token: 'r2', id_token: '', expired: 'true' }
			]
		});
		expect(rows.map((r: { name: string }) => r.name)).toEqual(['one@x', 'two@x']);
		expect(rows[1].secret).toEqual({
			email: 'two@x', access_token: 'a2', refresh_token: 'r2', id_token: '', expired: 'true'
		});
		// Shared fields belong to the connection, not to any account (spec §4).
		expect(connectionConfig).toEqual({
			protocol: 'freebuff',
			default_headers: { 'x-grok-client-version': '1' }
		});
	});

	it('keeps a bare api_key blob as one credential row', () => {
		const { rows, connectionConfig } = splitBlob({ api_key: 'sk-x' });
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ name: 'api-key', secret: { api_key: 'sk-x' } });
		expect(connectionConfig).toEqual({});
	});

	it('refuses to invent rows for an empty blob', () => {
		expect(splitBlob({}).rows).toEqual([]);
	});
});
