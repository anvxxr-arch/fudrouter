#!/usr/bin/env node
/**
 * merge-model-prefixes.mjs — collapse `providerA/modelA` duplicates into the
 * canonical `modelA` so the catalog publishes ONE name per model and the
 * router picks the provider adaptively (signals now flow, see
 * routing_signals_refresh).
 *
 * Rules:
 *  - org prefix (zai-org/, nvidia/, ...)          -> base = remainder
 *  - inferhub alias (ali|cb|cbcn|cc|ag|cp|ocg|cmc|cx, possibly 2 segments)
 *    -> longest suffix that matches an existing model wins, else last segment
 *  - canonical match is case-insensitive; active canonical preferred
 *  - mappings are NEVER dropped unless an identical
 *    (provider, connection, provider_model_id) row already exists on the
 *    canonical -- they are re-pointed, then the duplicate model row is deleted
 *  - an open model-level pricing rule migrates to the canonical when the
 *    canonical has none (otherwise the duplicate cascades away)
 *
 * Usage: node merge-model-prefixes.mjs [--apply]
 */
import postgres from 'postgres';

const APPLY = process.argv.includes('--apply');

const INFERHUB_ALIASES = new Set([
	'ag', 'ali', 'cb', 'cbcn', 'cc', 'cmc', 'cp', 'cx', 'ocg'
]);

const sql = postgres(process.env.DATABASE_URL, { max: 1, idle_timeout: 5 });

const rows = await sql`
	select m.id, m.slug, m.status,
		coalesce(
			(select jsonb_agg(jsonb_build_object(
				'pmId', pm.id,
				'provider', p.slug,
					'providerId', p.id,
				'connection', pm.connection_id,
				'upstream', pm.provider_model_id,
				'enabled', pm.enabled,
				'status', pm.status
			) order by p.slug)
			from provider_model pm
			join provider p on p.id = pm.provider_id
			where pm.model_id = m.id),
			'[]'::jsonb
		) as mappings
	from model m
	where m.status = 'active' and m.slug like '%/%'
	order by m.slug
`;

// every model slug, lowercased -> {id, slug, status}; active preferred
const allModels = await sql`select id, slug, status from model`;
const byLower = new Map();
for (const m of allModels) {
	const key = m.slug.toLowerCase();
	const prev = byLower.get(key);
	if (!prev || (prev.status !== 'active' && m.status === 'active')) {
		byLower.set(key, m);
	}
}

function findCanonical(base) {
	const hit = byLower.get(base.toLowerCase());
	if (!hit) return null;
	// never target a prefixed slug
	if (hit.slug.includes('/')) return null;
	return hit;
}

function computeBase(slug) {
	const segs = slug.split('/');
	if (segs.length < 2) return null;
	if (INFERHUB_ALIASES.has(segs[0])) {
		// longest suffix that matches an existing model
		for (let i = 1; i < segs.length; i++) {
			const suffix = segs.slice(i).join('/');
			if (findCanonical(suffix)) return suffix;
		}
		return segs[segs.length - 1];
	}
	return segs.slice(1).join('/');
}

const LIVE_PROVIDERS = new Set([
	'prv-openrouter', 'prv-dahl', 'prv-unikey', 'cline',
	'prv-googleai', 'prv-gonka24', 'prv-kiro', 'freeai', 'tt',
	'prv-9316bf5d-0fde-412a-9ac0-89344cfd1d37'
]);

const LIVE_LIST = [...LIVE_PROVIDERS];

const plan = [];
for (const r of rows) {
	const base = computeBase(r.slug);
	if (!base || base === r.slug) continue;
	const mappings = r.mappings;
	const live = mappings.filter((m) => LIVE_PROVIDERS.has(m.provider));
	const canonical = findCanonical(base);
	plan.push({
		from: r.slug,
		fromId: r.id,
		base,
		canonical: canonical ? canonical.slug : null,
		canonicalId: canonical ? canonical.id : null,
		canonicalStatus: canonical ? canonical.status : null,
		liveMappings: live.length,
		totalMappings: mappings.length,
		mappings
	});
}

const merges = plan.filter((p) => p.canonical);
const renames = plan.filter((p) => !p.canonical);

