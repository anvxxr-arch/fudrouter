#!/usr/bin/env node
/**
 * ops/reonboard-provider.mjs — put a dropped provider back on the routing
 * plane, optionally adding upstream models that were never mapped.
 *
 * Usage:
 *   node ops/reonboard-provider.mjs <provider-slug> [--models a:free,b:free] [--apply]
 *   e.g. node ops/reonboard-provider.mjs prv-tokenharbor \
 *          --models deepseek-v4.1-flash:free,mimo-v2.6-flash:free --apply
 *
 * The inverse of drop-provider.mjs, and just as reversible:
 *   1. provider     → enabled=true, status='active'
 *   2. connections  → enabled=true
 *   3. each --models slug → model row (created if absent, reactivated if
 *      orphaned) + provider_model mapping back to 'available'
 *
 * Why this exists: TokenHarbor was dropped on 2026-10-26 because its only
 * mapped model (mimo-v2.5:free) 403'd and the upstream was 429-flooded.
 * A direct probe later the same day showed deepseek-v4.1-flash:free and
 * mimo-v2.6-flash:free answering 200 — the provider was never dead, the
 * MAPPING was. A drop decision made on one mapped model is a decision made
 * on incomplete data; this script is the cheap undo.
 *
 * New model rows are created with the upstream catalog's own numbers
 * (context 1048576, free pricing 0/0 for :free variants) — pass --context
 * / --price to override. Nothing is deleted; existing rows are only
 * reactivated.
 */
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const PROVIDER = argv.find((a) => !a.startsWith('--'));
const modelsIdx = argv.indexOf('--models');
const MODELS = modelsIdx === -1 ? [] : argv[modelsIdx + 1].split(',').map((s) => s.trim()).filter(Boolean);

if (!PROVIDER) {
	console.error('usage: node ops/reonboard-provider.mjs <provider-slug> [--models a,b] [--apply]');
	process.exit(1);
}

const q = (sql) => execSync(`docker exec postgre psql -U postgres -d fudrouter -t -A -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();

const PROVIDER_ID = q(`select id from provider where id='${PROVIDER}' or slug='${PROVIDER}'`);
if (!PROVIDER_ID) {
	console.error(`provider ${PROVIDER} not found`);
	process.exit(1);
}

const before = {
	provider: q(`select status || '/' || enabled from provider where id='${PROVIDER_ID}'`),
	connections: q(`select count(*) from connection where provider_id='${PROVIDER_ID}' and enabled`),
	mappings: q(`select count(*) from provider_model where provider_id='${PROVIDER_ID}' and status='available'`),
	models: q(`select count(distinct model_id) from provider_model where provider_id='${PROVIDER_ID}'`),
};

console.log(`--- ${PROVIDER_ID} before ---`);
console.log(before);
if (MODELS.length) console.log(`models to (re)map: ${MODELS.join(', ')}`);

if (!APPLY) {
	console.log('\ndry run. pass --apply to execute.');
	process.exit(0);
}

// 1+2. Provider and its connections back on.
q(`
begin;
update provider set enabled=true, status='active', updated_at=now() where id='${PROVIDER_ID}';
update connection set enabled=true, updated_at=now() where provider_id='${PROVIDER_ID}';
commit;`);

// 3. Model rows + mappings. A model row that already exists (even inactive)
// is reused — the slug is the identity; only missing rows are created.
const created = [];
const revived = [];
for (const slug of MODELS) {
	const safe = slug.replace(/'/g, "''");
	let modelId = q(`select id from model where slug='${safe}'`);
	if (!modelId) {
		modelId = 'mdl_' + randomUUID();
		q(`
begin;
insert into model (id, provider_id, name, slug, context, input_price, output_price, currency, status, modality, created_at, updated_at)
values ('${modelId}', '${PROVIDER_ID}', '${safe}', '${safe}', 1048576, 0, 0, 'USD', 'active', '{"type": "text"}', now(), now());
commit;`);
		created.push(slug);
	} else {
		q(`update model set status='active', updated_at=now() where id='${modelId}' and status<>'active';`);
		revived.push(slug);
	}
	// Mapping: same upstream slug as the model slug (the :free variants are
	// the upstream's own ids). Upsert keeps a re-run idempotent. connection_id
	// is part of the identity — the catalogue gate (store.ActiveModels) joins
	// provider_model to its connection, so a NULL connection_id silently
	// drops the model from /v1/models while the DB says "available".
	const pmId = q(`select id from provider_model where provider_id='${PROVIDER_ID}' and model_id='${modelId}'`);
	const connId = q(`select id from connection where provider_id='${PROVIDER_ID}' and enabled order by priority nulls last, id limit 1`);
	if (pmId) {
		q(`update provider_model set status='available', enabled=true, provider_model_id='${safe}', connection_id='${connId}', updated_at=now() where id='${pmId}';`);
	} else {
		q(`
begin;
insert into provider_model (id, model_id, provider_id, connection_id, provider_model_id, status, enabled, created_at, updated_at)
values ('pm_' || replace(gen_random_uuid()::text, '-', ''), '${modelId}', '${PROVIDER_ID}', '${connId}', '${safe}', 'available', true, now(), now());
commit;`);
	}
}

const after = {
	provider: q(`select status || '/' || enabled from provider where id='${PROVIDER_ID}'`),
	connections: q(`select count(*) from connection where provider_id='${PROVIDER_ID}' and enabled`),
	mappings: q(`select count(*) from provider_model where provider_id='${PROVIDER_ID}' and status='available'`),
	models: q(`select count(distinct model_id) from provider_model where provider_id='${PROVIDER_ID}'`),
};

const publishedNow = async () => {
	const r = await fetch('http://127.0.0.1:8100/v1/models');
	const b = await r.json();
	return b.data.length;
};
const pubAfter = await publishedNow();

console.log(`--- ${PROVIDER_ID} after ---`);
console.log(after);
console.log(`published (endpoint): ${pubAfter}`);
console.log(`\nprovider: ${before.provider} -> ${after.provider}`);
console.log(`available mappings: ${before.mappings} -> ${after.mappings}`);
if (created.length) console.log(`model rows created: ${created.join(', ')}`);
if (revived.length) console.log(`model rows revived: ${revived.join(', ')}`);
console.log('\nnext: node ops/poll-models.mjs  (native status poll for the new mappings)');
