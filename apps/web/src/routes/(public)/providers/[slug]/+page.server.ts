import { desc, eq, inArray } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { servedModels, type PriceMicro } from '$lib/server/public-catalog';
import { modelsOf, providerRows } from '$lib/provider-directory';
import { componentOf } from '$lib/status';
import { publicError } from '$lib/server/public-error';
import { db } from '$lib/server/db';
import { incident, incidentUpdate, provider } from '$lib/server/db/schema';
import type { CapabilityKey } from '$lib/capabilities';
// Provider detail (PRD §17). SECURITY: this page selects provider identity and
// marketing fields ONLY (description, type, homepage, documentation URL) plus
// the catalog rollups. Upstream connection details and stored secret material
// are deliberately never queried here.
//
// `params.slug` matches the provider slug OR name case-insensitively, so both
// the directory's /providers/prv-mingles and a hand-typed /providers/Mingles
// land here. A slug with no served catalog row is a 404 with the PRD §130
// answers, because a provider page without served models would be all dashes.
interface ProviderModelRow {
	slug: string;
	name: string;
	context: number | null;
	/** Effective price for THIS provider: its specific rule, else model-wide. */
	price: PriceMicro;
	/** True when a provider-specific pricing rule overrides the model-wide one. */
	hasProviderPrice: boolean;
	/** Both sides of the override, for the Pricing section. */
	providerPrice: PriceMicro | null;
	widePrice: PriceMicro;
	availability: number | null;
}
export const load: PageServerLoad = async ({ params }) => {
	const needle = params.slug.toLowerCase();
	const models = await servedModels();
	const rows = providerRows(models);
	const row =
		rows.find((r) => (r.slug ?? '').toLowerCase() === needle) ??
		rows.find((r) => r.name.toLowerCase() === needle);
	if (!row) {
		publicError(404, 'Provider not found', {
			why: 'No provider in the public catalog matches this name or slug.',
			action: 'Browse the provider directory.'
		});
	}
	// Identity/marketing fields from the provider table — allowed columns only.
	const [meta] = await db
		.select({
			description: provider.description,
			type: provider.type,
			homepage: provider.homepage,
			documentationUrl: provider.documentationUrl
		})
		.from(provider)
		.where(eq(provider.name, row.name))
		.limit(1);
	const served: ProviderModelRow[] = modelsOf(models, row.name).map((m) => {
		const link = m.providers.find((p) => p.providerName === row.name);
		const price = link?.price ?? m.price;
		return {
			slug: m.slug,
			name: m.name,
			context: m.context,
			price,
			hasProviderPrice: link?.price != null,
			providerPrice: link?.price ?? null,
			widePrice: m.price,
			availability: link?.availability ?? null
		};
	});
	// Recent incidents: rows filed against the major-providers component OR
	// whose free-text component mentions this provider's name. Newest first,
	// capped at 10; the latest timeline update rides along.
	const all = await db
		.select({
			id: incident.id,
			title: incident.title,
			component: incident.component,
			severity: incident.severity,
			status: incident.status,
			startedAt: incident.startedAt,
			resolvedAt: incident.resolvedAt
		})
		.from(incident)
		.orderBy(desc(incident.startedAt));
	const nameNeedle = row.name.toLowerCase();
	const relevant = all
		.filter(
			(i) => componentOf(i.component) === 'major-providers' || i.component.toLowerCase().includes(nameNeedle)
		)
		.slice(0, 10);
	const updates = relevant.length
		? await db
				.select({
					incidentId: incidentUpdate.incidentId,
					message: incidentUpdate.message,
					createdAt: incidentUpdate.createdAt
				})
				.from(incidentUpdate)
				.where(inArray(incidentUpdate.incidentId, relevant.map((i) => i.id)))
				.orderBy(desc(incidentUpdate.createdAt))
		: [];
	const latestByIncident = new Map<string, { message: string; createdAt: string }>();
	for (const u of updates) {
		if (!latestByIncident.has(u.incidentId)) {
			latestByIncident.set(u.incidentId, {
				message: u.message,
				createdAt: u.createdAt.toISOString()
			});
		}
	}
	return {
		provider: { name: row.name, slug: row.slug, status: row.status },
		meta: {
			description: meta?.description ?? null,
			type: meta?.type ?? null,
			homepage: meta?.homepage ?? null,
			documentationUrl: meta?.documentationUrl ?? null
		},
		capabilities: row.capabilities as CapabilityKey[],
		regions: row.regions,
		availability: row.availability,
		performance: { p50Ms: row.p50Ms, p95Ms: row.p95Ms },
		models: served,
		pricingOverrides: served.filter((m) => m.hasProviderPrice),
		incidents: relevant.map((i) => ({
			id: i.id,
			title: i.title,
			severity: i.severity,
			status: i.status,
			startedAt: i.startedAt.toISOString(),
			resolvedAt: i.resolvedAt ? i.resolvedAt.toISOString() : null,
			latestUpdate: latestByIncident.get(i.id) ?? null
		}))
	};
};
