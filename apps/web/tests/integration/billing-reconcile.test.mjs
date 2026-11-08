// apps/web/tests/integration/billing-reconcile.test.mjs
//
// A2 isolate-exclude (FR-revised §S1/P1.2, §7 invariant 4): `reconcileAll`
// must keep reconciling the fleet when ONE account's ledger sum exceeds int64,
// instead of aborting the whole `billing_aggregation` job with `bigint out of
// range`. The overflow account is quarantined (`status='quarantine'` + audit
// row), its cache is never written, and every in-range account still converges.
//
// Four pinned cases (the four money-moving outcomes): (a) overflow, (b) normal,
// (c) the Σledger == Σbalance invariant across non-quarantine accounts, and
// (d) idempotence on a second run. Each case is self-contained (its own seed +
// teardown) so order never matters — the same rule retention-cleanup.test.mjs
// follows.
//
// Fixture rules shared with retention-cleanup.test.mjs: `sql.raw` with
// interpolated strings (postgres-js text mode has no Date encoder), the postgres
// client is created INSIDE the test, and the handler import is dynamic because
// billing.ts reaches `db/index.ts`, which throws at import time without
// DATABASE_URL. That import also opens the platform's module-level pool, so it
// is closed exactly once in `after` — never per-test.
//
// Run: node --test apps/web/tests/integration/billing-reconcile.test.mjs
//      (needs DATABASE_URL pointing at a throwaway database)
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';

const SKIP = !process.env.DATABASE_URL;
const MARK = 'reca2_';

// Two postings that are each comfortably in int64 but whose SUM is not:
// 5.555e18 * 2 = 1.111e19 > 2^63-1 (9.223e18). This is the exact shape the
// scrub runbook records (two 5.55e18 placeholder credit_purchase rows).
const CORRUPT = '5555555555555000000';

let client;
let testDb;
let billing;

async function setup() {
	if (billing) return;
	const { default: postgres } = await import('postgres');
	const { drizzle } = await import('drizzle-orm/postgres-js');
	const schema = await import('@fudrouter/platform/server/db/schema.ts');
	client = postgres(process.env.DATABASE_URL);
	testDb = drizzle(client, { schema });
	billing = await import('@fudrouter/platform/server/billing.ts');
}

/** Seed one user + billing account (+ ledger rows) under a unique `tag`. */
async function seedAccount(tag, { ledger = [], balance = '0', status = 'active' } = {}) {
	await testDb.execute(sql.raw(`insert into "user" (id, name, email) values ('${tag}', '${tag}', '${tag}@example.invalid')`));
	await testDb.execute(sql.raw(`
		insert into billing_account (id, user_id, balance_micro, status) values
			('bac_${tag}', '${tag}', ${balance}, '${status}')
	`));
	for (const [i, row] of ledger.entries()) {
		await testDb.execute(sql.raw(`
			insert into credit_ledger (id, billing_account_id, type, amount_micro, description)
			values ('txn_${tag}_${i}', 'bac_${tag}', '${row.type}', ${row.amount}, ${row.description ?? null})
		`));
	}
}

async function cleanupAccount(tag) {
	await testDb.execute(sql.raw(`delete from credit_ledger where billing_account_id = 'bac_${tag}'`));
	await testDb.execute(sql.raw(`delete from audit_log where resource_id = 'bac_${tag}'`));
	await testDb.execute(sql.raw(`delete from billing_account where id = 'bac_${tag}'`));
	await testDb.execute(sql.raw(`delete from "user" where id = '${tag}'`));
}

after(async () => {
	if (!testDb) return;
	await client.end({ timeout: 5000 });
	// billing.ts imports the platform's module-level pool (db/index.ts), whose
	// sockets keep the event loop alive — close it once here, after every test.
	const { closeDb } = await import('@fudrouter/platform/server/db/index.ts');
	await closeDb();
});

// ---------------------------------------------------------------------------

