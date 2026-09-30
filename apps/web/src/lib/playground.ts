/**
 * Playground request shape — pure build/normalize logic (PRD §27).
 *
 * The playground is a real client of the data plane: this module only builds
 * the `/v1/chat/completions` body and normalizes what comes back (metrics and
 * the PRD §130 error shape). Transport and key minting live server-side.
 */

export const PLAYGROUND_STRATEGIES = [
	{ value: '', label: 'Policy default', hint: 'Whatever the bound routing policy applies.' },
	{ value: 'balanced', label: 'Balanced', hint: 'Blended price/latency/reliability/capacity score.' },
	{ value: 'lowest_cost', label: 'Lowest Cost', hint: 'Cheapest candidate wins.' },
	{ value: 'lowest_latency', label: 'Lowest Latency', hint: 'Fastest candidate wins.' },
	{ value: 'highest_reliability', label: 'Highest Reliability', hint: 'Most reliable candidate wins.' },
	{ value: 'provider_priority', label: 'Provider Priority', hint: 'provider_preferences.order decides.' },
	{ value: 'weighted', label: 'Weighted', hint: 'Load spread across provider_preferences.order.' },
	{ value: 'round_robin', label: 'Round Robin', hint: 'Rotate across candidates.' },
	{ value: 'random', label: 'Random', hint: 'Uniform pick among candidates.' }
] as const;

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
}

export interface PlaygroundForm {
	/** Canonical slug, alias name, or fudrouter/* virtual. */
	model: string;
	strategy: string;
	messages: ChatMessage[];
	system: string;
	temperature: number | null;
	maxTokens: number | null;
	tools: unknown[] | null;
	jsonMode: boolean;
	stream: boolean;
	keyId: string;
}

export type ParseResult =
	| { ok: true; value: PlaygroundForm }
	| { ok: false; error: string };

/**
 * Parse the playground form. `messages` arrives as JSON (the panel edits
 * message rows and serializes them), so a malformed blob is a validation
 * error, not a crash.
 */
export function parsePlaygroundForm(get: (k: string) => FormDataEntryValue | null): ParseResult {
	const model = String(get('model') ?? '').trim();
	if (!model) return { ok: false, error: 'Pick a model or alias before running.' };

	const rawMessages = String(get('messages') ?? '').trim();
	let messages: ChatMessage[];
	try {
		const parsed = JSON.parse(rawMessages || '[]');
		if (!Array.isArray(parsed)) throw new Error('not an array');
		messages = parsed.map((m) => {
			const role = String((m as ChatMessage)?.role ?? '');
			const content = String((m as ChatMessage)?.content ?? '');
			if (!['system', 'user', 'assistant', 'tool'].includes(role)) {
				throw new Error('bad role');
			}
			return { role: role as ChatMessage['role'], content };
		});
	} catch {
		return { ok: false, error: 'Messages must be a JSON array of {role, content}.' };
	}
	if (messages.length === 0) return { ok: false, error: 'Add at least one message.' };

	const toolsRaw = String(get('tools') ?? '').trim();
	let tools: unknown[] | null = null;
	if (toolsRaw) {
		try {
			const parsed = JSON.parse(toolsRaw);
			if (!Array.isArray(parsed)) throw new Error('not an array');
			tools = parsed;
		} catch {
			return { ok: false, error: 'Tools must be a JSON array of tool definitions.' };
		}
	}

	const temperatureRaw = String(get('temperature') ?? '').trim();
	let temperature: number | null = null;
	if (temperatureRaw !== '') {
		temperature = Number(temperatureRaw);
		if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
			return { ok: false, error: 'Temperature must be between 0 and 2.' };
		}
	}

	const maxTokensRaw = String(get('maxTokens') ?? '').trim();
	let maxTokens: number | null = null;
	if (maxTokensRaw !== '') {
		maxTokens = Number(maxTokensRaw);
		if (!Number.isInteger(maxTokens) || maxTokens < 1) {
			return { ok: false, error: 'Max tokens must be a positive integer.' };
		}
	}

	const strategy = String(get('strategy') ?? '');
	if (strategy && !PLAYGROUND_STRATEGIES.some((s) => s.value === strategy && s.value !== '')) {
		return { ok: false, error: 'Unknown routing strategy.' };
	}

	return {
		ok: true,
		value: {
			model,
			strategy,
			messages,
			system: String(get('system') ?? ''),
			temperature,
			maxTokens,
			tools,
			jsonMode: get('jsonMode') === 'on' || get('jsonMode') === 'true',
			stream: get('stream') === 'on' || get('stream') === 'true',
			keyId: String(get('keyId') ?? '').trim()
		}
	};
}

/**
 * The exact body sent to `POST /v1/chat/completions`. A non-empty system prompt
 * becomes the standard `system` message at the head of the list — the same wire
 * shape an SDK client would send.
 */
export function buildChatBody(form: PlaygroundForm, opts: { stream: boolean }): Record<string, unknown> {
	const messages: ChatMessage[] = [];
	if (form.system.trim()) messages.push({ role: 'system', content: form.system });
	messages.push(...form.messages);
	const body: Record<string, unknown> = { model: form.model, messages, stream: opts.stream };
	if (form.temperature !== null) body.temperature = form.temperature;
	if (form.maxTokens !== null) body.max_tokens = form.maxTokens;
	if (form.tools && form.tools.length > 0) body.tools = form.tools;
	if (form.jsonMode) body.response_format = { type: 'json_object' };
	return body;
}

