import { fail } from '@sveltejs/kit';
import { eq, inArray, notInArray } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { cleanField } from '$lib/server/admin-vocab';
import { newId, ID_PREFIXES } from '$lib/server/id';
import { requireCap } from '$lib/server/roles';
import { writeAudit } from '$lib/server/audit';
import { db } from '$lib/server/db';
import { apiKey, securityRule } from '$lib/server/db/schema';
/**
 * Blocked API keys (PRD §70 enforcement list): `security_rule` rows of kind
 * `blocked_key` with `action = 'block'` and `config = {"key_id": …}`, rendered
 * with the key's name and prefix. The key hash column is never selected here —
 * display and audit carry metadata only, never anything secret-derived.
 */
const KIND = 'blocked_key';
const MAX_NAME = 200;

/** Key columns safe for display: id, name, prefix, status. No hash column. */
const KEY_DISPLAY = {
	id: apiKey.id,
	name: apiKey.name,
	prefix: apiKey.prefix,
	status: apiKey.status
};

export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'admin.audit');
	const rows = await db
		.select({
			id: securityRule.id,
			name: securityRule.name,
			keyId: securityRule.config,
			createdAt: securityRule.createdAt
		})
		.from(securityRule)
		.where(eq(securityRule.kind, KIND))
		.orderBy(securityRule.name);
	const ruleKeyIds = rows
		.map((r) => String((r.keyId as Record<string, unknown> | null)?.key_id ?? ''))
		.filter((id) => id.length > 0);
	// Name/prefix for each blocked key while it still exists; never the hash column.
	const blockedRows =
		ruleKeyIds.length > 0
			? await db
					.select(KEY_DISPLAY)
					.from(apiKey)
					.where(inArray(apiKey.id, ruleKeyIds))
					.limit(500)
			: [];
	const blockedById: Record<string, (typeof blockedRows)[number]> = {};
	for (const k of blockedRows) blockedById[k.id] = k;
	// The keys an admin can choose to block: id/name/prefix only, no hash column read.
	const keys =
		ruleKeyIds.length > 0
			? await db
					.select(KEY_DISPLAY)
					.from(apiKey)
					.where(notInArray(apiKey.id, ruleKeyIds))
					.orderBy(apiKey.name)
					.limit(500)
			: await db.select(KEY_DISPLAY).from(apiKey).orderBy(apiKey.name).limit(500);
	return {
		rules: rows.map((r) => {
			const keyId = String((r.keyId as Record<string, unknown> | null)?.key_id ?? '');
			const hit = blockedById[keyId];
			return {
				id: r.id,
				name: r.name,
				keyId,
				keyName: hit?.name ?? null,
				keyPrefix: hit?.prefix ?? null,
				keyStatus: hit?.status ?? null,
				createdAt: r.createdAt
			};
		}),
		keys
	};
};

export const actions: Actions = {
	add: async ({ locals, request }) => {
		requireCap(locals, 'admin.audit');
		const form = await request.formData();
		const keyId = cleanField(form.get('key_id'), 120);
		if (!keyId) return fail(400, { error: 'Choose an API key to block' });
		// Name/prefix only — the hash column is never read or written here.
		const key = await db
			.select(KEY_DISPLAY)
			.from(apiKey)
			.where(eq(apiKey.id, keyId))
			.limit(1);
		if (key.length === 0) return fail(404, { error: 'API key not found' });
		const name = cleanField(form.get('name'), MAX_NAME) ?? `blocked key ${key[0].prefix}`;
		const id = newId(ID_PREFIXES.securityRule);
		const config = { key_id: key[0].id };
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
					after: {
						name,
						kind: KIND,
						action: 'block',
						config,
						keyName: key[0].name,
						keyPrefix: key[0].prefix
					},
					metadata: { page: 'admin.security.blocked-keys' }
				});
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'insert failed';
			return fail(400, { error: `Could not block key: ${msg}` });
		}
		return { added: key[0].name };
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
					before: {
						name: before[0].name,
						kind: before[0].kind,
						action: before[0].action,
						config: before[0].config
					},
					metadata: { page: 'admin.security.blocked-keys' }
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
