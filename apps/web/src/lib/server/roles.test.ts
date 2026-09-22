import { describe, expect, it } from 'vitest';
import { capsFor, hasCap, landingFor, requiredCap, ALL_CAPS } from './roles';

describe('capsFor', () => {
	it('gives an unknown or absent role member only (fail-closed)', () => {
		for (const role of [null, undefined, '', 'user', 'nobody', 'superuser']) {
			const caps = capsFor(role as string | null | undefined);
			expect([...caps]).toEqual(['member']);
		}
	});

	it('gives admin every capability', () => {
		expect(new Set(capsFor('admin'))).toEqual(new Set(ALL_CAPS));
	});

	it('scopes finance_admin to billing/users', () => {
		expect(hasCap('finance_admin', 'admin.billing')).toBe(true);
		expect(hasCap('finance_admin', 'admin.users')).toBe(true);
		expect(hasCap('finance_admin', 'admin.providers')).toBe(false);
	});

	it('scopes ops_admin to providers/models/requests/ops', () => {
		expect(hasCap('ops_admin', 'admin.providers')).toBe(true);
		expect(hasCap('ops_admin', 'admin.ops')).toBe(true);
		expect(hasCap('ops_admin', 'admin.keys')).toBe(false);
		expect(hasCap('ops_admin', 'admin.billing')).toBe(false);
	});
});

describe('landingFor', () => {
	it('sends admin staff to /admin and everyone else to /dashboard', () => {
		expect(landingFor('admin')).toBe('/admin');
		expect(landingFor('ops_admin')).toBe('/admin');
		expect(landingFor('finance_admin')).toBe('/admin');
		expect(landingFor('user')).toBe('/dashboard');
		expect(landingFor(null)).toBe('/dashboard');
	});
});

describe('requiredCap', () => {
	it('classifies admin subroutes by their own capability', () => {
		expect(requiredCap('/admin/providers')).toBe('admin.providers');
		expect(requiredCap('/admin/models')).toBe('admin.models');
		expect(requiredCap('/admin/keys')).toBe('admin.keys');
		expect(requiredCap('/admin/users')).toBe('admin.users');
		expect(requiredCap('/admin/connections')).toBe('admin.ops');
	});

	it('picks the longest prefix (/admin/billing beats /billing)', () => {
		expect(requiredCap('/admin/billing')).toBe('admin.billing');
		expect(requiredCap('/billing')).toBe('member');
	});

	it('falls back to admin.view for the admin root and unknown admin paths', () => {
		expect(requiredCap('/admin')).toBe('admin.view');
		expect(requiredCap('/admin/unknown')).toBe('admin.view');
	});

	it('gates member routes', () => {
		expect(requiredCap('/keys')).toBe('member');
		expect(requiredCap('/usage')).toBe('member');
		expect(requiredCap('/dashboard')).toBe('member');
		expect(requiredCap('/account')).toBe('member');
	});

	it('leaves public routes open', () => {
		expect(requiredCap('/')).toBeNull();
		expect(requiredCap('/pricing')).toBeNull();
		expect(requiredCap('/models')).toBeNull();
		expect(requiredCap('/docs')).toBeNull();
		expect(requiredCap('/login')).toBeNull();
	});
});
