<script lang="ts">
	import { Button, Field, Input } from '$lib/ui';

	/**
	 * Confirmation dialog for destructive actions (PRD §109).
	 *
	 * `typed` raises the bar to a typed confirmation: the destructive command
	 * stays disabled until the user reproduces the exact name, which is the
	 * difference between "delete the production alias" and "delete *the*
	 * production alias I am looking at".
	 */
	let {
		open = $bindable(false),
		title,
		body,
		confirmLabel = 'Confirm',
		cancelLabel = 'Cancel',
		typed = null,
		danger = true,
		onconfirm,
		oncancel
	}: {
		open?: boolean;
		title: string;
		body?: string;
		confirmLabel?: string;
		cancelLabel?: string;
		typed?: string | null;
		danger?: boolean;
		onconfirm: () => void;
		oncancel: () => void;
	} = $props();

	let typedValue = $state('');
	let dialogEl: HTMLDivElement | undefined = $state();
	const satisfied = $derived(typed === null || typedValue.trim() === typed);

	// A dialog that opens without taking focus leaves a keyboard user stuck
	// behind the backdrop; focus it as soon as it mounts.
	$effect(() => {
		if (open) dialogEl?.focus();
	});

	function cancel(): void {
		typedValue = '';
		open = false;
		oncancel();
	}
	function confirm(): void {
		if (!satisfied) return;
		typedValue = '';
		open = false;
		onconfirm();
	}
	// Escape cancels; Enter confirms only once the typed gate is satisfied.
	function onKeydown(e: KeyboardEvent): void {
		if (e.key === 'Escape') {
			e.preventDefault();
			cancel();
		} else if (e.key === 'Enter' && satisfied) {
			e.preventDefault();
			confirm();
		}
	}
</script>

{#if open}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_click_events_have_key_events -->
	<div class="fr-dialog-backdrop" role="presentation" onclick={cancel}>
		<div
			class="fr-dialog"
			role="alertdialog"
			aria-modal="true"
			aria-label={title}
			tabindex="-1"
			bind:this={dialogEl}
			onkeydown={onKeydown}
			onclick={(e) => e.stopPropagation()}
		>
			<h2>{title}</h2>
			{#if body}<p>{body}</p>{/if}
			{#if typed !== null}
				<Field label='Type "{typed}" to confirm'>
					<Input bind:value={typedValue} autocomplete="off" />
				</Field>
			{/if}
			<div class="fr-dialog-actions">
				<Button variant="ghost" onclick={cancel}>{cancelLabel}</Button>
				<Button variant={danger ? 'danger' : 'primary'} disabled={!satisfied} onclick={confirm}>
					{confirmLabel}
				</Button>
			</div>
		</div>
	</div>
{/if}

<style>
	.fr-dialog-backdrop {
		position: fixed;
		inset: 0;
		z-index: 50;
		display: grid;
		place-items: center;
		background: rgb(0 0 0 / 0.5);
	}
	.fr-dialog {
		display: grid;
		gap: var(--space-md);
		width: min(28rem, calc(100vw - 2rem));
		padding: var(--space-lg);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
	}
	.fr-dialog-actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-sm);
	}
</style>
