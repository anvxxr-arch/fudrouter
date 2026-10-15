/**
 * Publish semantics — the rule that decides whether a model is reachable, and
 * which half of it this module mirrors.
 *
 * The data plane's rule is a model gate AND a provider gate, in SQL —
 * `providerServableSQLFor` in `backend/go/internal/store/catalog.go`, composed
 * by `ActiveModels` and `PublishedModel` with `m.status = 'active'` and by
 * `Candidates` with `pm.enabled`:
 *
 *   m.status = 'active'
 *     and p.enabled
 *     and (p.tier = 'commercial' or <allowDevProviders>)
 *     and p.status not in ('disabled', 'maintenance', 'outage')
 *     and (p.status <> 'dev' or <allowDevProviders>)
 *
 * PROVIDER GATE NOT MIRRORED HERE. `reachability()` below encodes the model gate
 * plus `providerStatus === 'active'`, with a `'dev'` pass when the opt-in is on.
 * Its three-argument signature cannot see the provider's `p.enabled` column or
 * `p.tier` at all, and it carries only the legacy status vocabulary — so it is
 * not a reimplementation of the SQL and must not be read as one.
 *
 * MIRRORED BY THE CONSOLE THROUGH THIS MODULE NOW. The gate used to be reproduced
 * BY HAND in two more places, neither of which imported this module: `admin.mjs`'s
 * `_reach` and `public.mjs`'s `served`. Both now call this export through
 * `apps/web/server/lib/platform-ts.mjs`, and a source scan
 * (`server/lib/platform-ts.test.mjs`, "no hand copy of the publish gate survives
 * in the server") fails if one comes back. That leaves two implementations of the
 * rule in total — this one and the router's SQL — and they share a gap:
 *
 *   - `p.enabled = false` / `p.tier = 'dev'` are structural blind spots — no
 *     argument conveys them. The public catalogue closed its half: servedModels
 *     (apps/web/server/public.mjs) applies `p.enabled and (p.tier =
 *     'commercial' or <opt-in>)` in SQL before calling this, probed against a
 *     live DB (GET /api/models now hides what GET /v1/models hides). Surfaces
 *     that call reachability() ALONE — admin.mjs's `_reach` display — can still
 *     show a row as served that the router refuses.
 *   - the status vocabulary drifts: the SQL (catalog.go:142-145) excludes
 *     `not in ('disabled', 'maintenance', 'outage')`, while these copies know only
 *     the S0 `'active'`/`'dev'`. A PRD `'operational'`/`'degraded'` provider is
 *     SERVED by the router and HIDDEN in the console/catalog.
 *
 * Migration 0010 closes the *provider on-gate* — it flips these copies to the PRD
 * status set in the same commit as the value migration. The MODEL side needs no
 * predicate change: both the router (`m.status = 'active'`) and `isPublished`
 * already gate on `active` (docs/specs/2026-09-30-platform-schema.md:110-124).
 * The provider vocabulary here is the pre-0010 S0 set — see catalog.go:125-131
 * ("It speaks BOTH status vocabularies because migration 0009 widened the CHECKs
 * while 0010 still has to move the values"). Do not unify it before that cutover.
 *
 * It is NOT pinned by a test: there is no `publish.test.ts` in this package,
 * and the Go predicate and `reachability()` are maintained by hand. An earlier
 * version of this comment claimed a `publish.test.ts` pinned the mirror; no such
 * file exists, so the claim is removed rather than left as a false assurance.
 * A future reader adding one should pin, at minimum, the two drift cases named
 * above: a provider row with `enabled = false`, and a PRD `operational`/`degraded`
 * provider (SERVED by the router, HIDDEN here). Note the direction: `maintenance`
 * and `outage` are NOT drift — catalog.go:144 excludes them and these copies
 * serve only `active`/`dev`, so those two agree on both sides.
 *
 * `reachability()` and `isPublished()` ARE CALLED — `reachability` by the console
 * through `server/lib/platform-ts.mjs` (admin's `_reach` and public's `served`),
 * pinned by the bridge test named above. `isPublished` still has no call site in
 * apps/ or packages/ (verified); the 0010 cutover must flip THIS export plus the
 * mirrored SQL, and the two console call sites now follow from it rather than
 * having to be found by hand.
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
