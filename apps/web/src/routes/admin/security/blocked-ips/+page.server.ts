import { fail } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { cleanField } from '$lib/server/admin-vocab';
import { isIpOrCidr } from '$lib/server/admin-security-store';
import { newId, ID_PREFIXES } from '$lib/server/id';
import { requireCap } from '$lib/server/roles';
import { writeAudit } from '$lib/server/audit';
import { db } from '$lib/server/db';
import { securityRule } from '$lib/server/db/schema';
/**
 * Blocked client addresses (PRD §70 enforcement list). These are NOT signals:
 * they are `security_rule` rows of kind `blocked_ip` with `action = 'block'`
 * and `config = {"cidr": …}`. The signal evaluator ignores unknown kinds, so
 * these never fire a signal — the edge matches traffic against the CIDR.
 */
const KIND = 'blocked_ip';
const MAX_NAME = 200;

export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'admin.audit');
	const rows = await db
		.select({
			id: securityRule.id,
			name: securityRule.name,
			cidr: securityRule.config,
			createdAt: securityRule.createdAt
		})
		.from(securityRule)
		.where(eq(securityRule.kind, KIND))
		.orderBy(securityRule.name);
	return {
		rules: rows.map((r) => ({
			id: r.id,
			name: r.name,
			cidr: String((r.cidr as Record<string, unknown> | null)?.cidr ?? ''),
			createdAt: r.createdAt
		}))
	};
};

export const actions: Actions = {
	add: async ({ locals, request }) => {
		requireCap(locals, 'admin.audit');
		const form = await request.formData();
		const cidr = cleanField(form.get('cidr'), 64);
		const name = cleanField(form.get('name'), MAX_NAME) ?? cidr;
		if (!cidr || !isIpOrCidr(cidr)) {
			return fail(400, { error: 'Enter a valid IP address or CIDR subnet (e.g. 203.0.113.0/24)' });
		}
		if (!name) return fail(400, { error: 'Name is required' });
		const id = newId(ID_PREFIXES.securityRule);
		const config = { cidr };
		try {
			await db.transaction(async (tx) => {
				await tx.insert(securityRule).values({
					id,
					name,
					kind: KIND,
					config,
					enabled: true,
					action: 'block'
				});
				await writeAudit(tx, {
					actorUserId: locals.user?.id ?? null,
					action: 'security_rule.create',
					resource: 'security_rule',
					resourceId: id,
					after: { name, kind: KIND, action: 'block', config },
					metadata: { page: 'admin.security.blocked-ips' }
				});
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'insert failed';
			return fail(400, { error: `Could not block address: ${msg}` });
		}
		return { added: cidr };
	},
	remove: async ({ locals, request }) => {
		requireCap(locals, 'admin.audit');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing rule id' });
		try {
			await db.transaction(async (tx) => {
				const before = await tx
					.select()
					.from(securityRule)
					.where(eq(securityRule.id, id))
					.limit(1);
				if (before.length === 0 || before[0].kind !== KIND) throw new Error('rule not found');
				await tx.delete(securityRule).where(eq(securityRule.id, id));
				await writeAudit(tx, {
					actorUserId: locals.user?.id ?? null,
					action: 'security_rule.delete',
					resource: 'security_rule',
					resourceId: id,
					before: { name: before[0].name, kind: before[0].kind, action: before[0].action, config: before[0].config },
					metadata: { page: 'admin.security.blocked-ips' }
				});
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'delete failed';
			if (msg === 'rule not found') return fail(404, { error: 'Blocked entry not found' });
			return fail(400, { error: `Could not unblock: ${msg}` });
		}
		return { removed: id };
	}
};
