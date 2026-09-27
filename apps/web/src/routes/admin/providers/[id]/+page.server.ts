import { error, fail } from '@sveltejs/kit';
import { and, asc, desc, eq, or, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { Actions, PageServerLoad } from './$types';
import { requireCap } from '$lib/server/roles';
import { decryptCredentials, type Credentials } from '$lib/server/credentials';
import { allowDevProviders, allowPrivateUpstreams } from '$lib/server/publish';
import { microToUsd, usdToMicro } from '$lib/server/admin';
import { db } from '$lib/server/db';
import { model, provider, requestLog } from '$lib/server/db/schema';
import {
	matchKey,
	parseUpstreamModels,
	seedState,
	type UpstreamModel
} from '$lib/provider-catalog';
import { reachability } from '$lib/publish';
import {
	MAX_BATCH_MODELS,
	MAX_CHAT_CHARS,
	MAX_PRIORITY,
	MIN_PRIORITY,
	cleanSlug,
	cleanText,
	parseIndex,
	parseModelPayloads,
	parsePriority,
	parseSlugList,
	parseTier,
	safeUpstreamUrl
} from '$lib/admin-limits';

/** How long any single upstream call may take. */
const UPSTREAM_TIMEOUT_MS = 15_000;
/**
 * A chat is a different budget from a catalog read: a reasoning model on a cold
 * upstream was measured at 27s for a one-word prompt, so the sandbox would report
 * a false failure on a 15s cap.
 */
const CHAT_TIMEOUT_MS = 60_000;
/** Upper bound on credentials probed in one "test all" run, so the POST returns. */
const MAX_BULK_TEST = 40;

interface Account {
	email?: string;
	api_key?: string;
	access_token?: string;
}

/** The sandbox chat result — one shape for every outcome so the page can render it. */
interface SandboxResult {
	ok: boolean;
	status: number | null;
	latencyMs: number;
	tokensIn: number | null;
	tokensOut: number | null;
	content: string | null;
	/** A reasoning model that ran out of budget answers here instead of `content`. */
	reasoning: string | null;
	finishReason: string | null;
	error: string | null;
}

/**
 * The credential blob is never sent to the page. This pulls out only what is
 * safe to render — a label per credential — and keeps every secret server-side.
 */
function credentialLabels(cred: Credentials): { label: string; index: number }[] {
	const accounts = Array.isArray(cred.accounts) ? (cred.accounts as Account[]) : [];
	if (accounts.length === 0) return [{ label: 'single key', index: 0 }];
	return accounts.map((a, i) => ({ label: String(a.email ?? `key #${i + 1}`), index: i }));
}

/** The token a given credential index authenticates with. Server-side only. */
function tokenAt(cred: Credentials, index: number): string {
	const accounts = Array.isArray(cred.accounts) ? (cred.accounts as Account[]) : [];
	const account = accounts[index];
	return String(account?.access_token || account?.api_key || cred.api_key || '');
}

function headersFor(cred: Credentials, token: string): Record<string, string> {
	const headers: Record<string, string> = {
		...((cred.default_headers as Record<string, string>) ?? {})
	};
	if (token) headers.authorization = `Bearer ${token}`;
	return headers;
}

/** Native-protocol providers cannot be spoken to over the plain [OI] wire. */
function nativeProtocol(cred: Credentials): string | null {
	const protocol = cred.Protocol ?? cred.protocol;
	return protocol && protocol !== 'openai' ? String(protocol) : null;
}

async function getProvider(id: string) {
	const [row] = await db.select().from(provider).where(eq(provider.id, id)).limit(1);
	return row ?? null;
}

/** Fetch and parse the upstream catalog. Returns the raw models plus the URL used. */
async function fetchUpstreamCatalog(
	baseUrl: string,
	cred: Credentials,
	index = 0
): Promise<{
	models: UpstreamModel[];
	status: number;
	url: string;
	rateLimit: Record<string, string>;
}> {
	const base = safeUpstreamUrl(baseUrl, allowPrivateUpstreams());
	if (!base) throw new Error('provider base URL is not a usable http(s) URL');
	const url = `${base}/models`;
	const headers = headersFor(cred, tokenAt(cred, index));
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
	try {
		const res = await fetch(url, { headers, signal: ctrl.signal });
		const rateLimit: Record<string, string> = {};
		for (const [k, v] of res.headers.entries()) {
			if (k.startsWith('x-ratelimit') || k === 'retry-after') rateLimit[k] = v;
		}
		if (!res.ok) return { models: [], status: res.status, url, rateLimit };
		return { models: parseUpstreamModels(await res.json()), status: res.status, url, rateLimit };
	} finally {
		clearTimeout(timer);
	}
}

export const load: PageServerLoad = async ({ locals, params }) => {
	requireCap(locals, 'admin.providers');

	const p = await getProvider(params.id);
	if (!p) error(404, 'Provider not found');

	const allowDev = allowDevProviders();

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
		.orderBy(asc(model.slug));

	// Usage. `request_log` is the only place a call is recorded, so every number
	// here is an observed fact rather than a configuration claim.
	const [totals] = await db
		.select({
			requests: sql<number>`count(*)::int`,
			ok: sql<number>`count(*) filter (where ${requestLog.status} = 'success')::int`,
			tokensIn: sql<number>`coalesce(sum(${requestLog.tokensIn}), 0)::int`,
			tokensOut: sql<number>`coalesce(sum(${requestLog.tokensOut}), 0)::int`,
			cost: sql<string>`coalesce(sum(${requestLog.cost}), 0)::text`,
			avgLatency: sql<number>`coalesce(round(avg(${requestLog.latencyMs})), 0)::int`,
			maxLatency: sql<number>`coalesce(max(${requestLog.latencyMs}), 0)::int`
		})
		.from(requestLog)
		.where(eq(requestLog.providerId, p.id));

	const [day] = await db
		.select({
			requests: sql<number>`count(*)::int`,
			ok: sql<number>`count(*) filter (where ${requestLog.status} = 'success')::int`,
			avgLatency: sql<number>`coalesce(round(avg(${requestLog.latencyMs})), 0)::int`
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
			avgLatency: sql<number>`coalesce(round(avg(${requestLog.latencyMs})), 0)::int`
		})
		.from(requestLog)
		.innerJoin(model, eq(model.id, requestLog.modelId))
		.where(eq(requestLog.providerId, p.id))
		.groupBy(model.slug)
		.orderBy(desc(sql`count(*)`))
		.limit(12);

	const recent = await db
		.select({
			slug: model.slug,
			status: requestLog.status,
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
		.limit(10);

	// Credentials: labels only. Decryption happens here and nothing but the
	// label leaves this function.
	let credentials: {
		kind: string;
		protocol: string | null;
		count: number;
		labels: { label: string; index: number }[];
		headerCount: number;
		error: string | null;
	} = { kind: 'unknown', protocol: null, count: 0, labels: [], headerCount: 0, error: null };
	try {
		const cred = decryptCredentials(p.credentialsEnc);
		credentials = {
			kind: String(cred.auth_kind ?? (cred.accounts ? 'oauth' : 'apikey')),
			protocol: nativeProtocol(cred),
			count: Array.isArray(cred.accounts) ? cred.accounts.length : 1,
			labels: credentialLabels(cred),
			headerCount: Object.keys((cred.default_headers as Record<string, string>) ?? {}).length,
			error: null
		};
	} catch {
		credentials.error = 'credentials could not be decrypted';
	}

	const seeded = new Map(models.map((m) => [m.slug, m.status]));

	return {
		provider: {
			id: p.id,
			name: p.name,
			baseUrl: p.baseUrl,
			status: p.status,
			priority: p.priority,
			createdAt: p.createdAt.toISOString()
		},
		allowDev,
		credentials,
		models: models.map((m) => ({
			...m,
			inputUsd: microToUsd(m.inputPrice),
			outputUsd: microToUsd(m.outputPrice)
		})),
		seededSlugs: [...seeded.keys()],
		stats: {
			totals: { ...totals, cost: microToUsd(totals.cost) },
			day,
			perModel,
			recent: recent.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }))
		},
		published: models.filter((m) => m.status === 'active').length,
		reachable: models.filter((m) => reachability(m.status, p.status, allowDev).served).length
	};
};

