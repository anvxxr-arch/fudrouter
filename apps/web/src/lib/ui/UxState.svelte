<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Alert, EmptyState, ButtonLink } from '$lib/ui';
	import { resolve } from '$app/paths';

	// PRD §108: every page shows loading / empty / success / error / permission
	// denied. `state` decides which; the success body is the caller's snippet.
	// Error and denied copy follows PRD §130 (What happened? / Why? / What can
	// I do? / Request ID?).
	let {
		state,
		emptyTitle = 'Nothing here yet',
		emptyHint,
		errorWhat,
		errorWhy,
		errorAction,
		errorRequestId,
		children
	}: {
		state: 'loading' | 'empty' | 'success' | 'error' | 'denied';
		emptyTitle?: string;
		emptyHint?: string;
		errorWhat?: string;
		errorWhy?: string;
		errorAction?: string;
		errorRequestId?: string;
		children?: Snippet;
	} = $props();
</script>

{#if state === 'loading'}
	<div class="ux-loading" role="status" aria-busy="true" aria-live="polite">
		<span class="bar" aria-hidden="true"></span>
		<span class="bar short" aria-hidden="true"></span>
		<span class="visually-hidden">Loading…</span>
	</div>
{:else if state === 'empty'}
	<EmptyState title={emptyTitle} hint={emptyHint} />
{:else if state === 'denied'}
	<div class="ux-error">
		<Alert tone="warning">
			<strong>What happened?</strong> You do not have permission to view this page.<br />
			<strong>Why?</strong> Your account or workspace role does not include it.<br />
			<strong>What can I do?</strong> Ask a workspace admin for access, or head back to your
			dashboard.
			{#if errorRequestId}<br /><strong>Request ID:</strong> <code>{errorRequestId}</code>{/if}
		</Alert>
		<ButtonLink href={resolve('/dashboard')}>Back to dashboard</ButtonLink>
	</div>
{:else if state === 'error'}
	<div class="ux-error">
		<Alert tone="danger">
			<strong>What happened?</strong>
			{errorWhat ?? 'Something went wrong loading this page.'}<br />
			<strong>Why?</strong>
			{errorWhy ?? 'The server hit an unexpected problem.'}<br />
			<strong>What can I do?</strong>
			{errorAction ?? 'Try again in a moment. If it keeps happening, check the status page.'}
			{#if errorRequestId}<br /><strong>Request ID:</strong> <code>{errorRequestId}</code>{/if}
		</Alert>
		<ButtonLink href={resolve('/status')}>Service status</ButtonLink>
	</div>
{:else}
	{@render children?.()}
{/if}

<style>
	.ux-loading {
		display: grid;
		gap: var(--space-sm);
		padding: var(--space-xl) var(--space-md);
	}
	.bar {
		display: block;
		height: 1rem;
		border-radius: var(--radius-sm);
		background: linear-gradient(
			90deg,
			var(--color-surface) 0%,
			var(--color-surface-raised) 50%,
			var(--color-surface) 100%
		);
		background-size: 200% 100%;
		animation: ux-shimmer 1.2s ease-in-out infinite;
	}
	.bar.short {
		width: 60%;
	}
	@keyframes ux-shimmer {
		0% {
			background-position: 200% 0;
		}
		100% {
			background-position: -200% 0;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.bar {
			animation: none;
		}
	}
	.ux-error {
		display: grid;
		gap: var(--space-md);
		justify-items: start;
		padding: var(--space-lg) 0;
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}
</style>
