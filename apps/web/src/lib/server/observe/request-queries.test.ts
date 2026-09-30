import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
// Same hermetic discipline as jobs.test.ts: the db module reads its env at
// import time through `$env/dynamic/private`, so pin it before the first
// import. These tests run against the dedicated `fudrouter_test` database.
vi.hoisted(() => {
	process.env.DATABASE_URL ??= 'postgres://fudrouter:fudrouter@127.0.0.1:5432/fudrouter_test';
	process.env.VALKEY_URL = '';
});
import { db } from '$lib/server/db';
import {
	apiKey,
	environment,
	model,
	project,
	provider,
	requestAttempt,
	requestLog,
	usageDaily,
	user,
	workspace
} from '$lib/server/db/schema';
import { newId, ID_PREFIXES } from '$lib/server/id';
import { cursorFromParam, requestDetail, requestPage, parseFilters, timingRows } from './request-queries';
import type { Cursor } from './cursor';
import { costStats, usageBreakdowns, usageTotals } from './usage-queries';

/**
 * One fixture graph per run: workspace -> project -> environment, one provider
 * -> model, one key, one user. Every id carries the run suffix so two parallel
 * runs never collide, and teardown drops exactly these rows.
 */
const run = Date.now().toString(36);
const ids = {
	user: newId(ID_PREFIXES.user),
	workspace: newId(ID_PREFIXES.workspace),
	project: newId(ID_PREFIXES.project),
	environment: newId(ID_PREFIXES.environment),
	provider: newId(ID_PREFIXES.provider),
	model: newId(ID_PREFIXES.model),
	key: newId(ID_PREFIXES.apiKey)
};

beforeAll(async () => {
	await db.insert(user).values({ id: ids.user, name: `observe-${run}`, email: `observe-${run}@test.invalid` });
	await db.insert(workspace).values({
		id: ids.workspace,
		name: `Observe ${run}`,
		slug: `observe-${run}`,
		ownerUserId: ids.user
	});
	await db.insert(project).values({
		id: ids.project,
		workspaceId: ids.workspace,
		name: `Observe ${run}`,
		slug: `observe-${run}`
	});
	await db.insert(environment).values({
		id: ids.environment,
		projectId: ids.project,
		name: 'production',
		slug: 'production',
		type: 'production'
	});
	await db.insert(provider).values({
		id: ids.provider,
		name: `observe-provider-${run}`,
		baseUrl: 'https://upstream.invalid',
		credentialsEnc: 'test-envelope',
		slug: `observe-provider-${run}`
	});
	await db.insert(model).values({
		id: ids.model,
		providerId: ids.provider,
		name: `Observe Model ${run}`,
		slug: `observe-model-${run}`,
		inputPrice: '1000000.000000',
		outputPrice: '2000000.000000'
	});
	await db.insert(apiKey).values({
		id: ids.key,
		userId: ids.user,
		workspaceId: ids.workspace,
		projectId: ids.project,
		environmentId: ids.environment,
		name: `observe-key-${run}`,
		prefix: 'observe1',
		keyHash: `observe-hash-${run}`
	});
});

afterAll(async () => {
	// Workspace cascade removes project -> environment -> key -> request rows
	// (-> attempts); the catalog rows have no such link and go explicitly.
	await db.delete(workspace).where(sql`${workspace.id} = ${ids.workspace}`);
	await db.delete(user).where(sql`${user.id} = ${ids.user}`);
	await db.delete(provider).where(sql`${provider.id} = ${ids.provider}`);
	await db.$client.end({ timeout: 1 });
});