export const actions: Actions = {
	/** Live catalog fetch. Nothing is written — the admin chooses what to enable. */
	fetchCatalog: async ({ locals, request, params }) => {
		requireCap(locals, 'admin.providers');
		const form = await request.formData();
		const tier = parseTier(form.get('tier'));

		const p = await getProvider(params.id);
		if (!p) return fail(404, { error: 'Provider not found' });

		let cred: Credentials;
		try {
			cred = decryptCredentials(p.credentialsEnc);
		} catch {
			return fail(400, { error: 'Cannot decrypt credentials for this provider' });
		}

		const started = Date.now();
		try {
			const { models, status, url, rateLimit } = await fetchUpstreamCatalog(p.baseUrl, cred);
			if (status !== 200) {
				return fail(502, {
					error: `Upstream returned HTTP ${status} for ${url}`
				});
			}
			const seeded = new Map(
				(
					await db
						.select({ slug: model.slug, status: model.status })
						.from(model)
						.where(eq(model.providerId, p.id))
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
					rateLimit
				}
			};
		} catch (err) {
			return fail(502, {
				error: `Could not reach ${p.baseUrl}: ${err instanceof Error ? err.message : 'request failed'}`
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
					.select({ id: model.id, providerId: model.providerId, slug: model.slug })
					.from(model)
			).map((m) => [matchKey(m.slug), m])
		);

		const batch = parseModelPayloads(form.getAll('payload').map(String));

		let added = 0;
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
					await db.insert(model).values({
						id: uuidv7(),
						providerId: p.id,
						name: row.name,
						slug,
						context: row.context,
						inputPrice: input,
						outputPrice: output,
						status: 'active'
					});
					added += 1;
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

			await db.update(model).set({ status: 'active' }).where(eq(model.id, existing.id));
			published += 1;
		}

		const parts = [`${added} added`, `${published} published`];
		if (skipped.length)
			parts.push(`${skipped.length} skipped (owned elsewhere): ${skipped.slice(0, 5).join(', ')}`);
		if (batch.rejected) parts.push(`${batch.rejected} rejected as invalid`);
		if (batch.duplicates) parts.push(`${batch.duplicates} duplicate(s) collapsed`);
		if (batch.overCap)
			parts.push(`${batch.overCap} beyond the ${MAX_BATCH_MODELS} per-request limit`);
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
		const updated = await db
			.update(model)
			.set({ status: 'disabled' })
			.where(and(eq(model.providerId, params.id), or(...forms.map((s) => eq(model.slug, s)))))
			.returning({ id: model.id });

		const note = overCap ? ` (${overCap} beyond the ${MAX_BATCH_MODELS} per-request limit)` : '';
		return { message: `Disabled ${updated.length} model(s)${note}.` };
	},

	/** Probe one credential against `<baseUrl>/models`. */
	testCredential: async ({ locals, request, params }) => {
		requireCap(locals, 'admin.providers');
		const form = await request.formData();

		const p = await getProvider(params.id);
		if (!p) return fail(404, { error: 'Provider not found' });

		let cred: Credentials;
		try {
			cred = decryptCredentials(p.credentialsEnc);
		} catch {
			return fail(400, { error: 'Cannot decrypt credentials' });
		}

		const labels = credentialLabels(cred);
		// An index that addresses nothing would probe with an empty token and report
		// a 401 that has nothing to do with the credential.
		const index = parseIndex(form.get('index'), labels.length);
		if (index === null) return fail(400, { error: 'Pick a credential that exists' });

		const label = labels.find((c) => c.index === index)?.label ?? `#${index}`;
		const started = Date.now();
		try {
			const { status, models, rateLimit } = await fetchUpstreamCatalog(p.baseUrl, cred, index);
			return {
				credentialTest: {
					label,
					index,
					ok: status === 200,
					status,
					latencyMs: Date.now() - started,
					modelCount: models.length,
					rateLimit,
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

		let cred: Credentials;
		try {
			cred = decryptCredentials(p.credentialsEnc);
		} catch {
			return fail(400, { error: 'Cannot decrypt credentials' });
		}

		const labels = credentialLabels(cred);
		const capped = labels.slice(0, MAX_BULK_TEST);

		const results = await Promise.all(
			capped.map(async ({ label, index }) => {
				const started = Date.now();
				try {
					const { status, models, rateLimit } = await fetchUpstreamCatalog(p.baseUrl, cred, index);
					return {
						label,
						index,
						ok: status === 200,
						status,
						latencyMs: Date.now() - started,
						modelCount: models.length,
						rateLimit,
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
				labels.length > MAX_BULK_TEST
					? `Tested the first ${MAX_BULK_TEST} of ${labels.length} credentials.`
					: null
		};
	},

	/** One tiny chat against the upstream, to prove a model actually answers. */
	testModel: async ({ locals, request, params }) => {
		requireCap(locals, 'admin.providers');
		const form = await request.formData();
		const slug = cleanSlug(form.get('slug'));
		if (!slug) return fail(400, { error: 'Missing or malformed model slug' });

		const out = await sandboxChat(params.id, slug, 'Say OK');
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

		const out = await sandboxChat(params.id, slug, message);
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

		const updated = await db
			.update(provider)
			.set({ priority })
			.where(eq(provider.id, params.id))
			.returning({ id: provider.id });
		if (updated.length === 0) return fail(404, { error: 'Provider not found' });
		return { message: `Priority set to ${priority}.` };
	}
};

/**
 * A real chat completion against the provider, used by both "test model" and the
 * playground. No system prompt and no tools are sent: this is a sandbox probe of
 * the upstream credential, not a routed product request, so nothing lands in
 * request_log and the model does not have to be published to be tested.
 *
 * Returns `{fatal}` for conditions that are not a chat result at all, so callers
 * can turn them into a form error; `{result}` is always the same shape.
 */
async function sandboxChat(
	providerId: string,
	slug: string,
	message: string
): Promise<{ fatal: string } | { result: SandboxResult }> {
	const p = await getProvider(providerId);
	if (!p) return { fatal: 'provider not found' };

	let cred: Credentials;
	try {
		cred = decryptCredentials(p.credentialsEnc);
	} catch {
		return { fatal: 'credentials could not be decrypted' };
	}

	const protocol = nativeProtocol(cred);
	if (protocol) {
		return {
			fatal: `this provider speaks a native "${protocol}" protocol; the sandbox only sends plain [OI] chat`
		};
	}

	const base = safeUpstreamUrl(p.baseUrl, allowPrivateUpstreams());
	if (!base) return { fatal: 'provider base URL is not a usable http(s) URL' };
	const url = `${base}/chat/completions`;
	const headers = { ...headersFor(cred, tokenAt(cred, 0)), 'content-type': 'application/json' };
	const body = JSON.stringify({
		model: slug,
		messages: [{ role: 'user', content: message }],
		// A reasoning model spends the budget on its own trace before it writes
		// anything, and a small cap returns finish_reason "length" with empty
		// content — which reads as a broken model when it is not.
		max_tokens: 512
	});

	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), CHAT_TIMEOUT_MS);
	const started = Date.now();
	try {
		const res = await fetch(url, { method: 'POST', headers, body, signal: ctrl.signal });
		const latencyMs = Date.now() - started;
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
		const usage = parsed.usage as
			{ prompt_tokens?: number; completion_tokens?: number } | undefined;
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
				// A reasoning model that ran out of budget answers in `reasoning_content`
				// with an empty `content`. Surfacing it beats showing a blank reply.
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
	} finally {
		clearTimeout(timer);
	}
}
