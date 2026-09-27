<script lang="ts">
	// Atom: Discord OAuth sign-in button. POSTs to the social sign-in endpoint and
	// hands the browser to Discord. Origin header is set explicitly because the
	// endpoint rejects cross-origin POSTs (CSRF guard).
	let { label = 'Continue with Discord' }: { label?: string } = $props();

	let pending = $state(false);
	let error = $state('');

	async function start() {
		pending = true;
		error = '';
		try {
			const res = await fetch('/api/auth/sign-in/social', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Origin: window.location.origin },
				body: JSON.stringify({ provider: 'discord' })
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			if (data.url) {
				window.location.href = data.url;
				return;
			}
			throw new Error('no_redirect_url');
		} catch {
			error = 'Could not start Discord sign-in. Try again.';
			pending = false;
		}
	}
</script>

<button type="button" class="fr-discord" onclick={start} disabled={pending}>
	<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"
		><path
			d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"
		/></svg
	>
	{pending ? 'Redirecting…' : label}
</button>
{#if error}
	<p class="fr-discord-error" role="alert">{error}</p>
{/if}

<style>
	.fr-discord {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-sm);
		width: 100%;
		padding: var(--space-sm) var(--space-md);
		background: var(--color-surface-raised);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		color: var(--color-text);
		font-family: inherit;
		font-weight: 600;
		font-size: var(--text-sm);
		cursor: pointer;
		transition:
			background 0.15s,
			border-color 0.15s;
	}
	.fr-discord:hover:not(:disabled) {
		background: var(--color-surface);
		border-color: var(--color-orange);
	}
	.fr-discord:disabled {
		opacity: 0.6;
		cursor: progress;
	}
	.fr-discord-error {
		margin-top: var(--space-sm);
		color: var(--color-danger);
		font-size: var(--text-sm);
		text-align: center;
	}
</style>