/** Seed one request row. Only the fields a test cares about are passed. */
async function seedRequest(
	i: number,
	overrides: Partial<typeof requestLog.$inferInsert> = {}
): Promise<string> {
	const id = `req_${run}_${String(i).padStart(3, '0')}`;
	await db.insert(requestLog).values({
		id,
		userId: ids.user,
		apiKeyId: ids.key,
		modelId: ids.model,
		providerId: ids.provider,
		workspaceId: ids.workspace,
		projectId: ids.project,
		environmentId: ids.environment,
		endpoint: '/v1/chat/completions',
		requestedModel: `observe-model-${run}`,
		status: 'success',
		tokensIn: 10,
		tokensOut: 5,
		totalTokens: 15,
		cost: 100n,
		currency: 'USD',
		latencyMs: 100,
		attempts: 1,
		createdAt: new Date('2026-09-30T12:00:00.000Z'),
		...overrides
	});
	return id;
}

const clearRequests = async () => {
	await db.delete(requestLog).where(sql`${requestLog.workspaceId} = ${ids.workspace}`);
};
const scope = { workspaceId: ids.workspace, projectId: ids.project };

it('walks 25 seeded rows by cursor with no duplicates and no gaps', async () => {
	await clearRequests();
	// 5 rows share each of 5 timestamps — a burst, which is exactly the case a
	// created_at-only keyset either duplicates or skips. The id breaks the tie.
	const seeded: { id: string; createdAt: Date }[] = [];
	for (let i = 0; i < 25; i++) {
		const createdAt = new Date(Date.UTC(2026, 8, 30, 12, Math.floor(i / 5)));
		const id = await seedRequest(i, { createdAt });
		seeded.push({ id, createdAt });
	}
	// Expected walk order: (created_at, id) descending — the order requestPage
	// sorts by, so the assertion compares the walk against its own contract.
	const expected = [...seeded]
		.sort(
			(a, b) =>
				b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
		)
		.map((r) => r.id);

	const walked: string[] = [];
	let after: Cursor | null = null;
	for (let page = 0; page < 10; page++) {
		const { rows, nextCursor } = await requestPage(db, ids.project, {}, after, 10);
		walked.push(...rows.map((r) => r.id));
		if (!nextCursor) break;
		after = cursorFromParam(nextCursor);
		expect(after, 'a next cursor must decode').not.toBeNull();
	}

	expect(walked).toHaveLength(25);
	expect(new Set(walked).size, 'no row appeared twice').toBe(25);
	expect(walked, 'no gaps, and the pinned order').toEqual(expected);
});

it('filters status across the taxonomy AND its legacy spellings', async () => {
	await clearRequests();
	const idsSeeded = [
		await seedRequest(1, { status: 'provider_error' }),
		await seedRequest(2, { status: 'upstream_error' }),
		await seedRequest(3, { status: 'internal_error' }),
		await seedRequest(4, { status: 'error' }),
		await seedRequest(5, { status: 'success' })
	];
	expect(idsSeeded).toHaveLength(5);

	const walkAll = async (query: string): Promise<string[]> => {
		const { rows } = await requestPage(db, ids.project, parseFilters(new URLSearchParams(query)), null, 50);
		return rows.map((r) => r.id);
	};
	// PRD §28: the filter includes both stored forms, so a legacy row is never
	// invisible just because the taxonomy renamed its status.
	expect((await walkAll('status=provider_error')).sort()).toEqual([idsSeeded[0], idsSeeded[1]].sort());
	expect((await walkAll('status=internal_error')).sort()).toEqual([idsSeeded[2], idsSeeded[3]].sort());
	expect(await walkAll('status=success')).toEqual([idsSeeded[4]]);
	// And the list column reports the taxonomy spelling for the legacy rows.
	const { rows } = await requestPage(db, ids.project, {}, null, 50);
	const byId = new Map(rows.map((r) => [r.id, r]));
	expect(byId.get(idsSeeded[1])!.status).toBe('upstream_error');
	expect(byId.get(idsSeeded[3])!.status).toBe('error');
});

