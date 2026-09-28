import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
// The global sheets, exactly as `layout.css` loads them. Without them every
// computed style is the browser default and a test would pass while proving
// nothing about our tokens.
import '$lib/design/tokens.css';
import '$lib/design/components.css';
import BorderGlow from './BorderGlow.svelte';
import Counter from './Counter.svelte';

const el = (c: HTMLElement) => c.firstElementChild as HTMLElement;
const style = (n: Element) => getComputedStyle(n);

/** The index of the digit whose top edge sits at the window's top edge. */
const visibleDigit = (place: HTMLElement) => {
	const win = place.getBoundingClientRect();
	const digits = [...place.querySelectorAll<HTMLElement>('.digit')];
	return digits.findIndex((d) => Math.abs(d.getBoundingClientRect().top - win.top) < 1);
};

/** Every digit slot the odometer rendered, in document order. */
const slots = (c: HTMLElement) =>
	[...c.querySelectorAll<HTMLElement>('.place')].map((place) => {
		const roll = place.querySelector<HTMLElement>('.roll') as HTMLElement;
		return {
			current: roll?.getAttribute('data-current'),
			// Which digit is *geometrically* inside the 1em window. This is the
			// only assertion that proves the effect: the offset has to land the
			// right row, and a percentage that resolves against the wrong box
			// (the 1em window instead of the 10em column) still produces a
			// plausible-looking `translateY(-30%)` while showing the wrong digit.
			visible: visibleDigit(place),
			digits: place.querySelectorAll('.digit').length
		};
	});

