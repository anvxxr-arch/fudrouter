import type { Actions, PageServerLoad } from './$types';
import { fail } from '@sveltejs/kit';
import { and, desc, eq, isNull, type SQL } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { alert, alertEvent } from '$lib/server/db/schema';
import { newId, ID_PREFIXES } from '$lib/server/id';
import { writeAudit } from '$lib/server/audit';
import { requireCap } from '$lib/server/roles';
import { observeGate } from '$lib/server/observe/scope';
import type { AlertCondition, AlertConditionType } from '$lib/server/alerts';

/**
 * Alerts (PRD §42): CRUD on this project's `alert` rows plus the `alert_event`
 * history. Workspace-wide alerts (project_id NULL) are shown as inherited
 * context — they are managed at the workspace, not here.
 *
 * `condition` is the `AlertCondition` shape lib/server/alerts.ts evaluates:
 * { type, threshold, window_seconds?, baseline_rate? }. Units per type: ratio
 * 0–1 for the rate conditions, ms for latency, micro-units for money.
 */
const CONDITION_TYPES: AlertConditionType[] = [
	'error_rate',
	'latency',
	'budget_threshold',
	'credit_threshold',
	'fallback_rate',
	'provider_availability',
	'unusual_key_traffic'
];
const CONDITION_LABELS: Record<AlertConditionType, string> = {
	error_rate: 'Error rate (ratio 0–1)',
	latency: 'Latency (ms)',
	budget_threshold: 'Budget spend (micro-units)',
	credit_threshold: 'Credit balance (micro-units)',
	fallback_rate: 'Fallback rate (ratio 0–1)',
	provider_availability: 'Provider availability (ratio 0–1)',
	unusual_key_traffic: 'Unusual key traffic (ratio 0–1)'
};
const CHANNELS = ['inapp', 'email', 'webhook'] as const;
const DEFAULT_WINDOW_SECONDS = 300;

export const load: PageServerLoad = async ({ locals, params }) => {
	requireCap(locals, 'member');
	const gate = await observeGate(locals, params.projectId, 'alert.read');
	const shell = {
		conditionTypes: CONDITION_TYPES,
		conditionLabels: CONDITION_LABELS,
		channels: CHANNELS
	};
	if (gate.denied) return { denied: true, queryError: null, projectId: params.projectId, ...shell, alerts: [], workspaceAlerts: [], events: [] };

	try {
		const scope = and(
			eq(alert.workspaceId, gate.workspaceId),
			eq(alert.projectId, gate.project.id)
		) as SQL;
		const [rows, workspaceRows, events] = await Promise.all([
			db.select().from(alert).where(scope).orderBy(desc(alert.createdAt)),
			db
				.select()
				.from(alert)
				.where(and(eq(alert.workspaceId, gate.workspaceId), isNull(alert.projectId)) as SQL)
				.orderBy(desc(alert.createdAt)),
			db
				.select({
					id: alertEvent.id,
					alertId: alertEvent.alertId,
					alertName: alert.name,
					triggeredAt: alertEvent.triggeredAt,
					value: alertEvent.value,
					message: alertEvent.message,
					state: alertEvent.state,
					resolvedAt: alertEvent.resolvedAt,
					deliveredAt: alertEvent.deliveredAt
				})
				.from(alertEvent)
				.innerJoin(alert, eq(alert.id, alertEvent.alertId))
				.where(scope)
				.orderBy(desc(alertEvent.triggeredAt))
				.limit(50)
		]);
		return {
			denied: false,
			queryError: null,
			projectId: gate.project.id,
			projectName: gate.project.name,
			...shell,
			alerts: rows.map(rowView),
			workspaceAlerts: workspaceRows.map(rowView),
			events: events.map((e) => ({
				id: e.id,
				alertId: e.alertId,
				alertName: e.alertName,
				triggeredAt: e.triggeredAt,
				value: e.value,
				message: e.message,
				state: e.state,
				resolvedAt: e.resolvedAt,
				deliveredAt: e.deliveredAt
			}))
		};
	} catch (err) {
		console.error('[alerts] load failed', err);
		return {
			denied: false,
			queryError: 'Alerts could not be read.',
			projectId: params.projectId,
			projectName: '',
			...shell,
			alerts: [],
			workspaceAlerts: [],
			events: []
		};
	}
};

/** The alert row as the page shows it — condition kept as its typed shape. */
function rowView(a: typeof alert.$inferInsert & { id: string; createdAt: Date; updatedAt: Date }) {
	const cond = (a.condition ?? {}) as Partial<AlertCondition>;
	return {
		id: a.id,
		name: a.name,
		enabled: a.enabled ?? true,
		channel: a.channel ?? 'inapp',
		condition: {
			type: (cond.type ?? 'error_rate') as AlertConditionType,
			threshold: Number(cond.threshold ?? 0),
			windowSeconds: cond.window_seconds ?? DEFAULT_WINDOW_SECONDS,
			baselineRate: cond.baseline_rate ?? null
		},
		createdAt: a.createdAt,
		updatedAt: a.updatedAt
	};
}

type AlertForm = {
	name: string;
	channel: (typeof CHANNELS)[number];
	enabled: boolean;
	condition: AlertCondition;
};

