import { error, fail } from '@sveltejs/kit';
import { and, desc, eq, or, sql } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { requireCap } from '$lib/server/roles';
import { decryptCredentials, type Credentials } from '$lib/server/credentials';
import { allowDevProviders, allowPrivateUpstreams } from '$lib/server/publish-env';
import { usdToMicro } from '$lib/server/admin';
import { writeAudit } from '$lib/server/audit';
import { newId, ID_PREFIXES } from '$lib/server/id';
import { guardedUpstreamFetch } from '$lib/server/ssrf';
import { headersFor, tokenAt } from '$lib/server/provider-credentials';
import { fetchUpstreamCatalog, getProvider } from '$lib/server/provider-catalog-fetch';
import { db } from '$lib/server/db';
import {
	circuitBreaker,
	connection,
	credential,
	model,
	pricingRule,
	provider,
	providerModel,
	rateLimit,
	requestLog
} from '$lib/server/db/schema';
import { matchKey, seedState } from '$lib/provider-catalog';
import { reachability } from '$lib/publish';
import {
	MAX_BATCH_MODELS,
	MAX_CHAT_CHARS,
	MAX_PRIORITY,
	MIN_PRIORITY,
	cleanSlug,
	cleanText,
	parseModelPayloads,
	parsePriority,
	parseSlugList,
	parseTier
} from '$lib/server/admin-limits';

/** Upper bound on credentials probed in one "test all" run, so the POST returns. */
const MAX_BULK_TEST = 40;
/** A reasoning model on a cold upstream was measured at 27s for one word. */
const CHAT_TIMEOUT_MS = 60_000;

/** The provider's connections, lowest priority number first. */
async function connectionRows(providerId: string) {
	return db
		.select({
			id: connection.id,
			name: connection.name,
			slug: connection.slug,
			baseUrl: connection.baseUrl,
			region: connection.region,
			authType: connection.authType,
			timeoutMs: connection.timeoutMs,
			priority: connection.priority,
			enabled: connection.enabled,
			healthStatus: connection.healthStatus
		})
		.from(connection)
		.where(eq(connection.providerId, providerId))
		.orderBy(connection.priority, connection.name);
}

/**
 * The provider's credential rows, ordered so a form `index` addresses one stable
 * row. Includes `secretEnc` ONLY for the action call sites that must
 * authenticate; nothing derived from it reaches page data.
 */
async function credentialRows(providerId: string) {
	return db
		.select({
			id: credential.id,
			connectionId: credential.connectionId,
			name: credential.name,
			status: credential.status,
			priority: credential.priority,
			weight: credential.weight,
			secretEnc: credential.secretEnc
		})
		.from(credential)
		.innerJoin(connection, eq(connection.id, credential.connectionId))
		.where(eq(connection.providerId, providerId))
		.orderBy(credential.priority, credential.name, credential.id);
}

/** One credential row's plaintext blob, or null when it cannot be decrypted. */
function blobOf(row: { secretEnc: string } | undefined): Credentials | null {
	if (!row) return null;
	try {
		return decryptCredentials(row.secretEnc);
	} catch {
		return null;
	}
}

