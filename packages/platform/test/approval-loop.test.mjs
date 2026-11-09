// packages/platform/test/approval-loop.test.mjs — the durable escalation tick (B5b).
//
// Five cases (MANDAT B5b §3), no network, no DB, no process.env:
//
//   (a) init prompt primary     — a claim-less payment prompts approvers[0];
//   (b) TTL lewat -> prompt next — the escalating tick prompts approvers[1];
//   (c) answered -> nop         — a settled claim holds, never re-prompts;
//   (d) single approver -> no loop — createEscalationLoop refuses to start;
//   (e) state persist di raw.approval — a prompt tick persists the claim back.
//
// The loop is driven with an in-memory stand-in: a fake `getDb()` that vends a
// rows list plus Capture chains for the persistence read/write, a fake prompt
// recorder, and a fake clock — exactly the injection shape the console will use
// with the real drizzle handle.
//
// Run: node --test packages/platform/test/approval-loop.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tickApproval, createEscalationLoop, listOpenPayments } from '../server/approval-loop.ts';

const TTL = 900_000; // 15 minutes
const T0 = 1_700_000_000_000;
const APPROVERS = ['adm-1', 'adm-2', 'adm-3'];

// --------------------------------- fakes -----------------------------------

function fakeDb(rows) {
	// A thenable builder chain mirroring drizzle: select().from().where().limit()
	// and update().set().where(), each resolving to the programmed rows on await.
	// orderBy() records the columns the caller asked for; the await applies them
	// like Postgres would, so a test can pin the scan's order contract.
	const chain = (result) => {
		const b = {
			from: () => b,
			where: () => b,
			orderBy(...cols) {
				b._orderBy = cols;
				return b;
			},
			limit: (n) => {
				b._limit = n;
				return b;
			},
			set: () => b,
			then(resolve) {
				let out = result;
				if (Array.isArray(out) && b._orderBy?.length) {
					// drizzle hands orderBy() either a bare column (name on the
				// descriptor) or an asc()/desc() SQL wrapper whose column sits in
				// queryChunks. Read the SQL column name out of either shape.
				const SQL_TO_JS = { updated_at: 'updatedAt', created_at: 'createdAt' };
				const colName = (c) => {
					if (!c) return undefined;
					if (typeof c === 'string') return c;
					if (c.name && typeof c.name === 'string') return c.name;
					const chunks = c.queryChunks;
					if (Array.isArray(chunks)) {
						for (const ch of chunks) {
							if (ch && typeof ch.name === 'string') return ch.name;
						}
					}
					return undefined;
				};
				const keyOf = (c) => {
					const name = colName(c);
					return (name && SQL_TO_JS[name]) || name;
				};
					out = [...out].sort((x, y) => {
						for (const col of b._orderBy) {
							const key = keyOf(col);
							const a = x[key] instanceof Date ? x[key].getTime() : x[key];
							const z = y[key] instanceof Date ? y[key].getTime() : y[key];
							if (a !== z) return a < z ? -1 : 1;
						}
						return 0;
					});
				}
				if (Array.isArray(out) && b._limit !== undefined) out = out.slice(0, b._limit);
				resolve(out);
			}
		};
		return b;
	};
	return {
		select: () => chain(rows),
		update: () => chain([])
	};
}

function openRow(overrides) {
	return {
		id: 'pay_1',
		plan: 'sub_7d',
		status: 'claimed',
		raw: { proofUrl: 'https://cdn.example/p.png' },
		updatedAt: new Date(T0),
		memberName: 'member',
		proofUrl: 'https://cdn.example/p.png',
		...overrides
	};
}

function makeLoopDeps({ approvers = APPROVERS, rows = [openRow()], storedApproval = null, now = () => T0 + TTL * 2 }) {
	const prompted = [];
	const saved = [];
	// The loop reconstructs each claim from the `raw.approval` the scan already
	// fetched (no per-row load). Simulate a prior tick by injecting the claim
	// into the row's `raw`; `save` records the persisted ApprovalClaim.
	const scanRows = storedApproval
		? rows.map((r) => ({ ...r, raw: { ...(r.raw ?? {}), approval: storedApproval } }))
		: rows;
	const deps = {
		getDb: () => fakeDb(scanRows),
		approvers,
		ttlMs: TTL,
		now,
		prompt: async (idx, payment) => prompted.push({ idx, payment }),
		// Fire fast so the test does not wait a real minute.
		tickMs: 5,
		persistence: {
			save: async (paymentId, claim) => saved.push({ paymentId, claim })
		},
		log: { warn: () => {}, error: () => {} }
	};
	return { deps, prompted, saved, rows: scanRows };
}

// --- (a) init prompt primary -------------------------------------------------

test('tickApproval: no claim yet -> bootstrap and prompt the primary (0)', () => {
	const step = tickApproval(null, APPROVERS, T0, TTL);
	assert.equal(step.action, 'prompt');
	assert.equal(step.toIndex, 0);
	assert.equal(step.claim.promptedIndex, 0);
	assert.equal(step.claim.promptedAt, T0);
	assert.equal(step.claim.answeredBy, null);
});

// --- (b) TTL lewat -> prompt next -------------------------------------------

