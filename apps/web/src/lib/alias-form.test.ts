import { describe, expect, it } from 'vitest';
import { ALIAS_NAME_PATTERN, parseAliasForm, targetRows } from './alias-form';

/** A `FormData.get`-shaped getter over a plain record — keeps the test free of DOM. */
function getter(fields: Record<string, string>): (k: string) => FormDataEntryValue | null {
	return (k) => (k in fields ? fields[k] : null);
}

describe('name validation', () => {
	it('accepts 2..64 chars of lowercase letters, digits and dashes', () => {
		for (const name of ['ab', 'a1', '99', 'my-alias', 'api-v2', 'a'.repeat(64)]) {
			expect(ALIAS_NAME_PATTERN.test(name), name).toBe(true);
		}
	});
	it('rejects below the 2-char floor and past the 64-char ceiling', () => {
		expect(ALIAS_NAME_PATTERN.test('a')).toBe(false);
		expect(ALIAS_NAME_PATTERN.test('')).toBe(false);
		expect(ALIAS_NAME_PATTERN.test('a'.repeat(65))).toBe(false);
	});
	it('rejects uppercase, underscores, spaces, dots and leading dashes', () => {
		for (const name of ['My-Alias', 'my_alias', 'my alias', 'my.alias', '-lead']) {
			expect(ALIAS_NAME_PATTERN.test(name), name).toBe(false);
		}
	});
});

describe('parseAliasForm', () => {
	it('round-trips a full form into a trimmed value', () => {
		const result = parseAliasForm(
			getter({
				name: '  Fast-Primary  ',
				description: '  prefers the cheapest healthy model  ',
				enabled: 'on',
				targets: JSON.stringify(['mdl_a', 'mdl_b'])
			})
		);
		expect(result).toEqual({
			ok: true,
			value: {
				name: 'fast-primary',
				description: 'prefers the cheapest healthy model',
				enabled: true,
				targets: ['mdl_a', 'mdl_b']
			}
		});
	});
	it('treats a missing enabled checkbox as disabled', () => {
		const result = parseAliasForm(getter({ name: 'plain', targets: JSON.stringify(['mdl_a']) }));
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.enabled).toBe(false);
	});
	it('rejects an invalid name before anything else', () => {
		const result = parseAliasForm(getter({ name: 'Bad Name', targets: JSON.stringify(['mdl_a']) }));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/Invalid name/);
	});
	it('rejects an empty target list', () => {
		const result = parseAliasForm(getter({ name: 'empty-targets', targets: '[]' }));
		expect(result).toEqual({ ok: false, error: 'Pick at least one model as the primary target.' });
	});
	it('rejects duplicate targets, keeping first-seen order otherwise', () => {
		const result = parseAliasForm(
			getter({ name: 'dupes', targets: JSON.stringify(['mdl_a', 'mdl_b', 'mdl_a']) })
		);
		expect(result).toEqual({
			ok: false,
			error: 'Each model may appear in the fallback list only once.'
		});
	});
	it('rejects malformed targets payloads', () => {
		for (const targets of ['not-json', '{"a":1}', '[""]', '[1]']) {
			const result = parseAliasForm(getter({ name: 'bad-targets', targets }));
			expect(result.ok, targets).toBe(false);
		}
	});
});

describe('targetRows', () => {
	it('numbers targets 1..N in the given order', () => {
		expect(targetRows('als_1', ['mdl_a', 'mdl_b', 'mdl_c'])).toEqual([
			{ aliasId: 'als_1', modelId: 'mdl_a', position: 1 },
			{ aliasId: 'als_1', modelId: 'mdl_b', position: 2 },
			{ aliasId: 'als_1', modelId: 'mdl_c', position: 3 }
		]);
	});
	it('gives a single-target alias position 1 and an empty list no rows', () => {
		expect(targetRows('als_2', ['mdl_a'])).toEqual([
			{ aliasId: 'als_2', modelId: 'mdl_a', position: 1 }
		]);
		expect(targetRows('als_3', [])).toEqual([]);
	});
	it('preserves the parse order round-trip: parse → targetRows', () => {
		const parsed = parseAliasForm(
			getter({ name: 'ordered', targets: JSON.stringify(['mdl_c', 'mdl_a', 'mdl_b']) })
		);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(targetRows('als_x', parsed.value.targets).map((t) => t.position)).toEqual([1, 2, 3]);
			expect(targetRows('als_x', parsed.value.targets).map((t) => t.modelId)).toEqual([
				'mdl_c',
				'mdl_a',
				'mdl_b'
			]);
		}
	});
});
