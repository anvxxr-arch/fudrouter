import { fail, redirect } from '@sveltejs/kit';
import type { Actions } from './$types';
import { auth } from '$lib/server/auth';
import { limitCredentialAttempt, formatRetryAfter } from '$lib/server/rate-limit';

export const actions: Actions = {
	default: async ({ request }) => {
		const form = await request.formData();
		const email = String(form.get('email') ?? '').trim();
		const password = String(form.get('password') ?? '');

		if (!email || !password) {
			return fail(400, { error: 'Email and password are required' });
		}

		// This action calls auth.api.* directly, which bypasses better-auth's own
		// rate limiter (that runs only in its HTTP router), so an unlimited
		// brute-force surface sat behind this form. Limited per address AND per
		// account — see $lib/server/rate-limit.
		const decision = limitCredentialAttempt('login', request.headers, email);
		if (!decision.allowed) {
			return fail(429, {
				error: `Too many attempts. Try again in ${formatRetryAfter(decision.retryAfterMs)}.`
			});
		}

		// See signup/+page.server.ts: better-auth throws instead of returning .ok,
		// and redirect() must not be inside the catch.
		try {
			await auth.api.signInEmail({ body: { email, password } });
		} catch {
			return fail(400, { error: 'Invalid email or password' });
		}

		redirect(303, '/dashboard/keys');
	}
};
