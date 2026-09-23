import { env } from '$env/dynamic/private';
import { devProvidersAllowed } from '$lib/publish';

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
