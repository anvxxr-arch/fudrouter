<script lang="ts">
	import { onMount } from 'svelte';
	import type { Chart as ChartInstance, TooltipItem } from 'chart.js';
	import { formatCost, formatTokens } from '$lib/format';

	// Chart: requests per day, on a canvas.
	//
	// Chart.js is imported lazily inside onMount: the module is large and touches
	// the DOM, so it must not enter the shared bundle, run during SSR, or delay
	// first paint. The wrapper keeps a fixed height, so the late chunk cannot
	// shift the page under the reader. Palette and tick font are read from the
	// design tokens at mount — a chart carries no hex of its own (DESIGN.md
	// §Charts).
	type Day = { day: string; requests: number; tokens: number; cost: string };

	let { days, label = 'Requests per day' }: { days: Day[]; label?: string } = $props();

	let canvas = $state<HTMLCanvasElement>();

	const dayFormat = new Intl.DateTimeFormat('en-US', {
		month: 'short',
		day: 'numeric',
		timeZone: 'UTC'
	});
	const labelFor = (day: string) => dayFormat.format(new Date(`${day}T00:00:00Z`));

	const total = $derived(days.reduce((n, d) => n + d.requests, 0));

	onMount(() => {
		let chart: ChartInstance | undefined;
		let disposed = false;

		(async () => {
			const { Chart, BarController, BarElement, CategoryScale, LinearScale, Tooltip } =
				await import('chart.js');
			if (disposed || !canvas) return;

			Chart.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip);

			const computed = getComputedStyle(document.documentElement);
			const token = (name: string) => computed.getPropertyValue(name).trim();

			chart = new Chart(canvas, {
				type: 'bar',
				data: {
					labels: days.map((d) => labelFor(d.day)),
					datasets: [
						{
							label,
							data: days.map((d) => d.requests),
							backgroundColor: token('--fr-primary'),
							hoverBackgroundColor: token('--fr-primary-hover'),
							borderRadius: Number.parseInt(token('--fr-radius-sm') || '4', 10),
							maxBarThickness: 26
						}
					]
				},
				options: {
					responsive: true,
					maintainAspectRatio: false,
					animation: matchMedia('(prefers-reduced-motion: reduce)').matches
						? false
						: { duration: 350 },
					plugins: {
						legend: { display: false },
						tooltip: {
							backgroundColor: token('--fr-surface-raised'),
							borderColor: token('--fr-border-strong'),
							borderWidth: 1,
							cornerRadius: Number.parseInt(token('--fr-radius-md') || '8', 10),
							titleColor: token('--fr-text'),
							bodyColor: token('--fr-text'),
							displayColors: false,
							padding: 10,
							callbacks: {
								title: (items: TooltipItem<'bar'>[]) => {
									const d = days[items[0]?.dataIndex ?? -1];
									return d ? labelFor(d.day) : '';
								},
								label: (item: TooltipItem<'bar'>) => {
									const d = days[item.dataIndex];
									return d
										? `${formatTokens(d.requests)} requests · ${formatTokens(d.tokens)} tokens · ${formatCost(BigInt(d.cost))}`
										: '';
								}
							}
						}
					},
					scales: {
						x: {
							grid: { display: false },
							border: { color: token('--fr-border') },
							ticks: {
								color: token('--fr-text-muted'),
								font: { family: token('--fr-font-mono'), size: 11 },
								maxRotation: 0
							}
						},
						y: {
							beginAtZero: true,
							grid: { color: token('--fr-border') },
							border: { display: false },
							ticks: {
								color: token('--fr-text-muted'),
								font: { family: token('--fr-font-mono'), size: 11 },
								precision: 0
							}
						}
					}
				}
			});
		})();

		return () => {
			disposed = true;
			chart?.destroy();
		};
	});
</script>

<!-- The numbers live in a text summary; the canvas itself is decoration. -->
<p class="sr-only">{label}: {formatTokens(total)} requests in the last {days.length} days.</p>
<div class="chart-box">
	<canvas bind:this={canvas} aria-hidden="true"></canvas>
</div>

<style>
	/* Fixed height: the chart chunk lands late on a cold load and must not shift
	   the page. min-width 0 lets the column shrink at 320px instead of widening. */
	.chart-box {
		position: relative;
		height: 240px;
		min-width: 0;
	}
</style>
