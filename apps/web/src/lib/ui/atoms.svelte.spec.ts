import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
// The global sheets the app loads in `layout.css`. Without them the atoms render
// bare markup and every computed style is the browser default — so a test that
// skipped these would pass while proving nothing.
import '$lib/design/tokens.css';
import '$lib/design/components.css';
import Alert from './Alert.svelte';
import Badge from './Badge.svelte';
import Button from './Button.svelte';
import ButtonLink from './ButtonLink.svelte';
import Input from './Input.svelte';
import Facts from './Facts.svelte';
import Metric from './Metric.svelte';
import Select from './Select.svelte';
import Textarea from './Textarea.svelte';
import VisualDivider from './VisualDivider.svelte';
import { ALERT_TONES, BUTTON_VARIANTS, CONTROL_SIZES, TONES } from '$lib/design/variants';

/** The element a component rendered, as a real DOM node we can measure. */
const el = (container: HTMLElement) => container.firstElementChild as HTMLElement;
const style = (node: HTMLElement) => getComputedStyle(node);
const px = (node: HTMLElement, prop: string) => Math.round(parseFloat(style(node)[prop as never]));

describe('the shared button shell', () => {
	it('renders the variant, size and shell classes', () => {
		const { container } = render(Button, { variant: 'primary', size: 'lg' });
		const cls = el(container).className;
		expect(cls).toContain('fr-btn');
		expect(cls).toContain('fr-btn--primary');
		expect(cls).toContain('fr-btn--lg');
	});

	it('merges a caller class instead of letting it replace the variant', () => {
		// The regression this guards: `{...rest}` sat after the literal `class`, so
		// `<Button class="mt-4">` emitted class="mt-4" and lost the shell entirely.
		const { container } = render(Button, { variant: 'danger', class: 'mt-4 custom-thing' });
		const cls = el(container).className;
		expect(cls).toContain('mt-4');
		expect(cls).toContain('custom-thing');
		expect(cls, 'the caller class clobbered the variant').toContain('fr-btn--danger');
		expect(cls).toContain('fr-btn');
	});

	it('gives every variant a distinct appearance — proof the stylesheet applies', () => {
		// Asserting the class name only proves the string; this proves the rule.
		//
		// The invariant is *appearance*, not background: `secondary` and `danger`
		// deliberately share the raised surface and separate themselves by text and
		// border colour instead. Comparing only backgrounds would fail on a correct
		// stylesheet.
		const looks = new Map<string, string>();
		for (const variant of BUTTON_VARIANTS) {
			const { container } = render(Button, { variant });
			const s = style(el(container));
			looks.set(variant, `${s.backgroundColor}|${s.color}|${s.borderTopColor}`);
		}
		expect(new Set(looks.values()).size, `variants look identical: ${[...looks]}`).toBe(
			BUTTON_VARIANTS.length
		);
		// Every one of them must resolve to a real colour, never an empty value.
		for (const [variant, look] of looks) {
			expect(look, `${variant} resolved to nothing`).not.toMatch(/^(\|\|\||\s*)$/);
		}
	});

	it('gives every size its own height, matching the token scale', () => {
		const heights = CONTROL_SIZES.map((size) => {
			const { container } = render(Button, { size });
			return px(el(container), 'minHeight');
		});
		expect(heights).toEqual([32, 40, 48]);
	});

	it('keeps a primary ButtonLink visually identical to a primary Button', () => {
		// This is what the shared shell buys: the two were separate copies and had
		// already diverged (ButtonLink was missing `danger`, and its ghost had no
		// hover rule).
		const { container: b } = render(Button, { variant: 'primary' });
		const { container: l } = render(ButtonLink, { variant: 'primary', href: '/x' });
		const bs = style(el(b));
		const ls = style(el(l));
		for (const prop of ['backgroundColor', 'color', 'borderRadius', 'minHeight', 'fontWeight']) {
			expect(ls[prop as never], `ButtonLink and Button disagree on ${prop}`).toBe(
				bs[prop as never]
			);
		}
	});

	it('supports every variant on ButtonLink too — the drift that was fixed', () => {
		for (const variant of BUTTON_VARIANTS) {
			const { container } = render(ButtonLink, { variant, href: '/x' });
			expect(el(container).className, `ButtonLink has no ${variant}`).toContain(
				`fr-btn--${variant}`
			);
		}
	});

	it('marks a disabled link with aria-disabled, not the disabled attribute', () => {
		// `disabled` does not exist on <a>, so it would have been silently dropped.
		const { container } = render(ButtonLink, { href: '/x', disabled: true });
		const a = el(container);
		expect(a.getAttribute('aria-disabled')).toBe('true');
		expect(a.getAttribute('tabindex')).toBe('-1');
	});
});

