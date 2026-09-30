/**
 * Playground streaming relay (PRD §27).
 *
 * Streams run through HERE instead of the page's form action because SSE must
 * reach the browser incrementally: the action's JSON response can only arrive
 * after the upstream completes, which would make "streaming" a lie and TTFT
 * unmeasurable.
 *
 * Shape: mint a run key in the chosen key's context → POST the body to the data
 * plane's `/v1/chat/completions` with `stream: true` → relay the SSE byte-for-
 * byte, stamping TTFT at the first `data:` line → after `[DONE]`, emit one
 * `event: metrics` frame (JSON `RunMetrics`, enriched from `request_log` via
 * `x-fudrouter-request-id`) → reclaim the run key. On client cancel the relay
 * aborts the upstream and STILL reclaims (rule 5).
 */
import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireCap } from '$lib/server/roles';
import { currentWorkspaceId, requireMemberPermission } from '$lib/server/rbac';
import { buildChatBody, mergeLogMetrics, normalizeRunResult, parsePlaygroundForm, EMPTY_METRICS, type RunMetrics } from '$lib/playground';
import {
	chatCompletionsRequest,
	fetchRunMetrics,
	mintRunKey,
	resolveRunContext
} from '$lib/server/playground';

export const POST: RequestHandler = async ({ locals, request }) => {
	requireCap(locals, 'member');
	const workspaceId = await currentWorkspaceId(locals);
	if (!workspaceId) error(403, 'No workspace selected');
	// The run mints a key, so the permission names that side effect.
	await requireMemberPermission(locals, workspaceId, 'key.create');
	const raw = await request.json();
	// Array/number/boolean fields arrive as JSON values here but as form
	// strings in parsePlaygroundForm — normalize to the string shape once.
	const parsed = parsePlaygroundForm((k) => {
		const v = (raw as Record<string, unknown>)[k];
		return v == null ? null : typeof v === 'string' ? v : JSON.stringify(v);
	});
	if (!parsed.ok) return json({ error: { code: 'INVALID_REQUEST', message: parsed.error, requestId: null } }, { status: 400 });
	const ctx = await resolveRunContext(locals, workspaceId, {
		keyId: parsed.value.keyId,
		projectId: (raw as Record<string, unknown>).projectId as string | undefined
	});
	if (!ctx) return json({ error: { code: 'AUTHORIZATION_ERROR', message: 'Key not found in this workspace.', requestId: null } }, { status: 403 });

	const body = buildChatBody(parsed.value, { stream: true });
	const { key, reclaim } = await mintRunKey(locals, ctx);
	const upstream = await chatCompletionsRequest(key, body, parsed.value.strategy || null);

	if (!upstream.ok || !upstream.body) {
		const text = await upstream.text();
		// A non-JSON error body (a proxy's plain-text 502, an HTML interstitial)
		// must not throw before normalization: the correlation id lives in a
		// header, and losing it here orphans the request_log row.
		let parsedErrorBody: Record<string, unknown> | null = null;
		try {
			parsedErrorBody = JSON.parse(text) as Record<string, unknown>;
		} catch {
			parsedErrorBody = null;
		}
		const normalized = normalizeRunResult({
			status: upstream.status,
			headers: upstream.headers,
			json: parsedErrorBody,
			text
		});
		const metrics = mergeLogMetrics(
			normalized.metrics,
			await fetchRunMetrics(normalized.error?.requestId ?? '')
		);
		await reclaim();
		return json({ error: normalized.error, metrics }, { status: upstream.status });
	}

	const requestId = upstream.headers.get('x-fudrouter-request-id');
	const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
	const writer = writable.getWriter();
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	// Reclaim when the stream ends OR when the client walks away: the run key
	// must not outlive its one run in either case.
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
		void pump;
		upstream.body?.cancel().catch(() => undefined);
	});
	return new Response(readable, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
			'x-fudrouter-request-id': requestId ?? ''
		}
	});
};
