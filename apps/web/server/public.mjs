// Public catalog/status/docs/changelog API for the public surface
// (models, providers, pricing, status,
// docs, changelog) plus the landing metric strip.
//
// All routes are PUBLIC (no auth), exactly like the pages they mirror.
// Registered from index.mjs via registerPublicRoutes(app, ctx). Raw SQL is
// used throughout so real columns work regardless of the minimal drizzle
// table copies in index.mjs. Credential material is never selected.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { served as _served, allowDevProviders as _allowDevProviders } from './lib/platform-ts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function rowsOf(r) {
	if (Array.isArray(r)) return r;
	if (r && Array.isArray(r.rows)) return r.rows;
	return [];
}
function iso(v) {
	if (!v) return null;
	try {
		return new Date(v).toISOString();
	} catch {
		return String(v);
	}
}
function num(v) {
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}
/**
 * Publish gate — the shared one. packages/platform/publish.ts OWNS the rule and
 * the Go router's SQL mirrors it; this file used to carry a third copy
 * (`served`), which is exactly the "mirrored SQL"/hand-copy drift the module's
 * header warns about. `allowDevProviders` is read from the platform's own
 * publish-env, so the console and the router parse ROUTER_ALLOW_DEV_PROVIDERS
 * identically.
 */
function served(modelStatus, providerStatus) {
	return _served(modelStatus, providerStatus, _allowDevProviders());
}
function toPrice(raw) {
	const r = raw ?? {};
	return {
		inputPriceMicro: r.input ?? '0',
		cachedInputPriceMicro: r.cached ?? null,
		outputPriceMicro: r.output ?? null,
		reasoningPriceMicro: r.reasoning ?? null,
		currency: r.currency ?? 'USD'
	};
}
function priceDiffers(wide, spec) {
	return (
		wide.inputPriceMicro !== spec.inputPriceMicro ||
		(wide.cachedInputPriceMicro ?? null) !== (spec.cachedInputPriceMicro ?? null) ||
		(wide.outputPriceMicro ?? null) !== (spec.outputPriceMicro ?? null) ||
		(wide.reasoningPriceMicro ?? null) !== (spec.reasoningPriceMicro ?? null)
	);
}
function effectiveCapability(canonical, overrides, key) {
	const o = overrides ?? {};
	const c = canonical ?? {};
	if (typeof o[key] === 'boolean') return o[key];
	if (typeof c[key] === 'boolean') return c[key];
	return null;
}
function matchesCapability(value, filter) {
	if (filter === 'any') return true;
	if (value === null) return false;
	return filter === 'yes' ? value : !value;
}
const CAPABILITIES = [
	'text',
	'vision',
	'audio',
	'tools',
	'reasoning',
	'structured_output',
	'streaming',
	'embeddings'
];
const CAPABILITY_FILTERS = ['vision', 'tools', 'reasoning', 'structured_output', 'streaming'];
const SORT_KEYS = ['name', 'input-price', 'output-price', 'context', 'popularity', 'latency', 'availability'];
const MAX_COMPARE = 4;

