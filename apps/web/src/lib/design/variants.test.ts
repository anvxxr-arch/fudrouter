import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	ALERT_TONES,
	BADGE_TONES,
	BUTTON_VARIANTS,
	CONTROL_SIZES,
	STAT_TONES,
	TONES,
	buttonClass,
	toneClass
} from './variants';

// The design system's failure mode is not a broken page — it is two components
// that quietly disagree. That is exactly what had happened: `Button` grew a
// `danger` variant `ButtonLink` never got, `Badge` had a `neutral` tone `Alert`
// lacked, and the button shell was written out twice. Nothing failed; it just
// rotted.
//
// These tests make that class of rot impossible: every enumerated member must have
// a matching rule in components.css, and no atom may re-declare a shared one.

const css = readFileSync(new URL('./components.css', import.meta.url), 'utf8');
const tokens = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

const uiDir = new URL('../ui/', import.meta.url);
const atomNames = readdirSync(uiDir).filter((f) => f.endsWith('.svelte'));
const atoms = new Map(atomNames.map((f) => [f, readFileSync(new URL(f, uiDir), 'utf8')] as const));

/** Every class selector components.css defines, as bare names. */
const definedClasses = new Set([...css.matchAll(/^\.([a-z0-9-]+)/gim)].map((m) => m[1]));

describe('variants ↔ stylesheet', () => {
	it('has a rule for every button variant', () => {
		for (const v of BUTTON_VARIANTS) {
			expect(definedClasses, `no .fr-btn--${v} in components.css`).toContain(`fr-btn--${v}`);
		}
	});

	it('has a rule for every control size, on both buttons and controls', () => {
		for (const s of CONTROL_SIZES) {
			expect(definedClasses, `no .fr-btn--${s}`).toContain(`fr-btn--${s}`);
			expect(definedClasses, `no .fr-control--${s}`).toContain(`fr-control--${s}`);
		}
	});

	it('has a tone rule for every tone, and each one sets --_tone', () => {
		for (const t of TONES) {
			expect(definedClasses, `no .fr-tone-${t} in components.css`).toContain(`fr-tone-${t}`);
			const rule = new RegExp(`\\.fr-tone-${t}\\s*\\{[^}]*\\}`).exec(css);
			expect(rule, `.fr-tone-${t} does not set --_tone`).not.toBeNull();
			expect(rule![0]).toMatch(/--_tone\s*:/);
		}
	});

	it('only lists tones that exist in the tone table', () => {
		// A subset list may be narrower than TONES, but never wider — a tone with no
		// CSS rule renders an unstyled component.
		for (const [name, list] of [
			['BADGE_TONES', BADGE_TONES],
			['ALERT_TONES', ALERT_TONES],
			['STAT_TONES', STAT_TONES]
		] as const) {
			for (const t of list) {
				expect(TONES, `${name} contains "${t}", which TONES does not`).toContain(t);
			}
		}
	});

	it('keeps every class helper in step with the stylesheet', () => {
		for (const v of BUTTON_VARIANTS) {
			for (const s of CONTROL_SIZES) {
				for (const cls of buttonClass(v, s).split(' ')) {
					expect(definedClasses, `buttonClass emitted an undefined class: ${cls}`).toContain(cls);
				}
			}
		}
		for (const t of TONES) {
			expect(definedClasses, `toneClass emitted an undefined class: ${toneClass(t)}`).toContain(
				toneClass(t)
			);
		}
	});
});

describe('no atom re-declares a shared style', () => {
	/**
	 * Declarations that belong to a shared shell in components.css and nowhere else.
	 *
	 * Only *composite* shell geometry is listed. Referencing a token is not
	 * duplication — `Badge` using `--fr-radius-pill` is a component consuming the
	 * design system, which is the point of having tokens at all.
	 */
	const shared = [
		'--fr-control-h-md',
		'--fr-control-h-sm',
		'--fr-control-h-lg',
		'letter-spacing: 0.04em'
	];

	it.each(atomNames)('%s does not duplicate the shared shell', (name) => {
		const src = atoms.get(name)!;
		// Only the <style> block matters; a class name in markup is the point.
		const style = /<style[^>]*>([\s\S]*?)<\/style>/.exec(src)?.[1] ?? '';
		for (const decl of shared) {
			expect(style, `${name} re-declares "${decl}" — that belongs in components.css`).not.toContain(
				decl
			);
		}
	});

	it.each(atomNames)('%s declares no enumerated prop locally', (name) => {
		// `type Variant = …` / `type Tone = …` is how the two copies drifted apart.
		const src = atoms.get(name)!;
		expect(
			src,
			`${name} declares its own Variant/Tone union — import it from $lib/design/variants`
		).not.toMatch(/type\s+(Variant|Tone|Size)\s*=/);
	});
});

