import { describe, expect, it } from 'vitest';
import {
	MAX_BATCH_MODELS,
	MAX_CHAT_CHARS,
	MAX_CONTEXT_TOKENS,
	MAX_PRIORITY,
	MAX_PRICE_USD,
	MAX_SLUG_CHARS,
	cleanModelPayload,
	cleanSlug,
	cleanText,
	parseIndex,
	parseModelPayloads,
	parsePriority,
	parseSlugList,
	parseTier,
	safeUpstreamUrl
} from './admin-limits';

describe('parseTier', () => {
	it('accepts the four filters the gallery understands', () => {
		for (const t of ['all', 'free', 'paid', 'unknown'] as const) expect(parseTier(t)).toBe(t);
	});

	it('falls back to `all` for anything else, including empty and undefined', () => {
		expect(parseTier('everything')).toBe('all');
		expect(parseTier('')).toBe('all');
		expect(parseTier(undefined)).toBe('all');
		expect(parseTier(null)).toBe('all');
		expect(parseTier(42)).toBe('all');
	});
});

describe('cleanSlug', () => {
	it('keeps real slugs, including a namespace prefix and a :free suffix', () => {
		expect(cleanSlug('deepseek/deepseek-v4-flash')).toBe('deepseek/deepseek-v4-flash');
		expect(cleanSlug('models/gemini-3.6-flash')).toBe('models/gemini-3.6-flash');
		expect(cleanSlug('mimo-v2.5:free')).toBe('mimo-v2.5:free');
		expect(cleanSlug('  spaced  ')).toBe('spaced');
	});

	it('rejects blank, whitespace inside, control characters and over-long slugs', () => {
		expect(cleanSlug('')).toBeNull();
		expect(cleanSlug('   ')).toBeNull();
		expect(cleanSlug(undefined)).toBeNull();
		// Internal whitespace is not cosmetic: the slug is the upstream `model` field.
		expect(cleanSlug('gpt 5.6')).toBeNull();
		expect(cleanSlug('gpt\t5.6')).toBeNull();
		expect(cleanSlug('gpt\u00005.6')).toBeNull();
		expect(cleanSlug('a'.repeat(MAX_SLUG_CHARS + 1))).toBeNull();
		expect(cleanSlug('a'.repeat(MAX_SLUG_CHARS))).toBe('a'.repeat(MAX_SLUG_CHARS));
	});
});

describe('cleanText', () => {
	it('keeps newlines — a playground message can be multi-line', () => {
		expect(cleanText('line one\nline two')).toBe('line one\nline two');
	});

	it('strips control characters that would break the JSON body', () => {
		expect(cleanText('a\u0000b\u001fc')).toBe('abc');
	});

	it('rejects blank and over-long messages', () => {
		expect(cleanText('')).toBeNull();
		expect(cleanText('   ')).toBeNull();
		expect(cleanText('x'.repeat(MAX_CHAT_CHARS + 1))).toBeNull();
		expect(cleanText('x'.repeat(MAX_CHAT_CHARS))).toHaveLength(MAX_CHAT_CHARS);
	});
});

describe('parsePriority', () => {
	it('accepts whole numbers in range', () => {
		expect(parsePriority('100')).toBe(100);
		expect(parsePriority('0')).toBe(0);
		expect(parsePriority(String(MAX_PRIORITY))).toBe(MAX_PRIORITY);
		expect(parsePriority(' 190 ')).toBe(190);
	});

	it('rejects what an integer column cannot store', () => {
		// 1e308 would reach `integer` and fail as a 500 instead of a 400.
		expect(parsePriority('1e308')).toBeNull();
		expect(parsePriority('999999999999')).toBeNull();
		expect(parsePriority(String(MAX_PRIORITY + 1))).toBeNull();
		expect(parsePriority('-1')).toBeNull();
		expect(parsePriority('1.5')).toBeNull();
		expect(parsePriority('abc')).toBeNull();
		expect(parsePriority('')).toBeNull();
		expect(parsePriority('NaN')).toBeNull();
		expect(parsePriority(Infinity)).toBeNull();
	});
});

