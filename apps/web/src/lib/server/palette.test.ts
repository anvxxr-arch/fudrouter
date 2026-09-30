import { describe, expect, it } from 'vitest';
import { likePattern, paletteParams } from './palette';

const url = (qs: string) => new URL(`http://x/api/palette/projects${qs}`);

describe('paletteParams', () => {
	it('normalizes q and defaults the limit to 8', () => {
		expect(paletteParams(url('?q=%20%20a%20%20b%20'))).toEqual({ q: 'a b', limit: 8 });
		expect(paletteParams(url(''))).toEqual({ q: '', limit: 8 });
	});
	it('clamps limit to 1..20 and floors it', () => {
		expect(paletteParams(url('?limit=0')).limit).toBe(1);
		expect(paletteParams(url('?limit=50')).limit).toBe(20);
		expect(paletteParams(url('?limit=8.9')).limit).toBe(8);
	});
	it('falls back to 8 on a garbage limit', () => {
		expect(paletteParams(url('?limit=abc')).limit).toBe(8);
		expect(paletteParams(url('?limit=')).limit).toBe(8);
	});
});

describe('likePattern', () => {
	it('wraps contains patterns in %', () => {
		expect(likePattern('gpt', 'contains')).toBe('%gpt%');
		expect(likePattern('gpt', 'prefix')).toBe('gpt%');
	});
	it('escapes LIKE metacharacters so they match literally', () => {
		// Postgres' default LIKE escape character is `\`.
		expect(likePattern('100%', 'contains')).toBe('%100\\%%');
		expect(likePattern('a_b', 'prefix')).toBe('a\\_b%');
		expect(likePattern('c:\\tmp', 'contains')).toBe('%c:\\\\tmp%');
	});
	it('leaves ordinary text untouched', () => {
		expect(likePattern('req_01', 'prefix')).toBe('req\\_01%');
	});
});