/** PRD §27 metrics panel fields, in display order. Missing values render as `—`. */
export interface RunMetrics {
	requestId: string | null;
	provider: string | null;
	connection: string | null;
	actualModel: string | null;
	tokensIn: number | null;
	tokensOut: number | null;
	tokensTotal: number | null;
	ttftMs: number | null;
	latencyMs: number | null;
	costMicro: string | null;
	fallback: boolean | null;
	attempts: number | null;
}

export const EMPTY_METRICS: RunMetrics = {
	requestId: null,
	provider: null,
	connection: null,
	actualModel: null,
	tokensIn: null,
	tokensOut: null,
	tokensTotal: null,
	ttftMs: null,
	latencyMs: null,
	costMicro: null,
	fallback: null,
	attempts: null
};

/** PRD §130 normalized error: taxonomy code + human message + correlation id. */
export interface NormalizedError {
	code: string;
	message: string;
	requestId: string | null;
}

export interface UpstreamResult {
	status: number;
	headers: { get(name: string): string | null };
	/** Parsed JSON body, or null for a non-JSON body. */
	json: Record<string, unknown> | null;
	text: string;
}

/**
 * Fold the data plane's response into metrics + normalized error.
 *
 * The router reports identity in `x-fudrouter-*` headers (request id, resolved
 * model, provider, latency) and usage in the body's `usage` block; anything the
 * plane does not report stays null and renders as `—` rather than a guess.
 */
export function normalizeRunResult(result: UpstreamResult): {
	metrics: RunMetrics;
	error: NormalizedError | null;
} {
	const usage = (result.json?.usage ?? null) as Record<string, number> | null;
	const model = (result.json?.model ?? null) as string | null;
	const requestId = result.headers.get('x-fudrouter-request-id');
	const latencyHeader = result.headers.get('x-fudrouter-latency');
	const tokensIn = usage && typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : null;
	const tokensOut =
		usage && typeof usage.completion_tokens === 'number' ? usage.completion_tokens : null;
	const tokensTotal =
		usage && typeof usage.total_tokens === 'number'
			? usage.total_tokens
			: tokensIn !== null && tokensOut !== null
				? tokensIn + tokensOut
				: null;
	const metrics: RunMetrics = {
		requestId: requestId ?? null,
		provider: result.headers.get('x-fudrouter-provider'),
		connection: null,
		actualModel: result.headers.get('x-fudrouter-model') ?? model,
		tokensIn,
		tokensOut,
		tokensTotal,
		ttftMs: null,
		latencyMs: latencyHeader !== null ? Number(latencyHeader) : null,
		costMicro: null,
		fallback: null,
		attempts: null
	};
	if (result.status >= 200 && result.status < 300) return { metrics, error: null };

	const err = (result.json?.error ?? null) as Record<string, unknown> | null;
	const code = typeof err?.code === 'string' ? err.code : codeForStatus(result.status);
	const message = typeof err?.message === 'string' ? err.message : result.text.slice(0, 500) || 'Request failed.';
	return { metrics, error: { code, message, requestId: requestId ?? null } };
}

/** Taxonomy fallback when the plane sends no `code` (PRD §130, spec §8). */
export function codeForStatus(status: number): string {
	switch (status) {
		case 400:
			return 'INVALID_REQUEST';
		case 401:
			return 'AUTHENTICATION_ERROR';
		case 402:
			return 'INSUFFICIENT_CREDITS';
		case 403:
			return 'AUTHORIZATION_ERROR';
		case 404:
			return 'MODEL_NOT_FOUND';
		case 413:
			return 'CONTEXT_TOO_LONG';
		case 429:
			return 'RATE_LIMITED';
		case 504:
			return 'PROVIDER_TIMEOUT';
		default:
			return status >= 500 ? 'UPSTREAM_ERROR' : 'INTERNAL_ERROR';
	}
}

/**
 * Overlay `request_log` values on the fast-path metrics. The ledger row is the
 * authoritative record (tokens, cost, TTFT, attempts, fallback, connection);
 * headers win only for identity fields the row has not filled yet.
 */
export function mergeLogMetrics(
	metrics: RunMetrics,
	log: {
		requestId?: string | null;
		provider?: string | null;
		connection?: string | null;
		actualModel?: string | null;
		tokensIn?: number | null;
		tokensOut?: number | null;
		tokensTotal?: number | null;
		ttftMs?: number | null;
		latencyMs?: number | null;
		costMicro?: string | null;
		fallback?: boolean | null;
		attempts?: number | null;
	}
): RunMetrics {
	const pick = <K extends keyof RunMetrics>(key: K): RunMetrics[K] =>
		(log[key] ?? null) !== null ? (log[key] as RunMetrics[K]) : metrics[key];
	return {
		requestId: pick('requestId'),
		provider: pick('provider'),
		connection: pick('connection'),
		actualModel: pick('actualModel'),
		tokensIn: pick('tokensIn'),
		tokensOut: pick('tokensOut'),
		tokensTotal: pick('tokensTotal'),
		ttftMs: pick('ttftMs'),
		latencyMs: pick('latencyMs'),
		costMicro: pick('costMicro'),
		fallback: pick('fallback'),
		attempts: pick('attempts')
	};
}
