#!/usr/bin/env node
// ops/health-triage.mjs — ONE read-only view of fleet health: which providers,
// connections, credentials and models are actually servable, what is blocking
// each one, and what to do about it.
//
// WHY THIS EXISTS. The request_log showed `deepseek-v4-flash-0731` failing
// 503 while `prv_dahl` served 171/171, and providers with tens of thousands of
// credentials (prv_gonka24: 20,006; prv_zro: 452) never appeared in traffic at
// all. Two different failure layers were being read as one story — "provider
// down" — when the real causes were: connection disabled despite healthy
// signals (zro: availability 1.0, 822 samples, enabled=f), every credential
// bulk-invalid (zro, freemodel), and an upstream that times out with healthy
// credentials (crowllm). A single surface that explains each layer separately
// is what the operator needs before touching anything.
//
// The routing predicate is mirrored EXACTLY from backend/go/internal/store
// catalog.go (displayWinnerCTE + CandidatesBatch): a provider is servable when
//   provider.enabled AND provider tier commercial-or-dev AND status not in
//   (disabled, maintenance, outage) AND connection.enabled AND
//   connection.health_status <> 'unhealthy' AND at least one credential with
//   status not in (disabled, invalid) AND not cooling.
// Every count in this report uses that same gate, so the report answers "what
// would the router actually dial right now?" — not "what looks healthy".
//
// Usage: set -a && . .env && set +a && node ops/health-triage.mjs [--probe N]
//   --probe N   live-probe up to N credentials per ENABLED connection whose
//               pool looks usable, to confirm the upstream answers. Off by
//               default; probes are real chat completions (max_tokens 1).
import postgres from 'postgres';

const PROBE = Number(process.argv[process.argv.indexOf('--probe') + 1] || 0);
const sql = postgres(process.env.DATABASE_URL, { max: 2, idle_timeout: 5 });

const PROBE_TIMEOUT = 25000;
const PROBE_MODEL = 'deepseek-v4-flash-0731'; // the most-tested live model

// ---- fetch the whole fleet once -----------------------------------------
const providers = await sql`
	select p.id, p.name, p.status, p.enabled, p.tier, p.priority,
	       p.base_url
	from provider p order by p.priority, p.id`;

const connections = await sql`
	select c.id, c.provider_id, c.enabled, c.health_status, c.base_url, c.config
	from connection c order by c.provider_id, c.slug`;

const credentials = await sql`
	select cr.id, cr.connection_id, cr.status, cr.priority, cr.cooldown_until
	from credential cr order by cr.connection_id, cr.priority, cr.id`;

const models = await sql`
	select m.id, m.slug, m.status, m.capabilities, m.provider_id
	from model m order by m.slug`;

const mappings = await sql`
	select pm.id, pm.model_id, pm.provider_id, pm.connection_id, pm.enabled, pm.status,
	       pm.provider_model_id
	from provider_model pm order by pm.provider_id, pm.model_id`;

const aliases = await sql`
	select alias, canonical_model_id from model_slug_alias`;

// ---- indexes ---------------------------------------------------------------
const connByProv = new Map();
for (const c of connections) {
	const l = connByProv.get(c.provider_id) || [];
	l.push(c);
	connByProv.set(c.provider_id, l);
}
const credsByConn = new Map();
for (const cr of credentials) {
	const l = credsByConn.get(cr.connection_id) || [];
	l.push(cr);
	credsByConn.set(cr.connection_id, l);
}
const aliasTo = new Map(aliases.map(a => [a.alias.toLowerCase(), a.canonical_model_id]));
const canonicalOf = new Map();
for (const a of aliases) canonicalOf.set(a.canonical_model_id, (canonicalOf.get(a.canonical_model_id)||[]).concat(a.alias));
const pmByModel = new Map();
for (const pm of mappings) {
	const l = pmByModel.get(pm.model_id) || [];
	l.push(pm);
	pmByModel.set(pm.model_id, l);
}

// ---- the exact routing gate -------------------------------------------------
function connServable(c) {
	return c.enabled && (c.health_status ?? 'unknown') !== 'unhealthy';
}
function credUsable(cr) {
	return cr.status !== 'disabled' && cr.status !== 'invalid' &&
		(!cr.cooldown_until || new Date(cr.cooldown_until) <= new Date());
}
function providerServable(p) {
	if (!p.enabled) return 'provider disabled';
	if (p.tier !== 'commercial' && p.tier !== 'dev') return `tier ${p.tier}`;
	if (['disabled', 'maintenance', 'outage'].includes(p.status)) return `provider status ${p.status}`;
	return '';
}

