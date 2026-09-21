<script>
  import { onMount } from 'svelte'
  import { api } from '../lib/api.js'
  
  let models = $state([])
  let search = $state('')
  let providerFilter = $state('')
  let loading = $state(true)
  
  onMount(async () => {
    try {
      models = await api.getModels()
    } catch (e) {
      console.error(e)
    }
    loading = false
  })
  
  let providersList = $derived([...new Set(models.map(m => m.provider).filter(Boolean))])
  
  let filtered = $derived(models.filter(m => {
    const q = search.toLowerCase()
    const matchesSearch = !q || m.id?.toLowerCase().includes(q) || m.provider?.toLowerCase().includes(q)
    const matchesProvider = !providerFilter || m.provider === providerFilter
    return matchesSearch && matchesProvider
  }))
</script>

<h1>Models</h1>

{#if loading}
  <p class="muted">Loading...</p>
{:else}
  <div class="filters">
    <input class="input" placeholder="Search models..." bind:value={search} />
    <select class="input" bind:value={providerFilter}>
      <option value="">All providers</option>
      {#each providersList as p}
        <option value={p}>{p}</option>
      {/each}
    </select>
    <span class="muted" style="align-self:center">{filtered.length} of {models.length}</span>
  </div>
  
  {#if filtered.length > 0}
    <div class="card" style="margin-top:1rem">
      <table class="table">
        <thead><tr><th>Model ID</th><th>Provider</th><th>Owned By</th></tr></thead>
        <tbody>
          {#each filtered as m}
            <tr>
              <td>{m.id}</td>
              <td>{m.provider || '-'}</td>
              <td class="muted">{m.ownedBy || m.owned_by || '-'}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else}
    <p class="muted" style="text-align:center; padding:2rem">No models match your search</p>
  {/if}
{/if}

<style>
  .filters { display: flex; gap: .8rem; margin-bottom: 0; }
  .filters .input { max-width: 300px; }
</style>
