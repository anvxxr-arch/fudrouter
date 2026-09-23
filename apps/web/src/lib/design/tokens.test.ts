import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// DESIGN.md is the normative spec; tokens.css is its implementation. This test
// fails the build the moment the two drift apart — a design system nobody can
// silently desync from.
const spec = readFileSync(new URL('../../../../../DESIGN.md', import.meta.url), 'utf8');
const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');
const fonts = readFileSync(new URL('./fonts.css', import.meta.url), 'utf8');

const hexes = (text: string) =>
	new Set((text.match(/#[0-9a-fA-F]{6}\b/g) ?? []).map((h) => h.toLowerCase()));

describe('design tokens', () => {
	it('implements every colour declared in DESIGN.md', () => {
		const declared = [...hexes(spec)];
		expect(declared.length).toBeGreaterThan(5);
		const missing = declared.filter((h) => !css.toLowerCase().includes(h));
		expect(missing, `missing from tokens.css: ${missing.join(', ')}`).toEqual([]);
	});

	it('declares no colour that DESIGN.md does not define', () => {
		const declared = hexes(spec);
		const extra = [...hexes(css)].filter((h) => !declared.has(h));
		expect(extra, `undocumented in DESIGN.md: ${extra.join(', ')}`).toEqual([]);
	});

	it('exposes the semantic scales every surface relies on', () => {
		for (const token of [
			'--fr-primary',
			'--fr-success',
			'--fr-warning',
			'--fr-danger',
			'--fr-info',
			'--fr-text-muted',
			'--fr-space-md',
			'--fr-radius-lg',
			'--fr-control-h-md',
			'--fr-focus'
		]) {
			expect(css).toContain(token);
		}
	});
});

describe('numeric scales', () => {
	/**
	 * DESIGN.md is normative for the *scales* too, not only for colour and type.
	 * Radius and spacing were unguarded, so a change to either could land in
	 * tokens.css without ever touching the spec the rest of the system is written
	 * against. `pill` is the one step whose spec value (999px) is a deliberate
	 * stand-in for "fully rounded", so it is compared as a unit only.
	 */
	const yamlScale = (section: string) => {
		const body = new RegExp(`^${section}:\\s*\\n((?:\\s+\\S.*\\n)*)`, 'm').exec(spec)?.[1] ?? '';
		return new Map(
			[...body.matchAll(/^\s+([a-z0-9-]+):\s*"?([\d.]+)(px|rem)?"?\s*$/gm)].map((m) => [
				m[1],
				m[3] ? `${m[2]}${m[3]}` : m[2]
			])
		);
	};

	it('implements the radius scale DESIGN.md declares', () => {
		const declared = yamlScale('rounded');
		expect(declared.size, 'no rounded scale found in DESIGN.md').toBeGreaterThan(0);
		for (const [name, value] of declared) {
			const actual = css.match(new RegExp(`--fr-radius-${name}:\\s*([^;]+);`))?.[1];
			expect(actual, `tokens.css has no --fr-radius-${name}`).toBeDefined();
			if (name === 'pill') {
				// The spec says 999px; any large value that clamps to a pill is fine.
				expect(parseFloat(actual!)).toBeGreaterThanOrEqual(999);
			} else {
				expect(actual!.trim(), `--fr-radius-${name}`).toBe(value);
			}
		}
	});

	it('implements the spacing scale DESIGN.md declares', () => {
		const declared = yamlScale('spacing');
		expect(declared.size, 'no spacing scale found in DESIGN.md').toBeGreaterThan(0);
		for (const [name, value] of declared) {
			const actual = css.match(new RegExp(`--fr-space-${name}:\\s*([^;]+);`))?.[1];
			expect(actual?.trim(), `--fr-space-${name}`).toBe(value);
		}
	});

	it('keeps both scales strictly increasing', () => {
		for (const [section, prefix] of [
			['rounded', '--fr-radius-'],
			['spacing', '--fr-space-']
		] as const) {
			const values = [...yamlScale(section).values()].map((v) =>
				v.endsWith('rem') ? parseFloat(v) * 16 : parseFloat(v)
			);
			for (let i = 1; i < values.length; i++) {
				expect(values[i], `${section} scale is not increasing`).toBeGreaterThan(values[i - 1]);
			}
			expect(css).toContain(prefix);
		}
	});
});

describe('typography', () => {
	/** The first family in a CSS font stack, unquoted. */
	const firstFamily = (stack: string) =>
		stack
			.split(',')[0]
			.trim()
			.replace(/^['"]|['"]$/g, '');
	/**
	 * CSS with comments stripped. A comment can contain anything — the one in
	 * fonts.css quotes `font-weight: 200 800` — and a naive declaration regex will
	 * happily match inside it.
	 */
	const uncommented = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '');
	const fontsCss = uncommented(fonts);

	it('uses the UI font family DESIGN.md declares', () => {
		// DESIGN.md also declares a `mono` scale, which is deliberately a different
		// family — only the non-mono scales must agree on one UI face.
		const declared = [...spec.matchAll(/fontFamily:\s*"([^"]+)"/g)]
			.map((m) => firstFamily(m[1]))
			.filter((f) => !f.toLowerCase().includes('mono'));
		expect(declared.length).toBeGreaterThan(0);
		const unique = [...new Set(declared)];
		expect(unique.length, `scales disagree on the UI face: ${unique.join(' vs ')}`).toBe(1);

		const token = css.match(/--fr-font-ui:\s*([^;]+);/)?.[1] ?? '';
		expect(token, 'tokens.css declares no --fr-font-ui').not.toBe('');
		expect(
			firstFamily(token),
			`DESIGN.md says "${unique[0]}" but --fr-font-ui starts with "${firstFamily(token)}"`
		).toBe(unique[0]);
	});

	it('loads the family it names via @font-face', () => {
		// A family named in the stack but never declared is silently dropped to the
		// system fallback — which is exactly how "Inter" behaved for months.
		const uiFamily = firstFamily(css.match(/--fr-font-ui:\s*([^;]+);/)![1]);
		const declared = [...fontsCss.matchAll(/font-family:\s*'([^']+)'/g)].map((m) => m[1]);
		expect(declared, `no @font-face declares "${uiFamily}"`).toContain(uiFamily);
	});

	it('ships a file for every @font-face src', () => {
		const srcs = [...fontsCss.matchAll(/url\('([^']+)'\)/g)].map((m) => m[1]);
		expect(srcs.length).toBeGreaterThan(0);
		for (const src of srcs) {
			expect(src.startsWith('/fonts/'), `unexpected font path: ${src}`).toBe(true);
			const onDisk = new URL(`../../../static${src}`, import.meta.url);
			expect(existsSync(onDisk), `@font-face points at a missing file: ${src}`).toBe(true);
		}
	});

	it('declares a variable weight range, not static cuts', () => {
		// One variable file per subset is the point; per-weight files would mean the
		// browser fetches several and the ranges would be single values.
		const weights = [...fontsCss.matchAll(/font-weight:\s*([^;]+);/g)].map((m) => m[1].trim());
		expect(weights.length).toBeGreaterThan(0);
		for (const w of weights) {
			expect(w, `static weight "${w}" — expected a range like "200 800"`).toMatch(/^\d+\s+\d+$/);
		}
	});
});

describe('type scale', () => {
	const toPx = (v: string) => {
		const m = /^(-?[\d.]+)(rem|em|px)$/.exec(v.trim());
		if (!m) throw new Error(`unparsable dimension: ${v}`);
		return Number(m[1]) * (m[2] === 'px' ? 1 : 16);
	};
	const sizeOf = (name: string) => {
		const value = css.match(new RegExp(`--fr-text-${name}:\\s*([^;]+);`))?.[1];
		if (!value) throw new Error(`tokens.css declares no --fr-text-${name}`);
		// A fluid heading is judged by its floor: the size at the smallest viewport.
		return toPx((/^clamp\(([^,]+),/.exec(value.trim())?.[1] ?? value).trim());
	};

	/**
	 * The fluid table in DESIGN.md's prose. `clamp()` and `vw` are not valid
	 * dimensions in the spec frontmatter, so the expressions live in the body —
	 * and this is what keeps the body honest against tokens.css.
	 */
	const fluidTable = [
		...spec.matchAll(
			/^\|\s*`([a-z0-9-]+)`\s*\|\s*([^|]+?)\s*\|\s*`(clamp\([^`]+\))`\s*\|\s*([^|]+?)\s*\|\s*$/gm
		)
	].map((m) => ({ name: m[1], floor: m[2].trim(), expr: m[3], ceiling: m[4].trim() }));

	/** The frontmatter's `typography:` block: scale name → declared fontSize. */
	const yamlFloor = (() => {
		const out: Record<string, string> = {};
		let scale: string | null = null;
		for (const line of spec.slice(0, spec.indexOf('\n---', 3)).split('\n')) {
			const key = /^ {2}([a-z0-9-]+):\s*$/.exec(line);
			if (key) {
				scale = key[1];
				continue;
			}
			const size = /^ {4}fontSize:\s*(.+)$/.exec(line);
			if (size && scale) out[scale] = size[1].trim().replace(/^['"]|['"]$/g, '');
		}
		return out;
	})();

	it('implements every fluid heading exactly as DESIGN.md documents it', () => {
		expect(fluidTable.length, 'no fluid-heading table found in DESIGN.md').toBeGreaterThan(0);
		for (const { name, expr } of fluidTable) {
			expect(css, `tokens.css is missing --fr-text-${name}: ${expr}`).toContain(
				`--fr-text-${name}: ${expr};`
			);
		}
	});

	it('records each fluid heading floor in the frontmatter', () => {
		// The YAML cannot hold a clamp(), so it holds the floor instead. If the two
		// disagree, the exporter would emit a size no page actually renders.
		for (const { name, floor } of fluidTable) {
			expect(yamlFloor[name], `frontmatter fontSize for "${name}"`).toBe(floor);
		}
	});

	it('keeps every fluid heading between its own bounds', () => {
		for (const { name, floor, expr, ceiling } of fluidTable) {
			const parts = /^clamp\(([^,]+),\s*([^,]+),\s*([^)]+)\)$/.exec(expr);
			expect(parts, `unparsable clamp for "${name}": ${expr}`).not.toBeNull();
			const [, min, preferred, max] = parts!;
			expect(min.trim(), `${name} min`).toBe(floor);
			expect(max.trim(), `${name} max`).toBe(ceiling);
			expect(preferred, `${name} must actually scale`).toMatch(/vw/);
			expect(toPx(ceiling), `${name} ceiling must exceed its floor`).toBeGreaterThan(toPx(floor));
		}
	});

	it('holds static text still — no viewport unit in the text steps', () => {
		// Body copy that reflows because someone resized a window is hostile to read.
		for (const name of ['caption', 'sm', 'base', 'lg']) {
			const value = css.match(new RegExp(`--fr-text-${name}:\\s*([^;]+);`))?.[1] ?? '';
			expect(value, `--fr-text-${name} must not scale with the viewport`).not.toMatch(
				/clamp|vw|vh/
			);
		}
	});

	it('keeps the ladder monotonic — a bigger heading is never smaller', () => {
		const ladder = [
			'display-xl',
			'display',
			'h1',
			'h2',
			'h3',
			'h4',
			'h5',
			'h6',
			'lg',
			'base',
			'sm',
			'caption'
		];
		for (let i = 1; i < ladder.length; i++) {
			const above = sizeOf(ladder[i - 1]);
			const below = sizeOf(ladder[i]);
			expect(
				above,
				`--fr-text-${ladder[i - 1]} (${above}px) must not be smaller than --fr-text-${ladder[i]} (${below}px)`
			).toBeGreaterThanOrEqual(below);
		}
	});

	it('maps heading elements onto the ladder instead of raw values', () => {
		for (const el of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
			const rule = new RegExp(
				`^${el}\\s*\\{[^}]*font-size:\\s*var\\((--fr-text-[a-z0-9-]+)\\)`,
				'm'
			).exec(css);
			expect(rule, `${el} takes its font-size from nothing in the scale`).not.toBeNull();
			expect(css, `${el} references an undefined token`).toContain(`${rule![1]}:`);
		}
	});

	it('declares exactly the ladder DESIGN.md defines — no stragglers', () => {
		// `muted` is the text *colour*, not a size; everything else must be a step.
		const declared = [...css.matchAll(/--fr-text-([a-z0-9-]+):/g)].map((m) => m[1]).sort();
		expect(declared).toEqual(
			[
				'base',
				'caption',
				'display',
				'display-xl',
				'h1',
				'h2',
				'h3',
				'h4',
				'h5',
				'h6',
				'lg',
				'muted',
				'sm'
			].sort()
		);
	});
});

describe('optical sizing', () => {
	// The frontmatter records line-height and tracking per scale; the CSS carries
	// them as tokens. Without this guard the page renders different leading than
	// the spec declares — the exact drift the design system exists to prevent.
	const yamlType = (() => {
		const out: Record<string, { lineHeight?: string; letterSpacing?: string }> = {};
		let scale: string | null = null;
		for (const line of spec.slice(0, spec.indexOf('\n---', 3)).split('\n')) {
			const key = /^ {2}([a-z0-9-]+):\s*$/.exec(line);
			if (key) {
				scale = key[1];
				out[scale] = {};
				continue;
			}
			const prop = /^ {4}(lineHeight|letterSpacing):\s*(.+)$/.exec(line);
			if (prop && scale) {
				const entry = (out[scale] ??= {});
				entry[prop[1] as 'lineHeight' | 'letterSpacing'] = prop[2]
					.trim()
					.replace(/^['"]|['"]$/g, '');
			}
		}
		return out;
	})();

	const token = (name: string) => css.match(new RegExp(`--fr-${name}:\\s*([^;]+);`))?.[1]?.trim();

	it('implements the display and body leading DESIGN.md declares', () => {
		expect(token('display-xl-lh'), '--fr-display-xl-lh').toBe(yamlType['display-xl'].lineHeight);
		expect(token('display-lh'), '--fr-display-lh').toBe(yamlType['display'].lineHeight);
		expect(token('body-lh'), '--fr-body-lh').toBe(yamlType['base'].lineHeight);
		expect(token('display-tracking'), '--fr-display-tracking').toBe(
			yamlType['display-xl'].letterSpacing
		);
		expect(token('body-tracking'), '--fr-body-tracking').toBe(yamlType['base'].letterSpacing);
	});

	it('gives lg and base the same body leading — one body size, one rhythm', () => {
		expect(yamlType['lg'].lineHeight).toBe(yamlType['base'].lineHeight);
		expect(yamlType['lg'].letterSpacing).toBe(yamlType['base'].letterSpacing);
	});

	it('applies the body leading to the document, not just the token', () => {
		const bodyRule = /body\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
		expect(bodyRule).toContain('line-height: var(--fr-body-lh)');
		expect(bodyRule).toContain('letter-spacing: var(--fr-body-tracking)');
	});
});
