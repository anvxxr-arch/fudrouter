import { describe, expect, it } from 'vitest';
import { isIpOrCidr, mergeWindows } from './admin-security-store';
describe('isIpOrCidr', () => {
	it.each([
		'203.0.113.0/24',
		'192.0.2.7',
		'0.0.0.0/0',
		'255.255.255.255/32',
		'2001:db8::/32',
		'::1',
		'fe80::1/64'
	])('accepts %s', (v) => {
		expect(isIpOrCidr(v)).toBe(true);
	});
	it.each([
		'',
		'  ',
		'999.0.0.1',
		'203.0.113.0/33',
		'203.0.113.0/',
		'203.0.113.0/024',
		'203.0.113.0/24/8',
		'example.com',
		'203.0.113.0 / 24',
		'2001:db8::/129',
		'1:2:3:4:5:6:7:8:9'
	])('rejects %s', (v) => {
		expect(isIpOrCidr(v)).toBe(false);
	});
});
describe('mergeWindows', () => {
	const budget = 500_000n;
	it('folds request and rotation rows into one window per hour, newest first', () => {
		const older = new Date('2026-09-30T08:00:00Z');
		const newer = new Date('2026-09-30T09:00:00Z');
		const windows = mergeWindows(
			[
				{
					windowStart: older,
					requests: 4,
					authFailures: 1,
					errorCount: 2,
					credentialAuthFailures: 1,
					distinctIps: 3,
					topIpCount: 2,
					spendMicro: '123456'
				},
				{
					windowStart: newer,
					requests: 10,
					authFailures: 0,
					errorCount: 1,
					credentialAuthFailures: 0,
					distinctIps: 1,
					topIpCount: 10,
					spendMicro: 0
				}
			],
			[{ windowStart: older, n: 2 }],
			budget
		);
		expect(windows.map((w) => w.windowStart)).toEqual([newer, older]);
		const [first, second] = windows;
		expect(first.topIpShare).toBe(1);
		expect(first.keyRotations).toBe(0);
		expect(first.spendMicro).toBe(0n);
		expect(first.budgetMicro).toBe(budget);
		expect(second.topIpShare).toBe(0.5);
		expect(second.keyRotations).toBe(2);
		expect(second.spendMicro).toBe(123456n);
	});
	it('keeps a rotation-only hour and tolerates no budget', () => {
		const at = new Date('2026-09-30T07:00:00Z');
		const windows = mergeWindows([], [{ windowStart: at, n: 3 }], null);
		expect(windows).toHaveLength(1);
		expect(windows[0]).toMatchObject({
			requests: 0,
			keyRotations: 3,
			topIpShare: 0,
			budgetMicro: null
		});
		expect(windows[0].spendMicro).toBe(0n);
	});
});
