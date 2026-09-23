import { asc, eq } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { buildCatalog } from '$lib/catalog';
import { reachability } from '$lib/publish';
import { allowDevProviders } from '$lib/server/publish';
import { db } from '$lib/server/db';
import { model, provider } from '$lib/server/db/schema';

// Public page: model identity only — never provider names or URLs. The
// surface/tier assignment comes from $lib/catalog (placeholder today).
//
// Gated by the same rule the data plane applies (`reachability`, mirroring the
// SQL in services/router/internal/store), so this page cannot advertise a slug
// the router would refuse: publishing a model in /admin/models is what puts it
// here.
export const load: PageServerLoad = async () => {
	const allowDev = allowDevProviders();

	const rows = await db
		.select({
			slug: model.slug,
			name: model.name,
			context: model.context,
			modelStatus: model.status,
			providerStatus: provider.status
		})
		.from(model)
		.innerJoin(provider, eq(provider.id, model.providerId))
		.orderBy(asc(model.slug));

	const served = rows
		.filter((r) => reachability(r.modelStatus, r.providerStatus, allowDev).served)
		.map(({ slug, name, context }) => ({ slug, name, context }));

	return { catalog: buildCatalog(served) };
};