function parseAlertForm(form: FormData): { ok: true; value: AlertForm } | { ok: false; error: string } {
	const name = String(form.get('name') ?? '').trim();
	if (!name) return { ok: false, error: 'Name is required' };
	if (name.length > 120) return { ok: false, error: 'Name is too long' };

	const type = String(form.get('type') ?? '') as AlertConditionType;
	if (!CONDITION_TYPES.includes(type)) return { ok: false, error: 'Pick a condition' };

	const threshold = Number(String(form.get('threshold') ?? '').trim());
	if (!Number.isFinite(threshold) || threshold < 0) {
		return { ok: false, error: 'Threshold must be a number at or above zero' };
	}

	const windowRaw = String(form.get('windowSeconds') ?? '').trim();
	let window_seconds: number | undefined;
	if (windowRaw) {
		if (!/^\d{1,6}$/.test(windowRaw) || Number(windowRaw) < 1) {
			return { ok: false, error: 'Window must be a whole number of seconds' };
		}
		window_seconds = Number(windowRaw);
	}

	const condition: AlertCondition = { type, threshold };
	if (window_seconds !== undefined) condition.window_seconds = window_seconds;

	const baselineRaw = String(form.get('baselineRate') ?? '').trim();
	if (baselineRaw) {
		const baseline_rate = Number(baselineRaw);
		if (!Number.isFinite(baseline_rate) || baseline_rate < 0) {
			return { ok: false, error: 'Baseline rate must be a number at or above zero' };
		}
		condition.baseline_rate = baseline_rate;
	}

	const channel = String(form.get('channel') ?? 'inapp') as (typeof CHANNELS)[number];
	if (!CHANNELS.includes(channel)) return { ok: false, error: 'Channel must be inapp, email or webhook' };
	const enabled = form.get('enabled') === 'on';
	return { ok: true, value: { name, channel, enabled, condition } };
}

export const actions: Actions = {
	create: async ({ locals, request, params }) => {
		requireCap(locals, 'member');
		const gate = await observeGate(locals, params.projectId, 'alert.write');
		if (gate.denied) return fail(403, { error: 'You do not manage alerts for this project' });
		const parsed = parseAlertForm(await request.formData());
		if (!parsed.ok) return fail(400, { error: parsed.error });
		const id = newId(ID_PREFIXES.alert);
		await db.transaction(async (tx) => {
			await tx.insert(alert).values({
				id,
				workspaceId: gate.workspaceId,
				projectId: gate.project.id,
				name: parsed.value.name,
				condition: parsed.value.condition as unknown as Record<string, unknown>,
				channel: parsed.value.channel,
				enabled: parsed.value.enabled
			});
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: 'alert.create',
				resource: 'alert',
				resourceId: id,
				workspaceId: gate.workspaceId,
				after: { name: parsed.value.name, channel: parsed.value.channel, condition: parsed.value.condition }
			});
		});
		return { saved: id };
	},
	update: async ({ locals, request, params }) => {
		requireCap(locals, 'member');
		const gate = await observeGate(locals, params.projectId, 'alert.write');
		if (gate.denied) return fail(403, { error: 'You do not manage alerts for this project' });
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing alert id' });
		const parsed = parseAlertForm(form);
		if (!parsed.ok) return fail(400, { error: parsed.error });
		const [before] = await db
			.select()
			.from(alert)
			.where(and(eq(alert.id, id), eq(alert.projectId, gate.project.id)))
			.limit(1);
		if (!before) return fail(404, { error: 'Alert not found' });
		await db.transaction(async (tx) => {
			await tx
				.update(alert)
				.set({
					name: parsed.value.name,
					condition: parsed.value.condition as unknown as Record<string, unknown>,
					channel: parsed.value.channel,
					enabled: parsed.value.enabled,
					updatedAt: new Date()
				})
				.where(eq(alert.id, id));
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: 'alert.update',
				resource: 'alert',
				resourceId: id,
				workspaceId: gate.workspaceId,
				before: { name: before.name, channel: before.channel, enabled: before.enabled },
				after: { name: parsed.value.name, channel: parsed.value.channel, enabled: parsed.value.enabled }
			});
		});
		return { saved: id };
	},
	remove: async ({ locals, request, params }) => {
		requireCap(locals, 'member');
		const gate = await observeGate(locals, params.projectId, 'alert.write');
		if (gate.denied) return fail(403, { error: 'You do not manage alerts for this project' });
		const id = String((await request.formData()).get('id') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing alert id' });
		// Project-scoped only: a workspace-wide alert is managed at the workspace.
		const [before] = await db
			.select()
			.from(alert)
			.where(and(eq(alert.id, id), eq(alert.projectId, gate.project.id)))
			.limit(1);
		if (!before) return fail(404, { error: 'Alert not found' });
		await db.transaction(async (tx) => {
			// alert_event rows cascade with the alert (schema onDelete: cascade) —
			// the history goes with it because an orphan event names nothing.
			await tx.delete(alert).where(eq(alert.id, id));
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: 'alert.delete',
				resource: 'alert',
				resourceId: id,
				workspaceId: gate.workspaceId,
				before: { name: before.name, channel: before.channel }
			});
		});
		return { removed: id };
	}
};
