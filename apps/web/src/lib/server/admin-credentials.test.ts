import { describe, expect, it } from 'vitest';
import {
	credentialForDisplay,
	credentialPool,
	secretShownOnce,
	type CredentialRow
} from './admin-credentials';

const row: CredentialRow = {
	id: 'cred_1',
	connectionId: 'con_1',
	name: 'prod account',
	secretEnc: 'BASE64-CIPHERTEXT',
	status: 'healthy',
	priority: 10,
	weight: 100
};

describe('credentialForDisplay', () => {
	it('drops the ciphertext — the display shape carries no secret at all', () => {
		const view = credentialForDisplay(row);
		expect(view).not.toHaveProperty('secretEnc');
		expect(JSON.stringify(view)).not.toContain('BASE64-CIPHERTEXT');
		expect(view.name).toBe('prod account');
	});
});

describe('secretShownOnce', () => {
	it('is the only shape that carries a secret, and only at creation', () => {
		const once = secretShownOnce('cred_1', 'prod account', 'sk-plain');
		expect(once.shownOnce).toBe(true);
		expect(once.secret).toBe('sk-plain');
		// A stored row projected for display never reproduces it.
		const view = credentialForDisplay({ ...row, secretEnc: once.secret });
		expect(JSON.stringify(view)).not.toContain('sk-plain');
	});
});

describe('credentialPool', () => {
	it('buckets statuses into the pool dashboard counters', () => {
		const pool = credentialPool([
			{ status: 'healthy' },
			{ status: 'healthy' },
			{ status: 'rate_limited' },
			{ status: 'cooldown' },
			{ status: 'auth_failed' },
			{ status: 'invalid' },
			{ status: 'disabled' },
			{ status: 'unknown' },
			{ status: 'what' }
		]);
		expect(pool.total).toBe(9);
		expect(pool.buckets.Healthy).toBe(2);
		expect(pool.buckets['Rate Limited']).toBe(1);
		expect(pool.buckets.Cooldown).toBe(1);
		expect(pool.buckets.Invalid).toBe(2);
		expect(pool.buckets.Disabled).toBe(1);
		// Unproven and unrecognised statuses are never counted healthy.
		expect(pool.buckets.Unknown).toBe(2);
	});
	it('reports an empty pool as zeroed counters', () => {
		const pool = credentialPool([]);
		expect(pool.total).toBe(0);
		expect(Object.values(pool.buckets).every((n) => n === 0)).toBe(true);
	});
});
