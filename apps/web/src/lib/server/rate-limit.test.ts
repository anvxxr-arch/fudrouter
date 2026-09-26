import { beforeEach, describe, expect, it } from 'vitest';
import {
	clientAddress,
	consume,
	formatRetryAfter,
	limitCredentialAttempt,
	LOGIN_PER_ADDRESS,
	LOGIN_PER_IDENTITY,
	resetRateLimits
} from './rate-limit';

beforeEach(() => {
	resetRateLimits();
});

describe('consume', () => {
	it('allows exactly `max` attempts then refuses', () => {
		const rule = { max: 3, windowMs: 60_000 };
		const t = 1_000_000;

		expect(consume('k', rule, t).allowed).toBe(true);
		expect(consume('k', rule, t).allowed).toBe(true);
		expect(consume('k', rule, t).allowed).toBe(true);

		const refused = consume('k', rule, t);
		expect(refused.allowed).toBe(false);
		expect(refused.retryAfterMs).toBe(60_000);
	});

	it('resets once the window elapses', () => {
		const rule = { max: 1, windowMs: 60_000 };
		expect(consume('k', rule, 0).allowed).toBe(true);
		expect(consume('k', rule, 59_999).allowed).toBe(false);
		expect(consume('k', rule, 60_000).allowed).toBe(true);
	});

	it('counts keys independently', () => {
		const rule = { max: 1, windowMs: 60_000 };
		expect(consume('a', rule, 0).allowed).toBe(true);
		expect(consume('b', rule, 0).allowed).toBe(true);
		expect(consume('a', rule, 0).allowed).toBe(false);
	});
});

describe('clientAddress', () => {
	it('prefers the Cloudflare edge header', () => {
		const h = new Headers({
			'cf-connecting-ip': '203.0.113.9',
			'x-forwarded-for': '198.51.100.4, 127.0.0.1'
		});
		expect(clientAddress(h)).toBe('203.0.113.9');
	});

	it('falls back to the left-most forwarded entry', () => {
		const h = new Headers({ 'x-forwarded-for': '198.51.100.4, 127.0.0.1' });
		expect(clientAddress(h)).toBe('198.51.100.4');
	});

	it('returns null when no address header is present', () => {
		expect(clientAddress(new Headers())).toBe(null);
	});
});

describe('limitCredentialAttempt', () => {
	it('limits an account even when no address can be resolved', () => {
		const headers = new Headers();
		for (let i = 0; i < LOGIN_PER_IDENTITY.max; i++) {
			expect(limitCredentialAttempt('login', headers, 'target@example.com').allowed).toBe(true);
		}
		const refused = limitCredentialAttempt('login', headers, 'target@example.com');
		expect(refused.allowed).toBe(false);
		// A different account from the same (unresolved) address is unaffected.
		expect(limitCredentialAttempt('login', headers, 'other@example.com').allowed).toBe(true);
	});

	it('treats an identity case-insensitively', () => {
		const headers = new Headers();
		for (let i = 0; i < LOGIN_PER_IDENTITY.max; i++) {
			limitCredentialAttempt('login', headers, 'Target@Example.com');
		}
		expect(limitCredentialAttempt('login', headers, 'target@example.com').allowed).toBe(false);
	});

	it('limits a single address across many accounts', () => {
		const headers = new Headers({ 'cf-connecting-ip': '203.0.113.9' });
		for (let i = 0; i < LOGIN_PER_ADDRESS.max; i++) {
			expect(limitCredentialAttempt('login', headers, `u${i}@example.com`).allowed).toBe(true);
		}
		expect(limitCredentialAttempt('login', headers, 'fresh@example.com').allowed).toBe(false);
	});

	it('keeps login and signup budgets separate', () => {
		const headers = new Headers({ 'cf-connecting-ip': '203.0.113.9' });
		for (let i = 0; i < LOGIN_PER_ADDRESS.max; i++) {
			limitCredentialAttempt('login', headers, 'a@example.com');
		}
		expect(limitCredentialAttempt('login', headers, 'b@example.com').allowed).toBe(false);
		expect(limitCredentialAttempt('signup', headers, 'b@example.com').allowed).toBe(true);
	});
});

describe('formatRetryAfter', () => {
	it('reports seconds below a minute and minutes above', () => {
		expect(formatRetryAfter(1_000)).toBe('1 second');
		expect(formatRetryAfter(30_000)).toBe('30 seconds');
		expect(formatRetryAfter(90_000)).toBe('2 minutes');
	});

	it('never reports zero', () => {
		expect(formatRetryAfter(0)).toBe('1 second');
	});
});
