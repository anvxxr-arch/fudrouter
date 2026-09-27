import { env } from '$env/dynamic/private';

/**
 * Origins allowed to POST to the auth endpoints.
 *
 * The public origin comes from `ORIGIN` so it tracks the deployment. The local
 * dev origins are trusted ONLY outside production: leaving them in the prod
 * allow-list widens CSRF trust to any request that can present one of those
 * Origins, for a convenience the adapter-node ORIGIN binding already makes
 * unreachable in production.
 */
const DEV_ORIGINS =
	env.NODE_ENV === 'production' ? [] : ['http://localhost:3000', 'http://127.0.0.1:3000'];

export const ALLOWED_ORIGINS: string[] = [env.ORIGIN, ...DEV_ORIGINS].filter(Boolean);

/** True when the request carries an Origin that is explicitly trusted. */
export function isAllowedOrigin(origin: string | null): boolean {
	return origin !== null && ALLOWED_ORIGINS.includes(origin);
}
