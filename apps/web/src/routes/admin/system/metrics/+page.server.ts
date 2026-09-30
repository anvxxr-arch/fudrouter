import type { PageServerLoad } from './$types';
import { requireCap } from '$lib/server/roles';
import { db } from '$lib/server/db';
import { provider } from '$lib/server/db/schema';
import { sql } from 'drizzle-orm';

type RawRow = Record<string, unknown>;

const pct = (row: RawRow | undefined, key: string): number | null =>
	row && row[key] !== null && row[key] !== undefined ? Number(row[key]) : null;

export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'admin.ops');
	// Pure SQL over request_log (PRD §73): one window, several shapes of the
	// same truth — volume, error mix, latency percentiles, fallbacks.
	const since = sql`now() - interval '24 hours'`;

	const hourly = (await db.execute(sql`
		select date_trunc('hour', created_at) as bucket,
		       count(*)::int as requests,
		       count(*) filter (where status = 'success')::int as successes
		from request_log
		where created_at >= ${since}
		group by 1
		order by 1
	`)) as unknown as RawRow[];

	const errorMix = (await db.execute(sql`
		select status, coalesce(error_code, '') as error_code,
		       count(*)::int as requests
		from request_log
		where created_at >= ${since} and status <> 'success'
		group by 1, 2
		order by 3 desc
	`)) as unknown as RawRow[];

	const latency = (await db.execute(sql`
		select
			(percentile_cont(0.5) within group (order by latency_ms))::float8 as p50,
			(percentile_cont(0.95) within group (order by latency_ms))::float8 as p95,
			(percentile_cont(0.99) within group (order by latency_ms))::float8 as p99,
			(percentile_cont(0.5) within group (order by ttft_ms))::float8 as ttft_p50,
			(percentile_cont(0.95) within group (order by ttft_ms))::float8 as ttft_p95
		from request_log
		where created_at >= ${since}
	`)) as unknown as RawRow[];

	const fallback = (await db.execute(sql`
		select count(*)::int as requests,
		       count(*) filter (where fallback_used)::int as fallbacks
		from request_log
		where created_at >= ${since}
	`)) as unknown as RawRow[];

	const providers = await db
		.select({ id: provider.id, name: provider.name })
		.from(provider)
		.orderBy(provider.name);
	const providerNames = new Map(providers.map((p) => [p.id, p.name]));

	const perProvider = (await db.execute(sql`
		select provider_id,
		       count(*)::int as requests,
		       count(*) filter (where status = 'success')::int as successes,
		       (percentile_cont(0.5) within group (order by latency_ms))::float8 as p50,
		       (percentile_cont(0.95) within group (order by latency_ms))::float8 as p95
		from request_log
		where created_at >= ${since}
		group by provider_id
		order by 2 desc
	`)) as unknown as RawRow[];

	const fb = fallback[0];
	const requests = fb ? Number(fb.requests ?? 0) : 0;
	const fallbacks = fb ? Number(fb.fallbacks ?? 0) : 0;
	return {
		hourly: hourly.map((r) => ({
			bucket: String(r.bucket),
			requests: Number(r.requests),
			successes: Number(r.successes)
		})),
		errorMix: errorMix.map((r) => ({
			status: String(r.status),
			errorCode: String(r.error_code),
			requests: Number(r.requests)
		})),
		latency: {
			p50: pct(latency[0], 'p50'),
			p95: pct(latency[0], 'p95'),
			p99: pct(latency[0], 'p99'),
			ttftP50: pct(latency[0], 'ttft_p50'),
			ttftP95: pct(latency[0], 'ttft_p95')
		},
		fallback: {
			requests,
			fallbacks,
			rate: requests > 0 ? (100 * fallbacks) / requests : null
		},
		perProvider: perProvider.map((r) => ({
			providerId: String(r.provider_id),
			providerName: providerNames.get(String(r.provider_id)) ?? String(r.provider_id),
			requests: Number(r.requests),
			successes: Number(r.successes),
			p50: pct(r, 'p50'),
			p95: pct(r, 'p95')
		}))
	};
};
