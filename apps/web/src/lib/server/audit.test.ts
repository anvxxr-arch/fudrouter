import { describe, expect, it } from 'vitest';
import { REDACTED, redactSecrets } from './audit';

// Spec §11 / PRD §137: secrets never reach audit_log. The redaction happens at
// WRITE time — a leaked audit export cannot un-redact — so the matcher is the
// whole security boundary of these rows and is pinned here key-by-key.
describe('audit redaction', () => {
	it('redacts every secret-looking key (spec §11 regex)', () => {
		const input = {
			name: 'prod-backend',
			secret: 'x',
			client_secret: 'x',
			token: 'x',
			access_token: 'x',
			refreshToken: 'x',
			password: 'x',
			password_hash: 'x',
			key_hash: 'x',
			api_key_hash: 'x',
			credentials: 'x',
			credential: 'x',
			credentials_enc: 'x'
		};
		const out = redactSecrets(input) as Record<string, unknown>;
		expect(out.name).toBe('prod-backend');
		for (const k of Object.keys(input)) {
			if (k === 'name') continue;
			expect(out[k], `${k} must be redacted`).toBe(REDACTED);
		}
	});
	it('redacts nested objects and array elements', () => {
		const out = redactSecrets({
			metadata: { env: { access_token: 'x', slug: 'prod' } },
			list: [{ apiToken: 'x' }, 'plain']
		}) as Record<string, unknown>;
		const metadata = out.metadata as Record<string, Record<string, unknown>>;
		expect(metadata.env.access_token).toBe(REDACTED);
		expect(metadata.env.slug).toBe('prod');
		const list = out.list as unknown[];
		expect((list[0] as Record<string, unknown>).apiToken).toBe(REDACTED);
		expect(list[1]).toBe('plain');
	});
	it('leaves ordinary keys and values alone', () => {
		const input = { prefix: 'abc12345', name: 'secretless', status: 'active', rpm: 600 };
		expect(redactSecrets(input)).toEqual(input);
	});
	it('redacts raw api_key/authorization values but keeps their _id references', () => {
		const out = redactSecrets({
			api_key: 'sk-ar-aaaa_x',
			apikey: 'x',
			authorization: 'Bearer x',
			api_key_id: 'key_123',
			authorization_url: 'https://idp/authorize'
		}) as Record<string, unknown>;
		expect(out.api_key).toBe(REDACTED);
		expect(out.apikey).toBe(REDACTED);
		expect(out.authorization).toBe(REDACTED);
		// Reference keys name a resource, not a secret: audit needs them.
		expect(out.api_key_id).toBe('key_123');
		expect(out.authorization_url).toBe('https://idp/authorize');
	});
	it('keeps a secret-looking VALUE in a clean key (only keys are matched)', () => {
		expect(redactSecrets({ note: 'the token is abc' })).toEqual({ note: 'the token is abc' });
	});
});
