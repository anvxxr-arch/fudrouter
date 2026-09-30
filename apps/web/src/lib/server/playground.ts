/**
 * Playground execution against the DATA PLANE (PRD §27).
 *
 * The playground does not reimplement the router: it runs a real
 * `POST /v1/chat/completions` against `ROUTER_BASE_URL` under a real `sk-ar-`
 * key, so auth, policy, limits and billing behave exactly as a customer
 * request does. The only wrinkle is that key secrets are stored hash-only — an
 * existing key's secret cannot be replayed — so each run mints a short-lived
 * run key IN THE SELECTED KEY'S CONTEXT and reclaims it afterwards.
 *
 * Five rules (they are security properties, not style):
 *  1. self-expiring — `expires_at` is set at mint time; a crashed reclaim leaves
 *     a dead credential, not a live one;
 *  2. no escalation — workspace/project/environment/policy are COPIED from the
 *     selected key (or empty policy when the user has none), never widened;
 *  3. audited — mint and reclaim both write audit rows;
 *  4. marked — `policy.playground = true` so every key list can exclude runs;
 *  5. always reclaimed — disable first, then delete, in a `finally`.
 */
import { and, eq } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { apiKey, connection, environment, project, provider, requestLog } from '$lib/server/db/schema';
import { ID_PREFIXES, newId } from '$lib/server/id';
import { generateApiKey } from '$lib/server/keys';
import { writeAudit } from '$lib/server/audit';
import type { RunMetrics } from '$lib/playground';

/** Run keys die here even if the reclaim path never runs (rule 1). */
const RUN_KEY_TTL_MS = 5 * 60 * 1000;

export interface RunContext {
	workspaceId: string;
	projectId: string | null;
	environmentId: string | null;
	policy: Record<string, unknown>;
	/** Human label of the key context, for the metrics panel. */
	sourceKeyName: string;
}

/**
 * The context a run executes in: the user's chosen key's scope and policy, or
 * workspace + the project's `production` environment with an EMPTY policy
 * (platform defaults only) when they have no key to copy from.
 */
export async function resolveRunContext(
	locals: App.Locals,
	workspaceId: string,
	opts: { keyId?: string; projectId?: string }
): Promise<RunContext | null> {
	const userId = locals.user!.id;
	if (opts.keyId) {
		const [key] = await db
			.select({
				id: apiKey.id,
				name: apiKey.name,
				workspaceId: apiKey.workspaceId,
				projectId: apiKey.projectId,
				environmentId: apiKey.environmentId,
				policy: apiKey.policy
			})
			.from(apiKey)
			.where(
				and(
					eq(apiKey.id, opts.keyId),
					eq(apiKey.userId, userId),
					eq(apiKey.status, 'active')
				)
			)
			.limit(1);
		// A key from another workspace must never leak into this one's run.
		if (!key || (key.workspaceId !== null && key.workspaceId !== workspaceId)) return null;
		return {
			workspaceId: key.workspaceId ?? workspaceId,
			projectId: key.projectId ?? opts.projectId ?? null,
			environmentId: key.environmentId ?? null,
			policy: { ...(key.policy ?? {}), playground: true },
			sourceKeyName: key.name
		};
	}
	const [prod] = await db
		.select({ id: environment.id })
		.from(environment)
		.innerJoin(project, eq(project.id, environment.projectId))
		.where(and(eq(project.workspaceId, workspaceId), eq(environment.slug, 'production')))
		.limit(1);
	return {
		workspaceId,
		projectId: opts.projectId ?? null,
		environmentId: prod?.id ?? null,
		// Rule 2: with no key to copy, the run gets platform defaults only.
		policy: { playground: true },
		sourceKeyName: 'platform defaults'
	};
}

export const routerBase = (): string => (env.ROUTER_BASE_URL || 'http://127.0.0.1:8100').replace(/\/$/, '');

/**
 * Mint a run key. The returned `reclaim` disables first and deletes second, so
 * an interrupted reclaim leaves a disabled row, not a live one (rule 5).
 *
 * The plaintext exists only in the caller's frame — it is handed to the data
 * plane fetch and never returned to the browser or logged.
 */
