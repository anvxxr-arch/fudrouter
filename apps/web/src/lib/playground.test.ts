import { describe, expect, it } from 'vitest';
import {
	buildChatBody,
	codeForStatus,
	mergeLogMetrics,
	normalizeRunResult,
	parsePlaygroundForm,
	EMPTY_METRICS,
	type PlaygroundForm
} from './playground';

const fd = (over: Record<string, string> = {}) => {
	const entries = new FormData();
	for (const [k, v] of Object.entries({ model: 'gpt-x', messages: '[{"role":"user","content":"hi"}]', ...over })) {
		entries.set(k, v);
	}
	return (k: string) => entries.get(k);
};

describe('parsePlaygroundForm', () => {
	it('round-trips the full field set', () => {
		const parsed = parsePlaygroundForm(
			fd({
				system: 'be brief',
				temperature: '0.5',
				maxTokens: '256',
				tools: '[{"type":"function"}]',
				jsonMode: 'on',
				stream: 'on',
				strategy: 'lowest_cost',
				keyId: 'key_1'
			})
		);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value).toEqual({
			model: 'gpt-x',
			strategy: 'lowest_cost',
			messages: [{ role: 'user', content: 'hi' }],
			system: 'be brief',
			temperature: 0.5,
			maxTokens: 256,
			tools: [{ type: 'function' }],
			jsonMode: true,
			stream: true,
			keyId: 'key_1'
		} satisfies PlaygroundForm);
	});
	it('rejects bad input with a message, not a crash', () => {
		expect(parsePlaygroundForm(fd({ model: '' })).ok).toBe(false);
		expect(parsePlaygroundForm(fd({ messages: 'not json' })).ok).toBe(false);
		expect(parsePlaygroundForm(fd({ messages: '[]' })).ok).toBe(false);
		expect(parsePlaygroundForm(fd({ messages: '[{"role":"ghost","content":"x"}]' })).ok).toBe(false);
		expect(parsePlaygroundForm(fd({ temperature: '9' })).ok).toBe(false);
		expect(parsePlaygroundForm(fd({ maxTokens: '0' })).ok).toBe(false);
		expect(parsePlaygroundForm(fd({ tools: '{}' })).ok).toBe(false);
		expect(parsePlaygroundForm(fd({ strategy: 'telepathy' })).ok).toBe(false);
	});
});

describe('buildChatBody', () => {
	const base = (over: Partial<PlaygroundForm> = {}): PlaygroundForm => ({
		model: 'm',
		strategy: '',
		messages: [{ role: 'user', content: 'hi' }],
		system: '',
		temperature: null,
		maxTokens: null,
		tools: null,
		jsonMode: false,
		stream: false,
		keyId: '',
		...over
	});
	it('lifts the system prompt to the head of the list', () => {
		const body = buildChatBody(base({ system: 'sys' }), { stream: false });
		expect(body.messages).toEqual([
			{ role: 'system', content: 'sys' },
			{ role: 'user', content: 'hi' }
		]);
		expect(body.stream).toBe(false);
	});
	it('includes only the optional fields that are set', () => {
		const body = buildChatBody(base({ temperature: 0.2, tools: [{ type: 'function' }], jsonMode: true }), {
			stream: true
		});
		expect(body).toEqual({
			model: 'm',
			messages: [{ role: 'user', content: 'hi' }],
			stream: true,
			temperature: 0.2,
			tools: [{ type: 'function' }],
			response_format: { type: 'json_object' }
		});
	});
});

describe('normalizeRunResult', () => {
	const headers = (map: Record<string, string>) => ({ get: (n: string) => map[n] ?? null });
	it('folds identity headers and usage into metrics', () => {
		const { metrics, error } = normalizeRunResult({
			status: 200,
			headers: headers({
				'x-fudrouter-request-id': 'req_1',
				'x-fudrouter-model': 'gpt-x',
				'x-fudrouter-provider': 'acme',
				'x-fudrouter-latency': '420'
			}),
			json: { usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } },
			text: '{}'
		});
		expect(error).toBeNull();
		expect(metrics).toMatchObject({
			requestId: 'req_1',
			actualModel: 'gpt-x',
			provider: 'acme',
			tokensIn: 3,
			tokensOut: 4,
			tokensTotal: 7,
			latencyMs: 420
		});
	});
	it('sums totals when the provider omits total_tokens', () => {
		const { metrics } = normalizeRunResult({
			status: 200,
			headers: headers({}),
			json: { usage: { prompt_tokens: 1, completion_tokens: 2 } },
			text: '{}'
		});
		expect(metrics.tokensTotal).toBe(3);
	});
	it('normalizes errors to the taxonomy code', () => {
		const { error } = normalizeRunResult({
			status: 429,
			headers: headers({ 'x-fudrouter-request-id': 'req_2' }),
			json: { error: { code: 'RATE_LIMITED', message: 'slow down' } },
			text: ''
		});
		expect(error).toEqual({ code: 'RATE_LIMITED', message: 'slow down', requestId: 'req_2' });
		const bare = normalizeRunResult({ status: 502, headers: headers({}), json: null, text: 'bad gateway' });
		expect(bare.error?.code).toBe('UPSTREAM_ERROR');
		expect(bare.error?.message).toBe('bad gateway');
	});
	it('maps statuses to taxonomy codes as a fallback', () => {
		expect(codeForStatus(400)).toBe('INVALID_REQUEST');
		expect(codeForStatus(402)).toBe('INSUFFICIENT_CREDITS');
		expect(codeForStatus(413)).toBe('CONTEXT_TOO_LONG');
		expect(codeForStatus(504)).toBe('PROVIDER_TIMEOUT');
		expect(codeForStatus(418)).toBe('INTERNAL_ERROR');
	});
	it('lets ledger values fill what headers could not', () => {
		const merged = mergeLogMetrics(
			{ ...EMPTY_METRICS, requestId: 'req_3', provider: 'header-provider' },
			{ provider: 'log-provider', costMicro: '1500000', attempts: 2, fallback: true, tokensIn: 9 }
		);
		expect(merged).toMatchObject({
			requestId: 'req_3',
			provider: 'log-provider',
			costMicro: '1500000',
			attempts: 2,
			fallback: true,
			tokensIn: 9
		});
	});
});
