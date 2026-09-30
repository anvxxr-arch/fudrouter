import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

// Hermetic setup (see jobs.test.ts): pin env before the first import.
vi.hoisted(() => {
	process.env.DATABASE_URL ??= 'postgres://fudrouter:fudrouter@127.0.0.1:5432/fudrouter_test';
	process.env.VALKEY_URL = '';
});

import { db } from '$lib/server/db';
import { user as authUser } from '$lib/server/db/auth.schema';
import {
	apiKey,
	environment,
	model,
	provider,
	project,
	requestLog,
	systemEvent,
	usageDaily,
	usageHourly,
	workspace
} from '$lib/server/db/schema';
import { newId } from '$lib/server/id';
import { getSetting, setSetting } from '$lib/server/settings';
import { JOB_HANDLERS } from '$lib/server/workers';

const providerId = newId('prv_');
const modelId = newId('mdl_');
const workspaceId = newId('wrk_');
const projectId = newId('prj_');
const environmentId = newId('env_');
const userId = newId('usr_');
const apiKeyId = newId('key_');

beforeAll(async () => {
	await db.insert(provider).values({
		id: providerId,
		name: `JobsDelivery provider ${providerId}`,
		baseUrl: 'http://127.0.0.1:1/v1',
		credentialsEnc: 'test-ciphertext'
	});
	await db.insert(model).values({
		id: modelId,
		providerId,
		name: 'Test Model',
		slug: `jobs-test-model-${modelId}`,
		inputPrice: '0',
		outputPrice: '0'
	});
	await db
		.insert(workspace)
		.values({ id: workspaceId, name: 'JobsDelivery usage', slug: `jobs-usage-${workspaceId}` });
	await db.insert(project).values({ id: projectId, workspaceId, name: 'Usage', slug: 'usage' });
	await db
		.insert(environment)
		.values({ id: environmentId, projectId, name: 'prod', slug: 'prod', type: 'production' });
	await db
		.insert(authUser)
		.values({ id: userId, name: 'JobsDelivery', email: `jobs-test-${userId}@example.test` });
	await db.insert(apiKey).values({
		id: apiKeyId,
		userId,
		name: 'JobsDelivery key',
		prefix: `jt${userId.slice(-8)}`,
		keyHash: 'not-a-real-hash',
		workspaceId,
		projectId,
		environmentId
	});
});

afterAll(async () => {
	// Request rows survive their subject (spec §8, ON DELETE SET NULL) — delete
	// them explicitly before the FK parents go.
	await db.delete(usageHourly).where(eq(usageHourly.workspaceId, workspaceId));
	await db.delete(usageDaily).where(eq(usageDaily.workspaceId, workspaceId));
	await db.delete(requestLog).where(eq(requestLog.workspaceId, workspaceId));
	await db.delete(apiKey).where(eq(apiKey.id, apiKeyId));
	await db.delete(authUser).where(eq(authUser.id, userId));
	await db.delete(environment).where(eq(environment.id, environmentId));
	await db.delete(project).where(eq(project.id, projectId));
	await db.delete(workspace).where(eq(workspace.id, workspaceId));
	await db.delete(model).where(eq(model.id, modelId));
	await db.delete(provider).where(eq(provider.id, providerId));
	await db.$client.end({ timeout: 1 });
});

interface SeedRow {
	at: string;
	status: string;
	endpoint: string;
	apiKeyId: string | null;
	latencyMs: number;
	tokensIn: number;
	cached?: number;
	tokensOut: number;
	reasoning?: number;
	total: number;
	cost: number;
	ttft: number | null;
	attempts: number;
	fallback: boolean;
}

async function seedRequest(row: SeedRow): Promise<string> {
	const id = newId('req_');
	await db.insert(requestLog).values({
		id,
		workspaceId,
		projectId,
		environmentId,
		apiKeyId: row.apiKeyId,
		modelId,
		providerId,
		endpoint: row.endpoint,
		status: row.status,
		latencyMs: row.latencyMs,
		tokensIn: row.tokensIn,
		cachedInputTokens: row.cached ?? 0,
		tokensOut: row.tokensOut,
		reasoningTokens: row.reasoning ?? 0,
		totalTokens: row.total,
		cost: BigInt(row.cost),
		ttftMs: row.ttft,
		attempts: row.attempts,
		fallbackUsed: row.fallback,
		createdAt: new Date(row.at)
	});
	return id;
}

