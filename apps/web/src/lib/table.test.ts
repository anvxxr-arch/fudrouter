import { describe, expect, it } from 'vitest';
import {
	applyView,
	compareBy,
	defaultView,
	matchesQuery,
	toggleAllOnPage,
	toggleColumn,
	toggleSelection,
	type Column,
	type TableView
} from './table';

interface Row {
	id: string;
	name: string;
	tokens: number | null;
}

const rows: Row[] = [
	{ id: 'r1', name: 'Alpha', tokens: 100 },
	{ id: 'r2', name: 'beta request', tokens: null },
	{ id: 'r3', name: 'Gamma', tokens: 5 }
];
const columns: Column<Row>[] = [
	{ key: 'name', label: 'Name', value: (r) => r.name },
	{ key: 'tokens', label: 'Tokens', value: (r) => r.tokens, align: 'end' }
];

const view = (over: Partial<TableView> = {}): TableView => ({ ...defaultView(columns), ...over });

describe('applyView', () => {
	it('filters, searches and sorts in one pass', () => {
		const result = applyView(rows, columns, view({ query: 'a', sortKey: 'tokens', sortDir: 'asc' }));
		expect(result.rows.map((r) => r.id)).toEqual(['r3', 'r1', 'r2']);
	});
	it('keeps missing values at the bottom regardless of direction', () => {
		const asc = applyView(rows, columns, view({ sortKey: 'tokens', sortDir: 'asc' }));
		expect(asc.rows.at(-1)!.id).toBe('r2');
		const desc = applyView(rows, columns, view({ sortKey: 'tokens', sortDir: 'desc' }));
		expect(desc.rows.at(-1)!.id).toBe('r2');
	});
	it('pages with a clamped page number', () => {
		const result = applyView(rows, columns, view({ page: 99, pageSize: 2 }));
		expect(result.pageRows).toHaveLength(1);
		expect(result.pageCount).toBe(2);
	});
	it('drops hidden columns from the visible set but keeps them searchable', () => {
		const result = applyView(rows, columns, view({ hiddenColumns: ['name'], query: 'Alpha' }));
		expect(result.visibleColumns.map((c) => c.key)).toEqual(['tokens']);
		expect(result.rows).toHaveLength(1);
	});
	it('honours filter selections', () => {
		const result = applyView(rows, columns, view({ filters: { tokens: '5' } }));
		expect(result.rows.map((r) => r.id)).toEqual(['r3']);
	});
});

describe('helpers', () => {
	it('matches query case-insensitively over any column', () => {
		expect(matchesQuery(rows[0], columns, 'ALPHA')).toBe(true);
		expect(matchesQuery(rows[0], columns, 'nope')).toBe(false);
	});
	it('compares numbers numerically and strings naturally', () => {
		expect(compareBy(columns, 'tokens', 'asc')(rows[0], rows[2])).toBeGreaterThan(0);
		expect(compareBy(columns, 'name', 'asc')(rows[0], rows[2])).toBeLessThan(0);
	});
	it('toggles columns and selection', () => {
		expect(toggleColumn(view(), 'name').hiddenColumns).toEqual(['name']);
		expect(toggleSelection(['a'], 'b')).toEqual(['a', 'b']);
		expect(toggleSelection(['a', 'b'], 'a')).toEqual(['b']);
		expect(toggleAllOnPage([], ['a', 'b'])).toEqual(['a', 'b']);
		expect(toggleAllOnPage(['a', 'b', 'c'], ['a', 'b'])).toEqual(['c']);
	});
});