it('parses filters defensively — junk never 500s and never silently filters', () => {
	const f = parseFilters(
		new URLSearchParams('maxLatency=abc&minCost=xyz&from=not-a-date&status=timeout&key=key_1')
	);
	expect(f.maxLatencyMs).toBeNull();
	expect(f.minCostMicro).toBeNull();
	expect(f.from).toBeNull();
	expect(f.status).toBe('timeout');
	expect(f.apiKey).toBe('key_1');
});

it('reads a date-only range as whole days, UTC', () => {
	// A date picker sends `YYYY-MM-DD`: `to` must cover the day, not stop at
	// its first millisecond (which would hide every row of the chosen day).
	const f = parseFilters(new URLSearchParams('from=2026-09-30&to=2026-09-30'));
	expect(f.from?.toISOString()).toBe('2026-09-30T00:00:00.000Z');
	expect(f.to?.toISOString()).toBe('2026-09-30T23:59:59.999Z');
	// A full instant still passes through untouched.
	const exact = parseFilters(new URLSearchParams('to=2026-09-30T12:00:00.000Z'));
	expect(exact.to?.toISOString()).toBe('2026-09-30T12:00:00.000Z');
});

it('returns request detail with its attempts and timing from seeded rows', async () => {
	await clearRequests();
	const createdAt = new Date('2026-09-30T14:00:00.000Z');
	const timing = { auth: 2, rate_limit: 1, routing: 3, queue: 4, connection: 5, generation: 80 };
	const requestId = await seedRequest(1, {
		createdAt,
		timing,
		ttftMs: 25,
		attempts: 2,
		fallbackUsed: true,
		httpStatus: 200,
		creditChargedMicro: 150n,
		providerCostMicro: 60n
	});
	const attemptRow = async (attempt: number, overrides: Partial<typeof requestAttempt.$inferInsert>) => {
		await db.insert(requestAttempt).values({
			id: `rta_${run}_${attempt}`,
			requestId,
			attempt,
			providerId: ids.provider,
			connectionId: null,
			latencyMs: 10,
			startedAt: createdAt,
			finishedAt: new Date(createdAt.getTime() + 10),
			...overrides
		});
	};
	// Attempt 1 fails upstream, attempt 2 wins — the routing trace PRD §29 shows.
	await attemptRow(1, { httpStatus: 503, errorCode: 'PROVIDER_UNAVAILABLE', retryable: true, latencyMs: 40 });
	await attemptRow(2, { retryable: false, reason: 'fallback after upstream 503', ttftMs: 25 });

	const { row, attempts } = await requestDetail(db, ids.project, requestId);
	expect(row, 'the seeded row resolves').not.toBeNull();
	expect(row!.id).toBe(requestId);
	// Timing comes through as the jsonb the detail page renders stage-by-stage.
	expect(row!.timing).toEqual(timing);
	expect(row!.ttftMs).toBe(25);
	expect(row!.creditChargedMicro).toBe(150n);
	expect(row!.providerCostMicro).toBe(60n);

	// The Timing section rows are built from exactly those fields: every PRD
	// §29 stage in order, then TTFT and the request total, missing stages null.
	expect(timingRows(row!.timing, row!.ttftMs, row!.latencyMs)).toEqual([
		{ key: 'auth', ms: 2 },
		{ key: 'rate_limit', ms: 1 },
		{ key: 'routing', ms: 3 },
		{ key: 'queue', ms: 4 },
		{ key: 'connection', ms: 5 },
		{ key: 'generation', ms: 80 },
		{ key: 'ttft', ms: 25 },
		{ key: 'total', ms: 100 }
	]);
	expect(timingRows(null, null, 42)).toEqual([
		{ key: 'auth', ms: null },
		{ key: 'rate_limit', ms: null },
		{ key: 'routing', ms: null },
		{ key: 'queue', ms: null },
		{ key: 'connection', ms: null },
		{ key: 'generation', ms: null },
		{ key: 'ttft', ms: null },
		{ key: 'total', ms: 42 }
	]);

	// Attempts in attempt order, each with its outcome (PRD §29 Routing Attempts).
	expect(attempts.map((a) => a.attempt)).toEqual([1, 2]);
	expect(attempts[0].errorCode).toBe('PROVIDER_UNAVAILABLE');
	expect(attempts[0].httpStatus).toBe(503);
	expect(attempts[0].retryable).toBe(true);
	expect(attempts[1].reason).toBe('fallback after upstream 503');
	expect(attempts[1].providerName).toBe(`observe-provider-${run}`);

	// Project scoping: the same id under another project must not resolve.
	expect((await requestDetail(db, 'prj_other', requestId)).row).toBeNull();
});

