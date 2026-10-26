#!/usr/bin/env node
/**
 * ops/drop-inferhub.mjs — remove InferHub from the routing plane.
 *
 * Decision (dwizzy, 2026-10-26): "kita ga pake inferhub, mahal". The
 * provider's credentials are revoked anyway (401 api key revoked), and it
 * is the sole active mapping for 136 published models — every one of them
 * fails the probe with all_mappings_failed.
 *
 * Strategy, same as the prefix merge: rows are DISABLED, never deleted.
 * request_log → model and the credential/connection history all restrict
 * deletes, and a re-onboard later must be a flip, not a rebuild.
 *
 *   1. provider.prv_inferhub  → enabled=false, status='disabled'
 *   2. its provider_model rows → status='unavailable' (149 available today)
 *   3. models left with ZERO active mappings → status='inactive'
 *      ("aktif = bisa dipake, percuma ada tapi gabisa dipake")
 *
 * The publisher-side InferHub account (earnings, withdraw) is untouched —
 * this is the consumer routing plane only.
 *
 * Usage: node ops/drop-inferhub.mjs [--apply]
 */
import { execSync } from 'node:child_process';

const APPLY = process.argv.includes('--apply');
const q = (sql) => execSync(`docker exec postgre psql -U postgres -d fudrouter -t -A -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();

const PROVIDER = 'prv_inferhub';

const ORPHANS = `
	select count(*) from model m
	where m.status='active'
	  and exists (select 1 from provider_model pm where pm.model_id=m.id and pm.provider_id='${PROVIDER}')
	  and not exists (
		select 1 from provider_model pm2
		join provider p2 on p2.id=pm2.provider_id
		where pm2.model_id=m.id and pm2.provider_id<>'${PROVIDER}'
		  and pm2.status='available' and p2.enabled and p2.status='active'
	  )`;

const before = {
	provider: q(`select status || '/' || enabled from provider where id='${PROVIDER}'`),
	mappings: q(`select count(*) from provider_model where provider_id='${PROVIDER}' and status='available'`),
	modelsServed: q(`select count(distinct model_id) from provider_model where provider_id='${PROVIDER}'`),
	orphans: q(ORPHANS),
};

// The real published count is what /v1/models serves (credential-gated
// catalogue), not a mapping-level approximation — measured separately via
// the router endpoint.
const publishedNow = async () => {
	const r = await fetch('http://127.0.0.1:8100/v1/models');
	const b = await r.json();
	return b.data.length;
};

const pubBefore = await publishedNow();
console.log('--- before ---');
console.log(before);
console.log(`published (endpoint): ${pubBefore}`);

if (!APPLY) {
	console.log('\ndry run. pass --apply to execute.');
	process.exit(0);
}

// One transaction: either inferhub is fully out of the routing plane, or
// nothing changed.
const sql = `
begin;
update provider set enabled=false, status='disabled', updated_at=now() where id='${PROVIDER}';
update provider_model set status='unavailable' where provider_id='${PROVIDER}' and status='available';
update model m set status='inactive', updated_at=now()
where m.status='active'
  and exists (select 1 from provider_model pm where pm.model_id=m.id and pm.provider_id='${PROVIDER}')
  and not exists (
    select 1 from provider_model pm2
    join provider p2 on p2.id=pm2.provider_id
    where pm2.model_id=m.id and pm2.provider_id<>'${PROVIDER}'
      and pm2.status='available' and p2.enabled and p2.status='active'
  );
commit;`;
q(sql);

const after = {
	provider: q(`select status || '/' || enabled from provider where id='${PROVIDER}'`),
	mappings: q(`select count(*) from provider_model where provider_id='${PROVIDER}' and status='available'`),
	activeModels: q(`select count(*) from model where status='active'`),
	orphans: q(ORPHANS),
};

const pubAfter = await publishedNow();
console.log('--- after ---');
console.log(after);
console.log(`published (endpoint): ${pubAfter}`);
console.log(`\nprovider: ${before.provider} -> ${after.provider}`);
console.log(`available mappings: ${before.mappings} -> ${after.mappings}`);
console.log(`active models: ${q(`select count(*) from model where status='active'`)} (orphans inactivated: ${before.orphans})`);
console.log(`published: ${pubBefore} -> ${pubAfter}`);
