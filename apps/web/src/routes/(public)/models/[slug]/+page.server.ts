import type { PageServerLoad } from './$types';
import { identifiersOf, servedModels, type CatalogModel } from '$lib/server/public-catalog';
import { publicError } from '$lib/server/public-error';
import { CAPABILITIES, effectiveCapability } from '$lib/capabilities';

// Model detail (PRD §15) — one model, its pricing, its providers and its
// identifiers. The lookup goes through servedModels([slug]), i.e. the same
// publish gate as the catalog: an unpublished slug is a 404 here, exactly as
// the router would refuse it.

/** The curl sample clients paste to call this model. */
function curlSample(slug: string): string {
	return [
		'curl https://ai.karepmuwes.my.id/v1/chat/completions \\',
		'  -H "Authorization: Bearer $FUDROUTER_KEY" \\',
		'  -H "Content-Type: application/json" \\',
		"  -d '{\"model\": \"" + slug + "\", \"messages\": [{\"role\": \"user\", \"content\": \"hello\"}]}'"
	].join('\n');
}

export const load: PageServerLoad = async ({ params }) => {
	const models = await servedModels([params.slug]);
	const model: CatalogModel | undefined = models[0];
	if (!model) {
		publicError(404, 'Model not found', {
			why: 'No published model has that identifier — it may be unpublished, renamed or never existed.',
			action: 'Browse the model catalog.'
		});
	}
	return {
		model,
		capabilities: CAPABILITIES.map((key) => ({
			key,
			value: effectiveCapability(model.capabilities, {}, key)
		})),
		identifiers: identifiersOf(model),
		curl: curlSample(model.slug)
	};
};
