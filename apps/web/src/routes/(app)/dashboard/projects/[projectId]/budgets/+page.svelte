<script lang="ts">
	import { enhance } from '$app/forms';
	import { formatCost } from '$lib/format';
	import { withPending } from '$lib/forms';
	import {
		Alert,
		Badge,
		Button,
		Field,
		Guide,
		Input,
		PageHeader,
		Section,
		Select,
		TableWrap,
		UxState
	} from '$lib/ui';
	import type { Tone } from '$lib/ui';
	let { data, form } = $props();
	let pending = $state(false);
	const uxState = $derived(
		data.denied ? 'denied' : data.queryError ? 'error' : data.budgets.length ? 'success' : 'empty'
	);
	const stateTone: Record<string, Tone> = { ok: 'success', warn: 'warning', critical: 'danger', exceeded: 'danger' };
	const currency = 'USD';
</script>

<PageHeader
	title="Budgets"
	lede={`Spend guardrails for ${data.projectName || 'this project'}. Daily, weekly and monthly windows in UTC.`}
/>
<Guide id="budgets" />

{#if form?.error}
	<Alert tone="danger">{form.error}</Alert>
{/if}
{#if form?.saved}
	<Alert tone="success">Budget saved.</Alert>
{/if}
{#if form?.removed}
	<Alert tone="success">Budget removed.</Alert>
{/if}

{#if !data.denied}
	<Section title="Add or update a budget" lede="One budget per scope and period — saving again updates it.">
		<form class="grid" method="POST" action="?/save" use:enhance={withPending((v) => (pending = v))}>
			<Field label="Scope">
				<Select name="scope">
					<option value="project">This project</option>
					<option value="environment">Environment</option>
				</Select>
			</Field>
			<Field label="Environment" hint="Used when scope is Environment">
				<Select name="environmentId">
					<option value="">—</option>
					{#each data.environments as e (e.id)}
						<option value={e.id}>{e.name}</option>
					{/each}
				</Select>
			</Field>
			<Field label="Period">
				<Select name="period">
					{#each data.periods as p (p)}
						<option value={p}>{data.periodLabels[p]}</option>
					{/each}
				</Select>
			</Field>
			<Field label="Amount (USD)">
				<Input name="amount" inputmode="decimal" placeholder="25.00" required />
			</Field>
			<Field label="Warn at %">
				<Input type="number" name="warnPercent" min="0" max="100" value="70" />
			</Field>
			<Field label="Critical at %">
				<Input type="number" name="criticalPercent" min="0" max="100" value="90" />
			</Field>
			<Field label="At 100%">
				<Select name="actionAt100">
					{#each data.actions as a (a)}
						<option value={a} selected={a === 'block'}>{data.actionLabels[a]}</option>
					{/each}
				</Select>
			</Field>
			<div class="actions">
				<Button type="submit" variant="primary" {pending}>Save budget</Button>
			</div>
		</form>
	</Section>
{/if}

<UxState
	state={uxState}
	emptyTitle="No budgets yet"
	emptyHint="Add a daily, weekly or monthly budget to watch spend against an amount."
	errorWhat={data.queryError ?? undefined}
	errorWhy="Measuring budget consumption failed on the server."
>
	<Section title="Current consumption" lede="Spent inside the current UTC window against the budget amount.">
		<TableWrap label="Budgets">
			<table class="fr">
				<thead>
					<tr>
						<th>Scope</th><th>Period</th><th>Amount</th><th>Consumed</th><th>Used</th>
						<th>State</th><th>Warn / Critical</th><th>At 100%</th><th></th>
					</tr>
				</thead>
				<tbody>
					{#each data.budgets as b (b.id)}
						<tr>
							<td>{b.scopeLabel}</td>
							<td>{data.periodLabels[b.period]}</td>
							<td class="num">{formatCost(BigInt(b.amountMicro), currency)}</td>
							<td class="num">{formatCost(BigInt(b.consumedMicro), currency)}</td>
							<td class="num">{b.percent}%</td>
							<td><Badge tone={stateTone[b.state] ?? 'neutral'}>{b.state}</Badge></td>
							<td class="num">{b.warnPercent}% / {b.criticalPercent}%</td>
							<td>{data.actionLabels[b.actionAt100]}</td>
							<td>
								<form method="POST" action="?/remove" use:enhance={withPending((v) => (pending = v))}>
									<input type="hidden" name="id" value={b.id} />
									<Button type="submit" variant="danger" size="sm" {pending}>Remove</Button>
								</form>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</TableWrap>
	</Section>
</UxState>

<style>
	.grid {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-md);
		align-items: flex-end;
		margin-bottom: var(--space-lg);
	}
	.grid :global(.field) {
		width: 9.5rem;
	}
	.actions {
		display: flex;
		align-items: center;
	}
</style>