it('usage_aggregation rolls request_log into correct usage_hourly and usage_daily rows', async () => {
	const rows: SeedRow[] = [
		// 10:05 UTC — success, latency bucket 50.
		{
			at: '2026-09-30T10:05:00Z',
			status: 'success',
			endpoint: '/v1/chat/completions',
			apiKeyId,
			latencyMs: 40,
			tokensIn: 100,
			cached: 10,
			tokensOut: 20,
			reasoning: 5,
			total: 135,
			cost: 1000,
			ttft: 30,
			attempts: 1,
			fallback: false
		},
		// 10:59 UTC — same hour, failure with two retries, latency bucket 500.
		{
			at: '2026-09-30T10:59:00Z',
			status: 'provider_error',
			endpoint: '/v1/chat/completions',
			apiKeyId,
			latencyMs: 300,
			tokensIn: 200,
			tokensOut: 50,
			total: 250,
			cost: 2000,
			ttft: 60,
			attempts: 3,
			fallback: true
		},
		// 10:30 UTC — success, latency bucket 2500, provider reported no ttft.
		{
			at: '2026-09-30T10:30:00Z',
			status: 'success',
			endpoint: '/v1/chat/completions',
			apiKeyId,
			latencyMs: 1200,
			tokensIn: 1,
			tokensOut: 0,
			total: 1,
			cost: 0,
			ttft: null,
			attempts: 1,
			fallback: false
		},
		// 11:20 UTC — next hour, success, latency bucket 1000.
		{
			at: '2026-09-30T11:20:00Z',
			status: 'success',
			endpoint: '/v1/chat/completions',
			apiKeyId,
			latencyMs: 900,
			tokensIn: 500,
			tokensOut: 100,
			total: 600,
			cost: 5000,
			ttft: 60,
			attempts: 1,
			fallback: false
		},
		// 11:45 UTC — next hour, different endpoint + no key, latency bucket 50.
		{
			at: '2026-09-30T11:45:00Z',
			status: 'success',
			endpoint: '/v1/embeddings',
			apiKeyId: null,
			latencyMs: 10,
			tokensIn: 7,
			tokensOut: 0,
			total: 7,
			cost: 1234,
			ttft: null,
			attempts: 1,
			fallback: false
		}
	];
	for (const row of rows) await seedRequest(row);

	const window = { from: '2026-09-30T10:00:00Z', to: '2026-09-30T12:00:00Z' };
	await JOB_HANDLERS.usage_aggregation(db, window);

	const hourly = await db
		.select()
		.from(usageHourly)
		.where(eq(usageHourly.workspaceId, workspaceId))
		.orderBy(usageHourly.bucketStart, usageHourly.status, usageHourly.endpoint);
	// 2 (10:00 — success + provider_error) + 2 (11:00 — chat + embeddings).
	expect(hourly).toHaveLength(4);

	const h0success = hourly.find(
		(r) => r.bucketStart.toISOString() === '2026-09-30T10:00:00.000Z' && r.status === 'success'
	);
	expect(h0success).toBeDefined();
	expect(h0success!.requests).toBe(2);
	expect(h0success!.successes).toBe(2);
	expect(h0success!.tokensIn).toBe(101);
	expect(h0success!.cachedInputTokens).toBe(10);
	expect(h0success!.tokensOut).toBe(20);
	expect(h0success!.reasoningTokens).toBe(5);
	expect(h0success!.totalTokens).toBe(136);
	expect(h0success!.costMicro).toBe(BigInt(1000));
	expect(h0success!.latencyMsSum).toBe(1240);
	expect(h0success!.ttftMsSum).toBe(30);
	expect(h0success!.fallbackCount).toBe(0);
	expect(h0success!.retryCount).toBe(0);
	// Fixed buckets (spec §8): 40ms in "50", 1200ms in "2500", the rest empty.
	expect(h0success!.latencyHistogram).toEqual({
		'50': 1,
		'100': 0,
		'250': 0,
		'500': 0,
		'1000': 0,
		'2500': 1,
		'5000': 0,
		'10000': 0,
		'25000': 0,
		'60000': 0,
		inf: 0
	});

	const h0failure = hourly.find(
		(r) =>
			r.bucketStart.toISOString() === '2026-09-30T10:00:00.000Z' && r.status === 'provider_error'
	);
	expect(h0failure).toBeDefined();
	expect(h0failure!.requests).toBe(1);
	expect(h0failure!.successes).toBe(0);
	expect(h0failure!.tokensIn).toBe(200);
	expect(h0failure!.tokensOut).toBe(50);
	expect(h0failure!.totalTokens).toBe(250);
	expect(h0failure!.costMicro).toBe(BigInt(2000));
	expect(h0failure!.latencyMsSum).toBe(300);
	expect(h0failure!.ttftMsSum).toBe(60);
	expect(h0failure!.fallbackCount).toBe(1);
	expect(h0failure!.retryCount).toBe(2);
	expect(h0failure!.latencyHistogram).toMatchObject({ '500': 1 });

	const h1chat = hourly.find(
		(r) =>
			r.bucketStart.toISOString() === '2026-09-30T11:00:00.000Z' &&
			r.endpoint === '/v1/chat/completions'
	);
	expect(h1chat).toBeDefined();
	expect(h1chat!.requests).toBe(1);
	expect(h1chat!.costMicro).toBe(BigInt(5000));
	expect(h1chat!.latencyHistogram).toMatchObject({ '1000': 1 });

	const h1embed = hourly.find((r) => r.endpoint === '/v1/embeddings');
	expect(h1embed).toBeDefined();
	expect(h1embed!.apiKeyId).toBeNull();
	expect(h1embed!.requests).toBe(1);
	expect(h1embed!.costMicro).toBe(BigInt(1234));
	expect(h1embed!.latencyHistogram).toMatchObject({ '50': 1 });

	// usage_daily collapses both hours into the UTC day, still split by
	// status/endpoint — the same coalesced dimension tuple as the hour table.
	const daily = await db
		.select()
		.from(usageDaily)
		.where(eq(usageDaily.workspaceId, workspaceId))
		.orderBy(usageDaily.status, usageDaily.endpoint);
	expect(daily).toHaveLength(3);
	const dayChatSuccess = daily.find(
		(r) => r.status === 'success' && r.endpoint === '/v1/chat/completions'
	);
	expect(dayChatSuccess).toBeDefined();
	expect(dayChatSuccess!.bucketStart.toISOString()).toBe('2026-09-30T00:00:00.000Z');
	expect(dayChatSuccess!.requests).toBe(3);
	expect(dayChatSuccess!.successes).toBe(3);
	expect(dayChatSuccess!.tokensIn).toBe(601);
	expect(dayChatSuccess!.tokensOut).toBe(120);
	expect(dayChatSuccess!.reasoningTokens).toBe(5);
	expect(dayChatSuccess!.totalTokens).toBe(736);
	expect(dayChatSuccess!.costMicro).toBe(BigInt(6000));
	expect(dayChatSuccess!.latencyMsSum).toBe(2140);
	expect(dayChatSuccess!.ttftMsSum).toBe(90);

	// Idempotent (the queue may redeliver): a second run recomputes the same
	// buckets instead of doubling them.
	await JOB_HANDLERS.usage_aggregation(db, window);
	const rerun = await db
		.select()
		.from(usageHourly)
		.where(eq(usageHourly.workspaceId, workspaceId));
	expect(rerun).toHaveLength(4);
	expect(rerun.reduce((n, r) => n + r.requests, 0)).toBe(5);
	const rerunSuccess = await db
		.select()
		.from(usageDaily)
		.where(and(eq(usageDaily.workspaceId, workspaceId), eq(usageDaily.status, 'success')));
	// Success rows: chat 1000+0+5000 and embeddings 1234 = 7234 (the 2000
	// failure sits on its own status row). Unchanged by the rerun — the
	// recomputation replaces bucket values, it never adds deltas.
	expect(rerunSuccess.reduce((n, r) => n + Number(r.costMicro), 0)).toBe(7234);
});

