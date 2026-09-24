import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { titleFor } from '../titles';

// The member surface shipped gated exactly once — by the hook — and every action on
// it ran without a check of its own, so editing ROUTE_CAPS alone was enough to open
// the whole area. Nothing failed; it just was not defended twice the way /admin is.
//
// These tests make that class of rot impossible: the second gate has to be in the
// file, once per load and once per action, for every route under `(app)`. They also
// pin the two quieter failures — a member page with no title of its own (the tab
// shows the parent's name, or the bare site name) and a page nothing links to.

const appRoutes = new URL('../../routes/(app)/', import.meta.url);

function filesNamed(dir: string, names: string[]): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) out.push(...filesNamed(path, names));
		else if (names.includes(entry)) out.push(path);
	}
	return out;
}

/** `/` + the path with route-group segments (parenthesised) dropped. */
function routePath(file: string): string {
	const rel = file.slice(appRoutes.pathname.length).replace(/\/(\+page|\+layout)\.\w+$/, '');
	const segments = rel.split('/').filter((s) => s && !(s.startsWith('(') && s.endsWith(')')));
	return '/' + segments.join('/');
}

const layout = readFileSync(new URL('+layout.svelte', appRoutes), 'utf8');

describe('the member surface is gated twice', () => {
	const serverFiles = filesNamed(appRoutes.pathname, ['+page.server.ts', '+layout.server.ts']);

	it('covers every server file under (app)', () => {
		expect(serverFiles.length).toBeGreaterThanOrEqual(5);
	});

	it.each(serverFiles.map((f) => [routePath(f) + '/' + f.split('/').pop(), f] as const))(
		'%s calls requireCap',
		(_label, file) => {
			const src = readFileSync(file as string, 'utf8');
			expect(src, `${file} has no requireCap(locals, 'member')`).toContain(
				"requireCap(locals, 'member')"
			);
		}
	);

	it.each(serverFiles.map((f) => [routePath(f), f] as const))(
		'%s gates every handler, not just the load',
		(_route, file) => {
			const src = readFileSync(file as string, 'utf8');
			const handlers = src.match(/async \(/g)?.length ?? 0;
			const gates = src.match(/requireCap\(locals, 'member'\)/g)?.length ?? 0;
			expect(handlers, `no handlers found in ${file}`).toBeGreaterThan(0);
			expect(gates, `${file}: ${handlers} handler(s) but ${gates} gate(s)`).toBeGreaterThanOrEqual(
				handlers
			);
		}
	);
});

describe('the member surface is reachable and named', () => {
	const pages = filesNamed(appRoutes.pathname, ['+page.svelte']).map(routePath);

	it('finds the member pages', () => {
		expect(pages).toContain('/dashboard');
		expect(pages).toContain('/dashboard/keys');
	});

	it.each(pages)('%s is linked from the member nav', (path) => {
		expect(layout, `${path} is not in the sidebar`).toContain(`href: '${path}'`);
	});

	it.each(pages)('%s has a title of its own, not its parent’s', (path) => {
		const parent = path.slice(0, path.lastIndexOf('/')) || '/';
		expect(titleFor(parent)).not.toBe('fudrouter');
		expect(titleFor(path), `${path} inherits the parent title`).not.toBe(titleFor(parent));
		expect(titleFor(path), `${path} has no title entry`).not.toBe('fudrouter');
	});
});
