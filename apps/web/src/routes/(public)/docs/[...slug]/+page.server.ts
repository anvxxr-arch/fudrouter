import type { PageServerLoad } from './$types';
import { DOC_BY_PATH, DOC_FLAT } from '$lib/docs-content';
import { publicError } from '$lib/server/public-error';
// The docs tree (PRD §131–133). `docs/[...slug]` also matches `/docs` (empty
// rest), so the index and every page come through here: an empty slug is the
// category overview, "category-slug/page-slug" is a page, anything else is a
// 404 carrying the four answers.
export const load: PageServerLoad = ({ params }) => {
	const path = (params.slug ?? '').replace(/^\/+|\/+$/g, '');
	if (path === '') return { entry: null, prev: null, next: null };
	const entry = DOC_BY_PATH[path] ?? null;
	if (!entry) {
		throw publicError(404, 'Page not found', {
			why: `No documentation page lives at /docs/${path}.`,
			action: 'Pick a page from the docs index.'
		});
	}
	// Position is the flattened tree's reading order (category order, then the
	// order the pages are authored in) — prev/next walk exactly that.
	const at = DOC_FLAT.findIndex((candidate) => candidate.path === entry.path);
	return {
		entry,
		prev: at > 0 ? DOC_FLAT[at - 1] : null,
		next: at < DOC_FLAT.length - 1 ? DOC_FLAT[at + 1] : null
	};
};
