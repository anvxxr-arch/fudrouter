import { fail, redirect } from '@sveltejs/kit';
import type { Actions } from './$types';
import { auth } from '$lib/server/auth';

export const actions: Actions = {
	default: async ({ request }) => {
		const form = await request.formData();
		const email = String(form.get('email') ?? '').trim();
		const password = String(form.get('password') ?? '');
		const name = String(form.get('name') ?? '').trim();

		if (!email || !password || !name) {
			return fail(400, { error: 'Name, email and password are all required' });
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

		redirect(303, '/keys');
	}
};
