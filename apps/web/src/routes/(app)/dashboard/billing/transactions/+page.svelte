<script lang="ts">
	import { formatDateTime } from '$lib/format';
	import { Button, EmptyState, Guide, PageHeader, TableWrap } from '$lib/ui';
	import { formatMicroSigned, typeLabel } from '../billing-format';
	let { data } = $props();
	/**
	 * Export the rendered rows as CSV in the browser — same columns the server
	 * declares, so a download is never a second code path with its own drift.
	 * No server export action exists; the cursor keeps paging server-side.
	 */
	function downloadCsv() {
		const esc = (v: string | null) => `"${(v ?? '').replace(/"/g, '""')}"`;
		const lines = [data.csvHeaders.join(',')];
		for (const r of data.rows) {
			lines.push(
				[
					esc(r.id),
					esc(r.createdAt),
					esc(r.type),
					esc(r.amountMicro),
					esc(r.currency),
					esc(r.requestId),
					esc(r.idempotencyKey),
					esc(r.description),
					esc(r.createdBy)
				].join(',')
			);
		}
		const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv' });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = 'transactions.csv';
		a.click();
		URL.revokeObjectURL(a.href);
	}
</script>
<PageHeader
	title="Transactions"
	lede="The raw ledger, newest first, in export-friendly columns."
/>
{#if data.rows.length > 0}
	<div class="export"><Button onclick={downloadCsv}>Download CSV ({data.rows.length} rows)</Button></div>
{/if}
<TableWrap label="Transactions">
	<table class="fr">
		<thead>
			<tr><th>ID</th><th>When (UTC)</th><th>Type</th><th>Amount</th><th>Request</th><th>Description</th></tr>
		</thead>
		<tbody>
			{#each data.rows as r (r.id)}
				<tr>
					<td class="num">{r.id}</td>
					<td class="num">{formatDateTime(new Date(r.createdAt))}</td>
					<td>{typeLabel(r.type)}</td>
					<td class="num">{formatMicroSigned(r.amountMicro, r.currency)}</td>
					<td>{r.requestId ?? '—'}</td>
					<td>{r.description ?? '—'}</td>
				</tr>
			{:else}
				<tr
					><td colspan="6"
						><EmptyState title="No transactions yet" hint="Billed requests and credit purchases land here."
					/></td></tr
				>
			{/each}
		</tbody>
	</table>
</TableWrap>
{#if data.nextCursor}
	<p><a href="/dashboard/billing/transactions?cursor={data.nextCursor}">Next page →</a></p>
{/if}
<nav class="billing-nav" aria-label="Billing sections">
	<a href="/dashboard/billing">Overview</a>
	<a href="/dashboard/billing/credits">Credits & ledger</a>
	<a href="/dashboard/billing/invoices">Invoices</a>
	<a href="/dashboard/billing/payment-methods">Payment methods</a>
</nav>
<Guide id="billing.transactions" />

<style>
	.export {
		margin-bottom: var(--space-md);
	}
	.billing-nav {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-md);
		margin-top: var(--space-xl);
	}
</style>