describe('the odometer counter', () => {
	it('gives every place a full 0-9 stack', () => {
		// The regression this guards: the first port rendered a single `<em>` per
		// place with no digits in it. It compiled, it type-checked, and the
		// odometer had nothing to roll — a number that never moved.
		const { container } = render(Counter, { value: 308 });
		const s = slots(container);
		expect(s.length).toBe(3);
		for (const place of s) expect(place.digits).toBe(10);
	});

	it('lands the right digit in the window, measured from the layout', () => {
		// The resting state has to be in the SSR markup, not written by an effect
		// after hydration — otherwise the first paint shows `000` and the number
		// visibly snaps.
		//
		// The assertion is geometric on purpose. The first port published
		// `--roll: translateY(-30%)` while the stylesheet also wrapped it in
		// `translateY()`, so the value was invalid and the computed transform was
		// `none`; and the column was pinned to the 1em window, so a percentage
		// resolved against the wrong box. Both bugs produced a markup string that
		// looked perfectly correct. Asking which digit actually sits at the
		// window's top edge is the only check neither can survive.
		const { container } = render(Counter, { value: 308 });
		const s = slots(container);
		expect(s.map((x) => x.current)).toEqual(['3', '0', '8']);
		expect(s.map((x) => x.visible)).toEqual([3, 0, 8]);
	});

	it('reads a fractional place as a tenths digit, not a units digit', () => {
		// 9.5 with `places=[1, 0.1]` is two places: units and tenths. Treating
		// 0.1 like 1 would show `9.9` — the same arithmetic, wrong scale.
		const { container } = render(Counter, { value: 9.5, places: [1, 0.1] });
		expect(slots(container).map((s) => s.current)).toEqual(['9', '5']);
	});

	it('survives the float trap in the tenths place', () => {
		// `0.3 / 0.1` is 2.9999999999999996 in IEEE754, so a bare
		// `Math.trunc(magnitude / place)` reports 2 and the counter shows `0.2`
		// for a value of `0.3`. This is not exotic: 67 of the first 201 tenths
		// values hit it, and a price of $0.30 is one of them. Rounding the
		// quotient before truncating is what makes the digit exact.
		const { container } = render(Counter, { value: 0.3, places: [1, 0.1] });
		expect(slots(container).map((s) => s.current)).toEqual(['0', '3']);
	});

	it('handles a two-digit value whose tenths digit needs the same guard', () => {
		// 1.2 -> `1.2 / 0.1` is 11.999999999999998: naive truncation gives 1.
		const { container } = render(Counter, { value: 1.2, places: [1, 0.1] });
		expect(slots(container).map((s) => s.current)).toEqual(['1', '2']);
	});

	it('renders one place for a one-digit value rather than none', () => {
		// `Math.trunc(0).toString().length` is 1, and a zero still needs a digit.
		const { container } = render(Counter, { value: 0 });
		expect(slots(container).map((s) => s.current)).toEqual(['0']);
	});

	it('drives each place from its own node, never a global lookup', () => {
		// Two counters on one page is the normal case (a status strip). The first
		// port resolved nodes with `document.querySelector('[data-place=...]')`,
		// so the second counter animated the first one's digits. The check is
		// geometric, because that is what a cross-instance write would corrupt.
		const { container } = render(Counter, { value: 12 });
		const other = render(Counter, { value: 87 });
		expect(slots(container).map((s) => s.visible)).toEqual([1, 2]);
		expect(slots(other.container).map((s) => s.visible)).toEqual([8, 7]);
	});

	it('shows exactly one digit per place, the rest clipped', () => {
		// The DOM carries all ten glyphs per place — that is how the roll works —
		// so a word count of the served HTML reports ten times the digits. Two
		// separate guarantees keep that off the screen:
		//
		//   1. layout — the offset lands exactly one digit inside the window;
		//   2. painting — `.place` clips the other nine.
		//
		// They need separate assertions. `getBoundingClientRect` ignores
		// `overflow`, so a geometry check alone still passes with the clipping
		// removed, and the reader gets a stack of ten digits.
		const { container } = render(Counter, { value: 308 });
		for (const place of container.querySelectorAll<HTMLElement>('.place')) {
			const win = place.getBoundingClientRect();
			const visible = [...place.querySelectorAll<HTMLElement>('.digit')].filter((d) => {
				const r = d.getBoundingClientRect();
				return r.top < win.bottom - 1 && r.bottom > win.top + 1;
			});
			expect(visible.length, 'digits intersecting the window').toBe(1);
			expect(visible[0].getBoundingClientRect().height).toBeCloseTo(win.height, 1);
			expect(getComputedStyle(place).overflow, 'window clips the column').toBe('hidden');
		}
	});

	it('re-runs its animation when the value changes', async () => {
		// A reduced-motion environment has no roll to observe — the action snaps
		// to the resting offset by design — so the mid-flight assertion only
		// applies when motion is allowed.
		const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

		// The action is parameterised by the *target digit*, so Svelte calls
		// `update` when the digit moves. Parameterising it by `place` instead —
		// which never changes — leaves a live counter that jumps instead of
		// rolling.
		//
		// The resting geometry alone cannot tell those apart: Svelte patches the
		// `--roll` custom property on re-render, so the final digit is right
		// either way. The discriminator is the *inline* `transform`, which only
		// the action writes while it is mid-roll.
		const { container, rerender } = render(Counter, { value: 12 });
		expect(slots(container).map((s) => s.visible)).toEqual([1, 2]);

		await rerender({ value: 87 });
		expect(slots(container).map((s) => s.current)).toEqual(['8', '7']);

		// Mid-flight, the action owns `transform`; the markup never writes it.
		// The roll is driven by `requestAnimationFrame`, so the first frame has
		// to actually run before there is an inline transform to observe —
		// sampling straight after `rerender` races the rAF and is flaky.
		await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
		const midFlight = [...container.querySelectorAll<HTMLElement>('.roll')].map(
			(r) => r.style.transform
		);
		if (!reduced) {
			expect(midFlight.filter(Boolean).length, 'rolls the action is animating').toBeGreaterThan(0);
		}

		// The roll runs for the motion scale's 320ms; when it settles the action
		// removes the inline transform and `--roll` owns the resting offset.
		await new Promise((r) => setTimeout(r, 500));
		expect(slots(container).map((s) => s.visible)).toEqual([8, 7]);
		const settled = [...container.querySelectorAll<HTMLElement>('.roll')].map(
			(r) => r.style.transform
		);
		expect(settled.filter(Boolean), 'inline transforms left behind').toEqual([]);
	});

	it('exposes the value to assistive tech as one number', () => {
		const { container } = render(Counter, { value: 308, label: '308 requests' });
		expect(el(container).getAttribute('aria-label')).toBe('308 requests');
	});
});

