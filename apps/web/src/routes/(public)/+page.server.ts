import { and, eq, gte, sql } from 'drizzle-orm';
import { redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { auth } from '$lib/server/auth';
import { landingFor } from '$lib/server/roles';
import { db } from '$lib/server/db';
import { model, requestLog } from '$lib/server/db/schema';

// Signed-in users land on their own home, so `/` is never a dead end.
export const load: PageServerLoad = async ({ locals }) => {
	if (locals.user) {
		const role = (locals.user as { role?: string | null }).role;
		redirect(303, landingFor(role));
	}

	// The metric strip makes claims, so it may only carry facts the database can
	// back — no invented uptime figure lives here (Status owns the live probe).
	// A database blip must not take the landing page down with it, so a failed
	// query degrades to dashes rather than a 500.
	const metrics: { models: number | null; calls: number | null; latencyMs: number | null } = {
		models: null,
		calls: null,
		latencyMs: null
	};
	try {
		const [modelsAgg, callsAgg, latencyAgg] = await Promise.all([
			db
				.select({ n: sql<number>`count(*)::int` })
				.from(model)
				.where(eq(model.status, 'active')),
			db.select({ n: sql<number>`count(*)::int` }).from(requestLog),
			db
				.select({ avg: sql<string | null>`avg(${requestLog.latencyMs})` })
				.from(requestLog)
				.where(
					and(
						eq(requestLog.status, 'success'),
						gte(requestLog.createdAt, new Date(Date.now() - 24 * 60 * 60 * 1000))
					)
				)
		]);
		metrics.models = modelsAgg[0]?.n ?? 0;
		metrics.calls = callsAgg[0]?.n ?? 0;
		metrics.latencyMs = latencyAgg[0]?.avg == null ? null : Math.round(Number(latencyAgg[0].avg));
	} catch (error) {
		console.error('[landing] metric strip queries failed', error);
	}

	return { metrics };
};

export const actions: Actions = {
	// POST /?/logout — the nav's sign-out form targets this.
	logout: async (event) => {
		await auth.api.signOut({ headers: event.request.headers });
		redirect(303, '/login');
	}
};
