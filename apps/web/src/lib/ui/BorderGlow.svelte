<script lang="ts">
	// Atom: a card with a pointer-driven border glow and an edge light.
	//
	// Inspiration: reactbits.dev BorderGlow (DavidHDev/react-bits, MIT +
	// Commons Clause). This is a port of the idea, not the code: the source is
	// React with useRef callbacks, this is Svelte 5 with runes.
	//
	// Deliberate departures from the source, all forced by our design system:
	//   1. The color comes from `--primary`, not from a default palette. The
	//      source ships purple/pink/blue and a `glowColor` HSL string; we have
	//      one brand hue and a rule that a component may not reach a brand
	//      primitive directly, so it composes the semantic token instead.
	//   2. No `animated` entrance sweep. An entrance that nobody asked for is
	//      motion with no home on the `motion` scale, and it runs while the
	//      reader is still working out what the page is.
	//   3. Transform and opacity only, and the opacity ramp is the source's
	//      edge-proximity math — which already is a pure opacity change.
	//
	// Component tier: `--edge-proximity`, `--cursor-angle` and the glow color
	// steps are set on the instance, never in `:root`.

	let {
		children,
		class: klass = '',
		edgeSensitivity = 30,
		glowColor = 'var(--primary)',
		radius = 'var(--radius-lg)',
		glowRadius = '2rem',
		intensity = 1
	}: {
		children?: import('svelte').Snippet;
		class?: string;
		edgeSensitivity?: number;
		glowColor?: string;
		radius?: string;
		glowRadius?: string;
		intensity?: number;
	} = $props();

	// Pointer position, in the card's own coordinates, written straight to
	// custom properties. Two values drive the entire effect and neither is
	// ever read back into script.
	function track(event: PointerEvent) {
		const el = event.currentTarget as HTMLElement;
		const rect = el.getBoundingClientRect();
		const x = event.clientX - rect.left;
		const y = event.clientY - rect.top;

		const cx = rect.width / 2;
		const cy = rect.height / 2;
		const dx = x - cx;
		const dy = y - cy;

		// Proximity to the edge: 1 at the boundary, 0 at the centre. The
		// source's `1 / min(|kx|, |ky|)` — the min is the axis the pointer is
		// closest to escaping on.
		const kx = dx === 0 ? Infinity : cx / Math.abs(dx);
		const ky = dy === 0 ? Infinity : cy / Math.abs(dy);
		const edge = Math.min(Math.max(1 / Math.min(kx, ky), 0), 1);

		let angle = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
		if (angle < 0) angle += 360;

		el.style.setProperty('--edge-proximity', (edge * 100).toFixed(3));
		el.style.setProperty('--cursor-angle', `${angle.toFixed(3)}deg`);
	}

	function release(event: PointerEvent) {
		const el = event.currentTarget as HTMLElement;
		el.style.setProperty('--edge-proximity', '0');
	}
</script>

<div
	class="glow {klass}"
	role="group"
	onpointermove={track}
	onpointerleave={release}
	style:--glow-color={glowColor}
	style:--glow-intensity={intensity}
	style:--glow-radius={glowRadius}
	style:--glow-edge-sensitivity={edgeSensitivity}
	style:--glow-radius-card={radius}
>
	<span class="edge-light" aria-hidden="true"></span>
	<div class="inner">
		{@render children?.()}
	</div>
</div>

