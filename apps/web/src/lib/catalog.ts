/**
 * Model catalog — which models are served, on which surface, at which tier.
 *
 * TWO API_SURFACES
 *   payg    `<base>/v1`         billed per token
 *   coding  `<base>/coding/v1`  included in a coding-plan subscription
 *
 * The two are separate API prefixes, not a filter on one list: a client points at
 * the surface it is entitled to use.
 *
 * ---------------------------------------------------------------------------
 * DUMMY TIERS — this block is a placeholder, not a source of truth.
 *
 * `model` has no `tier` and no `surface` column, and the data plane has no
 * `/coding/v1` route yet: the PAYG/coding split and the free/premium split are
 * S2/S3 work (docs/specs §2, S3 "Programs — free credit, coding plan"). The maps
 * below stand in so this surface can be reviewed before billing exists.
 *
 * To go live: add the columns (or a model_surface join), move the assignment into
 * the DB, and delete `DUMMY_TIERS` / `DEFAULT_TIERS`. Nothing else on the page
 * changes — `buildCatalog` already takes plain rows and returns the same shape.
 * ---------------------------------------------------------------------------
 */

export type ApiSurface = 'payg' | 'coding';
export type Tier = 'free' | 'premium';

/** Public base URL, shared by every page that prints an endpoint. */
export const BASE_URL = 'https://ai.karepmuwes.my.id';

export interface ApiSurfaceMeta {
	label: string;
	/** Path prefix a client points at. */
	path: string;
	/** One line on who the surface is for. */
	lede: string;
}

export const API_SURFACES: Record<ApiSurface, ApiSurfaceMeta> = {
	payg: {
		label: 'Pay as you go',
		path: '/v1',
		lede: 'Billed per token, no commitment. One key works with any [OI]-compatible client.'
	},
	coding: {
		label: 'Coding plan',
		path: '/coding/v1',
		lede: 'Included in a coding subscription — no per-token charge on covered models.'
	}
};

/** Render order: the surface most readers arrive on comes first. */
export const API_SURFACE_ORDER: ApiSurface[] = ['payg', 'coding'];

/** PLACEHOLDER — see the file header. Keyed by slug. */
const DUMMY_TIERS: Record<string, Partial<Record<ApiSurface, Tier>>> = {
	'grok-4.6': { payg: 'premium', coding: 'free' },
	'grok-4.7': { payg: 'premium', coding: 'premium' }
};

/** PLACEHOLDER — the assignment for a slug with no explicit entry. */
const DEFAULT_TIERS: Partial<Record<ApiSurface, Tier>> = { payg: 'premium' };

export interface ModelRow {
	slug: string;
	name: string;
	context: number | null;
}

export interface ApiSurfaceTier {
	surface: ApiSurface;
	tier: Tier;
}

export interface CatalogModel extends ModelRow {
	surfaces: ApiSurfaceTier[];
}

export interface SurfaceEntry<M = CatalogModel> {
	model: M;
	tier: Tier;
}

/**
 * Attach the surface/tier assignment to plain model rows.
 *
 * Takes rows rather than reading the DB so the placeholder map can be swapped for
 * a real column with no change to callers or the page. Generic in the row type so
 * a caller that selects extra columns (pricing, say) keeps them.
 */
export function buildCatalog<T extends ModelRow>(
	rows: T[]
): (T & { surfaces: ApiSurfaceTier[] })[] {
	return rows.map((row) => {
		const tiers = DUMMY_TIERS[row.slug] ?? DEFAULT_TIERS;
		const surfaces: ApiSurfaceTier[] = [];
		// Iterate the map, not a fixed order, so a slug served on one surface only
		// (a coding-plan exclusive, say) needs no special case.
		for (const surface of Object.keys(tiers) as ApiSurface[]) {
			const tier = tiers[surface];
			if (tier) surfaces.push({ surface, tier });
		}
		return { ...row, surfaces };
	});
}

/** The models served on one surface, in slug order. */
export function modelsOn<M extends CatalogModel>(
	catalog: M[],
	surface: ApiSurface
): SurfaceEntry<M>[] {
	return catalog
		.flatMap((model) =>
			model.surfaces.filter((s) => s.surface === surface).map((s) => ({ model, tier: s.tier }))
		)
		.sort((a, b) => a.model.slug.localeCompare(b.model.slug));
}

/** Badge tone per tier: the free one is the good news, so it reads as success. */
export function tierTone(tier: Tier): 'success' | 'info' {
	return tier === 'free' ? 'success' : 'info';
}