export const load: PageServerLoad = async ({ locals, params }) => {
	requireCap(locals, 'admin.providers');
	const p = await getProvider(params.id);
	if (!p) error(404, 'Provider not found');
	const allowDev = allowDevProviders();
	const conns = await connectionRows(p.id);
	// A provider row created before the connection split still has its endpoint on
	// `provider.base_url`; prefer the connection's, fall back to the legacy column.
	const baseUrl = conns[0]?.baseUrl ?? p.baseUrl;
	// The display projection of the pool: `secretEnc` is not in the column list,
	// so no secret material exists anywhere in this load's data.
	const creds = await db
		.select({
			id: credential.id,
			connectionId: credential.connectionId,
			name: credential.name,
			status: credential.status
		})
		.from(credential)
		.innerJoin(connection, eq(connection.id, credential.connectionId))
		.where(eq(connection.providerId, p.id))
		.orderBy(credential.priority, credential.name, credential.id);
	const models = await db
		.select({
			id: model.id,
			slug: model.slug,
			name: model.name,
			context: model.context,
			inputPrice: model.inputPrice,
			outputPrice: model.outputPrice,
			status: model.status
		})
		.from(model)
		.where(eq(model.providerId, p.id))
		.orderBy(sql`${model.slug}`);
	// Usage. `request_log` is the only place a call is recorded, so every number
	// here is an observed fact rather than a configuration claim. Percentiles come
	// from percentile_cont over latency_ms — the row's own latency, no joins.
	const [totals] = await db
		.select({
			requests: sql<number>`count(*)::int`,
			ok: sql<number>`count(*) filter (where ${requestLog.status} = 'success')::int`,
			p50: sql<number>`coalesce(round(percentile_cont(0.5) within group (order by ${requestLog.latencyMs})), 0)::int`,
			p95: sql<number>`coalesce(round(percentile_cont(0.95) within group (order by ${requestLog.latencyMs})), 0)::int`,
			p99: sql<number>`coalesce(round(percentile_cont(0.99) within group (order by ${requestLog.latencyMs})), 0)::int`,
			rate429: sql<number>`count(*) filter (where ${requestLog.httpStatus} = 429)::int`,
			rate5xx: sql<number>`count(*) filter (where ${requestLog.httpStatus} between 500 and 599)::int`,
			tokensIn: sql<number>`coalesce(sum(${requestLog.tokensIn}), 0)::int`,
			tokensOut: sql<number>`coalesce(sum(${requestLog.tokensOut}), 0)::int`,
			cost: sql<string>`coalesce(sum(${requestLog.cost}), 0)::text`
		})
		.from(requestLog)
		.where(eq(requestLog.providerId, p.id));
	const [day] = await db
		.select({
			requests: sql<number>`count(*)::int`,
			ok: sql<number>`count(*) filter (where ${requestLog.status} = 'success')::int`,
			p50: sql<number>`coalesce(round(percentile_cont(0.5) within group (order by ${requestLog.latencyMs})), 0)::int`,
			p95: sql<number>`coalesce(round(percentile_cont(0.95) within group (order by ${requestLog.latencyMs})), 0)::int`,
			p99: sql<number>`coalesce(round(percentile_cont(0.99) within group (order by ${requestLog.latencyMs})), 0)::int`,
			rate429: sql<number>`count(*) filter (where ${requestLog.httpStatus} = 429)::int`,
			rate5xx: sql<number>`count(*) filter (where ${requestLog.httpStatus} between 500 and 599)::int`
		})
		.from(requestLog)
		.where(
			and(
				eq(requestLog.providerId, p.id),
				sql`${requestLog.createdAt} > now() - interval '24 hours'`
			)
		);
	const perModel = await db
		.select({
			slug: model.slug,
			requests: sql<number>`count(*)::int`,
			ok: sql<number>`count(*) filter (where ${requestLog.status} = 'success')::int`,
			p50: sql<number>`coalesce(round(percentile_cont(0.5) within group (order by ${requestLog.latencyMs})), 0)::int`,
			p95: sql<number>`coalesce(round(percentile_cont(0.95) within group (order by ${requestLog.latencyMs})), 0)::int`
		})
		.from(requestLog)
		.innerJoin(model, eq(model.id, requestLog.modelId))
		.where(eq(requestLog.providerId, p.id))
		.groupBy(model.slug)
		.orderBy(desc(sql`count(*)`))
		.limit(12);
	const errors = await db
		.select({
			errorCode: requestLog.errorCode,
			httpStatus: requestLog.httpStatus,
			error: requestLog.error,
			n: sql<number>`count(*)::int`,
			lastAt: sql<string | null>`max(${requestLog.createdAt})::text`
		})
		.from(requestLog)
		.where(and(eq(requestLog.providerId, p.id), sql`${requestLog.status} <> 'success'`))
		.groupBy(requestLog.errorCode, requestLog.httpStatus, requestLog.error)
		.orderBy(desc(sql`count(*)`))
		.limit(20);
	const recent = await db
		.select({
			slug: model.slug,
			status: requestLog.status,
			httpStatus: requestLog.httpStatus,
			latencyMs: requestLog.latencyMs,
			tokensIn: requestLog.tokensIn,
			tokensOut: requestLog.tokensOut,
			error: requestLog.error,
			createdAt: requestLog.createdAt
		})
		.from(requestLog)
		.innerJoin(model, eq(model.id, requestLog.modelId))
		.where(eq(requestLog.providerId, p.id))
		.orderBy(desc(requestLog.createdAt))
		.limit(20);
	// Credentials: labels only. `secretEnc` is never selected into page data —
	// decryption happens in the actions that must authenticate, nowhere else.
	const credAgg = await db
		.select({
			total: sql<number>`count(*)::int`,
			healthy: sql<number>`count(*) filter (where ${credential.status} = 'healthy')::int`,
			unknown: sql<number>`count(*) filter (where ${credential.status} = 'unknown')::int`,
			bad: sql<number>`count(*) filter (where ${credential.status} in ('auth_failed', 'invalid'))::int`,
			cooldown: sql<number>`count(*) filter (where ${credential.status} in ('cooldown', 'rate_limited'))::int`
		})
		.from(credential)
		.innerJoin(connection, eq(connection.id, credential.connectionId))
		.where(eq(connection.providerId, p.id));
	const connName = new Map(conns.map((c) => [c.id, c.name]));
	const labels = creds.map((c, index) => ({
		label: c.name,
		index,
		status: c.status,
		connection: connName.get(c.connectionId) ?? '—'
	}));
	const mappings = await db
		.select({
			id: providerModel.id,
			providerModelId: providerModel.providerModelId,
			modelSlug: model.slug,
			connectionId: providerModel.connectionId,
			enabled: providerModel.enabled,
			status: providerModel.status,
			contextOverride: providerModel.contextOverride
		})
		.from(providerModel)
		.innerJoin(model, eq(model.id, providerModel.modelId))
		.where(eq(providerModel.providerId, p.id))
		.orderBy(sql`${model.slug}`);
	const pricing = await db
		.select({
			id: pricingRule.id,
			modelSlug: model.slug,
			version: pricingRule.version,
			currency: pricingRule.currency,
			inputPrice: pricingRule.inputPrice,
			cachedInputPrice: pricingRule.cachedInputPrice,
			outputPrice: pricingRule.outputPrice,
			reasoningPrice: pricingRule.reasoningPrice,
			effectiveFrom: pricingRule.effectiveFrom,
			effectiveUntil: pricingRule.effectiveUntil
		})
		.from(pricingRule)
		.innerJoin(model, eq(model.id, pricingRule.modelId))
		.where(eq(model.providerId, p.id))
		.orderBy(desc(pricingRule.effectiveFrom))
		.limit(50);
	const limits = await db
		.select({
			id: rateLimit.id,
			scope: rateLimit.scope,
			scopeId: rateLimit.scopeId,
			rpm: rateLimit.rpm,
			tpm: rateLimit.tpm,
			rpd: rateLimit.rpd,
			tpd: rateLimit.tpd,
			concurrency: rateLimit.concurrency
		})
		.from(rateLimit)
		.where(and(eq(rateLimit.scope, 'provider'), eq(rateLimit.scopeId, p.id)));
	const breakers = await db
		.select({
			id: circuitBreaker.id,
			target: circuitBreaker.target,
			targetId: circuitBreaker.targetId,
			failureThreshold: circuitBreaker.failureThreshold,
			windowSeconds: circuitBreaker.windowSeconds,
			openMs: circuitBreaker.openMs,
			halfOpenProbes: circuitBreaker.halfOpenProbes,
			enabled: circuitBreaker.enabled
		})
		.from(circuitBreaker)
		.where(and(eq(circuitBreaker.target, 'provider'), eq(circuitBreaker.targetId, p.id)));
	const seeded = new Map(models.map((m) => [m.slug, m.status]));
	return {
		provider: {
			id: p.id,
			name: p.name,
			slug: p.slug,
			description: p.description,
			type: p.type,
			status: p.status,
			tier: p.tier,
			homepage: p.homepage,
			documentationUrl: p.documentationUrl,
			enabled: p.enabled,
			baseUrl,
			priority: p.priority,
			createdAt: p.createdAt.toISOString()
		},
		allowDev,
		connections: conns,
		credentials: {
			count: creds.length,
			labels,
			healthy: credAgg[0]?.healthy ?? 0,
			unknown: credAgg[0]?.unknown ?? 0,
			bad: credAgg[0]?.bad ?? 0,
			cooldown: credAgg[0]?.cooldown ?? 0
		},
		models: models.map((m) => ({
			...m,
			inputMicro: microString(m.inputPrice),
			outputMicro: microString(m.outputPrice)
		})),
		mappings,
		pricing: pricing.map((r) => ({
			...r,
			inputMicro: microString(r.inputPrice),
			cachedInputMicro: r.cachedInputPrice === null ? null : microString(r.cachedInputPrice),
			outputMicro: microString(r.outputPrice),
			reasoningMicro: r.reasoningPrice === null ? null : microString(r.reasoningPrice)
		})),
		limits,
		breakers,
		seededSlugs: [...seeded.keys()],
		stats: {
			totals: { ...totals, costMicro: totals.cost },
			day,
			perModel,
			errors,
			recent: recent.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }))
		},
		published: models.filter((m) => m.status === 'active').length,
		reachable: models.filter((m) => reachability(m.status, p.status, allowDev).served).length
	};
};

