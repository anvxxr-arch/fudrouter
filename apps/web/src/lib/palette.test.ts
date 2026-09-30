import { describe, expect, it } from 'vitest';
import {
	assembleGroups,
	clampLimit,
	filterActions,
	normalizeQuery,
	rankItems,
	rankScore,
	type PaletteAction,
	type PaletteItem
} from './palette';

const item = (over: Partial<PaletteItem>): PaletteItem => ({
	id: 'id-1',
	type: 'project',
	title: 'Title',
	subtitle: 'Sub',
	href: '/x',
	...over
});

describe('normalizeQuery', () => {
	it('trims and collapses whitespace', () => {
		expect(normalizeQuery('  a   b \n c ')).toBe('a b c');
		expect(normalizeQuery('')).toBe('');
		expect(normalizeQuery(' \t ')).toBe('');
	});
});

describe('rankScore', () => {
	it('orders exact > prefix > word-start > substring > no match', () => {
		expect(rankScore('api', 'api')).toBe(3);
		expect(rankScore('api keys', 'api')).toBe(2);
		expect(rankScore('my api key', 'api')).toBe(1);
		expect(rankScore('capital', 'api')).toBe(0);
		expect(rankScore('nothing', 'api')).toBe(-1);
	});

	it('is case-insensitive and query-normalizing', () => {
		expect(rankScore('API Keys', '  api ')).toBe(2);
	});

	it('treats empty query as a neutral match', () => {
		expect(rankScore('anything', '  ')).toBe(0);
	});
});

describe('rankItems', () => {
	it('sorts by score descending, then alphabetically', () => {
		const items = [
			item({ id: 'a', title: 'capital' }), // substring (0)
			item({ id: 'b', title: 'api keys' }), // prefix (2)
			item({ id: 'c', title: 'my api' }), // word-start (1)
			item({ id: 'd', title: 'Api' }) // exact (3)
		];
		expect(rankItems(items, 'api').map((i) => i.id)).toEqual(['d', 'b', 'c', 'a']);
	});

	it('breaks equal-score ties alphabetically, then by id', () => {
		const items = [
			item({ id: '1', title: 'Alpine' }),
			item({ id: '2', title: 'ALERT' }),
			item({ id: '3', title: 'alarm' }),
			item({ id: '5', title: 'same' }),
			item({ id: '4', title: 'same' })
		];
		// All three are prefix matches (score 2); case-insensitive alphabetical
		// decides: alarm < alert < alpine.
		expect(rankItems(items, 'al').map((i) => i.id)).toEqual(['3', '2', '1']);
		// Identical titles fall through to the id for a stable order.
		expect(rankItems(items, 'same').map((i) => i.id)).toEqual(['4', '5']);
	});

	it('drops non-matching rows but keeps everything on an empty query', () => {
		const items = [item({ id: 'a', title: 'alpha' }), item({ id: 'b', title: 'omega' })];
		expect(rankItems(items, 'zz').map((i) => i.id)).toEqual([]);
		// Empty query: all items, alphabetical, and each scores 0.
		expect(rankItems(items, '   ').map((i) => i.title)).toEqual(['alpha', 'omega']);
	});

	it('matches subtitle and id too', () => {
		const items = [
			item({ id: 'req_01h', title: 'request', subtitle: 'model-x', type: 'request' }),
			item({ id: 'zz', title: 'other', subtitle: 'nope' })
		];
		expect(rankItems(items, 'req_01').map((i) => i.id)).toEqual(['req_01h']);
		expect(rankItems(items, 'model-x').map((i) => i.id)).toEqual(['req_01h']);
	});
});

describe('filterActions', () => {
	const actions: PaletteAction[] = [
		{ id: 'create-project', title: 'Create project', hint: 'new workspace project', run: () => {} },
		{ id: 'create-key', title: 'Create API key', run: () => {} },
		{ id: 'playground', title: 'Open playground', run: () => {} },
		{ id: 'requests', title: 'Open requests', run: () => {} },
		{ id: 'workspace', title: 'Switch workspace', run: () => {} }
	];

	it('returns everything for an empty query', () => {
		expect(filterActions(actions, '').map((a) => a.id)).toEqual(actions.map((a) => a.id));
	});

	it('filters by title and hint, case-insensitively', () => {
		expect(filterActions(actions, 'create').map((a) => a.id)).toEqual([
			'create-project',
			'create-key'
		]);
		expect(filterActions(actions, 'PLAY').map((a) => a.id)).toEqual(['playground']);
		// Hint text matches even when the title does not.
		expect(filterActions(actions, 'new workspace').map((a) => a.id)).toEqual(['create-project']);
		expect(filterActions(actions, 'zzz')).toEqual([]);
	});
});

describe('assembleGroups', () => {
	it('groups in canonical order and omits empty groups', () => {
		const items = [
			item({ id: 'w', type: 'workspace', title: 'Acme' }),
			item({ id: 'p', type: 'project', title: 'Proj' }),
			item({ id: 'm', type: 'model', title: 'gpt-x' })
		];
		expect(assembleGroups(items).map((g) => g.title)).toEqual([
			'Projects',
			'Models',
			'Workspaces'
		]);
	});

	it('returns no groups for no items', () => {
		expect(assembleGroups([])).toEqual([]);
	});
});

describe('clampLimit', () => {
	it('clamps to 1..20 and floors', () => {
		expect(clampLimit(8)).toBe(8);
		expect(clampLimit(0)).toBe(1);
		expect(clampLimit(99)).toBe(20);
		expect(clampLimit(8.9)).toBe(8);
		expect(clampLimit(Number.NaN)).toBe(20);
	});
});
