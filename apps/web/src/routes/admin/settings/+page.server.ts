import { fail } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { usdToMicro } from '$lib/server/admin';
import { parseBoolField, parseIntField } from '$lib/server/admin-vocab';
import { writeAudit } from '$lib/server/audit';
import { requireCap } from '$lib/server/roles';
import { db } from '$lib/server/db';
import { billingAccount, routingPolicy } from '$lib/server/db/schema';
import { getSetting, setSetting } from '$lib/server/settings';

const DAY_MAX = 36_500;
const RPM_MAX = 10_000_000;
const TPM_MAX = 1_000_000_000_000;
const CONCURRENCY_MAX = 100_000;

export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'admin.settings');
	const [maintenance, passthrough, registration, retention, defaultRouting, hardLimits] =
		await Promise.all([
			getSetting('maintenance'),
			getSetting('generic_passthrough'),
			getSetting('registration'),
			getSetting('retention'),
			getSetting('default_routing_policy'),
			getSetting('platform_hard_limits')
		]);
	const policies = await db
		.select({ id: routingPolicy.id, name: routingPolicy.name, strategy: routingPolicy.strategy })
		.from(routingPolicy)
		.orderBy(routingPolicy.name);
	const accounts = await db
		.select({
			workspaceId: billingAccount.workspaceId,
			warningThresholdMicro: billingAccount.warningThresholdMicro,
			hardStopThresholdMicro: billingAccount.hardStopThresholdMicro
		})
		.from(billingAccount)
		.orderBy(billingAccount.createdAt);
	return {
		maintenance: maintenance?.enabled ?? false,
		genericPassthrough: passthrough?.enabled ?? false,
		registration: registration?.enabled ?? false,
		retention: {
			request_metadata_days: retention?.request_metadata_days ?? 90,
			request_content_days: retention?.request_content_days ?? 0,
			system_events_days: retention?.system_events_days ?? 90,
			audit_logs_days: retention?.audit_logs_days ?? 365
		},
		defaultRoutingPolicyId: defaultRouting?.id ?? '',
		hardLimits: {
			rpm: hardLimits?.rpm ?? 10_000,
			tpm: hardLimits?.tpm ?? 100_000_000,
			concurrency: hardLimits?.concurrency ?? 1_000
		},
		policies,
		accounts: accounts.map((a) => ({
			workspaceId: a.workspaceId,
			warningMicro: a.warningThresholdMicro.toString(),
			hardStopMicro: a.hardStopThresholdMicro.toString()
		}))
	};
};
export const actions: Actions = {
	updateGeneral: async ({ locals, request }) => {
		requireCap(locals, 'admin.settings');
		const form = await request.formData();
		const actor = locals.user?.id ?? null;
		const maintenance = { enabled: parseBoolField(form.get('maintenance')) };
		const passthrough = { enabled: parseBoolField(form.get('generic_passthrough')) };
		const beforeMaintenance = await getSetting('maintenance');
		const beforePassthrough = await getSetting('generic_passthrough');
		await db.transaction(async (tx) => {
			await setSetting('maintenance', maintenance, actor);
			await writeAudit(tx, {
				actorUserId: actor,
				action: 'system_setting.update',
				resource: 'system_setting',
				resourceId: 'maintenance',
				before: beforeMaintenance,
				after: maintenance
			});
			await setSetting('generic_passthrough', passthrough, actor);
			await writeAudit(tx, {
				actorUserId: actor,
				action: 'system_setting.update',
				resource: 'system_setting',
				resourceId: 'generic_passthrough',
				before: beforePassthrough,
				after: passthrough
			});
		});
		return { saved: 'General settings' };
	},
	updateRegistration: async ({ locals, request }) => {
		requireCap(locals, 'admin.settings');
		const form = await request.formData();
		const actor = locals.user?.id ?? null;
		const after = { enabled: parseBoolField(form.get('registration')) };
		const before = await getSetting('registration');
		await db.transaction(async (tx) => {
			await setSetting('registration', after, actor);
			await writeAudit(tx, {
				actorUserId: actor,
				action: 'system_setting.update',
				resource: 'system_setting',
				resourceId: 'registration',
				before,
				after
			});
		});
		return { saved: 'Registration settings' };
	},
	updateRetention: async ({ locals, request }) => {
		requireCap(locals, 'admin.settings');
		const form = await request.formData();
		const days = (name: string) => parseIntField(form.get(name), { min: 0, max: DAY_MAX });
		const metadata = days('request_metadata_days');
		const content = days('request_content_days');
		const events = days('system_events_days');
		const auditLogs = days('audit_logs_days');
		if (
			metadata === null ||
			content === null ||
			events === null ||
			auditLogs === null
		) {
			return fail(400, { error: 'Retention values must be whole numbers of days, 0 or more' });
		}
		const after = {
			request_metadata_days: metadata,
			request_content_days: content,
			system_events_days: events,
			audit_logs_days: auditLogs
		};
		const actor = locals.user?.id ?? null;
		const before = await getSetting('retention');
		await db.transaction(async (tx) => {
			await setSetting('retention', after, actor);
			await writeAudit(tx, {
				actorUserId: actor,
				action: 'system_setting.update',
				resource: 'system_setting',
				resourceId: 'retention',
				before,
				after
			});
		});
		return { saved: 'Retention settings' };
	},
	updateDefaultRouting: async ({ locals, request }) => {
		requireCap(locals, 'admin.settings');
		const form = await request.formData();
		const id = String(form.get('policyId') ?? '').trim();
		if (!id) return fail(400, { error: 'Pick a routing policy' });
		const exists = await db
			.select({ id: routingPolicy.id })
			.from(routingPolicy)
			.where(eq(routingPolicy.id, id))
			.limit(1);
		if (exists.length === 0) return fail(400, { error: 'Unknown routing policy' });
		const after = { id };
		const actor = locals.user?.id ?? null;
		const before = await getSetting('default_routing_policy');
		await db.transaction(async (tx) => {
			await setSetting('default_routing_policy', after, actor);
			await writeAudit(tx, {
				actorUserId: actor,
				action: 'system_setting.update',
				resource: 'system_setting',
				resourceId: 'default_routing_policy',
				before,
				after
			});
		});
		return { saved: 'Default routing policy' };
	},
	updateHardLimits: async ({ locals, request }) => {
		requireCap(locals, 'admin.settings');
		const form = await request.formData();
		const rpm = parseIntField(form.get('rpm'), { min: 0, max: RPM_MAX });
		const tpm = parseIntField(form.get('tpm'), { min: 0, max: TPM_MAX });
		const concurrency = parseIntField(form.get('concurrency'), { min: 0, max: CONCURRENCY_MAX });
		if (rpm === null || tpm === null || concurrency === null) {
			return fail(400, { error: 'Hard limits must be whole numbers, 0 or more' });
		}
		const after = { rpm, tpm, concurrency };
		const actor = locals.user?.id ?? null;
		const before = await getSetting('platform_hard_limits');
		await db.transaction(async (tx) => {
			await setSetting('platform_hard_limits', after, actor);
			await writeAudit(tx, {
				actorUserId: actor,
				action: 'system_setting.update',
				resource: 'system_setting',
				resourceId: 'platform_hard_limits',
				before,
				after
			});
		});
		return { saved: 'Platform hard limits' };
	},
	setBillingDefaults: async ({ locals, request }) => {
		requireCap(locals, 'admin.settings');
		const form = await request.formData();
		const warn = usdToMicro(String(form.get('warningUsd') ?? ''));
		const hard = usdToMicro(String(form.get('hardStopUsd') ?? ''));
		if (warn === null || hard === null) {
			return fail(400, { error: 'Enter both thresholds as USD amounts (e.g. 10.00)' });
		}
		const warningThresholdMicro = BigInt(warn);
		const hardStopThresholdMicro = BigInt(hard);
		const actor = locals.user?.id ?? null;
		await db.transaction(async (tx) => {
			const before = await tx
				.select({
					warningThresholdMicro: billingAccount.warningThresholdMicro,
					hardStopThresholdMicro: billingAccount.hardStopThresholdMicro
				})
				.from(billingAccount);
			await tx
				.update(billingAccount)
				.set({ warningThresholdMicro, hardStopThresholdMicro, updatedAt: new Date() });
			const count = BigInt(before.length);
			const beforeWarnTotal = before.reduce((s, r) => s + BigInt(r.warningThresholdMicro), 0n);
			const beforeHardTotal = before.reduce((s, r) => s + BigInt(r.hardStopThresholdMicro), 0n);
			await writeAudit(tx, {
				actorUserId: actor,
				action: 'billing_account.defaults_update',
				resource: 'billing_account',
				before: {
					accounts: before.length,
					warningThresholdMicroTotal: beforeWarnTotal.toString(),
					hardStopThresholdMicroTotal: beforeHardTotal.toString()
				},
				after: {
					accounts: before.length,
					warningThresholdMicro: warn,
					hardStopThresholdMicro: hard,
					warningThresholdMicroTotal: (warningThresholdMicro * count).toString(),
					hardStopThresholdMicroTotal: (hardStopThresholdMicro * count).toString()
				}
			});
		});
		return { saved: 'Billing defaults' };
	}
};
