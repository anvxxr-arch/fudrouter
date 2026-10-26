/**
 * Publish semantics — the rule that decides whether a model is reachable.
 *
 * There is ONE rule and two implementations of it: the data plane's SQL
 * (`providerServableSQLFor` in `backend/go/internal/store/catalog.go`, composed
 * by `ActiveModels`, `PublishedModel`, `Candidates`, `CandidatesBatch`) and
 * `reachability()` below. The console reads this module; the router reads its
 * SQL. `publish.test.ts` pins the cases that have historically drifted, so a
 * change to one that is not made to the other fails a test instead of silently
 * showing a model the router refuses.
 *
 * The rule, in the router's own terms:
 *
 *   m.status = 'active'
 *     and p.enabled
 *     and (p.tier = 'commercial' or <allowDevProviders>)
 *     and p.status not in ('disabled', 'maintenance', 'outage')
 *     and (p.status <> 'dev' or <allowDevProviders>)
 *
 * `reachability()` used to take three arguments — model status, provider status
 * and the dev opt-in — which structurally could not see `p.enabled` or `p.tier`.
 * Every caller then compensated by hand in SQL, and one (the admin model list)
 * did not, so the console could show a row as served that the router refused.
 * All five inputs are arguments now and the compensating SQL is gone.
 *
 * The status predicate speaks BOTH vocabularies on purpose. Migration 0010
 * narrowed `provider_status_check` to the PRD §52 set (`operational`,
 * `degraded`, `disabled`, `maintenance`, `outage`), but S0-era rows still carry
 * `active`/`dev`, and the Go gate accepts both. An ALLOW-list would therefore
 * hide `operational`/`degraded` providers the router serves; this is a
 * deny-list for that reason.
 */

/** Statuses a model row can carry. Only `active` publishes it. */
export const MODEL_STATUSES = ['active', 'deprecated', 'sunset', 'disabled'] as const;
export type ModelStatus = (typeof MODEL_STATUSES)[number];

/** Provider statuses that stop a provider serving, in both vocabularies. */
export const PROVIDER_BLOCKING_STATUSES = ['disabled', 'maintenance', 'outage'] as const;

/** Why a model is not reachable, or null when it is. */
export type HiddenReason = 'unpublished' | 'provider-off';

export interface Reachability {
	/** True when a client can call this slug right now. */
	served: boolean;
	/** Set when `served` is false; the admin UI turns this into words. */
	reason: HiddenReason | null;
}

/** The provider columns the gate reads. */
export interface ProviderGate {
	status: string;
	enabled: boolean;
	tier: string;
}

/**
 * The publish gate. `allowDevProviders` is the data plane's
 * `ROUTER_ALLOW_DEV_PROVIDERS` opt-in — pass the value the router actually runs
 * with, or the console will disagree with the router.
 *
 * A provider is servable when it is enabled, its tier is `commercial` (or the
 * dev opt-in is on), its status is not one of the blocking three, and it is not
 * a legacy `status='dev'` row without the opt-in.
 */
export function reachability(
	modelStatus: string,
	provider: ProviderGate,
	allowDevProviders: boolean
): Reachability {
	if (modelStatus !== 'active') return { served: false, reason: 'unpublished' };
	if (!provider.enabled) return { served: false, reason: 'provider-off' };
	if (provider.tier !== 'commercial' && !allowDevProviders) {
		return { served: false, reason: 'provider-off' };
	}
	if ((PROVIDER_BLOCKING_STATUSES as readonly string[]).includes(provider.status)) {
		return { served: false, reason: 'provider-off' };
	}
	if (provider.status === 'dev' && !allowDevProviders) {
		return { served: false, reason: 'provider-off' };
	}
	return { served: true, reason: null };
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
