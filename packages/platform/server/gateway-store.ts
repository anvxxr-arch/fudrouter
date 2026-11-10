import { sql } from 'drizzle-orm';

import { newId } from './id.ts';
import type { DbTx } from './audit.ts';
import { GATEWAY_DEFAULT, type GatewayStore, type NewPayment, type PaymentRecord, type PaymentStatus } from './gateway.ts';

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
		status: String(r.status) as PaymentRecord['status'],
		raw: r.raw ?? undefined
	};
}

function rowsOf(r: unknown): Record<string, unknown>[] {
	return Array.isArray(r) ? (r as Record<string, unknown>[]) : (r as { rows?: Record<string, unknown>[] })?.rows ?? [];
}

/**
 * The Mayar create path needs one extra persist seam on top of the durable
 * `GatewayStore`: persisting the vendor's create facts onto `payment.raw`
 * (migration 0025) AFTER the row is inserted. It is a write-only extension — the
 * find/insert idempotency contract is unchanged.
 */
export interface MayarGatewayStore extends GatewayStore {
	/** Persist the vendor envelope for a payment we already inserted. */
	updateRaw(id: string, raw: unknown): Promise<void>;
	/** Move a payload status (e.g. pending -> failed when the vendor create dies). */
	updateStatus(id: string, status: PaymentStatus): Promise<void>;
}

/**
 * The drizzle-backed GatewayStore, scoped to ONE gateway identity.
 *
 * `gateway` defaults to `GATEWAY_DEFAULT` ('qris-native') so every existing
 * caller — the two bot transports, which pass only `(db, idfn)` — keeps the
 * exact predicate it had before this parameter existed. The Mayar path
 * instantiates its own store with `gateway = 'mayar'`, so the two histories live
 * in the same table under the durable UNIQUE (gateway, gateway_ref) index
 * (migration 0025) without either one shadowing the other: a `purchase:<key>`
 * lookup on the qris-native store can never return a Mayar row, and vice versa.
 *
 * `idfn` defaults to the platform `newId` and is injectable so a test (or a
 * caller that wants a different id namespace) can override it; both transports
 * supply `newId('pay_')`.
 */
export function drizzleGatewayStore(
	db: DbTx,
	idfn: (prefix: string) => string = newId,
	gateway: string = GATEWAY_DEFAULT
): MayarGatewayStore {
	const scopedGateway = typeof gateway === 'string' && gateway.trim() !== '' ? gateway : GATEWAY_DEFAULT;
	return {
		async findPayment(gatewayRef: string) {
			if (!db || !gatewayRef) return null;
			const rows = rowsOf(
				await db.execute(
					sql`select id, account_id, channel, gateway_ref, gateway, plan, amount_idr::bigint as amount_idr, status, raw
						from payment where gateway_ref = ${gatewayRef} and gateway = ${scopedGateway} limit 1`
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
		},
		async updateRaw(id: string, raw: unknown) {
			if (!db || !id) return;
			await db.execute(
				sql`update payment set raw = ${JSON.stringify(raw)}::jsonb, updated_at = now() where id = ${id}`
			);
		},
		async updateStatus(id: string, status: PaymentStatus) {
			if (!db || !id) return;
			await db.execute(
				sql`update payment set status = ${status}, updated_at = now() where id = ${id}`
			);
		}
	};
}