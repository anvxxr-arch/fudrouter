// packages/platform/server/gateway-store.ts — the durable GatewayStore (B1/C-store).
//
// This module is the ONE Postgres-backed implementation of gateway.ts's
// `GatewayStore` interface. B1 (`gateway.ts`) defined `createPayment` + the
// interface but deliberately deferred the durable store, and the two bot
// transports (telegram-transport.mjs, discord-transport.mjs) each wrote a local
// raw-SQL copy. That got the WRITE discipline right (insert on conflict do
// nothing, then re-select the winner) but split it across two files, so the
// `findPayment` predicate drifted: discord filtered `gateway_ref AND gateway`
// while telegram filtered `gateway_ref` only. This module collapses both into
// one implementation and fixes the predicate to be precise against the durable
// UNIQUE (gateway, gateway_ref) index (migration 0025).
//
// DECISION ≠ store: `createPayment` (gateway.ts) remains the only plan/amount/
// channel/QR decision. This file persists and re-reads a pending payment row,
// nothing else. No price, no plan, no grant logic lives here.
//
// Idempotency is the store's contract (the same ON CONFLICT discipline the
// ledger relies on in billing.ts `postLedger` and the grant writer relies on in
// grant.ts): two concurrent `createPayment` calls for the same ref both see
// `null` from `findPayment`, and the loser of the insert race returns the
// winner's row — never a throw, never a second payment.

import { sql } from 'drizzle-orm';

import { newId } from './id.ts';
import type { DbTx } from './audit.ts';
import { GATEWAY_DEFAULT, type GatewayStore, type NewPayment, type PaymentRecord } from './gateway.ts';

/** A row as Postgres returns it (bigint amount), shaped into a PaymentRecord. */
function toPaymentRecord(r: Record<string, unknown>): PaymentRecord {
	return {
		id: String(r.id),
		accountId: String(r.account_id),
		channel: String(r.channel),
		gatewayRef: String(r.gateway_ref),
		gateway: String(r.gateway),
		plan: String(r.plan),
		amountIdr: Number(r.amount_idr),
		status: String(r.status) as PaymentRecord['status']
	};
}

function rowsOf(r: unknown): Record<string, unknown>[] {
	return Array.isArray(r) ? (r as Record<string, unknown>[]) : (r as { rows?: Record<string, unknown>[] })?.rows ?? [];
}

/**
 * The drizzle-backed GatewayStore. `idfn` defaults to the platform `newId` and
 * is injectable so a test (or a caller that wants a different id namespace) can
 * override it; both transports supply `newId('pay_')`.
 */
export function drizzleGatewayStore(db: DbTx, idfn: (prefix: string) => string = newId): GatewayStore {
	return {
		async findPayment(gatewayRef: string) {
			if (!db || !gatewayRef) return null;
			const rows = rowsOf(
				await db.execute(
					sql`select id, account_id, channel, gateway_ref, gateway, plan, amount_idr::bigint as amount_idr, status
						from payment where gateway_ref = ${gatewayRef} and gateway = ${GATEWAY_DEFAULT} limit 1`
				)
			);
			if (!rows[0]) return null;
			return toPaymentRecord(rows[0]);
		},
		async insertPayment(p: NewPayment) {
			if (!db) throw new Error('DATABASE_URL is not set');
			const id = idfn('pay_');
			const inserted = rowsOf(
				await db.execute(
					sql`insert into payment (id, account_id, channel, gateway_ref, gateway, plan, amount_idr, status)
						values (${id}, ${p.accountId}, ${p.channel}, ${p.gatewayRef}, ${p.gateway}, ${p.plan}, ${p.amountIdr}, ${p.status})
						on conflict (gateway, gateway_ref) do nothing
						returning id`
				)
			);
			if (inserted.length > 0) return { id: String(inserted[0].id), ...p };
			// Lost the insert race: return the winner's row, never a second payment.
			return (await this.findPayment(p.gatewayRef)) ?? { id, ...p };
		}
	};
}
