#!/usr/bin/env node
/**
 * ops/drop-provider.mjs — remove a provider from the routing plane.
 *
 * Usage: node ops/drop-provider.mjs <provider-slug> [--apply]
 *   e.g. node ops/drop-provider.mjs prv-openrouter --apply
 *
 * Generalizes the InferHub drop (2026-10-26): disable-not-delete, one
 * transaction, models orphaned by the drop go inactive ("aktif = bisa
 * dipake, percuma ada tapi gabisa dipake"). request_log history stays
 * intact and a re-onboard is a flip, not a rebuild.
 *
 *   1. provider            → enabled=false, status='disabled'
 *   2. its provider_model  → status='unavailable'
 *   3. orphaned models     → status='inactive'
 */
import { execSync } from 'node:child_process';

const APPLY = process.argv.includes('--apply');
const PROVIDER = process.argv.slice(2).find((a) => !a.startsWith('--'));

if (!PROVIDER) {
	console.error('usage: node ops/drop-provider.mjs <provider-slug> [--apply]');
	process.exit(1);
}

const q = (sql) => execSync(`docker exec postgre psql -U postgres -d fudrouter -t -A -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();

// Accept either the id (prv_openrouter) or the slug (prv-openrouter);
// every later query speaks the id.
const PROVIDER_ID = q(`select id from provider where id='${PROVIDER}' or slug='${PROVIDER}'`);
if (!PROVIDER_ID) {
	console.error(`provider ${PROVIDER} not found`);
	process.exit(1);
}

const ORPHANS = `
	select count(*) from model m
	where m.status='active'
	  and exists (select 1 from provider_model pm where pm.model_id=m.id and pm.provider_id='${PROVIDER_ID}')
	  and not exists (
		select 1 from provider_model pm2
		join provider p2 on p2.id=pm2.provider_id
		where pm2.model_id=m.id and pm2.provider_id<>'${PROVIDER_ID}'
		  and pm2.status='available' and p2.enabled and p2.status='active'
	  )`;

const before = {
	provider: q(`select status || '/' || enabled from provider where id='${PROVIDER_ID}'`),
	mappings: q(`select count(*) from provider_model where provider_id='${PROVIDER_ID}' and status='available'`),
	modelsServed: q(`select count(distinct model_id) from provider_model where provider_id='${PROVIDER_ID}'`),
	orphans: q(ORPHANS),
};

// The real published count is what /v1/models serves (credential-gated
// catalogue), measured through the router itself.
const publishedNow = async () => {
	const r = await fetch('http://127.0.0.1:8100/v1/models');
	const b = await r.json();
	return b.data.length;
};

const pubBefore = await publishedNow();
console.log(`--- ${PROVIDER_ID} before ---`);
console.log(before);
console.log(`published (endpoint): ${pubBefore}`);

if (!APPLY) {
	console.log('\ndry run. pass --apply to execute.');
	process.exit(0);
}

const sql = `
begin;
update provider set enabled=false, status='disabled', updated_at=now() where id='${PROVIDER_ID}';
update provider_model set status='unavailable' where provider_id='${PROVIDER_ID}' and status='available';
update model m set status='inactive', updated_at=now()
where m.status='active'
  and exists (select 1 from provider_model pm where pm.model_id=m.id and pm.provider_id='${PROVIDER_ID}')
  and not exists (
    select 1 from provider_model pm2
    join provider p2 on p2.id=pm2.provider_id
    where pm2.model_id=m.id and pm2.provider_id<>'${PROVIDER_ID}'
      and pm2.status='available' and p2.enabled and p2.status='active'
  );
commit;`;
q(sql);

const after = {
	provider: q(`select status || '/' || enabled from provider where id='${PROVIDER_ID}'`),
	mappings: q(`select count(*) from provider_model where provider_id='${PROVIDER_ID}' and status='available'`),
	activeModels: q(`select count(*) from model where status='active'`),
	orphans: q(ORPHANS),
};

const pubAfter = await publishedNow();
console.log(`--- ${PROVIDER_ID} after ---`);
console.log(after);
console.log(`published (endpoint): ${pubAfter}`);
console.log(`\nprovider: ${before.provider} -> ${after.provider}`);
console.log(`available mappings: ${before.mappings} -> ${after.mappings}`);
console.log(`orphans inactivated: ${before.orphans}`);
console.log(`published: ${pubBefore} -> ${pubAfter}`);
