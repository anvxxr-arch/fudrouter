import { describe, expect, it } from 'vitest';
import {
	MODEL_STATUSES,
	devProvidersAllowed,
	isModelStatus,
	isPublished,
	reachability
} from './publish';

// The truth table below is a mirror of the data plane's SQL gate. If a case here
// changes, `services/router/internal/store/store.go` must change with it.
describe('publish gate', () => {
	it('serves an active model on an active provider, with or without the dev opt-in', () => {
		expect(reachability('active', 'active', false).served).toBe(true);
		expect(reachability('active', 'active', true).served).toBe(true);
	});

	it('serves a dev provider only when the opt-in is on', () => {
		expect(reachability('active', 'dev', true).served).toBe(true);
		expect(reachability('active', 'dev', false)).toEqual({ served: false, reason: 'provider-off' });
	});

	it('never serves a model on a disabled provider', () => {
		expect(reachability('active', 'disabled', true)).toEqual({
			served: false,
			reason: 'provider-off'
		});
		expect(reachability('active', 'disabled', false).served).toBe(false);
	});

	it('never serves an unpublished model, whatever the provider says', () => {
		for (const providerStatus of ['active', 'dev', 'disabled']) {
			for (const allow of [true, false]) {
				expect(reachability('disabled', providerStatus, allow)).toEqual({
					served: false,
					reason: 'unpublished'
				});
				// `dev` on a model row is a draft: the SQL gate requires 'active'.
				expect(reachability('dev', providerStatus, allow).reason).toBe('unpublished');
			}
		}
	});

	it('reports the model gate ahead of the provider gate', () => {
		// Both gates are closed; "you have not published this" is the actionable one.
		expect(reachability('disabled', 'disabled', false).reason).toBe('unpublished');
	});

	it('agrees with isPublished for every model status', () => {
		for (const status of MODEL_STATUSES) {
			expect(isPublished(status)).toBe(status === 'active');
		}
	});
});

describe('isModelStatus', () => {
	it('accepts exactly the declared statuses', () => {
		for (const status of MODEL_STATUSES) expect(isModelStatus(status)).toBe(true);
		for (const bad of ['', 'ACTIVE', 'published', 'inactive', 'dev ']) {
			expect(isModelStatus(bad)).toBe(false);
		}
	});
});

describe('devProvidersAllowed', () => {
	it('enables only on the values Go accepts', () => {
		for (const on of ['1', 'true', 'TRUE', 'yes', 'on', ' 1 ']) {
			expect(devProvidersAllowed(on), `${on} should enable`).toBe(true);
		}
	});

	it('fails closed on anything else', () => {
		for (const off of ['', '0', 'false', 'no', 'off', 'maybe', undefined, null]) {
			expect(devProvidersAllowed(off), `${String(off)} should stay closed`).toBe(false);
		}
	});
});