describe('parseIndex', () => {
	it('accepts an index that addresses a real credential', () => {
		expect(parseIndex('0', 10)).toBe(0);
		expect(parseIndex('9', 10)).toBe(9);
	});

	it('rejects an index outside the pool — probing with an empty token lies', () => {
		expect(parseIndex('10', 10)).toBeNull();
		expect(parseIndex('999', 10)).toBeNull();
		expect(parseIndex('-1', 10)).toBeNull();
		expect(parseIndex('1.5', 10)).toBeNull();
		expect(parseIndex('abc', 10)).toBeNull();
		expect(parseIndex('', 10)).toBeNull();
		expect(parseIndex('0', 0)).toBeNull();
	});
});

describe('safeUpstreamUrl', () => {
	it('accepts http(s) and drops a trailing slash', () => {
		expect(safeUpstreamUrl('https://openrouter.ai/api/v1')).toBe('https://openrouter.ai/api/v1');
		expect(safeUpstreamUrl('https://openrouter.ai/api/v1/')).toBe('https://openrouter.ai/api/v1');
	});

	it('refuses loopback/private/link-local targets unless explicitly allowed', () => {
		// A stored base_url is fetched server-side, so a private target is an SSRF
		// probe (the loopback DB, the cloud metadata endpoint). Blocked by default.
		for (const blocked of [
			'http://127.0.0.1:8100',
			'http://localhost:3000/v1',
			'http://169.254.169.254/',
			'http://10.0.0.5/v1',
			'http://192.168.100.6:5432',
			'http://172.16.0.1/v1',
			'http://100.64.0.1/v1',
			'http://[::1]:8100/v1'
		]) {
			expect(safeUpstreamUrl(blocked), blocked).toBeNull();
		}
		// The deployment runs local upstreams (seed = http://127.0.0.1:20128/v1),
		// so the block must be escapable by an explicit opt-in.
		expect(safeUpstreamUrl('http://127.0.0.1:8100', true)).toBe('http://127.0.0.1:8100');
		expect(safeUpstreamUrl('http://127.0.0.1:20128/v1', true)).toBe('http://127.0.0.1:20128/v1');
		// A public host is unaffected by the flag either way.
		expect(safeUpstreamUrl('https://openrouter.ai/api/v1', true)).toBe(
			'https://openrouter.ai/api/v1'
		);
	});

	it('refuses a scheme that is not http(s)', () => {
		expect(safeUpstreamUrl('ftp://example.com')).toBeNull();
		expect(safeUpstreamUrl('file:///etc/passwd')).toBeNull();
		expect(safeUpstreamUrl('not a url')).toBeNull();
		expect(safeUpstreamUrl('')).toBeNull();
		expect(safeUpstreamUrl(undefined)).toBeNull();
	});

	it('refuses credentials embedded in the URL and strips a fragment', () => {
		// Those would be echoed into error messages and upstream logs.
		expect(safeUpstreamUrl('https://user:secret@example.com/v1')).toBeNull();
		expect(safeUpstreamUrl('https://token@example.com/v1')).toBeNull();
		expect(safeUpstreamUrl('https://example.com/v1#frag')).toBe('https://example.com/v1');
	});
});

