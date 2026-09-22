import { env } from '$env/dynamic/private';

/**
 * Origins allowed to POST to the auth endpoints.
 *
 * The public origin comes from `ORIGIN` so it tracks the deployment; the local
 * dev origins are always allowed so `localhost:3000` / `127.0.0.1:3000` keep
 * working against the same build the tunnel serves.
 */
export const ALLOWED_ORIGINS: string[] = [
	env.ORIGIN,
	'http://localhost:3000',
	'http://127.0.0.1:3000'
].filter(Boolean);

/** True when the request carries an Origin that is explicitly trusted. */
export function isAllowedOrigin(origin: string | null): boolean {
	return origin !== null && ALLOWED_ORIGINS.includes(origin);
}
