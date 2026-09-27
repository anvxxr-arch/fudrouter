import { env } from '$env/dynamic/private';
import { devProvidersAllowed, privateUpstreamsAllowed } from '$lib/publish';

/**
 * The data plane's dev-provider opt-in, read from the same variable the router
 * runs with (`ROUTER_ALLOW_DEV_PROVIDERS`, set in `ecosystem.config.cjs` and
 * documented in `.env.example`).
 *
 * The control plane has to know this: with the flag off, a `dev` provider is
 * invisible no matter how many of its models an admin publishes, so the console
 * must say so instead of showing a green "published" badge for a slug the router
 * will 404.
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
