<script>
  import { onMount } from 'svelte'
  import { api } from '../lib/api.js'
  
  let quotas = $state([])
  let loading = $state(true)
  
  onMount(async () => {
    try {
      quotas = await api.getQuotas?.() ?? []
    } catch (e) {
      console.error(e)
    }
    loading = false
  })
</script>

<h1>Quota</h1>

{#if loading}
  <p class="muted">Loading...</p>
{:else if quotas.length > 0}
  <div class="card">
    <table class="table">
      <thead><tr><th>Provider</th><th>Limit</th><th>Used</th><th>Remaining</th><th>Period</th></tr></thead>
      <tbody>
        {#each quotas as q}
          <tr>
            <td>{q.provider}</td>
            <td>{q.limit}</td>
            <td>{q.used}</td>
            <td>{q.remaining}</td>
            <td>{q.period}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{:else}
  <div class="empty">
    <p class="muted">No quota data available</p>
  </div>
{/if}

<style>
  .empty { display: flex; flex-direction: column; align-items: center; gap: .5rem; padding: 3rem; }
</style>
