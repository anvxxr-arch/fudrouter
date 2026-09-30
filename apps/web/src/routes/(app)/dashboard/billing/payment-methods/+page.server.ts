import { eq } from 'drizzle-orm';
import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { systemSetting } from '$lib/server/db/schema';
import { writeAudit } from '$lib/server/audit';
import { requireCap } from '$lib/server/roles';
import { billingContext } from '../billing-context.server';

/**
 * Payment methods (PRD §47): HONEST EMPTY STATE + intent, no fake payment flow.
 *
 * There is no payment method on file and nothing on this page pretends
 * otherwise. What exists is a form that records HOW a workspace wants to be
 * billed (a `system_setting` row keyed per workspace) — an operator picks it up
 * and sets up billing offline. No card fields, no tokenization stub, no
 * "connect" button that connects nothing.
 */
const settingKey = (workspaceId: string) => `billing.payment_method_intent:${workspaceId}`;

export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'member');
	const ctx = await billingContext(locals);
	const [row] = await db
		.select()
		.from(systemSetting)
		.where(eq(systemSetting.key, settingKey(ctx.workspaceId)))
		.limit(1);
	const intent = (row?.value ?? null) as {
		method?: string;
		contact?: string;
		note?: string;
		recordedAt?: string;
	} | null;
	return {
		canWrite: ctx.canWrite,
		intent
	};
};

export const actions: Actions = {
	record: async ({ locals, request }) => {
		requireCap(locals, 'member');
		const ctx = await billingContext(locals);
		if (!ctx.canWrite) {
			return fail(403, { error: 'You need billing.write to record billing intent.' });
		}
		const form = await request.formData();
		const method = String(form.get('method') ?? '').trim();
		const contact = String(form.get('contact') ?? '').trim();
		const note = String(form.get('note') ?? '').trim();
		if (!method) return fail(400, { error: 'Choose how you intend to pay.' });
		if (!contact) return fail(400, { error: 'Leave a contact so an operator can follow up.' });

		const value = {
			method,
			contact,
			note,
			recordedAt: new Date().toISOString(),
			recordedBy: locals.user?.id ?? null
		};
		await db
			.insert(systemSetting)
			.values({ key: settingKey(ctx.workspaceId), value, updatedBy: locals.user?.id ?? null })
			.onConflictDoUpdate({
				target: systemSetting.key,
				set: { value, updatedBy: locals.user?.id ?? null, updatedAt: new Date() }
			});
		await writeAudit(db, {
			actorUserId: locals.user?.id ?? null,
			action: 'billing.payment_method.intent',
			resource: 'system_setting',
			resourceId: settingKey(ctx.workspaceId),
			workspaceId: ctx.workspaceId,
			after: value
		});
		return { recorded: true };
	}
};
