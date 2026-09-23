import { describe, expect, it } from 'vitest';
import {
	classifyTier,
	filterByTier,
	matchKey,
	parseUpstreamModels,
	seedState,
	slugSuffixNote,
	tierCounts
} from './provider-catalog';

describe('parseUpstreamModels', () => {
	it('reads the OpenRouter per-token shape and converts to per-1M', () => {
		// Real OpenRouter payload: prices are per TOKEN, as strings.
		const [m] = parseUpstreamModels({
			data: [
				{
					id: 'nvidia/nemotron-3.5-lightning:free',
					name: 'Nemotron 3.5 Lightning',
					context_length: 128000,
					pricing: { prompt: '0.0000015', completion: '0.000006' }
				}
			]
		});
		expect(m.slug).toBe('nvidia/nemotron-3.5-lightning:free');
		expect(m.inputUsd).toBe(1.5);
		expect(m.outputUsd).toBe(6);
		expect(m.context).toBe(128000);
		expect(m.tier).toBe('free'); // the :free suffix wins over the quoted price
	});

	it('reads the InferHub per-1M shape without scaling', () => {
		const [m] = parseUpstreamModels({
			data: [
				{
					id: 'ali/deepseek-v4.1-flash',
					pricing: { official_in: 0.16, official_out: 0.64 },
					input_token_limit: 131072
				}
			]
		});
		expect(m.inputUsd).toBe(0.16);
		expect(m.outputUsd).toBe(0.64);
		expect(m.context).toBe(131072);
		expect(m.tier).toBe('paid');
	});

	it('prefers a per-1M pair over a per-token pair when both are present', () => {
		const [m] = parseUpstreamModels({
			data: [{ id: 'x', pricing: { official_in: 2, official_out: 6, prompt: '0.000002' } }]
		});
		expect(m.inputUsd).toBe(2);
		expect(m.outputUsd).toBe(6);
	});

	it('accepts a bare array and falls back to the slug for the name', () => {
		const models = parseUpstreamModels([{ id: 'a' }, { id: 'b' }]);
		expect(models.map((m) => m.slug)).toEqual(['a', 'b']);
		expect(models[0].name).toBe('a');
	});

	it('returns an empty list for anything else', () => {
		expect(parseUpstreamModels(null)).toEqual([]);
		expect(parseUpstreamModels({})).toEqual([]);
		expect(parseUpstreamModels({ data: 'nope' })).toEqual([]);
		expect(parseUpstreamModels({ data: [null, 3, 'x'] })).toEqual([]);
	});

	it('drops entries with no id and de-duplicates repeats', () => {
		const models = parseUpstreamModels({ data: [{ name: 'no id' }, { id: 'a' }, { id: 'a' }] });
		expect(models.map((m) => m.slug)).toEqual(['a']);
	});

	it('rounds scaled prices instead of leaking float noise', () => {
		const [m] = parseUpstreamModels({ data: [{ id: 'x', pricing: { prompt: '0.0000015' } }] });
		expect(m.inputUsd).toBe(1.5);
	});

	it('reports context as null when the upstream omits it', () => {
		const [m] = parseUpstreamModels({ data: [{ id: 'x', pricing: { official_in: 1 } }] });
		expect(m.context).toBeNull();
	});

	it('reads each context key the upstreams actually use', () => {
		for (const key of ['context_length', 'context_window', 'input_token_limit', 'context']) {
			const [m] = parseUpstreamModels({ data: [{ id: 'x', [key]: 4096 }] });
			expect(m.context, key).toBe(4096);
		}
	});
});

describe('classifyTier', () => {
	it('treats a :free slug as free whatever the price says', () => {
		expect(classifyTier('m:free', 5, 15)).toBe('free');
	});

	it('calls zero cost free and any cost paid', () => {
		expect(classifyTier('m', 0, 0)).toBe('free');
		expect(classifyTier('m', 0, 0.5)).toBe('paid');
		expect(classifyTier('m', 1, 0)).toBe('paid');
	});

	it('treats a one-sided quote as free on the missing side', () => {
		expect(classifyTier('m', 0, null)).toBe('free');
	});

	it('is unknown when the upstream reported no price at all', () => {
		expect(classifyTier('m', null, null)).toBe('unknown');
	});
});

describe('filterByTier / tierCounts', () => {
	const models = parseUpstreamModels({
		data: [
			{ id: 'f', pricing: { official_in: 0, official_out: 0 } },
			{ id: 'p', pricing: { official_in: 1, official_out: 2 } },
			{ id: 'u' }
		]
	});

	it('filters to a single tier and passes everything through on "all"', () => {
		expect(filterByTier(models, 'free').map((m) => m.slug)).toEqual(['f']);
		expect(filterByTier(models, 'paid').map((m) => m.slug)).toEqual(['p']);
		expect(filterByTier(models, 'unknown').map((m) => m.slug)).toEqual(['u']);
		expect(filterByTier(models, 'all')).toHaveLength(3);
	});

	it('counts every tier', () => {
		expect(tierCounts(models)).toEqual({ free: 1, paid: 1, unknown: 1 });
	});
});

describe('seedState', () => {
	it('separates a fetched slug from what is already seeded', () => {
		expect(seedState(undefined)).toBe('new');
		expect(seedState('active')).toBe('active');
		expect(seedState('disabled')).toBe('hidden');
		expect(seedState('dev')).toBe('hidden');
	});
});

describe('matchKey', () => {
	it('strips the Google `models/` prefix so ids match stored slugs', () => {
		expect(matchKey('models/gemini-3.6-flash')).toBe('gemini-3.6-flash');
		expect(matchKey('gemini-3.6-flash')).toBe('gemini-3.6-flash');
	});

	it('leaves every other slug alone', () => {
		expect(matchKey('nvidia/nemotron-3.5-lightning:free')).toBe(
			'nvidia/nemotron-3.5-lightning:free'
		);
		expect(matchKey('ali/deepseek-v4.1-flash')).toBe('ali/deepseek-v4.1-flash');
		// Only a LEADING prefix is a namespace artefact; a mid-path `models/` is real.
		expect(matchKey('vendor/models/x')).toBe('vendor/models/x');
	});
});

describe('parseUpstreamModels — real upstream quirks', () => {
	it('skips entries whose id is blank or missing', () => {
		// TokenHarbor really ships rows like this: a label and a price, no id.
		const out = parseUpstreamModels({
			object: 'list',
			data: [
				{ id: 'th-orchestra', label: 'TH Orchestra' },
				{ id: '', label: 'the model 4.6', pricing: { input_usd_per_1m: 3, output_usd_per_1m: 15 } },
				{ id: '   ', label: 'spaces only' },
				{ label: 'no id key at all' },
				{ id: 'grok-4.6' }
			]
		});
		expect(out.map((m) => m.slug)).toEqual(['th-orchestra', 'grok-4.6']);
	});

	it('reads `label` as the display name when there is no name field', () => {
		const out = parseUpstreamModels({ data: [{ id: 'th-orchestra', label: 'TH Orchestra' }] });
		expect(out[0].name).toBe('TH Orchestra');
	});
});

describe('slugSuffixNote', () => {
	it('flags the :free suffix and stays quiet otherwise', () => {
		expect(slugSuffixNote('a/b:free')).toMatch(/free tier/);
		expect(slugSuffixNote('a/b')).toBeNull();
	});
});
