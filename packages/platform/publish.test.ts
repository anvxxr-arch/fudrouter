/**
 * The publish gate, pinned.
 *
 * Why this file exists: `reachability()` is the console's copy of a rule the Go
 * router implements in SQL (`providerServableSQLFor`,
 * backend/go/internal/store/catalog.go). The two are maintained separately, so
 * the only thing that stops them drifting is a test that fails when this side
 * changes its mind about a case the router decides. The module's header used to
 * claim a `publish.test.ts` pinned it; there was no such file, and the claim was
 * removed rather than left as a false assurance. This is that file.
 *
 * Every case below is one the two implementations HAVE disagreed on in
 * production, or one where the old three-argument signature could not express
 * the router's answer at all:
 *
 *   - a disabled provider (`p.enabled = false`) was invisible to the old
 *     signature, so the admin model list reported the row as served;
 *   - a dev-tier provider without the opt-in was likewise invisible, and only
 *     the public catalogue compensated, in SQL;
 *   - `maintenance` is excluded by the router and must be excluded here.
 *
 * The all-clear case is last: it is the one that catches an over-eager gate,
 * which is the failure mode that hides working models.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	reachability,
	devProvidersAllowed,
	MODEL_STATUSES,
	PROVIDER_BLOCKING_STATUSES
} from './publish.ts';

/** A provider row the router serves: enabled, commercial, operational. */
const servable = { status: 'operational', enabled: true, tier: 'commercial' };

test('a disabled provider is hidden', () => {
	assert.deepEqual(reachability('active', { ...servable, enabled: false }, false), {
		served: false,
		reason: 'provider-off'
	});
	// Even with the dev opt-in on: `p.enabled` is not a tier question.
	assert.deepEqual(reachability('active', { ...servable, enabled: false }, true), {
		served: false,
		reason: 'provider-off'
	});
});

test('a dev-tier provider is hidden without the opt-in and served with it', () => {
	const dev = { ...servable, tier: 'dev' };
	assert.deepEqual(reachability('active', dev, false), { served: false, reason: 'provider-off' });
	assert.deepEqual(reachability('active', dev, true), { served: true, reason: null });
});

test('a maintenance provider is hidden', () => {
	// The router excludes disabled, maintenance and outage; the old status
	// allow-list here ('active'/'dev' only) agreed on these by accident, and an
	// allow-list over the PRD vocabulary would not.
	for (const status of PROVIDER_BLOCKING_STATUSES) {
		assert.deepEqual(reachability('active', { ...servable, status }, false), {
			served: false,
			reason: 'provider-off'
		});
	}
});

test('the legacy S0 statuses still decide the same way', () => {
	// Pre-0010 rows carry `active`/`dev`. `active` is served (it is not in the
	// blocking set); `dev` needs the opt-in, exactly like a dev-tier provider.
	assert.deepEqual(reachability('active', { ...servable, status: 'active' }, false), {
		served: true,
		reason: null
	});
	assert.deepEqual(reachability('active', { ...servable, status: 'dev' }, false), {
		served: false,
		reason: 'provider-off'
	});
	assert.deepEqual(reachability('active', { ...servable, status: 'dev' }, true), {
		served: true,
		reason: null
	});
});

test('the PRD operational and degraded statuses are served', () => {
	// A deny-list, not an allow-list: migration 0010 narrowed the CHECK to this
	// vocabulary, and the router serves anything outside the blocking three. An
	// allow-list over 'active' alone hid every migrated provider.
	for (const status of ['operational', 'degraded']) {
		assert.deepEqual(reachability('active', { ...servable, status }, false), {
			served: true,
			reason: null
		});
	}
});

test('an unpublished model is hidden whatever the provider is doing', () => {
	for (const status of MODEL_STATUSES) {
		const result = reachability(status, servable, true);
		if (status === 'active') {
			assert.equal(result.served, true, `${status} must publish`);
		} else {
			assert.deepEqual(result, { served: false, reason: 'unpublished' }, `${status} must not publish`);
		}
	}
	// The model gate comes first: a deprecated model on a disabled provider
	// reports 'unpublished', not 'provider-off'.
	assert.equal(reachability('deprecated', { ...servable, enabled: false }, false).reason, 'unpublished');
});

test('an all-clear row is served', () => {
	assert.deepEqual(reachability('active', servable, false), { served: true, reason: null });
});

test('the dev opt-in fails closed on anything unrecognised', () => {
	for (const on of ['1', 'true', 'yes', 'on', 'TRUE', ' true ']) {
		assert.equal(devProvidersAllowed(on), true, `${JSON.stringify(on)} must enable`);
	}
	for (const off of [undefined, null, '', '0', 'no', 'off', 'false', 'maybe']) {
		assert.equal(devProvidersAllowed(off), false, `${JSON.stringify(off)} must not enable`);
	}
});
