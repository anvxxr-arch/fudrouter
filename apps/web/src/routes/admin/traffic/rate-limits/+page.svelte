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
</script>
<PageHeader
	title="Rate limits"
	lede="One row per workspace, project, environment or API key. Empty fields inherit from the scope above; the effective limit is the minimum across the chain."
/>
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
{#if form?.created}
	<div class="fr-feedback"><Alert tone="success">Rate limit for “{form.created}” created.</Alert></div>
{/if}
{#if form?.updated}
	<div class="fr-feedback"><Alert tone="success">Rate limit updated.</Alert></div>
{/if}
{#if form?.deleted}
	<div class="fr-feedback"><Alert tone="success">Rate limit deleted.</Alert></div>
{/if}
<Card>
	<h2 class="first">Add rate limit</h2>
	<form method="POST" action="?/create" use:enhance={track}>
		<div class="fr-grid">
			<Field label="Scope">
				<Select name="scope">
					{#each data.scopes as s (s)}<option value={s}>{s}</option>{/each}
				</Select>
			</Field>
			<Field label="Scope ID"><Input name="scopeId" placeholder="wrk_… / prj_… / env_… / key_…" required /></Field>
			<Field label="RPM (empty = inherit)"><Input name="rpm" type="number" min="0" /></Field>
			<Field label="TPM (empty = inherit)"><Input name="tpm" type="number" min="0" /></Field>
			<Field label="RPD (empty = inherit)"><Input name="rpd" type="number" min="0" /></Field>
			<Field label="TPD (empty = inherit)"><Input name="tpd" type="number" min="0" /></Field>
			<Field label="Concurrency (empty = inherit)"
				><Input name="concurrency" type="number" min="0" /></Field
			>
			<Field label="Daily spend cap, USD (empty = inherit)"
				><Input name="dailySpendUsd" type="number" min="0" step="0.01" /></Field
			>
			<Field label="Monthly spend cap, USD (empty = inherit)"
				><Input name="monthlySpendUsd" type="number" min="0" step="0.01" /></Field
			>
		</div>
		<div class="submit">
			<Button type="submit" {pending} variant="primary">Create rate limit</Button>
		</div>
	</form>
</Card>
<Guide id="admin-traffic-rate-limits" />
<!-- Row actions: one update/delete form per row, outside the table and wired by
     the `form` attribute — a <form> may not wrap <tr> without breaking the table. -->
{#each data.limits as r (r.id)}
	<form id="rl-save-{r.id}" method="POST" action="?/update" use:enhance={track}>
		<input type="hidden" name="id" value={r.id} />
	</form>
	<form id="rl-del-{r.id}" method="POST" action="?/delete" use:enhance={track}>
		<input type="hidden" name="id" value={r.id} />
	</form>
{/each}
<TableWrap label="Rate limits">
	<table class="fr">
		<thead>
			<tr>
				<th>Scope</th><th>Scope ID</th><th>RPM</th><th>TPM</th><th>RPD</th><th>TPD</th>
				<th>Conc.</th><th>Daily</th><th>Monthly</th><th>Actions</th>
			</tr>
		</thead>
		<tbody>
			{#each data.limits as r (r.id)}
				<tr>
					<td><Badge tone="neutral">{r.scope}</Badge></td>
					<td><code>{r.scopeId}</code></td>
					<td
						><Input form="rl-save-{r.id}" name="rpm" type="number" min="0" value={r.rpm ?? ''} size="sm" /></td
					>
					<td
						><Input form="rl-save-{r.id}" name="tpm" type="number" min="0" value={r.tpm ?? ''} size="sm" /></td
					>
					<td
						><Input form="rl-save-{r.id}" name="rpd" type="number" min="0" value={r.rpd ?? ''} size="sm" /></td
					>
					<td
						><Input form="rl-save-{r.id}" name="tpd" type="number" min="0" value={r.tpd ?? ''} size="sm" /></td
					>
					<td
						><Input
							form="rl-save-{r.id}"
							name="concurrency"
							type="number"
							min="0"
							value={r.concurrency ?? ''}
							size="sm"
						/></td
					>
					<td
						><Input
							form="rl-save-{r.id}"
							name="dailySpendUsd"
							type="number"
							min="0"
							step="0.01"
							value={r.dailySpendUsd === '—' ? '' : r.dailySpendUsd}
							size="sm"
						/></td
					>
					<td
						><Input
							form="rl-save-{r.id}"
							name="monthlySpendUsd"
							type="number"
							min="0"
							step="0.01"
							value={r.monthlySpendUsd === '—' ? '' : r.monthlySpendUsd}
							size="sm"
						/></td
					>
					<td class="actions">
						<Button type="submit" form="rl-save-{r.id}" {pending} size="sm">Save</Button>
						<Button type="submit" form="rl-del-{r.id}" {pending} size="sm" variant="danger"
							>Delete</Button
						>
					</td>
				</tr>
			{:else}
				<tr><td colspan="10"><EmptyState title="No rate limits configured" /></td></tr>
			{/each}
		</tbody>
	</table>
</TableWrap>
<Card>
	<h2 class="first">Budgets (read-only)</h2>
	<TableWrap label="Budgets">
		<table class="fr">
			<thead>
				<tr
					><th>Scope</th><th>Scope ID</th><th>Period</th><th>Amount</th><th>Warn</th><th>Critical</th
					><th>At 100%</th></tr
				>
			</thead>
			<tbody>
				{#each data.budgets as b (b.id)}
					<tr>
						<td><Badge tone="neutral">{b.scope}</Badge></td>
						<td><code>{b.scopeId}</code></td>
						<td>{b.period}</td>
						<td class="num">{formatCost(BigInt(b.amountMicro))}</td>
						<td class="num">{b.warnPercent}%</td>
						<td class="num">{b.criticalPercent}%</td>
						<td>{b.actionAt100}</td>
					</tr>
				{:else}
					<tr><td colspan="7"><EmptyState title="No budgets configured" /></td></tr>
				{/each}
			</tbody>
		</table>
	</TableWrap>
</Card>
