import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { parseIntField } from '$lib/server/admin-vocab';
import { writeAudit } from '$lib/server/audit';
import { db } from '$lib/server/db';
import { requireCap } from '$lib/server/roles';
import { getSetting, setSetting } from '$lib/server/settings';
// Platform hard limits (PRD §65): the ceiling every scope is capped by. The
// effective limit for a request is the minimum across the whole chain
// platform -> workspace -> project -> environment -> api_key (spec §7), so this
// page can only ever tighten, never loosen, what a scope below asked for.
const BOUNDS = { min: 0, max: 1_000_000_000_000 };
export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'admin.ops');
	const hard = await getSetting('platform_hard_limits');
	return { hard };
};
export const actions: Actions = {
	save: async ({ locals, request }) => {
		requireCap(locals, 'admin.ops');
		const form = await request.formData();
		const rpm = parseIntField(form.get('rpm'), BOUNDS);
		const tpm = parseIntField(form.get('tpm'), BOUNDS);
		const concurrency = parseIntField(form.get('concurrency'), BOUNDS);
		if (rpm === null || tpm === null || concurrency === null) {
			return fail(400, { error: 'All three limits must be whole numbers (0 = no cap)' });
		}
		const before = await getSetting('platform_hard_limits');
		const after = { rpm, tpm, concurrency };
		// setSetting owns the system_setting write; the audit row lands beside it
		// so the change and its trail are committed together.
		await db.transaction(async (tx) => {
			await setSetting('platform_hard_limits', after, locals.user?.id ?? null);
			await writeAudit(tx, {
				actorUserId: locals.user?.id ?? null,
				action: 'system_setting.update',
				resource: 'system_setting',
				resourceId: 'platform_hard_limits',
				before: before ?? null,
				after
			});
		});
		return { saved: true };
	}
};
