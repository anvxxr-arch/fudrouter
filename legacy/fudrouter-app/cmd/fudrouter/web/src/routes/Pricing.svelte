<script>
  import { onMount } from 'svelte'
  import { api } from '../lib/api.js'
  
  let catalog = $state([])
  let search = $state('')
  let loading = $state(true)
  
  onMount(async () => {
    try {
      catalog = await api.getCatalog()
    } catch (e) {
      console.error(e)
    }
    loading = false
  })
  
  let filtered = $derived(catalog.filter(m => {
    const q = search.toLowerCase()
    return !q || m.id?.toLowerCase().includes(q) || m.provider?.toLowerCase().includes(q)
  }))
  
  function fmtPrice(p) {
    if (!p) return '-'
    return '$' + p.toFixed(6)
  }
</script>

<h1>Pricing</h1>

{#if loading}
  <p class="muted">Loading...</p>
{:else}
  <input class="input" placeholder="Search models..." bind:value={search} style="max-width:300px; margin-bottom:1rem" />
  
  {#if filtered.length > 0}
    <div class="card">
      <table class="table">
        <thead><tr><th>Model</th><th>Provider</th><th>Input</th><th>Output</th><th>Cache Read</th><th>Cache Write</th></tr></thead>
        <tbody>
          {#each filtered as m}
            <tr>
              <td>{m.id}</td>
              <td>{m.provider || '-'}</td>
              <td>{fmtPrice(m.inputPrice || m.input_price)}</td>
              <td>{fmtPrice(m.outputPrice || m.output_price)}</td>
              <td>{fmtPrice(m.cacheReadPrice || m.cache_read_price)}</td>
              <td>{fmtPrice(m.cacheWritePrice || m.cache_write_price)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else}
    <p class="muted">No pricing data</p>
  {/if}
{/if}