console.log(`\n=== MERGE into existing canonical (${merges.length}) ===`);
for (const p of merges) {
	const dup = p.mappings.length;
	console.log(
		`${p.from}  ->  ${p.canonical}${p.canonicalStatus !== 'active' ? ' (was ' + p.canonicalStatus + ')' : ''}` +
		`  [${p.liveMappings} live / ${dup} mappings re-pointed]`
	);
}

console.log(`\n=== RENAME, no canonical exists (${renames.length}) ===`);
for (const p of renames) {
	console.log(
		`${p.from}  ->  ${p.base}  [${p.liveMappings} live / ${p.totalMappings} mappings]`
	);
}

// collision check: two renames targeting the same base
const baseCount = new Map();
for (const p of renames) baseCount.set(p.base, (baseCount.get(p.base) ?? 0) + 1);
const collisions = [...baseCount.entries()].filter(([, n]) => n > 1);
if (collisions.length) {
	console.log('\n=== RENAME COLLISIONS (need merge-among-aliases) ===');
	for (const [base, n] of collisions) {
		const group = renames.filter((p) => p.base === base);
		console.log(`${base}  <-  ${group.map((g) => g.from).join(' + ')}`);
	}
}

if (!APPLY) {
	console.log('\n(dry run -- pass --apply to execute)');
	await sql.end();
	process.exit(0);
}

// ---------------- apply ----------------
console.log('\n=== APPLYING ===');
let repointed = 0;
let droppedDup = 0;
let modelsDeleted = 0;
let modelsRenamed = 0;
let pricingMoved = 0;
let caseMerged = 0;
let reactivated = 0;

