import { env } from '$env/dynamic/private';
import { devProvidersAllowed, privateUpstreamsAllowed } from '$lib/publish';
/**
 * Environment reads for the publish rule.
 *
 * The rule itself is pure and lives in `$lib/publish`; this module is the only
 * place that touches `$env` for it, which is what keeps the rule unit-testable
 * (see the header there). Every flag below must be set identically in the
 * router's own environment, or the console and the data plane will disagree
 * about which slugs are reachable.
 */

/**
 * The data plane's dev-provider opt-in, read from the same variable the router
 * runs with (`ROUTER_ALLOW_DEV_PROVIDERS`, set in `ecosystem.config.cjs` and
 * described in `.env.example` — where it is deliberately left commented out,
 * because leaving it unset is the correct production posture).
 *
 * The control plane has to know this: with the flag off, a `dev` provider is
 * invisible no matter how many of its models an admin publishes, so the console
 * must say so instead of showing a green "published" badge for a slug the router
 * will 404. It must be set in BOTH environments: the router decides what it
 * serves, this decides what the console claims, and a one-sided value makes the
 * two disagree.
 */
export function allowDevProviders(): boolean {
	return devProvidersAllowed(env.ROUTER_ALLOW_DEV_PROVIDERS);
}

/**
 * Whether an admin-supplied upstream `base_url` may point at loopback / a private
 * range (`ALLOW_PRIVATE_UPSTREAMS`). Off by default: a stored `base_url` is
 * fetched server-side, so a private target is an SSRF probe. On for a deployment
 * that runs local upstreams (the seed provider is `http://127.0.0.1:20128/v1`).
 */
export function allowPrivateUpstreams(): boolean {
	return privateUpstreamsAllowed(env.ALLOW_PRIVATE_UPSTREAMS);
}
