import { AsyncLocalStorage } from 'node:async_hooks';
import { clientIp } from './lib/ip.mjs';
// Playground stream relay (real data-plane SSE relay).
// Mirrors /api/playground/stream: mint a short-lived run key in the
// chosen key's context, POST stream:true to the data plane, relay SSE
// byte-for-byte, then emit one `event: metrics` frame enriched from
// request_log before reclaiming the run key (always reclaimed, incl. cancel).
export function registerPlayground(app, deps) {
  const {
    needDb,
    authedUser,
    requireCap,
    HttpError,
    newId,
    ID_PREFIXES,
    writeAudit,
    client
  } = deps;
  // Request-scoped client IP so the minted-key audit rows record it.
  const _ipStore = new AsyncLocalStorage();
// Shared, proxy-aware client IP (lib/ip.mjs).
  const _clientIp = clientIp;
  // --- playground stream relay (real data-plane SSE relay) ---
  // Mirrors /api/playground/stream: mint a short-lived run key in the
  // chosen key's context, POST stream:true to the data plane, relay SSE
  // byte-for-byte, then emit one `event: metrics` frame enriched from
  // request_log before reclaiming the run key (always reclaimed, incl. cancel).
  const PLAYGROUND_RUN_KEY_TTL_MS = 5 * 60 * 1000;
  const PLAYGROUND_STRATEGIES = new Set([
  	'balanced',
  	'lowest_cost',
  	'lowest_latency',
  	'highest_reliability',
  	'provider_priority',
  	'weighted',
  	'round_robin',
  	'random'
  ]);
  const PLAYGROUND_ROUTER_BASE = () =>
  	(process.env.ROUTER_BASE_URL || 'http://127.0.0.1:8100').replace(/\/$/, '');
  const PG_EMPTY_METRICS = {
  	requestId: null,
  	provider: null,
  	connection: null,
  	actualModel: null,
  	tokensIn: null,
  	tokensOut: null,
  	tokensTotal: null,
  	ttftMs: null,
  	latencyMs: null,
  	costMicro: null,
  	fallback: null,
	attempts: null,
	status: null
};
  function pgField(v) {
  	return v == null ? null : typeof v === 'string' ? v : JSON.stringify(v);
  }
  function pgNum(v) {
  	if (v === null || v === undefined) return null;
  	const n = Number(v);
  	return Number.isFinite(n) ? n : null;
  }
  function pgCodeForStatus(status) {
  	switch (status) {
  		case 400:
  			return 'INVALID_REQUEST';
  		case 401:
  			return 'AUTHENTICATION_ERROR';
  		case 402:
  			return 'INSUFFICIENT_CREDITS';
  		case 403:
  			return 'AUTHORIZATION_ERROR';
  		case 404:
  			return 'MODEL_NOT_FOUND';
  		case 413:
  			return 'CONTEXT_TOO_LONG';
  		case 429:
  			return 'RATE_LIMITED';
  		case 504:
  			return 'PROVIDER_TIMEOUT';
  		default:
  			return status >= 500 ? 'UPSTREAM_ERROR' : 'INTERNAL_ERROR';
  	}
  }
  function parsePlaygroundBody(raw) {
  	const get = (k) => pgField(raw[k]);
  	const model = String(get('model') ?? '').trim();
  	if (!model) return { ok: false, error: 'Pick a model or alias before running.' };
  	let messages;
  	try {
  		const parsed = JSON.parse(String(get('messages') ?? '').trim() || '[]');
  		if (!Array.isArray(parsed)) throw new Error('not an array');
  		messages = parsed.map((m) => {
  			const role = String(m?.role ?? '');
  			const content = String(m?.content ?? '');
  			if (!['system', 'user', 'assistant', 'tool'].includes(role)) throw new Error('bad role');
  			return { role, content };
  		});
  	} catch {
  		return { ok: false, error: 'Messages must be a JSON array of {role, content}.' };
  	}
  	if (messages.length === 0) return { ok: false, error: 'Add at least one message.' };
  	let tools = null;
  	const toolsRaw = String(get('tools') ?? '').trim();
  	if (toolsRaw) {
  		try {
  			const parsed = JSON.parse(toolsRaw);
  			if (!Array.isArray(parsed)) throw new Error('not an array');
  			tools = parsed;
  		} catch {
  			return { ok: false, error: 'Tools must be a JSON array of tool definitions.' };
  		}
  	}
  	let temperature = null;
  	const tempRaw = String(get('temperature') ?? '').trim();
  	if (tempRaw !== '') {
  		temperature = Number(tempRaw);
  		if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
  			return { ok: false, error: 'Temperature must be between 0 and 2.' };
  		}
  	}
  	let maxTokens = null;
  	const maxRaw = String(get('maxTokens') ?? '').trim();
  	if (maxRaw !== '') {
  		maxTokens = Number(maxRaw);
  		if (!Number.isInteger(maxTokens) || maxTokens < 1) {
  			return { ok: false, error: 'Max tokens must be a positive integer.' };
  		}
  	}
  	const strategy = String(get('strategy') ?? '');
  	if (strategy && !PLAYGROUND_STRATEGIES.has(strategy)) {
  		return { ok: false, error: 'Unknown routing strategy.' };
  	}
  	return {
  		ok: true,
  		value: {
  			model,
  			strategy,
  			messages,
  			system: String(get('system') ?? ''),
  			temperature,
  			maxTokens,
  			tools,
  			jsonMode: get('jsonMode') === 'on' || get('jsonMode') === 'true',
  			keyId: String(get('keyId') ?? '').trim()
  		}
  	};
  }
  function pgBuildChatBody(form) {
  	const messages = [];
  	if (form.system.trim()) messages.push({ role: 'system', content: form.system });
  	messages.push(...form.messages);
  	const body = { model: form.model, messages, stream: true };
  	if (form.temperature !== null) body.temperature = form.temperature;
  	if (form.maxTokens !== null) body.max_tokens = form.maxTokens;
  	if (form.tools && form.tools.length > 0) body.tools = form.tools;
  	if (form.jsonMode) body.response_format = { type: 'json_object' };
  	return body;
  }
  function pgNormalize({ status, headers, json, text }) {
  	const usage = json?.usage ?? null;
  	const model = typeof json?.model === 'string' ? json.model : null;
  	const requestId = headers.get('x-fudrouter-request-id');
  	const latencyHeader = headers.get('x-fudrouter-latency');
  	const tokensIn = usage && typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : null;
  	const tokensOut =
  		usage && typeof usage.completion_tokens === 'number' ? usage.completion_tokens : null;
  	const tokensTotal =
  		usage && typeof usage.total_tokens === 'number'
  			? usage.total_tokens
  			: tokensIn !== null && tokensOut !== null
  				? tokensIn + tokensOut
  				: null;
  	const metrics = {
  		...PG_EMPTY_METRICS,
  		requestId: requestId ?? null,
  		provider: headers.get('x-fudrouter-provider'),
  		actualModel: headers.get('x-fudrouter-model') ?? model,
  		tokensIn,
  		tokensOut,
  		tokensTotal,
  		latencyMs: latencyHeader !== null ? Number(latencyHeader) : null
  	};
  	if (status >= 200 && status < 300) return { metrics, error: null };
  	const err = json?.error ?? null;
  	const code = typeof err?.code === 'string' ? err.code : pgCodeForStatus(status);
  	const message =
  		typeof err?.message === 'string' ? err.message : String(text).slice(0, 500) || 'Request failed.';
  	return { metrics, error: { code, message, requestId: requestId ?? null } };
  }
  function pgMergeMetrics(metrics, log) {
  	const pick = (key) => (log[key] ?? null) !== null ? log[key] : metrics[key];
  	return {
  		requestId: pick('requestId'),
  		provider: pick('provider'),
  		connection: pick('connection'),
  		actualModel: pick('actualModel'),
  		tokensIn: pick('tokensIn'),
  		tokensOut: pick('tokensOut'),
  		tokensTotal: pick('tokensTotal'),
		tokensSaved: pick('tokensSaved'),
  		ttftMs: pick('ttftMs'),
  		latencyMs: pick('latencyMs'),
  		costMicro: pick('costMicro'),
  		fallback: pick('fallback'),
		attempts: pick('attempts'),
		status: pick('status')
	};
  }
  async function pgFetchRunMetrics(requestId) {
  	if (!requestId || !client) return {};
  	for (let i = 0; i < 5; i++) {
  		const rows = await client`select id, provider_id, requested_model, tokens_in, tokens_out, total_tokens, tokens_saved, ttft_ms, latency_ms, cost, status, fallback_used, attempts from request_log where id = ${requestId} limit 1`;
  		if (rows.length) {
  			const row = rows[0];
  			let providerName = null;
  			if (row.provider_id) {
  				const [prov] = await client`select slug, name from provider where id = ${row.provider_id} limit 1`;
  				if (prov) providerName = prov.slug ?? prov.name;
  			}
  			return {
  				requestId: row.id,
  				provider: providerName,
  				connection: null,
  				actualModel: row.requested_model ?? null,
  				tokensIn: pgNum(row.tokens_in),
  				tokensOut: pgNum(row.tokens_out),
  				tokensTotal: pgNum(row.total_tokens),
				// The token-saver's saving (migration 0020). An ESTIMATE, kept
				// separate from tokensIn/Out, which are the provider's report.
				tokensSaved: pgNum(row.tokens_saved),
  				ttftMs: pgNum(row.ttft_ms),
  				latencyMs: pgNum(row.latency_ms),
  				costMicro: row.cost !== null && row.cost !== undefined ? String(row.cost) : null,
				fallback: row.fallback_used ?? null,
				attempts: pgNum(row.attempts),
				status: row.status ?? null
			};
  		}
  		await new Promise((r) => setTimeout(r, 150));
  	}
  	return {};
  }
  async function pgResolveRunContext(userId, { keyId }) {
  	if (keyId) {
  		const rows = await client`select id, name, policy from api_key where id = ${keyId} and user_id = ${userId} and status = 'active' limit 1`;
  		const key = rows[0];
  		// A key from another user must never leak into this one's run.
  		if (!key) return null;
  		return {
  			policy: { ...(key.policy ?? {}), playground: true },
  			sourceKeyName: key.name
  		};
  	}
  	return { policy: { playground: true }, sourceKeyName: 'platform defaults' };
  }
  async function pgMintRunKey(database, userId, ctx) {
  	const { randomBytes, createHash } = await import('node:crypto');
  	let prefix;
  	do {
  		prefix = randomBytes(6).toString('base64url');
  	} while (prefix.includes('_'));
  	const secret = randomBytes(32).toString('base64url');
  	const keyHash = createHash('sha256').update(secret).digest('hex');
  	const id = newId(ID_PREFIXES.apiKey);
  	const name = `[playground] ${new Date().toISOString().slice(0, 19)}Z`;
  	const expiresAt = new Date(Date.now() + PLAYGROUND_RUN_KEY_TTL_MS);
  	const policyJson = JSON.stringify(ctx.policy);
  await client`insert into api_key (id, user_id, name, prefix, key_hash, status, policy, expires_at) values (${id}, ${userId}, ${name}, ${prefix}, ${keyHash}, 'active', ${policyJson}::jsonb, ${expiresAt.toISOString()})`;
  	await database.transaction(async (tx) => {
        await writeAudit(tx, {
          actorUserId: userId,
          action: 'key.create',
          resource: 'api_key',
          resourceId: id,
          ip: _ipStore.getStore() ?? null,
          after: { name, policy: ctx.policy, playground: true }
        });
  	});
  	let done = false;
  	const reclaim = async () => {
  		// Idempotent: disable-then-delete runs exactly once (rule 5).
  		if (done) return;
  		done = true;
  		await client`update api_key set status = 'disabled' where id = ${id}`;
  		await database.transaction(async (tx) => {
          await writeAudit(tx, {
            actorUserId: userId,
            action: 'key.revoke',
            resource: 'api_key',
            resourceId: id,
            ip: _ipStore.getStore() ?? null,
            metadata: { playground: true, reason: 'run key reclaimed' }
          });
  		});
  		await client`delete from api_key where id = ${id}`;
  	};
  	return { key: `sk-ar-${prefix}_${secret}`, reclaim };
  }
  app.post('/api/playground/stream', async (req, res) => {
  	await _ipStore.run(_clientIp(req), async () => {
  	let reclaim = null;
  	try {
  		const database = needDb(res);
  		if (!database) return;
  		const userRow = await authedUser(req);
  		requireCap(userRow, 'member');
  		const raw = req.body ?? {};
  		const parsed = parsePlaygroundBody(raw);
  		if (!parsed.ok) {
  			return res
  				.status(400)
  				.json({ error: { code: 'INVALID_REQUEST', message: parsed.error, requestId: null } });
  		}
  		const ctx = await pgResolveRunContext(userRow.id, {
  			keyId: parsed.value.keyId || undefined
  		});
  		if (!ctx) {
  			return res.status(403).json({
  				error: {
  					code: 'AUTHORIZATION_ERROR',
  					message: 'Key not found in this account.',
  					requestId: null
  				}
  			});
  		}
  		const body = pgBuildChatBody(parsed.value);
  		const minted = await pgMintRunKey(database, userRow.id, ctx);
  		reclaim = minted.reclaim;
  		const upstreamHeaders = {
  			'content-type': 'application/json',
  			authorization: `Bearer ${minted.key}`
  		};
  		if (parsed.value.strategy) upstreamHeaders['x-fudrouter-strategy'] = parsed.value.strategy;
  		let upstream;
  		try {
  			upstream = await fetch(`${PLAYGROUND_ROUTER_BASE()}/v1/chat/completions`, {
  				method: 'POST',
  				headers: upstreamHeaders,
  				body: JSON.stringify(body)
  			});
  		} catch (e) {
  			await reclaim();
  			reclaim = null;
  			return res.status(502).json({
  				error: {
  					code: 'UPSTREAM_ERROR',
  					message: e instanceof Error ? e.message.slice(0, 500) : 'The run failed to reach the router.',
  					requestId: null
  				}
  			});
  		}
  		if (!upstream.ok || !upstream.body) {
  			const text = await upstream.text();
  			let payload = null;
  			try {
  				payload = JSON.parse(text);
  			} catch {
  				payload = null;
  			}
  			const normalized = pgNormalize({ status: upstream.status, headers: upstream.headers, json: payload, text });
  			const metrics = pgMergeMetrics(
  				normalized.metrics,
  				await pgFetchRunMetrics(normalized.error?.requestId ?? '')
  			);
  			await reclaim();
  			reclaim = null;
  			return res.status(upstream.status).json({ error: normalized.error, metrics });
  		}
  		const requestId = upstream.headers.get('x-fudrouter-request-id');
  		res.writeHead(200, {
  			'content-type': 'text/event-stream',
  			'cache-control': 'no-cache',
  			'x-fudrouter-request-id': requestId ?? ''
  		});
  		const start = Date.now();
  		let ttftMs = null;
  		let finished = false;
  		const decoder = new TextDecoder();
  		// `req` 'close' fires when the request BODY is complete (Node ≥16),
  		// which express.json has already consumed before this handler runs —
  		// so it can never signal a client disconnect. The response 'close'
  		// is the disconnect signal.
  		res.on('close', () => {
  			if (!finished) upstream.body?.cancel().catch(() => undefined);
  		});
  		try {
  			const reader = upstream.body.getReader();
  			for (;;) {
  				const { done, value } = await reader.read();
  				if (done) break;
  				const chunk = decoder.decode(value, { stream: true });
  				if (ttftMs === null && chunk.includes('data: ')) ttftMs = Date.now() - start;
  				res.write(Buffer.from(value));
  			}
  			const metrics = pgMergeMetrics(
  				{ ...PG_EMPTY_METRICS, requestId: requestId ?? null, latencyMs: Date.now() - start, ttftMs },
  				await pgFetchRunMetrics(requestId ?? '')
  			);
  			res.write(`event: metrics\ndata: ${JSON.stringify(metrics)}\n\n`);
  		} catch {
  			// Upstream died mid-stream: the relayed bytes already say so.
  		} finally {
  			finished = true;
  			await reclaim();
  			if (!res.writableEnded) res.end();
  		}
  	} catch (err) {
  		if (reclaim) {
  			try {
  				await reclaim();
  			} catch {
  				// Reclaim must never mask the original failure.
  			}
  		}
  		if (err instanceof HttpError) {
  			if (!res.headersSent) return res.status(err.status).json({ error: err.message });
  			return res.end();
  		}
  		throw err;
  	}
  	});
  });
  // --- playground comparison relay (N models, one prompt) ---
  // Same mint/relay/reclaim contract as /api/playground/stream, fanned out:
  // one run key per model, upstreams run concurrently, and every SSE line is
  // wrapped as {"model":…,"chunk":…} so the client can attribute bytes to a
  // column. One `event: metrics` frame per model, emitted as soon as that
  // model's upstream ends (success or error) — never held for the slowest.
  // Keys are reclaimed per model in a finally, so a mid-run client disconnect
  // still reclaims every minted key.
  app.post('/api/playground/compare', async (req, res) => {
  	await _ipStore.run(_clientIp(req), async () => {
  	const reclaims = [];
  	try {
  		const database = needDb(res);
  		if (!database) return;
  		const userRow = await authedUser(req);
  		requireCap(userRow, 'member');
  		const raw = req.body ?? {};
  		const models = Array.isArray(raw.models) ? raw.models.map(String).map((m) => m.trim()).filter(Boolean) : [];
  		const unique = [...new Set(models)];
  		if (unique.length < 2 || unique.length > 3) {
  			return res.status(400).json({
  				error: { code: 'INVALID_REQUEST', message: 'Pick 2–3 distinct models to compare.', requestId: null }
  			});
  		}
  		const base = parsePlaygroundBody({ ...raw, model: unique[0] });
  		if (!base.ok) {
  			return res
  				.status(400)
  				.json({ error: { code: 'INVALID_REQUEST', message: base.error, requestId: null } });
  		}
  		const ctx = await pgResolveRunContext(userRow.id, {
  			keyId: base.value.keyId || undefined
  		});
  		if (!ctx) {
  			return res.status(403).json({
  				error: {
  					code: 'AUTHORIZATION_ERROR',
  					message: 'Key not found in this account.',
  					requestId: null
  				}
  			});
  		}
  		// One mint per model: each upstream call is its own metered request
  		// with its own ledger row, so the comparison table reads real numbers.
  		// Each run carries its own AbortController: the client disconnect
  		// handler must be able to kill an upstream call that is still inside
  		// fetch(), not only one already streaming (body.cancel covers that).
  		const runs = [];
  		for (const model of unique) {
  			const form = { ...base.value, model };
  			const minted = await pgMintRunKey(database, userRow.id, ctx);
  			reclaims.push(minted.reclaim);
  			const headers = {
  				'content-type': 'application/json',
  				authorization: `Bearer ${minted.key}`
  			};
  			if (form.strategy) headers['x-fudrouter-strategy'] = form.strategy;
  			runs.push({ model, body: pgBuildChatBody(form), headers, reclaim: minted.reclaim, controller: new AbortController() });
  		}
  		res.writeHead(200, {
  			'content-type': 'text/event-stream',
  			'cache-control': 'no-cache'
  		});
  		const send = (event, payload) => {
  			// A disconnected client gets no frames: an aborted run must not
  			// emit a metrics frame for a reader that is already gone.
  			if (clientGone || res.writableEnded) return;
  			res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  		};
  		let open = runs.length;
  		// Same disconnect signal as the single-model relay: `req` 'close'
  		// only marks the body as complete, `res` 'close' is the client going
  		// away. body.cancel stops an already-streaming upstream; abort()
  		// stops one still inside fetch().
  		let clientGone = false;
  		res.on('close', () => {
  			clientGone = true;
  			for (const run of runs) {
  				run.controller.abort();
  				run.upstream?.body?.cancel().catch(() => undefined);
  			}
  			// The reclaim must not depend on settle() reaching its finally: a
  			// close that lands while a run is still inside fetch(), or before
  			// getReader(), can leave reader.read() waiting on an upstream that
  			// never ends — and the key then outlives its 5-minute TTL. Reclaim
  			// here as well; reclaim is idempotent (the `done` flag in
  			// pgMintRunKey), so settle()'s finally is a no-op when this has
  			// already run.
  			for (const run of runs) void run.reclaim().catch(() => undefined);
  		});
  		const settle = async (run) => {
  			try {
  				let upstream;
  				try {
  					upstream = await fetch(`${PLAYGROUND_ROUTER_BASE()}/v1/chat/completions`, {
  						method: 'POST',
  						headers: run.headers,
  						body: JSON.stringify(run.body),
  						signal: run.controller.signal
  					});
  				} catch (e) {
  					// The client disconnected while this call was still in
  					// flight: that is the normal disconnect path, not an
  					// upstream failure. The finally below still reclaims.
  					if (run.controller.signal.aborted) return;
  					send('metrics', {
  						model: run.model,
  						...PG_EMPTY_METRICS,
  						error: {
  							code: 'UPSTREAM_ERROR',
  							message: e instanceof Error ? e.message.slice(0, 500) : 'The run failed to reach the router.'
  						}
  					});
  					return;
  				}
				run.upstream = upstream;
  				// The disconnect handler reads run.upstream, which is only
				// assigned here — after fetch() resolves. A close that lands in
				// that window finds it undefined, so body.cancel() is a silent
				// no-op and the abort alone must error a reader that may not
				// exist yet. Cancel explicitly and return so the finally
				// reclaims the key.
				if (run.controller.signal.aborted) {
					run.upstream.body?.cancel().catch(() => undefined);
					return;
				}
				if (!upstream.ok || !upstream.body) {
					if (run.controller.signal.aborted) {
						upstream.body?.cancel().catch(() => undefined);
						return;
					}
  					const text = await upstream.text();
  					let payload = null;
  					try {
  						payload = JSON.parse(text);
  					} catch {
  						payload = null;
  					}
  					const normalized = pgNormalize({ status: upstream.status, headers: upstream.headers, json: payload, text });
  					const metrics = pgMergeMetrics(
  						normalized.metrics,
  						await pgFetchRunMetrics(normalized.error?.requestId ?? '')
  					);
  					send('metrics', { model: run.model, ...metrics, error: normalized.error });
  					return;
  				}
  				const requestId = upstream.headers.get('x-fudrouter-request-id');
  				const start = Date.now();
  				let ttftMs = null;
  				const decoder = new TextDecoder();
  				// Carried across reads: a TCP read can end mid-line, so a
  				// half line must wait here for its tail instead of being
  				// wrapped as its own chunk frame — the client JSON-parses
  				// every frame body, so a split line would be lost, not
  				// merely mis-framed.
				let pending = '';
  				try {
  					// The close handler's body.cancel() only helps once run.upstream
					// is set AND the stream is still unlocked; a close that lands
					// between the guard above and getReader() leaves cancel() to
					// race the reader being created. Re-check here so the reader is
					// never created for a client that is already gone.
					if (run.controller.signal.aborted) {
						upstream.body?.cancel().catch(() => undefined);
						return;
					}
					const reader = upstream.body.getReader();
  					for (;;) {
  						const { done, value } = await reader.read();
  						if (done) break;
  						const chunk = decoder.decode(value, { stream: true });
  						if (ttftMs === null && chunk.includes('data: ')) ttftMs = Date.now() - start;
  						pending += chunk;
  						const lines = pending.split('\n');
  						pending = lines.pop() ?? '';
  						for (const line of lines) {
  							if (line === '') continue;
  							send('chunk', { model: run.model, chunk: line });
  						}
  					}
  					// A stream that ends without a trailing newline still owes
  					// its last line: dropping it would silently truncate the
  					// model's answer.
  					if (pending !== '') send('chunk', { model: run.model, chunk: pending });
  					// The client is gone: no frame would be read, and the ledger
  					// poll below would only delay the reclaim this path exists for.
  					if (run.controller.signal.aborted) return;
  					const metrics = pgMergeMetrics(
  						{ ...PG_EMPTY_METRICS, requestId: requestId ?? null, latencyMs: Date.now() - start, ttftMs },
  						await pgFetchRunMetrics(requestId ?? '')
  					);
  					send('metrics', { model: run.model, ...metrics });
  				} catch {
  					if (run.controller.signal.aborted) return;
  					// Upstream died mid-stream: emit what the ledger has.
  					// A half-line buffered before the throw is still owed to the
  					// client, or the answer is silently truncated on the error path.
  					if (pending !== '') send('chunk', { model: run.model, chunk: pending });
  					const metrics = pgMergeMetrics(
  						{ ...PG_EMPTY_METRICS, requestId: requestId ?? null, latencyMs: Date.now() - start, ttftMs },
  						await pgFetchRunMetrics(requestId ?? '')
  					);
  					send('metrics', { model: run.model, ...metrics });
  				}
  			} finally {
  				open -= 1;
  				await run.reclaim();
  				if (open === 0 && !res.writableEnded) res.end();
  			}
  		};
  		await Promise.all(runs.map((run) => settle(run)));
  	} catch (err) {
  		for (const reclaim of reclaims) {
  			try {
  				await reclaim();
  			} catch {
  				// Reclaim must never mask the original failure.
  			}
  		}
  		if (err instanceof HttpError) {
  			if (!res.headersSent) return res.status(err.status).json({ error: err.message });
  			return res.end();
  		}
  		throw err;
  	}
  	});
  });
}
