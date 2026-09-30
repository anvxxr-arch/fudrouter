import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';

// Hermetic setup (see jobs.test.ts): pin env before the first import. The
// delivery test targets a REAL loopback HTTP server, so the private-upstream
// opt-in (`ALLOW_PRIVATE_UPSTREAMS`, spec/PRD §121) is mocked at its seam
// (`publish-env`): `$env/dynamic/private` is a vite-config-time snapshot, so
// process.env writes cannot reach it from a test. Mocking the flag is also how
// the SSRF guard gets PROVEN twice — once open (delivery reaches the loopback
// receiver) and once closed (the same delivery is refused before any socket).
vi.hoisted(() => {
	process.env.DATABASE_URL ??= 'postgres://fudrouter:fudrouter@127.0.0.1:5432/fudrouter_test';
	process.env.VALKEY_URL = '';
	process.env.CREDENTIALS_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
});

const upstreams = vi.hoisted(() => ({ allowPrivate: true }));

vi.mock('$lib/server/publish-env', () => ({
	allowPrivateUpstreams: () => upstreams.allowPrivate,
	allowDevProviders: () => false
}));

import { db } from '$lib/server/db';
import { webhook, webhookDelivery, workspace } from '$lib/server/db/schema';
import { newId } from '$lib/server/id';
import { encryptCredentials } from '$lib/server/credentials';
import { checkWebhookUrl, dispatchEvent, SIGNATURE_HEADER, signBody } from '$lib/server/webhooks';
import { JOB_HANDLERS } from '$lib/server/workers';

const SECRET = 'whsec_test_secret';
let server: Server;
let hookUrl: string;
let received: { body: string; signature: string | undefined }[] = [];
let respondWith = 503;
/** Every workspace the file creates; deleting one cascades its hooks/deliveries. */
const workspaceIds: string[] = [];

