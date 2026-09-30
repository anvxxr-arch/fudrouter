/**
 * The request-content privacy boundary (PRD §93–94).
 *
 * Request METADATA is always kept; the raw prompt/response bodies are written
 * and shown only when the retention policy opts in to content capture
 * (`system_setting['retention'].request_content_days > 0`). A missing or
 * malformed policy fails CLOSED — an unreadable setting must never decide to
 * expose customer content.
 *
 * The data plane enforces the write half (bodies are NULL when capture is off);
 * this module is the read half, so the admin request page cannot leak a body
 * that was retained under an older, looser policy after capture is switched
 * off. `contentCaptureAllowed` is pure so the boundary is testable without a
 * database or a request context.
 */
export interface ContentRetentionView {
	request_content_days?: number | null;
}

/** True only when the policy explicitly keeps request content. */
export function contentCaptureAllowed(
	retention: ContentRetentionView | null | undefined
): boolean {
	const days = retention?.request_content_days;
	return typeof days === 'number' && Number.isFinite(days) && days > 0;
}

export interface BodyRow {
	requestBody?: string | null;
	responseBody?: string | null;
}

export interface BodiesForDisplay {
	requestBody: string | null;
	responseBody: string | null;
	/** False = the policy never captured content; the page shows "not retained". */
	contentRetained: boolean;
}

/**
 * Bodies as the admin UI may show them: the real text under an opt-in policy,
 * NULL (rendered as "not retained") otherwise — regardless of what the row
 * happens to carry.
 */
export function bodiesForDisplay<T extends BodyRow>(
	row: T,
	retention: ContentRetentionView | null | undefined
): BodiesForDisplay {
	if (!contentCaptureAllowed(retention)) {
		return { requestBody: null, responseBody: null, contentRetained: false };
	}
	return {
		requestBody: row.requestBody ?? null,
		responseBody: row.responseBody ?? null,
		contentRetained: true
	};
}
