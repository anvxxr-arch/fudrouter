import type { PageServerLoad } from './$types';
import { servedModels, type CatalogModel } from '$lib/server/public-catalog';
import { parseCompareList } from '$lib/compare';

// Compare (PRD §16) — a neutral fact grid over 1..4 published models. The
// selection is entirely in the URL (?models=a,b,c), so any comparison is
// shareable and there is no session state to lose. Unknown slugs are reported
// and skipped rather than failing the page: a stale link should still show the
// models that do exist.
export const load: PageServerLoad = async ({ url }) => {
	const { slugs, truncated } = parseCompareList(url.searchParams.get('models'));
	// One query serves both the columns and the picker's option list.
	const all = await servedModels();
	const bySlug = new Map(all.map((m) => [m.slug, m]));
	const columns: CatalogModel[] = [];
	const missing: string[] = [];
	for (const slug of slugs) {
		const m = bySlug.get(slug);
		if (m) columns.push(m);
		else missing.push(slug);
	}
	return {
		columns,
		missing,
		truncated,
		slugs,
		options: all.map((m) => ({ slug: m.slug, name: m.name }))
	};
};