beforeAll(async () => {
	server = createServer((req, res) => {
		let body = '';
		req.on('data', (chunk) => (body += chunk));
		req.on('end', () => {
			received.push({ body, signature: req.headers[SIGNATURE_HEADER] as string | undefined });
			res.writeHead(respondWith, { 'content-type': 'application/json' });
			res.end(`{"ok":${respondWith < 400}}`);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (address === null || typeof address === 'string') throw new Error('no port');
	hookUrl = `http://127.0.0.1:${address.port}/hook`;
});

afterAll(async () => {
	for (const id of workspaceIds) await db.delete(workspace).where(eq(workspace.id, id));
	await new Promise<void>((resolve) => server.close(() => resolve()));
	await db.$client.end({ timeout: 1 });
});

/** One workspace + one hook pointed at the local receiver. */
async function seedHook(
	events: string[] = ['request.failed'],
	scope: { projectId: string } | null = null
): Promise<{ workspaceId: string; hookId: string }> {
	const workspaceId = newId('wrk_');
	workspaceIds.push(workspaceId);
	await db
		.insert(workspace)
		.values({ id: workspaceId, name: 'JobsDelivery test', slug: `jobs-test-${workspaceId}` });
	const hookId = newId('whk_');
	await db.insert(webhook).values({
		id: hookId,
		workspaceId,
		projectId: scope?.projectId ?? null,
		url: hookUrl,
		secretEnc: encryptCredentials({ secret: SECRET }),
		events,
		enabled: true
	});
	return { workspaceId, hookId };
}

it('dispatchEvent creates one pending delivery per matching hook and skips the rest', async () => {
	const { workspaceId, hookId } = await seedHook(['request.failed', 'credit.low']);
	// Same workspace, non-matching event filter.
	const otherId = newId('whk_');
	await db.insert(webhook).values({
		id: otherId,
		workspaceId,
		url: hookUrl,
		events: ['budget.threshold'],
		enabled: true
	});
	// Same workspace + matching event, but scoped to another project.
	const scoped = await seedHook(['request.failed'], { projectId: 'prj_other' });

	const dispatched = await dispatchEvent('request.failed', {
		workspaceId,
		projectId: 'prj_mine',
		requestId: 'req_test'
	});
	expect(dispatched.matched).toBe(1);
	expect(dispatched.deliveryIds).toHaveLength(1);

	const rows = await db
		.select()
		.from(webhookDelivery)
		.where(
			and(
				eq(webhookDelivery.event, 'request.failed'),
				inArray(webhookDelivery.webhookId, [hookId, otherId, scoped.hookId])
			)
		);
	// Exactly the one matching hook got a delivery; neither the non-matching
	// filter nor the foreign-project scope received anything.
	expect(rows).toHaveLength(1);
	expect(rows[0].webhookId).toBe(hookId);
	expect(rows[0].status).toBe('pending');
	expect(rows[0].attempts).toBe(0);
	expect(rows[0].payload).toMatchObject({ event: 'request.failed', requestId: 'req_test' });
});

it('webhook_delivery records a 5xx response_code and retries, then delivers on 2xx', async () => {
	const { workspaceId } = await seedHook();
	const dispatched = await dispatchEvent('request.failed', {
		workspaceId,
		deliveryProbe: true
	});
	expect(dispatched.matched).toBe(1);
	const deliveryId = dispatched.deliveryIds[0];

	// Attempt 1: the receiver is broken — the response code is recorded and a
	// retry is scheduled (PRD §43 backoff).
	respondWith = 503;
	received = [];
	await JOB_HANDLERS.webhook_delivery(db, { deliveryId });
	let row = (await db.select().from(webhookDelivery).where(eq(webhookDelivery.id, deliveryId)))[0];
	expect(row.status).toBe('pending');
	expect(row.attempts).toBe(1);
	expect(row.responseCode).toBe(503);
	expect(row.error).toMatch(/503/);
	expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
	expect(row.deliveredAt).toBeNull();
	expect(received).toHaveLength(1);
	// HMAC-SHA256 over the exact bytes sent, keyed by the webhook secret
	// (PRD §43) — signing one string and sending another would verify nowhere.
	const expected = `sha256=${createHmac('sha256', SECRET).update(received[0].body).digest('hex')}`;
	expect(received[0].signature).toBe(expected);
	expect(JSON.parse(received[0].body)).toMatchObject({
		id: deliveryId,
		event: 'request.failed',
		payload: { deliveryProbe: true }
	});

	// Attempt 2 (the backoff window elapsed): delivered.
	respondWith = 200;
	await db
		.update(webhookDelivery)
		.set({ nextAttemptAt: new Date(Date.now() - 1000) })
		.where(eq(webhookDelivery.id, deliveryId));
	await JOB_HANDLERS.webhook_delivery(db, { deliveryId });
	row = (await db.select().from(webhookDelivery).where(eq(webhookDelivery.id, deliveryId)))[0];
	expect(row.status).toBe('delivered');
	expect(row.attempts).toBe(2);
	expect(row.responseCode).toBe(200);
	expect(row.error).toBeNull();
	expect(row.deliveredAt).not.toBeNull();

	// A redelivered job must not POST a settled delivery again.
	const before = received.length;
	await JOB_HANDLERS.webhook_delivery(db, { deliveryId });
	expect(received).toHaveLength(before);
});

it('signBody is keyed by the webhook secret and absent without one', () => {
	const sig = signBody('{"a":1}', encryptCredentials({ secret: SECRET }));
	expect(sig).toBe(`sha256=${createHmac('sha256', SECRET).update('{"a":1}').digest('hex')}`);
	expect(signBody('{"a":1}', null)).toBeNull();
});

it('checkWebhookUrl rejects non-http schemes and embedded credentials', async () => {
	expect(await checkWebhookUrl('ftp://example.com/x')).toMatch(/http/);
	expect(await checkWebhookUrl('https://user:pass@example.com/x')).toMatch(/credential/);
	expect(await checkWebhookUrl('not a url')).toMatch(/valid absolute URL/);
	// Loopback passes only because this process opted into private upstreams.
	expect(await checkWebhookUrl(hookUrl)).toBeNull();
});

it('refuses delivery when the SSRF guard would not allow the target', async () => {
	// The guard re-runs PER DELIVERY (PRD §121 — a stored name can re-resolve),
	// so with the private-upstream opt-in off the loopback receiver is refused
	// before any socket is opened, and the failure is recorded like any other.
	const { workspaceId } = await seedHook();
	const dispatched = await dispatchEvent('request.failed', { workspaceId, ssrfProbe: true });
	const deliveryId = dispatched.deliveryIds[0];
	upstreams.allowPrivate = false;
	const before = received.length;
	try {
		await JOB_HANDLERS.webhook_delivery(db, { deliveryId });
	} finally {
		upstreams.allowPrivate = true;
	}
	expect(received).toHaveLength(before);
	const row = (await db.select().from(webhookDelivery).where(eq(webhookDelivery.id, deliveryId)))[0];
	expect(row.status).toBe('pending');
	expect(row.responseCode).toBeNull();
	expect(row.error).toMatch(/non-public address/);
	expect(row.attempts).toBe(1);
});
