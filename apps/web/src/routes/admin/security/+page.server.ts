import { fail } from '@sveltejs/kit';
import { and, eq, notInArray } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { parseEnum, parseBoolField, parseIntField } from '$lib/server/admin-vocab';
import { newId, ID_PREFIXES } from '$lib/server/id';
import { requireCap } from '$lib/server/roles';
import { writeAudit } from '$lib/server/audit';
import { SIGNAL_KINDS, type SecurityRuleRow } from '$lib/server/admin-signals';
import { db } from '$lib/server/db';
import { securityRule } from '$lib/server/db/schema';
/**
 * The hub manages SIGNAL rules only (PRD §70). The enforcement-list kinds —
 * `blocked_ip` and `blocked_key` — have their own pages (blocked-ips,
 * blocked-keys) and are filtered out of every query and form here so the hub
 * table cannot show or edit a rule it has no fields for.
 */
const ENFORCEMENT_KINDS = ['blocked_ip', 'blocked_key'];
const ACTIONS = ['log', 'block'] as const;
const MAX_NAME = 200;
const MAX_THRESHOLD = 10_000_000;
const MAX_WINDOW_SECONDS = 30 * 24 * 3600;
/** The hub table only shows signal rules — enforcement lists live on their own pages. */
const onlySignalRules = notInArray(securityRule.kind, ENFORCEMENT_KINDS);

export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'admin.audit');
	const rows = await db
		.select({
			id: securityRule.id,
			name: securityRule.name,
			kind: securityRule.kind,
			config: securityRule.config,
			enabled: securityRule.enabled,
			action: securityRule.action
		})
		.from(securityRule)
		.where(onlySignalRules)
		.orderBy(securityRule.name);
	const rules: SecurityRuleRow[] = rows.map((r) => ({
		...r,
		kind: r.kind as SecurityRuleRow['kind'],
		action: r.action as SecurityRuleRow['action']
	}));
	return { rules, kinds: SIGNAL_KINDS, actions: ACTIONS };
};

export const actions: Actions = {
	create: async ({ locals, request }) => {
		requireCap(locals, 'admin.audit');
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		const kind = parseEnum(SIGNAL_KINDS, form.get('kind'));
		const action = parseEnum(ACTIONS, form.get('action'));
		const threshold = parseIntField(form.get('threshold'), { min: 0, max: MAX_THRESHOLD });
		const windowSeconds = parseIntField(form.get('window_seconds'), {
			min: 1,
			max: MAX_WINDOW_SECONDS
		});
		const enabled = parseBoolField(form.get('enabled'));
		if (!name || name.length > MAX_NAME) return fail(400, { error: 'Name is required (max 200 chars)' });
		if (!kind) return fail(400, { error: 'Unknown signal kind' });
		if (!action) return fail(400, { error: 'Action must be log or block' });
		if (threshold === null || windowSeconds === null) {
			return fail(400, { error: 'Threshold and window_seconds must be whole numbers in range' });
		}
		const config = { threshold, window_seconds: windowSeconds };
		const id = newId(ID_PREFIXES.securityRule);
		try {
			await db.transaction(async (tx) => {
				await tx.insert(securityRule).values({
					id,
					name,
					kind,
					config,
					enabled,
					action
				});
				await writeAudit(tx, {
					actorUserId: locals.user?.id ?? null,
					action: 'security_rule.create',
					resource: 'security_rule',
					resourceId: id,
					after: { name, kind, action, enabled, config }
				});
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'insert failed';
			return fail(400, { error: `Could not create rule: ${msg}` });
		}
		return { created: name };
	},
	update: async ({ locals, request }) => {
		requireCap(locals, 'admin.audit');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		const name = String(form.get('name') ?? '').trim();
		const kind = parseEnum(SIGNAL_KINDS, form.get('kind'));
		const action = parseEnum(ACTIONS, form.get('action'));
		const threshold = parseIntField(form.get('threshold'), { min: 0, max: MAX_THRESHOLD });
		const windowSeconds = parseIntField(form.get('window_seconds'), {
			min: 1,
			max: MAX_WINDOW_SECONDS
		});
		const enabled = parseBoolField(form.get('enabled'));
		if (!id) return fail(400, { error: 'Missing rule id' });
		if (!name || name.length > MAX_NAME) return fail(400, { error: 'Name is required (max 200 chars)' });
		if (!kind) return fail(400, { error: 'Unknown signal kind' });
		if (!action) return fail(400, { error: 'Action must be log or block' });
		if (threshold === null || windowSeconds === null) {
			return fail(400, { error: 'Threshold and window_seconds must be whole numbers in range' });
		}
		const config = { threshold, window_seconds: windowSeconds };
		try {
			await db.transaction(async (tx) => {
				const before = await tx
					.select()
					.from(securityRule)
					.where(and(eq(securityRule.id, id), onlySignalRules))
					.limit(1);
				if (before.length === 0) throw new Error('rule not found');
				await tx
					.update(securityRule)
					.set({ name, kind, action, enabled, config, updatedAt: new Date() })
					.where(eq(securityRule.id, id));
				await writeAudit(tx, {
					actorUserId: locals.user?.id ?? null,
					action: 'security_rule.update',
					resource: 'security_rule',
					resourceId: id,
					before: {
						name: before[0].name,
						kind: before[0].kind,
						action: before[0].action,
						enabled: before[0].enabled,
						config: before[0].config
					},
					after: { name, kind, action, enabled, config }
				});
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'update failed';
			if (msg === 'rule not found') return fail(404, { error: 'Rule not found' });
			return fail(400, { error: `Could not update rule: ${msg}` });
		}
		return { updated: id };
	},
	delete: async ({ locals, request }) => {
		requireCap(locals, 'admin.audit');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing rule id' });
		try {
			await db.transaction(async (tx) => {
				const before = await tx
					.select()
					.from(securityRule)
					.where(and(eq(securityRule.id, id), onlySignalRules))
					.limit(1);
				if (before.length === 0) throw new Error('rule not found');
				await tx.delete(securityRule).where(eq(securityRule.id, id));
				await writeAudit(tx, {
					actorUserId: locals.user?.id ?? null,
					action: 'security_rule.delete',
					resource: 'security_rule',
					resourceId: id,
					before: {
						name: before[0].name,
						kind: before[0].kind,
						action: before[0].action,
						enabled: before[0].enabled,
						config: before[0].config
					}
				});
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'delete failed';
			if (msg === 'rule not found') return fail(404, { error: 'Rule not found' });
			return fail(400, { error: `Could not delete rule: ${msg}` });
		}
		return { deleted: id };
	}
};
