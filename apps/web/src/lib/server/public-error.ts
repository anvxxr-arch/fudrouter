/**
 * Server half of the error UX (PRD §130): throw with the four answers attached.
 *
 * `routes/+error.svelte` renders exactly `PublicErrorBody` and falls back to
 * status-derived copy when a page threw bare `error()`. The request id is the
 * platform's own `req_…` id when the failure belongs to a logged call, or a
 * generated `req_…` correlation id for control-plane failures — either way the
 * user gets a token support can look up.
 */
import { error } from '@sveltejs/kit';
import type { PublicErrorBody } from '$lib/error-ux';
import { newId } from '$lib/server/id';

/** Build the four-answer body for a failure. Generates a request id if none exists. */
export function publicErrorBody(
	what: string,
	opts: { why?: string; action?: string; requestId?: string } = {}
): PublicErrorBody {
	return {
		message: what,
		why: opts.why,
		action: opts.action,
		requestId: opts.requestId ?? newId('req_')
	};
}

/** Throw a SvelteKit error carrying the PRD §130 answers. */
export function publicError(
	status: number,
	what: string,
	opts: { why?: string; action?: string; requestId?: string } = {}
): never {
	error(status, publicErrorBody(what, opts) as unknown as App.Error);
}
