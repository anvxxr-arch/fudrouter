/**
 * Error UX (PRD §130) — every user-facing error answers four questions:
 * What happened? / Why? / What can I do? / Request ID?
 *
 * CLIENT-SAFE half: the body shape and the status-derived fallback copy
 * `routes/+error.svelte` renders. The throwing helper lives in
 * `$lib/server/public-error` (mints ids via `newId`, server-only) so the error
 * page can import this without dragging a server module into the browser bundle.
 */
export interface PublicErrorBody {
	/** What happened, in one line. Carried as `message` so SvelteKit shows it. */
	message: string;
	why?: string;
	action?: string;
	requestId?: string;
}

/** Status-derived fallbacks for errors thrown outside `publicError`. */
export function describeStatus(status: number): Required<Pick<PublicErrorBody, 'why' | 'action'>> {
	switch (status) {
		case 401:
			return {
				why: 'You need to be signed in to use this page.',
				action: 'Log in and try again.'
			};
		case 403:
			return {
				why: 'Your account does not have permission for this page.',
				action: 'Ask a workspace admin for access, or head back to your dashboard.'
			};
		case 404:
			return {
				why:
					'That address does not exist on this deployment — the item may have been removed or renamed.',
				action: 'Check the address, or browse from the home page.'
			};
		case 429:
			return {
				why: 'Too many requests in a short window.',
				action: 'Wait a moment and try again.'
			};
		default:
			return {
				why: 'The server hit an unexpected problem while serving this page.',
				action: 'Try again in a moment. If it keeps happening, check the status page.'
			};
	}
}

/** Narrow an unknown `page.error` to the four-answer body. */
export function asPublicErrorBody(value: unknown): PublicErrorBody | null {
	if (value && typeof value === 'object' && 'message' in value) {
		const v = value as Record<string, unknown>;
		return {
			message: String(v.message ?? ''),
			why: typeof v.why === 'string' ? v.why : undefined,
			action: typeof v.action === 'string' ? v.action : undefined,
			requestId: typeof v.requestId === 'string' ? v.requestId : undefined
		};
	}
	return null;
}
