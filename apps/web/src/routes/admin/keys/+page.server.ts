import { fail } from '@sveltejs/kit';
import { desc, eq, sql } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { microToUsd, usdToMicro } from '$lib/server/admin';
import { requireCap } from '$lib/server/roles';
import { writeAudit } from '$lib/server/audit';
import { db } from '$lib/server/db';
import {
	apiKey,
	environment,
	project,
	requestLog,
	user,
	workspace
} from '$lib/server/db/schema';
import { generateApiKey } from '$lib/server/keys';
import { newId, ID_PREFIXES } from '$lib/server/id';
type Limits = { rpm: number | null; monthly_cost_micro: string | null };
function readLimits(form: FormData): Limits {
	const rpmRaw = String(form.get('rpm') ?? '').trim();
	const rpm = rpmRaw ? Number(rpmRaw) : null;
	return {
		rpm: rpm !== null && Number.isFinite(rpm) && rpm >= 0 ? rpm : null,
		monthly_cost_micro: usdToMicro(String(form.get('monthlyCap') ?? ''))
	};
}
export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'admin.keys');
	const users = await db
		.select({ id: user.id, email: user.email, name: user.name, role: user.role })
		.from(user)
		.orderBy(user.email);
	// Never `key_hash`: the list carries key METADATA only (name/prefix/status).
	const keys = await db
		.select({
			id: apiKey.id,
			name: apiKey.name,
			prefix: apiKey.prefix,
			status: apiKey.status,
			limits: apiKey.limits,
			lastUsedAt: apiKey.lastUsedAt,
			revokedAt: apiKey.revokedAt,
			createdAt: apiKey.createdAt,
			userId: apiKey.userId,
			email: user.email,
			workspaceName: workspace.name,
			projectName: project.name,
			environmentName: environment.name
		})
		.from(apiKey)
		.innerJoin(user, eq(user.id, apiKey.userId))
		.leftJoin(workspace, eq(workspace.id, apiKey.workspaceId))
		.leftJoin(project, eq(project.id, apiKey.projectId))
		.leftJoin(environment, eq(environment.id, apiKey.environmentId))
		.orderBy(desc(apiKey.createdAt));
	// Per-key totals — the raw material for "total usage" and "top consumer".
	const usage = await db
		.select({
			apiKeyId: requestLog.apiKeyId,
			requests: sql<number>`count(*)::int`,
			tokensIn: sql<number>`coalesce(sum(${requestLog.tokensIn}), 0)::int`,
			tokensOut: sql<number>`coalesce(sum(${requestLog.tokensOut}), 0)::int`,
			cost: sql<string>`coalesce(sum(${requestLog.cost}), 0)::text`
		})
		.from(requestLog)
		.groupBy(requestLog.apiKeyId);
	const byKey = new Map(usage.map((u) => [u.apiKeyId, u]));
	const empty = { requests: 0, tokensIn: 0, tokensOut: 0, cost: '0' };
	const rows = keys
		.map((k) => {
			const limits = (k.limits ?? {}) as Partial<Limits>;
			return {
				...k,
				usage: byKey.get(k.id) ?? empty,
				rpm: limits.rpm ?? null,
				monthlyCapUsd: limits.monthly_cost_micro ? microToUsd(limits.monthly_cost_micro) : ''
			};
		})
		.sort((a, b) => Number(BigInt(b.usage.cost) - BigInt(a.usage.cost)));
	return { users, keys: rows };
};
export const actions: Actions = {
	create: async ({ locals, request }) => {
		requireCap(locals, 'admin.keys');
		const form = await request.formData();
		const userId = String(form.get('userId') ?? '').trim();
		const name = String(form.get('name') ?? '').trim() || 'default';
		if (!userId) return fail(400, { error: 'Pick an owner for the key' });
		const limits = readLimits(form);
		const { key, prefix, keyHash } = generateApiKey();
		let createdId = '';
		try {
			await db.transaction(async (tx) => {
				const rows = await tx
					.insert(apiKey)
					.values({
						id: newId(ID_PREFIXES.apiKey),
						userId,
						name,
						prefix,
						keyHash,
						limits
					})
					.returning({ id: apiKey.id });
				createdId = rows[0].id;
				await writeAudit(tx, {
					actorUserId: locals.user?.id ?? null,
					action: 'key.create',
					resource: 'api_key',
					resourceId: createdId,
					before: null,
					// Never the secret or the hash: name/prefix/limits only.
					after: { name, prefix, userId, limits }
				});
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'insert failed';
			return fail(400, { error: `Could not create key: ${msg}` });
		}
		// Plaintext exists only in this response; only sha256(secret) is stored.
		return { created: key, name };
	},
	updateLimits: async ({ locals, request }) => {
		requireCap(locals, 'admin.keys');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing key id' });
		const limits = readLimits(form);
		try {
			await db.transaction(async (tx) => {
				const [beforeRow] = await tx
					.select({ limits: apiKey.limits })
					.from(apiKey)
					.where(eq(apiKey.id, id))
					.limit(1);
				if (!beforeRow) throw new Error('not-found');
				await tx.update(apiKey).set({ limits }).where(eq(apiKey.id, id));
				await writeAudit(tx, {
					actorUserId: locals.user?.id ?? null,
					action: 'key.limits_update',
					resource: 'api_key',
					resourceId: id,
					before: { limits: beforeRow.limits },
					after: { limits }
				});
			});
		} catch (err) {
			if (err instanceof Error && err.message === 'not-found') {
				return fail(404, { error: 'Key not found' });
			}
			throw err;
		}
		return { limitsSaved: id };
	},
	revoke: async ({ locals, request }) => {
		requireCap(locals, 'admin.keys');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing key id' });
		const revokedAt = new Date();
		try {
			await db.transaction(async (tx) => {
				const [beforeRow] = await tx
					.select({ revokedAt: apiKey.revokedAt })
					.from(apiKey)
					.where(eq(apiKey.id, id))
					.limit(1);
				if (!beforeRow) throw new Error('not-found');
				await tx.update(apiKey).set({ revokedAt }).where(eq(apiKey.id, id));
				await writeAudit(tx, {
					actorUserId: locals.user?.id ?? null,
					action: 'key.revoke',
					resource: 'api_key',
					resourceId: id,
					before: { revokedAt: beforeRow.revokedAt },
					after: { revokedAt }
				});
			});
		} catch (err) {
			if (err instanceof Error && err.message === 'not-found') {
				return fail(404, { error: 'Key not found' });
			}
			throw err;
		}
		return { revoked: id };
	},
	disableKey: async ({ locals, request }) => {
		requireCap(locals, 'admin.keys');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing key id' });
		try {
			await db.transaction(async (tx) => {
				const [beforeRow] = await tx
					.select({ status: apiKey.status })
					.from(apiKey)
					.where(eq(apiKey.id, id))
					.limit(1);
				if (!beforeRow) throw new Error('not-found');
				await tx.update(apiKey).set({ status: 'disabled' }).where(eq(apiKey.id, id));
				await writeAudit(tx, {
					actorUserId: locals.user?.id ?? null,
					action: 'key.disable',
					resource: 'api_key',
					resourceId: id,
					before: { status: beforeRow.status },
					after: { status: 'disabled' }
				});
			});
		} catch (err) {
			if (err instanceof Error && err.message === 'not-found') {
				return fail(404, { error: 'Key not found' });
			}
			throw err;
		}
		return { keyDisabled: id };
	},
	enableKey: async ({ locals, request }) => {
		requireCap(locals, 'admin.keys');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing key id' });
		try {
			await db.transaction(async (tx) => {
				const [beforeRow] = await tx
					.select({ status: apiKey.status })
					.from(apiKey)
					.where(eq(apiKey.id, id))
					.limit(1);
				if (!beforeRow) throw new Error('not-found');
				await tx.update(apiKey).set({ status: 'active' }).where(eq(apiKey.id, id));
				await writeAudit(tx, {
					actorUserId: locals.user?.id ?? null,
					action: 'key.enable',
					resource: 'api_key',
					resourceId: id,
					before: { status: beforeRow.status },
					after: { status: 'active' }
				});
			});
		} catch (err) {
			if (err instanceof Error && err.message === 'not-found') {
				return fail(404, { error: 'Key not found' });
			}
			throw err;
		}
		return { keyEnabled: id };
	}
};
