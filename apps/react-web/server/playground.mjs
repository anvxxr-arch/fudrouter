import { AsyncLocalStorage } from 'node:async_hooks';
// Playground stream relay (real data-plane SSE relay).
// Mirrors /api/playground/stream: mint a short-lived run key in the
// chosen key's context, POST stream:true to the data plane, relay SSE
// byte-for-byte, then emit one `event: metrics` frame enriched from
// request_log before reclaiming the run key (always reclaimed, incl. cancel).
export function registerPlayground(app, deps) {
  const {
    needDb,
    authedUser,
    parseCookies,
    currentWorkspaceId,
    requireMemberPermission,
    requireCap,
    HttpError,
    provider,
    environment,
    project,
    eq,
    and,
    newId,
    ID_PREFIXES,
    writeAudit,
    client
  } = deps;
  // Request-scoped client IP so the minted-key audit rows record it.
  const _ipStore = new AsyncLocalStorage();
  const _clientIp = (req) => { const xff = req.headers?.['x-forwarded-for']; if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim(); if (Array.isArray(xff) && xff.length) return String(xff[0]).split(',')[0].trim(); return req.socket?.remoteAddress ?? null; };
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
  	attempts: null
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
  		ttftMs: pick('ttftMs'),
  		latencyMs: pick('latencyMs'),
  		costMicro: pick('costMicro'),
  		fallback: pick('fallback'),
  		attempts: pick('attempts')
  	};
  }
  async function pgFetchRunMetrics(database, requestId) {
  	if (!requestId || !client) return {};
  	for (let i = 0; i < 5; i++) {
  		const rows = await client`select id, provider_id, requested_model, tokens_in, tokens_out, total_tokens, ttft_ms, latency_ms, cost, fallback_used, attempts from request_log where id = ${requestId} limit 1`;
  		if (rows.length) {
  			const row = rows[0];
  			let providerName = null;
  			if (row.provider_id) {
  				const [prov] = await database
  					.select({ slug: provider.slug, name: provider.name })
  					.from(provider)
  					.where(eq(provider.id, row.provider_id))
  					.limit(1);
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
  				ttftMs: pgNum(row.ttft_ms),
  				latencyMs: pgNum(row.latency_ms),
  				costMicro: row.cost !== null && row.cost !== undefined ? String(row.cost) : null,
  				fallback: row.fallback_used ?? null,
  				attempts: pgNum(row.attempts)
  			};
  		}
  		await new Promise((r) => setTimeout(r, 150));
  	}
  	return {};
  }
  async function pgResolveRunContext(database, userId, workspaceId, { keyId, projectId }) {
  	if (keyId) {
  		const rows = await client`select id, name, workspace_id, project_id, environment_id, policy from api_key where id = ${keyId} and user_id = ${userId} and status = 'active' limit 1`;
  		const key = rows[0];
  		// A key from another workspace must never leak into this one's run.
  		if (!key || (key.workspace_id !== null && key.workspace_id !== workspaceId)) return null;
  		return {
  			workspaceId: key.workspace_id ?? workspaceId,
  			projectId: key.project_id ?? projectId ?? null,
  			environmentId: key.environment_id ?? null,
  			policy: { ...(key.policy ?? {}), playground: true },
  			sourceKeyName: key.name
  		};
  	}
  	const [prod] = await database
  		.select({ id: environment.id })
  		.from(environment)
  		.innerJoin(project, eq(project.id, environment.projectId))
  		.where(and(eq(project.workspaceId, workspaceId), eq(environment.slug, 'production')))
  		.limit(1);
  	return {
  		workspaceId,
  		projectId: projectId ?? null,
  		environmentId: prod?.id ?? null,
  		policy: { playground: true },
  		sourceKeyName: 'platform defaults'
  	};
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
  	await client`insert into api_key (id, user_id, name, prefix, key_hash, workspace_id, project_id, environment_id, status, policy, expires_at) values (${id}, ${userId}, ${name}, ${prefix}, ${keyHash}, ${ctx.workspaceId}, ${ctx.projectId}, ${ctx.environmentId}, 'active', ${policyJson}::jsonb, ${expiresAt})`;
  	await database.transaction(async (tx) => {
        await writeAudit(tx, {
          actorUserId: userId,
          action: 'key.create',
          resource: 'api_key',
          resourceId: id,
          workspaceId: ctx.workspaceId,
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
            workspaceId: ctx.workspaceId,
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
  		const cookies = parseCookies(req);
  		const workspaceId = await currentWorkspaceId(database, userRow.id, cookies);
  		if (!workspaceId) throw new HttpError(403, 'No workspace selected');
  		// The run mints a key, so the permission names that side effect.
  		await requireMemberPermission(database, userRow, workspaceId, 'key.create');
  		const raw = req.body ?? {};
  		const parsed = parsePlaygroundBody(raw);
  		if (!parsed.ok) {
  			return res
  				.status(400)
  				.json({ error: { code: 'INVALID_REQUEST', message: parsed.error, requestId: null } });
  		}
  		const ctx = await pgResolveRunContext(database, userRow.id, workspaceId, {
  			keyId: parsed.value.keyId || undefined,
  			projectId: typeof raw.projectId === 'string' && raw.projectId ? raw.projectId : undefined
  		});
  		if (!ctx) {
  			return res.status(403).json({
  				error: {
  					code: 'AUTHORIZATION_ERROR',
  					message: 'Key not found in this workspace.',
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
  				await pgFetchRunMetrics(database, normalized.error?.requestId ?? '')
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
  		req.on('close', () => {
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
  				await pgFetchRunMetrics(database, requestId ?? '')
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
}