await sql.begin(async (tx) => {
// ---------- phase 1: prefix merge / rename ----------
// group renames by base so alias-vs-alias collisions merge into one row
const renameGroups = new Map();
for (const p of renames) {
	if (!renameGroups.has(p.base)) renameGroups.set(p.base, []);
	renameGroups.get(p.base).push(p);
}

for (const p of merges) {
	// existing (provider, connection, upstream) on the canonical
	const existing = await tx`
		select provider_id, connection_id, provider_model_id
		from provider_model where model_id = ${p.canonicalId}
	`;
	const existSet = new Set(
		existing.map((e) => `${e.provider_id}|${e.connection_id ?? ''}`)
	);
	for (const m of p.mappings) {
		const key = `${m.providerId}|${m.connection ?? ''}`;
		if (existSet.has(key)) {
			await tx`delete from provider_model where id = ${m.pmId}`;
			droppedDup++;
			continue;
		}
		await tx`update provider_model set model_id = ${p.canonicalId}, updated_at = now() where id = ${m.pmId}`;
		repointed++;
		existSet.add(key);
	}
	// migrate an open model-level pricing rule when canonical has none
	const canonRule = await tx`
		select id from pricing_rule
		where model_id = ${p.canonicalId} and provider_model_id is null and effective_until is null
		limit 1
	`;
	if (canonRule.length === 0) {
		const moved = await tx`
			update pricing_rule set model_id = ${p.canonicalId}
			where model_id = ${p.fromId} and provider_model_id is null and effective_until is null
		`;
		pricingMoved += moved.count;
	}
	await tx`update model set status = 'inactive', updated_at = now() where id = ${p.fromId}`;
	modelsDeleted++;
	if (p.liveMappings > 0 && p.canonicalStatus !== 'active') {
		await tx`update model set status = 'active', updated_at = now() where id = ${p.canonicalId}`;
		reactivated++;
	}
}

for (const [base, group] of renameGroups) {
	const keeper = group[0];
	await tx`update model set slug = ${base}, updated_at = now() where id = ${keeper.fromId}`;
	modelsRenamed++;
	if (group.length === 1) continue;
	// fold the rest into the keeper
	const existing = await tx`
		select provider_id, connection_id, provider_model_id
		from provider_model where model_id = ${keeper.fromId}
	`;
	const existSet = new Set(
		existing.map((e) => `${e.provider_id}|${e.connection_id ?? ''}`)
	);
	for (const p of group.slice(1)) {
		for (const m of p.mappings) {
			const key = `${m.providerId}|${m.connection ?? ''}`;
			if (existSet.has(key)) {
				await tx`delete from provider_model where id = ${m.pmId}`;
				droppedDup++;
				continue;
			}
			await tx`update provider_model set model_id = ${keeper.fromId}, updated_at = now() where id = ${m.pmId}`;
			repointed++;
			existSet.add(key);
		}
		const canonRule = await tx`
			select id from pricing_rule
			where model_id = ${keeper.fromId} and provider_model_id is null and effective_until is null
			limit 1
		`;
		if (canonRule.length === 0) {
			const moved = await tx`
				update pricing_rule set model_id = ${keeper.fromId}
				where model_id = ${p.fromId} and provider_model_id is null and effective_until is null
			`;
			pricingMoved += moved.count;
		}
		await tx`update model set status = 'inactive', updated_at = now() where id = ${p.fromId}`;
		modelsDeleted++;
	}
}

// ---------- phase 2: case-variant dedup among no-prefix models ----------
// after phase 1 the same model can survive as two rows differing only in
// case (GLM-5.3-Flash vs glm-5.3-flash). Winner: most live mappings, then
// active, then most mappings, then open pricing rule, then oldest row.
const variants = await tx`
	select m.id, m.slug, m.status, lower(m.slug) as lslug,
		(select count(*) from provider_model pm
		 join provider p on p.id = pm.provider_id
		 where pm.model_id = m.id and p.slug = any(${LIVE_LIST})) as live,
		(select count(*) from provider_model pm where pm.model_id = m.id) as total,
		(select count(*) from pricing_rule pr
		 where pr.model_id = m.id and pr.effective_until is null) as pricing
	from model m
	where m.slug not like '%/%'
	order by m.id
`;
const groups = new Map();
for (const v of variants) {
	if (!groups.has(v.lslug)) groups.set(v.lslug, []);
	groups.get(v.lslug).push(v);
}
for (const [, group] of groups) {
	if (group.length < 2) continue;
	group.sort((a, b) => {
		if (b.live !== a.live) return b.live - a.live;
		if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
		if (b.total !== a.total) return b.total - a.total;
		if (b.pricing !== a.pricing) return b.pricing - a.pricing;
		return a.id < b.id ? -1 : 1;
	});
	const [keeper, ...losers] = group;
	console.log(
		`case-merge: ${losers.map((l) => l.slug).join(' + ')}  ->  ${keeper.slug}` +
		`  [keeper: ${keeper.live} live / ${keeper.total} mappings / ${keeper.status}]`
	);
	for (const l of losers) {
		const existing = await tx`
			select provider_id, connection_id, provider_model_id
			from provider_model where model_id = ${keeper.id}
		`;
		const existSet = new Set(
			existing.map((e) => `${e.provider_id}|${e.connection_id ?? ''}`)
		);
		const lMaps = await tx`
			select pm.id, p.slug as provider, p.id as "providerId", pm.connection_id as connection, pm.provider_model_id as upstream
			from provider_model pm join provider p on p.id = pm.provider_id
			where pm.model_id = ${l.id}
		`;
		for (const m of lMaps) {
			const key = `${m.providerId}|${m.connection ?? ''}`;
			if (existSet.has(key)) {
				await tx`delete from provider_model where id = ${m.id}`;
				droppedDup++;
				continue;
			}
			await tx`update provider_model set model_id = ${keeper.id}, updated_at = now() where id = ${m.id}`;
			repointed++;
			existSet.add(key);
		}
		const canonRule = await tx`
			select id from pricing_rule
			where model_id = ${keeper.id} and provider_model_id is null and effective_until is null
			limit 1
		`;
		if (canonRule.length === 0) {
			const moved = await tx`
				update pricing_rule set model_id = ${keeper.id}
				where model_id = ${l.id} and provider_model_id is null and effective_until is null
			`;
			pricingMoved += moved.count;
		}
		await tx`update model set status = 'inactive', updated_at = now() where id = ${l.id}`;
		modelsDeleted++;
		caseMerged++;
	}
}
});

console.log(
	`done: ${modelsRenamed} renamed, ${modelsDeleted} duplicate rows deleted ` +
	`(${caseMerged} case-variant), ${repointed} mappings re-pointed, ` +
	`${droppedDup} exact-duplicate mappings dropped, ${pricingMoved} pricing rules migrated, ` +
	`${reactivated} canonicals reactivated`
);

await sql.end();
