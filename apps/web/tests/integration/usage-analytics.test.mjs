// tests/integration/usage-analytics.test.mjs — the member usage page's data.
//
// Why this file exists: the usage endpoint advertised five breakdowns and
// returned hardcoded empty arrays for four of them, and the model FILTER was
// written against the wrong column — `r.requested_model = <model_id>` — so
// every model selection in the UI returned zero rows. Both were invisible to
// every gate: the endpoint had no test at all, and the filter bug only shows
// up when a consumer sends the id the breakdown itself advertises.
//
// The regression this pins: `breakdowns.byModel` groups by `r.model_id` and
// returns that id as `key`, so the filter MUST predicate on the same column.
// The pre-fix predicate (`requested_model = model_id`) returned 0 rows here,
// which is exactly what the UI rendered.
//
// The second regression: the filter selects were populated from the FILTERED
// breakdowns, so picking one model collapsed the dropdown to that model and
// the user could not switch without Reset. `facets` is the unfiltered source.
//
// Gating mirrors the rest of the suite: module-scope `skip`, because a
// `t.Skip` in test.before throws in Node 22 and reports failures instead of
// skips. The harness still FAILS under CI with no DSN.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { startServer, signUp, uniqueEmail, integrationEnabled } from './harness.mjs';

const hasDb = integrationEnabled();
const SKIP = 'no throwaway DATABASE_URL — integration suite skipped';
const NEEDS_DB = { skip: !hasDb && SKIP };

let server;
let sql;
let cookie;
let userId;
let modelA; // resolved model: the filter target
let modelB; // a second model, so the facet list has more than one entry
let run; // per-run suffix, so re-runs never collide on the fixed fixture ids

/** Sign up a tenant (the account is the tenant) and return its session cookie. */
async function tenant(tag) {
	const signed = await signUp(server.baseUrl, { email: uniqueEmail(tag) });
	assert.equal(signed.status, 200, `sign-up(${tag}) failed: ${JSON.stringify(signed.body)}`);
	const acct = await fetch(`${server.baseUrl}/api/pages/account`, { headers: { cookie: signed.cookie } });
	const body = await acct.json();
	assert.ok(body.account?.id, `${tag} has no account`);
	return { cookie: signed.cookie, userId: body.account.id };
}

test.before(async () => {
	if (!hasDb) return;
	server = await startServer();
	sql = postgres(process.env.DATABASE_URL, { max: 2 });
	run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
	const t = await tenant('usage');
	cookie = t.cookie;
	userId = t.userId;

	// Two real models (the model FK requires a provider) plus a known
	// request_log fixture: 3 rows on modelA, 2 on modelB, 1 with a NULL
	// model_id so the 'Unresolved' path is exercised. Inserted directly —
	// the router is not involved, so the fixture is exact.
	const prov = await sql`
		insert into provider (id, name, base_url, credentials_enc, status, priority, created_at)
		values ('prv_usagetest', 'usage-test', 'http://127.0.0.1:1', '{}', 'active', 100, now())
		on conflict (id) do nothing returning id`;
	if (prov.length === 0) await sql`select id from provider where id = 'prv_usagetest'`;
	const mk = async (id, slug) => {
		const r = await sql`
			insert into model (id, provider_id, name, slug, context, input_price, output_price, currency, status)
			values (${id}, 'prv_usagetest', ${slug}, ${slug}, 8192, '1', '1', 'USD', 'active')
			on conflict (id) do nothing returning id`;
		if (r.length === 0) await sql`select id from model where id = ${id}`;
	};
	modelA = 'mdl_usagetest_a';
	modelB = 'mdl_usagetest_b';
	await mk(modelA, 'usage-test-model-a');
	await mk(modelB, 'usage-test-model-b');

	const row = async (id, modelId, status, latency) => {
		await sql`
			insert into request_log (id, user_id, model_id, requested_model, tokens_in, tokens_out, cost, latency_ms, status, endpoint, created_at)
			values (${`${id}_${run}`}, ${userId}, ${modelId}, ${modelId ? `usage-test-${modelId}` : null}, 10, 5, 100, ${latency}, ${status}, '/v1/chat/completions', now())`;
	};
	await row('req_usagetest_a1', modelA, 'success', 100);
	await row('req_usagetest_a2', modelA, 'success', 200);
	await row('req_usagetest_a3', modelA, 'client_error', 300);
	await row('req_usagetest_b1', modelB, 'success', 400);
	await row('req_usagetest_b2', modelB, 'provider_error', 500);
	await row('req_usagetest_null', null, 'client_error', 600);

	// Fixture check before any assertion: the rows must be visible through
	// the endpoint, or every assertion below would pass vacuously.
	const seen = await fetch(`${server.baseUrl}/api/pages/dashboard/usage?days=1`, { headers: { cookie } });
	assert.equal(seen.status, 200, 'the usage endpoint must answer');
	const body = await seen.json();
	assert.ok(body.totals.requests >= 6, `fixture not visible: totals.requests=${body.totals.requests}`);
});

