<script lang="ts">
	// Atom: an animated odometer counter.
	//
	// Inspiration: reactbits.dev Counter (DavidHDev/react-bits, MIT + Commons
	// Clause). Port of the idea, not the code — Svelte 5 runes replace the
	// React hooks, and there is no dependency to add.
	//
	// DESIGN.md is absolute about motion: transform and opacity only,
	// durations come from the `motion` scale, and a reduce branch must restore
	// the resting state rather than hide content. This complies: exactly one
	// animated property (translateY), one duration (the scale's, applied as
	// ease-out cubic in script so the easing cannot drift from the spec), and
	// a reduced-motion path that snaps each digit to its final offset.
	//
	// Component tier: every custom property below is class-scoped (Tier 3)
	// and never lands in `:root`.

	let {
		value = 0,
		places,
		size = 'md',
		label
	}: {
		value?: number;
		places?: number[];
		size?: 'sm' | 'md' | 'lg';
		label?: string;
	} = $props();

	// What the value really says, ignoring its sign: a negative balance is a
	// debt, not a different number.
	const magnitude = $derived(Math.abs(Number(value) || 0));

	// Places come from the value unless they are given. A ones digit is `1`, a
	// tenths digit is `0.1` — that ratio is what makes the offset arithmetic
	// below a single expression.
	const slots = $derived.by(() => {
		// `p > 0` would put a tenths place in the integer row *and* in the
		// fraction row, rendering it twice. An integer place is `>= 1`.
		const given = places?.filter((p) => p >= 1) ?? [];
		if (given.length > 0) return given;
		const digits = Math.max(1, Math.trunc(magnitude).toString().length);
		return Array.from({ length: digits }, (_, i) => 10 ** (digits - i - 1));
	});
	const fractionSlots = $derived((places ?? []).filter((p) => p < 1));

	// The digit that should sit in the window for a given place. This is the
	// whole component's ground truth.
	//
	// `magnitude / place` is the digit's position on the number line: for 9.5
	// at place 0.1 that is 95, whose last digit is 5. The catch is float
	// division — 9.5 / 0.1 is 94.99999999999999, and a bare `Math.trunc` would
	// report 4. Rounding to six decimals first is what makes the arithmetic
	// exact without special-casing fractions.
	const digitFor = (place: number) => {
		const scaled = Number((magnitude / place).toFixed(6));
		return Math.min(9, Math.max(0, Math.trunc(scaled) % 10));
	};

	// Offset of digit n in a 10-slot stack, as a bare percentage. The stack is
	// 10em tall and the window is 1em, so digit n sits `n * 10%` above the
	// window — no layout is involved, which is why the effect is free.
	//
	// This is a *value*, not a whole transform: the stylesheet writes
	// `translateY(var(--roll))`, so returning `translateY(-30%)` here would
	// substitute into `translateY(translateY(-30%))` and be dropped as invalid.
	const offset = (n: number) => `${n * -10}%`;
	const offsetTransform = (n: number) => `translateY(${offset(n)})`;

	// Svelte 5: `action` hands us the exact node, so two counters on one page
	// never collide. (A `document.querySelector` here would have made every
	// instance drive the first one.)
	//
	// The action takes the *target digit* as its parameter, not the place, so
	// Svelte re-runs `update` whenever the digit changes — that is what makes a
	// live value animate instead of jump.
	//
	// Ownership of `transform` matters: the markup never writes it. It publishes
	// the resting offset as `--roll` and the stylesheet derives
	// `transform: translateY(var(--roll))`, so the server renders the right
	// digit. The action writes the inline `transform` only while it is
	// animating, then clears it and hands control back to the custom property.
	// Two writers on one property is how the first version lost its animation
	// mid-flight whenever Svelte patched the style attribute.
	function roll(node: HTMLElement, target: number) {
		const prefersReduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
		let raf = 0;
		let current = Number(node.dataset.digit ?? target);

		const settle = () => {
			cancelAnimationFrame(raf);
			node.style.removeProperty('transform');
			node.dataset.digit = String(target);
			current = target;
		};

		const animate = (to: number) => {
			cancelAnimationFrame(raf);
			if (prefersReduced() || current === to) {
				settle();
				return;
			}

			// The shorter way round: 9 -> 0 steps forward one slot, not nine back.
			const from = current;
			const delta = (to - from + 10) % 10;
			const duration = 320; // the scale's `durMed`; tokens.test.ts asserts the value
			const t0 = performance.now();

			const step = (t: number) => {
				const k = Math.min((t - t0) / duration, 1);
				const y = from + delta * (1 - Math.pow(1 - k, 3));
				// `% 10` keeps the column inside one turn at every frame, so the
				// transform never accumulates past the stack it has.
				node.style.transform = offsetTransform(Math.round(y) % 10);
				if (k < 1) {
					raf = requestAnimationFrame(step);
				} else {
					settle();
				}
			};
			raf = requestAnimationFrame(step);
		};

		// On mount the digit is already in the window (the markup painted it),
		// so there is nothing to animate.
		node.dataset.digit = String(target);
		current = target;

		return {
			update(next: number) {
				animate(next);
			},
			destroy() {
				cancelAnimationFrame(raf);
			}
		};
	}
	// The ten digit faces a roll cycles through. A constant rather than
	// `{length: 10}`: the only thing the body renders is the face itself, so the
	// iteration needs no unused first binding to carry.
	const digits = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
