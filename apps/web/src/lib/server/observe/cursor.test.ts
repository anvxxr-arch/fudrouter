import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from './cursor';

describe('cursor', () => {
	it('round-trips a (created_at, id) key', () => {
		const c = { createdAt: new Date('2026-09-30T12:00:00.000Z'), id: 'req_0199aabb' };
		expect(decodeCursor(encodeCursor(c))).toEqual(c);
	});
	it('decodes nothing from junk instead of guessing a position', () => {
		for (const raw of ['', '!!!not-base64!!!', 'bm90aGluZw', 'x3x', 'MjAyNi05LTMwVDEyOjAwOjAwLjAwMFp8']) {
			expect(decodeCursor(raw)).toBeNull();
		}
		expect(decodeCursor(null)).toBeNull();
		expect(decodeCursor(undefined)).toBeNull();
	});
	it('rejects an empty id or an unparseable date', () => {
		const emptyId = Buffer.from('2026-09-30T12:00:00.000Z|', 'utf8').toString('base64url');
		const badDate = Buffer.from('not-a-date|req_1', 'utf8').toString('base64url');
		expect(decodeCursor(emptyId)).toBeNull();
		expect(decodeCursor(badDate)).toBeNull();
	});
	it('keeps the id intact when it contains separator characters', () => {
		const c = { createdAt: new Date('2026-09-30T12:00:00.000Z'), id: 'req_a|b' };
		expect(decodeCursor(encodeCursor(c))?.id).toBe('req_a|b');
	});
});