function parseCompareList(raw) {
	const all = String(raw ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	const seen = new Set();
	const slugs = [];
	for (const s of all) {
		if (seen.has(s)) continue;
		seen.add(s);
		slugs.push(s);
	}
	return { slugs: slugs.slice(0, MAX_COMPARE), truncated: slugs.length > MAX_COMPARE };
}

/**
 * Every served model with provider availability, per the publish gate —
 * the one query layer behind /models, /providers, /pricing and /metrics.
 */
async function servedModels(database) {
	// The structural half of the router's provider gate (providerServableSQLFor,
	// backend/go/internal/store/catalog.go) belongs HERE, in SQL, because
	// reachability()'s three arguments cannot see p.enabled or p.tier at all.
	// Before this predicate a model served ONLY through a disabled provider
	// (p.enabled = false) or a dev-tier one (p.tier = 'dev' with the
	// ROUTER_ALLOW_DEV_PROVIDERS opt-in off) still appeared on the public
	// catalogue while the router refused to serve it — probed against the test
	// database: GET /api/models listed both probe models, GET /v1/models
	// excluded both. Filtering in the SPA would be worse: the page must not be
	// a security boundary.
	const allowDev = _allowDevProviders();
	const rows = rowsOf(
		await database.execute(sql`
			select m.id as model_id, m.slug, m.name, m.family, m.developer, m.description,
				m.context, m.max_output as max_output, m.modality, m.capabilities,
				m.status as model_status,
				coalesce(
					(select jsonb_build_object(
						'input', pr.input_price::text,
						'cached', pr.cached_input_price::text,
						'output', pr.output_price::text,
						'reasoning', pr.reasoning_price::text,
						'currency', pr.currency
					)
					from pricing_rule pr
					where pr.model_id = m.id
					  and pr.provider_model_id is null
					  and pr.effective_from <= now()
					  and (pr.effective_until is null or pr.effective_until > now())
					order by pr.version desc limit 1),
					jsonb_build_object(
						'input', m.input_price::text,
						'cached', null,
						'output', m.output_price::text,
						'reasoning', null,
						'currency', m.currency
					)
				) as wide_price,
				pm.id as pm_id, pm.provider_model_id as pm_provider_model_id,
				pm.status as pm_status, pm.enabled as pm_enabled,
				pm.context_override, pm.capabilities_override,
				p.name as provider_name, p.slug as provider_slug, p.status as provider_status,
				c.name as connection_name, c.region,
				(select jsonb_build_object(
					'input', pr.input_price::text,
					'cached', pr.cached_input_price::text,
					'output', pr.output_price::text,
					'reasoning', pr.reasoning_price::text,
					'currency', pr.currency
				)
				from pricing_rule pr
				where pr.provider_model_id = pm.id
				  and pr.effective_from <= now()
				  and (pr.effective_until is null or pr.effective_until > now())
				order by pr.version desc limit 1) as spec_price
			from model m
			inner join provider_model pm on pm.model_id = m.id and pm.enabled = true
			inner join provider p on p.id = pm.provider_id
			left join connection c on c.id = pm.connection_id
			where p.enabled = true
			  and (p.tier = 'commercial' or ${allowDev})
			order by m.slug, p.name`)
	);
	const gated = rows.filter((r) => served(r.model_status, r.provider_status));
	const pmIds = [...new Set(gated.map((r) => r.pm_id))].filter((id) =>
		/^[A-Za-z0-9_-]+$/.test(String(id ?? ''))
	);
	let stats = new Map();
	if (pmIds.length) {
		const statRows = rowsOf(
			await database.execute(sql`
				select provider_model_id as pm_id,
					percentile_disc(0.5) within group (order by latency_ms)::int as p50,
					percentile_disc(0.95) within group (order by latency_ms)::int as p95,
					count(*)::int as total,
					count(*) filter (where status = 'success')::int as ok
				from request_log
				where provider_model_id in (${sql.join(
					pmIds.map((id) => sql`${id}`),
					sql`, `
				)})
				group by provider_model_id`)
		);
		for (const r of statRows) {
			if (!r.pm_id) continue;
			stats.set(r.pm_id, {
				p50: r.p50 ?? null,
				p95: r.p95 ?? null,
				availability: num(r.total) > 0 ? num(r.ok) / num(r.total) : null
			});
		}
	}
	const byModel = new Map();
	for (const r of gated) {
		let entry = byModel.get(r.model_id);
		if (!entry) {
			const wide = toPrice(r.wide_price);
			entry = {
				id: r.model_id,
				slug: r.slug,
				name: r.name,
				family: r.family ?? null,
				developer: r.developer ?? null,
				description: r.description ?? null,
				context: r.context ?? null,
				maxOutput: r.max_output ?? null,
				modality: r.modality ?? {},
				capabilities: r.capabilities ?? {},
				status: r.model_status,
				currency: wide.currency,
				price: wide,
				providers: [],
				p50Ms: null,
				p95Ms: null,
				availability: null
			};
			byModel.set(r.model_id, entry);
		}
		const wide = entry.price;
		const spec = r.spec_price ? toPrice(r.spec_price) : null;
		const s = stats.get(r.pm_id);
		entry.providers.push({
			providerName: r.provider_name,
			providerSlug: r.provider_slug ?? null,
			connectionName: r.connection_name ?? null,
			region: r.region ?? null,
			providerModelId: r.pm_provider_model_id,
			status: r.pm_status,
			enabled: r.pm_enabled,
			price: spec && priceDiffers(wide, spec) ? spec : null,
			p50Ms: s?.p50 ?? null,
			p95Ms: s?.p95 ?? null,
			availability: s?.availability ?? null
		});
	}
	for (const entry of byModel.values()) {
		const withTraffic = entry.providers.filter((p) => p.p50Ms !== null);
		const p50s = withTraffic.map((p) => p.p50Ms).sort((a, b) => a - b);
		const p95s = withTraffic.map((p) => p.p95Ms).sort((a, b) => a - b);
		entry.p50Ms = p50s.length ? p50s[Math.floor((p50s.length - 1) / 2)] : null;
		entry.p95Ms = p95s.length ? p95s[Math.floor((p95s.length - 1) / 2)] : null;
		const avails = entry.providers
			.map((p) => p.availability)
			.filter((a) => a !== null);
		entry.availability = avails.length
			? avails.reduce((a, b) => a + b, 0) / avails.length
			: null;
	}
	return [...byModel.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

function identifiersOf(m) {
	return {
		canonical: m.slug,
		fudrouter: m.slug,
		providerForms: m.providers.map((p) => ({ providerName: p.providerName, id: p.providerModelId }))
	};
}
function publicApiBase() {
	return String(process.env.PUBLIC_API_BASE_URL || process.env.ROUTER_BASE_URL || 'http://127.0.0.1:8100').replace(/\/+$/, '');
}
function curlSample(slug) {
	return [
		`curl ${publicApiBase()}/v1/chat/completions \\`,
		'  -H "Authorization: Bearer $FUDROUTER_KEY" \\',
		'  -H "Content-Type: application/json" \\',
		`  -d '{"model": "${slug}", "messages": [{"role": "user", "content": "hello"}]}'`
	].join('\n');
}

/* ---------------- catalog filtering/sorting (models page) ---------------- */
function parseFilters(query) {
	const get = (k) => query[k] ?? '';
	const form = {
		search: String(get('search')).trim(),
		developer: String(get('developer')).trim(),
		provider: String(get('provider')).trim(),
		minContext: String(get('minContext')).trim(),
		maxInputPrice: String(get('maxInputPrice')).trim(),
		maxOutputPrice: String(get('maxOutputPrice')).trim()
	};
	const minContext = form.minContext ? Number(form.minContext) * 1000 : NaN;
	const price = (raw) => {
		if (!/^\d+(\.\d{1,6})?$/.test(raw)) return null;
		const [whole = '0', frac = ''] = raw.split('.');
		return BigInt(whole) * 1000000n + BigInt((frac + '000000').slice(0, 6));
	};
	const capabilities = {};
	for (const key of CAPABILITY_FILTERS) {
		const raw = String(query[key] ?? 'any').trim();
		const want = raw === 'yes' || raw === 'no' ? raw : 'any';
		form[key] = want;
		if (want !== 'any') capabilities[key] = want;
	}
	return {
		filters: {
			search: form.search,
			developer: form.developer,
			provider: form.provider,
			minContext: Number.isFinite(minContext) && minContext > 0 ? Math.round(minContext) : null,
			maxInputPriceMicro: price(form.maxInputPrice),
			maxOutputPriceMicro: price(form.maxOutputPrice),
			capabilities
		},
		form
	};
}
function inputPriceMicro(m) {
	return BigInt(String(m.price.inputPriceMicro ?? '0').split('.')[0] ?? '0');
}
function outputPriceMicro(m) {
	return BigInt(String(m.price.outputPriceMicro ?? '0').split('.')[0] ?? '0');
}
function applyFilters(models, f) {
	return models.filter((m) => {
		if (f.search) {
			const q = f.search.toLowerCase();
			const hay = `${m.name} ${m.slug} ${m.developer ?? ''} ${m.family ?? ''}`.toLowerCase();
			if (!hay.includes(q)) return false;
		}
		if (f.developer && (m.developer ?? '') !== f.developer) return false;
		if (f.provider && !m.providers.some((p) => p.providerName === f.provider)) return false;
		if (f.minContext !== null && (m.context ?? 0) < f.minContext) return false;
		if (f.maxInputPriceMicro !== null && inputPriceMicro(m) > f.maxInputPriceMicro) return false;
		if (f.maxOutputPriceMicro !== null && outputPriceMicro(m) > f.maxOutputPriceMicro) return false;
		for (const key of Object.keys(f.capabilities)) {
			const want = f.capabilities[key];
			if (!want || want === 'any') continue;
			if (!matchesCapability(effectiveCapability(m.capabilities, {}, key), want)) return false;
		}
		return true;
	});
}
function sortModels(models, key) {
	const out = [...models];
	const cmpNum = (a, b, dir) => {
		if (a === null && b === null) return 0;
		if (a === null) return 1;
		if (b === null) return -1;
		return (a - b) * dir;
	};
	switch (key) {
		case 'input-price':
			out.sort((a, b) =>
				inputPriceMicro(a) < inputPriceMicro(b) ? -1 : inputPriceMicro(a) > inputPriceMicro(b) ? 1 : 0
			);
			break;
		case 'output-price':
			out.sort((a, b) =>
				outputPriceMicro(a) < outputPriceMicro(b) ? -1 : outputPriceMicro(a) > outputPriceMicro(b) ? 1 : 0
			);
			break;
		case 'context':
			out.sort((a, b) => cmpNum(a.context, b.context, -1));
			break;
		case 'popularity':
			out.sort((a, b) => b.providers.length - a.providers.length || a.name.localeCompare(b.name));
			break;
		case 'latency':
			out.sort((a, b) => cmpNum(a.p50Ms, b.p50Ms, 1));
			break;
		case 'availability':
			out.sort((a, b) => cmpNum(a.availability, b.availability, -1));
			break;
		default:
			out.sort((a, b) => a.name.localeCompare(b.name));
	}
	return out;
}
function filterOptions(models) {
	return {
		developers: [...new Set(models.map((m) => m.developer).filter(Boolean))].sort(),
		providers: [...new Set(models.flatMap((m) => m.providers.map((p) => p.providerName)))].sort()
	};
}

/* ---------------- provider directory ---------------- */
const ALL_KEYS = ['text', 'vision', 'audio', 'tools', 'reasoning', 'structured_output', 'streaming', 'embeddings'];
function capabilitiesOf(models, providerName) {
	return ALL_KEYS.filter((key) =>
		models.some(
			(m) =>
				m.providers.some((p) => p.providerName === providerName) &&
				effectiveCapability(m.capabilities, {}, key) === true
		)
	);
}
function providerRows(models) {
	const names = [...new Set(models.flatMap((m) => m.providers.map((p) => p.providerName)))];
	return names
		.map((name) => {
			const links = models.flatMap((m) =>
				m.providers.filter((p) => p.providerName === name).map((p) => ({ m, p }))
			);
			const regions = [...new Set(links.map((l) => l.p.region).filter(Boolean))].sort();
			const p50s = links.map((l) => l.p.p50Ms).filter((v) => v !== null);
			const p95s = links.map((l) => l.p.p95Ms).filter((v) => v !== null);
			const avails = links.map((l) => l.p.availability).filter((v) => v !== null);
			const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];
			return {
				name,
				slug: links[0]?.p.providerSlug ?? null,
				status: links.some((l) => l.p.status === 'available') ? 'operational' : 'degraded',
				modelCount: new Set(links.map((l) => l.m.id)).size,
				capabilities: capabilitiesOf(models, name),
				regions,
				p50Ms: p50s.length ? median(p50s) : null,
				p95Ms: p95s.length ? median(p95s) : null,
				availability: avails.length ? avails.reduce((a, b) => a + b, 0) / avails.length : null
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}
function modelsOf(models, providerName) {
	return models.filter((m) => m.providers.some((p) => p.providerName === providerName));
}

/* ---------------- status vocabulary ---------------- */
const STATUS_COMPONENTS = ['gateway', 'dashboard', 'authentication', 'billing', 'database-services', 'major-providers'];
const COMPONENT_LABELS = {
	gateway: 'Gateway',
	dashboard: 'Dashboard',
	authentication: 'Authentication',
	billing: 'Billing',
	'database-services': 'Database-facing services',
	'major-providers': 'Major providers'
};
const COMPONENT_DESCRIPTIONS = {
	gateway: 'The data plane that answers /v1 calls.',
	dashboard: 'The control plane — console, API keys, usage.',
	authentication: 'Sign-in, sessions and key validation.',
	billing: 'Balance, ledger and per-request metering.',
	'database-services': 'PostgreSQL and Valkey.',
	'major-providers': 'The upstream AI providers the network routes to.'
};
const COMPONENT_STATES = ['operational', 'degraded', 'partial-outage', 'major-outage', 'maintenance'];
const STATE_LABELS = {
	operational: 'Operational',
	degraded: 'Degraded',
	'partial-outage': 'Partial Outage',
	'major-outage': 'Major Outage',
	maintenance: 'Maintenance'
};
const SEVERITY_STATE = { minor: 'degraded', major: 'partial-outage', critical: 'major-outage' };
const STATUS_LABELS = { investigating: 'Investigating', identified: 'Identified', monitoring: 'Monitoring', resolved: 'Resolved' };
function componentOf(raw) {
	const s = String(raw ?? '').toLowerCase();
	if (s.includes('gateway') || s.includes('router') || s.includes('data plane')) return 'gateway';
	if (s.includes('dashboard') || s.includes('console') || s.includes('control plane')) return 'dashboard';
	if (s.includes('auth') || s.includes('session') || s.includes('sign')) return 'authentication';
	if (s.includes('billing') || s.includes('ledger') || s.includes('meter')) return 'billing';
	if (s.includes('database') || s.includes('postgres') || s.includes('valkey') || s.includes('db'))
		return 'database-services';
	return 'major-providers';
}
function stateFor(component, open) {
	const mine = open.filter((i) => i.component === component);
	if (mine.length === 0) return 'operational';
	if (mine.some((i) => i.status === 'maintenance')) return 'maintenance';
	let worst = 'operational';
	for (const i of mine) {
		const s = SEVERITY_STATE[i.severity] ?? 'degraded';
		if (COMPONENT_STATES.indexOf(s) > COMPONENT_STATES.indexOf(worst)) worst = s;
	}
	return worst;
}
function worse(a, b) {
	if (a === null) return b;
	if (b === null) return a;
	return COMPONENT_STATES.indexOf(a) >= COMPONENT_STATES.indexOf(b) ? a : b;
}
function probeState(key, probe) {
	if (key === 'dashboard') return 'operational';
	if (key === 'gateway') return probe.ok ? 'operational' : 'major-outage';
	if (key === 'database-services') {
		if (probe.ok) return 'operational';
		return probe.dbUnreachable ? 'major-outage' : null;
	}
	return null;
}
const BASIS = {
	gateway: 'Live probe and open incidents.',
	dashboard: 'This page rendered — the control plane is up — with open incidents overlaid.',
	authentication: 'Open incidents only — there is no independent sign-in probe.',
	billing: 'Open incidents only — there is no independent billing probe.',
	'database-services': 'Live probe and open incidents.',
	'major-providers': 'Open incidents only — upstream trouble is reported through incidents.'
};
async function probeDataPlane() {
	const base = process.env.ROUTER_BASE_URL ?? 'http://127.0.0.1:8100';
	const started = Date.now();
	const finish = (partial) => ({
		ok: false,
		dbUnreachable: false,
		error: null,
		service: '',
		models: null,
		latencyMs: Date.now() - started,
		checkedAt: new Date().toISOString(),
		...partial
	});
	let health;
	try {
		health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(4000) });
	} catch (e) {
		return finish({ error: e && e.name === 'TimeoutError' ? 'timed out after 4s' : 'unreachable' });
	}
	if (!health.ok) {
		let body = {};
		try {
			body = await health.json();
		} catch {
			/* non-JSON error body: fall through with the status code */
		}
		const detail = String(body.error ?? '').toLowerCase();
		return finish({ error: body.error ?? `HTTP ${health.status}`, dbUnreachable: detail.includes('database') });
	}
	let service = '';
	try {
		service = (await health.json()).service ?? '';
	} catch {
		/* a 200 with an unreadable body is still an answer */
	}
	let models = null;
	try {
		const list = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(4000) });
		if (list.ok) models = ((await list.json()).data ?? []).length;
	} catch {
		models = null;
	}
	return finish({ ok: true, service, models });
}

/* ---------------- tiny markdown renderer (changelog) ---------------- */
const AMP = String.fromCharCode(38);
const ENTITIES = { '&': AMP + 'amp;', '<': AMP + 'lt;', '>': AMP + 'gt;', '"': AMP + 'quot;' };
function escapeHtml(src) {
	return src.replace(/[&<>"]/g, (c) => ENTITIES[c] ?? c);
}
function inlineMd(pre) {
	let out = pre;
	out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
	out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
	out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, text, href) => {
		if (!/^(https?:\/\/|\/)/.test(href)) return whole;
		return `<a href="${href}">${text}</a>`;
	});
	return out;
}
function renderMarkdown(src) {
	const lines = escapeHtml(src).split('\n');
	const out = [];
	let para = [];
	let list = [];
	let code = null;
	const flushPara = () => {
		if (para.length) {
			out.push(`<p>${inlineMd(para.join(' '))}</p>`);
			para = [];
		}
	};
	const flushList = () => {
		if (list.length) {
			out.push(`<ul>${list.map((li) => `<li>${inlineMd(li)}</li>`).join('')}</ul>`);
			list = [];
		}
	};
	for (const line of lines) {
		if (code !== null) {
			if (line.startsWith('```')) {
				out.push(`<pre><code>${code.join('\n')}</code></pre>`);
				code = null;
			} else {
				code.push(line);
			}
			continue;
		}
		if (line.startsWith('```')) {
			flushPara();
			flushList();
			code = [];
			continue;
		}
		const heading = /^(#{2,3})\s+(.*)$/.exec(line);
		if (heading) {
			flushPara();
			flushList();
			const level = heading[1].length;
			out.push(`<h${level}>${inlineMd(heading[2])}</h${level}>`);
			continue;
		}
		const item = /^[-*]\s+(.*)$/.exec(line);
		if (item) {
			flushPara();
			list.push(item[1]);
			continue;
		}
		if (line.trim() === '') {
			flushPara();
			flushList();
			continue;
		}
		para.push(line.trim());
	}
	if (code !== null) out.push(`<pre><code>${code.join('\n')}</code></pre>`);
	flushPara();
	flushList();
	return out.join('\n');
}

/* ---------------- changelog (docs/changelog/*.md is the source of truth) ---------------- */
const CHANGELOG_DIR = path.join(__dirname, '..', '..', '..', 'docs', 'changelog');
function changelog() {
	let files = [];
	try {
		files = readdirSync(CHANGELOG_DIR)
			.filter((f) => f.endsWith('.md'))
			.sort()
			.reverse();
	} catch {
		return [];
	}
	return files.map((file) => {
		const raw = readFileSync(path.join(CHANGELOG_DIR, file), 'utf8');
		const match = /^#\s+(.+)$/m.exec(raw);
		return {
			slug: file.replace(/\.md$/, ''),
			title: match ? match[1].trim() : file,
			date: file.slice(0, 10),
			html: renderMarkdown(raw.replace(/^#\s+.+\s*$/, ''))
		};
	});
}

const QUICKSTART = `Five steps from nothing to a request that shows up in your logs. Each step
links to the dashboard page that performs it.

## 1. Sign in

Open [/login](/login) and approve the Discord prompt. There is no separate
signup form: the first sign-in provisions your account, workspace, a default
project and three environments (Development, Staging, Production) — nothing to
set up before step 2.

## 2. Create a project

Projects hold the environments, keys and logs for one application. Create one
at [/dashboard/projects/new](/dashboard/projects/new) and name it after what
the keys will serve. Every project starts with the three default environments.

## 3. Generate an API key

Inside the project, open **API Keys** and generate a key for the environment
you want to call from. Keys are shown exactly once and look like
\`sk-ar-<prefix>_<secret>\` — only \`sha256(secret)\` is stored, so copy it into
your secret manager before leaving the page.

## 4. First request

Send a chat completion to \`POST /v1/chat/completions\` with the \`sk-ar-\` key as
the bearer token. Any OpenAI-compatible client works; plain \`curl\` is enough
to verify the wiring:

\`\`\`text
curl ${publicApiBase()}/v1/chat/completions \\
  -H "Authorization: Bearer sk-ar-YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "grok-4.6", "messages": [{"role": "user", "content": "hello"}]}'
\`\`\`

The response body is the chat-completion shape your SDK expects, including a
\`usage\` block. Model slugs are listed on [/pricing](/pricing).

The key itself is minted at [/dashboard/keys](/dashboard/keys).

## 5. View request logs

Every call writes one ledger row. Open
[/dashboard/usage](/dashboard/usage) to see it: model, provider, tokens, cost,
latency and an error code when the call failed. If step 4 returned a body,
the row is already there.`;

const API_AUTHENTICATION = `Every API call authenticates with one header: the \`sk-ar-\` key from your
dashboard, sent as a bearer token.

\`\`\`text
Authorization: Bearer sk-ar-YOUR_KEY
\`\`\`

A missing, malformed or revoked key gets \`401\` with an
\`AUTHENTICATION_ERROR\`. Keys are stored hash-only (\`sha256(secret)\`), so a
secret cannot be recovered — generate a new key instead.

A key is bound to a workspace and can be scoped to a project and environment.
That scope decides which models and routing policy apply, and where the
request lands in your logs.`;

const API_MODELS = `\`GET /v1/models\` is served natively by the router: it lists the models your
key can actually reach, in the OpenAI list shape (\`object: "list"\` with
\`data\` entries carrying \`id\` and \`object: "model"\`).

\`\`\`text
curl ${publicApiBase()}/v1/models \\
  -H "Authorization: Bearer sk-ar-YOUR_KEY"
\`\`\`

Only published, reachable models appear — the same gate the request path
applies. The browsable version of the same data is [/pricing](/pricing), which
lists every published model with its price and context window.

The \`id\` is the canonical model slug: use it as \`model\` in chat completions.
See [Model identifiers](/docs/models/identifiers).`;

const API_CHAT = `\`POST /v1/chat/completions\` is served natively: the router authenticates,
applies the bound routing policy, picks a provider, meters tokens and writes
the ledger row before returning. The wire format is the OpenAI chat
completions shape.

Request body (the fields the playground sends; unknown fields pass through to
the provider):

- \`model\` — required. Canonical slug, model alias, or \`fudrouter/*\` virtual.
- \`messages\` — required. \`[{ "role": "user", "content": "…" }]\`. A system
  prompt is just a message with \`role: "system"\`.
- \`stream\` — \`true\` for SSE. See [Streaming](/docs/api/streaming).
- \`temperature\` — 0 to 2, provider permitting.
- \`max_tokens\` — positive integer cap on the completion.

\`\`\`text
curl ${publicApiBase()}/v1/chat/completions \\
  -H "Authorization: Bearer sk-ar-YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "grok-4.6", "messages": [{"role": "user", "content": "hello"}]}'
\`\`\`

A successful response is a chat completion: \`choices[].message.content\` for
the text and a \`usage\` block (\`prompt_tokens\`, \`completion_tokens\`,
\`total_tokens\`). Failures return the error shape from
[Errors](/docs/api/errors).`;

const API_RESPONSES = `\`POST /v1/responses\` is forwarded pass-through: the router authenticates,
meters and logs the call, then forwards the request body to the selected
provider unchanged and returns its response.

The forwarding is conditional on the body carrying a \`model\` field — that is
what routing keys off. Without it the request is rejected as an
\`INVALID_REQUEST\`.

This path is forwarded, not reimplemented: request and response shapes are
whatever the upstream accepts and returns. Chat completions is the native
path if you need guarantees about behavior.`;

const API_EMBEDDINGS = `\`POST /v1/embeddings\` is forwarded pass-through: the router authenticates,
meters and logs the call, then forwards the request body to the selected
provider unchanged and returns its embedding response.

The forwarding is conditional on the body carrying a \`model\` field — that is
what routing keys off. Without it the request is rejected as an
\`INVALID_REQUEST\`.

This path is forwarded, not reimplemented: the request and response shapes
are whatever the upstream accepts and returns.`;

const API_ERRORS = `Failures return a 4xx or 5xx status with one JSON body:

\`\`\`json
{"error": {"message": "what went wrong"}}
\`\`\`

\`error.message\` is a human-readable sentence. The machine-readable code is
the platform error taxonomy:

- \`AUTHENTICATION_ERROR\` — missing, malformed or revoked key (\`401\`)
- \`AUTHORIZATION_ERROR\` — the key may not do this (\`403\`)
- \`RATE_LIMITED\` — a key limit was hit (\`429\`)
- \`INSUFFICIENT_CREDITS\` — the billing account cannot cover the call (\`402\`)
- \`INVALID_REQUEST\` — malformed body or missing \`model\` (\`400\`)
- \`MODEL_NOT_FOUND\` — the slug or alias serves nothing (\`404\`)
- \`CONTEXT_TOO_LONG\` — input exceeds the model's context (\`413\`)
- \`UNSUPPORTED_PARAMETER\` — a parameter the route cannot honor
- \`CONTENT_REJECTED\` — the provider refused the content
- \`PROVIDER_TIMEOUT\` — the attempt hit its deadline (\`504\`)
- \`PROVIDER_UNAVAILABLE\` / \`CIRCUIT_OPEN\` — no usable route right now
- \`UPSTREAM_ERROR\` — the provider failed (\`5xx\`)
- \`INTERNAL_ERROR\` — anything on this side of the wire (\`500\`)

\`4xx\` statuses mean the request must change before retrying; \`5xx\` statuses
are retryable. The dashboard playground and the request logs show the same
codes — the request id in the
[x-fudrouter-request-id](/docs/api/headers) header ties them together.`;

const API_RATE_LIMITS = `Limits are configured per key and environment — there are no global numbers
to code against. Each API key carries its own limits (requests per minute,
tokens per minute and spend), and the bound policy decides what applies to a
given call.

When a call exceeds a configured limit the router answers \`429\` with a
\`RATE_LIMITED\` error and does not forward the request. Limits that must not
move: none are published here on purpose — check the key's configuration in
the dashboard for the values that apply to your traffic.`;

const API_HEADERS = `## Request

One header authenticates a call:

\`\`\`text
Authorization: Bearer sk-ar-YOUR_KEY
\`\`\`

Optional per-request headers are documented on their endpoints (for example
the routing strategy override the playground uses).

## Response

Every response — success or failure — carries the \`x-fudrouter-\` headers:

- \`x-fudrouter-request-id\` — the ledger id for this call. Quote it in
  support requests; it is the join key across logs, usage and billing.
- \`x-fudrouter-model\` — the model that actually served the request.
- \`x-fudrouter-provider\` — the provider that served it.
- \`x-fudrouter-latency\` — total router-side latency in milliseconds.

When a call fails over, these name the route that answered (or the last one
tried), and the request log records every attempt.`;

const API_STREAMING = `Set \`"stream": true\` on \`POST /v1/chat/completions\` and the response is
Server-Sent Events (\`text/event-stream\`): one \`data:\` frame per chunk in the
OpenAI chunk shape, terminated by a \`data: [DONE]\` line.

The final chunk carries the \`usage\` object (\`prompt_tokens\`,
\`completion_tokens\`, \`total_tokens\`) — the router asks the provider for usage
on streaming calls, so a stream is metered exactly like a buffered one.

\`\`\`text
data: {"id":"…","choices":[{"delta":{"content":"Hello"}}]}

data: {"id":"…","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":34,"total_tokens":46}}

data: [DONE]
\`\`\`

If the upstream fails mid-stream the SSE just ends early; the request log
still records the attempt and its error. Time to first token is recorded per
request as TTFT and shown in the logs.`;

const MODELS_MODELS = `A model in this platform is one upstream model served through one provider,
published under a canonical slug. The router refuses to serve a slug that is
not published and reachable — so the catalog and the request path always
agree.

Browse what is live at [/pricing](/pricing), which lists every published model
with its price and context window.

Prices are normalized to micro-units per 1M tokens so routes can be compared
(and billed) without floating-point money.`;

const MODELS_IDENTIFIERS = `A request names its model with a \`model\` field. Three kinds of identifier
work:

- **Canonical slug** — the stable id from the catalog (\`grok-4.6\`). Use this
  in code you control end to end.
- **Model alias** — a name your workspace defines (for example
  \`production-chat\`) that points at a target list. The alias is what your
  application sends, so targets can change without a redeploy.
- **Virtual form** — \`fudrouter/*\` names, resolved by the routing policy.

Whatever identifier you send, the response and the request log tell you what
actually ran: \`x-fudrouter-model\` on the response and the request log's model
fields record the resolved slug, not the alias you asked for.

The key that authorises any of them is minted at
[/dashboard/keys](/dashboard/keys).`;

const ROUTING_ROUTING = `Routing picks one route per request. The candidates are the reachable
connections serving the requested model; each is scored on price, latency,
reliability and capacity under the policy bound to the key.

The strategy decides how the winner is chosen: balanced (a blended score),
lowest cost, lowest latency, highest reliability, provider priority,
weighted, round robin or random. A key's bound policy sets the default; a
caller can override the strategy per request without loosening the policy's
attempt caps, timeouts or constraints.

The winning route is never hidden: the provider and model come back on the
response headers ([Headers](/docs/api/headers)) and every attempt is in the
request log. See [Fallback](/docs/routing/fallback) for what happens when the
winner fails.`;

const ROUTING_FALLBACK = `When an attempt fails in a retryable way, the router tries the next candidate
route instead of failing your call. Retryable failures are rate limits,
timeouts, provider unavailability, open circuits, provider-side 5xx errors
and transport errors.

Not retryable — the call fails immediately: invalid requests, unsupported
parameters, context-too-long, unknown models, authorization failures and
content rejections. Retrying those cannot succeed and would only burn
attempts.

Each request has an overall deadline: the router never starts an attempt
that cannot finish inside it. Attempts, the fallback flag and the failing
error are all recorded on the request log, so "this call cost two attempts"
is readable per request in [Usage](/docs/usage/usage).`;

const PROJECTS_PROJECTS = `The hierarchy is workspace → project → environment → API key.

- **Workspace** — the billing and team boundary. Members, roles and the
  billing account live here.
- **Project** — one application. Its keys, aliases, routing policy and logs
  hang off it.
- **Environment** — Development, Staging and Production are created with each
  project. Keys and limits are per environment, so a staging key cannot spend
  production money.
- **API key** — scoped to the project and environment it was made in. See
  [API Keys](/docs/api-keys/api-keys).

Create projects at [/dashboard/projects/new](/dashboard/projects/new); usage
and request logs break down by project and environment.`;

const APIKEYS_KEYS = `An API key is the \`sk-ar-<prefix>_<secret>\` string your client sends as a
bearer token. The plaintext is shown once at creation; only
\`sha256(secret)\` is stored, so a lost key is replaced, never recovered.

A key belongs to one user and is scoped to a workspace, and optionally to a
project and environment. Its scope and bound policy decide which models it
can reach, its rate and spend limits, and where its requests log.

Keys are managed at [/dashboard/keys](/dashboard/keys) or inside a project.
Rotate or revoke from the same pages — revocation takes effect immediately
for new requests. The playground runs in a key's context without ever knowing
its secret: it mints a short-lived run key scoped exactly like the original
and reclaims it when the run ends.`;

const USAGE_USAGE = `Every API call writes exactly one ledger row when it finishes: request id,
model, provider, tokens in and out, cost, latency, TTFT, attempts and an
error code when it failed. The ledger is append-only — it is the financial
and usage record.

Your view of it is [/dashboard/usage](/dashboard/usage): the request list
plus per-model and per-project totals. Cost is computed per request from the
normalized price of the route that served it, in integer micro-units — the
same number that appears in billing.

The request id (\`x-fudrouter-request-id\`) joins the ledger to the response
you received; when something looks wrong, that id is the one thing support
needs.`;

const OBSERVABILITY_OBSERVABILITY = `Observability is the request log, and it is deliberately one place. No
sampling, no separate tracing store: if a call happened, a row exists.

Per request: what was asked (model, key, project, environment), what ran
(resolved model, provider, connection, attempts, fallback), what it cost
(tokens, cost), how it went (status, error code, latency, TTFT) and when
(start, end). The playground's metrics panel reads the same rows as your
logs — there is no second source of truth.

Cross-surface, one id ties it together:
[\`x-fudrouter-request-id\`](/docs/api/headers) on the response is the ledger
row's id.`;

const BILLING_BILLING = `Billing is metered per request. Each call is priced from the normalized
per-1M-token price of the route that served it — input and output tokens are
billed separately — and the cost lands on the request's ledger row the moment
the call ends.

Money is stored and added in integer micro-units (1e-6 of the currency);
prices and totals never pass through a floating-point number. The per-request
cost is what rolls up in [Usage](/docs/usage/usage) and what the billing
account is charged against.

Invoices, credits, transactions and payment methods live at
[/dashboard/billing](/dashboard/billing). Per-model prices are on
[/pricing](/pricing).`;

const SDKS_SDKS = `There is no proprietary SDK to install. Every OpenAI-compatible client works
against this platform with two settings: the base URL and your \`sk-ar-\` key.

\`\`\`text
base URL: ${publicApiBase()}/v1
api key:  sk-ar-YOUR_KEY
\`\`\`

The OpenAI official SDKs (Python, Node.js, Go, .NET) and community clients
that speak the chat completions wire format all qualify. Point one at the
base URL above, use a canonical slug from [/pricing](/pricing) as the model,
and calls route, meter and log exactly like any other request.

What is native versus forwarded is listed in
[Compatibility](/docs/compatibility/openai-compatibility).`;

const COMPATIBILITY_COMPAT = `The wire format is OpenAI-compatible at the \`/v1\` base URL
(\`${publicApiBase()}/v1\`): an OpenAI SDK sends chat completions and
lists models without code changes beyond the base URL and key.

- **Native** — \`POST /v1/chat/completions\` and \`GET /v1/models\` are
  implemented by the router itself: routing, metering, streaming and errors
  are platform behavior.
- **Forwarded pass-through** — \`POST /v1/responses\` and
  \`POST /v1/embeddings\` are authenticated, metered and logged here, then
  forwarded to the provider unchanged (conditional on the body carrying
  \`model\`). Their behavior is the upstream's behavior.

Streaming is OpenAI-style SSE ([Streaming](/docs/api/streaming)) and usage is
reported in the same \`usage\` block shape. Anything not listed here is
untested — ask before relying on it.`;

const REFERENCE_REFERENCE = `The short answers, in one place.

## Endpoints

- \`POST /v1/chat/completions\` — native. [Chat Completions](/docs/api/chat-completions)
- \`GET /v1/models\` — native. [Models](/docs/api/models)
- \`POST /v1/responses\` — forwarded pass-through. [Responses](/docs/api/responses)
- \`POST /v1/embeddings\` — forwarded pass-through. [Embeddings](/docs/api/embeddings)
- \`GET /health\` — unauthenticated liveness probe (pings the database; \`503\`
  when it is unreachable).

## Conventions

- Authentication: \`Authorization: Bearer sk-ar-…\` —
  [Authentication](/docs/api/authentication)
- Errors: \`{"error": {"message": "…"}}\` plus the taxonomy code —
  [Errors](/docs/api/errors)
- Response headers: \`x-fudrouter-request-id\` / \`-model\` / \`-provider\` /
  \`-latency\` — [Headers](/docs/api/headers)
- Prices: integer micro-units per 1M tokens, input and output separate —
  [Pricing](/pricing)
- Ids: prefixed (\`req_\`, \`mdl_\`, \`prv_\`, \`sk-ar-\`) and unique across the
  platform.`;

const SECURITY_OVERVIEW = `The platform runs as two planes: the console (this site —
dashboard, keys, billing, the docs you are reading) and the router (the Go
data plane that serves \`/v1\`). They are separate processes with separate
deployments, and the console is deliberately **not** a security boundary for
the hot path.

The router re-authenticates every API key against \`sha256(secret)\`,
re-resolves the key's limits and re-guards every upstream dial
independently, so a compromised console cannot mint traffic the router
accepts. The console's own checks — role gates, URL validation — are
convenience and hygiene, not the line of defense.

Both planes carry their own SSRF guard: the shared rule in the platform
package for console-side fetches, and the router's dial-time guard for
upstream connections. See [The SSRF guard](/docs/security/ssrf).`;

const SECURITY_KEYS = `An API key is the \`sk-ar-<prefix>_<secret>\` string your client sends as a
bearer token. The prefix is stored in plaintext so keys are identifiable in
the dashboard and logs; only \`sha256(secret)\` is stored, and the plaintext
is shown exactly once at creation — a lost key is replaced, never recovered.
See [API keys](/docs/api-keys/api-keys).

Provider credentials — the upstream keys the platform uses to reach
providers — are encrypted at rest with AES-256-GCM under the
\`CREDENTIALS_MASTER_KEY\` environment variable. The plaintext is decrypted
only in the data plane, at the moment it dials an upstream; the console
never holds a usable provider key.`;

const SECURITY_SSRF = `The router's SSRF guard is a dialer control hook, not a URL pre-check. It
runs after DNS resolution and before the socket connects, which is what
makes it catch a hostname that resolves into private space (DNS rebinding)
as well as a literal private address — a URL check sees only the name and
cannot.

Redirects are covered by the same mechanism: each redirect opens a new
connection through the same transport, so every hop passes the guard again.
An unresolved hostname is refused outright — by the time the hook runs,
resolution has already happened, so a name at that point means the resolver
was bypassed and the guard cannot vouch for the target.`;

const MIGRATION_FROM_9ROUTER = `Provider credentials from a 9Router backup can be brought across with
\`ops/import-9router-backup.mjs\`. It is an operator-run script against a
local backup file — not something you run from the dashboard — and there is
no automatic cutover: nothing is switched over for you, the operator stages,
probes and imports deliberately.

What it actually does, in order:

- **Stage** — reads the backup's SQLite \`providerConnections\` and
  \`providerNodes\` rows and dumps them to a staging directory
  (\`--stage\`).
- **Map** — 9Router providers map to this platform's providers and
  credential tags (for example \`gemini\` → \`googleai\`, \`dahl\` →
  \`dahl\`, \`tokenharbor\` → \`tokenharbor\`, \`openrouter\` →
  \`openrouter\`; node-based connections map to their own providers).
  OAuth rows are reported but never imported, and providers with no
  counterpart here are reported, not invented.
- **Probe** — every candidate key is checked against its provider's
  \`GET /models\` endpoint before import; dead and inactive rows are never
  imported. Verdicts are cached so a re-run costs nothing upstream.
- **Dedup** — a key already present in a provider's connection is skipped;
  a secret is written at most once per provider.

After an import, work through [the verification
checklist](/docs/migration/checklist).`;

const MIGRATION_CHECKLIST = `After importing credentials from another platform, verify in this order:

1. **Provider count matches** — every provider you expect appears with the
   connections and credential health you expect.
2. **Aliases point at models that exist here** — an alias whose target this
   platform does not serve fails at request time. See
   [Model identifiers](/docs/models/identifiers).
3. **A test request per alias succeeds** — one real call each, and the
   response's model header shows the resolved slug.
4. **Balance is visible** — the billing account shows a balance at
   [/dashboard/billing](/dashboard/billing).

Keys and their format are covered in [API keys](/docs/api-keys/api-keys).`;

/** The docs tree, in the order the sidebar and index render it. */
export const DOC_CATEGORIES = [
	{
		slug: 'getting-started',
		title: 'Getting Started',
		pages: [{ slug: 'quickstart', title: 'Quickstart', markdown: QUICKSTART }]
	},
	{
		slug: 'api',
		title: 'API',
		pages: [
			{ slug: 'authentication', title: 'Authentication', markdown: API_AUTHENTICATION },
			{ slug: 'models', title: 'Models', markdown: API_MODELS },
			{ slug: 'chat-completions', title: 'Chat Completions', markdown: API_CHAT },
			{ slug: 'responses', title: 'Responses', markdown: API_RESPONSES },
			{ slug: 'embeddings', title: 'Embeddings', markdown: API_EMBEDDINGS },
			{ slug: 'errors', title: 'Errors', markdown: API_ERRORS },
			{ slug: 'rate-limits', title: 'Rate Limits', markdown: API_RATE_LIMITS },
			{ slug: 'headers', title: 'Headers', markdown: API_HEADERS },
			{ slug: 'streaming', title: 'Streaming', markdown: API_STREAMING }
		]
	},
	{
		slug: 'models',
		title: 'Models',
		pages: [
			{ slug: 'models', title: 'The model catalog', markdown: MODELS_MODELS },
			{ slug: 'identifiers', title: 'Model identifiers', markdown: MODELS_IDENTIFIERS }
		]
	},
	{
		slug: 'routing',
		title: 'Routing',
		pages: [
			{ slug: 'routing', title: 'How routing works', markdown: ROUTING_ROUTING },
			{ slug: 'fallback', title: 'Fallback and retries', markdown: ROUTING_FALLBACK }
		]
	},
	{
		slug: 'projects',
		title: 'Projects',
		pages: [{ slug: 'projects', title: 'Projects and environments', markdown: PROJECTS_PROJECTS }]
	},
	{
		slug: 'api-keys',
		title: 'API Keys',
		pages: [{ slug: 'api-keys', title: 'API keys', markdown: APIKEYS_KEYS }]
	},
	{
		slug: 'usage',
		title: 'Usage',
		pages: [{ slug: 'usage', title: 'Usage and request logs', markdown: USAGE_USAGE }]
	},
	{
		slug: 'observability',
		title: 'Observability',
		pages: [
			{ slug: 'observability', title: 'What gets recorded', markdown: OBSERVABILITY_OBSERVABILITY }
		]
	},
	{
		slug: 'billing',
		title: 'Billing',
		pages: [{ slug: 'billing', title: 'Metering and billing', markdown: BILLING_BILLING }]
	},
	{
		slug: 'sdks',
		title: 'SDKs',
		pages: [{ slug: 'sdks', title: 'Using an SDK', markdown: SDKS_SDKS }]
	},
	{
		slug: 'compatibility',
		title: 'Compatibility',
		pages: [
			{
				slug: 'openai-compatibility',
				title: 'OpenAI compatibility',
				markdown: COMPATIBILITY_COMPAT
			}
		]
	},
	{
		slug: 'reference',
		title: 'Reference',
		pages: [{ slug: 'reference', title: 'Quick reference', markdown: REFERENCE_REFERENCE }]
	},
	{
		slug: 'security',
		title: 'Security',
		pages: [
			{ slug: 'overview', title: 'How the planes are separated', markdown: SECURITY_OVERVIEW },
			{ slug: 'keys-and-credentials', title: 'Keys and credentials', markdown: SECURITY_KEYS },
			{ slug: 'ssrf', title: 'The SSRF guard', markdown: SECURITY_SSRF }
		]
	},
	{
		slug: 'migration',
		title: 'Migration',
		pages: [
			{ slug: 'from-9router', title: 'Migrating from 9Router', markdown: MIGRATION_FROM_9ROUTER },
			{ slug: 'checklist', title: 'Verification checklist', markdown: MIGRATION_CHECKLIST }
		]
	}
];

/** Every page flattened in reading order — prev/next and the index read this. */
export const DOC_FLAT = DOC_CATEGORIES.flatMap((category) =>
	category.pages.map((page) => ({
		path: `${category.slug}/${page.slug}`,
		categoryTitle: category.title,
		slug: page.slug,
		title: page.title,
		markdown: page.markdown
	}))
);

/** Lookup by rest param ("category-slug/page-slug"). Case- and slash-sensitive by design. */
export const DOC_BY_PATH = Object.fromEntries(
	DOC_FLAT.map((entry) => [entry.path, entry])
);

/* ---------------- route registration ---------------- */
export function registerPublicRoutes(app, ctx) {
	const { needDb, HttpError } = ctx;
	function handler(fn) {
		return async (req, res) => {
			try {
				const database = needDb(res);
				if (!database) return;
				await fn(database, req, res);
			} catch (err) {
				if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
				console.error('[public]', err);
				return res.status(500).json({ error: 'Public load failed' });
			}
		};
	}

	// Landing metric strip ((public)/+page.server.ts). The strip's labels say
	// "requests served (24h)" and "median latency", so the queries must match
	// the labels: the old code counted request_log over ALL time for the 24h
	// figure and printed a 24h MEAN as the median. Both fixed below.
	app.get('/api/metrics', handler(async (database, req, res) => {
		const metrics = { models: null, providers: null, calls24h: null, p50Ms: null };
		let sampleModels = [];
		try {
			const all = await servedModels(database);
			metrics.models = all.length;
			metrics.providers = new Set(all.flatMap((m) => m.providers.map((p) => p.providerName))).size;
			sampleModels = all.slice(0, 6).map(({ slug, name, context }) => ({ slug, name, context }));
			const [callsAgg, latencyAgg] = await Promise.all([
				database.execute(sql`select count(*)::int as n from request_log where created_at >= now() - interval '24 hours'`),
				database.execute(
					sql`select percentile_cont(0.5) within group (order by latency_ms) as p50 from request_log where status = 'success' and latency_ms is not null and created_at >= now() - interval '24 hours'`
				)
			]);
			metrics.calls24h = rowsOf(callsAgg)[0]?.n ?? 0;
			const p50 = rowsOf(latencyAgg)[0]?.p50;
			metrics.p50Ms = p50 == null ? null : Math.round(Number(p50));
		} catch (err) {
			console.error('[landing metrics]', err);
		}
		res.json({ metrics, sampleModels });
	}));

	// Field Web-Vitals beacon (src/lib/vitals.ts, 10% sample). Best-effort:
	// validates bounds, logs, never throws. No PII — path + numbers only.
	app.post('/api/metrics/vitals', (req, res) => {
		try {
			const b = req.body && typeof req.body === 'object' ? req.body : {};
			const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
			const vitals = {
				path: String(b.path ?? '').slice(0, 120),
				cls: num(b.cls, 0, 10), lcp: num(b.lcp, 0, 120000),
				inp: num(b.inp, 0, 60000), fcp: num(b.fcp, 0, 120000),
				ttfb: num(b.ttfb, 0, 120000),
			};
			if (vitals.path && (vitals.lcp !== null || vitals.cls !== null)) {
				console.log('[vitals]', JSON.stringify(vitals));
			}
		} catch { /* beacon must never fail the page */ }
		res.json({ ok: true });
	});
	app.get('/api/models', handler(async (database, req, res) => {
		const models = await servedModels(database);
		const q = req.query ?? {};
		const { filters, form } = parseFilters(q);
		const sort = SORT_KEYS.includes(q.sort) ? q.sort : 'name';
		const rows = sortModels(applyFilters(models, filters), sort);
		const { slugs: selected } = parseCompareList(typeof q.compare === 'string' ? q.compare : null);
		res.json({ models: rows, total: models.length, selected, options: filterOptions(models), form, sort });
	}));

	// Compare (models/compare/+page.server.ts).
	app.get('/api/models/compare', handler(async (database, req, res) => {
		const { slugs, truncated } = parseCompareList(req.query?.models);
		const all = await servedModels(database);
		const bySlug = new Map(all.map((m) => [m.slug, m]));
		const columns = [];
		const missing = [];
		for (const slug of slugs) {
			const m = bySlug.get(slug);
			if (m) columns.push(m);
			else missing.push(slug);
		}
		res.json({
			columns,
			missing,
			truncated,
			slugs,
			options: all.map((m) => ({ slug: m.slug, name: m.name }))
		});
	}));

	// Model detail (models/[slug]/+page.server.ts).
	app.get('/api/models/:slug', handler(async (database, req, res) => {
		const all = await servedModels(database);
		const model = all.find((m) => m.slug === req.params.slug);
		if (!model) return res.status(404).json({ error: 'Model not found' });
		res.json({
			model,
			capabilities: CAPABILITIES.map((key) => ({ key, value: effectiveCapability(model.capabilities, {}, key) })),
			identifiers: identifiersOf(model),
			curl: curlSample(model.slug)
		});
	}));

	// Provider directory (providers/+page.server.ts).
	app.get('/api/providers', handler(async (database, req, res) => {
		const models = await servedModels(database);
		res.json({ providers: providerRows(models) });
	}));

	// Provider detail (providers/[slug]/+page.server.ts).
	app.get('/api/providers/:slug', handler(async (database, req, res) => {
		const needle = String(req.params.slug ?? '').toLowerCase();
		const models = await servedModels(database);
		const rows = providerRows(models);
		const row =
			rows.find((r) => (r.slug ?? '').toLowerCase() === needle) ??
			rows.find((r) => r.name.toLowerCase() === needle);
		if (!row) return res.status(404).json({ error: 'Provider not found' });
		let meta = { description: null, type: null, homepage: null, documentationUrl: null };
		try {
			const mrows = rowsOf(
				await database.execute(
					sql`select description, type, homepage, documentation_url from provider where name = ${row.name} limit 1`
				)
			);
			if (mrows[0]) {
				meta = {
					description: mrows[0].description ?? null,
					type: mrows[0].type ?? null,
					homepage: mrows[0].homepage ?? null,
					documentationUrl: mrows[0].documentation_url ?? null
				};
			}
		} catch {
			/* identity/marketing fields degrade to nulls, never a 500 */
		}
		const served = modelsOf(models, row.name).map((m) => {
			const link = m.providers.find((p) => p.providerName === row.name);
			const price = link?.price ?? m.price;
			return {
				slug: m.slug,
				name: m.name,
				context: m.context,
				price,
				hasProviderPrice: link?.price != null,
				providerPrice: link?.price ?? null,
				widePrice: m.price,
				availability: link?.availability ?? null
			};
		});
		let incidents = [];
		try {
			const all = rowsOf(
				await database.execute(
					sql`select id, title, component, severity, status, started_at, resolved_at from incident order by started_at desc`
				)
			);
			const nameNeedle = row.name.toLowerCase();
			const relevant = all
				.filter(
					(i) =>
						componentOf(i.component) === 'major-providers' ||
						String(i.component ?? '').toLowerCase().includes(nameNeedle)
				)
				.slice(0, 10);
			let latest = new Map();
			if (relevant.length) {
				const urows = rowsOf(
					await database.execute(sql`
						select incident_id, message, created_at from incident_update
						where incident_id in (${sql.join(
							relevant.map((i) => sql`${i.id}`),
							sql`, `
						)})
						order by created_at desc`)
				);
				for (const u of urows) {
					if (!latest.has(u.incident_id)) {
						latest.set(u.incident_id, { message: u.message, createdAt: iso(u.created_at) });
					}
				}
			}
			incidents = relevant.map((i) => ({
				id: i.id,
				title: i.title,
				severity: i.severity,
				status: i.status,
				startedAt: iso(i.started_at),
				resolvedAt: iso(i.resolved_at),
				latestUpdate: latest.get(i.id) ?? null
			}));
		} catch {
			incidents = [];
		}
		res.json({
			provider: { name: row.name, slug: row.slug, status: row.status },
			meta,
			capabilities: row.capabilities,
			regions: row.regions,
			availability: row.availability,
			performance: { p50Ms: row.p50Ms, p95Ms: row.p95Ms },
			models: served,
			pricingOverrides: served.filter((m) => m.hasProviderPrice),
			incidents
		});
	}));

	// Pricing (pricing/+page.server.ts).
	app.get('/api/pricing', handler(async (database, req, res) => {
		const models = await servedModels(database);
		const groups = new Map();
		for (const m of models) {
			const key = m.developer ?? 'Unknown';
			const list = groups.get(key);
			if (list) list.push(m);
			else groups.set(key, [m]);
		}
		const developers = [...groups.keys()].sort((a, b) => a.localeCompare(b));
		res.json({
			groups: developers.map((developer) => ({
				developer,
				models: groups
					.get(developer)
					.sort((a, b) => a.name.localeCompare(b.name))
					.map((m) => ({
						slug: m.slug,
						name: m.name,
						price: m.price,
						context: m.context,
						variesByProvider: m.providers.some((p) => p.price !== null)
					}))
			})),
			hasReasoning: models.some((m) => m.price.reasoningPriceMicro !== null)
		});
	}));

	// Status (status/+page.server.ts).
	app.get('/api/status', handler(async (database, req, res) => {
		const probe = await probeDataPlane();
		let incidents = null;
		let openIncidents = null;
		let dbErrorRequestId = null;
		try {
			const open = rowsOf(
				await database.execute(
					sql`select id, title, severity, status, component, started_at, resolved_at from incident where status <> 'resolved'`
				)
			);
			openIncidents = open.map((r) => ({ component: componentOf(r.component), severity: r.severity, status: r.status }));
			const rows = rowsOf(
				await database.execute(sql`
					select id, title, severity, status, component, started_at, resolved_at from incident
					order by case when status = 'resolved' then 1 else 0 end, started_at desc
					limit 50`)
			);
			const label = (s) => STATUS_LABELS[s] ?? String(s).charAt(0).toUpperCase() + String(s).slice(1);
			incidents = rows.map((r) => ({
				id: r.id,
				title: r.title,
				severity: r.severity,
				status: r.status,
				statusLabel: label(r.status),
				componentLabel: COMPONENT_LABELS[componentOf(r.component)],
				startedAt: iso(r.started_at),
				resolvedAt: iso(r.resolved_at)
			}));
		} catch {
			incidents = null;
			openIncidents = null;
			dbErrorRequestId = `req_${Date.now().toString(36)}`;
		}
		const components = STATUS_COMPONENTS.map((key) => {
			const fromIncidents = openIncidents === null ? null : stateFor(key, openIncidents);
			const state = worse(fromIncidents, probeState(key, probe));
			return {
				key,
				label: COMPONENT_LABELS[key],
				description: COMPONENT_DESCRIPTIONS[key],
				state,
				stateLabel: state ? STATE_LABELS[state] : 'Unknown',
				basis: BASIS[key]
			};
		});
		let overall = null;
		for (const c of components) overall = worse(overall, c.state);
		res.json({ probe, incidents, dbErrorRequestId, components, overall: { state: overall, label: overall ? STATE_LABELS[overall] : 'Unknown' } });
	}));

	// Incident detail (status/incidents/[id]/+page.server.ts).
	app.get('/api/status/incidents/:id', handler(async (database, req, res) => {
		let row;
		let updates = [];
		try {
			const rows = rowsOf(
				await database.execute(sql`select id, title, component, severity, status, started_at, resolved_at from incident where id = ${req.params.id} limit 1`)
			);
			row = rows[0];
			if (row) {
				updates = rowsOf(
					await database.execute(
						sql`select status, message, created_at from incident_update where incident_id = ${req.params.id} order by created_at asc`
					)
				);
			}
		} catch {
			return res.status(503).json({ error: 'Incident unavailable' });
		}
		if (!row) return res.status(404).json({ error: 'Incident not found' });
		const label = (s) => STATUS_LABELS[s] ?? String(s).charAt(0).toUpperCase() + String(s).slice(1);
		const timeline =
			updates.length > 0
				? updates.map((u) => ({
						status: u.status,
						statusLabel: label(u.status),
						message: u.message,
						createdAt: iso(u.created_at),
						synthesized: false
					}))
				: [
						{
							status: row.status,
							statusLabel: label(row.status),
							message: 'A step-by-step timeline was not recorded for this incident.',
							createdAt: iso(row.resolved_at ?? row.started_at),
							synthesized: true
						}
					];
		res.json({
			incident: {
				id: row.id,
				title: row.title,
				component: componentOf(row.component),
				componentLabel: COMPONENT_LABELS[componentOf(row.component)],
				severity: row.severity,
				status: row.status,
				statusLabel: label(row.status),
				startedAt: iso(row.started_at),
				resolvedAt: iso(row.resolved_at)
			},
			timeline
		});
	}));

	// Docs index + page (docs/[...slug]/+page.server.ts).
	app.get('/api/docs', (_req, res) => {
		res.json({
			categories: DOC_CATEGORIES.map((c) => ({
				slug: c.slug,
				title: c.title,
				pages: DOC_FLAT.filter((e) => e.path.startsWith(`${c.slug}/`))
			}))
		});
	});
	app.get('/api/docs/{*path}', (req, res) => {
		const raw = req.params.path ?? req.params[0] ?? '';
		const p = String(Array.isArray(raw) ? raw.join('/') : raw).replace(/^\/+|\/+$/g, '');
		const entry = DOC_BY_PATH[p] ?? null;
		if (!entry) return res.status(404).json({ error: 'Page not found' });
		const at = DOC_FLAT.findIndex((c) => c.path === entry.path);
		res.json({ entry, prev: at > 0 ? DOC_FLAT[at - 1] : null, next: at < DOC_FLAT.length - 1 ? DOC_FLAT[at + 1] : null });
	});

	// Changelog index + entry.
	app.get('/api/changelog', (_req, res) => {
		res.json({ entries: changelog() });
	});
	app.get('/api/changelog/:slug', (req, res) => {
		const entry = changelog().find((e) => e.slug === req.params.slug) ?? null;
		if (!entry) return res.status(404).json({ error: 'Entry not found' });
		res.json({ entry });
	});
}
