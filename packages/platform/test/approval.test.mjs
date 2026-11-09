// packages/platform/test/approval.test.mjs — the B5 escalation contract.
//
// Four pure cases (MANDAT §5), no network, no DB, no process.env: the clock is
// injected as epoch milliseconds, exactly as the adapters' transports will.
//
//   (a) primary   answered before TTL  -> no escalation;
//   (b) primary   silent    past   TTL -> escalate to [1];
//   (c) all       silent               -> the queue stays at [1] (no repeat);
//   (d) parseApprovers empty/malformed -> fail-closed ([] or a clear error).
//
// Run: node --test packages/platform/test/approval.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	nextApprover,
	approvalRoute,
	parseApprovers,
	parseApprovalTtlMs,
	DEFAULT_APPROVAL_TTL_MS
} from '../server/approval.ts';

const TTL = 900_000; // 15 minutes
const T0 = 1_700_000_000_000;

// --- (a) primary answered before TTL -> no escalation ----------------------

test('nextApprover: primary answered -> no escalation (null)', () => {
	assert.equal(nextApprover(['a', 'b'], 'a', T0, TTL, T0 + TTL - 1), null);
	// answered long after the TTL is still settled: no hand-off.
	assert.equal(nextApprover(['a', 'b'], 'a', T0, TTL, T0 + TTL + 1), null);
});

test('nextApprover: still within the TTL -> wait, no escalation', () => {
	assert.equal(nextApprover(['a', 'b'], null, T0, TTL, T0 + TTL - 1), null);
});

test('nextApprover: a single approver cannot escalate -> null', () => {
	assert.equal(nextApprover(['a'], null, T0, TTL, T0 + TTL + 1), null);
	assert.equal(nextApprover([], null, T0, TTL, T0 + TTL + 1), null);
});

// --- (b) primary silent past TTL -> escalate to [1] ------------------------

test('nextApprover: primary silent past TTL -> escalate to approvers[1]', () => {
	assert.equal(nextApprover(['a', 'b'], null, T0, TTL, T0 + TTL + 1), 'b');
});

test('approvalRoute: primary silent past TTL -> advances index 0 -> 1', () => {
	const claim = { promptedIndex: 0, promptedAt: T0, answeredBy: null, answeredAt: null };
	assert.equal(approvalRoute(claim, ['a', 'b'], T0 + TTL + 1, TTL), 1);
});

// --- (c) all approvers silent -> the queue stays at [1] (no repeat) --------

test('approvalRoute: all silent at the last approver -> stays at [1]', () => {
	const claim = { promptedIndex: 1, promptedAt: T0, answeredBy: null, answeredAt: null };
	// Past the TTL again, but there is no approver after [1] to hand off to:
	// the queue must NOT wrap back to [0] and must NOT advance again.
	assert.equal(approvalRoute(claim, ['a', 'b'], T0 + TTL + 1, TTL), 1);
	// Before/within the TTL it also holds where it is.
	assert.equal(approvalRoute(claim, ['a', 'b'], T0 + 1, TTL), 1);
});

test('approvalRoute: an answered claim is settled -> null', () => {
	const claim = { promptedIndex: 1, promptedAt: T0, answeredBy: 'b', answeredAt: T0 + 1 };
	assert.equal(approvalRoute(claim, ['a', 'b'], T0 + TTL + 1, TTL), null);
});

// --- (d) parseApprovers empty/malformed -> fail closed ----------------------

test('parseApprovers: empty / whitespace / unset -> []', () => {
	assert.deepEqual(parseApprovers(''), []);
	assert.deepEqual(parseApprovers('   '), []);
	assert.deepEqual(parseApprovers(' , , '), []);
	assert.deepEqual(parseApprovers(null), []);
	assert.deepEqual(parseApprovers(undefined), []);
});

test('parseApprovers: non-empty malformed entry -> a clear error', () => {
	assert.throws(() => parseApprovers('9000 8000'), /invalid approver id/);
	assert.throws(() => parseApprovers('9000,,bad id'), /invalid approver id/);
});

test('parseApprovers: trims, drops empties, dedupes, preserves order', () => {
	assert.deepEqual(parseApprovers('9000, 9001 ,9000,'), ['9000', '9001']);
	assert.deepEqual(parseApprovers('-1001234567890,@zupaxx'), ['-1001234567890', '@zupaxx']);
});

test('parseApprovalTtlMs: unset/malformed -> 15-minute default; valid -> parsed', () => {
	assert.equal(parseApprovalTtlMs(undefined), DEFAULT_APPROVAL_TTL_MS);
	assert.equal(parseApprovalTtlMs(''), DEFAULT_APPROVAL_TTL_MS);
	assert.equal(parseApprovalTtlMs('nope'), DEFAULT_APPROVAL_TTL_MS);
	assert.equal(parseApprovalTtlMs('-5'), DEFAULT_APPROVAL_TTL_MS);
	assert.equal(parseApprovalTtlMs('60000'), 60000);
});