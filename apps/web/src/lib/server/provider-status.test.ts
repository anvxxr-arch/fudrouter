import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
	resolveStatus,
	assertValidStatus,
	providerUpsertConflict,
	statusLogSuffix
} from './provider-status';

const ENV = 'TEST_PROVIDER_STATUS';

describe('resolveStatus', () => {
	beforeEach(() => delete process.env[ENV]);
	afterEach(() => delete process.env[ENV]);

	it('returns the insert status and is not explicit when the env var is unset', () => {
		expect(resolveStatus(ENV)).toEqual({ value: 'active', isExplicit: false });
	});

	it('treats a blank env var as unset', () => {
		process.env[ENV] = '   ';
		expect(resolveStatus(ENV)).toEqual({ value: 'active', isExplicit: false });
	});

	it('honours an explicit override and trims it', () => {
		process.env[ENV] = ' disabled ';
		expect(resolveStatus(ENV)).toEqual({ value: 'disabled', isExplicit: true });
	});

	it('uses the supplied insert status when nothing is set', () => {
		expect(resolveStatus(ENV, 'dev')).toEqual({ value: 'dev', isExplicit: false });
	});
});

describe('assertValidStatus', () => {
	it('accepts the three known statuses', () => {
		for (const s of ['active', 'dev', 'disabled']) {
			expect(assertValidStatus(s, ENV)).toBe(s);
		}
	});

	it('throws on a typo instead of writing it to the database', () => {
		expect(() => assertValidStatus('actve', ENV)).toThrow(/not a valid provider status/);
	});

	it('names the env var in the error so the operator knows what to fix', () => {
		expect(() => assertValidStatus('nope', ENV)).toThrow(ENV);
	});
});

describe('providerUpsertConflict', () => {
	it('omits status when the operator did not ask, preserving the stored value', () => {
		expect(providerUpsertConflict('id', 'active', false)).not.toMatch(/status/);
	});

	it('includes status only on an explicit override', () => {
		expect(providerUpsertConflict('id', 'dev', true)).toContain('status = excluded.status');
	});

	it('always refreshes the fields the script owns', () => {
		const sql = providerUpsertConflict('id', 'active', false);
		for (const frag of [
			'name = excluded.name',
			'base_url = excluded.base_url',
			'credentials_enc = excluded.credentials_enc',
			'priority = excluded.priority'
		]) {
			expect(sql).toContain(frag);
		}
	});

	it('honours a name-keyed conflict target', () => {
		expect(providerUpsertConflict('name', 'active', false)).toContain('on conflict (name)');
	});
});

describe('statusLogSuffix', () => {
	it('says preserved when status was not touched', () => {
		expect(statusLogSuffix('active', false)).toBe('status=active (preserved)');
	});

	it('says explicit override so a status change is never silent', () => {
		expect(statusLogSuffix('disabled', true)).toBe('status=disabled (explicit override)');
	});
});
