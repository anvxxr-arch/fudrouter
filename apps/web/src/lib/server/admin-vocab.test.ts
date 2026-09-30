import { describe, expect, it } from 'vitest';
import {
	MODEL_STATUSES,
	PROVIDER_STATUSES,
	cleanField,
	parseBoolField,
	parseEnum,
	parseIntField,
	parseSlugField
} from './admin-vocab';

describe('parseEnum', () => {
	it('narrows to the PRD §52 provider vocabulary', () => {
		for (const s of PROVIDER_STATUSES) expect(parseEnum(PROVIDER_STATUSES, s)).toBe(s);
		expect(parseEnum(PROVIDER_STATUSES, 'active')).toBeNull();
		expect(parseEnum(PROVIDER_STATUSES, null)).toBeNull();
	});
	it('narrows to the PRD §125 model vocabulary', () => {
		for (const s of MODEL_STATUSES) expect(parseEnum(MODEL_STATUSES, s)).toBe(s);
		expect(parseEnum(MODEL_STATUSES, 'inactive')).toBeNull();
	});
});

describe('cleanField', () => {
	it('keeps newlines and tabs — multi-line copy is legitimate input', () => {
		expect(cleanField('line one\nline two\tend')).toBe('line one\nline two\tend');
	});
	it('strips control characters that would corrupt JSON and log lines', () => {
		const dirty = 'a' + String.fromCharCode(0) + 'b' + String.fromCharCode(7) + 'c';
		expect(cleanField(dirty)).toBe('abc');
	});
	it('rejects empty and over-long input', () => {
		expect(cleanField('')).toBeNull();
		expect(cleanField('   ')).toBeNull();
		expect(cleanField(null)).toBeNull();
		expect(cleanField('a'.repeat(201))).toBeNull();
		expect(cleanField('a'.repeat(200))).toBe('a'.repeat(200));
	});
});

describe('parseSlugField', () => {
	it('accepts namespaced slugs and ports-style tokens', () => {
		expect(parseSlugField('deepseek/deepseek-v4-flash')).toBe('deepseek/deepseek-v4-flash');
		expect(parseSlugField('mimo-v2.5:free')).toBe('mimo-v2.5:free');
		expect(parseSlugField('  eu-west-1  ')).toBe('eu-west-1');
	});
	it('rejects whitespace inside and unknown characters', () => {
		expect(parseSlugField('gpt 5.6')).toBeNull();
		expect(parseSlugField('bad!slug')).toBeNull();
		expect(parseSlugField('')).toBeNull();
		expect(parseSlugField('a'.repeat(121))).toBeNull();
	});
});

describe('parseIntField', () => {
	it('bounds to the declared range', () => {
		expect(parseIntField('42', { min: 0, max: 100 })).toBe(42);
		expect(parseIntField('0', { min: 0, max: 100 })).toBe(0);
		expect(parseIntField('101', { min: 0, max: 100 })).toBeNull();
		expect(parseIntField('-1', { min: 0, max: 100 })).toBeNull();
		expect(parseIntField('3.5', { min: 0, max: 100 })).toBeNull();
		expect(parseIntField('', { min: 0, max: 100 })).toBeNull();
	});
});

describe('parseBoolField', () => {
	it('reads checkbox semantics', () => {
		expect(parseBoolField('on')).toBe(true);
		expect(parseBoolField('true')).toBe(true);
		expect(parseBoolField('1')).toBe(true);
		expect(parseBoolField('')).toBe(false);
		expect(parseBoolField(null)).toBe(false);
	});
});
