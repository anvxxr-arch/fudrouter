import { fail, redirect } from '@sveltejs/kit';
import type { Actions } from './$types';
import { auth } from '$lib/server/auth';
import { limitCredentialAttempt, formatRetryAfter } from '$lib/server/rate-limit';

export const actions: Actions = {
	default: async ({ request }) => {
		const form = await request.formData();
		const email = String(form.get('email') ?? '').trim();
		const password = String(form.get('password') ?? '');
		const name = String(form.get('name') ?? '').trim();

		if (!email || !password || !name) {
			return fail(400, { error: 'Name, email and password are all required' });
		}

		// Same bypass as the login action: auth.api.* skips better-auth's
		// router-level limiter. Signup is limited per address — a per-account cap
		// would never fire, since every attempt names a fresh address.
		const decision = limitCredentialAttempt('signup', request.headers, email);
		if (!decision.allowed) {
			return fail(429, {
				error: `Too many attempts. Try again in ${formatRetryAfter(decision.retryAfterMs)}.`
			});
		}

		// better-auth's server API returns data and THROWS APIError on failure —
		// there is no `.ok` flag. redirect() also throws, so it must sit outside
		// this try/catch or it would be swallowed as a signup error.
		try {
			await auth.api.signUpEmail({ body: { email, password, name } });
		} catch (err) {
			const message = err instanceof Error ? err.message : 'unknown error';
			return fail(400, { error: `Signup failed: ${message}` });
		}

		redirect(303, '/dashboard/keys');
	}
};