it('reconciles cost analytics with SUM(request_log.cost) for the range', async () => {
	await clearRequests();
	const inRange = new Date('2026-09-30T15:00:00.000Z');
	// Three rows inside the window, one outside it: the out-of-window row must
	// not reach any of the totals.
	const expected = [
		await seedRequest(1, { createdAt: inRange, cost: 250_000n, providerCostMicro: 100_000n, creditChargedMicro: 260_000n, totalTokens: 100 }),
		await seedRequest(2, { createdAt: inRange, cost: 500_000n, providerCostMicro: 250_000n, creditChargedMicro: 520_000n, totalTokens: 300 }),
		await seedRequest(3, {
			createdAt: inRange,
			cost: 25n,
			providerCostMicro: null,
			creditChargedMicro: null,
			totalTokens: 0,
			modelId: ids.model
		})
	];
	expect(expected).toHaveLength(3);
	await seedRequest(4, { createdAt: new Date('2026-09-01T00:00:00.000Z'), cost: 9_999_999n });

	const from = new Date('2026-09-30T00:00:00.000Z');
	const to = new Date('2026-09-30T23:59:59.999Z');
	const stats = await costStats(db, scope, from, to);

	// The reconciliation: what the page shows is SUM over the same rows the
	// ledger holds, computed independently of the code under test.
	const [sum] = await db
		.select({ total: sql<string>`coalesce(sum(${requestLog.cost}), 0)` })
		.from(requestLog)
		.where(
			and(
				eq(requestLog.workspaceId, ids.workspace),
				gte(requestLog.createdAt, from),
				lte(requestLog.createdAt, to)
			)
		);
	expect(stats.costMicro).toBe(BigInt(sum.total));
	expect(stats.costMicro).toBe(750_025n);
	expect(stats.providerCostMicro).toBe(350_000n);
	expect(stats.markupMicro).toBe(400_025n);
	expect(stats.creditsMicro).toBe(780_000n);
	expect(stats.requests).toBe(3);
	// Every breakdown sums back to the same total — no row lost in a group-by.
	for (const rows of [stats.byProvider, stats.byModel, stats.byEnvironment, stats.byProject]) {
		const rolled = rows.reduce((n, r) => n + r.costMicro, 0n);
		expect(rolled).toBe(stats.costMicro);
	}
});

