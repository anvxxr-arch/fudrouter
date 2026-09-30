/**
 * Sandbox chat — a real completion against a provider credential.
 *
 * Used by both "test credential" and the admin playground. No system prompt and
 * no tools are sent: this is a probe of the upstream credential, not a routed
 * product request, so nothing lands in `request_log` and the model does not have
 * to be published to be tested.
 *
 * The response shape is fixed so the page can render every outcome through one
 * branch. Conditions that are not a chat result at all (no such provider, a
 * native protocol the sandbox cannot speak, an undecryptable blob) return
 * `{fatal}` so callers can turn them into a form error rather than a red result
 * row that looks like the upstream failed.
 */
import { decryptCredentials, type Credentials } from '$lib/server/credentials';
import { allowPrivateUpstreams } from '$lib/server/publish-env';
import { guardedUpstreamFetch } from '$lib/server/ssrf';
import { getProvider } from '$lib/server/provider-catalog-fetch';
import { headersFor, nativeProtocol, tokenAt } from '$lib/server/provider-credentials';

/**
 * A chat is a different budget from a catalog read: a reasoning model on a cold
 * upstream was measured at 27s for a one-word prompt, so the sandbox would report
 * a false failure on a 15s cap.
 */
const CHAT_TIMEOUT_MS = 60_000;

/** One sandbox outcome — the same shape whatever happened. */
export interface SandboxResult {
	ok: boolean;
	status: number | null;
	latencyMs: number;
	tokensIn: number | null;
	tokensOut: number | null;
	content: string | null;
	/** A reasoning model that ran out of budget answers here instead of `content`. */
	reasoning: string | null;
	finishReason: string | null;
	error: string | null;
}
/**
 * A real chat completion against the provider, used by both "test model" and the
 * playground. No system prompt and no tools are sent: this is a sandbox probe of
 * the upstream credential, not a routed product request, so nothing lands in
 * request_log and the model does not have to be published to be tested.
 *
 * Returns `{fatal}` for conditions that are not a chat result at all, so callers
 * can turn them into a form error; `{result}` is always the same shape.
 */
export async function sandboxChat(
	providerId: string,
	slug: string,
	message: string
): Promise<{ fatal: string } | { result: SandboxResult }> {
	const p = await getProvider(providerId);
	if (!p) return { fatal: 'provider not found' };

	let cred: Credentials;
	try {
		cred = decryptCredentials(p.credentialsEnc);
	} catch {
		return { fatal: 'credentials could not be decrypted' };
	}

	const protocol = nativeProtocol(cred);
	if (protocol) {
		return {
			fatal: `this provider speaks a native "${protocol}" protocol; the sandbox only sends plain [OI] chat`
		};
	}

	const headers = { ...headersFor(cred, tokenAt(cred, 0)), 'content-type': 'application/json' };
	const body = JSON.stringify({
		model: slug,
		messages: [{ role: 'user', content: message }],
		// A reasoning model spends the budget on its own trace before it writes
		// anything, and a small cap returns finish_reason "length" with empty
		// content — which reads as a broken model when it is not.
		max_tokens: 512
	});

	const started = Date.now();
	// Guarded, exactly as on the catalog path: an admin sets base_url, so a chat
	// POST against an unvalidated target is a request-forgery primitive. The
	// helper owns the timeout and abort, so there is no ctrl/timer pair to leak
	// on an early return.
	const guarded = await guardedUpstreamFetch(
		p.baseUrl,
		allowPrivateUpstreams(),
		'/chat/completions',
		{
			method: 'POST',
			headers,
			body,
			timeoutMs: CHAT_TIMEOUT_MS
		}
	);
	const latencyMs = Date.now() - started;
	if (!guarded.ok) {
		return {
			result: {
				ok: false,
				status: null,
				latencyMs,
				tokensIn: null,
				tokensOut: null,
				content: null,
				reasoning: null,
				finishReason: null,
				error: guarded.message
			}
		};
	}
	const res = guarded.response;
	try {
		const text = await res.text();
		let parsed: Record<string, unknown> = {};
		try {
			parsed = JSON.parse(text) as Record<string, unknown>;
		} catch {
			/* non-JSON error body */
		}

		if (!res.ok) {
			const upstream = (parsed.error as Record<string, unknown> | undefined)?.message;
			return {
				result: {
					ok: false,
					status: res.status,
					latencyMs,
					tokensIn: null,
					tokensOut: null,
					content: null,
					reasoning: null,
					finishReason: null,
					error: String(upstream ?? text.slice(0, 300) ?? `HTTP ${res.status}`)
				}
			};
		}

		type Choice = {
			message?: { content?: string | null; reasoning_content?: string | null };
			finish_reason?: string;
		};
		const choice = (parsed.choices as Choice[] | undefined)?.[0];
		const usage = parsed.usage as
			{ prompt_tokens?: number; completion_tokens?: number } | undefined;
		const content = choice?.message?.content?.trim() ? choice.message.content : null;
		const reasoning = choice?.message?.reasoning_content?.trim()
			? choice.message.reasoning_content
			: null;
		return {
			result: {
				ok: true,
				status: res.status,
				latencyMs,
				tokensIn: usage?.prompt_tokens ?? null,
				tokensOut: usage?.completion_tokens ?? null,
				content,
				// A reasoning model that ran out of budget answers in `reasoning_content`
				// with an empty `content`. Surfacing it beats showing a blank reply.
				reasoning,
				finishReason: choice?.finish_reason ?? null,
				error: null
			}
		};
	} catch (err) {
		return {
			result: {
				ok: false,
				status: null,
				latencyMs: Date.now() - started,
				tokensIn: null,
				tokensOut: null,
				content: null,
				reasoning: null,
				finishReason: null,
				error: err instanceof Error ? err.message : 'request failed'
			}
		};
	}
}
