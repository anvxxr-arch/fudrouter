import type { PageServerLoad } from './$types';
import { servedModels } from '$lib/server/public-catalog';
import { providerRows } from '$lib/provider-directory';
// Provider directory (PRD §17). Rows come from the publish-gated catalog via
// $lib/provider-directory: identity, status, model/capability counts, regions
// and aggregate performance only. Credential material never crosses into the
// rollup, so it cannot reach this page's payload.
export const load: PageServerLoad = async () => {
	const models = await servedModels();
	return { providers: providerRows(models) };
};
