<script lang="ts">
	import { enhance } from '$app/forms';
	import { Alert, Button, Card, Field, Guide, Input, PageHeader, TableWrap } from '$lib/ui';
	import { withPending } from '$lib/forms';
	let { data, form } = $props();
	let pending = $state(false);
	const track = withPending((v) => (pending = v));
	const hard = $derived(data.hard ?? { rpm: 0, tpm: 0, concurrency: 0 });
</script>
<PageHeader
	title="Traffic"
	lede="Platform hard limits — the ceiling every scope is capped by."
/>
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
{#if form?.saved}<div class="fr-feedback"><Alert tone="success">Hard limits saved.</Alert></div>{/if}
<Card>
	<h2 class="first">Platform hard limits</h2>
	<form method="POST" action="?/save" use:enhance={track}>
		<div class="fr-grid">
			<Field label="Requests per minute (0 = no cap)"
				><Input name="rpm" type="number" min="0" value={hard.rpm} required /></Field
			>
			<Field label="Tokens per minute (0 = no cap)"
				><Input name="tpm" type="number" min="0" value={hard.tpm} required /></Field
			>
			<Field label="Concurrency (0 = no cap)"
				><Input name="concurrency" type="number" min="0" value={hard.concurrency} required /></Field
			>
		</div>
		<div class="submit">
			<Button type="submit" {pending} variant="primary">Save hard limits</Button>
		</div>
	</form>
</Card>
<Guide id="admin-traffic" />
<Card>
	<h2 class="first">Effective-limit chain</h2>
	<p class="muted">
		A request is admitted only if every level allows it. The effective limit is the
		<strong>minimum</strong> across the chain — a tighter level below lowers the limit, never raises it.
	</p>
	<TableWrap label="Effective-limit chain">
		<table class="fr">
			<thead><tr><th>Level</th><th>Source</th><th>Behaviour</th></tr></thead>
			<tbody>
				<tr
					><td>platform</td><td>hard limits above</td><td
						>ceiling for everything below</td
					></tr
				>
				<tr
					><td>workspace</td><td><code>rate_limit</code> row, scope=workspace</td><td
						>min(platform, workspace)</td
					></tr
				>
				<tr
					><td>project</td><td><code>rate_limit</code> row, scope=project</td><td
						>min(..., project)</td
					></tr
				>
				<tr
					><td>environment</td><td><code>rate_limit</code> row, scope=environment</td><td
						>min(..., environment)</td
					></tr
				>
				<tr
					><td>api_key</td><td><code>rate_limit</code> row, scope=api_key</td><td
						>min(..., api_key) = effective</td
					></tr
				>
			</tbody>
		</table>
	</TableWrap>
</Card>
