// tests/integration/admin-models-pricing.test.mjs — the admin models list's
// "effective price" column.
//
// Why this file exists: the admin list selected the wide pricing rule with
// `effective_until IS NULL` alone, while the public catalogue and the router
// (public.mjs servedModels) select on the full window
// `effective_from <= now() and (effective_until is null or effective_until > now())`.
// The two predicates disagree in both directions:
//
//   - a FUTURE-dated rule (effective_from next week, effective_until NULL) was
//     picked by admin and displayed as today's price, while the router still
//     billed the previous rule — an operator reading /admin/models saw a price
//     no request pays;
//   - a rule with a FUTURE effective_until that is currently in force was
//     EXCLUDED by admin but included by public.
//
// The regression this pins: the admin list must show the rule the router bills.
// Rule A (in force, version 1) and rule B (future-dated, version 2) are seeded
// for one model; the list must report A's prices, not B's. The pre-fix query
// ordered by version desc and matched B, so the assertion below failed with
// B's prices before the fix and passes after.
//
// Gating mirrors the rest of the suite: module-scope `skip`, because a skip
// inside test.before throws in Node 22 and reports failures instead of skips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { startServer, signUp, uniqueEmail, integrationEnabled } from './harness.mjs';

const hasDb = integrationEnabled();
const SKIP = 'no throwaway DATABASE_URL — integration suite skipped';
const NEEDS_DB = { skip: !hasDb && SKIP };

let server;
let sql;
let memberCookie; // a plain user: the gate must refuse this
let adminCookie; // promoted below: the gate must serve this
let modelId; // the seeded model both rules hang off
let run; // per-run suffix, so re-runs never collide on the fixed fixture ids

test.before(async () => {
	if (!hasDb) return;
	server = await startServer();

	// A plain user first, asserted before any promotion — a passing 403
	// cannot be a leftover admin role from an earlier run.
	const member = await signUp(server.baseUrl, { email: uniqueEmail('member') });
	assert.equal(member.status, 200, `sign-up failed: ${JSON.stringify(member.body)}`);
	memberCookie = member.cookie;

	const promoted = await signUp(server.baseUrl, { email: uniqueEmail('admin') });
	assert.equal(promoted.status, 200, `sign-up failed: ${JSON.stringify(promoted.body)}`);
	adminCookie = promoted.cookie;
	const email = promoted.body?.user?.email;
	assert.ok(email, 'sign-up must return the user email');

	// Promotion is a row update, not a new session: the gate resolves the user
	// row per request, so the next request sees the new role.
	sql = postgres(process.env.DATABASE_URL, { max: 2 });
	const rows = await sql`update "user" set role = 'admin' where email = ${email} returning id`;
	assert.equal(rows.length, 1, 'the promoted user must exist in the throwaway database');

	run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
	modelId = `mdl_pricetest_${run}`;

	// One provider and one model (the pricing_rule FK requires a model, the
	// model FK requires a provider). Inserted directly — the router is not
	// involved, so the fixture is exact.
	await sql`
		insert into provider (id, name, base_url, credentials_enc, status, priority, created_at)
		values (${`prv_pricetest_${run}`}, ${`pricing-test-${run}`}, 'http://127.0.0.1:1', '{}', 'active', 100, now())
		on conflict (id) do nothing`;
	await sql`
		insert into model (id, provider_id, name, slug, context, input_price, output_price, currency, status)
		values (${modelId}, ${`prv_pricetest_${run}`}, ${`pricing-test-${run}`}, ${`pricing-test-${run}`}, 8192, '0', '0', 'USD', 'active')
		on conflict (id) do nothing`;

	// Five rules, chosen so each half of the predicate is independently testable:
	//   A v1  in force, expires next week        $1 / $2
	//   B v2  future-dated, open-ended           $9 / $9
	//   C v3  in force, expires next week        $3 / $4
	//   D v4  in force, open-ended               $5 / $6
	//   E v5  future-dated, open-ended           $7 / $8
	//
	// The router bills D: public.mjs applies the full window and takes the highest
	// version among the rules it admits (A, C, D). The pre-fix admin query, which
	// required `effective_until IS NULL`, admits B, D and E — and E outranks D, so
	// it reported the future-dated price. And `new Map(pairs)` over the
	// desc-ordered rows keeps the LAST, i.e. the lowest in-force version (A), so
	// even with the window fixed the list would report A's price. Both halves
	// therefore have to be right to land on D, which is what the assertion below
	// pins. E exists precisely so the where-revert fails on its own: without a
	// future-dated rule above every open-ended in-force rule, the old predicate's
	// highest row is D and the two halves mask each other.
	const rule = async (tag, version, input, output, from, until) => {
		await sql`
			insert into pricing_rule (id, model_id, provider_model_id, version, currency, input_price, cached_input_price, output_price, reasoning_price, effective_from, effective_until, created_by)
			values (${`prc_pricetest_${tag}_${run}`}, ${modelId}, null, ${version}, 'USD', ${input}, null, ${output}, null, ${from}, ${until}, null)`;
	};
	await rule('a', 1, '1.000000', '2.000000', sql`now() - interval '1 day'`, sql`now() + interval '7 days'`);
	await rule('b', 2, '9.000000', '9.000000', sql`now() + interval '7 days'`, null);
	await rule('c', 3, '3.000000', '4.000000', sql`now() - interval '1 month'`, sql`now() + interval '7 days'`);
	await rule('d', 4, '5.000000', '6.000000', sql`now() - interval '1 month'`, null);
	await rule('e', 5, '7.000000', '8.000000', sql`now() + interval '7 days'`, null);

	// Fixture check before any assertion: the model must be visible through
	// the endpoint, or the assertions below would pass vacuously.
	const seen = await fetch(`${server.baseUrl}/api/admin/models`, { headers: { cookie: adminCookie } });
	const seenBody = await seen.json().catch(() => null);
	assert.equal(seen.status, 200, `admin models list failed: ${JSON.stringify(seenBody)}`);
	assert.ok(
		Array.isArray(seenBody?.models) && seenBody.models.some((m) => m.id === modelId),
		'fixture not visible: the seeded model is absent from /api/admin/models',
	);

});

