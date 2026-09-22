import { fail } from '@sveltejs/kit';
import { asc, eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { Actions, PageServerLoad } from './$types';
import { microToUsd, usdToMicro } from '$lib/server/admin';
import { requireCap } from '$lib/server/roles';
import { db } from '$lib/server/db';
import { model, provider } from '$lib/server/db/schema';

const STATUSES = ['active', 'dev', 'disabled'];

export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'admin.models');

	const providers = await db
		.select({ id: provider.id, name: provider.name, status: provider.status })
		.from(provider)
		.orderBy(asc(provider.name));

	const models = await db
		.select({
			id: model.id,
			providerId: model.providerId,
			name: model.name,
			slug: model.slug,
			context: model.context,
			inputPrice: model.inputPrice,
			outputPrice: model.outputPrice,
			currency: model.currency,
			status: model.status
		})
		.from(model)
		.orderBy(asc(model.slug));

	const nameOf = new Map(providers.map((p) => [p.id, p.name]));
	return {
		providers,
		models: models.map((m) => ({
			...m,
			providerName: nameOf.get(m.providerId) ?? '—',
			inputUsd: microToUsd(m.inputPrice),
			outputUsd: microToUsd(m.outputPrice)
		})),
		statuses: STATUSES
	};
};

export const actions: Actions = {
	create: async ({ locals, request }) => {
		requireCap(locals, 'admin.models');
		const form = await request.formData();
		const providerId = String(form.get('providerId') ?? '').trim();
		const name = String(form.get('name') ?? '').trim();
		const slug = String(form.get('slug') ?? '').trim();
		const context = Number(form.get('context') ?? 0);
		const input = usdToMicro(String(form.get('inputUsd') ?? ''));
		const output = usdToMicro(String(form.get('outputUsd') ?? ''));
		const currency = String(form.get('currency') ?? 'USD')
			.trim()
			.toUpperCase()
			.slice(0, 3);
		const status = String(form.get('status') ?? 'active');

		if (!providerId || !name || !slug)
			return fail(400, { error: 'Provider, name and slug required' });
		if (input === null || output === null)
			return fail(400, { error: 'Prices must be non-negative USD' });
		if (!STATUSES.includes(status)) return fail(400, { error: 'Invalid status' });

		try {
			await db.insert(model).values({
				id: uuidv7(),
				providerId,
				name,
				slug,
				context: Number.isFinite(context) && context > 0 ? context : null,
				inputPrice: input,
				outputPrice: output,
				currency,
				status
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'insert failed';
			return fail(400, { error: `Could not create model: ${msg}` });
		}
		return { created: slug };
	},

	update: async ({ locals, request }) => {
		requireCap(locals, 'admin.models');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		const input = usdToMicro(String(form.get('inputUsd') ?? ''));
		const output = usdToMicro(String(form.get('outputUsd') ?? ''));
		const status = String(form.get('status') ?? '');
		const context = Number(form.get('context') ?? 0);

		if (!id) return fail(400, { error: 'Missing model id' });
		if (input === null || output === null)
			return fail(400, { error: 'Prices must be non-negative USD' });
		if (!STATUSES.includes(status)) return fail(400, { error: 'Invalid status' });

		const updated = await db
			.update(model)
			.set({
				inputPrice: input,
				outputPrice: output,
				status,
				context: Number.isFinite(context) && context > 0 ? context : null
			})
			.where(eq(model.id, id))
			.returning({ id: model.id });
		if (updated.length === 0) return fail(404, { error: 'Model not found' });
		return { updated: id };
	},

	delete: async ({ locals, request }) => {
		requireCap(locals, 'admin.models');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing model id' });

		try {
			const deleted = await db.delete(model).where(eq(model.id, id)).returning({ id: model.id });
			if (deleted.length === 0) return fail(404, { error: 'Model not found' });
		} catch {
			// request_log.model_id has no cascade: a referenced model is kept.
			return fail(409, { error: 'Model has request history — disable it instead' });
		}
		return { deleted: id };
	}
};
