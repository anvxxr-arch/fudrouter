import { createHash, randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'drizzle-orm';
import { rowsOf, big, num, iso, okBody } from './lib/validate.mjs';
import { clientIp } from './lib/ip.mjs';

// DB-backed dashboard page loads + POST actions for the member dashboard
// routes. All routes require auth (anon 401).
// Raw SQL is used throughout so real columns work regardless of the minimal
// drizzle table copies in index.mjs.
function fail(res, status, error) {
	return res.status(status).json({ error });
}
// sk-ar-<prefix>_<secret>, sha256(secret) stored. Byte-compatible with
// packages/platform/server/keys.ts + the Go data plane parser.
function generateApiKey() {
	let prefix;
	do {
		prefix = randomBytes(6).toString('base64url');
	} while (prefix.includes('_'));
	const secret = randomBytes(32).toString('base64url');
	const keyHash = createHash('sha256').update(secret).digest('hex');
	return { key: `sk-ar-${prefix}_${secret}`, prefix, keyHash };
}
function parseAmountToMicro(input) {
	const m = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(String(input ?? '').trim());
	if (!m) return null;
	const micro = BigInt(m[2]) * 1_000_000n + BigInt((m[3] ?? '').padEnd(6, '0'));
	return m[1] === '-' ? -micro : micro;
}
function slugifyName(input) {
	const s = String(input ?? '')
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return s || 'project';
}
function microsToInput(value) {
	const n = typeof value === 'bigint' ? value : BigInt(String(value));
	const whole = n / 1000000n;
	const frac = (n % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
	return frac ? `${whole}.${frac}` : whole.toString();
}
function parseStrictMicros(input) {
	const s = String(input ?? '').trim();
	if (!/^\d+(\.\d{1,6})?$/.test(s)) return null;
	const [whole, frac = ''] = s.split('.');
	return BigInt(whole) * 1000000n + BigInt(frac.padEnd(6, '0'));
}
function csvList(raw) {
	return String(raw ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
}
// Mirror keys policyFromForm: every field optional, empty omitted.
function policyFromForm(b) {
	const policy = {};
	for (const k of ['endpoints', 'models', 'aliases', 'ip_allowlist']) {
		const v = Array.isArray(b[k]) ? b[k].map((s) => String(s).trim()).filter(Boolean) : csvList(b[k]);
		if (v.length) policy[k] = v;
	}
	for (const field of ['rpm', 'tpm', 'concurrency']) {
		const raw = String(b[field] ?? '').trim();
		if (!raw) continue;
		if (!/^\d+$/.test(raw)) return { ok: false, error: `${field} must be a whole number` };
		const value = Number(raw);
		if (!Number.isSafeInteger(value)) return { ok: false, error: `${field} is too large` };
		policy[field] = value;
	}
	for (const [field, key, label] of [['daily_spend_micro', 'dailySpend', 'Daily spend'], ['monthly_spend_micro', 'monthlySpend', 'Monthly spend']]) {
		const raw = String(b[key] ?? '').trim();
		if (!raw) continue;
		const micros = parseStrictMicros(raw);
		if (micros === null) return { ok: false, error: `${label} must be a plain amount like 12.50` };
		if (micros > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, error: `${label} is too large` };
		policy[field] = Number(micros);
	}
	return { ok: true, policy };
}
const LIMIT_METRICS = ['rpm', 'tpm', 'rpd', 'tpd', 'concurrency', 'dailySpendMicro', 'monthlySpendMicro'];
const LIMIT_LABELS = { rpm: 'Requests per minute', tpm: 'Tokens per minute', rpd: 'Requests per day', tpd: 'Tokens per day', concurrency: 'Concurrent requests', dailySpendMicro: 'Daily spend', monthlySpendMicro: 'Monthly spend' };
const LIMIT_LEVEL_LABELS = { platform: 'Platform default', workspace: 'Workspace', project: 'Project', environment: 'Environment', api_key: 'API key' };
const REQUEST_STATUSES = ['success', 'client_error', 'provider_error', 'timeout', 'rate_limited', 'cancelled', 'internal_error'];
function normalizeStatus(stored) {
	switch (String(stored ?? '')) {
		case 'success': return 'success';
		case 'client_error': return 'client_error';
		case 'provider_error':
		case 'upstream_error': return 'provider_error';
		case 'timeout': return 'timeout';
		case 'rate_limited': return 'rate_limited';
		case 'cancelled': return 'cancelled';
		case 'internal_error':
		case 'error': return 'internal_error';
		default: return 'internal_error';
	}
}
function statusTone(s) {
	switch (s) {
		case 'success': return 'success';
		case 'timeout':
		case 'rate_limited': return 'warning';
		case 'cancelled': return 'neutral';
		default: return 'danger';
	}
}
function statusFilterValues(s) {
	if (s === 'provider_error') return ['provider_error', 'upstream_error'];
	if (s === 'internal_error') return ['internal_error', 'error'];
	return [s];
}
// Mirror routing parsePolicyForm for JSON bodies.
const ROUTING_STRATEGIES = ['balanced', 'lowest_cost', 'lowest_latency', 'highest_reliability', 'provider_priority', 'weighted', 'round_robin', 'random'];
function slugListForm(raw) {
	const parts = Array.isArray(raw) ? raw.flatMap((s) => String(s).split(/[\n,]/)) : String(raw ?? '').split(/[\n,]/);
	const out = [];
	for (const part of parts) {
		const s = String(part).trim();
		if (s && !out.includes(s)) out.push(s);
	}
	return out;
}
function intFieldForm(raw, label, min, max, fallback) {
	const s = String(raw ?? '').trim();
	if (!s) return { ok: true, value: fallback };
	if (!/^\d+$/.test(s)) return { ok: false, error: `${label} must be a whole number` };
	const n = Number(s);
	if (n < min || n > max) return { ok: false, error: `${label} must be between ${min} and ${max}` };
	return { ok: true, value: n };
}
function boolFieldForm(v, dflt) {
	if (v === undefined || v === null || v === '') return dflt;
	if (v === true || v === 'true' || v === '1' || v === 'on') return true;
	if (v === false || v === 'false' || v === '0') return false;
	return Boolean(v);
}
function microFieldForm(v, label) {
	const s = String(v ?? '').trim();
	if (!s) return { ok: true, value: null };
	const m = parseStrictMicros(s);
	if (m === null) return { ok: false, error: `${label} must be a decimal amount (at most 6 decimal places)` };
	if (m > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, error: `${label} is too large` };
	return { ok: true, value: Number(m) };
}
function parsePolicyFormBody(b) {
	const name = String(b.name ?? '').trim();
	if (!name) return { ok: false, error: 'Name is required' };
	if (name.length > 200) return { ok: false, error: 'Name must be 200 characters or fewer' };
	const strategy = String(b.strategy ?? '').trim();
	if (strategy === 'smart') return { ok: false, error: 'Smart routing — learns from outcomes; coming soon' };
	if (!ROUTING_STRATEGIES.includes(strategy)) return { ok: false, error: 'Unknown routing strategy' };
	const ma = intFieldForm(b.max_attempts ?? b.maxAttempts, 'Max attempts', 1, 8, 2);
	if (!ma.ok) return ma;
	const to = intFieldForm(b.request_timeout_ms ?? b.requestTimeoutMs, 'Request timeout', 1000, 600000, 30000);
	if (!to.ok) return to;
	const constraints = {};
	const ci = microFieldForm(b.max_input_price_micro ?? b.maxInputPriceMicro, 'Max input price');
	if (!ci.ok) return ci;
	if (ci.value !== null) constraints.max_input_price_micro = ci.value;
	const co = microFieldForm(b.max_output_price_micro ?? b.maxOutputPriceMicro, 'Max output price');
	if (!co.ok) return co;
	if (co.value !== null) constraints.max_output_price_micro = co.value;
	const latRaw = String(b.max_p95_latency_ms ?? b.maxP95LatencyMs ?? '').trim();
	if (latRaw) {
		if (!/^\d+$/.test(latRaw)) return { ok: false, error: 'Max p95 latency must be a whole number of milliseconds' };
		constraints.max_p95_latency_ms = Number(latRaw);
	}
	const availRaw = String(b.min_availability ?? b.minAvailability ?? '').trim();
	if (availRaw) {
		if (!/^\d*\.?\d*$/.test(availRaw) || availRaw === '.') return { ok: false, error: 'Min availability must be a fraction between 0 and 1' };
		const n = Number(availRaw);
		if (!(n >= 0 && n <= 1)) return { ok: false, error: 'Min availability must be a fraction between 0 and 1' };
		constraints.min_availability = n;
	}
	const allowed = slugListForm(b.allowed_providers ?? b.allowedProviders);
	if (allowed.length) constraints.allowed_providers = allowed;
	const blocked = slugListForm(b.blocked_providers ?? b.blockedProviders);
	if (blocked.length) constraints.blocked_providers = blocked;
	const region = String(b.region_preference ?? b.regionPreference ?? '').trim();
	if (region) constraints.region_preference = region;
	const weights = {};
	for (const key of ['price', 'latency', 'reliability', 'capacity']) {
		const cap = key[0].toUpperCase() + key.slice(1);
		const wraw = b[`weight_${key}`] ?? b[`weight${cap}`] ?? (b.weights && b.weights[key]);
		const s = String(wraw ?? '').trim();
		if (!s) continue;
		if (!/^\d+$/.test(s)) return { ok: false, error: `Weight ${key} must be a whole number 0-100` };
		const n = Number(s);
		if (n < 0 || n > 100) return { ok: false, error: `Weight ${key} must be between 0 and 100` };
		weights[key] = n;
	}
	return { ok: true, values: { name, strategy, enabled: boolFieldForm(b.enabled, true), maxAttempts: ma.value, requestTimeoutMs: to.value, fallbackEnabled: boolFieldForm(b.fallback_enabled ?? b.fallbackEnabled, true), providerPreferences: { order: slugListForm(b.provider_order ?? b.providerOrder) }, modelPreferences: { order: slugListForm(b.model_order ?? b.modelOrder) }, constraints, weights } };
}

const EXTRA_PREFIXES = { creditLedger: 'txn_', invoice: 'inv_', rateLimit: 'lim_', routingPolicy: 'rte_' };
function prefixFor(ctx, key) {
  if (ctx.ID_PREFIXES && ctx.ID_PREFIXES[key]) return ctx.ID_PREFIXES[key];
  return EXTRA_PREFIXES[key];
}
export function registerPages(app, ctx) {
	const {
		needDb,
		authedUser,
		requireCap,
		requireMemberPermission,
		currentWorkspaceId,
		parseCookies,
		newId,
		writeAudit,
		ID_PREFIXES,
		HttpError
	} = ctx;
	// Request-scoped client IP so every writeAudit row records it without
	// threading req through every handler. Set by wrap() below.
	const _ipStore = new AsyncLocalStorage();
// Shared, proxy-aware client IP (lib/ip.mjs) — the old local copy trusted a
	// spoofable X-Forwarded-For, poisoning every audit row's ip.
	const _clientIp = clientIp;

	async function mustAuth(req) {
		const userRow = await authedUser(req);
		requireCap(userRow, 'member');
		return userRow;
	}
	async function mustWorkspace(database, userRow, req, perm) {
		const cookies = parseCookies(req);
		const workspaceId = await currentWorkspaceId(database, userRow.id, cookies);
		if (!workspaceId) {
			const e = new HttpError(404, 'No workspace');
			e.status = 404;
			throw e;
		}
		const { workspace } = await requireMemberPermission(database, userRow, workspaceId, perm);
		return { workspaceId, workspace };
	}
	async function scopedProject(database, projectId, workspaceId) {
		const r = rowsOf(
			await database.execute(
				sql`select id, name, slug, description, status, created_at, updated_at from project where id = ${projectId} and workspace_id = ${workspaceId} limit 1`
			)
		);
		if (!r.length) {
			const e = new HttpError(404, 'Project not found');
			e.status = 404;
			throw e;
		}
		return r[0];
	}
	async function billingAccountFor(database, workspaceId) {
		await database.execute(
			sql`insert into billing_account (id, workspace_id) values (${newId(ID_PREFIXES.billingAccount)}, ${workspaceId}) on conflict (workspace_id) do nothing`
		);
		const r = rowsOf(
			await database.execute(sql`select * from billing_account where workspace_id = ${workspaceId} limit 1`)
		);
		if (!r.length) throw new Error('billing_account missing');
		return r[0];
	}
	async function ledgerBalance(database, accountId) {
		const r = rowsOf(
			await database.execute(
				sql`select coalesce(sum(amount_micro), 0)::text as total from credit_ledger where billing_account_id = ${accountId}`
			)
		);
		return big(r[0]?.total);
	}

	const wrap = (fn) => async (req, res) => {
		try {
			await _ipStore.run(_clientIp(req), () => fn(req, res));
		} catch (err) {
			if (err instanceof HttpError) return fail(res, err.status, err.message);
			if (err && err.status) return fail(res, err.status, err.message || 'Request failed');
			console.error('[pages]', err);
			if (!res.headersSent) return fail(res, 500, 'Request failed');
		}
	};
	// writeAudit with the request IP filled in from the async store.
	const audit = (database, entry) => writeAudit(database, { ip: _ipStore.getStore() ?? null, ...entry });

	// ---- overview ----
	app.get('/api/pages/dashboard', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const totals = rowsOf(
			await database.execute(sql`select count(*)::int as requests, coalesce(sum(tokens_in),0)::int as tokens_in, coalesce(sum(tokens_out),0)::int as tokens_out, coalesce(sum(cost),0)::text as cost from request_log where user_id = ${userRow.id}`)
		)[0] ?? { requests: 0, tokens_in: 0, tokens_out: 0, cost: '0' };
		const kc = rowsOf(
			await database.execute(sql`select count(*)::int as n from api_key where user_id = ${userRow.id} and revoked_at is null`)
		)[0];
		const recent = rowsOf(
			await database.execute(sql`select r.id, r.created_at, r.tokens_in, r.tokens_out, r.cost, r.currency, r.latency_ms, r.status, m.slug as model_slug, p.name as provider_name from request_log r left join model m on m.id = r.model_id left join provider p on p.id = r.provider_id where r.user_id = ${userRow.id} order by r.created_at desc limit 10`)
		).map((r) => ({ ...r, createdAt: iso(r.created_at), cost: String(r.cost ?? '0'), providerName: r.provider_name ?? null }));
		// The chart range is a closed vocabulary, not a free number: the series
		// is materialised per day, so an unbounded value would let a request
		// build a 999-element array and a 999-day log scan.
		const range = [7, 30, 90].includes(Number(req.query.range)) ? Number(req.query.range) : 30;
		const since = new Date();
		since.setUTCHours(0, 0, 0, 0);
		since.setUTCDate(since.getUTCDate() - (range - 1));
		const win = rowsOf(
			await database.execute(sql`select created_at, tokens_in, tokens_out, cost, status from request_log where user_id = ${userRow.id} and created_at >= ${since.toISOString()}`)
		);
		const byDay = new Map();
		for (const row of win) {
			const k = new Date(row.created_at).toISOString().slice(0, 10);
			const b = byDay.get(k) ?? { requests: 0, tokens: 0, cost: 0n, errors: 0, tokensIn: 0, tokensOut: 0 };
			b.requests += 1;
			b.tokens += num(row.tokens_in) + num(row.tokens_out);
			b.cost += big(row.cost);
			// status is the ledger's own taxonomy (success|client_error|...), not
			// an HTTP code: http_status is NULL whenever the request died before
			// a provider answered, so a numeric threshold would miss those.
			b.errors += row.status === 'success' ? 0 : 1;
			b.tokensIn += num(row.tokens_in);
			b.tokensOut += num(row.tokens_out);
			byDay.set(k, b);
		}
		const series = Array.from({ length: range }, (_, i) => {
			const d = new Date(since);
			d.setUTCDate(since.getUTCDate() + i);
			const k = d.toISOString().slice(0, 10);
			const b = byDay.get(k) ?? { requests: 0, tokens: 0, cost: 0n, errors: 0, tokensIn: 0, tokensOut: 0 };
			return { day: k, requests: b.requests, tokens: b.tokens, cost: b.cost.toString(), errors: b.errors, tokensIn: b.tokensIn, tokensOut: b.tokensOut };
		});
		const byModel = rowsOf(
			await database.execute(sql`select m.slug as slug, count(*)::int as requests, coalesce(sum(r.cost),0)::text as cost from request_log r left join model m on m.id = r.model_id where r.user_id = ${userRow.id} and r.created_at >= ${since.toISOString()} group by m.slug order by count(*) desc limit 5`)
		).map((r) => ({ slug: String(r.slug ?? 'Unresolved'), requests: num(r.requests), cost: String(r.cost ?? '0') }));
		// Onboarding checklist fields (spec §19 item 7). mustWorkspace is the
		// resolution every other page handler uses, so the banner's
		// localStorage key names the workspace the member is actually viewing;
		// workspace.read is in all five builtin roles, so it cannot refuse a
		// member this page already serves.
		const { workspaceId } = await mustWorkspace(database, userRow, req, 'workspace.read');
		// Spec §19's four cards need the credit balance, and a firing alert is
		// the one thing on this page a member has to act on, so both ride the
		// same page load rather than a second round trip.
		// workspace.read does not imply alert.read: a custom role can hold one
		// without the other, and alert names are not that role's business. An
		// empty list keeps the page rendering; a 403 would take the whole
		// dashboard away over a panel.
		const caps = await memberCapsOf(database, userRow.id, workspaceId);
		const [wsRow, alertRows, balance] = await Promise.all([
			database.execute(sql`select created_at from workspace where id = ${workspaceId} limit 1`),
			caps.has('alert.read')
				? database.execute(sql`select e.id, e.alert_id, a.name as alert_name, a.project_id, a.condition->>'type' as condition_type, e.triggered_at, e.value, e.message, e.state from alert_event e inner join alert a on a.id = e.alert_id where a.workspace_id = ${workspaceId} and e.state = 'firing' order by e.triggered_at desc limit 10`)
				: Promise.resolve([]),
			// The billing page's own helpers, not a second balance query. An
			// account row is provisioned with the workspace, but a workspace
			// predating that must read zero here rather than 500 the page.
			billingAccountFor(database, workspaceId).then((a) => ledgerBalance(database, a.id)).catch(() => 0n)
		]);
		const firingAlerts = rowsOf(alertRows).map((e) => ({ id: e.id, alertId: e.alert_id, alertName: e.alert_name, projectId: e.project_id ?? null, conditionType: String(e.condition_type ?? ''), value: String(e.value ?? ''), message: e.message, triggeredAt: iso(e.triggered_at) }));
		res.json({ totals: { requests: num(totals.requests), tokensIn: num(totals.tokens_in), tokensOut: num(totals.tokens_out), cost: String(totals.cost ?? '0') }, activeKeys: num(kc?.n), recent, series, byModel, range, workspaceId, workspaceCreatedAt: iso(rowsOf(wsRow)[0]?.created_at), balanceMicro: balance.toString(), firingAlerts });
	}));

	// ---- workspace-level keys ----
	app.get(['/api/pages/keys', '/api/pages/dashboard/keys'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const keys = rowsOf(
			await database.execute(sql`select k.id, k.name, k.prefix, k.status, k.last_used_at, k.revoked_at, k.created_at, k.expires_at, k.project_id, k.environment_id, p.name as project_name, e.name as environment_name from api_key k left join project p on p.id = k.project_id left join environment e on e.id = k.environment_id where k.user_id = ${userRow.id} order by k.created_at desc`)
		).map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, status: k.revoked_at ? 'revoked' : (k.status ?? 'active'), lastUsedAt: iso(k.last_used_at), revokedAt: iso(k.revoked_at), createdAt: iso(k.created_at), expiresAt: iso(k.expires_at), projectId: k.project_id ?? null, projectName: k.project_name ?? null, environmentId: k.environment_id ?? null, environmentName: k.environment_name ?? null, usage30d: { requests: 0, tokens: 0, costMicro: '0' } }));
		// One grouped query for the whole table: a per-key query would make the
		// page load scale with key count, and the page renders usage for every row.
		const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
		const usage = new Map(
			rowsOf(
				await database.execute(sql`select api_key_id, count(*)::int as requests, coalesce(sum(tokens_in + tokens_out),0)::int as tokens, coalesce(sum(cost),0)::text as cost from request_log where user_id = ${userRow.id} and api_key_id is not null and created_at >= ${since} group by api_key_id`)
			).map((r) => [r.api_key_id, { requests: num(r.requests), tokens: num(r.tokens), costMicro: String(r.cost ?? '0') }])
		);
		for (const k of keys) k.usage30d = usage.get(k.id) ?? k.usage30d;
		res.json({ keys });
	}));
	// expiresIn is a closed vocabulary; Object.hasOwn (not `in`) because `in`
	// would accept prototype names like "toString" and store an Invalid Date.
	const KEY_EXPIRY_DAYS = { '30d': 30, '90d': 90, '1y': 365 };
	app.post(['/api/pages/keys/create', '/api/pages/dashboard/keys/create'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const b = okBody(req);
		const name = String(b.name ?? '').trim() || 'default';
		const expiresIn = String(b.expiresIn ?? 'never').trim() || 'never';
		if (expiresIn !== 'never' && !Object.hasOwn(KEY_EXPIRY_DAYS, expiresIn)) return fail(res, 400, 'Expiry must be never, 30d, 90d or 1y');
		const projectId = String(b.projectId ?? '').trim();
		const environmentId = String(b.environmentId ?? '').trim();
		// Scope ids arrive in the body, so they are looked up against the
		// caller's workspace before they are stored — an id alone is not proof
		// the caller may bind a key to it. Only scoped creates pay the lookup;
		// an unscoped key keeps the pre-existing insert.
		let workspaceId = null;
		let scopeProjectId = null;
		let scopeEnvId = null;
		if (projectId || environmentId) {
			({ workspaceId } = await mustWorkspace(database, userRow, req, 'key.create'));
			if (projectId) {
				const proj = rowsOf(await database.execute(sql`select id from project where id = ${projectId} and workspace_id = ${workspaceId} limit 1`))[0];
				if (!proj) return fail(res, 403, 'That project is not in this workspace');
				scopeProjectId = proj.id;
			}
			if (environmentId) {
				const env = rowsOf(await database.execute(sql`select e.id from environment e inner join project p on p.id = e.project_id where e.id = ${environmentId} and p.workspace_id = ${workspaceId} limit 1`))[0];
				if (!env) return fail(res, 403, 'That environment is not in this workspace');
				scopeEnvId = env.id;
			}
		}
		const { key, prefix, keyHash } = generateApiKey();
		const id = newId(ID_PREFIXES.apiKey);
		const expiresAt = expiresIn === 'never' ? null : new Date(Date.now() + KEY_EXPIRY_DAYS[expiresIn] * 86_400_000).toISOString();
		await database.execute(sql`insert into api_key (id, user_id, name, prefix, key_hash, status, workspace_id, project_id, environment_id, expires_at) values (${id}, ${userRow.id}, ${name}, ${prefix}, ${keyHash}, 'active', ${workspaceId}, ${scopeProjectId}, ${scopeEnvId}, ${expiresAt})`);
		await audit(database, { actorUserId: userRow.id, action: 'key.create', resource: 'api_key', resourceId: id, workspaceId, metadata: { name, prefix, projectId: scopeProjectId, environmentId: scopeEnvId, expiresAt } });
		res.json({ created: key, name, id });
	}));
	app.post(['/api/pages/keys/revoke', '/api/pages/dashboard/keys/revoke'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const id = String(okBody(req).id ?? '').trim();
		if (!id) return fail(res, 400, 'Missing key id');
		const r = rowsOf(
			await database.execute(sql`update api_key set revoked_at = now(), status = 'revoked' where id = ${id} and user_id = ${userRow.id} returning id`)
		);
		if (!r.length) return fail(res, 404, 'Key not found');
		res.json({ revoked: id });
	}));

	// ---- usage (workspace, 30d default) ----
	app.get(['/api/pages/usage', '/api/pages/dashboard/usage'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const { workspaceId } = await mustWorkspace(database, userRow, req, 'usage.read');
		const days = [1, 7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
		const to = new Date();
		const from = new Date(to.getTime() - days * 86_400_000);
		// Optional facet filters, shared by the summary and the log endpoint.
		// Every predicate is a parameterised sql fragment — never concatenated.
		const model = String(req.query.model ?? '').trim().slice(0, 200);
		const provider = String(req.query.provider ?? '').trim().slice(0, 200);
		const key = String(req.query.key ?? '').trim().slice(0, 200);
		const status = String(req.query.status ?? '').trim();
		const conds = [sql`r.workspace_id = ${workspaceId}`, sql`r.created_at >= ${from.toISOString()}`, sql`r.created_at < ${to.toISOString()}`];
		// model/provider/key filter on the same columns the breakdowns group by,
		// so a facet value selected from byModel/byProvider always matches.
		if (model) conds.push(sql`r.model_id = ${model}`);
		if (provider) conds.push(sql`r.provider_id = ${provider}`);
		if (key) conds.push(sql`r.api_key_id = ${key}`);
		if (REQUEST_STATUSES.includes(status)) conds.push(sql`r.status in (${sql.join(statusFilterValues(status), sql`, `)})`);
		const where = sql.join(conds, sql` and `);
		// Facet sources for the filter selects: the same window WITHOUT the
		// model/provider predicates, so the dropdowns never collapse to the
		// active selection. Breakdowns below stay filtered.
		const facetWhere = sql.join([sql`r.workspace_id = ${workspaceId}`, sql`r.created_at >= ${from.toISOString()}`, sql`r.created_at < ${to.toISOString()}`], sql` and `);
		const facets = {
			models: rowsOf(
				await database.execute(sql`select coalesce(m.slug, 'Unresolved') as label, coalesce(r.model_id,'') as key from request_log r left join model m on m.id = r.model_id where ${facetWhere} group by m.slug, r.model_id order by count(*) desc limit 50`)
			).map((r) => ({ key: r.key, label: r.label || 'Unresolved' })),
			providers: rowsOf(
				await database.execute(sql`select coalesce(p.name, 'Unresolved') as label, coalesce(r.provider_id,'') as key from request_log r left join provider p on p.id = r.provider_id where ${facetWhere} group by p.name, r.provider_id order by count(*) desc limit 50`)
			).map((r) => ({ key: r.key, label: r.label || 'Unresolved' }))
		};
		const totals = rowsOf(
			await database.execute(sql`select count(*)::int as requests, coalesce(sum(tokens_in),0)::int as tokens_in, coalesce(sum(tokens_out),0)::int as tokens_out, coalesce(sum(cost),0)::text as cost from request_log r where ${where}`)
		)[0] ?? {};
		const byDay = rowsOf(
			await database.execute(sql`select date_trunc('day', r.created_at)::text as day, count(*)::int as requests, coalesce(sum(r.tokens_in + r.tokens_out),0)::int as tokens, coalesce(sum(r.cost),0)::text as cost from request_log r where ${where} group by 1 order by 1`)
		).map((r) => ({ day: String(r.day).slice(0, 10), requests: num(r.requests), totalTokens: num(r.tokens), costMicro: String(r.cost ?? '0') }));
		const byProject = rowsOf(
			await database.execute(sql`select coalesce(p.name, r.project_id, 'Unresolved') as label, coalesce(r.project_id,'') as key, count(*)::int as requests, coalesce(sum(r.tokens_in + r.tokens_out),0)::int as tokens, coalesce(sum(r.cost),0)::text as cost from request_log r left join project p on p.id = r.project_id where ${where} group by p.name, r.project_id order by count(*) desc limit 20`)
		).map((r) => ({ key: r.key, label: r.label || 'Unresolved', requests: num(r.requests), totalTokens: num(r.tokens), costMicro: String(r.cost ?? '0') }));
		const byModel = rowsOf(
			await database.execute(sql`select coalesce(m.slug, 'Unresolved') as label, coalesce(r.model_id,'') as key, count(*)::int as requests, coalesce(sum(r.tokens_in + r.tokens_out),0)::int as tokens, coalesce(sum(r.cost),0)::text as cost from request_log r left join model m on m.id = r.model_id where ${where} group by m.slug, r.model_id order by count(*) desc limit 20`)
		).map((r) => ({ key: r.key, label: r.label || 'Unresolved', requests: num(r.requests), totalTokens: num(r.tokens), costMicro: String(r.cost ?? '0') }));
		const byProvider = rowsOf(
			await database.execute(sql`select coalesce(p.name, 'Unresolved') as label, coalesce(r.provider_id,'') as key, count(*)::int as requests, coalesce(sum(r.tokens_in + r.tokens_out),0)::int as tokens, coalesce(sum(r.cost),0)::text as cost from request_log r left join provider p on p.id = r.provider_id where ${where} group by p.name, r.provider_id order by count(*) desc limit 20`)
		).map((r) => ({ key: r.key, label: r.label || 'Unresolved', requests: num(r.requests), totalTokens: num(r.tokens), costMicro: String(r.cost ?? '0') }));
		const byApiKey = rowsOf(
			await database.execute(sql`select coalesce(k.name || ' · ' || k.prefix, 'Unresolved') as label, coalesce(r.api_key_id,'') as key, count(*)::int as requests, coalesce(sum(r.tokens_in + r.tokens_out),0)::int as tokens, coalesce(sum(r.cost),0)::text as cost from request_log r left join api_key k on k.id = r.api_key_id where ${where} group by k.name, k.prefix, r.api_key_id order by count(*) desc limit 20`)
		).map((r) => ({ key: r.key, label: r.label || 'Unresolved', requests: num(r.requests), totalTokens: num(r.tokens), costMicro: String(r.cost ?? '0') }));
		// percentile_cont ignores NULL latency rows natively; coalesce covers the
		// empty-range case so the chart never renders NaN.
		const latency = rowsOf(
			await database.execute(sql`select coalesce(round(percentile_cont(0.5) within group (order by r.latency_ms)),0)::int as p50, coalesce(round(percentile_cont(0.95) within group (order by r.latency_ms)),0)::int as p95, coalesce(round(percentile_cont(0.99) within group (order by r.latency_ms)),0)::int as p99 from request_log r where ${where}`)
		)[0] ?? { p50: 0, p95: 0, p99: 0 };
		// Chart-only siblings: byDay's shape is frozen, so per-day errors and
		// latency percentiles live beside it. status is the ledger's taxonomy,
		// not an HTTP code (see the dashboard handler's comment).
		const errorsByDay = rowsOf(
			await database.execute(sql`select date_trunc('day', r.created_at)::text as day, count(*) filter (where r.status <> 'success')::int as errors from request_log r where ${where} group by 1 order by 1`)
		).map((r) => ({ day: String(r.day).slice(0, 10), errors: num(r.errors) }));
		const latencyByDay = rowsOf(
			await database.execute(sql`select date_trunc('day', r.created_at)::text as day, coalesce(round(percentile_cont(0.5) within group (order by r.latency_ms)),0)::int as p50, coalesce(round(percentile_cont(0.95) within group (order by r.latency_ms)),0)::int as p95, coalesce(round(percentile_cont(0.99) within group (order by r.latency_ms)),0)::int as p99 from request_log r where ${where} group by 1 order by 1`)
		).map((r) => ({ day: String(r.day).slice(0, 10), p50: num(r.p50), p95: num(r.p95), p99: num(r.p99) }));
		res.json({ denied: false, range: { days, from: from.toISOString(), to: to.toISOString(), source: 'raw' }, totals: { requests: num(totals.requests), tokensIn: num(totals.tokens_in), tokensOut: num(totals.tokens_out), costMicro: String(totals.cost ?? '0') }, latency: { p50: num(latency.p50), p95: num(latency.p95), p99: num(latency.p99) }, breakdowns: { byDay, byProject, byEnvironment: [], byApiKey, byModel, byProvider }, errorsByDay, latencyByDay, facets });
	}));

	// ---- usage request log (workspace, paged) ----
	app.get('/api/pages/dashboard/usage/requests', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const { workspaceId } = await mustWorkspace(database, userRow, req, 'usage.read');
		const days = [1, 7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
		const to = new Date();
		const from = new Date(to.getTime() - days * 86_400_000);
		const model = String(req.query.model ?? '').trim().slice(0, 200);
		const provider = String(req.query.provider ?? '').trim().slice(0, 200);
		const key = String(req.query.key ?? '').trim().slice(0, 200);
		const status = String(req.query.status ?? '').trim();
		const conds = [sql`r.workspace_id = ${workspaceId}`, sql`r.created_at >= ${from.toISOString()}`, sql`r.created_at < ${to.toISOString()}`];
		// Same columns as the summary handler's filters (and the breakdowns'
		// group-by keys), so a facet value selected in the UI always matches.
		if (model) conds.push(sql`r.model_id = ${model}`);
		if (provider) conds.push(sql`r.provider_id = ${provider}`);
		if (key) conds.push(sql`r.api_key_id = ${key}`);
		if (REQUEST_STATUSES.includes(status)) conds.push(sql`r.status in (${sql.join(statusFilterValues(status), sql`, `)})`);
		const where = sql.join(conds, sql` and `);
		const total = num(rowsOf(
			await database.execute(sql`select count(*)::int as n from request_log r where ${where}`)
		)[0]?.n);
		const pages = Math.max(1, Math.ceil(total / 50));
		const page = Math.min(pages, Math.max(1, Number.isFinite(Number(req.query.page)) ? Math.floor(Number(req.query.page)) : 1));
		const rows = rowsOf(
			await database.execute(sql`select r.id, r.project_id, r.created_at, r.requested_model, m.slug as model_slug, p.name as provider_name, r.attempts, r.fallback_used, r.tokens_in, r.tokens_out, r.cost, r.latency_ms, r.ttft_ms, r.status, r.error_code from request_log r left join model m on m.id = r.model_id left join provider p on p.id = r.provider_id where ${where} order by r.created_at desc, r.id desc limit 50 offset ${(page - 1) * 50}`)
		).map((r) => ({ id: r.id, projectId: r.project_id ?? null, createdAt: iso(r.created_at), requestedModel: r.requested_model, modelSlug: r.model_slug, providerName: r.provider_name, attempts: num(r.attempts), fallbackUsed: !!r.fallback_used, tokensIn: num(r.tokens_in), tokensOut: num(r.tokens_out), costMicro: String(r.cost ?? '0'), latencyMs: num(r.latency_ms), ttftMs: r.ttft_ms == null ? null : num(r.ttft_ms), status: normalizeStatus(r.status), errorCode: r.error_code }));
		res.json({ rows, total, page, pages });
	}));

	// ---- billing ----
	app.get(['/api/pages/billing', '/api/pages/dashboard/billing'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const { workspaceId, workspace } = await mustWorkspace(database, userRow, req, 'billing.read');
		const account = await billingAccountFor(database, workspaceId);
		const balance = await ledgerBalance(database, account.id);
		const now = new Date();
		const ps = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
		const pe = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
		const period = rowsOf(
			await database.execute(sql`select coalesce(-sum(amount_micro),0)::text as total, count(*)::int as requests from credit_ledger where billing_account_id = ${account.id} and type = 'usage_charge' and created_at >= ${ps.toISOString()} and created_at < ${pe.toISOString()}`)
		)[0] ?? {};
		const caps = await memberCapsOf(database, userRow.id, workspaceId);
		res.json({ currency: String(account.currency ?? 'USD').trim(), status: account.status, workspaceName: workspace.name, canWrite: caps.has('billing.write'), balanceMicro: balance.toString(), warningThresholdMicro: String(account.warning_threshold_micro ?? account.warningThresholdMicro ?? '0'), hardStopThresholdMicro: String(account.hard_stop_threshold_micro ?? account.hardStopThresholdMicro ?? '0'), period: { start: ps.toISOString(), end: pe.toISOString(), spentMicro: String(period.total ?? '0'), requests: num(period.requests) } });
	}));
	app.post(['/api/pages/billing/thresholds', '/api/pages/dashboard/billing/thresholds'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const { workspaceId } = await mustWorkspace(database, userRow, req, 'billing.read');
		const caps = await memberCapsOf(database, userRow.id, workspaceId);
		if (!caps.has('billing.write')) return fail(res, 403, 'You need billing.write to change thresholds.');
		const b = okBody(req);
		const warning = parseAmountToMicro(b.warn ?? b.warning ?? '');
		const hardStop = parseAmountToMicro(b.suspend ?? b.hard_stop ?? b.hardStop ?? '');
		if (warning === null || hardStop === null) return fail(res, 400, 'Thresholds must be dollar amounts, e.g. 10 or 0.50.');
		if (warning < 0n || hardStop < 0n) return fail(res, 400, 'Thresholds cannot be negative.');
		if (hardStop > warning) return fail(res, 400, 'The hard-stop threshold must be at or below the warning threshold.');
		await database.execute(sql`update billing_account set warning_threshold_micro = ${warning.toString()}, hard_stop_threshold_micro = ${hardStop.toString()}, updated_at = now() where workspace_id = ${workspaceId}`);
		await audit(database, { actorUserId: userRow.id, action: 'billing.thresholds.update', resource: 'billing_account', workspaceId, after: { warning_threshold_micro: warning.toString(), hard_stop_threshold_micro: hardStop.toString() } });
		res.json({ saved: true });
	}));
	app.get(['/api/pages/billing/credits', '/api/pages/dashboard/billing/credits'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const { workspaceId } = await mustWorkspace(database, userRow, req, 'billing.read');
		const account = await billingAccountFor(database, workspaceId);
		const balance = await ledgerBalance(database, account.id);
		// The window must run over the account's FULL ledger, so the page filter
		// happens in the outer query — otherwise balanceAfterMicro is wrong.
		const total = num(rowsOf(
			await database.execute(sql`select count(*)::int as n from credit_ledger where billing_account_id = ${account.id}`)
		)[0]?.n);
		const pages = Math.max(1, Math.ceil(total / 50));
		const page = Math.min(pages, Math.max(1, Number.isFinite(Number(req.query.page)) ? Math.floor(Number(req.query.page)) : 1));
		const rows = rowsOf(
			await database.execute(sql`with w as (select id, type, amount_micro, currency, request_id, description, created_at, sum(amount_micro) over (order by created_at, id) as balance_after from credit_ledger where billing_account_id = ${account.id}) select id, type, amount_micro, currency, request_id, description, created_at, balance_after from w order by created_at desc, id desc limit 50 offset ${(page - 1) * 50}`)
		).map((r) => ({ id: r.id, type: r.type, amountMicro: String(r.amount_micro ?? '0'), currency: String(r.currency ?? '').trim(), requestId: r.request_id, description: r.description, createdAt: iso(r.created_at), balanceAfterMicro: String(r.balance_after ?? '0') }));
		// Spend series + breakdowns share the 30-day window; cost > 0 keeps
		// zero-cost rows out of the chart and the top-5 ranking.
		const to = new Date();
		const from = new Date(to.getTime() - 30 * 86_400_000);
		const window = sql`r.workspace_id = ${workspaceId} and r.cost > 0 and r.created_at >= ${from.toISOString()} and r.created_at < ${to.toISOString()}`;
		const topModels = rowsOf(
			await database.execute(sql`select coalesce(m.slug, 'Unresolved') as label, coalesce(r.model_id,'') as key, coalesce(sum(r.cost),0)::text as cost from request_log r left join model m on m.id = r.model_id where ${window} group by m.slug, r.model_id order by sum(r.cost) desc limit 5`)
		);
		const topKeys = topModels.map((r) => r.key);
		// Group by model_id (not slug) so the top-5 filter below compares keys
		// to keys; a NULL model_id collapses to '' and lands in Other.
		const seriesRows = rowsOf(
			await database.execute(sql`select date_trunc('day', r.created_at)::text as day, coalesce(r.model_id,'') as key, coalesce(m.slug, 'Unresolved') as label, coalesce(sum(r.cost),0)::text as cost from request_log r left join model m on m.id = r.model_id where ${window} group by 1, 2, 3 order by 1`)
		);
		const byDay = new Map();
		for (const r of seriesRows) {
			const day = String(r.day).slice(0, 10);
			if (!byDay.has(day)) byDay.set(day, []);
			byDay.get(day).push({ key: r.key, label: r.label, costMicro: String(r.cost ?? '0') });
		}
		const series = [...byDay.entries()].map(([day, entries]) => {
			const top = topModels.map((t) => entries.find((e) => e.key === t.key) ?? { key: t.key, label: t.label, costMicro: '0' });
			const other = entries.filter((e) => !topKeys.includes(e.key)).reduce((acc, e) => acc + BigInt(e.costMicro), 0n);
			return { day, series: [...top, { label: 'Other', costMicro: other.toString() }] };
		});
		const byModel = rowsOf(
			await database.execute(sql`select coalesce(m.slug, 'Unresolved') as label, coalesce(r.model_id,'') as key, count(*)::int as requests, coalesce(sum(r.tokens_in + r.tokens_out),0)::int as tokens, coalesce(sum(r.cost),0)::text as cost from request_log r left join model m on m.id = r.model_id where ${window} group by m.slug, r.model_id order by sum(r.cost) desc limit 10`)
		).map((r) => ({ key: r.key, label: r.label || 'Unresolved', requests: num(r.requests), totalTokens: num(r.tokens), costMicro: String(r.cost ?? '0') }));
		const byProject = rowsOf(
			await database.execute(sql`select coalesce(p.name, 'Unresolved') as label, coalesce(r.project_id,'') as key, count(*)::int as requests, coalesce(sum(r.tokens_in + r.tokens_out),0)::int as tokens, coalesce(sum(r.cost),0)::text as cost from request_log r left join project p on p.id = r.project_id where ${window} group by p.name, r.project_id order by sum(r.cost) desc limit 10`)
		).map((r) => ({ key: r.key, label: r.label || 'Unresolved', requests: num(r.requests), totalTokens: num(r.tokens), costMicro: String(r.cost ?? '0') }));
		res.json({ currency: String(account.currency ?? 'USD').trim(), balanceMicro: balance.toString(), rows, addCreditKey: `purchase:${newId(prefixFor(ctx, 'creditLedger'))}`, page, pages, total, thresholds: { warningMicro: String(account.warning_threshold_micro ?? account.warningThresholdMicro ?? '0'), hardStopMicro: String(account.hard_stop_threshold_micro ?? account.hardStopThresholdMicro ?? '0') }, series, breakdowns: { byModel, byProject } });
	}));
	app.post(['/api/pages/billing/credits/add', '/api/pages/dashboard/billing/credits/add'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const { workspaceId } = await mustWorkspace(database, userRow, req, 'billing.read');
		const caps = await memberCapsOf(database, userRow.id, workspaceId);
		if (!caps.has('billing.write')) return fail(res, 403, 'You need billing.write to add credits.');
		const b = okBody(req);
		const amount = parseAmountToMicro(b.amount ?? '');
		if (amount === null || amount <= 0n) return fail(res, 400, 'Enter a positive dollar amount, e.g. 100 or 25.50.');
		const key = String(b.key ?? `purchase:${newId(prefixFor(ctx, 'creditLedger'))}`).trim();
		const account = await billingAccountFor(database, workspaceId);
		const id = newId(prefixFor(ctx, 'creditLedger'));
		const ins = rowsOf(
			await database.execute(sql`insert into credit_ledger (id, billing_account_id, type, amount_micro, currency, idempotency_key, description, created_by) values (${id}, ${account.id}, 'credit_purchase', ${amount.toString()}, ${String(account.currency ?? 'USD').trim()}, ${key}, ${String(b.description ?? '').trim() || 'Credit purchase'}, ${userRow.id}) on conflict (idempotency_key) do nothing returning id`)
		);
		if (!ins.length) {
			const ex = rowsOf(await database.execute(sql`select id from credit_ledger where idempotency_key = ${key} limit 1`))[0];
			return res.json({ already: true, id: ex?.id });
		}
		await database.execute(sql`update billing_account set balance_micro = balance_micro + ${amount.toString()}, updated_at = now() where id = ${account.id}`);
		res.json({ added: true, id });
	}));
	app.get(['/api/pages/billing/invoices', '/api/pages/dashboard/billing/invoices'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const { workspaceId } = await mustWorkspace(database, userRow, req, 'billing.read');
		const account = await billingAccountFor(database, workspaceId);
		const rows = rowsOf(
			await database.execute(sql`select id, number, period_start, period_end, amount_micro, currency, status, issued_at, paid_at from invoice where billing_account_id = ${account.id} order by period_start desc limit 100`)
		).map((r) => ({ id: r.id, number: r.number, periodStart: iso(r.period_start), periodEnd: iso(r.period_end), amountMicro: String(r.amount_micro ?? '0'), currency: String(r.currency ?? '').trim(), status: r.status, issuedAt: iso(r.issued_at), paidAt: iso(r.paid_at) }));
		res.json({ invoices: rows, rows });
	}));
	app.post(['/api/pages/billing/invoices/generate', '/api/pages/dashboard/billing/invoices/generate'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const { workspaceId } = await mustWorkspace(database, userRow, req, 'billing.read');
		const caps = await memberCapsOf(database, userRow.id, workspaceId);
		if (!caps.has('billing.write')) return fail(res, 403, 'You need billing.write to generate invoices.');
		const account = await billingAccountFor(database, workspaceId);
		const now = new Date();
		const ps = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
		const pe = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
		const ex = rowsOf(await database.execute(sql`select id, number from invoice where billing_account_id = ${account.id} and period_start = ${ps.toISOString()} and period_end = ${pe.toISOString()} limit 1`))[0];
		if (ex) return res.json({ already: true, number: ex.number });
		const period = rowsOf(
			await database.execute(sql`select coalesce(-sum(amount_micro),0)::text as total from credit_ledger where billing_account_id = ${account.id} and type = 'usage_charge' and created_at >= ${ps.toISOString()} and created_at < ${pe.toISOString()}`)
		)[0];
		const id = newId(prefixFor(ctx, 'invoice'));
		const ym = `${ps.getUTCFullYear()}${String(ps.getUTCMonth() + 1).padStart(2, '0')}`;
		// The FULL id, not a 6-character suffix. `invoice.number` is UNIQUE and
		// this used to be `id.slice(-6)` — 6 hex characters, 2^24 of them,
		// shared by every invoice row; two ids agreeing in the last 6
		// characters produced the same number and the insert died on the
		// unique violation. Mirrors packages/platform/server/workers.ts
		// invoiceGeneration, which fixed the same collision with the full id.
		const number = `INV-${ym}-${id}`;
		await database.execute(sql`insert into invoice (id, billing_account_id, number, period_start, period_end, amount_micro, currency, status, issued_at) values (${id}, ${account.id}, ${number}, ${ps.toISOString()}, ${pe.toISOString()}, ${String(period?.total ?? '0')}, ${String(account.currency ?? 'USD').trim()}, 'open', now())`);
		res.json({ generated: true, number, id });
	}));
	async function invoiceTransition(database, userRow, req, res, status) {
		const { workspaceId } = await mustWorkspace(database, userRow, req, 'billing.read');
		const caps = await memberCapsOf(database, userRow.id, workspaceId);
		if (!caps.has('billing.write')) return fail(res, 403, 'You need billing.write to change invoices.');
		const id = String(okBody(req).id ?? '').trim();
		if (!id) return fail(res, 400, 'Missing invoice id.');
		const account = await billingAccountFor(database, workspaceId);
		const upd = rowsOf(
			status === 'paid'
				? await database.execute(sql`update invoice set status = 'paid', paid_at = now() where id = ${id} and billing_account_id = ${account.id} returning id, number, status`)
				: await database.execute(sql`update invoice set status = 'void', paid_at = null where id = ${id} and billing_account_id = ${account.id} returning id, number, status`)
		)[0];
		if (!upd) return fail(res, 404, 'Invoice not found.');
		return res.json(status === 'paid' ? { paid: true, number: upd.number } : { voided: true, number: upd.number });
	}
	app.post(['/api/pages/billing/invoices/markPaid', '/api/pages/dashboard/billing/invoices/markPaid'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		await invoiceTransition(database, await mustAuth(req), req, res, 'paid');
	}));
	app.post(['/api/pages/billing/invoices/void', '/api/pages/dashboard/billing/invoices/void'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		await invoiceTransition(database, await mustAuth(req), req, res, 'void');
	}));
	app.get(['/api/pages/billing/payment-methods', '/api/pages/dashboard/billing/payment-methods'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const { workspaceId } = await mustWorkspace(database, userRow, req, 'billing.read');
		const key = `billing.payment_method_intent:${workspaceId}`;
		const row = rowsOf(await database.execute(sql`select value from system_setting where key = ${key} limit 1`))[0];
		res.json({ intent: row?.value ?? null });
	}));
	app.post(['/api/pages/billing/payment-methods/record', '/api/pages/dashboard/billing/payment-methods/record'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const { workspaceId } = await mustWorkspace(database, userRow, req, 'billing.read');
		const caps = await memberCapsOf(database, userRow.id, workspaceId);
		if (!caps.has('billing.write')) return fail(res, 403, 'You need billing.write to record billing intent.');
		const b = okBody(req);
		const method = String(b.method ?? b.label ?? '').trim();
		const contact = String(b.contact ?? '').trim();
		if (!method) return fail(res, 400, 'Choose how you intend to pay.');
		if (!contact) return fail(res, 400, 'Leave a contact so an operator can follow up.');
		const value = JSON.stringify({ method, contact, note: String(b.note ?? '').trim(), recordedAt: new Date().toISOString(), recordedBy: userRow.id });
		const key = `billing.payment_method_intent:${workspaceId}`;
		await database.execute(sql`insert into system_setting (key, value, updated_by) values (${key}, ${value}::jsonb, ${userRow.id}) on conflict (key) do update set value = ${value}::jsonb, updated_by = ${userRow.id}, updated_at = now()`);
		res.json({ recorded: true });
	}));
	app.get(['/api/pages/billing/transactions', '/api/pages/dashboard/billing/transactions'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const { workspaceId } = await mustWorkspace(database, userRow, req, 'billing.read');
		const account = await billingAccountFor(database, workspaceId);
		const rows = rowsOf(
			await database.execute(sql`select id, type, amount_micro, currency, request_id, description, created_at from credit_ledger where billing_account_id = ${account.id} order by created_at desc, id desc limit 50`)
		).map((r) => ({ id: r.id, type: r.type, amountMicro: String(r.amount_micro ?? '0'), currency: String(r.currency ?? '').trim(), requestId: r.request_id, description: r.description, createdAt: iso(r.created_at) }));
		res.json({ rows, currency: String(account.currency ?? 'USD').trim() });
	}));

	// ---- account ----
	app.get(['/api/pages/account', '/api/pages/dashboard/account'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const acc = rowsOf(await database.execute(sql`select id, name, email, role, created_at from "user" where id = ${userRow.id} limit 1`))[0];
		const prof = rowsOf(await database.execute(sql`select timezone from profile where user_id = ${userRow.id} limit 1`))[0];
		res.json({ account: acc ? { ...acc, createdAt: iso(acc.created_at) } : null, timezone: prof?.timezone ?? '' });
	}));
	app.post(['/api/pages/account/save', '/api/pages/dashboard/account/save'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const b = okBody(req);
		const name = String(b.name ?? '').trim();
		if (!name) return fail(res, 400, 'Name is required');
		const timezone = String(b.timezone ?? '').trim();
		await database.execute(sql`update "user" set name = ${name} where id = ${userRow.id}`);
		await database.execute(sql`insert into profile (user_id, timezone) values (${userRow.id}, ${timezone}) on conflict (user_id) do update set timezone = ${timezone}`);
		res.json({ saved: true });
	}));

	// ---- workspace ----
	app.get(['/api/pages/workspace', '/api/pages/dashboard/workspace'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const { workspaceId, workspace } = await mustWorkspace(database, userRow, req, 'workspace.read');
		const owner = rowsOf(await database.execute(sql`select id, name, email from "user" where id = ${workspace.owner_user_id ?? workspace.ownerUserId ?? ''} limit 1`))[0] ?? null;
		const counts = rowsOf(await database.execute(sql`select (select count(*)::int from project where workspace_id = ${workspaceId} and status != 'suspended') as projects, (select count(*)::int from workspace_member where workspace_id = ${workspaceId}) as members`))[0] ?? {};
		const members = rowsOf(await database.execute(sql`select m.user_id, u.name, u.email from workspace_member m inner join "user" u on u.id = m.user_id where m.workspace_id = ${workspaceId} and m.status = 'active'`));
		res.json({ workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug, status: workspace.status, ownerUserId: workspace.owner_user_id ?? workspace.ownerUserId ?? null }, owner, isOwner: userRow.id === (workspace.owner_user_id ?? workspace.ownerUserId), projectCount: num(counts.projects), memberCount: num(counts.members), members });
	}));
	async function workspaceMutation(database, userRow, req, res, fn) {
		const { workspace } = await mustWorkspace(database, userRow, req, 'workspace.write');
		return fn(workspace);
	}
	for (const [action, mutate] of [
		['rename', async (database, userRow, req, res, ws) => {
			const name = String(okBody(req).name ?? '').trim();
			if (!name) return fail(res, 400, 'Workspace name is required');
			await database.execute(sql`update workspace set name = ${name}, updated_at = now() where id = ${ws.id}`);
			await audit(database, { actorUserId: userRow.id, action: 'workspace.update', resource: 'workspace', resourceId: ws.id, workspaceId: ws.id, before: { name: ws.name }, after: { name } });
			return res.json({ renamed: name });
		}],
		['archive', async (database, userRow, req, res, ws) => {
			await database.execute(sql`update workspace set status = 'archived', updated_at = now() where id = ${ws.id}`);
			await audit(database, { actorUserId: userRow.id, action: 'workspace.archive', resource: 'workspace', resourceId: ws.id, workspaceId: ws.id });
			return res.json({ archived: true });
		}],
		['restore', async (database, userRow, req, res, ws) => {
			await database.execute(sql`update workspace set status = 'active', updated_at = now() where id = ${ws.id}`);
			await audit(database, { actorUserId: userRow.id, action: 'workspace.restore', resource: 'workspace', resourceId: ws.id, workspaceId: ws.id });
			return res.json({ restored: true });
		}]
	]) {
		app.post([`/api/pages/workspace/${action}`, `/api/pages/dashboard/workspace/${action}`], wrap(async (req, res) => {
			const database = needDb(res);
			if (!database) return;
			const userRow = await mustAuth(req);
			await workspaceMutation(database, userRow, req, res, (ws) => mutate(database, userRow, req, res, ws));
		}));
	}
	app.post(['/api/pages/workspace/switch', '/api/pages/dashboard/workspace/switch'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const targetId = String(okBody(req).workspaceId ?? okBody(req).id ?? '').trim();
		const m = rowsOf(await database.execute(sql`select id from workspace_member where workspace_id = ${targetId} and user_id = ${userRow.id} and status = 'active' limit 1`))[0];
		if (!m) return fail(res, 403, 'Not a member of that workspace');
		// httpOnly + secure: deployment is behind a cloudflared tunnel at
		// https://ai.karepmuwes.my.id, so these only ever travel over HTTPS.
		res.cookie('fwid', targetId, { path: '/', maxAge: 31536000000, sameSite: 'lax', httpOnly: true, secure: true });
		res.clearCookie('fpid', { path: '/', httpOnly: true, secure: true });
		res.clearCookie('feid', { path: '/', httpOnly: true, secure: true });
		res.json({ switched: targetId });
	}));

	// ---- team ----
	app.get(['/api/pages/team', '/api/pages/dashboard/team'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const { workspaceId } = await mustWorkspace(database, userRow, req, 'member.read');
		const mc = rowsOf(await database.execute(sql`select count(*)::int as n from workspace_member where workspace_id = ${workspaceId}`))[0];
		const roles = rowsOf(await database.execute(sql`select r.name, count(*)::int as count from workspace_member m inner join workspace_role r on r.id = m.role_id where m.workspace_id = ${workspaceId} group by r.name order by count(*) desc, r.name`));
		res.json({ memberCount: num(mc?.n), roles });
	}));
	app.get(['/api/pages/team/members', '/api/pages/dashboard/team/members'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const { workspaceId, workspace } = await mustWorkspace(database, userRow, req, 'member.read');
		const members = rowsOf(
			await database.execute(sql`select m.id, m.user_id, u.name, u.email, m.role_id, r.name as role_name, m.status, m.created_at from workspace_member m inner join "user" u on u.id = m.user_id inner join workspace_role r on r.id = m.role_id where m.workspace_id = ${workspaceId} order by m.created_at asc`)
		).map((m) => ({ id: m.id, userId: m.user_id, name: m.name, email: m.email, roleId: m.role_id, role: m.role_name, roleName: m.role_name, status: m.status, createdAt: iso(m.created_at) }));
		const roles = rowsOf(await database.execute(sql`select id, name, workspace_id from workspace_role where workspace_id is null or workspace_id = ${workspaceId} order by name`));
		res.json({ members, roles, ownerUserId: workspace.owner_user_id ?? workspace.ownerUserId ?? null });
	}));
	app.post(['/api/pages/team/members/invite', '/api/pages/dashboard/team/members/invite'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const { workspaceId, workspace } = await mustWorkspace(database, userRow, req, 'member.invite');
		const b = okBody(req);
		const email = String(b.email ?? '').trim().toLowerCase();
		const roleId = String(b.roleId ?? b.role ?? '').trim();
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, 400, 'Enter a valid email address');
		const role = rowsOf(await database.execute(sql`select id, name, permissions from workspace_role where id = ${roleId} and (workspace_id is null or workspace_id = ${workspaceId}) limit 1`))[0];
		if (!role) return fail(res, 400, 'Pick a role for the new member');
		// The same rule changeRole enforces, and it was missing here, which made
		// this route its bypass. The role lookup above admits the builtin owner
		// template (`rol_owner` has workspace_id IS NULL) and any custom role, and
		// the insert below then trusted roleId with no dominance check — so a
		// holder of `member.invite` who does NOT hold `workspace.write` (the
		// builtin `admin`) could invite an address they control straight into the
		// owner role, or into a custom role carrying permissions they do not have.
		// Granting on the invite path what the change-role path refuses is not a
		// lesser hole: it is the same escalation with one extra step.
		const ownerId = workspace.owner_user_id ?? workspace.ownerUserId ?? null;
		const isOwner = ownerId !== null && userRow.id === ownerId;
		const targetIsOwner = role.id === 'rol_owner' || String(role.name ?? '').toLowerCase() === 'owner';
		if (targetIsOwner && !isOwner) return fail(res, 403, 'Only the workspace owner can grant the owner role');
		if (!isOwner) {
			const actor = rowsOf(await database.execute(sql`select r.permissions from workspace_member m inner join workspace_role r on r.id = m.role_id where m.workspace_id = ${workspaceId} and m.user_id = ${userRow.id} limit 1`))[0];
			const held = new Set(Array.isArray(actor?.permissions) ? actor.permissions.filter((p) => typeof p === 'string') : []);
			const wanted = Array.isArray(role.permissions) ? role.permissions.filter((p) => typeof p === 'string') : [];
			if (wanted.some((p) => !held.has(p))) return fail(res, 403, 'You cannot grant permissions you do not hold');
		}
		const existingUser = rowsOf(await database.execute(sql`select id from "user" where email = ${email} limit 1`))[0];
		const token = randomBytes(32).toString('base64url');
		const identifier = 'invite:' + createHash('sha256').update(token).digest('hex');
		const payload = JSON.stringify({ email, workspaceId, roleId, invitedBy: userRow.id, name: email.split('@')[0] });
		if (existingUser) {
			const already = rowsOf(await database.execute(sql`select id from workspace_member where workspace_id = ${workspaceId} and user_id = ${existingUser.id} limit 1`))[0];
			if (already) return fail(res, 400, 'That person is already a member');
			await database.execute(sql`insert into workspace_member (id, workspace_id, user_id, role_id, status, invited_by) values (${newId(ID_PREFIXES.workspaceMember)}, ${workspaceId}, ${existingUser.id}, ${roleId}, 'active', ${userRow.id}) on conflict (workspace_id, user_id) do update set role_id = ${roleId}, status = 'active'`);
			await audit(database, { actorUserId: userRow.id, action: 'member.invite', resource: 'workspace_member', workspaceId, metadata: { email, roleId } });
			return res.json({ invited: email });
		}
		const id = newId(ID_PREFIXES.verification);
		await database.execute(sql`insert into verification (id, identifier, value, expires_at, created_at, updated_at) values (${id}, ${identifier}, ${payload}, now() + interval '7 days', now(), now())`);
		await audit(database, { actorUserId: userRow.id, action: 'member.invite', resource: 'workspace_member', workspaceId, metadata: { email, roleId } });
		res.json({ invited: email, invitedLink: `/invite/${token}` });
	}));
	app.post(['/api/pages/team/members/changeRole', '/api/pages/dashboard/team/members/changeRole'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const { workspace } = await mustWorkspace(database, userRow, req, 'workspace.write');
		const b = okBody(req);
		const memberId = String(b.memberId ?? b.id ?? '').trim();
		const roleId = String(b.roleId ?? b.role ?? '').trim();
		const member = rowsOf(await database.execute(sql`select id, user_id, role_id from workspace_member where id = ${memberId} and workspace_id = ${workspace.id} limit 1`))[0];
		if (!member) return fail(res, 404, 'Member not found');
		if (member.user_id === (workspace.owner_user_id ?? workspace.ownerUserId)) return fail(res, 403, "The workspace owner's role cannot be changed");
		const role = rowsOf(await database.execute(sql`select id, name, permissions from workspace_role where id = ${roleId} and (workspace_id is null or workspace_id = ${workspace.id}) limit 1`))[0];
		if (!role) return fail(res, 400, 'Unknown role');
		// No dominance check existed here: any holder of `workspace.write` (the
		// builtin `admin` role) could grant itself `owner` and gain
		// `workspace.delete`. The owner role is grantable only by the owner,
		// and no one may grant permissions they do not hold themselves.
		const ownerId = workspace.owner_user_id ?? workspace.ownerUserId;
		const isOwner = userRow.id === ownerId;
		const targetIsOwner = role.id === 'rol_owner' || String(role.name ?? '').toLowerCase() === 'owner';
		if (targetIsOwner && !isOwner) return fail(res, 403, 'Only the workspace owner can grant the owner role');
		if (!isOwner) {
			const actor = rowsOf(await database.execute(sql`select r.permissions from workspace_member m inner join workspace_role r on r.id = m.role_id where m.workspace_id = ${workspace.id} and m.user_id = ${userRow.id} limit 1`))[0];
			const held = new Set(Array.isArray(actor?.permissions) ? actor.permissions.filter((p) => typeof p === 'string') : []);
			const wanted = Array.isArray(role.permissions) ? role.permissions.filter((p) => typeof p === 'string') : [];
			if (wanted.some((p) => !held.has(p))) return fail(res, 403, 'You cannot grant permissions you do not hold');
		}
		await database.execute(sql`update workspace_member set role_id = ${roleId}, updated_at = now() where id = ${member.id}`);
		res.json({ changed: member.id });
	}));
	app.post(['/api/pages/team/members/remove', '/api/pages/dashboard/team/members/remove'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const { workspace } = await mustWorkspace(database, userRow, req, 'member.remove');
		const b = okBody(req);
		const memberId = String(b.memberId ?? b.id ?? '').trim();
		const member = rowsOf(await database.execute(sql`select m.id, m.user_id, u.name from workspace_member m inner join "user" u on u.id = m.user_id where m.id = ${memberId} and m.workspace_id = ${workspace.id} limit 1`))[0];
		if (!member) return fail(res, 404, 'Member not found');
		if (member.user_id === (workspace.owner_user_id ?? workspace.ownerUserId)) return fail(res, 403, 'The workspace owner cannot be removed — transfer ownership first');
		if (String(b.confirm ?? '').trim() !== member.name) return fail(res, 400, `Type the member's name "${member.name}" exactly to confirm removal`);
		await database.execute(sql`delete from workspace_member where id = ${member.id}`);
		res.json({ removed: member.id });
	}));
	app.get(['/api/pages/team/invitations', '/api/pages/dashboard/team/invitations'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const { workspaceId } = await mustWorkspace(database, userRow, req, 'member.read');
		const rows = rowsOf(await database.execute(sql`select id, identifier, value, expires_at from verification where identifier like 'invite:%' and expires_at > now()`));
		const invites = [];
		for (const row of rows) {
			try {
				const p = JSON.parse(row.value);
				if (p && p.workspaceId === workspaceId) invites.push({ id: row.id, identifier: row.identifier, email: p.email, name: p.name, roleId: p.roleId, expiresAt: iso(row.expires_at), invitedBy: p.invitedBy });
			} catch { /* skip */ }
		}
		const roles = rowsOf(await database.execute(sql`select id, name from workspace_role where workspace_id is null or workspace_id = ${workspaceId} order by name`));
		res.json({ invitations: invites, invites, roles });
	}));
	app.post(['/api/pages/team/invitations/revoke', '/api/pages/dashboard/team/invitations/revoke'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const { workspaceId } = await mustWorkspace(database, userRow, req, 'member.invite');
		const b = okBody(req);
		const ref = String(b.identifier ?? b.id ?? '').trim();
		if (!ref) return fail(res, 400, 'Missing invitation');
		const row = rowsOf(await database.execute(sql`select id, identifier, value from verification where (identifier = ${ref} or id = ${ref}) and expires_at > now() limit 1`))[0];
		if (!row) return fail(res, 404, 'Invitation not found');
		let payload = null;
		try { payload = JSON.parse(row.value); } catch { /* noop */ }
		if (!payload || payload.workspaceId !== workspaceId) return fail(res, 404, 'Invitation not found');
		await database.execute(sql`delete from verification where id = ${row.id}`);
		await audit(database, { actorUserId: userRow.id, action: 'member.invite_revoke', resource: 'workspace_member', workspaceId, metadata: { email: payload.email } });
		res.json({ revoked: payload.email });
	}));
	app.get(['/api/pages/team/roles', '/api/pages/dashboard/team/roles'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const { workspaceId } = await mustWorkspace(database, userRow, req, 'member.read');
		const roles = rowsOf(await database.execute(sql`select r.id, r.name, r.workspace_id, r.permissions, r.created_at, (select count(*)::int from workspace_member m where m.role_id = r.id and m.workspace_id = ${workspaceId}) as member_count from workspace_role r where r.workspace_id is null or r.workspace_id = ${workspaceId} order by r.created_at`))
			.map((r) => ({ id: r.id, name: r.name, custom: r.workspace_id !== null, permissions: r.permissions ?? [], memberCount: num(r.member_count) }));
		res.json({ roles });
	}));
	app.post(['/api/pages/team/roles/create', '/api/pages/dashboard/team/roles/create'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const { workspaceId } = await mustWorkspace(database, userRow, req, 'workspace.write');
		const b = okBody(req);
		const name = String(b.name ?? '').trim();
		if (!name) return fail(res, 400, 'Role name is required');
		const permissions = Array.isArray(b.permissions) ? b.permissions.filter((p) => typeof p === 'string') : [];
		const dup = rowsOf(await database.execute(sql`select name from workspace_role where (workspace_id is null or workspace_id = ${workspaceId}) and name = ${name} limit 1`))[0];
		if (dup) return fail(res, 400, `A role named "${name}" already exists`);
		const id = newId(ID_PREFIXES.workspaceRole);
		await database.execute(sql`insert into workspace_role (id, workspace_id, name, permissions) values (${id}, ${workspaceId}, ${name}, ${JSON.stringify(permissions)}::jsonb)`);
		res.json({ created: name, id });
	}));

	// ---- projects ----
	app.get(['/api/pages/projects', '/api/pages/dashboard/projects'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const { workspaceId } = await mustWorkspace(database, userRow, req, 'project.read');
		const projects = rowsOf(await database.execute(sql`select id, name, slug, description, status, created_at from project where workspace_id = ${workspaceId} order by created_at desc`))
			.map((p) => ({ ...p, createdAt: iso(p.created_at) }));
		res.json({ projects });
	}));
	app.post(['/api/pages/projects/create', '/api/pages/dashboard/projects/create'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const { workspaceId } = await mustWorkspace(database, userRow, req, 'project.write');
		const b = okBody(req);
		const name = String(b.name ?? '').trim();
		if (!name) return fail(res, 400, 'Project name is required');
		const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
		let slug = base;
		for (let n = 2; ; n++) {
			const taken = rowsOf(await database.execute(sql`select id from project where workspace_id = ${workspaceId} and slug = ${slug} limit 1`))[0];
			if (!taken) break;
			slug = `${base}-${n}`;
		}
		const id = newId(ID_PREFIXES.project);
		await database.execute(sql`insert into project (id, workspace_id, name, slug, description) values (${id}, ${workspaceId}, ${name}, ${slug}, ${String(b.description ?? '').trim() || null})`);
		for (const e of [{ name: 'Development', slug: 'development', type: 'development' }, { name: 'Staging', slug: 'staging', type: 'production' }, { name: 'Production', slug: 'production', type: 'production' }]) {
			await database.execute(sql`insert into environment (id, project_id, name, slug, type) values (${newId(ID_PREFIXES.environment)}, ${id}, ${e.name}, ${e.slug}, ${e.type})`);
		}
		await audit(database, { actorUserId: userRow.id, action: 'project.create', resource: 'project', resourceId: id, workspaceId, after: { name, slug } });
		res.json({ created: id, id, slug });
	}));
	async function projectAction(database, userRow, req, res, perm, fn) {
		const { workspaceId } = await mustWorkspace(database, userRow, req, perm);
		const projectId = req.params.projectId;
		const proj = await scopedProject(database, projectId, workspaceId);
		return fn(workspaceId, proj);
	}
	app.get('/api/pages/projects/:projectId', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const { workspaceId } = await mustWorkspace(database, userRow, req, 'project.read');
		const proj = await scopedProject(database, req.params.projectId, workspaceId);
		const envs = rowsOf(await database.execute(sql`select id, name, slug, type, status from environment where project_id = ${proj.id} order by created_at asc`));
		const counts = rowsOf(await database.execute(sql`select environment_id, count(*)::int as count from api_key where project_id = ${proj.id} and coalesce(policy->>'playground','') <> 'true' group by environment_id`));
		const keyCountByEnv = new Map(counts.map((c) => [c.environment_id, num(c.count)]));
		res.json({ project: { ...proj, createdAt: iso(proj.created_at), updatedAt: iso(proj.updated_at) }, environments: envs.map((e) => ({ ...e, keyCount: keyCountByEnv.get(e.id) ?? 0 })), statuses: ['active', 'archived', 'suspended'] });
	}));
	app.post('/api/pages/projects/:projectId/update', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		await projectAction(database, userRow, req, res, 'project.write', async (workspaceId, proj) => {
			const b = okBody(req);
			const name = String(b.name ?? proj.name).trim();
			const status = String(b.status ?? proj.status).trim();
			if (!name) return fail(res, 400, 'Project name is required');
			if (!['active', 'archived', 'suspended'].includes(status)) return fail(res, 400, 'Invalid project status');
			const slugInput = String(b.slug ?? '').trim();
			const slug = slugInput || slugifyName(name) || proj.slug;
			if (slug !== proj.slug) {
				const taken = rowsOf(await database.execute(sql`select id from project where workspace_id = ${workspaceId} and slug = ${slug} limit 1`))[0];
				if (taken) return fail(res, 400, `Slug "${slug}" is already used by another project`);
			}
			const description = String(b.description ?? '').trim() || null;
			const before = { name: proj.name, slug: proj.slug, description: proj.description, status: proj.status };
			const after = { name, slug, description, status };
			await database.execute(sql`update project set name = ${name}, slug = ${slug}, description = ${description}, status = ${status}, updated_at = now() where id = ${proj.id}`);
			await audit(database, { actorUserId: userRow.id, action: 'project.update', resource: 'project', resourceId: proj.id, workspaceId, before, after });
			return res.json({ saved: true });
		});
	}));
	app.post('/api/pages/projects/:projectId/archive', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		await projectAction(database, userRow, req, res, 'project.write', async (workspaceId, proj) => {
			await database.execute(sql`update project set status = 'archived', updated_at = now() where id = ${proj.id}`);
			await audit(database, { actorUserId: userRow.id, action: 'project.archive', resource: 'project', resourceId: proj.id, workspaceId, before: { status: proj.status }, after: { status: 'archived' } });
			return res.json({ archived: proj.name });
		});
	}));
	app.post('/api/pages/projects/:projectId/restore', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		await projectAction(database, userRow, req, res, 'project.write', async (workspaceId, proj) => {
			await database.execute(sql`update project set status = 'active', updated_at = now() where id = ${proj.id}`);
			await audit(database, { actorUserId: userRow.id, action: 'project.restore', resource: 'project', resourceId: proj.id, workspaceId, before: { status: proj.status }, after: { status: 'active' } });
			return res.json({ restored: proj.name });
		});
	}));
	app.post('/api/pages/projects/:projectId/switch', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		await projectAction(database, userRow, req, res, 'project.write', async (workspaceId, proj) => {
			const env = rowsOf(await database.execute(sql`select id from environment where project_id = ${proj.id} order by created_at asc limit 1`))[0];
			res.cookie('fpid', proj.id, { path: '/', maxAge: 31536000000, sameSite: 'lax', httpOnly: true, secure: true });
			if (env) res.cookie('feid', env.id, { path: '/', maxAge: 31536000000, sameSite: 'lax', httpOnly: true, secure: true });
			else res.clearCookie('feid', { path: '/', httpOnly: true, secure: true });
			return res.json({ switched: proj.id });
		});
	}));
	app.post('/api/pages/projects/:projectId/delete', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		await projectAction(database, userRow, req, res, 'project.delete', async (workspaceId, proj) => {
			const b = okBody(req);
			const confirm = String(b.confirm ?? '').trim();
			if (confirm !== proj.name) return fail(res, 400, `Type the project name "${proj.name}" exactly to confirm deletion`);
			const kc = rowsOf(await database.execute(sql`select count(*)::int as n from api_key where project_id = ${proj.id}`))[0];
			const keyCount = num(kc?.n);
			const force = b.force === true || b.force === 'true' || b.force === 'on' || b.force === 'force' || b.force === 1;
			if (keyCount > 0 && !force) return fail(res, 400, `Project still has API keys — ${keyCount} key(s) would be deleted with it. Remove them first, or tick "force" to delete them too.`);
			await audit(database, { actorUserId: userRow.id, action: 'project.delete', resource: 'project', resourceId: proj.id, workspaceId, before: { name: proj.name, slug: proj.slug, description: proj.description, status: proj.status }, metadata: { forced: Boolean(force), keyCount } });
			await database.execute(sql`delete from project where id = ${proj.id}`);
			return res.json({ deleted: proj.name });
		});
	}));
	// project keys
	app.get('/api/pages/projects/:projectId/keys', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		await projectAction(database, userRow, req, res, 'key.read', async (workspaceId, proj) => {
			const envs = rowsOf(await database.execute(sql`select id, name, status from environment where project_id = ${proj.id} order by created_at desc`));
			const keys = rowsOf(
				await database.execute(sql`select id, name, prefix, status, environment_id, created_at, last_used_at, expires_at from api_key where project_id = ${proj.id} and workspace_id = ${workspaceId} and coalesce(policy->>'playground','') <> 'true' order by created_at desc`)
			).map((k) => ({ ...k, environmentName: envs.find((e) => e.id === k.environment_id)?.name ?? null, createdAt: iso(k.created_at), lastUsedAt: iso(k.last_used_at), expiresAt: iso(k.expires_at) }));
			return res.json({ projectId: proj.id, projectName: proj.name, environments: envs, keys });
		});
	}));
	app.post('/api/pages/projects/:projectId/keys/create', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		await projectAction(database, userRow, req, res, 'key.create', async (workspaceId, proj) => {
			const b = okBody(req);
			const name = String(b.name ?? '').trim();
			if (!name) return fail(res, 400, 'Key name is required');
			const envId = String(b.environmentId ?? '').trim();
			const env = rowsOf(await database.execute(sql`select id from environment where id = ${envId} and project_id = ${proj.id} limit 1`))[0];
			if (!env) return fail(res, 400, 'Pick an environment of this project');
			const expiresRaw = String(b.expiresAt ?? b.expires_at ?? '').trim();
			let expiresAt = null;
			if (expiresRaw) {
				expiresAt = /^\d{4}-\d{2}-\d{2}$/.test(expiresRaw) ? new Date(`${expiresRaw}T00:00:00.000Z`) : new Date(expiresRaw);
				if (Number.isNaN(expiresAt.getTime())) return fail(res, 400, 'Expiration is not a date');
			}
			const parsed = policyFromForm(b);
			if (!parsed.ok) return fail(res, 400, parsed.error);
			const { key, prefix, keyHash } = generateApiKey();
			const id = newId(ID_PREFIXES.apiKey);
			await database.execute(sql`insert into api_key (id, workspace_id, project_id, environment_id, user_id, name, prefix, key_hash, policy, expires_at, status) values (${id}, ${workspaceId}, ${proj.id}, ${env.id}, ${userRow.id}, ${name}, ${prefix}, ${keyHash}, ${JSON.stringify(parsed.policy)}::jsonb, ${expiresAt ? expiresAt.toISOString() : null}, 'active')`);
			await audit(database, { actorUserId: userRow.id, action: 'key.create', resource: 'api_key', resourceId: id, workspaceId, metadata: { name, prefix, environmentId: env.id } });
			return res.json({ created: key, name, id });
		});
	}));
	for (const st of ['enable', 'disable']) {
		app.post(`/api/pages/projects/:projectId/keys/${st}`, wrap(async (req, res) => {
			const database = needDb(res);
			if (!database) return;
			const userRow = await mustAuth(req);
			await projectAction(database, userRow, req, res, 'key.revoke', async (workspaceId, proj) => {
				const id = String(okBody(req).id ?? '').trim();
				if (!id) return fail(res, 400, 'Missing key id');
				const row = rowsOf(await database.execute(sql`select id, name, status from api_key where id = ${id} and project_id = ${proj.id} and workspace_id = ${workspaceId} limit 1`))[0];
				if (!row) return fail(res, 404, 'Key not found');
				const next = st === 'enable' ? 'active' : 'disabled';
				// Ownership predicate repeated on the UPDATE, not just the lookup —
				// same hole the alerts/update comment documents: an UPDATE anchored
				// only by primary key lets a member rewrite another project's key
				// between the two statements.
				await database.execute(sql`update api_key set status = ${next}, updated_at = now() where id = ${row.id} and project_id = ${proj.id} and workspace_id = ${workspaceId}`);
				await audit(database, { actorUserId: userRow.id, action: st === 'enable' ? 'key.enable' : 'key.disable', resource: 'api_key', resourceId: row.id, workspaceId, before: { status: row.status }, after: { status: next } });
				return res.json({ [st === 'enable' ? 'enabled' : 'disabled']: row.name });
			});
		}));
	}
	// project limits
	app.get('/api/pages/projects/:projectId/limits', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		await projectAction(database, userRow, req, res, 'limit.read', async (workspaceId, proj) => {
			const str = (v) => (v === null || v === undefined ? '' : String(v));
			const noLimits = () => ({ rpm: null, tpm: null, rpd: null, tpd: null, concurrency: null, dailySpendMicro: null, monthlySpendMicro: null });
			const valuesOf = (r) => r ? { rpm: r.rpm, tpm: r.tpm, rpd: r.rpd, tpd: r.tpd, concurrency: r.concurrency, dailySpendMicro: r.daily_spend_micro, monthlySpendMicro: r.monthly_spend_micro } : { ...noLimits() };
			const view = (v) => ({ rpm: v.rpm == null ? '' : String(v.rpm), tpm: v.tpm == null ? '' : String(v.tpm), rpd: v.rpd == null ? '' : String(v.rpd), tpd: v.tpd == null ? '' : String(v.tpd), concurrency: v.concurrency == null ? '' : String(v.concurrency), dailySpendMicro: v.dailySpendMicro == null ? '' : microsToInput(v.dailySpendMicro), monthlySpendMicro: v.monthlySpendMicro == null ? '' : microsToInput(v.monthlySpendMicro) });
			const editorView = (scope, scopeId, label, row) => ({ scope, scopeId, label, row: row ? { id: row.id, values: view(valuesOf(row)) } : null });
			try {
				const envs = rowsOf(await database.execute(sql`select id, name from environment where project_id = ${proj.id} order by name asc`));
				const keys = rowsOf(await database.execute(sql`select id, name, prefix from api_key where project_id = ${proj.id} order by name asc`));
				let hard = null;
				try {
					const hrow = rowsOf(await database.execute(sql`select value from system_setting where key = 'platform_hard_limits' limit 1`))[0];
					const hv = hrow?.value;
					hard = typeof hv === 'string' ? JSON.parse(hv) : hv;
				} catch { hard = null; }
				const rows = rowsOf(await database.execute(sql`select * from rate_limit where scope in ('workspace','project','environment','api_key')`));
				const envIds = new Set(envs.map((e) => e.id));
				const keyIds = new Set(keys.map((k) => k.id));
				const workspaceRow = rows.find((r) => r.scope === 'workspace' && r.scope_id === workspaceId) ?? null;
				const projectRow = rows.find((r) => r.scope === 'project' && r.scope_id === proj.id) ?? null;
				const envRows = rows.filter((r) => r.scope === 'environment' && envIds.has(r.scope_id));
				const keyLimitRows = rows.filter((r) => r.scope === 'api_key' && keyIds.has(r.scope_id));
				const platformValues = hard ? { ...noLimits(), rpm: hard.rpm ?? null, tpm: hard.tpm ?? null, concurrency: hard.concurrency ?? null } : { ...noLimits() };
				const tightest = (vals) => {
					const out = { ...noLimits() };
					for (const v of vals) {
						for (const m of LIMIT_METRICS) {
							const value = v[m];
							if (value == null) continue;
							const cur = out[m];
							const isSpend = m === 'dailySpendMicro' || m === 'monthlySpendMicro';
							const nv = isSpend ? BigInt(String(value)) : Number(value);
							const cv = cur == null ? null : (isSpend ? BigInt(String(cur)) : Number(cur));
							if (cv === null || nv <= cv) out[m] = value;
						}
					}
					return out;
				};
				const chainLevels = [
					{ level: 'platform', values: platformValues },
					{ level: 'workspace', values: valuesOf(workspaceRow) },
					{ level: 'project', values: valuesOf(projectRow) },
					{ level: 'environment', values: tightest(envRows.map(valuesOf)) },
					{ level: 'api_key', values: tightest(keyLimitRows.map(valuesOf)) }
				];
				const chain = LIMIT_METRICS.map((metric) => {
					const isSpend = metric === 'dailySpendMicro' || metric === 'monthlySpendMicro';
					const fmt = (v) => (v == null ? null : (isSpend ? microsToInput(v) : String(v)));
					let effective = null, boundAt = null;
					const byLevel = {};
					for (const { level, values } of chainLevels) {
						const value = values[metric];
						byLevel[level] = fmt(value);
						if (value == null) continue;
						if (effective === null) { effective = value; boundAt = level; continue; }
						const nv = isSpend ? BigInt(String(value)) : Number(value);
						const ev = isSpend ? BigInt(String(effective)) : Number(effective);
						if (nv <= ev) { effective = value; boundAt = level; }
					}
					return { metric, label: LIMIT_LABELS[metric], spend: isSpend, effective: fmt(effective), boundAt, boundAtLabel: boundAt ? LIMIT_LEVEL_LABELS[boundAt] : null, byLevel };
				});
				return res.json({ denied: false, queryError: null, projectId: proj.id, projectName: proj.name, labels: LIMIT_LABELS, levelLabels: LIMIT_LEVEL_LABELS, chain,
					editors: [editorView('workspace', workspaceId, 'Workspace (all projects)', workspaceRow), editorView('project', proj.id, `${proj.name} (project)`, projectRow), ...envs.map((e) => editorView('environment', e.id, `${e.name} (environment)`, envRows.find((r) => r.scope_id === e.id) ?? null))],
					keyRows: keys.map((k) => ({ id: k.id, name: k.name ?? k.prefix ?? k.id, values: view(valuesOf(keyLimitRows.find((r) => r.scope_id === k.id) ?? null)) })) });
			} catch (err) {
				console.error('[pages] limits load failed', err);
				return res.json({ denied: false, queryError: 'The limits could not be read.', projectId: proj.id, projectName: proj.name, labels: LIMIT_LABELS, levelLabels: LIMIT_LEVEL_LABELS, chain: [], editors: [], keyRows: [] });
			}
		});
	}));
	app.post('/api/pages/projects/:projectId/limits/save', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		await projectAction(database, userRow, req, res, 'limit.write', async (workspaceId, proj) => {
			const b = okBody(req);
			const scope = String(b.scope ?? 'project');
			const scopeId = String(b.scopeId ?? (scope === 'workspace' ? workspaceId : proj.id));
			if (scope === 'environment') {
				const env = rowsOf(await database.execute(sql`select id from environment where id = ${scopeId} and project_id = ${proj.id} limit 1`))[0];
				if (!env) return fail(res, 400, 'Unknown scope for this project');
			} else if (!((scope === 'workspace' && scopeId === workspaceId) || (scope === 'project' && scopeId === proj.id))) return fail(res, 400, 'Unknown scope for this project');
			const intOrNull = (v) => {
				const s = String(v ?? '').trim();
				if (!s) return null;
				if (!/^\d{1,12}$/.test(s)) return undefined;
				return Number(s);
			};
			const vals = {};
			for (const k of ['rpm', 'tpm', 'rpd', 'tpd', 'concurrency']) {
				const p = intOrNull(b[k]);
				if (p === undefined) return fail(res, 400, `${k} must be a whole number`);
				vals[k] = p;
			}
			for (const [k, label] of [['dailySpendMicro', 'Daily spend'], ['monthlySpendMicro', 'Monthly spend']]) {
				const s = String(b[k] ?? '').trim();
				if (!s) { vals[k] = null; continue; }
				const m = parseAmountToMicro(s);
				if (m === null) return fail(res, 400, `${label} must be a plain amount like 12.50`);
				vals[k] = m.toString();
			}
			const ex = rowsOf(await database.execute(sql`select id from rate_limit where scope = ${scope} and scope_id = ${scopeId} limit 1`))[0];
			const id = ex?.id ?? newId(prefixFor(ctx, 'rateLimit'));
			await database.execute(sql`insert into rate_limit (id, scope, scope_id, rpm, tpm, rpd, tpd, concurrency, daily_spend_micro, monthly_spend_micro) values (${id}, ${scope}, ${scopeId}, ${vals.rpm}, ${vals.tpm}, ${vals.rpd}, ${vals.tpd}, ${vals.concurrency}, ${vals.dailySpendMicro}, ${vals.monthlySpendMicro}) on conflict (scope, scope_id) do update set rpm = ${vals.rpm}, tpm = ${vals.tpm}, rpd = ${vals.rpd}, tpd = ${vals.tpd}, concurrency = ${vals.concurrency}, daily_spend_micro = ${vals.dailySpendMicro}, monthly_spend_micro = ${vals.monthlySpendMicro}, updated_at = now()`);
			await audit(database, { actorUserId: userRow.id, action: ex ? 'limit.update' : 'limit.create', resource: 'rate_limit', resourceId: id, workspaceId, after: { scope, scopeId, rpm: vals.rpm, tpm: vals.tpm, rpd: vals.rpd, tpd: vals.tpd, concurrency: vals.concurrency, dailySpendMicro: vals.dailySpendMicro, monthlySpendMicro: vals.monthlySpendMicro } });
			return res.json({ saved: id });
		});
	}));
	app.post('/api/pages/projects/:projectId/limits/remove', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		await projectAction(database, userRow, req, res, 'limit.write', async (workspaceId, proj) => {
			const b = okBody(req);
			const scope = String(b.scope ?? '');
			const scopeId = String(b.scopeId ?? '').trim();
			let okScope = (scope === 'workspace' && scopeId === workspaceId) || (scope === 'project' && scopeId === proj.id);
			if (!okScope && scope === 'environment') {
				const env = rowsOf(await database.execute(sql`select id from environment where id = ${scopeId} and project_id = ${proj.id} limit 1`))[0];
				okScope = Boolean(env);
			}
			if (!okScope) return fail(res, 400, 'Unknown scope for this project');
			const row = rowsOf(await database.execute(sql`select id, scope, scope_id from rate_limit where scope = ${scope} and scope_id = ${scopeId} limit 1`))[0];
			if (!row) return fail(res, 404, 'Limit row not found');
			await database.execute(sql`delete from rate_limit where id = ${row.id}`);
			await audit(database, { actorUserId: userRow.id, action: 'limit.delete', resource: 'rate_limit', resourceId: row.id, workspaceId, before: { scope: row.scope, scopeId: row.scope_id } });
			return res.json({ removed: row.id });
		});
	}));
	// project routing
	app.get('/api/pages/projects/:projectId/routing', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		await projectAction(database, userRow, req, res, 'routing.read', async (workspaceId, proj) => {
			const envs = rowsOf(await database.execute(sql`select id, name, routing_policy_id from environment where project_id = ${proj.id} order by created_at asc`));
			const envIds = envs.map((e) => e.id);
			let policies = [];
			try {
				policies = envIds.length
					? rowsOf(await database.execute(sql`select id, name, strategy, enabled, max_attempts, request_timeout_ms, fallback_enabled, workspace_id, project_id, environment_id, provider_preferences, model_preferences, constraints, weights from routing_policy where project_id = ${proj.id} or (workspace_id = ${workspaceId} and project_id is null) or environment_id in (${sql.join(envIds, sql`, `)}) order by name asc`))
					: rowsOf(await database.execute(sql`select id, name, strategy, enabled, max_attempts, request_timeout_ms, fallback_enabled, workspace_id, project_id, environment_id, provider_preferences, model_preferences, constraints, weights from routing_policy where project_id = ${proj.id} or (workspace_id = ${workspaceId} and project_id is null) order by name asc`));
			} catch { policies = []; }
			let providers = [], models = [];
			try {
				providers = rowsOf(await database.execute(sql`select slug, name from provider where slug is not null order by slug asc`));
				models = rowsOf(await database.execute(sql`select slug, name from model where slug is not null order by slug asc`));
			} catch { providers = []; models = []; }
			const byId = new Map(policies.map((p) => [p.id, p.name]));
			return res.json({ project: { id: proj.id, name: proj.name, slug: proj.slug }, policies: policies.map((p) => ({ id: p.id, name: p.name, strategy: p.strategy, enabled: p.enabled, maxAttempts: p.max_attempts, requestTimeoutMs: p.request_timeout_ms, fallbackEnabled: p.fallback_enabled, scope: p.environment_id ? 'environment' : p.project_id ? 'project' : 'workspace', providerPreferences: p.provider_preferences ?? { order: [] }, modelPreferences: p.model_preferences ?? { order: [] }, constraints: p.constraints ?? {}, weights: p.weights ?? {}, boundEnvironments: envs.filter((e) => e.routing_policy_id === p.id).map((e) => e.name) })), bindings: envs.map((e) => ({ environmentId: e.id, environmentName: e.name, policyId: e.routing_policy_id, policyName: e.routing_policy_id ? (byId.get(e.routing_policy_id) ?? null) : null })), strategies: ROUTING_STRATEGIES, providers, models });
		});
	}));
	app.post('/api/pages/projects/:projectId/routing/create', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		await projectAction(database, userRow, req, res, 'routing.write', async (workspaceId, proj) => {
			const b = okBody(req);
			const parsed = parsePolicyFormBody(b);
			if (!parsed.ok) return fail(res, 400, parsed.error);
			const scopeRaw = String(b.scope ?? 'project');
			if (scopeRaw !== 'project' && scopeRaw !== 'workspace') return fail(res, 400, 'Scope must be project or workspace');
			const scope = scopeRaw;
			const v = parsed.values;
			const hit = rowsOf(await database.execute(scope === 'project'
				? sql`select id from routing_policy where project_id = ${proj.id} and environment_id is null and name = ${v.name} limit 1`
				: sql`select id from routing_policy where workspace_id = ${workspaceId} and project_id is null and environment_id is null and name = ${v.name} limit 1`))[0];
			if (hit) return fail(res, 409, `A policy named "${v.name}" already exists in this ${scope}.`);
			const id = newId(prefixFor(ctx, 'routingPolicy'));
			await database.execute(sql`insert into routing_policy (id, workspace_id, project_id, environment_id, name, strategy, enabled, max_attempts, request_timeout_ms, fallback_enabled, provider_preferences, model_preferences, constraints, weights) values (${id}, ${workspaceId}, ${scope === 'project' ? proj.id : null}, null, ${v.name}, ${v.strategy}, ${v.enabled}, ${v.maxAttempts}, ${v.requestTimeoutMs}, ${v.fallbackEnabled}, ${JSON.stringify(v.providerPreferences)}::jsonb, ${JSON.stringify(v.modelPreferences)}::jsonb, ${JSON.stringify(v.constraints)}::jsonb, ${JSON.stringify(v.weights)}::jsonb)`);
			await audit(database, { actorUserId: userRow.id, action: 'routing.create', resource: 'routing_policy', resourceId: id, workspaceId, after: { name: v.name, strategy: v.strategy, enabled: v.enabled, maxAttempts: v.maxAttempts, requestTimeoutMs: v.requestTimeoutMs, fallbackEnabled: v.fallbackEnabled, providerPreferences: v.providerPreferences, modelPreferences: v.modelPreferences, constraints: v.constraints, weights: v.weights, scope } });
			return res.json({ created: v.name, id });
		});
	}));
	app.post('/api/pages/projects/:projectId/routing/update', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		await projectAction(database, userRow, req, res, 'routing.write', async (workspaceId, proj) => {
			const b = okBody(req);
			const id = String(b.id ?? '').trim();
			if (!id) return fail(res, 400, 'Missing policy id');
			const envIds = rowsOf(await database.execute(sql`select id from environment where project_id = ${proj.id}`)).map((e) => e.id);
			// The ownership fragment branches on envIds because an empty list
			// would render `environment_id in ()` — a syntax error, not a no-op.
			const owned = envIds.length
				? sql`(project_id = ${proj.id} or (workspace_id = ${workspaceId} and project_id is null) or environment_id in (${sql.join(envIds, sql`, `)}))`
				: sql`(project_id = ${proj.id} or (workspace_id = ${workspaceId} and project_id is null))`;
			const existing = rowsOf(await database.execute(sql`select id, name, strategy, enabled, max_attempts, request_timeout_ms, fallback_enabled, workspace_id, project_id, environment_id, provider_preferences, model_preferences, constraints, weights from routing_policy where id = ${id} and ${owned} limit 1`))[0];
			if (!existing) return fail(res, 404, 'Policy not found');
			const parsed = parsePolicyFormBody(b);
			if (!parsed.ok) return fail(res, 400, parsed.error);
			const scopeRaw = String(b.scope ?? (existing.environment_id ? 'environment' : existing.project_id ? 'project' : 'workspace'));
			if (scopeRaw !== 'project' && scopeRaw !== 'workspace' && scopeRaw !== 'environment') return fail(res, 400, 'Scope must be project or workspace');
			if (scopeRaw === 'environment' && !existing.environment_id) return fail(res, 400, 'Scope must be project or workspace');
			const scope = scopeRaw;
			const environmentId = scope === 'environment' ? existing.environment_id : null;
			const v = parsed.values;
			const hit = rowsOf(await database.execute(scope === 'project'
				? sql`select id from routing_policy where project_id = ${proj.id} and environment_id is null and name = ${v.name} and id <> ${id} limit 1`
				: scope === 'workspace'
					? sql`select id from routing_policy where workspace_id = ${workspaceId} and project_id is null and environment_id is null and name = ${v.name} and id <> ${id} limit 1`
					: sql`select id from routing_policy where environment_id = ${environmentId} and name = ${v.name} and id <> ${id} limit 1`))[0];
			if (hit) return fail(res, 409, `A policy named "${v.name}" already exists in this ${scope}.`);
			const before = { name: existing.name, strategy: existing.strategy, enabled: existing.enabled, maxAttempts: existing.max_attempts, requestTimeoutMs: existing.request_timeout_ms, fallbackEnabled: existing.fallback_enabled, providerPreferences: existing.provider_preferences, modelPreferences: existing.model_preferences, constraints: existing.constraints, weights: existing.weights, scope: existing.environment_id ? 'environment' : existing.project_id ? 'project' : 'workspace' };
			const after = { name: v.name, strategy: v.strategy, enabled: v.enabled, maxAttempts: v.maxAttempts, requestTimeoutMs: v.requestTimeoutMs, fallbackEnabled: v.fallbackEnabled, providerPreferences: v.providerPreferences, modelPreferences: v.modelPreferences, constraints: v.constraints, weights: v.weights, scope };
			// Ownership predicate repeated on the UPDATE, not just the lookup —
			// same hole the alerts/update comment documents: the row could change
			// between the two statements, and an UPDATE anchored only by primary
			// key lets a member rewrite another workspace's policy.
			const updated = rowsOf(await database.execute(sql`update routing_policy set workspace_id = ${workspaceId}, project_id = ${scope === 'project' ? proj.id : null}, environment_id = ${environmentId}, name = ${v.name}, strategy = ${v.strategy}, enabled = ${v.enabled}, max_attempts = ${v.maxAttempts}, request_timeout_ms = ${v.requestTimeoutMs}, fallback_enabled = ${v.fallbackEnabled}, provider_preferences = ${JSON.stringify(v.providerPreferences)}::jsonb, model_preferences = ${JSON.stringify(v.modelPreferences)}::jsonb, constraints = ${JSON.stringify(v.constraints)}::jsonb, weights = ${JSON.stringify(v.weights)}::jsonb, updated_at = now() where id = ${id} and ${owned} returning id`));
			if (!updated.length) return fail(res, 404, 'Policy not found');
			await audit(database, { actorUserId: userRow.id, action: 'routing.update', resource: 'routing_policy', resourceId: id, workspaceId, before, after });
			return res.json({ updated: v.name });
		});
	}));
	app.post('/api/pages/projects/:projectId/routing/delete', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		await projectAction(database, userRow, req, res, 'routing.write', async (workspaceId, proj) => {
			const id = String(okBody(req).id ?? '').trim();
			if (!id) return fail(res, 400, 'Missing policy id');
			const envIds = rowsOf(await database.execute(sql`select id from environment where project_id = ${proj.id}`)).map((e) => e.id);
			// The ownership fragment branches on envIds because an empty list
			// would render `environment_id in ()` — a syntax error, not a no-op.
			const owned = envIds.length
				? sql`(project_id = ${proj.id} or (workspace_id = ${workspaceId} and project_id is null) or environment_id in (${sql.join(envIds, sql`, `)}))`
				: sql`(project_id = ${proj.id} or (workspace_id = ${workspaceId} and project_id is null))`;
			const existing = rowsOf(await database.execute(sql`select id, name, strategy, enabled, max_attempts, request_timeout_ms, fallback_enabled, workspace_id, project_id, environment_id, provider_preferences, model_preferences, constraints, weights from routing_policy where id = ${id} and ${owned} limit 1`))[0];
			if (!existing) return fail(res, 404, 'Policy not found');
			const bound = rowsOf(await database.execute(sql`select name from environment where routing_policy_id = ${id}`)).map((r) => r.name);
			const before = { name: existing.name, strategy: existing.strategy, enabled: existing.enabled, maxAttempts: existing.max_attempts, requestTimeoutMs: existing.request_timeout_ms, fallbackEnabled: existing.fallback_enabled, providerPreferences: existing.provider_preferences, modelPreferences: existing.model_preferences, constraints: existing.constraints, weights: existing.weights, scope: existing.environment_id ? 'environment' : existing.project_id ? 'project' : 'workspace', unboundEnvironments: bound };
			// Ownership predicate repeated on the DELETE, not just the lookup —
			// same hole the alerts/remove comment documents: a delete anchored
			// only by primary key is the same ownership hole one statement later.
			const deleted = rowsOf(await database.execute(sql`delete from routing_policy where id = ${id} and ${owned} returning id`));
			if (!deleted.length) return fail(res, 404, 'Policy not found');
			await audit(database, { actorUserId: userRow.id, action: 'routing.delete', resource: 'routing_policy', resourceId: id, workspaceId, before });
			return res.json({ deleted: existing.name });
		});
	}));
	// project requests
	app.get('/api/pages/projects/:projectId/requests', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		await projectAction(database, userRow, req, res, 'request.read', async (workspaceId, proj) => {
			try {
				const q = req.query ?? {};
				const str = (k) => { const v = q[k]; return v == null ? '' : String(v); };
				const numOrNull = (k) => { const s = str(k).trim(); if (!s) return null; const n = Number(s); return Number.isFinite(n) && n >= 0 ? n : null; };
				const bigOrNull = (k) => { const s = str(k).trim(); if (!s) return null; try { const n = BigInt(s); return n >= 0n ? n : null; } catch { return null; } };
				const dateOrNull = (k, endOfDay) => {
					const s = str(k).trim();
					if (!s) return null;
					if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
						const d = new Date(`${s}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
						return Number.isNaN(d.getTime()) ? null : d;
					}
					const d = new Date(s);
					return Number.isNaN(d.getTime()) ? null : d;
				};
				const f = { from: dateOrNull('from', false), to: dateOrNull('to', true), status: str('status').trim() || null, model: str('model').trim() || null, provider: str('provider').trim() || null, apiKey: str('key').trim() || null, environment: str('env').trim() || null, endpoint: str('endpoint').trim() || null, requestId: str('requestId').trim() || null, minLatencyMs: numOrNull('minLatency'), maxLatencyMs: numOrNull('maxLatency'), minCostMicro: bigOrNull('minCost'), maxCostMicro: bigOrNull('maxCost') };
				// Keyset cursor: base64url("<ISO>|<id>"); bad cursor falls back to first page.
				let after = null;
				const cursorRaw = str('cursor').trim();
				if (cursorRaw) {
					try {
						const text = Buffer.from(cursorRaw, 'base64url').toString('utf8');
						const bar = text.indexOf('|');
						if (bar >= 0) {
							const when = new Date(text.slice(0, bar));
							const cid = text.slice(bar + 1);
							if (cid && !Number.isNaN(when.getTime())) after = { createdAt: when, id: cid };
						}
					} catch { after = null; }
				}
				const conds = [sql`r.project_id = ${proj.id}`];
				if (f.from) conds.push(sql`r.created_at >= ${f.from.toISOString()}`);
				if (f.to) conds.push(sql`r.created_at <= ${f.to.toISOString()}`);
				if (f.status) conds.push(sql`r.status in (${sql.join(statusFilterValues(normalizeStatus(f.status)), sql`, `)})`);
				if (f.model) conds.push(sql`r.requested_model = ${f.model}`);
				if (f.provider) conds.push(sql`r.provider_id = ${f.provider}`);
				if (f.apiKey) conds.push(sql`r.api_key_id = ${f.apiKey}`);
				if (f.environment) conds.push(sql`r.environment_id = ${f.environment}`);
				if (f.endpoint) conds.push(sql`r.endpoint = ${f.endpoint}`);
				if (f.requestId) conds.push(sql`r.id = ${f.requestId}`);
				if (f.minLatencyMs != null) conds.push(sql`r.latency_ms >= ${f.minLatencyMs}`);
				if (f.maxLatencyMs != null) conds.push(sql`r.latency_ms <= ${f.maxLatencyMs}`);
				if (f.minCostMicro != null) conds.push(sql`r.cost >= ${f.minCostMicro.toString()}`);
				if (f.maxCostMicro != null) conds.push(sql`r.cost <= ${f.maxCostMicro.toString()}`);
				if (after) conds.push(sql`(r.created_at < ${after.createdAt.toISOString()} or (r.created_at = ${after.createdAt.toISOString()} and r.id < ${after.id}))`);
				const where = sql.join(conds, sql` and `);
				const pageRows = rowsOf(
					await database.execute(sql`select r.id, r.created_at, r.status, r.requested_model, r.latency_ms, r.ttft_ms, r.tokens_in, r.tokens_out, r.total_tokens, r.cost, r.currency, r.http_status, r.attempts, r.fallback_used, r.client_ip, m.slug as model_slug, pr.name as provider_name, k.name as key_name, k.prefix as key_prefix from request_log r left join model m on m.id = r.model_id left join provider pr on pr.id = r.provider_id left join api_key k on k.id = r.api_key_id where ${where} order by r.created_at desc, r.id desc limit 26`)
				);
				const page = pageRows.slice(0, 25);
				const tail = page[page.length - 1];
				const nextCursor = (pageRows.length > 25 && tail) ? Buffer.from(`${new Date(tail.created_at).toISOString()}|${tail.id}`, 'utf8').toString('base64url') : null;
				const rows = page.map((r) => {
					const norm = normalizeStatus(r.status);
					return { id: r.id, createdAt: iso(r.created_at), status: norm, storedStatus: r.status, tone: statusTone(norm), requestedModel: r.requested_model, modelSlug: r.model_slug, providerName: r.provider_name, latencyMs: r.latency_ms, ttftMs: r.ttft_ms, tokensIn: num(r.tokens_in), tokensOut: num(r.tokens_out), totalTokens: r.total_tokens == null ? num(r.tokens_in) + num(r.tokens_out) : num(r.total_tokens), costMicro: String(r.cost ?? '0'), currency: r.currency, keyName: r.key_name, keyPrefix: r.key_prefix, clientIp: r.client_ip == null ? null : String(r.client_ip), httpStatus: r.http_status, attempts: r.attempts, fallbackUsed: r.fallback_used };
				});
				const echo = {};
				const put = (k, v) => { if (v == null || v === '') return; echo[k] = v instanceof Date ? v.toISOString() : String(v); };
				put('from', f.from); put('to', f.to); put('status', f.status); put('model', f.model); put('provider', f.provider); put('key', f.apiKey); put('env', f.environment); put('endpoint', f.endpoint); put('requestId', f.requestId); put('minLatency', f.minLatencyMs); put('maxLatency', f.maxLatencyMs); put('minCost', f.minCostMicro); put('maxCost', f.maxCostMicro);
				let options = { models: [], providers: [], keys: [], environments: [], endpoints: [] };
				try {
					const [mRows, pRows, kRows, eRows, epRows] = await Promise.all([
						database.execute(sql`select distinct requested_model as value from request_log where project_id = ${proj.id} and requested_model is not null order by requested_model`),
						database.execute(sql`select distinct r.provider_id as id, pr.name as name from request_log r left join provider pr on pr.id = r.provider_id where r.project_id = ${proj.id} and r.provider_id is not null`),
						database.execute(sql`select distinct r.api_key_id as id, k.name as name, k.prefix as prefix from request_log r left join api_key k on k.id = r.api_key_id where r.project_id = ${proj.id} and r.api_key_id is not null`),
						database.execute(sql`select id, name from environment where project_id = ${proj.id} order by name asc`),
						database.execute(sql`select distinct endpoint as value from request_log where project_id = ${proj.id} and endpoint is not null order by endpoint`)
					]);
					options = { models: rowsOf(mRows).map((r) => r.value ?? ''), providers: rowsOf(pRows), keys: rowsOf(kRows).filter((k) => k.id), environments: rowsOf(eRows), endpoints: rowsOf(epRows).map((r) => r.value ?? '') };
				} catch { /* options stay empty */ }
				const kept = new URLSearchParams();
				for (const [k, v] of Object.entries(echo)) kept.set(k, v);
				const nextQuery = new URLSearchParams(kept);
				if (nextCursor) nextQuery.set('cursor', nextCursor);
				return res.json({ denied: false, queryError: null, projectId: proj.id, projectName: proj.name, filters: echo, statuses: REQUEST_STATUSES, options, rows, nextCursor, nextHref: nextCursor ? `?${nextQuery}` : null });
			} catch (err) {
				console.error('[pages] requests load failed', err);
				return res.json({ denied: false, queryError: 'The request log could not be read.', projectId: proj.id, projectName: proj.name, filters: {}, statuses: REQUEST_STATUSES, options: { models: [], providers: [], keys: [], environments: [], endpoints: [] }, rows: [], nextCursor: null, nextHref: null });
			}
		});
	}));
	// project settings (= update form data)
	app.get('/api/pages/projects/:projectId/settings', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const { workspaceId } = await mustWorkspace(database, userRow, req, 'project.read');
		const proj = await scopedProject(database, req.params.projectId, workspaceId);
		res.json({ project: { ...proj, createdAt: iso(proj.created_at), updatedAt: iso(proj.updated_at) }, statuses: ['active', 'archived', 'suspended'] });
	}));

	// ---- connect (client onboarding, read-only) ----
	app.get(['/api/pages/connect', '/api/pages/dashboard/connect'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const { workspaceId } = await mustWorkspace(database, userRow, req, 'workspace.read');
		const models = rowsOf(
			await database.execute(sql`select slug, name, developer from model where status = 'active' order by slug asc`)
		).map((m) => ({ slug: m.slug, name: m.name, developer: m.developer }));
		const aliases = rowsOf(
			await database.execute(sql`select name, description from model_alias where enabled = true and (workspace_id is null or (workspace_id = ${workspaceId} and project_id is null)) order by name asc`)
		);
		const ordered = aliases.filter((a) => !String(a.name).startsWith('fudrouter/')).concat(aliases.filter((a) => String(a.name).startsWith('fudrouter/')));
		const keys = rowsOf(
			await database.execute(sql`select id, name, prefix from api_key where user_id = ${userRow.id} and status = 'active' and revoked_at is null order by created_at asc`)
		);
		const baseUrl = String(process.env.PUBLIC_API_BASE_URL || process.env.ROUTER_BASE_URL || 'http://127.0.0.1:8100').replace(/\/+$/, '');
		res.json({ models, aliases: ordered, keys, baseUrl });
	}));
	// ---- workspace playground (picker data; runs go through /api/playground/stream) ----
	async function playgroundPicker(database, userRow, workspaceId, projectId) {
		const models = rowsOf(
			await database.execute(sql`select id, slug, name, status, developer from model where status <> 'disabled' order by slug asc`)
		);
		const aliases = projectId
			? rowsOf(await database.execute(sql`select id, name, description from model_alias where project_id = ${projectId} or (workspace_id = ${workspaceId} and project_id is null) or workspace_id is null order by name asc`))
			: rowsOf(await database.execute(sql`select id, name, description from model_alias where (workspace_id = ${workspaceId} and project_id is null) or workspace_id is null order by name asc`));
		const ordered = aliases.filter((a) => !String(a.name).startsWith('fudrouter/')).concat(aliases.filter((a) => String(a.name).startsWith('fudrouter/')));
		const keys = projectId
			? rowsOf(await database.execute(sql`select id, name from api_key where user_id = ${userRow.id} and status = 'active' and revoked_at is null and (project_id = ${projectId} or project_id is null) order by created_at asc`))
			: rowsOf(await database.execute(sql`select id, name from api_key where user_id = ${userRow.id} and status = 'active' and revoked_at is null order by created_at asc`));
		return { models, aliases: ordered, keys };
	}
	app.get(['/api/pages/playground', '/api/pages/dashboard/playground'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const { workspaceId } = await mustWorkspace(database, userRow, req, 'key.create');
		res.json(await playgroundPicker(database, userRow, workspaceId, null));
	}));
	app.get('/api/pages/projects/:projectId/playground', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		await projectAction(database, userRow, req, res, 'key.create', async (workspaceId, proj) => {
			return res.json({ project: { id: proj.id, name: proj.name }, ...(await playgroundPicker(database, userRow, workspaceId, proj.id)) });
		});
	}));
	// ---- project alerts ----
	const ALERT_TYPES = ['error_rate', 'latency', 'budget_threshold', 'credit_threshold', 'fallback_rate', 'provider_availability', 'unusual_key_traffic'];
	const ALERT_CHANNELS = ['inapp', 'email', 'webhook'];
	function alertView(a) {
		const cond = (a.condition && typeof a.condition === 'object') ? a.condition : {};
		if (typeof cond === 'string') { try { Object.assign(cond, JSON.parse(cond)); } catch { /* keep */ } }
		const c = (typeof cond === 'object' && cond) ? cond : {};
		return { id: a.id, name: a.name, enabled: a.enabled ?? true, channel: a.channel ?? 'inapp', condition: { type: c.type ?? 'error_rate', threshold: Number(c.threshold ?? 0), windowSeconds: c.window_seconds ?? 300, baselineRate: c.baseline_rate ?? null }, createdAt: iso(a.created_at), updatedAt: iso(a.updated_at) };
	}
	function parseAlertBody(b) {
		const name = String(b.name ?? '').trim();
		if (!name) return { ok: false, error: 'Name is required' };
		if (name.length > 120) return { ok: false, error: 'Name is too long' };
		const type = String(b.type ?? '');
		if (!ALERT_TYPES.includes(type)) return { ok: false, error: 'Pick a condition' };
		const threshold = Number(String(b.threshold ?? '').trim());
		if (!Number.isFinite(threshold) || threshold < 0) return { ok: false, error: 'Threshold must be a number at or above zero' };
		const condition = { type, threshold };
		const wRaw = String(b.windowSeconds ?? '').trim();
		if (wRaw) {
			if (!/^\d{1,6}$/.test(wRaw) || Number(wRaw) < 1) return { ok: false, error: 'Window must be a whole number of seconds' };
			condition.window_seconds = Number(wRaw);
		}
		const blRaw = String(b.baselineRate ?? '').trim();
		if (blRaw) {
			const bl = Number(blRaw);
			if (!Number.isFinite(bl) || bl < 0) return { ok: false, error: 'Baseline rate must be a number at or above zero' };
			condition.baseline_rate = bl;
		}
		const channel = String(b.channel ?? 'inapp');
		if (!ALERT_CHANNELS.includes(channel)) return { ok: false, error: 'Channel must be inapp, email or webhook' };
		const enabled = b.enabled === 'on' || b.enabled === true || b.enabled === 'true';
		return { ok: true, value: { name, channel, enabled, condition } };
	}
	app.get('/api/pages/projects/:projectId/alerts', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		await projectAction(database, userRow, req, res, 'alert.read', async (workspaceId, proj) => {
			const rows = rowsOf(await database.execute(sql`select * from alert where workspace_id = ${workspaceId} and project_id = ${proj.id} order by created_at desc`));
			const wsRows = rowsOf(await database.execute(sql`select * from alert where workspace_id = ${workspaceId} and project_id is null order by created_at desc`));
			const events = rowsOf(await database.execute(sql`select e.id, e.alert_id, a.name as alert_name, e.triggered_at, e.value, e.message, e.state, e.resolved_at, e.delivered_at from alert_event e inner join alert a on a.id = e.alert_id where a.workspace_id = ${workspaceId} and a.project_id = ${proj.id} order by e.triggered_at desc limit 50`))
				.map((e) => ({ id: e.id, alertId: e.alert_id, alertName: e.alert_name, triggeredAt: iso(e.triggered_at), value: String(e.value ?? ''), message: e.message, state: e.state, resolvedAt: iso(e.resolved_at), deliveredAt: iso(e.delivered_at) }));
			return res.json({ denied: false, queryError: null, projectId: proj.id, projectName: proj.name, conditionTypes: ALERT_TYPES, channels: ALERT_CHANNELS, alerts: rows.map(alertView), workspaceAlerts: wsRows.map(alertView), events });
		});
	}));
	app.post('/api/pages/projects/:projectId/alerts/create', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		await projectAction(database, userRow, req, res, 'alert.write', async (workspaceId, proj) => {
			const parsed = parseAlertBody(okBody(req));
			if (!parsed.ok) return fail(res, 400, parsed.error);
			const id = newId('alr_');
			await database.execute(sql`insert into alert (id, workspace_id, project_id, name, condition, channel, enabled) values (${id}, ${workspaceId}, ${proj.id}, ${parsed.value.name}, ${JSON.stringify(parsed.value.condition)}::jsonb, ${parsed.value.channel}, ${parsed.value.enabled})`);
			await audit(database, { actorUserId: userRow.id, action: 'alert.create', resource: 'alert', resourceId: id, workspaceId, after: { name: parsed.value.name, channel: parsed.value.channel } });
			return res.json({ saved: id });
		});
	}));
	app.post('/api/pages/projects/:projectId/alerts/update', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		await projectAction(database, userRow, req, res, 'alert.write', async (workspaceId, proj) => {
			const b = okBody(req);
			const id = String(b.id ?? '').trim();
			if (!id) return fail(res, 400, 'Missing alert id');
			const parsed = parseAlertBody(b);
			if (!parsed.ok) return fail(res, 400, parsed.error);
			const before = rowsOf(await database.execute(sql`select id, name from alert where id = ${id} and project_id = ${proj.id} limit 1`))[0];
			if (!before) return fail(res, 404, 'Alert not found');
			// 3c: the project predicate is repeated on the UPDATE, not just the
			// lookup — same hole the model_alias delete comment below documents:
			// the row could change between the two statements, and an UPDATE
			// anchored only by primary key lets any member with alert.write
			// rewrite another project's alert (the lookup row being theirs proves
			// nothing about the write). Ownership is not implied by "not found
			// elsewhere"; it has to be stated on the write itself.
			const updated = rowsOf(await database.execute(sql`update alert set name = ${parsed.value.name}, condition = ${JSON.stringify(parsed.value.condition)}::jsonb, channel = ${parsed.value.channel}, enabled = ${parsed.value.enabled}, updated_at = now() where id = ${id} and project_id = ${proj.id} and workspace_id = ${workspaceId} returning id`));
			if (!updated.length) return fail(res, 404, 'Alert not found');
			return res.json({ saved: id });
		});
	}));
	app.post('/api/pages/projects/:projectId/alerts/remove', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		await projectAction(database, userRow, req, res, 'alert.write', async (workspaceId, proj) => {
			const id = String(okBody(req).id ?? '').trim();
			if (!id) return fail(res, 400, 'Missing alert id');
			const before = rowsOf(await database.execute(sql`select id, name from alert where id = ${id} and project_id = ${proj.id} limit 1`))[0];
			if (!before) return fail(res, 404, 'Alert not found');
			// 3c: predicate repeated on the DELETE for the same reason as the
			// UPDATE above and the alias-delete comment below — a delete anchored
			// only by primary key is the same ownership hole one statement later.
			const deleted = rowsOf(await database.execute(sql`delete from alert where id = ${id} and project_id = ${proj.id} and workspace_id = ${workspaceId} returning id`));
			if (!deleted.length) return fail(res, 404, 'Alert not found');
			await audit(database, { actorUserId: userRow.id, action: 'alert.delete', resource: 'alert', resourceId: id, workspaceId, before: { name: before.name } });
			return res.json({ removed: id });
		});
	}));
	// ---- project aliases ----
	app.get('/api/pages/projects/:projectId/aliases', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		await projectAction(database, userRow, req, res, 'alias.read', async (workspaceId, proj) => {
			const aliasRows = rowsOf(await database.execute(sql`select id, name, description, enabled, workspace_id, project_id from model_alias where project_id = ${proj.id} or (workspace_id = ${workspaceId} and project_id is null) or workspace_id is null order by name asc`));
			let targetsByAlias = new Map();
			if (aliasRows.length) {
				const ids = aliasRows.map((a) => a.id);
				const joins = rowsOf(await database.execute(sql`select t.alias_id, t.model_id, t.position, m.slug, m.status, m.developer from model_alias_target t inner join model m on m.id = t.model_id where t.alias_id in (${sql.join(ids, sql`, `)}) order by t.alias_id asc, t.position asc`));
				for (const j of joins) {
					const list = targetsByAlias.get(j.alias_id) ?? [];
					list.push({ modelId: j.model_id, slug: j.slug, status: j.status, developer: j.developer, position: j.position });
					targetsByAlias.set(j.alias_id, list);
				}
			}
			const aliases = aliasRows.map((a) => ({ id: a.id, name: a.name, description: a.description, enabled: a.enabled, scope: a.workspace_id === null ? 'global' : a.project_id === null ? 'workspace' : 'project', targets: targetsByAlias.get(a.id) ?? [] }));
			const models = rowsOf(await database.execute(sql`select id, slug, name, status, developer from model where status <> 'disabled' order by slug asc`));
			return res.json({ project: { id: proj.id, name: proj.name, slug: proj.slug }, aliases, models });
		});
	}));
	app.post('/api/pages/projects/:projectId/aliases/create', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		await projectAction(database, userRow, req, res, 'alias.write', async (workspaceId, proj) => {
			const b = okBody(req);
			const name = String(b.name ?? '').trim();
			if (!name) return fail(res, 400, 'Alias name is required');
			const scope = String(b.scope ?? 'project') === 'workspace' ? 'workspace' : 'project';
			const targets = Array.isArray(b.targets) ? b.targets.filter((t) => typeof t === 'string') : [];
			if (!targets.length) return fail(res, 400, 'Pick at least one target model');
			const collision = rowsOf(await database.execute(scope === 'project'
				? sql`select id from model_alias where project_id = ${proj.id} and name = ${name} limit 1`
				: sql`select id from model_alias where workspace_id = ${workspaceId} and project_id is null and name = ${name} limit 1`))[0];
			if (collision) return fail(res, 409, `An alias named "${name}" already exists in this ${scope}.`);
			const known = rowsOf(await database.execute(sql`select id from model where id in (${sql.join(targets, sql`, `)})`));
			if (known.length !== targets.length) return fail(res, 400, 'One or more target models do not exist.');
			const aliasId = newId('als_');
			await database.execute(sql`insert into model_alias (id, workspace_id, project_id, name, description, enabled) values (${aliasId}, ${workspaceId}, ${scope === 'project' ? proj.id : null}, ${name}, ${String(b.description ?? '').trim() || null}, ${b.enabled === false ? false : true})`);
			let pos = 1;
			for (const mid of targets) {
				await database.execute(sql`insert into model_alias_target (alias_id, model_id, position) values (${aliasId}, ${mid}, ${pos})`);
				pos += 1;
			}
			await audit(database, { actorUserId: userRow.id, action: 'alias.create', resource: 'model_alias', resourceId: aliasId, workspaceId, after: { name, scope } });
			return res.json({ created: name, id: aliasId });
		});
	}));
	app.post('/api/pages/projects/:projectId/aliases/delete', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		await projectAction(database, userRow, req, res, 'alias.write', async (workspaceId, proj) => {
			const id = String(okBody(req).id ?? '').trim();
			if (!id) return fail(res, 400, 'Missing alias id');
			const existing = rowsOf(await database.execute(sql`select id, name, workspace_id, project_id from model_alias where id = ${id} limit 1`))[0];
			if (!existing) return fail(res, 404, 'Alias not found');
			if (existing.workspace_id === null) return fail(res, 403, 'Global virtual aliases are read-only.');
			// The missing ownership check. The two guards below it both PASS for
			// another workspace's WORKSPACE-SCOPED alias, because that row has
			// workspace_id set (so the global 403 is skipped) and project_id NULL
			// (so `null !== proj.id && null !== null` is false and the 404 is
			// skipped) — and `id` comes straight from the request body. Any member
			// with alias.write could therefore delete a foreign tenant's aliases,
			// with the audit row filed under their OWN workspaceId so the victim
			// saw nothing. Ownership is not implied by "not global"; it has to be
			// stated.
			if (existing.workspace_id !== workspaceId) return fail(res, 404, 'Alias not found');
			if (existing.project_id !== null && existing.project_id !== proj.id) return fail(res, 404, 'Alias not found');
			// The predicate is repeated on the DELETE, not just the lookup: the
			// row could change between the two statements, and a delete anchored
			// only by primary key is the same hole one statement later.
			await database.execute(sql`delete from model_alias where id = ${id} and workspace_id = ${workspaceId} and (project_id = ${proj.id} or project_id is null)`);
			await audit(database, { actorUserId: userRow.id, action: 'alias.delete', resource: 'model_alias', resourceId: id, workspaceId, before: { name: existing.name } });
			return res.json({ deleted: existing.name });
		});
	}));
	// ---- project analytics ----
	function pickDays(raw) {
		const n = Number(raw);
		return [1, 7, 30, 90].includes(n) ? n : 30;
	}
	app.get('/api/pages/projects/:projectId/analytics', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		await projectAction(database, userRow, req, res, 'analytics.read', async (workspaceId, proj) => {
			const days = pickDays(req.query.days);
			const to = new Date();
			const from = new Date(to.getTime() - days * 86_400_000);
			const lat = rowsOf(await database.execute(sql`select latency_ms from request_log where project_id = ${proj.id} and created_at >= ${from.toISOString()} and created_at < ${to.toISOString()} and latency_ms is not null order by latency_ms asc`)).map((r) => num(r.latency_ms));
			const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))] : null);
			const agg = rowsOf(await database.execute(sql`select count(*)::int as requests, count(*) filter (where status = 'success')::int as ok, coalesce(sum(tokens_in + tokens_out),0)::int as tokens, coalesce(sum(cost),0)::text as cost, coalesce(sum(case when fallback_used then 1 else 0 end),0)::int as fallbacks, avg(ttft_ms)::float as ttft from request_log where project_id = ${proj.id} and created_at >= ${from.toISOString()} and created_at < ${to.toISOString()}`))[0] ?? {};
			const requests = num(agg.requests);
			const ok = num(agg.ok);
			const byProvider = rowsOf(await database.execute(sql`select coalesce(p.name, r.provider_id, 'Unresolved') as label, coalesce(r.provider_id,'') as key, coalesce(sum(r.cost),0)::text as cost from request_log r left join provider p on p.id = r.provider_id where r.project_id = ${proj.id} and r.created_at >= ${from.toISOString()} group by p.name, r.provider_id order by sum(r.cost) desc limit 10`))
				.map((r) => ({ key: r.key, label: r.label || 'Unresolved', costMicro: String(r.cost ?? '0'), providerCostMicro: String(r.cost ?? '0') }));
			const byModel = rowsOf(await database.execute(sql`select coalesce(m.slug, r.requested_model, 'Unresolved') as label, coalesce(r.model_id, r.requested_model, '') as key, coalesce(sum(r.cost),0)::text as cost from request_log r left join model m on m.id = r.model_id where r.project_id = ${proj.id} and r.created_at >= ${from.toISOString()} group by m.slug, r.model_id, r.requested_model order by sum(r.cost) desc limit 10`))
				.map((r) => ({ key: r.key, label: r.label || 'Unresolved', costMicro: String(r.cost ?? '0'), providerCostMicro: String(r.cost ?? '0') }));
			const byEnv = rowsOf(await database.execute(sql`select coalesce(e.name, r.environment_id, 'Unresolved') as label, coalesce(r.environment_id,'') as key, coalesce(sum(r.cost),0)::text as cost from request_log r left join environment e on e.id = r.environment_id where r.project_id = ${proj.id} and r.created_at >= ${from.toISOString()} group by e.name, r.environment_id order by sum(r.cost) desc limit 10`))
				.map((r) => ({ key: r.key, label: r.label || 'Unresolved', costMicro: String(r.cost ?? '0'), providerCostMicro: String(r.cost ?? '0') }));
			const costMicro = String(agg.cost ?? '0');
			const rPct = (n) => Math.round(n * 1000) / 10;
			const sr = requests ? ok / requests : 0;
			return res.json({ denied: false, queryError: null, projectId: proj.id, projectName: proj.name,
				range: { days, from: from.toISOString(), to: to.toISOString(), source: 'raw', latencySource: 'exact' },
				engineering: { requestCount: requests, successCount: ok, errorCount: requests - ok, successRatePct: rPct(sr), errorRatePct: rPct(1 - sr), p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99), ttftMs: agg.ttft == null ? null : Math.round(Number(agg.ttft)), tokensPerSecond: null, fallbackRatePct: rPct(requests ? num(agg.fallbacks) / requests : 0), retryRatePct: 0, providerDistribution: [], modelDistribution: [], p99Unbounded: false },
				cost: { totalSpendMicro: costMicro, costPerRequestMicro: requests ? (big(costMicro) / BigInt(requests)).toString() : '0', costPer1mTokensMicro: num(agg.tokens) ? ((big(costMicro) * 1000000n) / BigInt(num(agg.tokens))).toString() : '0', providerCostMicro: costMicro, markupMicro: '0', creditsMicro: '0', totalTokens: num(agg.tokens), requests, byProvider, byModel, byEnvironment: byEnv, byProject: [{ key: proj.id, label: proj.name, costMicro, providerCostMicro: costMicro }] } });
		});
	}));
	// ---- project budgets ----
	const BUDGET_PERIODS = ['daily', 'weekly', 'monthly'];
	const BUDGET_ACTIONS = ['notify', 'restrict', 'block'];
	function periodStart(period, now) {
		const y = now.getUTCFullYear(), mo = now.getUTCMonth(), d = now.getUTCDate();
		if (period === 'daily') return new Date(Date.UTC(y, mo, d));
		if (period === 'weekly') { const back = (now.getUTCDay() + 6) % 7; return new Date(Date.UTC(y, mo, d - back)); }
		return new Date(Date.UTC(y, mo, 1));
	}
	app.get('/api/pages/projects/:projectId/budgets', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		await projectAction(database, userRow, req, res, 'budget.read', async (workspaceId, proj) => {
			const envs = rowsOf(await database.execute(sql`select id, name from environment where project_id = ${proj.id} order by name asc`));
			const scopeIds = [proj.id, ...envs.map((e) => e.id)];
			const rows = rowsOf(await database.execute(sql`select * from budget where scope_id in (${sql.join(scopeIds, sql`, `)}) or scope_id = ${workspaceId}`));
			const now = new Date();
			const budgets = [];
			for (const b of rows) {
				const wFrom = periodStart(String(b.period), now);
				const scope = b.scope === 'environment'
					? sql`workspace_id = ${workspaceId} and project_id = ${proj.id} and environment_id = ${b.scope_id}`
					: sql`workspace_id = ${workspaceId} and project_id = ${b.scope_id === workspaceId ? null : b.scope_id}`;
				let consumed = 0n;
				try {
					const c = rowsOf(await database.execute(sql`select coalesce(sum(cost),0)::text as total from request_log where created_at >= ${wFrom.toISOString()} and created_at < ${now.toISOString()} and ${scope}`))[0];
					consumed = big(c?.total);
				} catch { consumed = 0n; }
				const amount = big(b.amount_micro);
				const percent = amount <= 0n ? 0 : Number((consumed * 100n) / amount);
				const state = percent >= 100 ? 'exceeded' : percent >= num(b.critical_percent) ? 'critical' : percent >= num(b.warn_percent) ? 'warn' : 'ok';
				const env = envs.find((e) => e.id === b.scope_id);
				budgets.push({ id: b.id, scope: b.scope, scopeLabel: b.scope === 'project' ? `${proj.name} (project)` : b.scope === 'environment' ? `${env?.name ?? b.scope_id} (environment)` : 'Workspace (all projects)', period: b.period, amountMicro: String(b.amount_micro ?? '0'), warnPercent: num(b.warn_percent), criticalPercent: num(b.critical_percent), actionAt100: b.action_at_100, windowFrom: wFrom.toISOString(), windowTo: now.toISOString(), consumedMicro: consumed.toString(), percent, state });
			}
			return res.json({ denied: false, queryError: null, projectId: proj.id, projectName: proj.name, periods: BUDGET_PERIODS, actions: BUDGET_ACTIONS, environments: envs, budgets });
		});
	}));
	app.post('/api/pages/projects/:projectId/budgets/save', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		await projectAction(database, userRow, req, res, 'budget.write', async (workspaceId, proj) => {
			const b = okBody(req);
			const scope = String(b.scope ?? 'project') === 'environment' ? 'environment' : 'project';
			const environmentId = scope === 'environment' ? String(b.environmentId ?? '').trim() : null;
			if (scope === 'environment') {
				if (!environmentId) return fail(res, 400, 'Pick an environment');
				const env = rowsOf(await database.execute(sql`select id from environment where id = ${environmentId} and project_id = ${proj.id} limit 1`))[0];
				if (!env) return fail(res, 400, 'Pick an environment of this project');
			}
			const period = String(b.period ?? '');
			if (!BUDGET_PERIODS.includes(period)) return fail(res, 400, 'Period must be daily, weekly or monthly');
			const amount = parseAmountToMicro(b.amount ?? '');
			if (amount === null || amount <= 0n) return fail(res, 400, 'Amount must be a positive amount like 25.00');
			const pctOf = (name, fb) => { const raw = String(b[name] ?? '').trim(); if (!raw) return fb; if (!/^\d{1,3}$/.test(raw)) return null; const n = Number(raw); return n >= 0 && n <= 100 ? n : null; };
			const warnPercent = pctOf('warnPercent', 70), criticalPercent = pctOf('criticalPercent', 90);
			if (warnPercent == null || criticalPercent == null) return fail(res, 400, 'Warn and critical must be whole percentages 0-100');
			if (criticalPercent < warnPercent) return fail(res, 400, 'Critical must be at or above the warning percentage');
			const actionAt100 = String(b.actionAt100 ?? 'block');
			if (!BUDGET_ACTIONS.includes(actionAt100)) return fail(res, 400, 'Action must be notify, restrict or block');
			const scopeId = scope === 'project' ? proj.id : environmentId;
			const existing = rowsOf(await database.execute(sql`select id from budget where scope = ${scope} and scope_id = ${scopeId} and period = ${period} limit 1`))[0];
			const id = existing?.id ?? newId('bdg_');
			await database.execute(sql`insert into budget (id, scope, scope_id, period, amount_micro, warn_percent, critical_percent, action_at_100) values (${id}, ${scope}, ${scopeId}, ${period}, ${amount.toString()}, ${warnPercent}, ${criticalPercent}, ${actionAt100}) on conflict (scope, scope_id, period) do update set amount_micro = ${amount.toString()}, warn_percent = ${warnPercent}, critical_percent = ${criticalPercent}, action_at_100 = ${actionAt100}, updated_at = now()`);
			await audit(database, { actorUserId: userRow.id, action: existing ? 'budget.update' : 'budget.create', resource: 'budget', resourceId: id, workspaceId, after: { scope, scopeId, period } });
			return res.json({ saved: id });
		});
	}));
	app.post('/api/pages/projects/:projectId/budgets/remove', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		await projectAction(database, userRow, req, res, 'budget.write', async (workspaceId, proj) => {
			const id = String(okBody(req).id ?? '').trim();
			if (!id) return fail(res, 400, 'Missing budget id');
			const envs = rowsOf(await database.execute(sql`select id from environment where project_id = ${proj.id}`)).map((e) => e.id);
			// The workspace branch exists because the budgets GET lists
			// workspace-scoped rows too ("Workspace (all projects)"), so a
			// delete that only accepted project/env scope_ids would 404 on
			// every row that list displayed.
			const owned = sql`(scope_id in (${sql.join([proj.id, ...envs], sql`, `)}) or (scope = 'workspace' and scope_id = ${workspaceId}))`;
			const row = rowsOf(await database.execute(sql`select id from budget where id = ${id} and ${owned} limit 1`))[0];
			if (!row) return fail(res, 404, 'Budget not found');
			// Ownership predicate repeated on the DELETE, not just the lookup —
			// same hole the alerts/remove comment documents: a delete anchored
			// only by primary key is the same ownership hole one statement later.
			const deleted = rowsOf(await database.execute(sql`delete from budget where id = ${id} and ${owned} returning id`));
			if (!deleted.length) return fail(res, 404, 'Budget not found');
			return res.json({ removed: id });
		});
	}));
	// ---- project environments ----
	app.get('/api/pages/projects/:projectId/environments', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		await projectAction(database, userRow, req, res, 'project.read', async (workspaceId, proj) => {
			const envs = rowsOf(await database.execute(sql`select e.id, e.name, e.slug, e.type, e.status, e.routing_policy_id, rp.name as routing_policy_name, e.monthly_budget_micro, l.rpm, l.tpm, l.concurrency from environment e left join routing_policy rp on rp.id = e.routing_policy_id left join rate_limit l on l.scope = 'environment' and l.scope_id = e.id where e.project_id = ${proj.id} order by e.created_at asc`))
				.map((e) => ({ ...e, routingPolicyId: e.routing_policy_id, routingPolicyName: e.routing_policy_name, monthlyBudgetMicro: e.monthly_budget_micro == null ? null : String(e.monthly_budget_micro), budgetInput: e.monthly_budget_micro == null ? '' : String(Number(e.monthly_budget_micro) / 1_000_000) }));
			const policies = rowsOf(await database.execute(sql`select id, name from routing_policy where workspace_id = ${workspaceId} or project_id = ${proj.id} or (workspace_id is null and project_id is null and environment_id is null)`));
			return res.json({ project: { id: proj.id, name: proj.name }, environments: envs, policies });
		});
	}));
	app.post('/api/pages/projects/:projectId/environments/create', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		await projectAction(database, userRow, req, res, 'project.write', async (workspaceId, proj) => {
			const name = String(okBody(req).name ?? '').trim();
			if (!name) return fail(res, 400, 'Environment name is required');
			let slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'environment';
			for (let n = 2; ; n++) {
				const taken = rowsOf(await database.execute(sql`select id from environment where project_id = ${proj.id} and slug = ${slug} limit 1`))[0];
				if (!taken) break;
				slug = `${name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'environment'}-${n}`;
			}
			const id = newId(ID_PREFIXES.environment);
			await database.execute(sql`insert into environment (id, project_id, name, slug, type, status) values (${id}, ${proj.id}, ${name}, ${slug}, 'custom', 'active')`);
			await audit(database, { actorUserId: userRow.id, action: 'environment.create', resource: 'environment', resourceId: id, workspaceId, after: { name, slug } });
			return res.json({ created: name, environmentId: id });
		});
	}));
	// ---- project key detail ----
	app.get('/api/pages/projects/:projectId/keys/:keyId', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		await projectAction(database, userRow, req, res, 'key.read', async (workspaceId, proj) => {
			const key = rowsOf(await database.execute(sql`select id, name, prefix, status, environment_id, policy, created_at, last_used_at, expires_at from api_key where id = ${req.params.keyId} and project_id = ${proj.id} and workspace_id = ${workspaceId} limit 1`))[0];
			if (!key) return fail(res, 404, 'Key not found');
			const env = key.environment_id ? rowsOf(await database.execute(sql`select id, name from environment where id = ${key.environment_id} limit 1`))[0] : null;
			const totals = rowsOf(await database.execute(sql`select count(*)::int as requests, count(*) filter (where status = 'success')::int as successes, coalesce(sum(tokens_in),0)::int as tokens_in, coalesce(sum(tokens_out),0)::int as tokens_out, coalesce(sum(cost),0)::text as cost from request_log where api_key_id = ${key.id}`))[0] ?? {};
			const recent = rowsOf(await database.execute(sql`select id, created_at, requested_model, status, cost from request_log where api_key_id = ${key.id} order by created_at desc limit 10`))
				.map((r) => ({ id: r.id, createdAt: iso(r.created_at), requestedModel: r.requested_model, status: r.status, cost: String(r.cost ?? '0') }));
			return res.json({ projectId: proj.id, projectName: proj.name, key: { ...key, createdAt: iso(key.created_at), lastUsedAt: iso(key.last_used_at), expiresAt: iso(key.expires_at) }, environmentName: env?.name ?? null, totals: { requests: num(totals.requests), successes: num(totals.successes), tokensIn: num(totals.tokens_in), tokensOut: num(totals.tokens_out), cost: String(totals.cost ?? '0') }, recent });
		});
	}));
	for (const kact of ['rotate', 'revoke', 'enable', 'disable']) {
		app.post(`/api/pages/projects/:projectId/keys/:keyId/${kact}`, wrap(async (req, res) => {
			const database = needDb(res);
			if (!database) return;
			const userRow = await mustAuth(req);
			await projectAction(database, userRow, req, res, kact === 'rotate' ? 'key.rotate' : 'key.revoke', async (workspaceId, proj) => {
				const key = rowsOf(await database.execute(sql`select id, name, prefix, status from api_key where id = ${req.params.keyId} and project_id = ${proj.id} and workspace_id = ${workspaceId} limit 1`))[0];
				if (!key) return fail(res, 404, 'Key not found');
				const b = okBody(req);
				const confirm = String(b.confirm ?? b.name ?? '').trim();
				if (confirm && confirm !== key.name) return fail(res, 400, `Type the key's name "${key.name}" exactly to confirm`);
				if (kact === 'rotate') {
					const { key: plaintext, prefix, keyHash } = generateApiKey();
					await database.execute(sql`update api_key set prefix = ${prefix}, key_hash = ${keyHash}, updated_at = now() where id = ${key.id}`);
					await audit(database, { actorUserId: userRow.id, action: 'key.rotate', resource: 'api_key', resourceId: key.id, workspaceId, before: { prefix: key.prefix }, after: { prefix } });
					return res.json({ created: plaintext, name: key.name });
				}
				const next = kact === 'revoke' ? 'revoked' : kact === 'enable' ? 'active' : 'disabled';
				if (kact === 'revoke') await database.execute(sql`update api_key set status = 'revoked', revoked_at = now(), updated_at = now() where id = ${key.id}`);
				else await database.execute(sql`update api_key set status = ${next}, updated_at = now() where id = ${key.id}`);
				await audit(database, { actorUserId: userRow.id, action: `key.${kact}`, resource: 'api_key', resourceId: key.id, workspaceId, before: { status: key.status }, after: { status: next } });
				return res.json({ [kact === 'revoke' ? 'revoked' : kact === 'enable' ? 'enabled' : 'disabled']: key.name });
			});
		}));
	}
	// ---- project request detail ----
	app.get('/api/pages/projects/:projectId/requests/:requestId', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		await projectAction(database, userRow, req, res, 'request.read', async (workspaceId, proj) => {
			const row = rowsOf(await database.execute(sql`select r.*, p.name as project_name, e.name as environment_name, k.name as key_name, k.prefix as key_prefix, m.slug as resolved_slug, pr.name as provider_name from request_log r left join project p on p.id = r.project_id left join environment e on e.id = r.environment_id left join api_key k on k.id = r.api_key_id left join model m on m.id = r.model_id left join provider pr on pr.id = r.provider_id where r.id = ${req.params.requestId} and r.project_id = ${proj.id} limit 1`))[0];
			if (!row) return res.json({ denied: false, project: { id: proj.id, name: proj.name }, row: null, attempts: [], timing: [], content: null });
			const attempts = rowsOf(await database.execute(sql`select a.*, pr.name as provider_name from request_attempt a left join provider pr on pr.id = a.provider_id where a.request_id = ${row.id} order by a.attempt asc`))
				.map((a) => ({ id: a.id, attempt: a.attempt, providerName: a.provider_name, providerId: a.provider_id, connectionId: a.connection_id, httpStatus: a.http_status, errorCode: a.error_code, retryable: a.retryable, latencyMs: a.latency_ms, ttftMs: a.ttft_ms, providerCostMicro: a.provider_cost_micro == null ? null : String(a.provider_cost_micro), reason: a.reason ?? a.error_code, startedAt: iso(a.started_at), finishedAt: iso(a.finished_at) }));
			let timing = [];
			try {
				const t = typeof row.timing === 'string' ? JSON.parse(row.timing) : (row.timing ?? {});
				timing = Object.entries(t).map(([stage, ms]) => ({ stage, ms: num(ms) }));
			} catch { timing = []; }
			return res.json({ denied: false, projectId: proj.id, project: { id: proj.id, name: proj.name },
				row: { id: row.id, createdAt: iso(row.created_at), status: row.status, storedStatus: row.status, endpoint: row.endpoint, projectName: row.project_name, environmentName: row.environment_name, keyName: row.key_name, keyPrefix: row.key_prefix, requestedModel: row.requested_model, resolvedSlug: row.resolved_slug, providerName: row.provider_name, providerId: row.provider_id, strategy: row.strategy, tokensIn: num(row.tokens_in), tokensOut: num(row.tokens_out), totalTokens: row.total_tokens == null ? num(row.tokens_in) + num(row.tokens_out) : num(row.total_tokens), costMicro: String(row.cost ?? '0'), currency: row.currency, providerCostMicro: row.provider_cost_micro == null ? null : String(row.provider_cost_micro), ttftMs: row.ttft_ms, latencyMs: row.latency_ms, attemptsCount: row.attempts, fallbackUsed: row.fallback_used, stream: row.stream, error: row.error, errorCode: row.error_code, httpStatus: row.http_status },
				timing, attempts, content: { state: 'hidden', requestBody: null, responseBody: null } });
		});
	}));
	// ---- invite by token (token IS the credential; member cap only, no workspace perm) ----
	async function lookupInvite(database, token) {
		const identifier = 'invite:' + createHash('sha256').update(String(token)).digest('hex');
		const row = rowsOf(await database.execute(sql`select id, identifier, value, expires_at from verification where identifier = ${identifier} and expires_at > now() limit 1`))[0];
		if (!row) return null;
		let payload = null;
		try { payload = JSON.parse(row.value); } catch { return null; }
		if (!payload || !payload.email || !payload.workspaceId || !payload.roleId) return null;
		return { id: row.id, identifier: row.identifier, expiresAt: row.expires_at, payload };
	}
	app.get('/api/pages/invite/:token', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const invite = await lookupInvite(database, req.params.token);
		if (!invite) return fail(res, 404, 'This invitation is invalid or has expired');
		const context = rowsOf(await database.execute(sql`select w.name as workspace_name, r.name as role_name from workspace w inner join workspace_role r on r.id = ${invite.payload.roleId} where w.id = ${invite.payload.workspaceId} limit 1`))[0];
		if (!context) return fail(res, 404, 'This invitation is invalid or has expired');
		res.json({ invite: { email: invite.payload.email, name: invite.payload.name }, workspaceName: context.workspace_name, roleName: context.role_name, expiresAt: iso(invite.expiresAt) });
	}));
	app.post(['/api/pages/invite/:token/accept', '/api/invite/:token/accept'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const invite = await lookupInvite(database, req.params.token);
		if (!invite) return fail(res, 404, 'This invitation is invalid or has expired');
		if (String(invite.payload.email).toLowerCase() !== String(userRow.email).toLowerCase()) return fail(res, 403, 'This invitation was sent to a different email address');
		const prior = rowsOf(await database.execute(sql`select id from workspace_member where workspace_id = ${invite.payload.workspaceId} and user_id = ${userRow.id} limit 1`))[0];
		if (prior) await database.execute(sql`update workspace_member set role_id = ${invite.payload.roleId}, status = 'active', updated_at = now() where id = ${prior.id}`);
		else await database.execute(sql`insert into workspace_member (id, workspace_id, user_id, role_id, status, invited_by) values (${newId(ID_PREFIXES.workspaceMember)}, ${invite.payload.workspaceId}, ${userRow.id}, ${invite.payload.roleId}, 'active', ${invite.payload.invitedBy})`);
		await database.execute(sql`delete from verification where id = ${invite.id}`);
		await audit(database, { actorUserId: userRow.id, action: 'member.accept', resource: 'workspace_member', workspaceId: invite.payload.workspaceId, metadata: { email: invite.payload.email } });
		// httpOnly + secure: deployment is behind a cloudflared tunnel at
		// https://ai.karepmuwes.my.id, so this only ever travels over HTTPS.
		res.cookie('fwid', invite.payload.workspaceId, { path: '/', maxAge: 31536000000, sameSite: 'lax', httpOnly: true, secure: true });
		res.json({ accepted: invite.payload.workspaceId });
	}));
	app.post(['/api/pages/invite/:token/decline', '/api/invite/:token/decline'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const invite = await lookupInvite(database, req.params.token);
		if (!invite) return fail(res, 404, 'This invitation is invalid or has expired');
		await database.execute(sql`delete from verification where id = ${invite.id}`);
		await audit(database, { actorUserId: userRow.id, action: 'member.decline', resource: 'workspace_member', workspaceId: invite.payload.workspaceId, metadata: { email: invite.payload.email } });
		res.json({ declined: true });
	}));

	async function memberCapsOf(database, userId, workspaceId) {
		try {
			const r = rowsOf(await database.execute(sql`select r.permissions from workspace_member m inner join workspace_role r on r.id = m.role_id where m.workspace_id = ${workspaceId} and m.user_id = ${userId} limit 1`))[0];
			const perms = r?.permissions;
			const list = Array.isArray(perms) ? perms : (typeof perms === 'string' ? JSON.parse(perms) : []);
			return new Set(list);
		} catch {
			return new Set();
		}
	}
}
