<script lang="ts">
	import { enhance } from '$app/forms';
	import {
		Alert,
		Badge,
		Button,
		Card,
		EmptyState,
		Field,
		Guide,
		Input,
		PageHeader,
		Select,
		TableWrap
	} from '$lib/ui';
	import { formatCost } from '$lib/format';
	import { withPending } from '$lib/forms';
	let { data, form } = $props();
	let pending = $state(false);
	const track = withPending((v) => (pending = v));
	function cost(micro: string): string {
		return formatCost(BigInt(micro));
	}
</script>
<PageHeader
	title="Routing simulations"
	lede="Score the candidates for a hypothetical request and see WHY each one ranks where it does. No request leaves this page."
/>
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
<Card>
	<h2 class="first">Simulate a request</h2>
	<form method="POST" action="?/simulate" use:enhance={track}>
		<div class="fr-grid">
			<Field label="Model">
				<Select name="modelId">
					{#each data.models as m (m.id)}<option value={m.id}>{m.slug}</option>{/each}
				</Select>
			</Field>
			<Field label="Strategy">
				<Select name="strategy">
					{#each data.strategies as s (s)}<option value={s}>{s}</option>{/each}
				</Select>
			</Field>
			<Field label="Input tokens"><Input name="inputTokens" type="number" value="1000" /></Field>
			<Field label="Output tokens"><Input name="outputTokens" type="number" value="500" /></Field>
			<Field label="Region" hint="Optional — scenario label only."><Input name="region" placeholder="us-east" /></Field>
			<Field label="Project" hint="Optional — scenario label only.">
				<Select name="projectId">
					<option value="">— none —</option>
					{#each data.projects as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
				</Select>
			</Field>
		</div>
		<div class="fr-grid">
			<Field label="Price weight" hint="Advanced, 0–1."><Input name="weightPrice" type="number" step="0.1" placeholder="default" /></Field>
			<Field label="Latency weight" hint="Advanced, 0–1."><Input name="weightLatency" type="number" step="0.1" placeholder="default" /></Field>
			<Field label="Reliability weight" hint="Advanced, 0–1."><Input name="weightReliability" type="number" step="0.1" placeholder="default" /></Field>
			<Field label="Capability weight" hint="Advanced, 0–1."><Input name="weightCapacity" type="number" step="0.1" placeholder="default" /></Field>
		</div>
		<div class="submit">
			<Button type="submit" {pending} variant="primary">Simulate</Button>
		</div>
	</form>
</Card>
<Guide id="admin-routing-simulations" />
{#if form?.simulated}
	<Card>
		<h2 class="fr-label">
			Result — {form.strategy} ({form.candidatesConsidered} candidate{form.candidatesConsidered === 1 ? '' : 's'})
		</h2>
		<TableWrap label="Simulation candidates">
			<table class="fr">
				<thead>
					<tr
						><th>Provider</th><th>Connection</th><th>Estimated cost</th><th>Health</th><th
							>Score</th
						><th>Reason</th></tr
					>
				</thead>
				<tbody>
					{#each form.rows as r (r.providerName + (r.connectionName ?? '') + r.reason)}
						<tr>
							<td>{r.providerName}</td>
							<td>{r.connectionName ?? '—'}</td>
							<td class="num">{cost(r.estimatedCostMicro)}</td>
							<td><Badge tone={r.healthStatus === 'healthy' ? 'success' : 'warning'}>{r.healthStatus}</Badge></td>
							<td class="num">{r.score}</td>
							<td>{r.reason}</td>
						</tr>
					{:else}
						<tr><td colspan="6"><EmptyState title="No candidates for this model" hint="Add provider mappings first." /></td></tr>
					{/each}
				</tbody>
			</table>
		</TableWrap>
	</Card>
{/if}
<style>
	h2.first {
		margin-top: 0;
	}
	form {
		display: grid;
		gap: var(--space-md);
	}
</style>
