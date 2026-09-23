import { fail } from '@sveltejs/kit';
import { asc, eq, inArray } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { Actions, PageServerLoad } from './$types';
import { microToUsd, usdToMicro } from '$lib/server/admin';
import { requireCap } from '$lib/server/roles';
import { allowDevProviders } from '$lib/server/publish';
import { db } from '$lib/server/db';
import { model, provider } from '$lib/server/db/schema';
import { MODEL_STATUSES, isModelStatus, reachability } from '$lib/publish';

const STATUSES = MODEL_STATUSES;

export const load: PageServerLoad = async ({ locals, url }) => {
	requireCap(locals, 'admin.models');

	// The router's own flag: a `dev` provider is invisible when it is off, so the
	// console must not call a published model "live" in that case.
	const allowDev = allowDevProviders();

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

	const providerOf = new Map(providers.map((p) => [p.id, p]));

	const rows = models.map((m) => {
		const parent = providerOf.get(m.providerId);
		const reach = reachability(m.status, parent?.status ?? 'disabled', allowDev);
		return {
			...m,
			providerName: parent?.name ?? '—',
			providerStatus: parent?.status ?? '—',
			inputUsd: microToUsd(m.inputPrice),
			outputUsd: microToUsd(m.outputPrice),
			served: reach.served,
			hiddenReason: reach.reason
		};
	});

	// Per-provider roll-up. With a catalog this size the useful unit of work is a
	// whole provider, not one slug at a time — "unpublish all 237 InferHub rows"
	// should be one click.
	const summary = providers.map((p) => {
		const mine = rows.filter((r) => r.providerId === p.id);
		return {
			id: p.id,
			name: p.name,
			status: p.status,
			total: mine.length,
			published: mine.filter((r) => r.status === 'active').length,
			served: mine.filter((r) => r.served).length
		};
	});

	// Filters ride in the query string so a working view can be linked and kept
	// across the POST-redirect cycle.
	const providerFilter = url.searchParams.get('provider') ?? '';
	const stateFilter = url.searchParams.get('state') ?? 'all';
	const visible = rows.filter((r) => {
		if (providerFilter && r.providerId !== providerFilter) return false;
		if (stateFilter === 'served') return r.served;
		if (stateFilter === 'hidden') return !r.served;
		return true;
	});

	return {
		providers,
		models: visible,
		summary,
		providerFilter,
		stateFilter,
		allowDev,
		statuses: STATUSES,
		counts: {
			all: rows.length,
			served: rows.filter((r) => r.served).length,
			hidden: rows.filter((r) => !r.served).length,
			published: rows.filter((r) => r.status === 'active').length
		}
	};
};

/** Shared write path: every publish control funnels through here. */
async function setStatus(ids: string[], status: string) {
	const clean = [...new Set(ids.filter(Boolean))];
	if (clean.length === 0) return fail(400, { error: 'Select at least one model' });
	if (!isModelStatus(status)) return fail(400, { error: 'Invalid status' });

	const updated = await db
		.update(model)
		.set({ status })
		.where(inArray(model.id, clean))
		.returning({ id: model.id });
	if (updated.length === 0) return fail(404, { error: 'No matching models' });

	const verb = status === 'active' ? 'Published' : 'Unpublished';
	return { changed: updated.length, status, message: `${verb} ${updated.length} model(s).` };
}

export const actions: Actions = {
	/**
	 * Set the publish flag on one row or many. A table row posts a single `ids`
	 * value; the checkbox toolbar posts one per selected row. Keeping both on one
	 * action means there is a single write path to reason about.
	 */
	bulk: async ({ locals, request }) => {
		requireCap(locals, 'admin.models');
		const form = await request.formData();
		return setStatus(
			form.getAll('ids').map((v) => String(v)),
			String(form.get('status') ?? '')
		);
	},

	/** Whole-provider switch — the practical control for a 200-row catalog. */
	provider: async ({ locals, request }) => {
		requireCap(locals, 'admin.models');
		const form = await request.formData();
		const providerId = String(form.get('providerId') ?? '').trim();
		const status = String(form.get('status') ?? '');
		if (!providerId) return fail(400, { error: 'Missing provider' });
		if (!isModelStatus(status)) return fail(400, { error: 'Invalid status' });

		const updated = await db
			.update(model)
			.set({ status })
			.where(eq(model.providerId, providerId))
			.returning({ id: model.id });
		if (updated.length === 0) return fail(404, { error: 'That provider has no models' });

		const verb = status === 'active' ? 'Published' : 'Unpublished';
		return { changed: updated.length, status, message: `${verb} all ${updated.length} model(s).` };
	},

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
		if (!STATUSES.includes(status as (typeof STATUSES)[number]))
			return fail(400, { error: 'Invalid status' });

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
		if (!isModelStatus(status)) return fail(400, { error: 'Invalid status' });

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