/**
 * numeric(18,6) micro-units -> whole micro-units as a digit string.
 * The fractional part is sub-micro and display-only noise; BigInt needs digits.
 */
function microString(value: string): string {
	return String(value).split('.')[0] || '0';
}

export const actions: Actions = {
	/** Live catalog fetch. Nothing is written — the admin chooses what to enable. */
	fetchCatalog: async ({ locals, request, params }) => {
		requireCap(locals, 'admin.providers');
		const form = await request.formData();
		const tier = parseTier(form.get('tier'));
		const p = await getProvider(params.id);
		if (!p) return fail(404, { error: 'Provider not found' });
		const conns = await connectionRows(p.id);
		const baseUrl = conns[0]?.baseUrl ?? p.baseUrl;
		if (!baseUrl) return fail(400, { error: 'Add a connection with a base URL first' });
		const cred = await authBlob(params.id);
		if (!cred) return fail(400, { error: 'Cannot decrypt a credential for this provider' });
		const started = Date.now();
		try {
			const { models, status, url, rateLimit: rl } = await fetchUpstreamCatalog(baseUrl, cred);
			if (status !== 200) {
				return fail(502, { error: `Upstream returned HTTP ${status} for ${url}` });
			}
			const seeded = new Map(
				(
					await db
						.select({ slug: model.slug, status: model.status })
						.from(model)
						.where(eq(model.providerId, params.id))
				).map((m) => [matchKey(m.slug), m.status])
			);
			const all = models.map((m) => ({ ...m, state: seedState(seeded.get(matchKey(m.slug))) }));
			return {
				fetched: {
					tier,
					url,
					latencyMs: Date.now() - started,
					total: all.length,
					models: all,
					rateLimit: rl
				}
			};
		} catch (err) {
			return fail(502, {
				error: `Could not reach ${baseUrl}: ${err instanceof Error ? err.message : 'request failed'}`
			});
		}
	},
	/** Upsert the submitted models as published. */
	enable: async ({ locals, request, params }) => {
		requireCap(locals, 'admin.providers');
		const form = await request.formData();
		const p = await getProvider(params.id);
		if (!p) return fail(404, { error: 'Provider not found' });
		// One lookup for the whole batch, keyed by the match form of the slug:
		// an upstream id and a stored slug can differ by a `models/` prefix.
		const known = new Map(
			(
				await db
					.select({
						id: model.id,
						providerId: model.providerId,
						slug: model.slug,
						status: model.status
					})
					.from(model)
			).map((m) => [matchKey(m.slug), m])
		);
		const batch = parseModelPayloads(form.getAll('payload').map(String));
		const added: string[] = [];
		let published = 0;
		const skipped: string[] = [];
		for (const row of batch.rows) {
			const slug = row.slug;
			// Costs are USD per 1M tokens in the payload and micro-units in the column.
			const input = usdToMicro(String(row.inputUsd)) ?? '0';
			const output = usdToMicro(String(row.outputUsd)) ?? '0';
			const existing = known.get(matchKey(slug));
			if (!existing) {
				try {
					await db.transaction(async (tx) => {
						const id = newId(ID_PREFIXES.model);
						await tx.insert(model).values({
							id,
							providerId: p.id,
							name: row.name,
							slug,
							context: row.context,
							inputPrice: input,
							outputPrice: output,
							status: 'active'
						});
						await writeAudit(tx, {
							actorUserId: locals.user?.id ?? null,
							action: 'model.create',
							resource: 'model',
							resourceId: id,
							after: { slug, name: row.name, providerId: p.id, inputPrice: input, outputPrice: output }
						});
					});
					added.push(slug);
				} catch {
					skipped.push(slug);
				}
				continue;
			}
			if (existing.providerId !== p.id) {
				// model.slug is unique table-wide: another provider owns this slug.
				skipped.push(slug);
				continue;
			}
			await db.transaction(async (tx) => {
				await tx.update(model).set({ status: 'active' }).where(eq(model.id, existing.id));
				await writeAudit(tx, {
					actorUserId: locals.user?.id ?? null,
					action: 'model.publish',
					resource: 'model',
					resourceId: existing.id,
					before: { status: existing.status },
					after: { status: 'active' }
				});
			});
			published += 1;
		}
		const parts = [`${added.length} added`, `${published} published`];
		if (skipped.length)
			parts.push(`${skipped.length} skipped (owned elsewhere): ${skipped.slice(0, 5).join(', ')}`);
		if (batch.rejected) parts.push(`${batch.rejected} rejected as invalid`);
		if (batch.duplicates) parts.push(`${batch.duplicates} duplicate(s) collapsed`);
		if (batch.overCap) parts.push(`${batch.overCap} beyond the ${MAX_BATCH_MODELS} per-request limit`);
		return { message: `Enable: ${parts.join(', ')}.` };
	},
	/** Hide the submitted models without deleting them. */
	disable: async ({ locals, request, params }) => {
		requireCap(locals, 'admin.providers');
		const form = await request.formData();
		const { slugs, overCap } = parseSlugList(form.getAll('slug').map(String));
		if (slugs.length === 0) return fail(400, { error: 'Select at least one model' });
		// Match either form: the gallery shows upstream ids, the catalog stores the
		// routable slug, and they can differ by a `models/` prefix.
		const forms = [...new Set([...slugs, ...slugs.map(matchKey)])];
		// Built from `or(eq…)` rather than an array bind: drizzle renders
		// `= any($1)` as `any(($1))`, which Postgres rejects as `any(text)`.
		const disabled = await db.transaction(async (tx) => {
			const updated = await tx
				.update(model)
				.set({ status: 'disabled' })
				.where(and(eq(model.providerId, params.id), or(...forms.map((s) => eq(model.slug, s)))))
				.returning({ id: model.id, slug: model.slug });
			for (const row of updated) {
				await writeAudit(tx, {
					actorUserId: locals.user?.id ?? null,
					action: 'model.disable',
					resource: 'model',
					resourceId: row.id,
					before: { status: 'active' },
					after: { status: 'disabled' }
				});
			}
			return updated;
		});
		const note = overCap ? ` (${overCap} beyond the ${MAX_BATCH_MODELS} per-request limit)` : '';
		return { message: `Disabled ${disabled.length} model(s)${note}.` };
	},
	/** Probe one credential (by its index in the pool) against `<baseUrl>/models`. */
	testCredential: async ({ locals, request, params }) => {
		requireCap(locals, 'admin.providers');
		const form = await request.formData();
		const p = await getProvider(params.id);
		if (!p) return fail(404, { error: 'Provider not found' });
		const conns = await connectionRows(p.id);
		const baseUrl = conns[0]?.baseUrl ?? p.baseUrl;
		if (!baseUrl) return fail(400, { error: 'Add a connection with a base URL first' });
		const creds = await credentialRows(params.id);
		const index = Number(String(form.get('index') ?? '').trim());
		// An index that addresses nothing would probe with an empty token and report
		// a 401 that has nothing to do with the credential.
		if (!Number.isInteger(index) || index < 0 || index >= creds.length) {
			return fail(400, { error: 'Pick a credential that exists' });
		}
		const row = creds[index];
		const cred = blobOf(row) ?? (await authBlob(params.id));
		if (!cred) return fail(400, { error: 'Cannot decrypt credentials' });
		const label = row.name;
		const started = Date.now();
		try {
			const { status, models, rateLimit: rl } = await fetchUpstreamCatalog(baseUrl, cred);
			return {
				credentialTest: {
					label,
					index,
					ok: status === 200,
					status,
					latencyMs: Date.now() - started,
					modelCount: models.length,
					rateLimit: rl,
					error: null as string | null
				}
			};
		} catch (err) {
			return {
				credentialTest: {
					label,
					index,
					ok: false,
					status: null,
					latencyMs: Date.now() - started,
					modelCount: 0,
					rateLimit: {},
					error: err instanceof Error ? err.message : 'request failed'
				}
			};
		}
	},
	/** Probe every credential (bounded) and report per-credential health. */
	testAll: async ({ locals, params }) => {
		requireCap(locals, 'admin.providers');
		const p = await getProvider(params.id);
		if (!p) return fail(404, { error: 'Provider not found' });
		const conns = await connectionRows(p.id);
		const baseUrl = conns[0]?.baseUrl ?? p.baseUrl;
		if (!baseUrl) return fail(400, { error: 'Add a connection with a base URL first' });
		const creds = await credentialRows(params.id);
		const legacy = creds.length === 0 ? await authBlob(p.id) : null;
		// A pre-pool provider has one legacy envelope instead of rows; probe it
		// as a single "legacy" credential so the dashboard says something true.
		const probes = creds.length
			? creds.slice(0, MAX_BULK_TEST).map((row, index) => ({ label: row.name, index, cred: blobOf(row) }))
			: legacy
				? [{ label: 'legacy envelope', index: 0, cred: legacy }]
				: [];
		const results = await Promise.all(
			probes.map(async ({ label, index, cred }) => {
				const started = Date.now();
				if (!cred) {
					return {
						label,
						index,
						ok: false,
						status: null as number | null,
						latencyMs: 0,
						modelCount: 0,
						rateLimit: {} as Record<string, string>,
						error: 'cannot decrypt credentials'
					};
				}
				try {
					const { status, models, rateLimit: rl } = await fetchUpstreamCatalog(baseUrl, cred);
					return {
						label,
						index,
						ok: status === 200,
						status,
						latencyMs: Date.now() - started,
						modelCount: models.length,
						rateLimit: rl,
						error: null as string | null
					};
				} catch (err) {
					return {
						label,
						index,
						ok: false,
						status: null as number | null,
						latencyMs: Date.now() - started,
						modelCount: 0,
						rateLimit: {} as Record<string, string>,
						error: err instanceof Error ? err.message : 'request failed'
					};
				}
			})
		);
		return {
			credentialTests: results,
			bulkNote:
				creds.length > MAX_BULK_TEST
					? `Tested the first ${MAX_BULK_TEST} of ${creds.length} credentials.`
					: null
		};
	},
	/** One tiny chat against the upstream, to prove a model actually answers. */
	testModel: async ({ locals, request, params }) => {
		requireCap(locals, 'admin.providers');
		const form = await request.formData();
		const slug = cleanSlug(form.get('slug'));
		if (!slug) return fail(400, { error: 'Missing or malformed model slug' });
		const out = await chatViaCredential(params.id, slug, 'Say OK');
		if ('fatal' in out)
			return fail(out.fatal === 'provider not found' ? 404 : 400, { error: out.fatal });
		return { modelTest: { ...out.result, slug } };
	},
	/** Playground: real chat through the provider, no system prompt, no tools. */
	chat: async ({ locals, request, params }) => {
		requireCap(locals, 'admin.providers');
		const form = await request.formData();
		const slug = cleanSlug(form.get('slug'));
		const message = cleanText(form.get('message'));
		if (!slug) return fail(400, { error: 'Pick a model' });
		if (!message)
			return fail(400, { error: `Type a message (up to ${MAX_CHAT_CHARS} characters)` });
		const out = await chatViaCredential(params.id, slug, message);
		if ('fatal' in out)
			return fail(out.fatal === 'provider not found' ? 404 : 400, { error: out.fatal });
		return { chat: { ...out.result, slug, message } };
	},
	/** Routing configuration this page owns: priority. */
	strategy: async ({ locals, request, params }) => {
		requireCap(locals, 'admin.providers');
		const form = await request.formData();
		const priority = parsePriority(form.get('priority'));
		if (priority === null)
			return fail(400, {
				error: `Priority must be a whole number between ${MIN_PRIORITY} and ${MAX_PRIORITY}`
			});
		const [before] = await db
			.select({ id: provider.id, priority: provider.priority })
			.from(provider)
			.where(eq(provider.id, params.id))
			.limit(1);
		if (!before) return fail(404, { error: 'Provider not found' });
		await db.transaction(async (tx) => {
			await tx.update(provider).set({ priority }).where(eq(provider.id, params.id));
			await writeAudit(tx, {
				actorUserId: locals.user?.id ?? null,
				action: 'provider.update',
				resource: 'provider',
				resourceId: params.id,
				before: { priority: before.priority },
				after: { priority }
			});
		});
		return { message: `Priority set to ${priority}.` };
	}
};

