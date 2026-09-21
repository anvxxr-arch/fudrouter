<script>
  import { onMount } from 'svelte'
  import { api } from '../lib/api.js'
  
  let health = $state(null)
  let stats = $state(null)
  let connections = $state([])
  let providers = $state([])
  let loading = $state(true)
  let error = $state(null)
  
  onMount(async () => {
    try {
      [health, stats, connections, providers] = await Promise.all([
        api.health(),
        api.getUsageStats().catch(() => null),
        api.getConnections().catch(() => []),
        api.getProviders().catch(() => [])
      ])
    } catch (e) {
      error = e.message
    }
    loading = false
  })
  
  function fmtNum(n) {
    if (!n && n !== 0) return '0'
    if (n >= 1e9) return (n/1e9).toFixed(1) + 'B'
    if (n >= 1e6) return (n/1e6).toFixed(1) + 'M'
    if (n >= 1e3) return (n/1e3).toFixed(1) + 'K'
    return String(n)
  }
  
  function fmtMoney(n) {
    if (!n) return '$0.00'
    return '$' + n.toFixed(2)
  }
  
  let activeConns = $derived(connections.filter(c => c.isActive).length)
  let totalModels = $derived(providers.reduce((sum, p) => sum + (p.models?.length || 0), 0))
</script>

<h1>Overview</h1>

{#if loading}
  <p class="muted">Loading dashboard...</p>
{:else if error}
  <div class="card" style="border-color: var(--danger)">
    <p style="color: var(--danger)">⚠ Failed to load: {error}</p>
    <button class="btn btn-ghost" onclick={() => location.reload()}>Retry</button>
  </div>
{:else}
<div class="grid grid-4">
  <div class="card stat-card">
    <div class="stat-value" style="color: var(--success)">●</div>
    <div class="stat-label">{health?.status || 'unknown'}</div>
    <div class="stat-sub">runtime {health?.runtime || '—'}</div>
  </div>
  <div class="card stat-card">
    <div class="stat-value">{fmtNum(stats?.totalRequests)}</div>
    <div class="stat-label">Requests</div>
    <div class="stat-sub">lifetime</div>
  </div>
  <div class="card stat-card">
    <div class="stat-value">{fmtMoney(stats?.totalCost)}</div>
    <div class="stat-label">Spent</div>
    <div class="stat-sub">{new Date().toLocaleDateString()}</div>
  </div>
  <div class="card stat-card">
    <div class="stat-value">{activeConns}/{connections.length}</div>
    <div class="stat-label">Connections</div>
    <div class="stat-sub">{totalModels} models total</div>
  </div>
</div>

<div class="grid grid-2" style="margin-top: 1rem">
  <div class="card">
    <h2>Recent Connections</h2>
    {#if connections.length > 0}
      <table class="table" style="margin-top: .8rem">
        <thead><tr><th>Name</th><th>Provider</th><th>Status</th></tr></thead>
        <tbody>
          {#each connections.slice(0, 5) as c}
            <tr>
              <td>{c.name}</td>
              <td>{c.provider}</td>
              <td>
                <span class="badge" class:badge-active={c.isActive}>
                  {c.isActive ? 'active' : 'off'}
                </span>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {:else}
      <p class="muted">No connections yet</p>
    {/if}
  </div>
  
  <div class="card">
    <h2>Usage (24h)</h2>
    {#if stats?.recent}
      <table class="table" style="margin-top: .8rem">
        <thead><tr><th>Model</th><th>Requests</th><th>Cost</th></tr></thead>
        <tbody>
          {#each stats.recent.slice(0, 5) as r}
            <tr>
              <td>{r.model}</td>
              <td>{fmtNum(r.requests)}</td>
              <td>{fmtMoney(r.cost)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {:else}
      <p class="muted">No usage data yet</p>
    {/if}
  </div>
</div>
{/if}

<style>
  .stat-card { text-align: center; }
  .stat-sub { font-size: .75rem; color: var(--text-muted); margin-top: .2rem; }
</style>
