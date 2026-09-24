import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { requiredCap } from './roles';
import { titleFor } from '../titles';

// The member surface once shipped gated exactly once — by the hook — with every
// action on it running without a check of its own, so editing ROUTE_CAPS alone was
// enough to open the area. Worse, three of those gates sat in the working tree and
// never reached the commit, because a `git mv` had already staged those files.
// Nothing failed; it just was not defended the way /admin is.
//
// These tests make that class of rot impossible, on BOTH surfaces:
//   - every +page.server.ts must call the SAME capability the route table demands
//     for its path (so a file cannot quietly gate on something weaker)
//   - every handler in it — load and each action — must carry its own call
//   - and a member page must have a title of its own and a link in the nav, so it
//     cannot ship unreachable or unnamed
//
// Handlers are matched by SHAPE, not by the substring `async (`: a load is a
// column-zero `export const load`, an action is a one-tab `name: async ({ … })`.
// Counting `async (` also matches callbacks inside an action body — the provider
// page's `Promise.all(creds.map(async ({ label, index }) => …))` would demand a
// gate that has no business existing. Measured across all 15 route files, this
// pattern gives handlers === gates exactly, so that is the assertion.

const routes = new URL('../../routes/', import.meta.url);
const LOAD = /^export const load: [\w.<>]+ = async \(\{[^}]*\}\)/gm;
const ACTION = /^\t[a-zA-Z]\w*: async \(\{[^}]*\}\)/gm;
const handlersIn = (src: string) =>
	(src.match(LOAD)?.length ?? 0) + (src.match(ACTION)?.length ?? 0);
const gatesIn = (src: string) => src.match(/requireCap\(locals, '[a-z.]+'\)/g)?.length ?? 0;
const surfaces = [
	{ dir: '(app)/', label: 'member' },
	{ dir: 'admin/', label: 'admin' }
] as const;

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
	const rel = file.slice(routes.pathname.length).replace(/\/(\+page|\+layout)\.\w+$/, '');
	const segments = rel.split('/').filter((s) => s && !(s.startsWith('(') && s.endsWith(')')));
	return '/' + segments.join('/');
}

const surfacesWithFiles = surfaces.map((s) => ({
	...s,
	pages: filesNamed(routes.pathname + s.dir, ['+page.server.ts']),
	layouts: filesNamed(routes.pathname + s.dir, ['+layout.server.ts'])
}));

describe('every surface is gated in code, on the capability the route table names', () => {
	it.each(surfacesWithFiles.map((s) => [s.label, s] as const))(
		'%s: finds the server files',
		(_label, s) => {
			expect(s.pages.length, `no +page.server.ts under ${s.dir}`).toBeGreaterThan(2);
			expect(s.layouts.length, `no +layout.server.ts under ${s.dir}`).toBeGreaterThan(0);
		}
	);

	it.each(
		surfacesWithFiles.flatMap((s) => s.pages.map((f) => [routePath(f), f, s.label] as const))
	)('%s calls requireCap on the cap its route needs', (route, file, label) => {
		const cap = requiredCap(route);
		expect(cap, `${route} has no entry in ROUTE_CAPS, so nothing gates it`).not.toBeNull();
		const src = readFileSync(file as string, 'utf8');
		expect(src, `${file} (${label}) must call requireCap(locals, '${cap}')`).toContain(
			`requireCap(locals, '${cap}')`
		);
		// And it may not ALSO gate on something else: one stray weaker (or stronger)
		// capability in a handler is exactly the drift that hides a missing check.
		const named = new Set([...src.matchAll(/requireCap\(locals, '([a-z.]+)'\)/g)].map((m) => m[1]));
		expect([...named], `${file} names caps other than '${cap}'`).toEqual([cap as string]);
	});

	it.each(surfacesWithFiles.flatMap((s) => s.layouts.map((f) => [routePath(f), f, s] as const)))(
		'%s/layout gates every handler',
		(_route, file, s) => {
			const src = readFileSync(file as string, 'utf8');
			const handlers = handlersIn(src);
			const gates = gatesIn(src);
			expect(handlers, `no handlers found in ${file}`).toBeGreaterThan(0);
			expect(gates, `${file} (${s.label}): ${handlers} handler(s), ${gates} gate(s)`).toBe(
				handlers
			);
		}
	);

	it.each(surfacesWithFiles.flatMap((s) => s.pages.map((f) => [routePath(f), f] as const)))(
		'%s gates every handler, not just the load',
		(route, file) => {
			const src = readFileSync(file as string, 'utf8');
			const handlers = handlersIn(src);
			const gates = gatesIn(src);
			expect(handlers, `no handlers found in ${file}`).toBeGreaterThan(0);
			expect(gates, `${route}: ${handlers} handler(s) but ${gates} requireCap call(s)`).toBe(
				handlers
			);
		}
	);
});

describe('the member pages are reachable and named', () => {
	const appRoutes = new URL('../../routes/(app)/', import.meta.url);
	const layout = readFileSync(new URL('+layout.svelte', appRoutes), 'utf8');
	const pages = filesNamed(appRoutes.pathname, ['+page.svelte']).map(routePath);

	it('finds the member pages', () => {
		expect(pages).toContain('/dashboard');
		expect(pages).toContain('/dashboard/keys');
		expect(pages).toContain('/dashboard/billing');
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
