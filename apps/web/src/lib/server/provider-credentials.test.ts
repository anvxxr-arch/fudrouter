import { describe, expect, it } from 'vitest';
import { credentialLabels, headersFor, isExpiredOAuth, tokenAt } from './provider-credentials';

// The bug these tests exist for: `tokenAt` read only `accounts[]`, but a
// credential row is ONE account stored FLAT at the top level (spec §4
// {email,access_token,refresh_token,id_token,expired}) — which is what the Go
// data plane writes and reads back. So it returned '' for all 12,044 rows, and
// `headersFor` emitted no Authorization header at all: the credential probe,
// the catalog fetch and the console test were all unauthenticated. Anything that
// regresses to reading only `accounts[]` must fail here.
describe('tokenAt', () => {
	it('reads the flat spec §4 account shape the data plane stores', () => {
		const cred = {
			email: 'farm-01@example.com',
			access_token: 'at-flat-1234567890',
			refresh_token: 'rt-flat',
			id_token: 'id-flat',
			expired: '2099-01-01T00:00:00Z'
		};
		expect(tokenAt(cred, 0)).toBe('at-flat-1234567890');
	});

	it('reads a flat static key', () => {
		expect(tokenAt({ api_key: 'sk-static' }, 0)).toBe('sk-static');
	});

	it('prefers the pooled account when the index exists', () => {
		const cred = {
			access_token: 'flat-should-lose',
			accounts: [
				{ email: 'a@x.com', access_token: 'at-0' },
				{ email: 'b@x.com', access_token: 'at-1' }
			]
		};
		expect(tokenAt(cred, 1)).toBe('at-1');
	});

	it('accepts api_key inside a pooled account', () => {
		expect(tokenAt({ accounts: [{ email: 'a@x.com', api_key: 'sk-pooled' }] }, 0)).toBe('sk-pooled');
	});

	it('falls back to the flat token when the pooled index is out of range', () => {
		expect(tokenAt({ access_token: 'at-flat', accounts: [{ access_token: 'at-0' }] }, 5)).toBe('at-flat');
	});

	it('is empty for a blob with no token at all', () => {
		expect(tokenAt({}, 0)).toBe('');
		expect(tokenAt({ email: 'only@email.com' }, 0)).toBe('');
	});
});

describe('headersFor', () => {
	it('sends an Authorization header for a flat account blob', () => {
		const h = headersFor({ email: 'a@x.com', access_token: 'at-flat' }, 'at-flat');
		expect(h.authorization).toBe('Bearer at-flat');
	});

	it('keeps the stored default_headers and adds auth', () => {
		const h = headersFor(
			{ access_token: 'at', default_headers: { 'x-grok-client-version': '1.0' } },
			'at'
		);
		expect(h['x-grok-client-version']).toBe('1.0');
		expect(h.authorization).toBe('Bearer at');
	});

	it('omits Authorization rather than sending an empty bearer', () => {
		const h = headersFor({ email: 'a@x.com' }, '');
		expect(h).not.toHaveProperty('authorization');
	});
});

describe('credentialLabels', () => {
	it('labels a flat account by its email, not "single key"', () => {
		expect(credentialLabels({ email: 'farm-07@example.com', access_token: 'at' })).toEqual([
			{ label: 'farm-07@example.com', index: 0 }
		]);
	});

	it('labels a blob with nothing but api_key as a single key', () => {
		expect(credentialLabels({ api_key: 'sk-x' })).toEqual([{ label: 'single key', index: 0 }]);
	});

	it('labels each pooled account, falling back to an index', () => {
		expect(
			credentialLabels({ accounts: [{ email: 'a@x.com' }, { api_key: 'sk-b' }] })
		).toEqual([
			{ label: 'a@x.com', index: 0 },
			{ label: 'key #2', index: 1 }
		]);
	});
});

describe('isExpiredOAuth', () => {
	it('is true for an OAuth account past its expiry', () => {
		expect(
			isExpiredOAuth({ refresh_token: 'rt', access_token: 'at', expired: '2020-01-01T00:00:00Z' })
		).toBe(true);
	});

	it('is false while the access token is still valid', () => {
		expect(
			isExpiredOAuth({ refresh_token: 'rt', access_token: 'at', expired: '2099-01-01T00:00:00Z' })
		).toBe(false);
	});

	it('is false without a refresh token — a static key cannot be refreshed', () => {
		expect(isExpiredOAuth({ api_key: 'sk-x', expired: '2020-01-01T00:00:00Z' })).toBe(false);
	});

	it('is false when there is no expiry to read', () => {
		expect(isExpiredOAuth({ refresh_token: 'rt', access_token: 'at' })).toBe(false);
	});
});
