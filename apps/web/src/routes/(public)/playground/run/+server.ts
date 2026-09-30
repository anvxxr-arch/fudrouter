import { json, type RequestHandler } from '@sveltejs/kit';
import { currentWorkspaceId, requireMemberPermission } from '$lib/server/rbac';
import {
	EMPTY_METRICS,
	buildChatBody,
	mergeLogMetrics,
	normalizeRunResult,
	parsePlaygroundForm,
	type NormalizedError,
	type RunMetrics
} from '$lib/playground';
import {
	chatCompletionsRequest,
	fetchRunMetrics,
	mintRunKey,
	resolveRunContext
} from '$lib/server/playground';
/**
 * The public playground's SSE relay (PRD §18/§27), the anonymous-safe mirror of
 * /api/playground/stream. Streaming runs must reach the browser incrementally —
 * a form action's JSON can only arrive after the upstream completes, which would
 * make "streaming" a lie and TTFT unmeasurable.
 *
 * Shape: parse the posted form → mint a run key in the chosen key's context →
 * POST to the data plane with stream: true → relay the SSE byte-for-byte,
 * stamping TTFT at the first `data:` line → after [DONE], emit one
 * `event: metrics` frame (RunMetrics, enriched from request_log via
 * x-fudrouter-request-id) → reclaim.
 *
 * The five mint rules live in $lib/server/playground; what this file owns is
 * rule 5's relay half: the key is reclaimed when the stream ends AND when the
 * client walks away (abort), in a finally. It is never returned to the browser.
 */
const mintDenied = (status: number, code: string, message: string): Response =>
	json({ error: { code, message, requestId: null } satisfies NormalizedError, metrics: null }, { status });
export const POST: RequestHandler = async ({ locals, request }) => {
	// The demo never calls this endpoint; an anonymous call gets a clean 401,
	// never a minted key.
	if (!locals.user) return mintDenied(401, 'AUTHENTICATION_ERROR', 'Sign in to run requests.');
	const raw = (await request.json()) as Record<string, unknown>;
	// Array/number/boolean fields arrive as JSON values here but as form strings
	// in parsePlaygroundForm — normalize to the string shape once.
	const parsed = parsePlaygroundForm((k) => {
		const v = raw[k];
		return v == null ? null : typeof v === 'string' ? v : JSON.stringify(v);
	});
	if (!parsed.ok) return mintDenied(400, 'INVALID_REQUEST', parsed.error);
	const workspaceId = await currentWorkspaceId(locals);
	if (!workspaceId) return mintDenied(403, 'AUTHORIZATION_ERROR', 'No workspace is available to this account yet.');
	// The run mints a key, so the permission names that side effect.
	try {
		await requireMemberPermission(locals, workspaceId, 'key.create');
	} catch {
		return mintDenied(403, 'AUTHORIZATION_ERROR', 'Missing permission: key.create');
	}
	const ctx = await resolveRunContext(locals, workspaceId, { keyId: parsed.value.keyId });
	if (!ctx) return mintDenied(403, 'AUTHORIZATION_ERROR', 'That API key is not in this workspace.');
	const body = buildChatBody(parsed.value, { stream: true });
	const { key, reclaim } = await mintRunKey(locals, ctx);
	try {
		const upstream = await chatCompletionsRequest(key, body, parsed.value.strategy || null);
		if (!upstream.ok || !upstream.body) {
			const text = await upstream.text();
			let payload: { error: NormalizedError; metrics: RunMetrics } = {
				error: { code: 'UPSTREAM_ERROR', message: text.slice(0, 500) || 'Upstream error.', requestId: null },
				metrics: EMPTY_METRICS
			};
			try {
				const normalized = normalizeRunResult({
					status: upstream.status,
					headers: upstream.headers,
					json: JSON.parse(text) as Record<string, unknown>,
					text
				});
				payload = {
					error: normalized.error ?? payload.error,
					metrics: mergeLogMetrics(normalized.metrics, await fetchRunMetrics(normalized.error?.requestId ?? ''))
				};
			} catch {
				// Non-JSON body: the slice above is the message.
			}
			return json(payload, { status: upstream.status });
		}
		const requestId = upstream.headers.get('x-fudrouter-request-id');
		const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
		const writer = writable.getWriter();
		const encoder = new TextEncoder();
		const decoder = new TextDecoder();
		// Reclaim when the stream ends OR when the client walks away: the run key
		// must not outlive its one run in either case (rule 5).
		const pump = (async () => {
			const reader = upstream.body!.getReader();
			let ttftMs: number | null = null;
			const start = Date.now();
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					const chunk = decoder.decode(value, { stream: true });
					if (ttftMs === null && chunk.includes('data: ')) ttftMs = Date.now() - start;
					await writer.write(value);
				}
				const log = await fetchRunMetrics(requestId ?? '');
				const metrics = mergeLogMetrics(
					{ ...EMPTY_METRICS, requestId: requestId ?? null, latencyMs: Date.now() - start, ttftMs },
					log
				);
				await writer.write(encoder.encode(`event: metrics\ndata: ${JSON.stringify(metrics)}\n\n`));
			} catch {
				// Upstream died mid-stream: the relayed bytes already say so.
			} finally {
				await reclaim();
				await writer.close().catch(() => undefined);
			}
		})();
		request.signal.addEventListener('abort', () => {
			upstream.body?.cancel().catch(() => undefined);
			// The pump's finally reclaims; dropping its rejection keeps a client
			// walk-away from surfacing as an unhandled promise rejection.
			pump.catch(() => undefined);
		});
		return new Response(readable, {
			headers: {
				'content-type': 'text/event-stream',
				'cache-control': 'no-cache',
				'x-fudrouter-request-id': requestId ?? ''
			}
		});
	} catch (e) {
		// The dial itself failed (router down): reclaim here — the stream never
		// started, so the pump's finally will never run.
		await reclaim();
		return mintDenied(502, 'UPSTREAM_ERROR', e instanceof Error ? e.message.slice(0, 500) : 'The run failed to reach the router.');
	}
};
