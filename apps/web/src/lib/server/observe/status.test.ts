import { describe, expect, it } from 'vitest';
import {
	contentState,
	errorRetryable,
	normalizeStatus,
	statusFilterValues,
	statusTone,
	REQUEST_STATUSES,
	type RetentionPolicy
} from './status';

describe('status normalization', () => {
	it('maps every taxonomy value to itself', () => {
		for (const s of REQUEST_STATUSES) expect(normalizeStatus(s)).toBe(s);
	});
	it('maps the S0 spellings onto the taxonomy', () => {
		expect(normalizeStatus('upstream_error')).toBe('provider_error');
		expect(normalizeStatus('error')).toBe('internal_error');
	});
	it('fails closed on an unknown stored value', () => {
		expect(normalizeStatus('who_knows')).toBe('internal_error');
		expect(normalizeStatus('')).toBe('internal_error');
	});
	it('expands a filter to every stored form of the taxonomy value', () => {
		expect(statusFilterValues('provider_error')).toEqual(['provider_error', 'upstream_error']);
		expect(statusFilterValues('internal_error')).toEqual(['internal_error', 'error']);
		expect(statusFilterValues('success')).toEqual(['success']);
		expect(statusFilterValues('timeout')).toEqual(['timeout']);
	});
	it('tones by colour AND word, never colour alone', () => {
		expect(statusTone('success')).toBe('success');
		expect(statusTone('timeout')).toBe('warning');
		expect(statusTone('rate_limited')).toBe('warning');
		expect(statusTone('cancelled')).toBe('neutral');
		expect(statusTone('provider_error')).toBe('danger');
	});
});

describe('error retryability (spec §9)', () => {
	it('retries transient upstream trouble', () => {
		expect(errorRetryable('RATE_LIMITED', 429)).toBe(true);
		expect(errorRetryable('PROVIDER_TIMEOUT', null)).toBe(true);
		expect(errorRetryable('PROVIDER_UNAVAILABLE', 503)).toBe(true);
		expect(errorRetryable('CIRCUIT_OPEN', null)).toBe(true);
	});
	it('never retries a rejected request', () => {
		expect(errorRetryable('INVALID_REQUEST', 400)).toBe(false);
		expect(errorRetryable('CONTENT_REJECTED', 400)).toBe(false);
		expect(errorRetryable('AUTHENTICATION_ERROR', 401)).toBe(false);
	});
	it('gates UPSTREAM_ERROR on the HTTP status, failing closed without one', () => {
		expect(errorRetryable('UPSTREAM_ERROR', 500)).toBe(true);
		expect(errorRetryable('UPSTREAM_ERROR', 502)).toBe(true);
		expect(errorRetryable('UPSTREAM_ERROR', 429)).toBe(true);
		expect(errorRetryable('UPSTREAM_ERROR', 400)).toBe(false);
		expect(errorRetryable('UPSTREAM_ERROR', null)).toBe(false);
		expect(errorRetryable(null, 500)).toBe(false);
	});
});

describe('content retention (PRD §93-94)', () => {
	const policy: RetentionPolicy = {
		request_metadata_days: 30,
		request_content_days: 7,
		system_events_days: 30,
		audit_logs_days: 90
	};
	const now = new Date('2026-09-30T00:00:00.000Z');
	const bodies = { requestBody: '{"prompt":"hi"}', responseBody: '{"text":"yo"}' };

	it('shows bodies only inside the content window', () => {
		const fresh = { ...bodies, createdAt: new Date('2026-09-29T00:00:00.000Z') };
		const stale = { ...bodies, createdAt: new Date('2026-09-01T00:00:00.000Z') };
		expect(contentState(policy, fresh, now)).toBe('shown');
		expect(contentState(policy, stale, now)).toBe('not_retained');
	});
	it('says not retained when capture is off or the policy is missing', () => {
		const off = { ...policy, request_content_days: 0 };
		const fresh = { ...bodies, createdAt: new Date('2026-09-29T00:00:00.000Z') };
		expect(contentState(off, fresh, now)).toBe('not_retained');
		expect(contentState(null, fresh, now)).toBe('not_retained');
	});
	it('distinguishes never-captured from no-longer-retained', () => {
		const empty = { requestBody: null, responseBody: null, createdAt: new Date('2026-09-29T00:00:00.000Z') };
		expect(contentState(policy, empty, now)).toBe('not_captured');
		expect(contentState(null, empty, now)).toBe('not_retained');
	});
});
