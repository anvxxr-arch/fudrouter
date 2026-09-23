import { fail, redirect } from '@sveltejs/kit';
import type { Actions } from './$types';
import { auth } from '$lib/server/auth';

export const actions: Actions = {
	default: async ({ request }) => {
		const form = await request.formData();
		const email = String(form.get('email') ?? '').trim();
		const password = String(form.get('password') ?? '');

		if (!email || !password) {
			return fail(400, { error: 'Email and password are required' });
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