describe('atoms are composable', () => {
	// `{...rest}` placed after a literal `class` OVERWRITES it, so a caller writing
	// `<Button class="mt-4">` silently lost `fr-btn fr-btn--secondary`. The fix is to
	// destructure `class` out of rest; this asserts it is never re-introduced.
	const spreading = atomNames.filter((n) => atoms.get(n)!.includes('{...rest}'));

	it('covers the atoms that spread props', () => {
		expect(spreading.length).toBeGreaterThan(5);
	});

	it.each(spreading)('%s pulls `class` out of rest before spreading', (name) => {
		const src = atoms.get(name)!;
		expect(src, `${name} spreads {...rest} but never destructures \`class\``).toMatch(
			/class:\s*className/
		);
	});
});

describe('shared class names', () => {
	it('uses the fr- prefix so nothing collides with a Tailwind utility', () => {
		for (const cls of definedClasses) {
			expect(cls, `.${cls} is not fr-prefixed`).toMatch(/^fr-/);
		}
	});

	it('only references control-height tokens that tokens.css declares', () => {
		const declared = new Set([...tokens.matchAll(/--fr-control-h-[a-z0-9]+/g)].map((m) => m[0]));
		const used = new Set([...css.matchAll(/--fr-control-h-[a-z0-9]+/g)].map((m) => m[0]));
		expect(used.size).toBeGreaterThan(0);
		for (const u of used) {
			expect(declared, `${u} is used in components.css but not declared in tokens.css`).toContain(
				u
			);
		}
	});
});

describe('DESIGN.md describes what is actually built', () => {
	// The linter checks the spec against itself, so a component entry can claim a
	// colour the implementation never uses and still lint clean. That had happened:
	// the spec declared `button-danger` as a filled `danger` background with
	// `onPrimary` text, while the shipped button was an outlined `surfaceRaised`
	// one with `danger` text. Nothing failed, because nothing compared the two.
	const spec = readFileSync(new URL('../../../../../DESIGN.md', import.meta.url), 'utf8');

	/** `surfaceRaised` -> `surface-raised`, the token naming rule. */
	const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

	/** The `button-<variant>:` entry's declared colours, as CSS token names. */
	const declaredColours = (variant: string) => {
		const block = new RegExp(`^ {2}button-${variant}:\\s*\\n((?: {4}\\S.*\\n)*)`, 'm').exec(
			spec
		)?.[1];
		if (!block) return null;
		const ref = (key: string) => {
			// A component colour is either a token ref ("{colors.primary}") or a raw
			// CSS value ("transparent", "currentColor"). The test resolves token refs
			// to their CSS custom-property name; raw values pass through unchanged.
			const m = new RegExp(`^\\s+${key}:\\s*"([^"]+)"`, 'm').exec(block);
			if (!m) return null;
			const token = /^\{colors\.([A-Za-z]+)\}$/.exec(m[1]);
			return token ? kebab(token[1]) : m[1];
		};
		const bg = ref('backgroundColor');
		const fg = ref('textColor');
		return bg && fg ? { bg, fg } : null;
	};

	/**
	 * What `.fr-btn--<variant>` resolves `--_bg` / `--_fg` to, as token names.
	 *
	 * A variant only overrides what it needs: `secondary` sets `--_bg` and
	 * `--_bd` but leaves `--_fg` to the base `.fr-btn`, while `ghost` sets
	 * `--_fg` alone. So the resolved colours are the base's with the variant
	 * layered on top — not just whatever the variant block literally contains.
	 *
	 * A value can be either a `var(--fr-...)` token ref (which we read by name)
	 * or a raw CSS value like `transparent` (which we read literally). Token refs
	 * win: `ghost` sets `--_fg` to `var(--fr-info)`, so we report `info`; the base
	 * sets `--_bg` to `transparent`, so we report `transparent`.
	 */
	const implementedColours = (variant: string) => {
		const base = new RegExp(`\\.fr-btn\\s*\\{([^}]*)\\}`).exec(css)?.[1];
		const override = new RegExp(`\\.fr-btn--${variant}\\s*\\{([^}]*)\\}`).exec(css)?.[1];
		if (!base) return null;
		const get = (prop: string, block: string) => {
			const varMatch = new RegExp(`${prop}:\\s*var\\(--fr-([a-z0-9-]+)\\)`).exec(block);
			if (varMatch) return varMatch[1];
			const rawMatch = new RegExp(`${prop}:\\s*([^;]+);`).exec(block);
			return rawMatch ? rawMatch[1].trim() : null;
		};
		const bg = get('--_bg', override ?? '') ?? get('--_bg', base);
		const fg = get('--_fg', override ?? '') ?? get('--_fg', base);
		return bg && fg ? { bg, fg } : null;
	};

	it.each([...BUTTON_VARIANTS])('matches the spec for button-%s', (variant) => {
		const declared = declaredColours(variant);
		const built = implementedColours(variant);
		expect(declared, `DESIGN.md has no button-${variant} component entry`).not.toBeNull();
		expect(built, `components.css has no .fr-btn--${variant} colour rule`).not.toBeNull();
		expect(built, `button-${variant}: the spec and the stylesheet disagree`).toEqual(declared);
	});
});
