import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '$lib/design/tokens.css';
import '$lib/design/components.css';
import DetailPage from './+page.svelte';
import type { PageData } from './$types';

/**
 * The request detail page (PRD §29) rendered against the SAME seeded row the
 * DB test writes (`request-queries.test.ts` seeds timing
 * {auth:2, rate_limit:1, routing:3, queue:4, connection:5, generation:80},
 * ttft 25, latency 100 and two attempts). That test proves the loader reads
 * those rows; this one proves the page RENDERS them — attempts table, timing
 * table and the error block — so "detail renders attempts + timing from seeded
 * rows" is covered end to end across the two.
 */
const fixture = {
	denied: false,
	projectId: 'prj_seed',
	project: { id: 'prj_seed', name: 'Seeded Project' },
	row: {
		id: 'req_seed_001',
		createdAt: new Date('2026-09-30T14:00:00.000Z'),
		status: 'provider_error',
		storedStatus: 'upstream_error',
		tone: 'danger',
		endpoint: '/v1/chat/completions',
		projectName: 'Seeded Project',
		environmentName: 'production',
		keyName: 'observe-key',
		keyPrefix: 'observe1',
		clientIp: '203.0.113.5',
		userId: null,
		workspaceId: 'wrk_seed',
		requestedModel: 'observe-model',
		resolvedSlug: 'observe-model',
		providerName: 'observe-provider',
		providerId: 'prv_seed',
		providerModelName: 'upstream-model',
		connectionId: 'con_seed',
		strategy: 'balanced',
		routingPolicyId: null,
		tokensIn: 10,
		cachedInputTokens: null,
		tokensOut: 5,
		reasoningTokens: null,
		totalTokens: 15,
		costMicro: '100',
		currency: 'USD',
		providerCostMicro: '60',
		markupMicro: '40',
		creditChargedMicro: '150',
		pricingRuleId: null,
		inputPriceMicro: null,
		cachedInputPriceMicro: null,
		outputPriceMicro: null,
		reasoningPriceMicro: null,
		ttftMs: 25,
		latencyMs: 100,
		attemptsCount: 2,
		fallbackUsed: true,
		stream: true,
		clientDisconnected: false,
		error: 'upstream returned 503',
		errorCode: 'PROVIDER_UNAVAILABLE',
		httpStatus: 503,
		retryable: true
	},
	// Exactly what lib/server/observe/request-queries.ts timingRows() builds for
	// the seeded timing jsonb + ttft + latency.
	timing: [
		{ key: 'auth', ms: 2 },
		{ key: 'rate_limit', ms: 1 },
		{ key: 'routing', ms: 3 },
		{ key: 'queue', ms: 4 },
		{ key: 'connection', ms: 5 },
		{ key: 'generation', ms: 80 },
		{ key: 'ttft', ms: 25 },
		{ key: 'total', ms: 100 }
	],
	attempts: [
		{
			id: 'rta_seed_1',
			attempt: 1,
			providerName: 'observe-provider',
			providerId: 'prv_seed',
			connectionId: null,
			httpStatus: 503,
			errorCode: 'PROVIDER_UNAVAILABLE',
			retryable: true,
			latencyMs: 40,
			ttftMs: null,
			providerCostMicro: null,
			reason: null,
			startedAt: new Date('2026-09-30T14:00:00.000Z'),
			finishedAt: new Date('2026-09-30T14:00:00.040Z')
		},
		{
			id: 'rta_seed_2',
			attempt: 2,
			providerName: 'observe-provider',
			providerId: 'prv_seed',
			connectionId: 'con_seed',
			httpStatus: 200,
			errorCode: null,
			retryable: false,
			latencyMs: 60,
			ttftMs: 25,
			providerCostMicro: '60',
			reason: 'fallback after upstream 503',
			startedAt: new Date('2026-09-30T14:00:00.040Z'),
			finishedAt: new Date('2026-09-30T14:00:00.100Z')
		}
	],
	content: { state: 'not_captured', requestBody: null, responseBody: null }
} as unknown as PageData;

describe('request detail renders the seeded request', () => {
	it('renders attempts and timing from the seeded rows', () => {
		const { container } = render(DetailPage, { data: fixture });

		// Routing attempts (PRD §29): both attempts, in order, with outcomes.
		const text = container.textContent ?? '';
		expect(text).toContain('Routing attempts');
		expect(text).toContain('fallback after upstream 503');
		expect(text).toContain('PROVIDER_UNAVAILABLE');
		const attemptRows = [...container.querySelectorAll('tbody tr')].filter((tr) =>
			(tr.textContent ?? '').includes('observe-provider')
		);
		expect(attemptRows.length).toBe(2);
		expect(attemptRows[0].textContent ?? '').toContain('PROVIDER_UNAVAILABLE');
		expect(attemptRows[1].textContent ?? '').toContain('fallback after upstream 503');

		// Timing (PRD §29): every stage row with its measured duration.
		for (const stage of ['auth', 'rate_limit', 'routing', 'queue', 'connection', 'generation', 'ttft', 'total']) {
			const row = [...container.querySelectorAll('tbody tr')].find((tr) =>
				(tr.textContent ?? '').trim().startsWith(stage)
			);
			expect(row, `timing row ${stage} is missing`).toBeTruthy();
		}
		expect(text).toContain('100 ms'); // total
		expect(text).toContain('80 ms'); // generation

		// Metadata carries the client IP (PRD §29 Request Metadata).
		expect(text).toContain('203.0.113.5');
		// Error block: normalized code + raw upstream text (PRD §29).
		expect(text).toContain('Normalized code:');
		expect(text).toContain('upstream returned 503');
	});
});
