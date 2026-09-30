import { describe, expect, it } from 'vitest';
import {
	evaluateSecuritySignals,
	type SecurityRuleRow,
	type WindowStats
} from './admin-signals';

const window: WindowStats = {
	windowStart: new Date('2026-09-30T12:00:00Z'),
	requests: 500,
	authFailures: 12,
	errorCount: 30,
	distinctIps: 40,
	topIpShare: 0.5,
	keyRotations: 2,
	credentialAuthFailures: 6,
	spendMicro: 2_500_000n,
	budgetMicro: 5_000_000n
};

function rule(partial: Partial<SecurityRuleRow>): SecurityRuleRow {
	return {
		id: 'rul_1',
		name: 'spike',
		kind: 'request_spike',
		config: { threshold: 100, window_seconds: 3600 },
		enabled: true,
		action: 'log',
		...partial
	};
}

describe('evaluateSecuritySignals', () => {
	it('fires a threshold rule with the observed value and message', () => {
		const signals = evaluateSecuritySignals([rule({})], [window]);
		expect(signals).toHaveLength(1);
		expect(signals[0].value).toBe(500);
		expect(signals[0].threshold).toBe(100);
		expect(signals[0].message).toContain('500 requests');
	});
	it('does not fire below the threshold', () => {
		const signals = evaluateSecuritySignals([rule({ config: { threshold: 501 } })], [window]);
		expect(signals).toHaveLength(0);
	});
	it('skips disabled rules entirely', () => {
		const signals = evaluateSecuritySignals([rule({ enabled: false })], [window]);
		expect(signals).toHaveLength(0);
	});
	it('evaluates every rule kind against its own counter', () => {
		const kinds: SecurityRuleRow[] = [
			rule({ kind: 'auth_failures', config: { threshold: 10 }, name: 'auth' }),
			rule({ kind: 'key_rotation', config: { threshold: 2 }, name: 'rot' }),
			rule({ kind: 'ip_distribution', config: { threshold: 30 }, name: 'ips' }),
			rule({ kind: 'budget_anomaly', config: { threshold: 40 }, name: 'budget' }),
			rule({ kind: 'excessive_errors', config: { threshold: 25 }, name: 'errs' }),
			rule({ kind: 'credential_abuse', config: { threshold: 5 }, name: 'cred' })
		];
		const signals = evaluateSecuritySignals(kinds, [window]);
		expect(signals.map((s) => s.name).sort()).toEqual([
			'auth',
			'budget',
			'cred',
			'errs',
			'ips',
			'rot'
		]);
		const budget = signals.find((s) => s.name === 'budget')!;
		expect(budget.value).toBe(50);
	});
	it('needs a budget before a budget anomaly can fire', () => {
		const noBudget = evaluateSecuritySignals(
			[rule({ kind: 'budget_anomaly', config: { threshold: 10 } })],
			[{ ...window, budgetMicro: null }]
		);
		expect(noBudget).toHaveLength(0);
	});
	it('returns newest-window signals first', () => {
		const older = { ...window, windowStart: new Date('2026-09-30T10:00:00Z'), requests: 200 };
		const signals = evaluateSecuritySignals([rule({})], [older, window]);
		expect(signals.map((s) => s.at.toISOString())).toEqual([
			'2026-09-30T12:00:00.000Z',
			'2026-09-30T10:00:00.000Z'
		]);
	});
});
