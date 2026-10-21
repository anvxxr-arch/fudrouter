import { createHash, randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'drizzle-orm';
import { rowsOf, big, num, iso, okBody } from './lib/validate.mjs';
import { clientIp } from './lib/ip.mjs';

// DB-backed dashboard page loads + POST actions for the member dashboard
// routes. All routes require auth (anon 401).
// Raw SQL is used throughout so real columns work regardless of the minimal
// drizzle table copies in index.mjs.
// The account is the tenant (migration 0019): every route below is scoped to
// the authenticated user's id, and the workspace/project/environment handlers
// were deleted with the tables they queried.
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
const LIMIT_METRICS = ['rpm', 'tpm', 'rpd', 'tpd', 'concurrency', 'dailySpendMicro', 'monthlySpendMicro'];
const LIMIT_LABELS = { rpm: 'Requests per minute', tpm: 'Tokens per minute', rpd: 'Requests per day', tpd: 'Tokens per day', concurrency: 'Concurrent requests', dailySpendMicro: 'Daily spend', monthlySpendMicro: 'Monthly spend' };
// The scope vocabulary is account|api_key (migration 0019); the workspace/
// project/environment labels died with their tables.
const LIMIT_LEVEL_LABELS = { platform: 'Platform default', account: 'Account', api_key: 'API key' };
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
	// The billing account is keyed by user (migration 0019): one per account,
	// provisioned on first read so a user predating the row reads a real one
	// rather than 500ing the page.
	async function billingAccountFor(database, userId) {
		await database.execute(
			sql`insert into billing_account (id, user_id) values (${newId(ID_PREFIXES.billingAccount)}, ${userId}) on conflict (user_id) do nothing`
		);
		const r = rowsOf(
			await database.execute(sql`select * from billing_account where user_id = ${userId} limit 1`)
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
		// Spec §19's four cards need the credit balance, and a firing alert is
		// the one thing on this page a member has to act on, so both ride the
		// same page load rather than a second round trip. The account is the
		// tenant, so the user's own alerts are all of them — no capability gate
		// can hide a panel from its owner.
		const [userRowFull, alertRows, balance] = await Promise.all([
			database.execute(sql`select created_at from "user" where id = ${userRow.id} limit 1`),
			database.execute(sql`select e.id, e.alert_id, a.name as alert_name, a.condition->>'type' as condition_type, e.triggered_at, e.value, e.message, e.state from alert_event e inner join alert a on a.id = e.alert_id where a.account_id = ${userRow.id} and e.state = 'firing' order by e.triggered_at desc limit 10`),
			// The billing page's own helpers, not a second balance query. An
			// account row is provisioned on first read, but a user predating
			// provisioning must read zero here rather than 500 the page.
			billingAccountFor(database, userRow.id).then((a) => ledgerBalance(database, a.id)).catch(() => 0n)
		]);
		const firingAlerts = rowsOf(alertRows).map((e) => ({ id: e.id, alertId: e.alert_id, alertName: e.alert_name, conditionType: String(e.condition_type ?? ''), value: String(e.value ?? ''), message: e.message, triggeredAt: iso(e.triggered_at) }));
		res.json({ totals: { requests: num(totals.requests), tokensIn: num(totals.tokens_in), tokensOut: num(totals.tokens_out), cost: String(totals.cost ?? '0') }, activeKeys: num(kc?.n), recent, series, byModel, range, accountCreatedAt: iso(rowsOf(userRowFull)[0]?.created_at), balanceMicro: balance.toString(), firingAlerts });
	}));

	// ---- account-level keys ----
	app.get(['/api/pages/keys', '/api/pages/dashboard/keys'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const keys = rowsOf(
			await database.execute(sql`select k.id, k.name, k.prefix, k.status, k.last_used_at, k.revoked_at, k.created_at, k.expires_at from api_key k where k.user_id = ${userRow.id} order by k.created_at desc`)
		).map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, status: k.revoked_at ? 'revoked' : (k.status ?? 'active'), lastUsedAt: iso(k.last_used_at), revokedAt: iso(k.revoked_at), createdAt: iso(k.created_at), expiresAt: iso(k.expires_at), usage30d: { requests: 0, tokens: 0, costMicro: '0' } }));
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
		const { key, prefix, keyHash } = generateApiKey();
		const id = newId(ID_PREFIXES.apiKey);
		const expiresAt = expiresIn === 'never' ? null : new Date(Date.now() + KEY_EXPIRY_DAYS[expiresIn] * 86_400_000).toISOString();
		await database.execute(sql`insert into api_key (id, user_id, name, prefix, key_hash, status, expires_at) values (${id}, ${userRow.id}, ${name}, ${prefix}, ${keyHash}, 'active', ${expiresAt})`);
		await audit(database, { actorUserId: userRow.id, action: 'key.create', resource: 'api_key', resourceId: id, metadata: { name, prefix, expiresAt } });
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

	// ---- usage (account, 30d default) ----
	app.get(['/api/pages/usage', '/api/pages/dashboard/usage'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const days = [1, 7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
		const to = new Date();
		const from = new Date(to.getTime() - days * 86_400_000);
		// Optional facet filters, shared by the summary and the log endpoint.
		// Every predicate is a parameterised sql fragment — never concatenated.
		const model = String(req.query.model ?? '').trim().slice(0, 200);
		const provider = String(req.query.provider ?? '').trim().slice(0, 200);
		const key = String(req.query.key ?? '').trim().slice(0, 200);
		const status = String(req.query.status ?? '').trim();
		const conds = [sql`r.user_id = ${userRow.id}`, sql`r.created_at >= ${from.toISOString()}`, sql`r.created_at < ${to.toISOString()}`];
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
		const facetWhere = sql.join([sql`r.user_id = ${userRow.id}`, sql`r.created_at >= ${from.toISOString()}`, sql`r.created_at < ${to.toISOString()}`], sql` and `);
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
		res.json({ denied: false, range: { days, from: from.toISOString(), to: to.toISOString(), source: 'raw' }, totals: { requests: num(totals.requests), tokensIn: num(totals.tokens_in), tokensOut: num(totals.tokens_out), costMicro: String(totals.cost ?? '0') }, latency: { p50: num(latency.p50), p95: num(latency.p95), p99: num(latency.p99) }, breakdowns: { byDay, byApiKey, byModel, byProvider }, errorsByDay, latencyByDay, facets });
	}));

	// ---- usage request log (account, paged) ----
	app.get(['/api/pages/usage/requests', '/api/pages/dashboard/usage/requests'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const days = [1, 7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
		const to = new Date();
		const from = new Date(to.getTime() - days * 86_400_000);
		const model = String(req.query.model ?? '').trim().slice(0, 200);
		const provider = String(req.query.provider ?? '').trim().slice(0, 200);
		const key = String(req.query.key ?? '').trim().slice(0, 200);
		const status = String(req.query.status ?? '').trim();
		const conds = [sql`r.user_id = ${userRow.id}`, sql`r.created_at >= ${from.toISOString()}`, sql`r.created_at < ${to.toISOString()}`];
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
			await database.execute(sql`select r.id, r.created_at, r.requested_model, m.slug as model_slug, p.name as provider_name, r.attempts, r.fallback_used, r.tokens_in, r.tokens_out, r.cost, r.latency_ms, r.ttft_ms, r.status, r.error_code from request_log r left join model m on m.id = r.model_id left join provider p on p.id = r.provider_id where ${where} order by r.created_at desc, r.id desc limit 50 offset ${(page - 1) * 50}`)
		).map((r) => ({ id: r.id, createdAt: iso(r.created_at), requestedModel: r.requested_model, modelSlug: r.model_slug, providerName: r.provider_name, attempts: num(r.attempts), fallbackUsed: !!r.fallback_used, tokensIn: num(r.tokens_in), tokensOut: num(r.tokens_out), costMicro: String(r.cost ?? '0'), latencyMs: num(r.latency_ms), ttftMs: r.ttft_ms == null ? null : num(r.ttft_ms), status: normalizeStatus(r.status), errorCode: r.error_code }));
		res.json({ rows, total, page, pages });
	}));

	// ---- billing ----
	app.get(['/api/pages/billing', '/api/pages/dashboard/billing'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const account = await billingAccountFor(database, userRow.id);
		const balance = await ledgerBalance(database, account.id);
		const now = new Date();
		const ps = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
		const pe = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
		const period = rowsOf(
			await database.execute(sql`select coalesce(-sum(amount_micro),0)::text as total, count(*)::int as requests from credit_ledger where billing_account_id = ${account.id} and type = 'usage_charge' and created_at >= ${ps.toISOString()} and created_at < ${pe.toISOString()}`)
		)[0] ?? {};
		// The account is the tenant: the caller owns the billing account, so
		// canWrite is always true (the SPA's threshold form reads this flag).
		res.json({ currency: String(account.currency ?? 'USD').trim(), status: account.status, canWrite: true, balanceMicro: balance.toString(), warningThresholdMicro: String(account.warning_threshold_micro ?? account.warningThresholdMicro ?? '0'), hardStopThresholdMicro: String(account.hard_stop_threshold_micro ?? account.hardStopThresholdMicro ?? '0'), period: { start: ps.toISOString(), end: pe.toISOString(), spentMicro: String(period.total ?? '0'), requests: num(period.requests) } });
	}));
	app.post(['/api/pages/billing/thresholds', '/api/pages/dashboard/billing/thresholds'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const b = okBody(req);
		const warning = parseAmountToMicro(b.warn ?? b.warning ?? '');
		const hardStop = parseAmountToMicro(b.suspend ?? b.hard_stop ?? b.hardStop ?? '');
		if (warning === null || hardStop === null) return fail(res, 400, 'Thresholds must be dollar amounts, e.g. 10 or 0.50.');
		if (warning < 0n || hardStop < 0n) return fail(res, 400, 'Thresholds cannot be negative.');
		if (hardStop > warning) return fail(res, 400, 'The hard-stop threshold must be at or below the warning threshold.');
		await database.execute(sql`update billing_account set warning_threshold_micro = ${warning.toString()}, hard_stop_threshold_micro = ${hardStop.toString()}, updated_at = now() where user_id = ${userRow.id}`);
		await audit(database, { actorUserId: userRow.id, action: 'billing.thresholds.update', resource: 'billing_account', after: { warning_threshold_micro: warning.toString(), hard_stop_threshold_micro: hardStop.toString() } });
		res.json({ saved: true });
	}));
	app.get(['/api/pages/billing/credits', '/api/pages/dashboard/billing/credits'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const account = await billingAccountFor(database, userRow.id);
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
		const window = sql`r.user_id = ${userRow.id} and r.cost > 0 and r.created_at >= ${from.toISOString()} and r.created_at < ${to.toISOString()}`;
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
		res.json({ currency: String(account.currency ?? 'USD').trim(), balanceMicro: balance.toString(), rows, addCreditKey: `purchase:${newId(prefixFor(ctx, 'creditLedger'))}`, page, pages, total, thresholds: { warningMicro: String(account.warning_threshold_micro ?? account.warningThresholdMicro ?? '0'), hardStopMicro: String(account.hard_stop_threshold_micro ?? account.hardStopThresholdMicro ?? '0') }, series, breakdowns: { byModel } });
	}));
	app.post(['/api/pages/billing/credits/add', '/api/pages/dashboard/billing/credits/add'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const b = okBody(req);
		const amount = parseAmountToMicro(b.amount ?? '');
		if (amount === null || amount <= 0n) return fail(res, 400, 'Enter a positive dollar amount, e.g. 100 or 25.50.');
		const key = String(b.key ?? `purchase:${newId(prefixFor(ctx, 'creditLedger'))}`).trim();
		const account = await billingAccountFor(database, userRow.id);
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
		const account = await billingAccountFor(database, userRow.id);
		const rows = rowsOf(
			await database.execute(sql`select id, number, period_start, period_end, amount_micro, currency, status, issued_at, paid_at from invoice where billing_account_id = ${account.id} order by period_start desc limit 100`)
		).map((r) => ({ id: r.id, number: r.number, periodStart: iso(r.period_start), periodEnd: iso(r.period_end), amountMicro: String(r.amount_micro ?? '0'), currency: String(r.currency ?? '').trim(), status: r.status, issuedAt: iso(r.issued_at), paidAt: iso(r.paid_at) }));
		res.json({ invoices: rows, rows });
	}));
	app.post(['/api/pages/billing/invoices/generate', '/api/pages/dashboard/billing/invoices/generate'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const account = await billingAccountFor(database, userRow.id);
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
		const id = String(okBody(req).id ?? '').trim();
		if (!id) return fail(res, 400, 'Missing invoice id.');
		const account = await billingAccountFor(database, userRow.id);
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
		const key = `billing.payment_method_intent:${userRow.id}`;
		const row = rowsOf(await database.execute(sql`select value from system_setting where key = ${key} limit 1`))[0];
		res.json({ intent: row?.value ?? null });
	}));
	app.post(['/api/pages/billing/payment-methods/record', '/api/pages/dashboard/billing/payment-methods/record'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const b = okBody(req);
		const method = String(b.method ?? b.label ?? '').trim();
		const contact = String(b.contact ?? '').trim();
		if (!method) return fail(res, 400, 'Choose how you intend to pay.');
		if (!contact) return fail(res, 400, 'Leave a contact so an operator can follow up.');
		const value = JSON.stringify({ method, contact, note: String(b.note ?? '').trim(), recordedAt: new Date().toISOString(), recordedBy: userRow.id });
		const key = `billing.payment_method_intent:${userRow.id}`;
		await database.execute(sql`insert into system_setting (key, value, updated_by) values (${key}, ${value}::jsonb, ${userRow.id}) on conflict (key) do update set value = ${value}::jsonb, updated_by = ${userRow.id}, updated_at = now()`);
		res.json({ recorded: true });
	}));
	app.get(['/api/pages/billing/transactions', '/api/pages/dashboard/billing/transactions'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const account = await billingAccountFor(database, userRow.id);
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

	// ---- limits (account scope; was /api/pages/projects/:projectId/limits) ----
	app.get('/api/pages/limits', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const noLimits = () => ({ rpm: null, tpm: null, rpd: null, tpd: null, concurrency: null, dailySpendMicro: null, monthlySpendMicro: null });
		const valuesOf = (r) => r ? { rpm: r.rpm, tpm: r.tpm, rpd: r.rpd, tpd: r.tpd, concurrency: r.concurrency, dailySpendMicro: r.daily_spend_micro, monthlySpendMicro: r.monthly_spend_micro } : { ...noLimits() };
		const view = (v) => ({ rpm: v.rpm == null ? '' : String(v.rpm), tpm: v.tpm == null ? '' : String(v.tpm), rpd: v.rpd == null ? '' : String(v.rpd), tpd: v.tpd == null ? '' : String(v.tpd), concurrency: v.concurrency == null ? '' : String(v.concurrency), dailySpendMicro: v.dailySpendMicro == null ? '' : microsToInput(v.dailySpendMicro), monthlySpendMicro: v.monthlySpendMicro == null ? '' : microsToInput(v.monthlySpendMicro) });
		const editorView = (scope, scopeId, label, row) => ({ scope, scopeId, label, row: row ? { id: row.id, values: view(valuesOf(row)) } : null });
		try {
			const keys = rowsOf(await database.execute(sql`select id, name, prefix from api_key where user_id = ${userRow.id} order by name asc`));
			let hard = null;
			try {
				const hrow = rowsOf(await database.execute(sql`select value from system_setting where key = 'platform_hard_limits' limit 1`))[0];
				const hv = hrow?.value;
				hard = typeof hv === 'string' ? JSON.parse(hv) : hv;
			} catch { hard = null; }
			const rows = rowsOf(await database.execute(sql`select * from rate_limit where scope in ('account','api_key')`));
			const keyIds = new Set(keys.map((k) => k.id));
			const accountRow = rows.find((r) => r.scope === 'account' && r.scope_id === userRow.id) ?? null;
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
				{ level: 'account', values: valuesOf(accountRow) },
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
			return res.json({ denied: false, queryError: null, labels: LIMIT_LABELS, levelLabels: LIMIT_LEVEL_LABELS, chain,
				editors: [editorView('account', userRow.id, 'Account (all keys)', accountRow)],
				keyRows: keys.map((k) => ({ id: k.id, name: k.name ?? k.prefix ?? k.id, values: view(valuesOf(keyLimitRows.find((r) => r.scope_id === k.id) ?? null)) })) });
		} catch (err) {
			console.error('[pages] limits load failed', err);
			return res.json({ denied: false, queryError: 'The limits could not be read.', labels: LIMIT_LABELS, levelLabels: LIMIT_LEVEL_LABELS, chain: [], editors: [], keyRows: [] });
		}
	}));
	app.post('/api/pages/limits/save', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const b = okBody(req);
		const scope = String(b.scope ?? 'account');
		const scopeId = String(b.scopeId ?? (scope === 'account' ? userRow.id : ''));
		// The scope id is validated against the caller's own account: an id
		// alone is not proof the caller may bind a limit to it.
		if (!((scope === 'account' && scopeId === userRow.id) || (scope === 'api_key' && scopeId))) return fail(res, 400, 'Unknown scope');
		if (scope === 'api_key') {
			const key = rowsOf(await database.execute(sql`select id from api_key where id = ${scopeId} and user_id = ${userRow.id} limit 1`))[0];
			if (!key) return fail(res, 400, 'Unknown scope');
		}
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
		await audit(database, { actorUserId: userRow.id, action: ex ? 'limit.update' : 'limit.create', resource: 'rate_limit', resourceId: id, after: { scope, scopeId, rpm: vals.rpm, tpm: vals.tpm, rpd: vals.rpd, tpd: vals.tpd, concurrency: vals.concurrency, dailySpendMicro: vals.dailySpendMicro, monthlySpendMicro: vals.monthlySpendMicro } });
		return res.json({ saved: id });
	}));
	app.post('/api/pages/limits/remove', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const b = okBody(req);
		const scope = String(b.scope ?? '');
		const scopeId = String(b.scopeId ?? '').trim();
		// The scope id is validated against the caller's own account: an id
		// alone is not proof the caller may unbind a limit from it.
		let okScope = scope === 'account' && scopeId === userRow.id;
		if (!okScope && scope === 'api_key') {
			const key = rowsOf(await database.execute(sql`select id from api_key where id = ${scopeId} and user_id = ${userRow.id} limit 1`))[0];
			okScope = Boolean(key);
		}
		if (!okScope) return fail(res, 400, 'Unknown scope');
		const row = rowsOf(await database.execute(sql`select id, scope, scope_id from rate_limit where scope = ${scope} and scope_id = ${scopeId} limit 1`))[0];
		if (!row) return fail(res, 404, 'Limit row not found');
		await database.execute(sql`delete from rate_limit where id = ${row.id}`);
		await audit(database, { actorUserId: userRow.id, action: 'limit.delete', resource: 'rate_limit', resourceId: row.id, before: { scope: row.scope, scopeId: row.scope_id } });
		return res.json({ removed: row.id });
	}));

	// ---- budgets (account scope; was /api/pages/projects/:projectId/budgets) ----
	const BUDGET_PERIODS = ['daily', 'weekly', 'monthly'];
	const BUDGET_ACTIONS = ['notify', 'restrict', 'block'];
	function periodStart(period, now) {
		const y = now.getUTCFullYear(), mo = now.getUTCMonth(), d = now.getUTCDate();
		if (period === 'daily') return new Date(Date.UTC(y, mo, d));
		if (period === 'weekly') { const back = (now.getUTCDay() + 6) % 7; return new Date(Date.UTC(y, mo, d - back)); }
		return new Date(Date.UTC(y, mo, 1));
	}
	app.get('/api/pages/budgets', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const scopeIds = [userRow.id, ...rowsOf(await database.execute(sql`select id from api_key where user_id = ${userRow.id}`)).map((k) => k.id)];
		const rows = rowsOf(await database.execute(sql`select * from budget where scope_id in (${sql.join(scopeIds, sql`, `)})`));
		const now = new Date();
		const budgets = [];
		for (const b of rows) {
			const wFrom = periodStart(String(b.period), now);
			// request_log is keyed by user_id after 0019, so every scope's
			// consumption window reads the same account's rows.
			let consumed = 0n;
			try {
				const c = rowsOf(await database.execute(sql`select coalesce(sum(cost),0)::text as total from request_log where created_at >= ${wFrom.toISOString()} and created_at < ${now.toISOString()} and user_id = ${userRow.id}`))[0];
				consumed = big(c?.total);
			} catch { consumed = 0n; }
			const amount = big(b.amount_micro);
			const percent = amount <= 0n ? 0 : Number((consumed * 100n) / amount);
			const state = percent >= 100 ? 'exceeded' : percent >= num(b.critical_percent) ? 'critical' : percent >= num(b.warn_percent) ? 'warn' : 'ok';
			const key = b.scope === 'api_key' ? rowsOf(await database.execute(sql`select name from api_key where id = ${b.scope_id} limit 1`))[0] : null;
			budgets.push({ id: b.id, scope: b.scope, scopeLabel: b.scope === 'account' ? 'Account (all keys)' : `${key?.name ?? b.scope_id} (API key)`, period: b.period, amountMicro: String(b.amount_micro ?? '0'), warnPercent: num(b.warn_percent), criticalPercent: num(b.critical_percent), actionAt100: b.action_at_100, windowFrom: wFrom.toISOString(), windowTo: now.toISOString(), consumedMicro: consumed.toString(), percent, state });
		}
		return res.json({ denied: false, queryError: null, periods: BUDGET_PERIODS, actions: BUDGET_ACTIONS, budgets });
	}));
	app.post('/api/pages/budgets/save', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const b = okBody(req);
		const scope = String(b.scope ?? 'account');
		if (scope !== 'account' && scope !== 'api_key') return fail(res, 400, 'Scope must be account or api_key');
		const scopeId = scope === 'account' ? userRow.id : String(b.scopeId ?? '').trim();
		if (scope === 'api_key') {
			if (!scopeId) return fail(res, 400, 'Pick an API key');
			const key = rowsOf(await database.execute(sql`select id from api_key where id = ${scopeId} and user_id = ${userRow.id} limit 1`))[0];
			if (!key) return fail(res, 400, 'Pick one of your API keys');
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
		const existing = rowsOf(await database.execute(sql`select id from budget where scope = ${scope} and scope_id = ${scopeId} and period = ${period} limit 1`))[0];
		const id = existing?.id ?? newId('bdg_');
		await database.execute(sql`insert into budget (id, scope, scope_id, period, amount_micro, warn_percent, critical_percent, action_at_100) values (${id}, ${scope}, ${scopeId}, ${period}, ${amount.toString()}, ${warnPercent}, ${criticalPercent}, ${actionAt100}) on conflict (scope, scope_id, period) do update set amount_micro = ${amount.toString()}, warn_percent = ${warnPercent}, critical_percent = ${criticalPercent}, action_at_100 = ${actionAt100}, updated_at = now()`);
		await audit(database, { actorUserId: userRow.id, action: existing ? 'budget.update' : 'budget.create', resource: 'budget', resourceId: id, after: { scope, scopeId, period } });
		return res.json({ saved: id });
	}));
	app.post('/api/pages/budgets/remove', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const b = okBody(req);
		const id = String(b.id ?? '').trim();
		if (!id) return fail(res, 400, 'Missing budget id');
		// Ownership predicate repeated on the DELETE, not just the lookup —
		// same hole the alerts/remove comment documents: a delete anchored
		// only by primary key is the same ownership hole one statement later.
		const owned = sql`(scope = 'account' and scope_id = ${userRow.id}) or (scope = 'api_key' and scope_id in (select id from api_key where user_id = ${userRow.id}))`;
		const row = rowsOf(await database.execute(sql`select id from budget where id = ${id} and ${owned} limit 1`))[0];
		if (!row) return fail(res, 404, 'Budget not found');
		const deleted = rowsOf(await database.execute(sql`delete from budget where id = ${id} and ${owned} returning id`));
		if (!deleted.length) return fail(res, 404, 'Budget not found');
		return res.json({ removed: id });
	}));

	// ---- aliases (account scope; was /api/pages/projects/:projectId/aliases) ----
	app.get('/api/pages/aliases', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const aliasRows = rowsOf(await database.execute(sql`select id, name, description, enabled, account_id from model_alias where account_id = ${userRow.id} or account_id is null order by name asc`));
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
		const aliases = aliasRows.map((a) => ({ id: a.id, name: a.name, description: a.description, enabled: a.enabled, scope: a.account_id === null ? 'global' : 'account', targets: targetsByAlias.get(a.id) ?? [] }));
		const models = rowsOf(await database.execute(sql`select id, slug, name, status, developer from model where status <> 'disabled' order by slug asc`));
		return res.json({ aliases, models });
	}));
	app.post('/api/pages/aliases/create', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const b = okBody(req);
		const name = String(b.name ?? '').trim();
		if (!name) return fail(res, 400, 'Alias name is required');
		const scope = String(b.scope ?? 'account') === 'global' ? 'global' : 'account';
		// modelIds is the contract field name; targets is what the SPA sent
		// before the flatten — accept both during the cutover.
		const targets = (Array.isArray(b.modelIds) ? b.modelIds : Array.isArray(b.targets) ? b.targets : []).filter((t) => typeof t === 'string');
		if (!targets.length) return fail(res, 400, 'Pick at least one target model');
		// The unique index is (coalesce(account_id,''), name), so the collision
		// check must compare the same shape: a global alias and an account
		// alias may share a name, two account aliases may not.
		const collision = rowsOf(await database.execute(scope === 'account'
			? sql`select id from model_alias where account_id = ${userRow.id} and name = ${name} limit 1`
			: sql`select id from model_alias where account_id is null and name = ${name} limit 1`))[0];
		if (collision) return fail(res, 409, `An alias named "${name}" already exists in this ${scope}.`);
		const known = rowsOf(await database.execute(sql`select id from model where id in (${sql.join(targets, sql`, `)})`));
		if (known.length !== targets.length) return fail(res, 400, 'One or more target models do not exist.');
		const aliasId = newId('als_');
		await database.execute(sql`insert into model_alias (id, account_id, name, description, enabled) values (${aliasId}, ${scope === 'account' ? userRow.id : null}, ${name}, ${String(b.description ?? '').trim() || null}, ${b.enabled === false ? false : true})`);
		let pos = 1;
		for (const mid of targets) {
			await database.execute(sql`insert into model_alias_target (alias_id, model_id, position) values (${aliasId}, ${mid}, ${pos})`);
			pos += 1;
		}
		await audit(database, { actorUserId: userRow.id, action: 'alias.create', resource: 'model_alias', resourceId: aliasId, after: { name, scope } });
		return res.json({ created: name, id: aliasId });
	}));
	app.post('/api/pages/aliases/delete', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const id = String(okBody(req).id ?? '').trim();
		if (!id) return fail(res, 400, 'Missing alias id');
		const existing = rowsOf(await database.execute(sql`select id, name, account_id from model_alias where id = ${id} limit 1`))[0];
		if (!existing) return fail(res, 404, 'Alias not found');
		if (existing.account_id === null) return fail(res, 403, 'Global virtual aliases are read-only.');
		// Ownership is stated on the predicate: an account alias belongs to
		// THIS user, and "not global" proves nothing (the pre-0019 hole let a
		// member delete a foreign tenant's workspace-scoped alias).
		if (existing.account_id !== userRow.id) return fail(res, 404, 'Alias not found');
		// The predicate is repeated on the DELETE, not just the lookup: the
		// row could change between the two statements, and a delete anchored
		// only by primary key is the same hole one statement later.
		await database.execute(sql`delete from model_alias where id = ${id} and account_id = ${userRow.id}`);
		await audit(database, { actorUserId: userRow.id, action: 'alias.delete', resource: 'model_alias', resourceId: id, before: { name: existing.name } });
		return res.json({ deleted: existing.name });
	}));

	// ---- routing (account scope; was /api/pages/projects/:projectId/routing) ----
	app.get('/api/pages/routing', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		let policies = [];
		try {
			// account_id NULL = the platform default policy; it is listed so the
			// page can show what applies when the account defines none.
			policies = rowsOf(await database.execute(sql`select id, name, strategy, enabled, max_attempts, request_timeout_ms, fallback_enabled, account_id, provider_preferences, model_preferences, constraints, weights from routing_policy where account_id = ${userRow.id} or account_id is null order by name asc`));
		} catch { policies = []; }
		let providers = [], models = [];
		try {
			providers = rowsOf(await database.execute(sql`select slug, name from provider where slug is not null order by slug asc`));
			models = rowsOf(await database.execute(sql`select slug, name from model where slug is not null order by slug asc`));
		} catch { providers = []; models = []; }
		return res.json({ policies: policies.map((p) => ({ id: p.id, name: p.name, strategy: p.strategy, enabled: p.enabled, maxAttempts: p.max_attempts, requestTimeoutMs: p.request_timeout_ms, fallbackEnabled: p.fallback_enabled, scope: p.account_id === null ? 'platform' : 'account', providerPreferences: p.provider_preferences ?? { order: [] }, modelPreferences: p.model_preferences ?? { order: [] }, constraints: p.constraints ?? {}, weights: p.weights ?? {} })), strategies: ROUTING_STRATEGIES, providers, models });
	}));
	app.post('/api/pages/routing/create', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const b = okBody(req);
		const parsed = parsePolicyFormBody(b);
		if (!parsed.ok) return fail(res, 400, parsed.error);
		// Writes are account-scoped only: the platform default policy is
		// operator-owned, and a member must never be able to overwrite it.
		const v = parsed.values;
		const hit = rowsOf(await database.execute(sql`select id from routing_policy where account_id = ${userRow.id} and name = ${v.name} limit 1`))[0];
		if (hit) return fail(res, 409, `A policy named "${v.name}" already exists in this account.`);
		const id = newId(prefixFor(ctx, 'routingPolicy'));
		await database.execute(sql`insert into routing_policy (id, account_id, name, strategy, enabled, max_attempts, request_timeout_ms, fallback_enabled, provider_preferences, model_preferences, constraints, weights) values (${id}, ${userRow.id}, ${v.name}, ${v.strategy}, ${v.enabled}, ${v.maxAttempts}, ${v.requestTimeoutMs}, ${v.fallbackEnabled}, ${JSON.stringify(v.providerPreferences)}::jsonb, ${JSON.stringify(v.modelPreferences)}::jsonb, ${JSON.stringify(v.constraints)}::jsonb, ${JSON.stringify(v.weights)}::jsonb)`);
		await audit(database, { actorUserId: userRow.id, action: 'routing.create', resource: 'routing_policy', resourceId: id, after: { name: v.name, strategy: v.strategy, enabled: v.enabled, maxAttempts: v.maxAttempts, requestTimeoutMs: v.requestTimeoutMs, fallbackEnabled: v.fallbackEnabled, providerPreferences: v.providerPreferences, modelPreferences: v.modelPreferences, constraints: v.constraints, weights: v.weights, scope: 'account' } });
		return res.json({ created: v.name, id });
	}));
	app.post('/api/pages/routing/update', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const b = okBody(req);
		const id = String(b.id ?? '').trim();
		if (!id) return fail(res, 400, 'Missing policy id');
		const existing = rowsOf(await database.execute(sql`select id, name, strategy, enabled, max_attempts, request_timeout_ms, fallback_enabled, account_id, provider_preferences, model_preferences, constraints, weights from routing_policy where id = ${id} and account_id = ${userRow.id} limit 1`))[0];
		if (!existing) return fail(res, 404, 'Policy not found');
		const parsed = parsePolicyFormBody(b);
		if (!parsed.ok) return fail(res, 400, parsed.error);
		const v = parsed.values;
		const hit = rowsOf(await database.execute(sql`select id from routing_policy where account_id = ${userRow.id} and name = ${v.name} and id <> ${id} limit 1`))[0];
		if (hit) return fail(res, 409, `A policy named "${v.name}" already exists in this account.`);
		const before = { name: existing.name, strategy: existing.strategy, enabled: existing.enabled, maxAttempts: existing.max_attempts, requestTimeoutMs: existing.request_timeout_ms, fallbackEnabled: existing.fallback_enabled, providerPreferences: existing.provider_preferences, modelPreferences: existing.model_preferences, constraints: existing.constraints, weights: existing.weights, scope: 'account' };
		const after = { name: v.name, strategy: v.strategy, enabled: v.enabled, maxAttempts: v.maxAttempts, requestTimeoutMs: v.requestTimeoutMs, fallbackEnabled: v.fallbackEnabled, providerPreferences: v.providerPreferences, modelPreferences: v.modelPreferences, constraints: v.constraints, weights: v.weights, scope: 'account' };
		// Ownership predicate repeated on the UPDATE, not just the lookup —
		// same hole the alerts/update comment documents: the row could change
		// between the two statements, and an UPDATE anchored only by primary
		// key lets a member rewrite another account's policy.
		const updated = rowsOf(await database.execute(sql`update routing_policy set name = ${v.name}, strategy = ${v.strategy}, enabled = ${v.enabled}, max_attempts = ${v.maxAttempts}, request_timeout_ms = ${v.requestTimeoutMs}, fallback_enabled = ${v.fallbackEnabled}, provider_preferences = ${JSON.stringify(v.providerPreferences)}::jsonb, model_preferences = ${JSON.stringify(v.modelPreferences)}::jsonb, constraints = ${JSON.stringify(v.constraints)}::jsonb, weights = ${JSON.stringify(v.weights)}::jsonb, updated_at = now() where id = ${id} and account_id = ${userRow.id} returning id`));
		if (!updated.length) return fail(res, 404, 'Policy not found');
		await audit(database, { actorUserId: userRow.id, action: 'routing.update', resource: 'routing_policy', resourceId: id, before, after });
		return res.json({ updated: v.name });
	}));
	app.post('/api/pages/routing/delete', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const id = String(okBody(req).id ?? '').trim();
		if (!id) return fail(res, 400, 'Missing policy id');
		const existing = rowsOf(await database.execute(sql`select id, name, strategy, enabled, max_attempts, request_timeout_ms, fallback_enabled, account_id, provider_preferences, model_preferences, constraints, weights from routing_policy where id = ${id} and account_id = ${userRow.id} limit 1`))[0];
		if (!existing) return fail(res, 404, 'Policy not found');
		const before = { name: existing.name, strategy: existing.strategy, enabled: existing.enabled, maxAttempts: existing.max_attempts, requestTimeoutMs: existing.request_timeout_ms, fallbackEnabled: existing.fallback_enabled, providerPreferences: existing.provider_preferences, modelPreferences: existing.model_preferences, constraints: existing.constraints, weights: existing.weights, scope: 'account' };
		// Ownership predicate repeated on the DELETE, not just the lookup —
		// same hole the alerts/remove comment documents: a delete anchored
		// only by primary key is the same ownership hole one statement later.
		const deleted = rowsOf(await database.execute(sql`delete from routing_policy where id = ${id} and account_id = ${userRow.id} returning id`));
		if (!deleted.length) return fail(res, 404, 'Policy not found');
		await audit(database, { actorUserId: userRow.id, action: 'routing.delete', resource: 'routing_policy', resourceId: id, before });
		return res.json({ deleted: existing.name });
	}));

	// ---- alerts (account scope; was /api/pages/projects/:projectId/alerts) ----
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
	app.get('/api/pages/alerts', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const rows = rowsOf(await database.execute(sql`select * from alert where account_id = ${userRow.id} order by created_at desc`));
		const events = rowsOf(await database.execute(sql`select e.id, e.alert_id, a.name as alert_name, e.triggered_at, e.value, e.message, e.state, e.resolved_at, e.delivered_at from alert_event e inner join alert a on a.id = e.alert_id where a.account_id = ${userRow.id} order by e.triggered_at desc limit 50`))
			.map((e) => ({ id: e.id, alertId: e.alert_id, alertName: e.alert_name, triggeredAt: iso(e.triggered_at), value: String(e.value ?? ''), message: e.message, state: e.state, resolvedAt: iso(e.resolved_at), deliveredAt: iso(e.delivered_at) }));
		return res.json({ denied: false, queryError: null, conditionTypes: ALERT_TYPES, channels: ALERT_CHANNELS, alerts: rows.map(alertView), events });
	}));
	app.post('/api/pages/alerts/create', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const parsed = parseAlertBody(okBody(req));
		if (!parsed.ok) return fail(res, 400, parsed.error);
		const id = newId('alr_');
		await database.execute(sql`insert into alert (id, account_id, name, condition, channel, enabled) values (${id}, ${userRow.id}, ${parsed.value.name}, ${JSON.stringify(parsed.value.condition)}::jsonb, ${parsed.value.channel}, ${parsed.value.enabled})`);
		await audit(database, { actorUserId: userRow.id, action: 'alert.create', resource: 'alert', resourceId: id, after: { name: parsed.value.name, channel: parsed.value.channel } });
		return res.json({ saved: id });
	}));
	app.post('/api/pages/alerts/update', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const b = okBody(req);
		const id = String(b.id ?? '').trim();
		if (!id) return fail(res, 400, 'Missing alert id');
		const parsed = parseAlertBody(b);
		if (!parsed.ok) return fail(res, 400, parsed.error);
		const before = rowsOf(await database.execute(sql`select id, name from alert where id = ${id} and account_id = ${userRow.id} limit 1`))[0];
		if (!before) return fail(res, 404, 'Alert not found');
		// 3c: the account predicate is repeated on the UPDATE, not just the
		// lookup — the row could change between the two statements, and an
		// UPDATE anchored only by primary key lets any member rewrite another
		// account's alert (the lookup row being theirs proves nothing about
		// the write). Ownership is not implied by "not found elsewhere"; it
		// has to be stated on the write itself.
		const updated = rowsOf(await database.execute(sql`update alert set name = ${parsed.value.name}, condition = ${JSON.stringify(parsed.value.condition)}::jsonb, channel = ${parsed.value.channel}, enabled = ${parsed.value.enabled}, updated_at = now() where id = ${id} and account_id = ${userRow.id} returning id`));
		if (!updated.length) return fail(res, 404, 'Alert not found');
		return res.json({ saved: id });
	}));
	app.post('/api/pages/alerts/remove', wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const id = String(okBody(req).id ?? '').trim();
		if (!id) return fail(res, 400, 'Missing alert id');
		const before = rowsOf(await database.execute(sql`select id, name from alert where id = ${id} and account_id = ${userRow.id} limit 1`))[0];
		if (!before) return fail(res, 404, 'Alert not found');
		// 3c: predicate repeated on the DELETE for the same reason as the
		// UPDATE above — a delete anchored only by primary key is the same
		// ownership hole one statement later.
		const deleted = rowsOf(await database.execute(sql`delete from alert where id = ${id} and account_id = ${userRow.id} returning id`));
		if (!deleted.length) return fail(res, 404, 'Alert not found');
		await audit(database, { actorUserId: userRow.id, action: 'alert.delete', resource: 'alert', resourceId: id, before: { name: before.name } });
		return res.json({ removed: id });
	}));

	// ---- connect (client onboarding, read-only) ----
	app.get(['/api/pages/connect', '/api/pages/dashboard/connect'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const models = rowsOf(
			await database.execute(sql`select slug, name, developer from model where status = 'active' order by slug asc`)
		).map((m) => ({ slug: m.slug, name: m.name, developer: m.developer }));
		// Alias visibility is account + global only; project-scoped aliases
		// died with the project table.
		const aliases = rowsOf(
			await database.execute(sql`select name, description from model_alias where enabled = true and (account_id is null or account_id = ${userRow.id}) order by name asc`)
		);
		const ordered = aliases.filter((a) => !String(a.name).startsWith('fudrouter/')).concat(aliases.filter((a) => String(a.name).startsWith('fudrouter/')));
		const keys = rowsOf(
			await database.execute(sql`select id, name, prefix from api_key where user_id = ${userRow.id} and status = 'active' and revoked_at is null order by created_at asc`)
		);
		const baseUrl = String(process.env.PUBLIC_API_BASE_URL || process.env.ROUTER_BASE_URL || 'http://127.0.0.1:8100').replace(/\/+$/, '');
		res.json({ models, aliases: ordered, keys, baseUrl });
	}));
	// ---- playground (picker data; runs go through /api/playground/stream) ----
	app.get(['/api/pages/playground', '/api/pages/dashboard/playground'], wrap(async (req, res) => {
		const database = needDb(res);
		if (!database) return;
		const userRow = await mustAuth(req);
		const models = rowsOf(
			await database.execute(sql`select id, slug, name, status, developer from model where status <> 'disabled' order by slug asc`)
		);
		const aliases = rowsOf(await database.execute(sql`select id, name, description from model_alias where account_id = ${userRow.id} or account_id is null order by name asc`));
		const ordered = aliases.filter((a) => !String(a.name).startsWith('fudrouter/')).concat(aliases.filter((a) => String(a.name).startsWith('fudrouter/')));
		const keys = rowsOf(await database.execute(sql`select id, name from api_key where user_id = ${userRow.id} and status = 'active' and revoked_at is null order by created_at asc`));
		res.json({ models, aliases: ordered, keys });
	}));
}
