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
	import { formatMicro, formatMicroSigned, microToDecimal, type Micro } from './billing-format';
	import { withPending } from '$lib/forms';
	let { data, form } = $props();
	// Runes: every $state declaration sits above the first use of its variable,
	// or svelte-check reports "$state used before its declaration".
	let pending = $state(false);
	const track = withPending((v) => (pending = v));
	const currency = $derived(data.currency);
	const balance = $derived(data.balanceMicro as Micro);
	// The call-out only matters when something is actually low: balance at or
	// under the hard stop (router rejects with INSUFFICIENT_CREDITS, spec §10)
	// or under the warning threshold.
	// `balanceState`, not `state`: a binding named `state` next to the $state
	// rune trips svelte-check's rune parser ("Cannot use 'state' as a store").
	const balanceState = $derived.by(() => {
		const b = BigInt(data.balanceMicro);
		if (b <= BigInt(data.hardStopThresholdMicro)) return 'stopped';
		if (b < BigInt(data.warningThresholdMicro)) return 'warn';
		return 'ok';
	});
</script>
<PageHeader title="Billing" lede="Account balance, low-balance thresholds, and this period's spend." />
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
{#if form?.saved}<div class="fr-feedback"><Alert tone="success">Thresholds saved.</Alert></div>{/if}
{#if balanceState === 'stopped'}
	<div class="fr-feedback">
		<Alert tone="danger">
			<strong>Hard stop reached.</strong> The balance is at or below the hard-stop threshold, so the
			router rejects requests with <code>INSUFFICIENT_CREDITS</code>. Add credits to resume.
		</Alert>
	</div>
{:else if balanceState === 'warn'}
	<div class="fr-feedback">
		<Alert tone="warning">
			Balance is below the warning threshold — add credits before it hits the hard stop.
		</Alert>
	</div>
{/if}
<section class="fr-stats">
	<StatCard label="Balance" value={formatMicro(balance, currency)} />
	<StatCard label="Currency" value={currency} />
	<StatCard label="Status" value={data.status} />
	<StatCard label="This period" value={formatMicro(data.period.spentMicro, currency)} />
</section>
<p class="muted">
	Current period ({formatDateTime(new Date(data.period.start))} → {formatDateTime(
		new Date(data.period.end)
	)}) — {formatTokens(data.period.requests)} billed requests.
</p>
<div class="grid2">
	<Card>
		<h2>Low-balance thresholds</h2>
		<p class="muted">
			The router warns below the warning threshold and rejects requests at or below the hard stop
			(spec §10).
		</p>
		{#if data.canWrite}
			<form method="POST" action="?/thresholds" use:enhance={track} class="stack">
				<Field label="Warning threshold (USD)" hint="Alerts fire below this balance.">
					<Input
						name="warning"
						value={microToDecimal(data.warningThresholdMicro)}
						inputmode="decimal"
						required
					/>
				</Field>
				<Field
					label="Hard-stop threshold (USD)"
					hint="Requests are rejected at or below this balance (INSUFFICIENT_CREDITS)."
				>
					<Input
						name="hard_stop"
						value={microToDecimal(data.hardStopThresholdMicro)}
						inputmode="decimal"
						required
					/>
				</Field>
				<Button type="submit" variant="primary" {pending}>Save thresholds</Button>
			</form>
		{:else}
			<p class="muted">
				Current: warn below {formatMicro(data.warningThresholdMicro, currency)}, hard stop at {formatMicro(
					data.hardStopThresholdMicro,
					currency
				)}. You need <code>billing.write</code> to change them.
			</p>
		{/if}
	</Card>
	<Card>
		<h2>Low-balance alerts</h2>
		<p class="muted">Alert events fired at your thresholds, newest first.</p>
		<TableWrap label="Low-balance alerts">
			<table class="fr">
				<thead><tr><th>When</th><th>Balance</th><th>State</th><th>Message</th></tr></thead>
				<tbody>
					{#each data.events as e (e.id)}
						<tr>
							<td class="num">{formatDateTime(new Date(e.triggeredAt))}</td>
							<td class="num">{formatMicroSigned(BigInt(e.valueMicro), currency)}</td>
							<td><Badge tone={e.state === 'firing' ? 'warning' : 'success'}>{e.state}</Badge></td>
							<td>{e.message}</td>
						</tr>
					{:else}
						<tr
							><td colspan="4"
								><EmptyState
									title="No alerts yet"
									hint="An event appears when the balance crosses a threshold."
								/></td
							></tr
						>
					{/each}
				</tbody>
			</table>
		</TableWrap>
	</Card>
</div>
<nav class="billing-nav" aria-label="Billing sections">
	<a href="/dashboard/billing/credits">Credits & ledger</a>
	<a href="/dashboard/billing/transactions">Transactions</a>
	<a href="/dashboard/billing/invoices">Invoices</a>
	<a href="/dashboard/billing/payment-methods">Payment methods</a>
</nav>
<Guide id="billing" />

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
	.billing-nav {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-md);
		margin-top: var(--space-xl);
	}
</style>