test('reconcileAll: overflow — cache untouched, quarantined, one audit row', { skip: SKIP }, async () => {
	await setup();
	const tag = `${MARK}ovfl`;
	await seedAccount(tag, {
		balance: '0',
		ledger: [
			{ type: 'credit_purchase', amount: CORRUPT, description: "'corrupt placeholder 1'" },
			{ type: 'credit_purchase', amount: CORRUPT, description: "'corrupt placeholder 2'" }
		]
	});
	try {
		const repaired = await billing.reconcileAll(testDb);

		const account = await testDb.execute(sql.raw(`
			select status, balance_micro::text as balance
			from billing_account where id = 'bac_${tag}'
		`));
		assert.equal(account[0].status, 'quarantine', 'overflow account must be quarantined');
		assert.equal(account[0].balance, '0', 'overflow account cache must NOT be written');

		const audits = await testDb.execute(sql.raw(`
			select id from audit_log
			where action = 'billing.quarantine' and resource_id = 'bac_${tag}'
		`));
		assert.equal(audits.length, 1, 'exactly one quarantine audit row');

		assert.ok(!repaired.includes(`bac_${tag}`), 'overflow account is not a repaired id');
	} finally {
		await cleanupAccount(tag);
	}
});

test('reconcileAll: normal — cache converges to the ledger sum', { skip: SKIP }, async () => {
	await setup();
	const tag = `${MARK}nrml`;
	await seedAccount(tag, {
		balance: '1000000',
		ledger: [
			{ type: 'credit_purchase', amount: 5000000, description: null },
			{ type: 'usage_charge', amount: -1000000, description: null }
		]
	});
	try {
		const repaired = await billing.reconcileAll(testDb);

		const account = await testDb.execute(sql.raw(`
			select status, balance_micro::text as balance
			from billing_account where id = 'bac_${tag}'
		`));
		assert.equal(account[0].status, 'active', 'normal account stays active');
		assert.equal(account[0].balance, '4000000', 'cache equals 5_000_000 - 1_000_000');
		assert.ok(repaired.includes(`bac_${tag}`), 'the drifted normal account is a repaired id');
	} finally {
		await cleanupAccount(tag);
	}
});

test('reconcileAll: invariant — Σledger == Σbalance for every non-quarantine account', { skip: SKIP }, async () => {
	await setup();
	const zero = `${MARK}zro_${Date.now()}`;
	const pos = `${MARK}pos_${Date.now()}`;
	await seedAccount(zero, { balance: '777', ledger: [] });
	await seedAccount(pos, {
		balance: '0',
		ledger: [
			{ type: 'credit_purchase', amount: 250, description: null },
			{ type: 'usage_charge', amount: -50, description: null }
		]
	});
	try {
		await billing.reconcileAll(testDb);

		const mismatches = await testDb.execute(sql.raw(`
			select b.id
			from billing_account b
			left join lateral (
				select coalesce(sum(c.amount_micro), 0) as total
				from credit_ledger c where c.billing_account_id = b.id
			) l on true
			where (b.id = 'bac_${zero}' or b.id = 'bac_${pos}')
			  and b.status <> 'quarantine'
			  and b.balance_micro <> l.total
		`));
		assert.equal(mismatches.length, 0, 'no non-quarantine account may drift after reconcile');
	} finally {
		await cleanupAccount(zero);
		await cleanupAccount(pos);
	}
});

test('reconcileAll: idempotent — a second run churns nothing', { skip: SKIP }, async () => {
	await setup();
	const tag = `${MARK}idem_${Date.now()}`;
	await seedAccount(tag, {
		balance: '0',
		ledger: [
			{ type: 'credit_purchase', amount: CORRUPT, description: "'corrupt once'" },
			{ type: 'credit_purchase', amount: CORRUPT, description: "'corrupt twice'" }
		]
	});
	try {
		await billing.reconcileAll(testDb);
		const second = await billing.reconcileAll(testDb);
		assert.deepEqual(second, [], 'steady-state run repairs nothing');

		const audits = await testDb.execute(sql.raw(`
			select count(*)::int as n from audit_log
			where action = 'billing.quarantine' and resource_id = 'bac_${tag}'
		`));
		assert.equal(audits[0].n, 1, 'quarantine audit is written once, not per run');
	} finally {
		await cleanupAccount(tag);
	}
});