describe('the border glow', () => {
	it('renders the glow ring and keeps the content reachable', () => {
		// `role="presentation"` would have told an assistive tech to ignore the
		// whole subtree — including the card's real content. `group` groups it
		// without hiding it, which is the reason the a11y warning was fixed this
		// way and not by silencing it.
		const { container } = render(BorderGlow, {});
		expect(container.querySelector('.edge-light')).not.toBeNull();
		expect(el(container).getAttribute('role')).toBe('group');
	});

	it('starts at rest, with the glow invisible', () => {
		// The effect is driven entirely by `--edge-proximity`, which is 0 until a
		// pointer arrives. A component that shipped with a non-zero default would
		// light every card on the page before anyone touched it.
		const { container } = render(BorderGlow, {});
		const glow = el(container);
		expect(style(glow).getPropertyValue('--edge-proximity').trim()).toBe('0');
	});

	it('takes its colour from the brand token, not a hard-coded palette', () => {
		// The upstream component ships purple/pink/blue defaults. The port has to
		// resolve through `--primary`, so a theme change moves the glow with it.
		//
		// Two traps this assertion is written around:
		//
		//   1. `getComputedStyle().getPropertyValue()` on a *custom property*
		//      returns the substituted token stream — `var(--primary)` becomes
		//      `#ff6c11`, the authored form, and is NOT normalised to `rgb()`.
		//      A matcher that only looked for `rgb(` found nothing and the test
		//      passed while proving nothing.
		//   2. Checking that the primary colour merely *appears* somewhere is too
		//      weak: the gradient repeats the token at several stops, so a
		//      hard-coded colour at one stop would leave the token visible
		//      elsewhere and the test would still be green.
		//
		// The real claim is that EVERY colour in the gradient is either the
		// brand colour or fully transparent — no foreign literal survives.
		const { container } = render(BorderGlow, {});
		const glow = el(container);
		const primary = style(glow).getPropertyValue('--primary').trim();
		const base = style(glow).getPropertyValue('--glow-base');

		expect(primary).not.toBe('');
		expect(base).toContain('conic-gradient');

		// Any colour syntax the browser can emit for a gradient stop.
		const colourRe = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|oklch\([^)]*\)|lab\([^)]*\)/gi;
		const colours = [...base.matchAll(colourRe)].map((m) => m[0].replace(/\s+/g, ' ').toLowerCase());
		expect(colours.length, 'colour stops found in the gradient').toBeGreaterThan(0);

		const isTransparent = (c: string) =>
			c === 'transparent' || /^rgba?\(\s*0,\s*0,\s*0,\s*0\s*\)$/.test(c);
		const foreign = colours.filter((c) => c !== primary.toLowerCase() && !isTransparent(c));
		expect(foreign, 'colours in the glow that are not the brand token').toEqual([]);
	});

	it('falls back to the design system radius, not a magic number', () => {
		// `--glow-radius-card` is `var(--radius-lg)` in the sheet, and the
		// computed value has to equal whatever that token resolves to — so a
		// change to the scale moves this card with it. Asserting the literal
		// `12px` would have passed while proving the opposite.
		const { container } = render(BorderGlow, {});
		const rootRadius = style(document.documentElement).getPropertyValue('--radius-lg').trim();
		const cardRadius = style(el(container)).getPropertyValue('--glow-radius-card').trim();

		expect(rootRadius).not.toBe('');
		expect(cardRadius).toBe(rootRadius);
	});
});