describe('the shared control shell', () => {
	it('renders input, select and textarea with identical geometry', () => {
		const rendered = [
			el(render(Input, {}).container),
			el(render(Select, {}).container),
			el(render(Textarea, {}).container)
		];
		const shells = rendered.map((n) => ({
			borderRadius: style(n).borderRadius,
			borderWidth: style(n).borderTopWidth,
			background: style(n).backgroundColor
		}));
		expect(shells[1]).toEqual(shells[0]);
		expect(shells[2]).toEqual(shells[0]);
	});

	it('sizes a control from the same scale as a button', () => {
		const { container } = render(Input, { size: 'sm' });
		expect(px(el(container), 'minHeight')).toBe(32);
	});

	it('merges a caller class on a control', () => {
		const { container } = render(Input, { class: 'w-40' });
		expect(el(container).className).toContain('w-40');
		expect(el(container).className).toContain('fr-control');
	});
});

describe('the shared tone table', () => {
	it('gives every tone a distinct colour on a Badge', () => {
		const colours = new Map<string, string>();
		for (const tone of TONES) {
			const { container } = render(Badge, { tone });
			colours.set(tone, style(el(container)).color);
		}
		expect(new Set(colours.values()).size, `tones collide: ${[...colours]}`).toBe(TONES.length);
	});

	it('announces a failure assertively and everything else politely', () => {
		// Both roles used to be "status", so a failed save was announced as quietly
		// as a success.
		const { container: danger } = render(Alert, { tone: 'danger' });
		expect(el(danger).getAttribute('role')).toBe('alert');
		for (const tone of ALERT_TONES.filter((t) => t !== 'danger')) {
			const { container } = render(Alert, { tone });
			expect(el(container).getAttribute('role'), `${tone} should be polite`).toBe('status');
		}
	});
});

describe('the metric strip', () => {
	it('renders the value in the tabular numeric treatment with its tone', () => {
		const { container } = render(Metric, {
			label: 'Models published',
			value: '243',
			tone: 'success'
		});
		const node = el(container);
		expect(node.textContent).toContain('Models published');
		expect(node.textContent).toContain('243');
		const value = node.querySelector('.metric-value') as HTMLElement;
		expect(value.className, 'the value must be tabular').toContain('num');
		expect(value.className).toContain('success');
	});

	it('draws the scene edge as a gradient hairline, hidden from assistive tech', () => {
		const { container } = render(VisualDivider, {});
		const node = el(container);
		expect(node.getAttribute('aria-hidden')).toBe('true');
		expect(style(node).backgroundImage, 'the shared divider rule must apply').toContain('gradient');
		expect(px(node, 'height')).toBe(1);
	});
});

describe('a guide is not a table', () => {
	it('separates fact rows with spacing, not a rule that mimics a table row', () => {
		// Regression: `.fr-dl > div` carried the same `border-bottom: 1px solid
		// var(--fr-border)` as `table.fr td`, so a Guide stacked directly above a
		// table read as one continuous table — the two blocks had no way to say
		// they were different things.
		const { container } = render(Facts, {
			items: [
				{ term: 'First', detail: 'one' },
				{ term: 'Second', detail: 'two' }
			]
		});
		const rows = container.querySelectorAll('.fr-dl > div');
		expect(rows.length).toBe(2);
		for (const row of rows) {
			// Width, not style: Chrome reports `border-bottom-style: solid` even at
			// 0px, so asserting on style alone is a check that cannot fail.
			expect(px(row as HTMLElement, 'borderBottomWidth'), 'a fact row drew a rule').toBe(0);
		}
		// The grouping is carried by the gap, so it must actually exist.
		expect(px(container.querySelector('.fr-dl') as HTMLElement, 'rowGap')).toBeGreaterThan(0);
	});
});