</script>

<span
	class="counter {size}"
	role={label ? 'img' : undefined}
	aria-label={label}
	aria-hidden={label ? undefined : true}
>
	<span class="track">
		{#each slots as place (place)}
			<span class="place">
				<em
					class="roll"
					data-place={place}
					data-current={digitFor(place)}
					style="--roll: {offset(digitFor(place))}"
					use:roll={digitFor(place)}
				>
					{#each digits as digit (digit)}
						<span class="digit">{digit}</span>
					{/each}
				</em>
			</span>
		{/each}
		{#if fractionSlots.length}
			<span class="sep">.</span>
			{#each fractionSlots as place (place)}
				<span class="place">
					<em
						class="roll"
						data-place={place}
						data-current={digitFor(place)}
						style="--roll: {offset(digitFor(place))}"
						use:roll={digitFor(place)}
					>
						{#each digits as digit (digit)}
							<span class="digit">{digit}</span>
						{/each}
					</em>
				</span>
			{/each}
		{/if}
	</span>
</span>

<style>
	/*
	 * `.place` is a one-em window; `.roll` is a 10-high column inside it.
	 * Sliding the column by 10n percent is the entire effect — no layout, no
	 * repaint, and nothing to restore for reduced motion except the final
	 * offset, which the action writes on its first run.
	 */
	.counter {
		--gap: 0.25ch;

		display: inline-flex;
		font-variant-numeric: tabular-nums;
		line-height: var(--lh-display);
	}

	.track {
		display: inline-flex;
		align-items: stretch;
		gap: var(--gap);
	}

	.place {
		position: relative;
		display: inline-block;
		width: 1ch;
		height: 1em;
		overflow: hidden;
	}

	.roll {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		/* 10em, not `inset: 0`. A percentage in `translateY` resolves against
		   the element's own height, so pinning the column to the 1em window
		   made `-30%` a 0.3em shift instead of 3em — ten times too small. */
		height: 10em;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: flex-start;
		/* The resting offset arrives as `--roll`, written by the markup, so the
		   server paints the right digit and there is no flash of `000` before
		   hydration. Every digit in the stack is exactly one em tall, so the
		   column is 10em and `n * -10%` lands digit n in the one-em window.
		   While the action animates it sets an inline `transform`, which wins
		   over this rule; when it settles it removes that inline value and this
		   one takes over again at the new resting offset. */
		transform: translateY(var(--roll, 0%));
		will-change: transform;
	}

	.sep {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 0.5ch;
		opacity: 0.55;
	}

	.digit {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1ch;
		height: 1em;
	}

	.sm {
		font-size: var(--text-h5);
	}
	.md {
		font-size: var(--text-h3);
	}
	.lg {
		font-size: var(--text-h1);
	}

	/* The spec's rule for reduce: restore the resting state, never hide the
	   content. The action above writes the resting offset before it can be
	   disabled, so a reduced-motion user still sees the right number — it
	   simply arrives without the slide. */
	@media (prefers-reduced-motion: reduce) {
		.roll {
			will-change: auto;
		}
	}
</style>
