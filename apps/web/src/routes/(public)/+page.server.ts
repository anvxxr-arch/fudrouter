import { and, eq, gte, sql } from 'drizzle-orm';
import { redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { auth } from '$lib/server/auth';
import { landingFor } from '$lib/server/roles';
import { db } from '$lib/server/db';
import { requestLog } from '$lib/server/db/schema';
import { servedModels } from '$lib/server/public-catalog';

// Signed-in users land on their own home, so `/` is never a dead end.
function roleOf(user: unknown): string | null {
	if (user && typeof user === 'object' && 'role' in user) {
		const role = user.role;
		return typeof role === 'string' ? role : null;
	}
	return null;
}

export const load: PageServerLoad = async ({ locals }) => {
	if (locals.user) {
		redirect(303, landingFor(roleOf(locals.user)));
	}
	// The hero states counts ("available models", "provider network"), so every
	// number here is a real database fact — no invented figure lives on the
	// landing (Status owns the live probe). A database blip must not take the
	// page down with it, so a failed query degrades to nulls rather than a 500
	// (PRD §108: the error state is a fallback panel, not a crash).
	const metrics: {
		models: number | null;
		providers: number | null;
		calls: number | null;
		latencyMs: number | null;
	} = { models: null, providers: null, calls: null, latencyMs: null };
	let sampleModels: { slug: string; name: string; context: number | null }[] = [];
	try {
		// servedModels() carries the publish gate the router serves with, so the
		// counts cannot advertise a slug the data plane would refuse.
		const all = await servedModels();
		metrics.models = all.length;
		metrics.providers = new Set(all.flatMap((m) => m.providers.map((p) => p.providerName))).size;
		sampleModels = all.slice(0, 6).map(({ slug, name, context }) => ({ slug, name, context }));
		const [callsAgg, latencyAgg] = await Promise.all([
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
		metrics.calls = callsAgg[0]?.n ?? 0;
		metrics.latencyMs = latencyAgg[0]?.avg == null ? null : Math.round(Number(latencyAgg[0].avg));
	} catch (error) {
		console.error('[landing] metric strip queries failed', error);
	}
	return { metrics, sampleModels };
};

export const actions: Actions = {
	// POST /?/logout — the nav's sign-out form targets this.
	logout: async (event) => {
		await auth.api.signOut({ headers: event.request.headers });
		redirect(303, '/login');
	}
};
