/**
 * Providers directory (PRD §17) — pure rollups for /providers and /providers/[slug].
 *
 * NEVER carries credential material: the pages get provider identity, status,
 * model/capability counts, regions and aggregate performance only.
 */
import type { CatalogModel } from '$lib/server/public-catalog';
import { effectiveCapability, type CapabilityKey } from '$lib/capabilities';

export interface ProviderRow {
	name: string;
	slug: string | null;
	/** Display status: operational when at least one served mapping is available. */
	status: string;
	modelCount: number;
	capabilities: CapabilityKey[];
	regions: string[];
	p50Ms: number | null;
	p95Ms: number | null;
	availability: number | null;
}

const ALL_KEYS: CapabilityKey[] = [
	'text',
	'vision',
	'audio',
	'tools',
	'reasoning',
	'structured_output',
	'streaming',
	'embeddings'
];

/** Capability is "supported" when ANY model the provider serves claims it true. */
function capabilitiesOf(models: CatalogModel[], providerName: string): CapabilityKey[] {
	return ALL_KEYS.filter((key) =>
		models.some((m) => {
			if (!m.providers.some((p) => p.providerName === providerName)) return false;
			return effectiveCapability(m.capabilities, {}, key) === true;
		})
	);
}

export function providerRows(models: CatalogModel[]): ProviderRow[] {
	const names = [...new Set(models.flatMap((m) => m.providers.map((p) => p.providerName)))];
	return names
		.map((name) => {
			const links = models.flatMap((m) =>
				m.providers.filter((p) => p.providerName === name).map((p) => ({ m, p }))
			);
			const regions = [...new Set(links.map((l) => l.p.region).filter((r): r is string => !!r))].sort();
			const p50s = links.map((l) => l.p.p50Ms).filter((v): v is number => v !== null);
			const p95s = links.map((l) => l.p.p95Ms).filter((v): v is number => v !== null);
			const avails = links.map((l) => l.p.availability).filter((v): v is number => v !== null);
			const median = (xs: number[]) =>
				[...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];
			return {
				name,
				slug: links[0]?.p.providerSlug ?? null,
				status: links.some((l) => l.p.status === 'available') ? 'operational' : 'degraded',
				modelCount: new Set(links.map((l) => l.m.id)).size,
				capabilities: capabilitiesOf(models, name),
				regions,
				p50Ms: p50s.length ? median(p50s) : null,
				p95Ms: p95s.length ? median(p95s) : null,
				availability: avails.length ? avails.reduce((a, b) => a + b, 0) / avails.length : null
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** The models one provider serves, for /providers/[slug]. */
export function modelsOf(models: CatalogModel[], providerName: string): CatalogModel[] {
	return models.filter((m) => m.providers.some((p) => p.providerName === providerName));
}
