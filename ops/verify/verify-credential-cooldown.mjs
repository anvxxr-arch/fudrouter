#!/usr/bin/env node
// Verify the credential-probe verdict mapping against the LIVE database.
//
// Doctrine (2026-10-31): the router's usable predicate is
// `status not in ('disabled','invalid') AND (cooldown_until IS NULL OR
// cooldown_until <= now())`. A revoked key (upstream 401/403) MUST land on
// `invalid` — the one status the predicate actually excludes. The handler used
// to write `auth_failed`, which is NOT an exclusion: the pool kept selecting a
// key the probe had just rejected, every request burned a pool-walk slot on it,
// and the row stayed routable forever because the hourly probe re-found it.
// A cooldown is therefore NOT the mechanism for a revoked key (it was the old
// workaround); it now exists for the transient `rate_limited` verdict only.
//
// Usage (plant a dead key first, e.g. `go run ./cmd/credcanary plant mistral`):
//   set -a && . .env && set +a && node ops/verify/verify-credential-cooldown.mjs [credentialId]
const { db } = await import('@fudrouter/platform/server/db/index.ts');
const { JOB_HANDLERS } = await import('@fudrouter/platform/server/workers.ts');
const { credential } = await import('@fudrouter/platform/server/db/schema.ts');
const { eq, sql } = await import('drizzle-orm');

// The router's own predicate, in SQL, so "usable" here means what the data plane
// means by it (backend/go/internal/store).
const USABLE = sql`status not in ('disabled','invalid') and (cooldown_until is null or cooldown_until <= now())`;

const credArg = process.argv[2] ?? '';
const [target] = await db
	.select({ id: credential.id, connectionId: credential.connectionId, status: credential.status })
	.from(credential)
	.where(credArg ? sql`id = ${credArg}` : sql`id like 'cred_canary_%'`)
	.orderBy(credential.id)
	.limit(1);
if (!target) {
	console.error('no target credential found (pass a credential id, or plant a canary)');
	await db.$client.end({ timeout: 1 });
	process.exit(1);
}

const snap = async (id) => {
	const [r] = await db
		.select({ status: credential.status, cooldownUntil: credential.cooldownUntil })
		.from(credential)
		.where(eq(credential.id, id));
	const [u] = await db.select({ usable: sql`(${USABLE})::int` }).from(credential).where(eq(credential.id, id));
	return { ...r, usable: u.usable === 1 };
};

const before = await snap(target.id);
console.log(`target  ${target.id}  (connection ${target.connectionId})`);
console.log(`before  status=${before.status} cooldownUntil=${before.cooldownUntil} routable=${before.usable}`);

await JOB_HANDLERS.credential_validation(db, { credentialId: target.id });

const after = await snap(target.id);
const mins = after.cooldownUntil ? Math.round((new Date(after.cooldownUntil) - Date.now()) / 60000) : null;
console.log(`after   status=${after.status} cooldownUntil=${after.cooldownUntil} (~${mins}min) routable=${after.usable}`);

const [evt] = await db.execute(
	sql`select type, metadata->>'httpStatus' as http from system_event where resource_id = ${target.id} order by created_at desc limit 1`
).then((r) => r.rows ?? r);
console.log(`event   ${evt ? `${evt.type} http=${evt.http}` : '(none)'}`);

let bad = 0;
const expect = (ok, label) => {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
	if (!ok) bad += 1;
};
expect(before.usable === true, 'the row WAS routable before the probe (regression reproduced)');
expect(after.status === 'invalid', "401/403 verdict is written as 'invalid' (the predicate's hard exclusion)");
expect(after.status !== 'auth_failed', "handler no longer writes 'auth_failed' (the status the picker serves)");
expect(after.usable === false, 'router predicate withholds the credential by exclusion, not by cooldown');
expect(evt?.type === 'credential.invalid', "a credential.invalid system_event records the transition");

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILURE(S)`);
await db.$client.end({ timeout: 1 });
process.exit(bad === 0 ? 0 : 1);
