<script>
  import { onMount } from 'svelte'
  import { api } from '../lib/api.js'
  
  let stats = $state(null)
  let history = $state([])
  let loading = $state(true)
  
  onMount(async () => {
    try {
      [stats, history] = await Promise.all([
        api.getUsageStats().catch(() => null),
        api.getUsageHistory().catch(() => [])
      ])
    } catch (e) {
      console.error(e)
    }
    loading = false
  })
  
  function fmtNum(n) {
    if (!n) return '0'
    if (n >= 1e9) return (n/1e9).toFixed(1) + 'B'
    if (n >= 1e6) return (n/1e6).toFixed(1) + 'M'
    if (n >= 1e3) return (n/1e3).toFixed(1) + 'K'
    return String(n)
  }
  
  function fmtMoney(n) {
    if (!n) return '$0.00'
    return '$' + n.toFixed(2)
  }
</script>

<h1>Usage</h1>

{#if loading}
  <p class="muted">Loading...</p>
{:else}
<div class="grid grid-4">
  <div class="card stat-card">
    <div class="stat-value">{fmtNum(stats?.totalRequests)}</div>
    <div class="stat-label">Total Requests</div>
  </div>
  <div class="card stat-card">
    <div class="stat-value">{fmtMoney(stats?.totalCost)}</div>
    <div class="stat-label">Total Cost</div>
  </div>
  <div class="card stat-card">
    <div class="stat-value">{fmtNum(stats?.promptTokens)}</div>
    <div class="stat-label">Prompt Tokens</div>
  </div>
  <div class="card stat-card">
    <div class="stat-value">{fmtNum(stats?.completionTokens)}</div>
    <div class="stat-label">Completion Tokens</div>
  </div>
</div>

<h2>History</h2>
{#if history.length > 0}
  <div class="card">
    <table class="table">
      <thead><tr><th>Time</th><th>Provider</th><th>Model</th><th>Prompt</th><th>Completion</th><th>Cost</th><th>Status</th></tr></thead>
      <tbody>
        {#each history.slice(0, 50) as h}
          <tr>
            <td class="muted" style="font-size:.75rem">{new Date(h.timestamp).toLocaleString()}</td>
            <td>{h.provider}</td>
            <td>{h.model}</td>
            <td>{fmtNum(h.promptTokens)}</td>
            <td>{fmtNum(h.completionTokens)}</td>
            <td>{fmtMoney(h.cost)}</td>
            <td><span class="badge" class:badge-active={h.status === 'ok'} class:badge-error={h.status !== 'ok'}>{h.status}</span></td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{:else}
  <p class="muted">No usage history yet</p>
{/if}
{/if}

<style>
  .stat-card { text-align: center; }
</style>