test.after(async () => {
	await server?.stop();
	await sql?.end({ timeout: 5 });
});

test('the usage breakdowns, model filter and facets agree', NEEDS_DB, async () => {
	const get = async (qs) => {
		const res = await fetch(`${server.baseUrl}/api/pages/dashboard/usage?${qs}`, { headers: { cookie } });
		assert.equal(res.status, 200, `usage?${qs} must answer`);
		return res.json();
	};

	const all = await get('days=1');

	// 1. byModel carries a row keyed by an inserted model id.
	const rowA = all.breakdowns.byModel.find((r) => r.key === modelA);
	assert.ok(rowA, `byModel has no row for ${modelA}: ${JSON.stringify(all.breakdowns.byModel)}`);
	assert.equal(rowA.requests, 3, 'the fixture has 3 rows on modelA');
	assert.equal(rowA.label, 'usage-test-model-a', 'the label is the model slug');
	// The NULL-model_id row lands in the Unresolved bucket.
	const unresolved = all.breakdowns.byModel.find((r) => r.label === 'Unresolved');
	assert.ok(unresolved, 'byModel must expose the Unresolved bucket for NULL model_id rows');

	// 2. THE REGRESSION: filtering by that model id must return exactly the
	// breakdown's count. The pre-fix predicate (requested_model = model_id)
	// returned 0 here, so the UI showed an empty page for every selection.
	const filtered = await get(`days=1&model=${encodeURIComponent(modelA)}`);
	assert.equal(
		filtered.totals.requests,
		rowA.requests,
		`model filter returned ${filtered.totals.requests} requests, byModel says ${rowA.requests} — the filter predicates a different column than the breakdown groups by`
	);

	// 3. The facet source is unfiltered, so the dropdown keeps every option
	// while a filter is active (the dropdown-collapse regression).
	assert.ok(
		filtered.facets.models.some((m) => m.key === modelB),
		`facets.models lost ${modelB} while the model filter was active — the selects would collapse to the selection`
	);
	assert.ok(
		filtered.facets.models.some((m) => m.key === modelA),
		'facets.models must still contain the active selection'
	);
	// The breakdowns themselves stay filtered.
	assert.equal(filtered.breakdowns.byModel.length, 1, 'the filtered breakdown describes only the filtered set');

	// 4. The paged log agrees with the summary for the same filter.
	const log = await fetch(`${server.baseUrl}/api/pages/dashboard/usage/requests?days=1&model=${encodeURIComponent(modelA)}&page=1`, { headers: { cookie } });
	assert.equal(log.status, 200, 'the requests endpoint must answer');
	const logBody = await log.json();
	assert.equal(logBody.total, rowA.requests, `requests total ${logBody.total} != byModel ${rowA.requests}`);
	assert.equal(logBody.rows.length, rowA.requests, 'every filtered row fits on page 1');
	assert.equal(logBody.page, 1);
	assert.equal(logBody.pages, 1);
	assert.ok(
		logBody.rows.every((r) => r.modelSlug === 'usage-test-model-a'),
		'every returned row is the filtered model'
	);

	// 5. latency.p50 must be a number — null renders "NaN ms" in the card.
	for (const body of [all, filtered]) {
		assert.equal(typeof body.latency.p50, 'number', `latency.p50 must be a number, got ${JSON.stringify(body.latency)}`);
		assert.ok(Number.isFinite(body.latency.p50), 'latency.p50 must be finite');
	}
});

// The credits page's spend chart: the top-5 series plus the Other bucket must
// sum to exactly the account's cost>0 spend. The pre-fix handler compared
// model_id keys against slug labels, so no entry ever matched, every top model
// was ALSO summed into Other, and the chart double-counted (2x the true spend
// with a single model). This is the assertion that catches it.
test('the credits spend series reconciles with request_log cost', NEEDS_DB, async () => {
	const res = await fetch(`${server.baseUrl}/api/pages/dashboard/billing/credits`, { headers: { cookie } });
	assert.equal(res.status, 200, 'the credits endpoint must answer');
	const body = await res.json();

	const expected = await sql`
		select coalesce(sum(cost), 0)::text as total from request_log
		where user_id = ${userId} and cost > 0 and created_at >= now() - interval '30 days'`;
	const want = BigInt(expected[0].total);

	const got = (body.series ?? []).reduce(
		(acc, day) => day.series.reduce((a, s) => a + BigInt(s.costMicro), acc),
		0n
	);
	assert.equal(
		got.toString(),
		want.toString(),
		`series total ${got} != request_log cost ${want} — the top-5/Other split double-counts or drops spend`
	);

	// The fixture's two models must each appear as their own series, not be
	// folded into Other.
	const labels = new Set((body.series ?? []).flatMap((d) => d.series.map((s) => s.label)));
	assert.ok(labels.has('usage-test-model-a'), `series lost modelA: ${[...labels].join(', ')}`);
	assert.ok(labels.has('usage-test-model-b'), `series lost modelB: ${[...labels].join(', ')}`);
});
