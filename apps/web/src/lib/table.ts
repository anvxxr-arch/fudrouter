/**
 * Table state math — the engine behind `<DataTable>` (PRD §107).
 *
 * Every universal-table requirement (search, sort, filter, paginate, column
 * visibility, selection) is decided here as a pure function of `(rows, view)`,
 * so the component only renders the result and the rules can be tested without
 * a browser. The component owns presentation; this file owns behaviour.
 */

export type SortDir = 'asc' | 'desc';

export interface Column<T> {
	key: string;
	label: string;
	/** The cell value. Doubles as the search haystack and the sort key. */
	value: (row: T) => string | number | null | undefined;
	sortable?: boolean;
	/** Start hidden (the user can re-enable it in the column menu). */
	hidden?: boolean;
	align?: 'start' | 'end';
}

export interface FilterSpec {
	key: string;
	label: string;
	options: { value: string; label: string }[];
}

export interface TableView {
	query: string;
	sortKey: string | null;
	sortDir: SortDir;
	/** filter key -> selected option value ('' = all). */
	filters: Record<string, string>;
	/** Column keys the user turned OFF. */
	hiddenColumns: string[];
	page: number;
	pageSize: number;
}

export interface TableResult<T> {
	rows: T[];
	/** Rows on the current page, after filtering and sorting. */
	pageRows: T[];
	total: number;
	pageCount: number;
	visibleColumns: Column<T>[];
}

export function defaultView<T>(columns: Column<T>[], pageSize = 25): TableView {
	return {
		query: '',
		sortKey: null,
		sortDir: 'asc',
		filters: {},
		hiddenColumns: columns.filter((c) => c.hidden).map((c) => c.key),
		page: 1,
		pageSize
	};
}

/** Case-insensitive substring test over every visible column's stringified value. */
export function matchesQuery<T>(row: T, columns: Column<T>[], query: string): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return true;
	return columns.some((c) => String(c.value(row) ?? '').toLowerCase().includes(q));
}

/**
 * Sort comparison over the column's value. Numbers compare numerically,
 * everything else as a locale string; empty values always sink to the bottom so
 * a missing field never leads the table.
 */
export function compareBy<T>(columns: Column<T>[], sortKey: string, dir: SortDir) {
	const col = columns.find((c) => c.key === sortKey);
	const sign = dir === 'asc' ? 1 : -1;
	return (a: T, b: T): number => {
		if (!col) return 0;
		const va = col.value(a);
		const vb = col.value(b);
		if (va == null || va === '') return vb == null || vb === '' ? 0 : 1;
		if (vb == null || vb === '') return -1;
		if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * sign;
		return String(va).localeCompare(String(vb), undefined, { numeric: true }) * sign;
	};
}

/**
 * The whole pipeline: filter → search → sort → page.
 *
 * `page` is clamped against the post-filter row count, because a filter change
 * that leaves the page number pointing past the end would render an empty page
 * while rows exist — the classic "it filtered everything away" bug report.
 */
export function applyView<T>(rows: T[], columns: Column<T>[], view: TableView): TableResult<T> {
	const visibleColumns = columns.filter((c) => !view.hiddenColumns.includes(c.key));
	let out = rows.filter((row) => {
		for (const [key, value] of Object.entries(view.filters)) {
			if (!value) continue;
			const col = columns.find((c) => c.key === key);
			if (col && String(col.value(row) ?? '') !== value) return false;
		}
		return true;
	});
	out = out.filter((row) => matchesQuery(row, columns, view.query));
	if (view.sortKey) out = [...out].sort(compareBy(columns, view.sortKey, view.sortDir));

	const pageSize = Math.max(1, view.pageSize);
	const total = out.length;
	const pageCount = Math.max(1, Math.ceil(total / pageSize));
	const page = Math.min(Math.max(1, view.page), pageCount);
	return {
		rows: out,
		pageRows: out.slice((page - 1) * pageSize, page * pageSize),
		total,
		pageCount,
		visibleColumns
	};
}

/** Toggle one column's visibility, keeping the state list minimal. */
export function toggleColumn(view: TableView, key: string): TableView {
	const hidden = view.hiddenColumns.includes(key)
		? view.hiddenColumns.filter((k) => k !== key)
		: [...view.hiddenColumns, key];
	return { ...view, hiddenColumns: hidden };
}

/**
 * Selection bookkeeping for bulk actions. `keyOf` gives a stable row id, so a
 * selection survives sorting and paging — the user picks across pages and only
 * acts on what they picked.
 */
export function toggleSelection(selected: string[], id: string): string[] {
	return selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id];
}

export function toggleAllOnPage(selected: string[], pageIds: string[]): string[] {
	const allSelected = pageIds.every((id) => selected.includes(id));
	return allSelected
		? selected.filter((id) => !pageIds.includes(id))
		: [...new Set([...selected, ...pageIds])];
}