test('tickApproval: primary silent past TTL -> prompt the next approver (1)', () => {
	const step = tickApproval(
		{ promptedIndex: 0, promptedAt: T0, answeredBy: null, answeredAt: null },
		APPROVERS,
		T0 + TTL + 1,
		TTL
	);
	assert.equal(step.action, 'prompt');
	assert.equal(step.toIndex, 1);
	assert.equal(step.claim.promptedIndex, 1);
	assert.equal(step.claim.promptedAt, T0 + TTL + 1);
});

test('tickApproval: within TTL -> hold (nop), never re-prompt', () => {
	const step = tickApproval(
		{ promptedIndex: 0, promptedAt: T0, answeredBy: null, answeredAt: null },
		APPROVERS,
		T0 + TTL - 1,
		TTL
	);
	assert.equal(step.action, 'nop');
	assert.equal(step.claim, null);
});

// --- (c) answered -> nop -----------------------------------------------------

test('tickApproval: answered claim -> nop, never re-prompts', () => {
	const step = tickApproval(
		{ promptedIndex: 1, promptedAt: T0, answeredBy: 'adm-2', answeredAt: T0 + 100 },
		APPROVERS,
		T0 + TTL + 1,
		TTL
	);
	assert.equal(step.action, 'nop');
	assert.equal(step.claim, null);
});

// --- (d) single approver -> no loop -------------------------------------------

test('createEscalationLoop: a single approver refuses to start (no timer, no tick)', () => {
	const { deps } = makeLoopDeps({ approvers: ['adm-1'] });
	const loop = createEscalationLoop(deps);
	assert.equal(loop.tickCount(), 0);
	loop.stop(); // must be a no-op, not a crash
	assert.equal(loop.tickCount(), 0);
});

// --- (e) state persist di raw.approval -----------------------------------------

test('createEscalationLoop: a fresh claim within TTL is nop (transport already prompted the primary)', async () => {
	// The transport prompts the primary at CLAIM time; the loop's job is only
	// escalation. So a fresh claim (no stored approval) still within its silence
	// window must NOT re-prompt and must NOT write raw.approval.
	const row = openRow({ updatedAt: new Date(T0) }); // claimed recently
	const { deps, prompted, saved } = makeLoopDeps({
		rows: [row],
		now: () => T0 + TTL - 1 // inside the window
	});
	const loop = createEscalationLoop(deps);
	try {
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(prompted.length, 0, 'no prompt while within TTL');
		assert.equal(saved.length, 0, 'no raw.approval write while within TTL');
	} finally {
		loop.stop();
	}
});

test('createEscalationLoop: TTL elapsed with a fresh claim -> escalate + PERSIST raw.approval', async () => {
	// The MANDAT path: no raw.approval yet, so the claim is reconstructed from
	// updated_at (fallback init). Past the TTL, tickApproval escalates to the
	// secondary, prompts it and persists the claim back into raw.approval.
	const row = openRow({ updatedAt: new Date(T0) }); // claimed a while ago
	const { deps, prompted, saved } = makeLoopDeps({
		rows: [row],
		now: () => T0 + TTL * 2 // well past the silence window
	});
	const loop = createEscalationLoop(deps);
	try {
		for (let i = 0; i < 40 && prompted.length === 0; i += 1) {
			await new Promise((r) => setTimeout(r, 5));
		}
		assert.equal(prompted.length, 1, 'one escalation prompt is sent');
		assert.equal(prompted[0].idx, 1, 'escalates to the secondary');
		assert.equal(prompted[0].payment.id, 'pay_1');
		assert.equal(saved.length, 1, 'the escalated claim was persisted');
		assert.equal(saved[0].paymentId, 'pay_1');
		assert.equal(saved[0].claim.promptedIndex, 1);
		assert.equal(saved[0].claim.promptedAt, deps.now());
		assert.equal(saved[0].claim.answeredBy, null);
	} finally {
		loop.stop();
	}
});

test('createEscalationLoop: TTL elapsed with a stored claim -> prompts the next approver', async () => {
	const row = openRow({ updatedAt: new Date(T0) });
	const stored = {
		promptedIndex: 0,
		promptedAt: T0,
		answeredBy: null,
		answeredAt: null
	};
	const { deps, prompted } = makeLoopDeps({
		rows: [row],
		storedApproval: stored,
		now: () => T0 + TTL * 2 // well past the silence window
	});
	const loop = createEscalationLoop(deps);
	try {
		for (let i = 0; i < 40 && prompted.length === 0; i += 1) {
			await new Promise((r) => setTimeout(r, 5));
		}
		assert.equal(prompted.length, 1);
		assert.equal(prompted[0].idx, 1, 'escalates to the secondary');
	} finally {
		loop.stop();
	}
});


test('listOpenPayments: rows come back sorted oldest claim first', async () => {
	// Deterministic escalation: the oldest (longest-waiting) claims sit at the
	// head of the scan, so a tick handles the most overdue prompt first.
	const rows = [
		openRow({ id: 'row_2', updatedAt: new Date(T0 + 300) }),
		openRow({ id: 'row_0', updatedAt: new Date(T0 + 100) }),
		openRow({ id: 'row_1', updatedAt: new Date(T0 + 200) })
	];
	const list = await listOpenPayments(fakeDb(rows));
	assert.deepEqual(list.map((r) => r.id), ['row_0', 'row_1', 'row_2']);
});

