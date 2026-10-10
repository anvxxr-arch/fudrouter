#!/usr/bin/env node
// Verify the credential-probe cooldown fix against the LIVE database.
//
// Before the fix, `credentialValidation` mapped a 401 onto `credential.status =
// 'auth_failed'` and wrote nothing else — but the router's usable predicate is
// `status not in ('disabled','invalid') AND (cooldown_until IS NULL OR
// cooldown_until <= now())`, so an `auth_failed` row stayed fully routable and
// every request kept spending a pool-walk slot on a credential the probe had
// already rejected. This asserts the handler now parks the credential.
//
// Read-only apart from the handler's own writes. Usage:
//   set -a && . .env && set +a && node scratch/verify-credential-cooldown.mjs
import { installTsHooks, libUrl } from '/home/dwizzy/fudrouter/scripts/ts-hooks.mjs';

const { libRoot } = installTsHooks('/home/dwizzy/fudrouter/scripts');

const { db } = await import(libUrl(libRoot, 'server/db/index.ts'));
const { JOB_HANDLERS } = await import(libUrl(libRoot, 'server/workers.ts'));
const { credential } = await import(libUrl(libRoot, 'server/db/schema.ts'));
const { eq, sql } = await import('drizzle-orm');

// The router's own predicate, in SQL, so "usable" here means what the data plane
// means by it (services/router/internal/store).
const USABLE = sql`status not in ('disabled','invalid') and (cooldown_until is null or cooldown_until <= now())`;

const connArg = process.argv[2] ?? '';
const [target] = await db
	.select({ id: credential.id, connectionId: credential.connectionId, status: credential.status })
	.from(credential)
	.where(
		connArg
			? sql`connection_id = ${connArg} and status = 'auth_failed'`
			: sql`status = 'auth_failed'`
	)
	.orderBy(sql`cooldown_until nulls first`, credential.id)
	.limit(1);
if (!target) {
	console.error('no auth_failed credential found to test');
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

let bad = 0;
const expect = (ok, label) => {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
	if (!ok) bad += 1;
};
expect(after.status === 'auth_failed', 'handler kept the auth_failed verdict');
expect(after.cooldownUntil !== null, 'handler wrote a cooldown_until');
expect(after.usable === false, 'router predicate now withholds the credential');
expect(before.usable === true, 'the row WAS routable before the fix (regression reproduced)');

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILURE(S)`);
await db.$client.end({ timeout: 1 });
process.exit(bad === 0 ? 0 : 1);
