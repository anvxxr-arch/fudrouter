import { createHmac } from 'node:crypto';
import { and, eq, lte, sql } from 'drizzle-orm';
import type { PostgresJsDatabase, PostgresJsQueryResultHKT } from 'drizzle-orm/postgres-js';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import { decryptCredentials } from './credentials.ts';
import { db } from './db/index.ts';
import { webhook, webhookDelivery } from './db/schema.ts';
import { newId } from './id.ts';
import { backoffMs, enqueue, type JobHandle } from './jobs.ts';
import { allowPrivateUpstreams } from './publish-env.ts';
import { assertPublicUpstream, guardedUpstreamFetch } from './ssrf.ts';
import { bumpVersion, setJSON } from './vk.ts';

/**
 * Outbound webhooks (PRD §43, spec §11).
 *
 * `dispatchEvent` fans an internal event out to every matching `webhook` row
 * (scope + `events` jsonb filter + enabled), inserting one `webhook_delivery`
 * per target in state `pending` plus one `webhook_delivery` job to move it.
 * Delivery state is DURABLE in PostgreSQL; Valkey only carries a
 * `job:wake:webhook_delivery` hint (spec §11 — losing it delays nothing that a
 * poll would not recover).
 *
 * Signature (PRD §43): `X-FUD-Signature: sha256=<hex HMAC of the exact request
 * body>` keyed with `webhook.secret_enc` decrypted through `lib/server/credentials`.
 * The body is the canonical JSON serialization computed ONCE and both hashed and
 * sent — signing one string and sending another is the classic webhook bug.
 *
 * SSRF (PRD §121): a webhook URL is admin/customer-supplied and is fetched
 * server-side, so it passes the `lib/server/ssrf` guard AT REGISTRATION and
 * AGAIN ON EVERY DELIVERY — a stored name can re-resolve to a private address
 * between the two (DNS rebind), and only the per-delivery check catches that.
 *
 * Retries (PRD §43): HTTP 2xx completes; 5xx / 429 / transport failure / guard
 * rejection retry with exponential backoff (`backoffMs`) up to `max_attempts`;
 * other 4xx are permanent failures recorded immediately — retrying a 404 URL
 * just multiplies noise. Delivery idempotency comes from the row's state:
 * only a `pending` row is POSTed, so a redelivered job cannot double-POST.
 */

export type WebhookDb = PostgresJsDatabase<Record<string, unknown>>;
export type WebhookTx = PgTransaction<
	PostgresJsQueryResultHKT,
	Record<string, unknown>,
	Record<string, never>
>;
export type WebhookHandle = WebhookDb | WebhookTx | JobHandle;

