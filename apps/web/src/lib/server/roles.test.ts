import { describe, expect, it } from 'vitest';
import {
	capsFor,
	hasCap,
	landingFor,
	requiredCap,
	requireCap,
	canAdminister,
	ALL_CAPS
} from './roles';

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

	it('picks the longest prefix (/admin/billing beats /admin)', () => {
		expect(requiredCap('/admin/billing')).toBe('admin.billing');
		expect(requiredCap('/admin')).toBe('admin.view');
	});

	it('falls back to admin.view for the admin root and unknown admin paths', () => {
		expect(requiredCap('/admin')).toBe('admin.view');
		expect(requiredCap('/admin/unknown')).toBe('admin.view');
	});

	it('gates the member surface, nested pages included', () => {
		expect(requiredCap('/dashboard')).toBe('member');
		expect(requiredCap('/dashboard/keys')).toBe('member');
		expect(requiredCap('/dashboard/usage')).toBe('member');
		expect(requiredCap('/dashboard/account')).toBe('member');
		expect(requiredCap('/dashboard/billing')).toBe('member');
		// Anything nested under the member root inherits `member` through the
		// longest-prefix rule, so a new page can never ship accidentally public.
		expect(requiredCap('/dashboard/something-new')).toBe('member');
	});

	it('leaves public routes open', () => {
		expect(requiredCap('/')).toBeNull();
		expect(requiredCap('/pricing')).toBeNull();
		expect(requiredCap('/models')).toBeNull();
		expect(requiredCap('/docs')).toBeNull();
		expect(requiredCap('/login')).toBeNull();
	});
});

describe('requireCap', () => {
	// The second gate, the hook being the first. Every role in the table carries
	// `member`, so for `member` this can only fire on a missing session — it exists
	// so a future role without `member` is refused instead of served.
	const statusOf = (fn: () => void): number | null => {
		try {
			fn();
			return null;
		} catch (err) {
			return (err as { status?: number }).status ?? null;
		}
	};

	it('refuses a request with no session', () => {
		expect(statusOf(() => requireCap({ user: null } as unknown as App.Locals, 'member'))).toBe(401);
	});

	it('refuses a signed-in member reaching for an admin capability', () => {
		const locals = { user: { id: 'u1', role: 'user' } } as unknown as App.Locals;
		expect(statusOf(() => requireCap(locals, 'admin.models'))).toBe(403);
	});

	it('lets a member through the member gate and staff through theirs', () => {
		const member = { user: { id: 'u1', role: 'user' } } as unknown as App.Locals;
		const ops = { user: { id: 'u2', role: 'ops_admin' } } as unknown as App.Locals;
		expect(statusOf(() => requireCap(member, 'member'))).toBeNull();
		expect(statusOf(() => requireCap(ops, 'admin.providers'))).toBeNull();
	});
});

describe('canAdminister (privilege ordering)', () => {
	it('admin dominates every role, so it administers anyone', () => {
		for (const target of ['user', 'finance_admin', 'ops_admin', 'admin']) {
			expect(canAdminister('admin', target), `admin -> ${target}`).toBe(true);
		}
	});

	it('refuses the self-promotion that the old self-demotion guard allowed', () => {
		// finance_admin holds admin.users but not admin; it must not be able to
		// grant itself (or anyone) the admin role.
		expect(canAdminister('finance_admin', 'finance_admin', 'admin')).toBe(false);
		expect(canAdminister('ops_admin', 'ops_admin', 'admin')).toBe(false);
		// ...nor to promote a plain user straight to admin.
		expect(canAdminister('finance_admin', 'user', 'admin')).toBe(false);
	});

	it('refuses acting on a peer or a superior', () => {
		// finance_admin must not demote/ban an admin or an ops_admin.
		expect(canAdminister('finance_admin', 'admin')).toBe(false);
		expect(canAdminister('finance_admin', 'ops_admin')).toBe(false);
		// ops_admin must not touch a finance_admin (billing/users it lacks).
		expect(canAdminister('ops_admin', 'finance_admin')).toBe(false);
	});

	it('allows acting on a role at or below your own level', () => {
		expect(canAdminister('finance_admin', 'user', 'user')).toBe(true);
		expect(canAdminister('finance_admin', 'user', 'finance_admin')).toBe(true);
		expect(canAdminister('ops_admin', 'user', 'ops_admin')).toBe(true);
		// A member-only role dominates only `member`.
		expect(canAdminister('user', 'user')).toBe(true);
		expect(canAdminister('user', 'admin')).toBe(false);
	});

	it('treats an unknown actor or target as the least-privileged role', () => {
		expect(canAdminister(null, 'admin')).toBe(false);
		expect(canAdminister('nobody', 'user')).toBe(true); // member dominates member
		expect(canAdminister('admin', 'nobody')).toBe(true);
	});
});