// ---- credential layer -------------------------------------------------------
const credSummary = new Map(); // connection_id -> {total, usable, byStatus}
for (const cr of credentials) {
	const s = credSummary.get(cr.connection_id) || { total: 0, usable: 0, byStatus: {} };
	s.total++;
	s.byStatus[cr.status] = (s.byStatus[cr.status] || 0) + 1;
	if (credUsable(cr)) s.usable++;
	credSummary.set(cr.connection_id, s);
}

// ---- model layer ------------------------------------------------------------
const modelReport = new Map(); // model_id -> {slug, providers:Set, servable:Set, viaAlias:bool}
for (const m of models) {
	if (m.status !== 'active' || m.capabilities?.chat === false) continue;
	const r = modelReport.get(m.id) || { slug: m.slug, providers: new Set(), servable: new Set() };
	modelReport.set(m.id, r);
}
for (const pm of mappings) {
	const r = modelReport.get(pm.model_id);
	if (!r || !pm.enabled || pm.status === 'unavailable' || pm.status === 'disabled') continue;
	r.providers.add(pm.provider_id);
	const conn = connections.find(c => c.id === pm.connection_id);
	const p = providers.find(p => p.id === pm.provider_id);
	if (conn && connServable(conn) && p && !providerServable(p) === '' ) {
		const cs = credSummary.get(pm.connection_id);
		if (cs && cs.usable > 0) r.servable.add(pm.provider_id);
	}
}
// alias fan-out: a model that is the canonical target of an alias gains that
// alias's own provider mappings (the routing identity union).
for (const a of aliases) {
	const tgt = modelReport.get(a.canonical_model_id);
	const src = modelReport.get(a.alias);
	if (!tgt || !src) continue;
	for (const p of src.providers) tgt.providers.add(p);
	for (const p of src.servable) tgt.servable.add(p);
}

// ---- report -----------------------------------------------------------------
console.log(`\n=== FLEET HEALTH TRIAGE (${new Date().toISOString()}) ===`);
console.log(`providers=${providers.length} connections=${connections.length} ` +
	`credentials=${credentials.length} models=${models.length} mappings=${mappings.length} aliases=${aliases.length}\n`);

for (const p of providers) {
	const conns = connByProv.get(p.id) || [];
	const provGate = providerServable(p);
	let poolUsable = 0, poolTotal = 0;
	const connLines = [];
	for (const c of conns) {
		const cs = credSummary.get(c.id) || { total: 0, usable: 0, byStatus: {} };
		poolTotal += cs.total; poolUsable += cs.usable;
		const gate = [];
		if (!c.enabled) gate.push('conn.enabled=false');
		if (c.health_status === 'unhealthy') gate.push('conn.unhealthy');
		if (cs.total === 0) gate.push('no credentials');
		else if (cs.usable === 0) gate.push(`all ${cs.total} creds unusable (${Object.entries(cs.byStatus).map(([k,v])=>`${k}=${v}`).join(', ')})`);
		const cfg = c.config || {};
		const sig = cfg.signal_updated_at ? `, signal@${cfg.signal_updated_at}` : '';
		connLines.push(`    conn ${c.id} enabled=${c.enabled} health=${c.health_status} ` +
			`creds=${cs.total}(usable ${cs.usable}) ${gate.length ? 'BLOCKED: '+gate.join(' + ') : 'OK'} ` +
			`[${cfg.availability ?? '?'} avail, ${cfg.p95_latency_ms ?? '?'}ms p95${sig}]`);
	}
	const total = poolTotal;
	const usable = poolUsable;
	const blocked = provGate || (conns.every(c => !connServable(c)) ? 'no servable connection' : '') ||
		(usable === 0 ? 'pool empty' : '');
	console.log(`${blocked ? '✗' : '✓'} ${p.id} (${p.name}) prio=${p.priority} ${p.status} tier=${p.tier} ` +
		`enabled=${p.enabled} creds=${total}/${usable}`);
	if (provGate) console.log(`    provider gate: ${provGate}`);
	for (const l of connLines) console.log(l);
	if (!blocked) {
		// model coverage through this provider
		const served = mappings.filter(pm => pm.provider_id === p.id && pm.enabled && pm.status !== 'unavailable' && pm.status !== 'disabled');
		const uniqueModels = new Set(served.map(pm => pm.model_id));
		console.log(`    serves ${uniqueModels.size} model rows` +
			(served.length !== uniqueModels.size ? ` (${served.length} mappings)` : ''));
	}
	console.log('');
}