/** The internal event vocabulary (PRD §43). */
export const WEBHOOK_EVENTS = [
	'request.failed',
	'budget.threshold',
	'credit.low',
	'provider.degraded',
	'provider.recovered',
	'routing.failover',
	'key.revoked'
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export interface EventPayload {
	workspaceId?: string | null;
	projectId?: string | null;
	[key: string]: unknown;
}

export interface WebhookMatch {
	id: string;
	url: string;
	secretEnc: string | null;
	maxAttempts: number;
}

export interface DispatchResult {
	matched: number;
	deliveryIds: string[];
}

/** How long one delivery POST may take. */
export const WEBHOOK_TIMEOUT_MS = 10_000;

/**
 * Registration-time URL screen (PRD §121). Returns a reason string the caller
 * can show the admin, or null when the URL is acceptable. The same rule runs
 * again per delivery — this one only stops a bad URL from being stored.
 */
export async function checkWebhookUrl(url: string): Promise<string | null> {
	const allowPrivate = allowPrivateUpstreams();
	let parsed: URL;
	try {
		parsed = new URL(url.trim());
	} catch {
		return 'url is not a valid absolute URL';
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
		return 'url must use http or https';
	}
	if (parsed.username || parsed.password) {
		return 'url must not embed credentials';
	}
	const guard = await assertPublicUpstream(url, allowPrivate);
	return guard.ok ? null : guard.reason;
}

/**
 * Fan an internal event out to matching webhooks.
 *
 * Matching is by scope (exact workspace, and the hook's `project_id` must be
 * NULL or equal to the event's) plus the `events` jsonb filter — an empty or
 * absent filter means "all events" (a hook that subscribes to nothing gets
 * nothing, but the schema default is `[]` and would silently unsubscribe every
 * existing hook if read literally).
 */
export async function dispatchEvent(
	event: WebhookEvent,
	payload: EventPayload,
	handle: WebhookHandle = db
): Promise<DispatchResult> {
	const workspaceId = payload.workspaceId ?? null;
	if (!workspaceId) return { matched: 0, deliveryIds: [] };
	const projectId = payload.projectId ?? null;
	const candidates = await handle
		.select({
			id: webhook.id,
			url: webhook.url,
			secretEnc: webhook.secretEnc,
			events: webhook.events
		})
		.from(webhook)
		.where(
			and(
				eq(webhook.workspaceId, workspaceId),
				eq(webhook.enabled, true),
				projectId === null ? sql`true` : sql`(${webhook.projectId} is null or ${webhook.projectId} = ${projectId})`
			)
		);
	const matches: WebhookMatch[] = [];
	for (const c of candidates) {
		const filter = Array.isArray(c.events) ? (c.events as string[]) : [];
		if (filter.length > 0 && !filter.includes(event)) continue;
		matches.push({ id: c.id, url: c.url, secretEnc: c.secretEnc, maxAttempts: 5 });
	}
	const deliveryIds: string[] = [];
	const now = new Date();
	for (const m of matches) {
		const id = newId('whd_');
		deliveryIds.push(id);
		await handle.insert(webhookDelivery).values({
			id,
			webhookId: m.id,
			event,
			payload: { ...payload, event },
			status: 'pending',
			attempts: 0,
			maxAttempts: m.maxAttempts,
			nextAttemptAt: now
		});
		await enqueue('webhook_delivery', { deliveryId: id }, { maxAttempts: 1 }, handle);
	}
	await bumpVersion('webhook_delivery');
	return { matched: matches.length, deliveryIds };
}

/** The HMAC header name and prefix receivers must verify against (PRD §43). */
export const SIGNATURE_HEADER = 'x-fud-signature';

/**
 * Sign a delivery body with the webhook secret. `secretEnc` is the S0
 * AES-GCM envelope (spec §4) whose plaintext is an account JSON — the signing
 * key is `secret` when present (the dedicated webhook signing secret), else the
 * account's `api_key`, else the envelope is used as the raw key so a plain
 * string secret also works. No secret is ever logged or returned.
 */
export function signBody(body: string, secretEnc: string | null): string | null {
	if (!secretEnc) return null;
	const plain = decryptCredentials(secretEnc);
	const key =
		typeof plain.secret === 'string'
			? plain.secret
			: typeof plain.api_key === 'string'
				? plain.api_key
				: JSON.stringify(plain);
	return `sha256=${createHmac('sha256', key).update(body).digest('hex')}`;
}

export type DeliveryOutcome =
	| { kind: 'delivered'; responseCode: number }
	| { kind: 'retry'; responseCode: number | null; error: string }
	| { kind: 'failed'; responseCode: number | null; error: string }
	| { kind: 'skipped' };

/**
 * Attempt one `webhook_delivery` row (the `webhook_delivery` job handler body).
 *
 * Idempotent across redelivery: a row that is no longer `pending` is skipped —
 * only the transition `pending → delivered|failed|pending(retry)` ever POSTs.
 */
export async function deliverWebhook(deliveryId: string): Promise<DeliveryOutcome> {
	const rows = await db
		.select({
			id: webhookDelivery.id,
			status: webhookDelivery.status,
			attempts: webhookDelivery.attempts,
			maxAttempts: webhookDelivery.maxAttempts,
			event: webhookDelivery.event,
			payload: webhookDelivery.payload,
			secretEnc: webhook.secretEnc,
			url: webhook.url,
			enabled: webhook.enabled
		})
		.from(webhookDelivery)
		.innerJoin(webhook, eq(webhookDelivery.webhookId, webhook.id))
		.where(eq(webhookDelivery.id, deliveryId))
		.limit(1);
	const row = rows[0];
	if (!row || row.status !== 'pending') return { kind: 'skipped' };

	const attempts = row.attempts + 1;
	// One canonical serialization, hashed and sent (see header).
	const body = JSON.stringify({ id: row.id, event: row.event, payload: row.payload });
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		'user-agent': 'fudrouter-webhooks/1'
	};
	const signature = signBody(body, row.secretEnc);
	if (signature) headers[SIGNATURE_HEADER] = signature;

	const guard = await assertPublicUpstream(row.url, allowPrivateUpstreams());
	if (!guard.ok) {
		return finalizeAttempt(row.id, attempts, row.maxAttempts, null, `blocked: ${guard.reason}`);
	}
	const sent = await guardedUpstreamFetch(row.url, allowPrivateUpstreams(), '', {
		method: 'POST',
		headers,
		body,
		timeoutMs: WEBHOOK_TIMEOUT_MS
	});
	if (!sent.ok) {
		return finalizeAttempt(row.id, attempts, row.maxAttempts, null, sent.message);
	}
	const code = sent.response.status;
	if (code >= 200 && code < 300) {
		await db
			.update(webhookDelivery)
			.set({ status: 'delivered', attempts, responseCode: code, error: null, deliveredAt: new Date() })
			.where(eq(webhookDelivery.id, row.id));
		await bumpVersion('webhook_delivery');
		return { kind: 'delivered', responseCode: code };
	}
	// Drain the body so the socket closes; the content is never trusted or stored.
	await sent.response.text().catch(() => '');
	return finalizeAttempt(
		row.id,
		attempts,
		row.maxAttempts,
		code,
		`upstream responded ${code}`,
		// 5xx and 429 are transient upstream states (PRD §43 retries); any other
		// 4xx is the receiver rejecting the event and will never succeed.
		code >= 500 || code === 429
	);
}