export async function mintRunKey(
	locals: App.Locals,
	ctx: RunContext
): Promise<{ key: string; reclaim: () => Promise<void> }> {
	const { key, prefix, keyHash } = generateApiKey();
	const id = newId(ID_PREFIXES.apiKey);
	const now = new Date();
	const row = {
		id,
		userId: locals.user!.id,
		name: `[playground] ${now.toISOString().slice(0, 19)}Z`,
		prefix,
		keyHash,
		workspaceId: ctx.workspaceId,
		projectId: ctx.projectId,
		environmentId: ctx.environmentId,
		status: 'active',
		policy: ctx.policy,
		expiresAt: new Date(now.getTime() + RUN_KEY_TTL_MS)
	};
	await db.transaction(async (tx) => {
		await tx.insert(apiKey).values(row);
		await writeAudit(tx, {
			actorUserId: locals.user!.id,
			action: 'key.create',
			resource: 'api_key',
			resourceId: id,
			workspaceId: ctx.workspaceId,
			after: { name: row.name, policy: ctx.policy, playground: true }
		});
	});
	const reclaim = (async () => {
		let done = false;
		return async (): Promise<void> => {
			// Idempotent: the relay hands reclaim off to the pump and also guards
			// the pre-handoff path, so it can be reached twice. Disable-then-delete
			// must run exactly once (rule 5) — a second call is a no-op, not a
			// double audit row or a delete of a row another run just minted.
			if (done) return;
			done = true;
			await db.transaction(async (tx) => {
				await tx.update(apiKey).set({ status: 'disabled' }).where(eq(apiKey.id, id));
				await writeAudit(tx, {
					actorUserId: locals.user!.id,
					action: 'key.revoke',
					resource: 'api_key',
					resourceId: id,
					workspaceId: ctx.workspaceId,
					metadata: { playground: true, reason: 'run key reclaimed' }
				});
				await tx.delete(apiKey).where(eq(apiKey.id, id));
			});
		};
	})();
	return { key, reclaim: await reclaim };
}

/**
 * Buffered-run sugar over `mintRunKey` (rule 5 in a `finally`). `fn` MUST fully
 * consume the response body before returning — the data plane writes its
 * `request_log` row after the body ends, so returning a live `Response` here
 * would reclaim (delete) the run key before that insert.
 *
 * The streaming relay cannot use this shape — it must reclaim only AFTER the
 * upstream stream ends — so it calls `mintRunKey` and reclaims on completion
 * and on client cancel instead.
 */
export async function withRunKey<T>(
	locals: App.Locals,
	ctx: RunContext,
	fn: (key: string) => Promise<T>
): Promise<T> {
	const { key, reclaim } = await mintRunKey(locals, ctx);
	try {
		return await fn(key);
	} finally {
		await reclaim();
	}
}

/** The one place that dials the data plane's chat endpoint (PRD §27). */
export function chatCompletionsRequest(
	key: string,
	body: Record<string, unknown>,
	strategy: string | null
): Promise<Response> {
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		authorization: `Bearer ${key}`
	};
	// A per-request override: it picks the strategy, never loosens the bound
	// policy's attempts/timeout/constraints.
	if (strategy) headers['x-fudrouter-strategy'] = strategy;
	return fetch(`${routerBase()}/v1/chat/completions`, {
		method: 'POST',
		headers,
		body: JSON.stringify(body)
	});
}

/** Short pause while the data plane's request_log write lands. */
function delay(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/**
 * Metrics for a finished run, read from the request ledger row the data plane
 * wrote (`x-fudrouter-request-id` → `request_log`). `logRequest` fires after the
 * response is written, so a missing row is retried a few times before giving up
 * — the panel then shows `—` instead of inventing values.
 */
export async function fetchRunMetrics(requestId: string): Promise<Partial<RunMetrics>> {
	// No correlation id = nothing to find; skip the retry loop entirely rather
	// than sleeping 750ms for a row that cannot exist.
	if (!requestId) return {};
	for (let i = 0; i < 5; i++) {
		const [row] = await db
			.select({
				requestId: requestLog.id,
				providerId: requestLog.providerId,
				connectionId: requestLog.connectionId,
				actualModel: requestLog.requestedModel,
				tokensIn: requestLog.tokensIn,
				tokensOut: requestLog.tokensOut,
				tokensTotal: requestLog.totalTokens,
				ttftMs: requestLog.ttftMs,
				latencyMs: requestLog.latencyMs,
				cost: requestLog.cost,
				fallback: requestLog.fallbackUsed,
				attempts: requestLog.attempts
			})
			.from(requestLog)
			.where(eq(requestLog.id, requestId))
			.limit(1);
		if (row) {
			const [prov] = row.providerId
				? await db.select({ slug: provider.slug, name: provider.name }).from(provider).where(eq(provider.id, row.providerId)).limit(1)
				: [];
			const [con] = row.connectionId
				? await db.select({ name: connection.name }).from(connection).where(eq(connection.id, row.connectionId)).limit(1)
				: [];
			return {
				requestId: row.requestId,
				provider: prov ? (prov.slug ?? prov.name) : null,
				connection: con?.name ?? null,
				actualModel: row.actualModel,
				tokensIn: row.tokensIn,
				tokensOut: row.tokensOut,
				tokensTotal: row.tokensTotal,
				ttftMs: row.ttftMs,
				latencyMs: row.latencyMs,
				costMicro: row.cost !== null ? String(row.cost) : null,
				fallback: row.fallback,
				attempts: row.attempts
			};
		}
		await delay(150);
	}
	return {};
}


