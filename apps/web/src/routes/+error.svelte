<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { asPublicErrorBody, describeStatus } from '$lib/error-ux';
	import { ButtonLink, Card } from '$lib/ui';

	// One boundary for every failure on every surface (public, member, admin).
	// PRD §130: a user-facing error answers FOUR questions — What happened? /
	// Why? / What can I do? / Request ID? — in those words, so nobody has to
	// infer them from a status code. Errors thrown via
	// `$lib/server/public-error` carry the answers; anything else (bare
	// error(), a hook redirect, a load crash) falls back to status-derived
	// copy below, so the shape is never missing.
	const body = $derived(asPublicErrorBody(page.error));
	const status = $derived(page.status);
	const fallback = $derived(describeStatus(status));
	const what = $derived(
		body?.message || page.error?.message || (status === 404 ? 'Page not found' : 'Something went wrong')
	);
	const why = $derived(body?.why ?? fallback.why);
	const action = $derived(body?.action ?? fallback.action);
	const requestId = $derived(body?.requestId ?? null);
</script>

<div class="error">
	<Card>
		<span class="code num">{status}</span>
		<h1>{status === 404 ? 'Page not found' : 'Something went wrong'}</h1>

		<dl class="answers">
			<div>
				<dt class="fr-label">What happened?</dt>
				<dd>{what}</dd>
			</div>
			<div>
				<dt class="fr-label">Why?</dt>
				<dd>{why}</dd>
			</div>
			<div>
				<dt class="fr-label">What can I do?</dt>
				<dd>{action}</dd>
			</div>
			<!-- PRD §130: the fourth question is always ANSWERED, even when the
			     answer is "none was recorded" — a missing row is a fact, and leaving
			     the question unasked is the failure this page exists to prevent. -->
			<div>
				<dt class="fr-label">Request ID?</dt>
				<dd>
					{#if requestId}<code>{requestId}</code>{:else}None was recorded for this page load.{/if}
				</dd>
			</div>
		</dl>

		<div class="actions">
			<ButtonLink variant="primary" href={resolve('/')}>Back to home</ButtonLink>
			{#if status !== 404}
				<ButtonLink href={resolve('/status')}>Service status</ButtonLink>
			{/if}
		</div>
	</Card>
</div>

<style>
	.error {
		max-width: 38rem;
		margin: 0 auto;
		/* Centred in the upper half: a card hugging the very top over a screen of
		   empty space reads as unfinished. */
		min-height: 60vh;
		display: grid;
		align-content: center;
	}
	.code {
		display: block;
		color: var(--color-text-muted);
		font-size: var(--text-caption);
		font-weight: 600;
		letter-spacing: 0.08em;
	}
	h1 {
		margin: var(--space-sm) 0 var(--space-md);
	}
	.answers {
		display: grid;
		gap: var(--space-sm);
		margin: 0 0 var(--space-md);
	}
	.answers div {
		display: grid;
		gap: 2px;
	}
	.answers dd {
		margin: 0;
		font-size: var(--text-sm);
	}
	.actions {
		display: flex;
		gap: var(--space-sm);
		flex-wrap: wrap;
		margin-top: var(--space-md);
	}
</style>
