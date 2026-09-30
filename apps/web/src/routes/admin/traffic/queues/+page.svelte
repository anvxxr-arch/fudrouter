<script lang="ts">
	import { formatDateTime } from '$lib/format';
	import {
		Badge,
		ButtonLink,
		Card,
		EmptyState,
		Guide,
		PageHeader,
		StatCard,
		TableWrap
	} from '$lib/ui';
	let { data } = $props();
	const byStatus = $derived(
		(() => {
			const out = new Map<string, number>();
			for (const c of data.counts) out.set(c.status, (out.get(c.status) ?? 0) + c.n);
			return [...out.entries()].map(([status, n]) => ({ status, n }));
		})()
	);
</script>
<PageHeader
	title="Queues"
	lede="Background jobs waiting on workers, and how busy the request path is."
/>
<section class="stats">
	<StatCard label="Requests in flight (last minute)" value={data.inFlightLastMinute.toLocaleString()} />
	{#each byStatus as s (s.status)}
		<StatCard label={`Jobs ${s.status}`} value={s.n.toLocaleString()} />
	{/each}
</section>
<Guide id="admin-traffic-queues" />
<Card>
	<h2 class="first">Jobs by status and type</h2>
	<TableWrap label="Jobs by status and type">
		<table class="fr">
			<thead><tr><th>Status</th><th>Type</th><th>Count</th></tr></thead>
			<tbody>
				{#each data.counts as c (c.status + c.type)}
					<tr>
						<td
							><Badge
								tone={c.status === 'pending'
									? 'neutral'
									: c.status === 'running'
										? 'success'
										: 'danger'}>{c.status}</Badge
							></td
						>
						<td><code>{c.type}</code></td>
						<td class="num">{c.n.toLocaleString()}</td>
					</tr>
				{:else}
					<tr><td colspan="3"><EmptyState title="No jobs recorded" /></td></tr>
				{/each}
			</tbody>
		</table>
	</TableWrap>
</Card>
<Card>
	<h2 class="first">Pending & running</h2>
	<TableWrap label="Pending and running jobs">
		<table class="fr">
			<thead>
				<tr
					><th>ID</th><th>Type</th><th>Attempts</th><th>Available at</th><th>Error</th></tr
				>
			</thead>
			<tbody>
				{#each data.live as j (j.id)}
					<tr>
						<td><code>{j.id}</code></td>
						<td><code>{j.type}</code></td>
						<td class="num">{j.attempts}/{j.maxAttempts}</td>
						<td class="num">{formatDateTime(new Date(j.availableAt))}</td>
						<td>{j.error ?? '—'}</td>
					</tr>
				{:else}
					<tr><td colspan="5"><EmptyState title="Nothing queued" /></td></tr>
				{/each}
			</tbody>
		</table>
	</TableWrap>
	<div class="submit">
		<ButtonLink href="/admin/system/jobs">Manage jobs</ButtonLink>
	</div>
</Card>
