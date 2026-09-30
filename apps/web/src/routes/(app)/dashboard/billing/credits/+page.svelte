<script lang="ts">
	import { enhance } from '$app/forms';
	import { formatDateTime, formatTokens } from '$lib/format';
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
		StatCard,
		TableWrap
	} from '$lib/ui';
	import { formatMicro, formatMicroSigned, ledgerLine, typeLabel, type Micro } from '../billing-format';
	import { withPending } from '$lib/forms';
	let { data, form } = $props();
	// $state declarations sit above the $deriveds that read through them, or
	// svelte-check reports "$state used before its declaration".
	let pending = $state(false);
	const track = withPending((v) => (pending = v));
	const currency = $derived(data.currency);
	const toneFor = (type: string): 'danger' | 'neutral' | 'success' =>
	type === 'usage_charge' ? 'danger' : type === 'refund' ? 'neutral' : 'success';
</script>
<PageHeader
	title="Credits"
	lede="Every posting on the ledger, with the balance it left behind."
/>
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
{#if form?.added}<div class="fr-feedback"><Alert tone="success">Credit purchase recorded.</Alert></div>{/if}
{#if form?.already}
	<div class="fr-feedback"><Alert tone="info">That purchase was already recorded — nothing was added twice.</Alert></div>
{/if}
<section class="fr-stats">
	<StatCard label="Balance" value={formatMicro(data.balanceMicro as Micro, currency)} />
</section>
<div class="grid2">
	<Card>
		<h2>Add credits</h2>
		{#if data.canWrite}
			<p class="muted">
				Records a <code>credit_purchase</code> on the ledger. Payment processing is out of scope —
				credits are added manually or granted by an administrator.
			</p>
			<form method="POST" action="?/add" use:enhance={track} class="stack">
				<Field label="Amount (USD)" hint="How many credits to add, e.g. 100 or 25.50.">
					<Input name="amount" inputmode="decimal" placeholder="100.00" required />
				</Field>
				<Field label="Description" hint="Why these credits were added.">
					<Input name="description" placeholder="Credit purchase" />
				</Field>
				<input type="hidden" name="key" value={data.addCreditKey} />
				<Button type="submit" variant="primary" {pending}>Add credits</Button>
			</form>
		{:else}
			<p class="muted">
				You need <code>billing.write</code> to add credits. An administrator can add them for you.
			</p>
		{/if}
	</Card>
	<Card>
		<h2>Filter</h2>
		<nav class="filters" aria-label="Ledger type filter">
			<a href="/dashboard/billing/credits" class:active={!data.filter}>all</a>
			{#each data.types as t (t)}
				<a href="/dashboard/billing/credits?type={t}" class:active={data.filter === t}>{typeLabel(t)}</a>
			{/each}
		</nav>
	</Card>
</div>
<h2>Ledger</h2>
<TableWrap label="Credit ledger">
	<table class="fr">
		<thead>
			<tr><th>When</th><th>Entry</th><th>Amount</th><th>Balance</th><th>Reference</th></tr>
		</thead>
		<tbody>
			{#each data.rows as r (r.id)}
				{@const entry = ledgerLine({ type: r.type, amountMicro: r.amountMicro, currency: r.currency })}
				<tr>
					<td class="num">{formatDateTime(new Date(r.createdAt))}</td>
					<td><Badge tone={toneFor(r.type)}>{entry.label}</Badge></td>
					<td class="num">{entry.amountLabel}</td>
					<td class="num">{formatMicroSigned(r.runningBalance as string, r.currency)}</td>
					<td>{r.description ?? r.requestId ?? '—'}</td>
				</tr>
			{:else}
				<tr
					><td colspan="5"
						><EmptyState
							title={data.filter ? 'Nothing of this type yet' : 'The ledger is empty'}
							hint="Entries appear as requests are billed and credits are added."
						/></td
					></tr
				>
			{/each}
		</tbody>
	</table>
</TableWrap>
<p class="muted">
	The {data.rows.length} newest entries
	{#if data.filter}(filtered to {typeLabel(data.filter)}){/if}. The balance column is the running
	ledger balance after each entry.
</p>
<nav class="billing-nav" aria-label="Billing sections">
	<a href="/dashboard/billing">Overview</a>
	<a href="/dashboard/billing/transactions">Transactions</a>
	<a href="/dashboard/billing/invoices">Invoices</a>
	<a href="/dashboard/billing/payment-methods">Payment methods</a>
</nav>
<Guide id="billing.credits" />

<style>
	.grid2 {
		display: grid;
		gap: var(--space-lg);
		grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr));
	}
	.stack {
		display: grid;
		gap: var(--space-md);
		justify-items: start;
	}
	.filters {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-sm);
	}
	.filters a {
		min-height: 24px;
		display: inline-flex;
		align-items: center;
		padding: var(--space-xs) var(--space-sm);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md, 8px);
		font-size: var(--text-sm);
	}
	.filters a.active {
		border-color: var(--color-text);
		font-weight: 600;
	}
	.billing-nav {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-md);
		margin-top: var(--space-xl);
	}
</style>
