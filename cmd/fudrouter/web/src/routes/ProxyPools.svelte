<script>
  import { onMount } from 'svelte'
  import { api } from '../lib/api.js'
  
  let pools = $state([])
  let loading = $state(true)
  
  onMount(async () => {
    try {
      pools = await api.getProxyPools()
    } catch (e) {
      console.error(e)
    }
    loading = false
  })
</script>

<h1>Proxy Pools</h1>

{#if loading}
  <p class="muted">Loading...</p>
{:else if pools.length > 0}
  <div class="card">
    <table class="table">
      <thead><tr><th>ID</th><th>Status</th><th>Test Status</th><th>Data</th></tr></thead>
      <tbody>
        {#each pools as p}
          <tr>
            <td>{p.id.substring(0, 8)}...</td>
            <td><span class="badge badge-active">{p.isActive ? 'Active' : 'Off'}</span></td>
            <td>{p.testStatus || 'untested'}</td>
            <td class="muted" style="font-size:.75rem">{JSON.stringify(p.data || {}).substring(0, 50)}...</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{:else}
  <div class="empty">
    <p class="muted">No proxy pools configured</p>
  </div>
{/if}

<style>
  .empty { display: flex; flex-direction: column; align-items: center; gap: .5rem; padding: 3rem; }
</style>
