import { and, desc, eq, sql } from 'drizzle-orm';
import { error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { alert, alertEvent, billingAccount } from '$lib/server/db/schema';
import { ensureBillingAccount, type BillingHandle } from '$lib/server/billing';
import { ID_PREFIXES, newId } from '$lib/server/id';
import {
	currentWorkspaceId,
	memberCaps,
	requireMemberPermission,
	type MemberContext
} from '$lib/server/rbac';

/**
 * The one place a billing page resolves "which workspace and account am I
 * showing". Cookie `fwid` (via `currentWorkspaceId`) picks the workspace; the
 * billing account is created on first touch (spec §2 backfill guarantees one
 * per workspace, but a workspace made outside the backfill must not dead-end
 * the page).
 *
 * `canWrite` mirrors the rbac split the PRD billing matrix draws: the `billing`
 * and `viewer` roles read, only `billing.write` posts money or edits thresholds.
 */
export interface BillingContext {
	workspaceId: string;
	member: MemberContext['member'];
	workspace: MemberContext['workspace'];
	account: typeof billingAccount.$inferSelect;
	canWrite: boolean;
}

export async function billingContext(locals: App.Locals): Promise<BillingContext> {
	const workspaceId = await currentWorkspaceId(locals);
	if (!workspaceId) error(404, 'This account has no workspace yet.');
	const { member, workspace } = await requireMemberPermission(locals, workspaceId, 'billing.read');
	const canWrite = (await memberCaps(locals, workspaceId)).has('billing.write');
	const account = await ensureBillingAccount(db, workspaceId);
	return { workspaceId, member, workspace, account, canWrite };
}

/**
 * The workspace's low-balance `alert` row (PRD §129) — the one the router fires
 * `alert_event` rows against (contract: `condition->>'type' = 'low_balance'`,
 * newest row wins). Created on first touch and kept in sync with the billing
 * account thresholds so the router's lookup always finds current values.
 */
export async function ensureLowBalanceAlert(
	dbtx: BillingHandle,
	ctx: Pick<BillingContext, 'workspaceId' | 'account'>
): Promise<typeof alert.$inferSelect> {
	const condition = {
		type: 'low_balance',
		threshold_micro: ctx.account.warningThresholdMicro.toString(),
		hard_stop_threshold_micro: ctx.account.hardStopThresholdMicro.toString()
	};
	const [existing] = await dbtx
		.select()
		.from(alert)
		.where(
			and(
				eq(alert.workspaceId, ctx.workspaceId),
				sql`${alert.condition}->>'type' = 'low_balance'`,
				eq(alert.enabled, true)
			)
		)
		.orderBy(desc(alert.createdAt))
		.limit(1);
	if (existing) {
		const [updated] = await dbtx
			.update(alert)
			.set({ condition, updatedAt: new Date() })
			.where(eq(alert.id, existing.id))
			.returning();
		return updated;
	}
	const [created] = await dbtx
		.insert(alert)
		.values({
			id: newId(ID_PREFIXES.alert),
			workspaceId: ctx.workspaceId,
			name: 'Low balance',
			condition,
			channel: 'inapp',
			enabled: true
		})
		.returning();
	return created;
}

/** The low-balance alert_events the router fired for this workspace, newest first. */
export async function lowBalanceEvents(
	ctx: Pick<BillingContext, 'workspaceId'>,
	limit = 20
): Promise<
	{
		id: string;
		triggeredAt: Date;
		value: string;
		message: string;
		state: string;
		resolvedAt: Date | null;
	}[]
> {
	return db
		.select({
			id: alertEvent.id,
			triggeredAt: alertEvent.triggeredAt,
			value: alertEvent.value,
			message: alertEvent.message,
			state: alertEvent.state,
			resolvedAt: alertEvent.resolvedAt
		})
		.from(alertEvent)
		.innerJoin(alert, eq(alert.id, alertEvent.alertId))
		.where(
			and(eq(alert.workspaceId, ctx.workspaceId), sql`${alert.condition}->>'type' = 'low_balance'`)
		)
		.orderBy(desc(alertEvent.triggeredAt))
		.limit(limit);
}