<style>
	/*
	 * Three layers, all opacity, no transform, no infinite animation:
	 *   ::before  the coloured mesh-gradient border, masked to a cone
	 *   ::after   the mesh fill inside the border
	 *   .edge-light  the outer glow ring
	 * All three fade in on pointer proximity and out on leave, which is the
	 * only event that turns them on.
	 */
	.glow {
		/* Every custom property the effect needs is declared here with the same
		   default the `<script>` passes, so a component that forgets a prop
		   still renders — and so the class tier stays readable in one place. */
		--edge-proximity: 0;
		--cursor-angle: 45deg;
		--glow-radius: 2rem;
		--glow-radius-card: var(--radius-lg);
		--glow-edge-sensitivity: 30;
		--glow-color: var(--primary);
		--glow-intensity: 1;
		--glow-opacity: calc(var(--glow-intensity) * 100%);
		--color-sensitivity: calc(var(--glow-edge-sensitivity) + 20);
		/* A conic sweep of the brand hue is the border; the same hue, dimmed,
		   is the interior fill. Both compose the semantic token — never the
		   primitive `--color-orange` behind it. */
		--glow-base: conic-gradient(
			from var(--cursor-angle),
			var(--primary) 0%,
			var(--glow-color) 8%,
			transparent 20%,
			transparent 80%,
			var(--glow-color) 92%,
			var(--primary) 100%
		);
		--glow-fill: radial-gradient(
				ellipse at 50% 50%,
				var(--glow-color) 0%,
				transparent 70%
			);

		position: relative;
		border-radius: var(--glow-radius-card);
		isolation: isolate;
		display: grid;
		border: 1px solid var(--color-border);
		background: var(--color-surface);
		overflow: visible;
	}

	.glow::before,
	.glow::after,
	.glow :global(.edge-light) {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: inherit;
		z-index: -1;
		/* The spec's duration and easing. Not a custom transition. */
		transition: opacity var(--duration-med) var(--ease);
	}

	.glow:not(:hover)::before,
	.glow:not(:hover)::after,
	.glow:not(:hover) :global(.edge-light) {
		opacity: 0;
		transition: opacity calc(var(--duration-med) * 2) var(--ease);
	}

	/* The border: a conic mask means only the arc facing the pointer lights
	   up, which is the whole point of tracking the angle. */
	.glow::before {
		border: 1px solid transparent;
		background:
			var(--color-surface) padding-box,
			var(--glow-base) border-box;
		mask-image: conic-gradient(
			from var(--cursor-angle) at center,
			black 0%,
			transparent 15%,
			transparent 85%,
			black 100%
		);
		opacity: calc((var(--edge-proximity) - var(--color-sensitivity)) / (100 - var(--color-sensitivity)));
	}

	.glow::after {
		background: var(--glow-fill);
		opacity: calc(
			0.5 * (var(--edge-proximity) - var(--color-sensitivity)) / (100 - var(--color-sensitivity))
		);
		mix-blend-mode: soft-light;
	}

	/* The glow ring lives one `--glow-radius` outside the card. */
	.edge-light {
		position: absolute;
		inset: calc(var(--glow-radius) * -1);
		pointer-events: none;
		mask-image: conic-gradient(
			from var(--cursor-angle) at center,
			black 2.5%,
			transparent 10%,
			transparent 90%,
			black 97.5%
		);
		opacity: calc(
			(var(--edge-proximity) - var(--glow-edge-sensitivity, 30)) /
				(100 - var(--glow-edge-sensitivity, 30))
		);
		mix-blend-mode: plus-lighter;
	}

	.edge-light::before {
		content: '';
		position: absolute;
		inset: var(--glow-radius);
		border-radius: inherit;
		box-shadow:
			inset 0 0 0 1px var(--glow-color),
			inset 0 0 3px 0 var(--glow-color),
			inset 0 0 12px 0 var(--glow-color),
			inset 0 0 32px 0 var(--glow-color);
	}

	.inner {
		position: relative;
		display: flex;
		flex-direction: column;
		z-index: 1;
	}

	/* The spec's rule, and it matters most here: a pointer effect is exactly
	   what a reduce user does not want, so the whole thing resolves to its
	   resting border. */
	@media (prefers-reduced-motion: reduce) {
		.glow::before,
		.glow::after,
		.glow :global(.edge-light) {
			opacity: 0 !important;
			transition: none !important;
		}
	}
</style>