/**
 * The blob a probe authenticates with: the first credential row's `secret_enc`,
 * or — for a provider created before the credential pool existed — the legacy
 * `provider.credentials_enc` envelope. Decryption happens here; the plaintext
 * never leaves the action that asked for it.
 */
async function authBlob(providerId: string): Promise<Credentials | null> {
	const first = (await credentialRows(providerId))[0];
	if (first) return blobOf(first);
	const legacy = await getProvider(providerId);
	return legacy?.credentialsEnc ? blobOf({ secretEnc: legacy.credentialsEnc }) : null;
}

/**
 * A real chat through the provider's first connection + credential rows.
 *
 * The shared `sandboxChat` reads the legacy `provider.credentials_enc` blob;
 * credentials live on `credential.secret_enc` now, so the same probe runs here
 * against those rows. Same result shape as `SandboxResult`, same guards.
 */
async function chatViaCredential(
	providerId: string,
	slug: string,
	message: string
): Promise<
	| { fatal: string }
	| {
			result: {
				ok: boolean;
				status: number | null;
				latencyMs: number;
				tokensIn: number | null;
				tokensOut: number | null;
				content: string | null;
				reasoning: string | null;
				finishReason: string | null;
				error: string | null;
			};
	  }
> {
	const conns = await connectionRows(providerId);
	const cred = await authBlob(providerId);
	if (!cred) return { fatal: 'credentials could not be decrypted' };
	const baseUrl = conns[0]?.baseUrl ?? (await getProvider(providerId))?.baseUrl;
	if (!baseUrl) return { fatal: 'provider not found' };
	const headers = { ...headersFor(cred, tokenAt(cred, 0)), 'content-type': 'application/json' };
	const body = JSON.stringify({
		model: slug,
		messages: [{ role: 'user', content: message }],
		// A reasoning model spends the budget on its own trace before it writes
		// anything, and a small cap returns finish_reason "length" with empty
		// content — which reads as a broken model when it is not.
		max_tokens: 512
	});
	const started = Date.now();
	const guarded = await guardedUpstreamFetch(baseUrl, allowPrivateUpstreams(), '/chat/completions', {
		method: 'POST',
		headers,
		body,
		timeoutMs: CHAT_TIMEOUT_MS
	});
	const latencyMs = Date.now() - started;
	if (!guarded.ok) {
		return {
			result: {
				ok: false,
				status: null,
				latencyMs,
				tokensIn: null,
				tokensOut: null,
				content: null,
				reasoning: null,
				finishReason: null,
				error: guarded.message
			}
		};
	}
	const res = guarded.response;
	try {
		const text = await res.text();
		let parsed: Record<string, unknown> = {};
		try {
			parsed = JSON.parse(text) as Record<string, unknown>;
		} catch {
			/* non-JSON error body */
		}
		if (!res.ok) {
			const upstream = (parsed.error as Record<string, unknown> | undefined)?.message;
			return {
				result: {
					ok: false,
					status: res.status,
					latencyMs,
					tokensIn: null,
					tokensOut: null,
					content: null,
					reasoning: null,
					finishReason: null,
					error: String(upstream ?? text.slice(0, 300) ?? `HTTP ${res.status}`)
				}
			};
		}
		type Choice = {
			message?: { content?: string | null; reasoning_content?: string | null };
			finish_reason?: string;
		};
		const choice = (parsed.choices as Choice[] | undefined)?.[0];
		const usage = parsed.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
		const content = choice?.message?.content?.trim() ? choice.message.content : null;
		const reasoning = choice?.message?.reasoning_content?.trim()
			? choice.message.reasoning_content
			: null;
		return {
			result: {
				ok: true,
				status: res.status,
				latencyMs,
				tokensIn: usage?.prompt_tokens ?? null,
				tokensOut: usage?.completion_tokens ?? null,
				content,
				reasoning,
				finishReason: choice?.finish_reason ?? null,
				error: null
			}
		};
	} catch (err) {
		return {
			result: {
				ok: false,
				status: null,
				latencyMs: Date.now() - started,
				tokensIn: null,
				tokensOut: null,
				content: null,
				reasoning: null,
				finishReason: null,
				error: err instanceof Error ? err.message : 'request failed'
			}
		};
	}
}