it('data_retention_cleanup removes rows past their window and scrubs old content', async () => {
	// The retention sweep is DB-WIDE by design (it is a platform job), so the
	// test runs it inside a transaction that is always rolled back — the
	// assertions see the deletes while the shared test database never does.
	// Same idea as a temp table, without contending with sibling test files.
	const savedRetention = await getSetting('retention');
	await setSetting('retention', {
		request_metadata_days: 30,
		request_content_days: 7,
		system_events_days: 30,
		audit_logs_days: 365
	});

	const now = Date.now();
	const day = 86_400_000;
	const mkRow = (ageDays: number, body: string | null) =>
		db
			.insert(requestLog)
			.values({
				id: newId('req_'),
				workspaceId,
				projectId,
				environmentId,
				modelId,
				providerId,
				endpoint: '/v1/chat/completions',
				status: 'success',
				latencyMs: 5,
				tokensIn: 1,
				tokensOut: 1,
				totalTokens: 2,
				cost: BigInt(1),
				requestBody: body,
				responseBody: body,
				createdAt: new Date(now - ageDays * day)
			})
			.returning({ id: requestLog.id });

	// 40 days old: past both windows. 10 days old: metadata stays, content is
	// scrubbed. 1 day old: untouched.
	const [ancient] = await mkRow(40, 'ancient body');
	const [staleContent] = await mkRow(10, 'old body');
	const [fresh] = await mkRow(1, 'fresh body');
	const oldEvent = newId('evt_');
	await db.insert(systemEvent).values({
		id: oldEvent,
		type: 'retention_probe',
		resource: 'test',
		createdAt: new Date(now - 40 * day)
	});
	const newEvent = newId('evt_');
	await db.insert(systemEvent).values({ id: newEvent, type: 'retention_probe', resource: 'test' });

	await db.transaction(async (tx) => {
		await JOB_HANDLERS.data_retention_cleanup(tx, {});
		const surviving = await tx
			.select()
			.from(requestLog)
			.where(sql`${requestLog.id} in (${ancient.id}, ${staleContent.id}, ${fresh.id})`);
		expect(surviving.map((r) => r.id).sort()).toEqual([staleContent.id, fresh.id].sort());
		const keptStale = surviving.find((r) => r.id === staleContent.id)!;
		expect(keptStale.requestBody).toBeNull();
		expect(keptStale.responseBody).toBeNull();
		const keptFresh = surviving.find((r) => r.id === fresh.id)!;
		expect(keptFresh.requestBody).toBe('fresh body');
		expect(keptFresh.responseBody).toBe('fresh body');

		const events = await tx
			.select()
			.from(systemEvent)
			.where(sql`${systemEvent.id} in (${oldEvent}, ${newEvent})`);
		expect(events.map((e) => e.id)).toEqual([newEvent]);

		// Idempotent: a second run deletes/scrubs nothing more.
		await JOB_HANDLERS.data_retention_cleanup(tx, {});
		const after = await tx
			.select()
			.from(requestLog)
			.where(sql`${requestLog.id} in (${ancient.id}, ${staleContent.id}, ${fresh.id})`);
		expect(after).toHaveLength(2);
		throw new Error('rollback: retention test asserts without touching the shared database');
	}).catch((e: unknown) => {
		if (!(e instanceof Error) || !e.message.startsWith('rollback:')) throw e;
	});

	// Restore the platform's seeded retention policy (0007) and our rows.
	await setSetting('retention', savedRetention);
	await db
		.delete(requestLog)
		.where(sql`${requestLog.id} in (${ancient.id}, ${staleContent.id}, ${fresh.id})`);
	await db
		.delete(systemEvent)
		.where(sql`${systemEvent.id} in (${oldEvent}, ${newEvent})`);
});
