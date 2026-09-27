// Live proof that a re-onboard preserves an operator-set status.
//
// Unit tests cover the helper in isolation; this runs the SAME helper against a
// real Postgres to prove the generated SQL is valid and that omitting `status`
// from the on-conflict clause really does leave the stored value alone.
//
//   node --experimental-strip-types scripts/verify-status-preservation.mjs
import postgres from 'postgres';
import {
	resolveStatus,
	assertValidStatus,
	providerUpsertConflict
} from '../src/lib/server/provider-status.ts';

const DB = process.env.VERIFY_DB;
if (!DB) {
	console.error('set VERIFY_DB to a throwaway database url');
	process.exit(2);
}
const sql = postgres(DB, { max: 1 });
let failures = 0;
const check = (got, want, label) => {
	const ok = got === want;
	if (!ok) failures++;
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label} (got ${got}, want ${want})`);
};

const ENV = 'VERIFY_PROVIDER_STATUS';
delete process.env[ENV];

try {
	await sql`drop table if exists status_probe`;
	await sql`create table status_probe (
		id text primary key,
		name text,
		base_url text,
		credentials_enc text,
		status text default 'active' not null,
		priority int
	)`;

	const upsert = async (status, isExplicit) => {
		const { value: STATUS } = resolveStatus(ENV);
		assertValidStatus(STATUS, ENV);
		await sql.unsafe(
			`insert into status_probe (id, name, base_url, credentials_enc, status, priority)
			 values ($1, $2, $3, $4, $5, $6) ${providerUpsertConflict('id', status, isExplicit)}`,
			['probe', 'Probe', 'https://example.invalid/v1', 'blob', STATUS, 100]
		);
		return (await sql`select status from status_probe where id = 'probe'`)[0].status;
	};

	console.log('### 1. fresh insert seeds active');
	check(await upsert('active', false), 'active', 'inserted row status');

	console.log('### 2. operator disables the provider');
	await sql`update status_probe set status = 'disabled' where id = 'probe'`;
	check(
		(await sql`select status from status_probe where id = 'probe'`)[0].status,
		'disabled',
		'operator set'
	);

	console.log('### 3. re-onboard with no env var must PRESERVE disabled');
	check(await upsert('active', false), 'disabled', 'after re-onboard');

	console.log('### 4. an explicit override does rewrite it');
	process.env[ENV] = 'dev';
	const { value: s2, isExplicit: e2 } = resolveStatus(ENV);
	check(s2, 'dev', 'resolved explicit value');
	check(await upsert(s2, e2), 'dev', 'after explicit override');
	delete process.env[ENV];

	console.log('### 5. a bad status is rejected before SQL runs');
	let threw = false;
	try {
		assertValidStatus('actve', ENV);
	} catch {
		threw = true;
	}
	check(threw, true, 'typo rejected');

	console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
	process.exitCode = failures === 0 ? 0 : 1;
} finally {
	await sql`drop table if exists status_probe`.catch(() => {});
	await sql.end({ timeout: 5 });
}