// ---- models with NO servable provider ----------------------------------------
console.log('=== MODELS WITH NO SERVABLE PROVIDER (client would 503/404) ===');
let orphanModels = 0;
for (const [id, r] of modelReport) {
	if (r.servable.size > 0) continue;
	orphanModels++;
	const provList = [...r.providers].map(pid => {
		const p = providers.find(x => x.id === pid);
		const pm = mappings.find(m => m.model_id === id && m.provider_id === pid);
		const conn = connections.find(c => c.id === pm?.connection_id);
		const why = [];
		if (!pm?.enabled || pm?.status === 'unavailable' || pm?.status === 'disabled') why.push(`mapping ${pm?.status ?? 'disabled'}`);
		if (conn && !conn.enabled) why.push('conn disabled');
		if (conn && conn.health_status === 'unhealthy') why.push('conn unhealthy');
		if (p) {
			const g = providerServable(p); if (g) why.push(g);
		}
		return `${pid}(${why.join('+') || 'no creds'})`;
	}).join(', ');
	console.log(`  ${r.slug}  [${provList}]`);
}
console.log(`\n${orphanModels} chat models have no servable provider.`);

// ---- combo sanity -------------------------------------------------------------
console.log('\n=== COMBO (display-family) COVERAGE ===');
const famByCanon = new Map(); // canonical slug -> [slugs]
for (const [id, r] of modelReport) {
	const canon = aliasTo.get(r.slug.toLowerCase()) || r.slug;
	const fam = famByCanon.get(canon) || [];
	fam.push(r.slug);
	famByCanon.set(canon, fam);
}
for (const [canon, slugs] of famByCanon) {
	const serv = slugs.map(s => modelReport.get(s)?.servable.size || 0);
	const max = Math.max(...serv);
	const total = Math.max(...slugs.map(s => modelReport.get(s)?.providers.size || 0));
	if (slugs.length > 1)
		console.log(`  ${canon}: ${slugs.length} spellings, ${total} providers, ${max} servable → ${max>0?'OK':'DEGRADED'}`);
}

// ---- optional live probe -------------------------------------------------------
if (PROBE > 0) {
	const { decryptCredentials } = await import('@fudrouter/platform/server/credentials.ts');
	console.log(`\n=== LIVE PROBE (${PROBE} creds per usable connection, model=${PROBE_MODEL}) ===`);
	// Probe EVERY connection that holds credentials, enabled or not: an
	// `enabled=false` connection (zro, freemodel, gonka24) is exactly the case
	// whose upstream liveness decides whether disabling was right. A disabled
	// connection whose keys still answer can be re-enabled; one whose keys are
	// rejected upstream should stay disabled.
	const targets = connections.filter(c => (credSummary.get(c.id)?.total || 0) > 0);
	for (const c of targets.slice(0, 25)) {
		const usableCreds = (credentials.filter(cr => cr.connection_id === c.id)).slice(0, PROBE);
		if (!usableCreds.length) continue;
		const p = providers.find(p => p.id === c.provider_id);
		let ok = 0, authed = 0;
		for (const cr of usableCreds) {
			try {
				const row = await sql`select secret_enc from credential where id=${cr.id}`;
				const { api_key, access_token } = decryptCredentials(row[0].secret_enc);
				const t0 = Date.now();
				const res = await fetch(`${c.base_url.replace(/\/+$/,'')}/chat/completions`, {
					method: 'POST',
					headers: { Authorization: `Bearer ${api_key || access_token}`, 'Content-Type': 'application/json' },
					body: JSON.stringify({ model: PROBE_MODEL, messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 1 }),
					signal: AbortSignal.timeout(PROBE_TIMEOUT),
				});
				const ms = Date.now() - t0;
				const b = await res.text().catch(() => '');
				authed++;
				if (res.ok) { ok++; console.log(`  ✓ ${p.id} ${c.id} (enabled=${c.enabled}): ${res.status} ${ms}ms`); }
				else console.log(`  ✗ ${p.id} ${c.id} (enabled=${c.enabled}): ${res.status} ${ms}ms ${b.slice(0,80)}`);
			} catch (e) {
				console.log(`  ✗ ${p.id} ${c.id}: ERR ${String(e.message).slice(0,80)}`);
			}
		}
		if (ok === 0 && usableCreds.length > 0 && authed > 0) console.log(`  → ${p.id}: 0/${usableCreds.length} live creds answer; upstream rejecting the pool`);
	}
}

await sql.end({ timeout: 1 });
