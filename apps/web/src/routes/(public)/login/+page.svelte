<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { Alert, Button, Card, Field, Input } from '$lib/ui';
	import { withPending } from '$lib/forms';

	let { form } = $props();
	let pending = $state(false);
	const track = withPending((v) => (pending = v));
</script>

<div class="auth">
	<h1>Log in</h1>
	<Card>
		{#if form?.error}
			<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>
		{/if}
		<form method="POST" use:enhance={track}>
			<Field label="Email">
				<Input name="email" type="email" autocomplete="email" required />
			</Field>
			<Field label="Password">
				<Input name="password" type="password" autocomplete="current-password" required />
			</Field>
			<Button type="submit" variant="primary" {pending}>Log in</Button>
		</form>
		<div class="divider"><span>or</span></div>
		<button type="button" class="discord-btn" onclick={async () => {
			const res = await fetch('/api/auth/sign-in/social', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Origin': window.location.origin },
				body: JSON.stringify({ provider: 'discord' })
			});
			const data = await res.json();
			if (data.url) window.location.href = data.url;
		}}>
				<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>
				Continue with Discord
			</button>
	</Card>
	<p class="muted">Need an account? <a href={resolve('/signup')}>Sign up</a></p>
</div>

<style>
	.auth {
		max-width: 24rem;
		margin: var(--fr-space-2xl) auto;
	}
	form {
		display: grid;
		gap: var(--fr-space-md);
	}
	.divider {
		display: flex;
		align-items: center;
		gap: var(--fr-space-md);
		margin: var(--fr-space-lg) 0;
		color: var(--fr-text-muted);
		font-size: var(--fr-text-sm);
	}
	.divider::before,
	.divider::after {
		content: '';
		flex: 1;
		height: 1px;
		background: var(--fr-border);
	}
	.discord-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--fr-space-sm);
		padding: var(--fr-space-sm) var(--fr-space-md);
		border: 1px solid var(--fr-border);
		border-radius: var(--fr-radius-md);
		color: var(--fr-text);
		font-weight: 600;
		font-size: var(--fr-text-sm);
		text-decoration: none;
		transition: background 0.15s;
	}
	.discord-btn:hover {
		background: var(--fr-surface-raised);
		text-decoration: none;
	}
	p {
		margin-top: var(--fr-space-md);
		text-align: center;
		font-size: var(--fr-text-sm);
	}
</style>