async function finalizeAttempt(
	id: string,
	attempts: number,
	maxAttempts: number,
	responseCode: number | null,
	error: string,
	retryable = true
): Promise<DeliveryOutcome> {
	const message = error.length > 2000 ? `${error.slice(0, 2000)}…` : error;
	if (retryable && attempts < maxAttempts) {
		const retryAt = new Date(Date.now() + backoffMs(attempts));
		await db
			.update(webhookDelivery)
			.set({ attempts, responseCode, error: message, nextAttemptAt: retryAt })
			.where(eq(webhookDelivery.id, id));
		await setJSON(`job:wake:webhook_delivery`, String(retryAt.getTime()), 60_000);
		return { kind: 'retry', responseCode, error: message };
	}
	await db
		.update(webhookDelivery)
		.set({ status: 'failed', attempts, responseCode, error: message })
		.where(eq(webhookDelivery.id, id));
	await bumpVersion('webhook_delivery');
	return { kind: 'failed', responseCode, error: message };
}

/**
 * Sweep deliveries whose retry window has arrived (the `webhook_delivery` job's
 * ready-check). Each ready row becomes its own attempt — the job re-runs the
 * sweep and reschedules itself while pending rows remain.
 */
export async function pendingDeliveriesReady(now = new Date()): Promise<string[]> {
	const rows = await db
		.select({ id: webhookDelivery.id })
		.from(webhookDelivery)
		.where(and(eq(webhookDelivery.status, 'pending'), lte(webhookDelivery.nextAttemptAt, now)))
		.orderBy(webhookDelivery.nextAttemptAt)
		.limit(100);
	return rows.map((r) => r.id);
}
