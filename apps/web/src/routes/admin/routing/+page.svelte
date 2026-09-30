<script lang="ts">
	import {
		Badge,
		ButtonLink,
		Card,
		EmptyState,
		Guide,
		PageHeader,
		TableWrap
	} from '$lib/ui';
	let { data } = $props();
	const SCOPE_TONE: Record<string, 'info' | 'neutral' | 'success'> = {
		platform: 'info',
		workspace: 'neutral',
		project: 'neutral',
		environment: 'success'
	};
</script>
<PageHeader
	title="Routing"
	lede="How a request finds its provider: environment → project → workspace → platform default."
/>
<Card>
	<h2 class="first">Resolution chain</h2>
	<p class="muted">
		Each scope level overrides the one below it. An environment with no policy of its own falls
		through to its project, then its workspace, then the platform default
		{#if data.platformDefaultName}
			(<strong>{data.platformDefaultName}</strong>)
		{:else}
			(<strong>unset</strong> — pick one on the Policies page)
		{/if}
		.
	</p>
	<TableWrap label="Policy resolution per environment">
		<table class="fr">
			<thead>
				<tr><th>Environment</th><th>Project</th><th>Workspace</th><th>Resolves to</th></tr>
			</thead>
			<tbody>
				{#each data.chain as c (c.environment + c.project)}
					<tr>
						<td>{c.environment}</td>
						<td>{c.project}</td>
						<td>{c.workspace}</td>
						<td>
							{#if c.policyId}
								<Badge tone="success">{c.policyName ?? c.policyId}</Badge>
								<span class="muted">own policy</span>
							{:else if data.platformDefaultName}
								<Badge tone="info">{data.platformDefaultName}</Badge>
								<span class="muted">platform default</span>
							{:else}
								<Badge tone="warning">unresolved</Badge>
							{/if}
						</td>
					</tr>
				{:else}
					<tr><td colspan="4"><EmptyState title="No environments yet" /></td></tr>
				{/each}
			</tbody>
		</table>
	</TableWrap>
</Card>
<Card>
	<h2 class="fr-label">Routing areas</h2>
	<div class="links">
		<ButtonLink href="/admin/routing/policies">Policies</ButtonLink>
		<ButtonLink href="/admin/routing/strategies">Strategies</ButtonLink>
		<ButtonLink href="/admin/routing/fallbacks">Fallbacks</ButtonLink>
		<ButtonLink href="/admin/routing/circuit-breakers">Circuit breakers</ButtonLink>
		<ButtonLink href="/admin/routing/simulations">Simulations</ButtonLink>
	</div>
</Card>
<Guide id="admin-routing" />
<TableWrap label="Routing policies">
	<table class="fr">
		<thead>
			<tr
				><th>Name</th><th>Scope</th><th>Strategy</th><th>Max attempts</th><th>Fallback</th><th
					>Status</th
				></tr
			>
		</thead>
		<tbody>
			{#each data.policies as p (p.id)}
				<tr>
					<td>{p.name}</td>
					<td><Badge tone={SCOPE_TONE[p.scope] ?? 'neutral'}>{p.scopeName}</Badge></td>
					<td><code>{p.strategy}</code></td>
					<td class="num">{p.maxAttempts}</td>
					<td><Badge tone={p.fallbackEnabled ? 'success' : 'neutral'}>{p.fallbackEnabled ? 'on' : 'off'}</Badge></td>
					<td><Badge tone={p.enabled ? 'success' : 'warning'}>{p.enabled ? 'enabled' : 'disabled'}</Badge></td>
				</tr>
			{:else}
				<tr><td colspan="6"><EmptyState title="No routing policies yet" hint="Create one on the Policies page." /></td></tr>
			{/each}
		</tbody>
	</table>
</TableWrap>
<style>
	h2.first {
		margin-top: 0;
	}
	.links {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-md);
	}
</style>