test.after(async () => {
	await server?.stop();
	await sql?.end({ timeout: 5 });
});

const get = (base, path, cookie) =>
	fetch(`${base}${path}`, { headers: cookie ? { cookie } : {} });

test('the admin list shows the rule the router bills, not a future-dated or superseded one', NEEDS_DB, async () => {
	const res = await get(server.baseUrl, '/api/admin/models', adminCookie);
	const body = await res.json().catch(() => null);
	assert.equal(res.status, 200, `admin models list failed: ${JSON.stringify(body)}`);
	const row = body.models.find((m) => m.id === modelId);
	assert.ok(row, `the seeded model is missing from the list: ${JSON.stringify(body.models?.map((m) => m.id))}`);

	// micros() is String(v).split('.')[0], so '5.000000' -> '5' and
	// '6.000000' -> '6'. Rule B (future-dated) would be '9' / '9' and rule C
	// (lower in-force version) would be '3' / '4'.
	assert.equal(row.inputPriceMicro, '5', `input price must be rule D (highest in-force version), got ${row.inputPriceMicro}`);
	assert.equal(row.outputPriceMicro, '6', `output price must be rule D (highest in-force version), got ${row.outputPriceMicro}`);
	assert.equal(row.currency, 'USD', `currency must come from rule D, got ${row.currency}`);
});

test('a plain user is refused by the admin gate, not shown the price list', NEEDS_DB, async () => {
	const anon = await get(server.baseUrl, '/api/admin/models');
	assert.equal(anon.status, 401, 'no cookie must be 401');
	const member = await get(server.baseUrl, '/api/admin/models', memberCookie);
	assert.equal(member.status, 403, 'a non-admin session must be 403, not an empty 200');
});

test('the pricing panel flags exactly the in-force rule as current', NEEDS_DB, async () => {
	const res = await get(server.baseUrl, `/api/admin/models/pricing?model=${encodeURIComponent(modelId)}`, adminCookie);
	const body = await res.json().catch(() => null);
	assert.equal(res.status, 200, `pricing panel failed: ${JSON.stringify(body)}`);
	const mine = (body.rules ?? []).filter((r) => r.modelId === modelId);
	assert.equal(mine.length, 5, `expected the five seeded rules, got ${mine.length}`);

	// Exactly one rule is in force: D (v4). The old check (`effective_until IS
	// NULL`) flagged B and E as well — both start in the future — which is the
	// defect this pins.
	const current = mine.filter((r) => r.current);
	assert.equal(current.length, 1, `exactly one rule is in force; got versions ${JSON.stringify(current.map((r) => r.version))}`);
	assert.equal(current[0].version, 4, `the in-force rule is D (v4); got v${current[0].version}`);

	for (const v of [2, 5]) {
		const r = mine.find((x) => x.version === v);
		assert.equal(r.current, false, `v${v} starts in the future and must not be current`);
	}
	// A and C are in force but superseded by D, so they are historical too.
	for (const v of [1, 3]) {
		const r = mine.find((x) => x.version === v);
		assert.equal(r.current, false, `v${v} is in force but superseded by v4`);
	}
});
