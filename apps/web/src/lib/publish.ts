/**
 * Publish semantics — the one rule that decides whether a model is reachable.
 *
 * A model is SERVED only when two gates agree:
 *
 *   model.status    = 'active'                        (an admin published it)
 *   provider.status = 'active', OR 'dev' while the     (the provider is live)
 *                     dev-provider opt-in is enabled
 *
 * The data plane implements exactly this in SQL — `ModelWithProvider` and
 * `ActiveModels` in `services/router/internal/store/store.go`:
 *
 *   where m.status = 'active'
 *     and (p.status = 'active' or (p.status = 'dev' and $allowDevProviders))
 *
 * That query is the source of truth. This module mirrors it so the admin console
 * and the public catalog cannot advertise a slug the router will refuse, and so
 * "published" means one thing everywhere. Keep the two in step; the mirror is
 * pinned by `publish.test.ts`.
 */

/** Statuses a model row can carry. Only `active` publishes it. */
export const MODEL_STATUSES = ['active', 'dev', 'disabled'] as const;
export type ModelStatus = (typeof MODEL_STATUSES)[number];

export function isModelStatus(value: string): value is ModelStatus {
	return (MODEL_STATUSES as readonly string[]).includes(value);
}

/** Why a model is not reachable, or null when it is. */
export type HiddenReason = 'unpublished' | 'provider-off';

export interface Reachability {
	/** True when a client can call this slug right now. */
	served: boolean;
	/** Set when `served` is false; the admin UI turns this into words. */
	reason: HiddenReason | null;
}

/**
 * The publish gate. `allowDevProviders` is the data plane's
 * `ROUTER_ALLOW_DEV_PROVIDERS` opt-in — pass the value the router actually runs
 * with, or the console will disagree with the router.
 */
export function reachability(
	modelStatus: string,
	providerStatus: string,
	allowDevProviders: boolean
): Reachability {
	if (modelStatus !== 'active') return { served: false, reason: 'unpublished' };
	if (providerStatus === 'active') return { served: true, reason: null };
	if (providerStatus === 'dev' && allowDevProviders) return { served: true, reason: null };
	return { served: false, reason: 'provider-off' };
}

/** The admin-facing flag on its own: has this row been published? */
export function isPublished(modelStatus: string): boolean {
	return modelStatus === 'active';
}

/**
 * Parse the dev-provider opt-in the way the Go data plane does: only
 * `1/true/yes/on` enable it, so anything unset or misspelled fails closed.
 */
export function devProvidersAllowed(raw: string | undefined | null): boolean {
	return ['1', 'true', 'yes', 'on'].includes((raw ?? '').trim().toLowerCase());
}

/**
 * Opt-in for upstream `base_url`s that point at loopback / private ranges.
 *
 * Blocking private targets is the secure default (a stored `base_url` is fetched
 * server-side, so `http://169.254.169.254/` is an SSRF probe). But this deployment
 * legitimately runs LOCAL upstreams — `SEED_PROVIDER_BASE_URL` is
 * `http://127.0.0.1:20128/v1` — so the block has to be escapable. Same truthy
 * parse and same fail-closed rule as the dev-provider flag.
 */
export function privateUpstreamsAllowed(raw: string | undefined | null): boolean {
	return devProvidersAllowed(raw);
}