it('reads usage_daily for long ranges and raw rows for short ones', async () => {
	await clearRequests();
	await db.delete(usageDaily).where(sql`${usageDaily.workspaceId} = ${ids.workspace}`);
	// Rollup rows across a 10-day window, all on the first day.
	const bucket = new Date('2026-09-01T00:00:00.000Z');
	// Raw rows for the same window: ignored while aggregates are populated.
	await seedRequest(1, { createdAt: new Date('2026-09-02T00:00:00.000Z'), cost: 777n });

	const longFrom = new Date('2026-09-01T00:00:00.000Z');
	const longTo = new Date('2026-09-11T00:00:00.000Z');
	// A long range with NO rollup rows yet (the job has not run) falls back to
	// raw and reports `raw`, so the page labels the numbers instead of showing
	// a confident zero for an un-rolled window.
	const beforeRollup = await usageTotals(db, scope, longFrom, longTo);
	expect(beforeRollup.source).toBe('raw');
	expect(beforeRollup.totals.costMicro).toBe(777n);

	// Now the rollup lands: the same window reads the aggregates and ignores
	// the raw row entirely.
	await db.insert(usageDaily).values({
		bucketStart: bucket,
		workspaceId: ids.workspace,
		projectId: ids.project,
		environmentId: ids.environment,
		apiKeyId: ids.key,
		modelId: ids.model,
		providerId: ids.provider,
		status: 'success',
		endpoint: '/v1/chat/completions',
		requests: 4,
		successes: 3,
		tokensIn: 40,
		tokensOut: 20,
		totalTokens: 60,
		costMicro: 400n,
		latencyMsSum: 400,
		latencyHistogram: { '100': 4 },
		ttftMsSum: 80,
		fallbackCount: 1,
		retryCount: 1
	});
	const agg = await usageTotals(db, scope, longFrom, longTo);
	expect(agg.source).toBe('aggregates');
	expect(agg.totals.requests).toBe(4);
	expect(agg.totals.costMicro).toBe(400n);
	expect(agg.totals.histogram).toEqual({ '100': 4 });

	// Short windows always read raw rows (PRD §96).
	const short = await usageTotals(
		db,
		scope,
		new Date('2026-09-30T00:00:00.000Z'),
		new Date('2026-09-30T23:59:59.999Z')
	);
	expect(short.source).toBe('raw');
});

it('breaks usage down by every dimension without losing rows', async () => {
	await clearRequests();
	await db.delete(usageDaily).where(sql`${usageDaily.workspaceId} = ${ids.workspace}`);
	await seedRequest(1, { createdAt: new Date('2026-09-30T10:00:00.000Z'), cost: 111n, totalTokens: 10 });
	await seedRequest(2, { createdAt: new Date('2026-09-30T11:00:00.000Z'), cost: 222n, totalTokens: 20 });
	const b = await usageBreakdowns(
		db,
		scope,
		new Date('2026-09-30T00:00:00.000Z'),
		new Date('2026-09-30T23:59:59.999Z'),
		'raw'
	);
	const total = (rows: { costMicro: bigint }[]) => rows.reduce((n, r) => n + r.costMicro, 0n);
	expect(total(b.byProject)).toBe(333n);
	expect(total(b.byEnvironment)).toBe(333n);
	expect(total(b.byApiKey)).toBe(333n);
	expect(total(b.byModel)).toBe(333n);
	expect(total(b.byProvider)).toBe(333n);
	expect(total(b.byDay)).toBe(333n);
	expect(b.byDay.map((d) => d.key)).toEqual(['2026-09-30']);
	expect(b.byDay.reduce((n, d) => n + d.requests, 0)).toBe(2);

	// Aggregates are also foldable per dimension: the usage page's long-range
	// breakdowns read `usage_daily` with the same shape as the raw path.
	await db.delete(usageDaily).where(sql`${usageDaily.workspaceId} = ${ids.workspace}`);
	await db.insert(usageDaily).values({
		bucketStart: new Date('2026-09-05T00:00:00.000Z'),
		workspaceId: ids.workspace,
		projectId: ids.project,
		environmentId: ids.environment,
		apiKeyId: ids.key,
		modelId: ids.model,
		providerId: ids.provider,
		status: 'success',
		endpoint: '/v1/chat/completions',
		requests: 7,
		successes: 7,
		totalTokens: 70,
		costMicro: 700n,
		latencyHistogram: {}
	});
	const fromAgg = await usageBreakdowns(
		db,
		scope,
		new Date('2026-09-01T00:00:00.000Z'),
		new Date('2026-09-11T00:00:00.000Z'),
		'aggregates'
	);
	expect(fromAgg.byDay.map((d) => d.key)).toEqual(['2026-09-05']);
	expect(fromAgg.byDay[0].requests).toBe(7);
	expect(total(fromAgg.byProject)).toBe(700n);
	expect(total(fromAgg.byModel)).toBe(700n);
});
