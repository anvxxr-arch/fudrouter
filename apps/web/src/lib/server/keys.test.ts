import { describe, it, expect } from 'vitest';
import { generateApiKey, hashSecret, parseApiKey } from './keys';

describe('generateApiKey', () => {
	it('emits sk-ar-<8 chars>_<secret>', () => {
		const { key, prefix } = generateApiKey();
		expect(key).toMatch(/^sk-ar-[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43}$/);
		expect(prefix).toHaveLength(8);
		expect(key.startsWith(`sk-ar-${prefix}_`)).toBe(true);
	});

	it('never lets the stored hash equal the secret', () => {
		const { key, keyHash } = generateApiKey();
		// Must go through parseApiKey: base64url's alphabet INCLUDES '_', so
		// splitting the key on '_' would also split a prefix that contains one.
		const parsed = parseApiKey(key)!;
		expect(parsed).not.toBeNull();
		expect(keyHash).toBe(hashSecret(parsed.secret));
		expect(keyHash).not.toContain(parsed.secret);
		expect(keyHash).toMatch(/^[a-f0-9]{64}$/);
	});

	it('generates distinct keys', () => {
		const keys = new Set(Array.from({ length: 200 }, () => generateApiKey().key));
		expect(keys.size).toBe(200);
	});
});

describe('parseApiKey', () => {
	it('round-trips a generated key', () => {
		const { key, prefix, keyHash } = generateApiKey();
		const parsed = parseApiKey(key);
		expect(parsed).not.toBeNull();
		expect(parsed!.prefix).toBe(prefix);
		expect(hashSecret(parsed!.secret)).toBe(keyHash);
	});

	it('rejects malformed keys', () => {
		expect(parseApiKey('')).toBeNull();
		expect(parseApiKey('sk-live-abc_def')).toBeNull();
		expect(parseApiKey('sk-ar-abc')).toBeNull(); // no separator
		expect(parseApiKey('sk-ar-ab_shortsecret')).toBeNull(); // secret < 16
		expect(parseApiKey('sk-ar-abc_0123456789abcdef')).toBeNull(); // prefix < 4
		expect(parseApiKey('sk-ar-abcd_totally-fine-secret-value')).not.toBeNull();
	});
});

// Cross-language pin. The Go data plane re-derives this hash on every request;
// if either side changes its algorithm or encoding, these vectors break and the
// data plane starts 401-ing every key the control plane mints.
describe('cross-language contract (Go internal/keys)', () => {
	it('hashSecret matches sha256 hex of the same input', () => {
		expect(hashSecret('hello')).toBe(
			'2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
		);
		expect(hashSecret('')).toBe(
			'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
		);
	});

	it('accepts the loosest key the Go parser accepts (prefix 4, secret 16)', () => {
		expect(parseApiKey('sk-ar-abcd_0123456789abcdef')).toEqual({
			prefix: 'abcd',
			secret: '0123456789abcdef'
		});
	});

	it('rejects the same boundary the Go parser rejects (prefix 3, secret 15)', () => {
		expect(parseApiKey('sk-ar-abc_0123456789abcde')).toBeNull();
	});
});