describe('cleanModelPayload', () => {
	it('accepts a gallery payload', () => {
		expect(
			cleanModelPayload(
				JSON.stringify({
					slug: 'a/b:free',
					name: 'A',
					context: 128000,
					inputUsd: 0.15,
					outputUsd: 0.6
				})
			)
		).toEqual({ slug: 'a/b:free', name: 'A', context: 128000, inputUsd: 0.15, outputUsd: 0.6 });
	});

	it('rejects a payload with no trustworthy slug', () => {
		// A blank slug would be inserted and then never match a request.
		expect(cleanModelPayload(JSON.stringify({ name: 'no slug' }))).toBeNull();
		expect(cleanModelPayload(JSON.stringify({ slug: '   ' }))).toBeNull();
		expect(cleanModelPayload('not json')).toBeNull();
		expect(cleanModelPayload('null')).toBeNull();
		expect(cleanModelPayload('"a string"')).toBeNull();
		expect(cleanModelPayload('[]')).toBeNull();
	});

	it('falls back to the slug as a name and truncates an over-long one', () => {
		expect(cleanModelPayload(JSON.stringify({ slug: 'x' }))?.name).toBe('x');
		const long = cleanModelPayload(JSON.stringify({ slug: 'x', name: 'n'.repeat(500) }));
		expect(long?.name).toHaveLength(200);
	});

	it('clamps prices into a sane range instead of storing nonsense', () => {
		const negative = cleanModelPayload(JSON.stringify({ slug: 'x', inputUsd: -5 }));
		expect(negative?.inputUsd).toBe(0);
		const absurd = cleanModelPayload(JSON.stringify({ slug: 'x', outputUsd: 1e12 }));
		expect(absurd?.outputUsd).toBe(MAX_PRICE_USD);
		const junk = cleanModelPayload(JSON.stringify({ slug: 'x', inputUsd: 'free' }));
		expect(junk?.inputUsd).toBe(0);
	});

	it('bounds the context window and rounds it to an integer', () => {
		expect(cleanModelPayload(JSON.stringify({ slug: 'x', context: 1e12 }))?.context).toBe(
			MAX_CONTEXT_TOKENS
		);
		expect(cleanModelPayload(JSON.stringify({ slug: 'x', context: 128000.7 }))?.context).toBe(
			128001
		);
		expect(cleanModelPayload(JSON.stringify({ slug: 'x', context: 'nope' }))?.context).toBeNull();
		expect(cleanModelPayload(JSON.stringify({ slug: 'x' }))?.context).toBeNull();
	});
});

describe('parseModelPayloads', () => {
	const p = (slug: string) => JSON.stringify({ slug, name: slug, inputUsd: 0, outputUsd: 0 });

	it('keeps valid rows and counts what it dropped', () => {
		const { rows, rejected, overCap } = parseModelPayloads([
			p('a'),
			'junk',
			p('b'),
			'{"no":"slug"}'
		]);
		expect(rows.map((r) => r.slug)).toEqual(['a', 'b']);
		expect(rejected).toBe(2);
		expect(overCap).toBe(0);
	});

	it('de-duplicates inside one batch so the second insert cannot fail', () => {
		// Without this the duplicate would insert twice and the failure would be
		// reported as "owned elsewhere", which is not what happened.
		const { rows, duplicates, rejected } = parseModelPayloads([p('a'), p('a'), p('b')]);
		expect(rows.map((r) => r.slug)).toEqual(['a', 'b']);
		expect(duplicates).toBe(1);
		expect(rejected).toBe(0);
	});

	it('separates an invalid row from a duplicate', () => {
		const { rows, duplicates, rejected } = parseModelPayloads([p('a'), 'junk', p('a')]);
		expect(rows).toHaveLength(1);
		expect(rejected).toBe(1);
		expect(duplicates).toBe(1);
	});

	it('caps the batch and reports how many were left out', () => {
		const many = Array.from({ length: MAX_BATCH_MODELS + 25 }, (_, i) => p(`m${i}`));
		const { rows, overCap } = parseModelPayloads(many);
		expect(rows).toHaveLength(MAX_BATCH_MODELS);
		expect(overCap).toBe(25);
	});
});

describe('parseSlugList', () => {
	it('cleans, de-duplicates and caps a disable submission', () => {
		const { slugs, overCap } = parseSlugList(['a', 'a', ' gpt 5 ', '', 'b']);
		expect(slugs).toEqual(['a', 'b']);
		expect(overCap).toBe(0);
	});

	it('drops out-of-range entries rather than building a huge WHERE', () => {
		const many = Array.from({ length: MAX_BATCH_MODELS + 7 }, (_, i) => `s${i}`);
		const { slugs, overCap } = parseSlugList(many);
		expect(slugs).toHaveLength(MAX_BATCH_MODELS);
		expect(overCap).toBe(7);
	});
});
