<script>
  import { onMount } from 'svelte'
  import { api } from '../lib/api.js'
  
  let providers = $state([])
  let loading = $state(true)
  
  onMount(async () => {
    try {
      providers = await api.getProviders()
    } catch (e) {
      console.error(e)
    }
    loading = false
  })
</script>

<h1>Providers</h1>

{#if loading}
  <p class="muted">Loading...</p>
{:else if providers.length > 0}
  <div class="grid grid-3">
    {#each providers as p}
      <div class="card provider-card">
        <div class="provider-header">
          <h3>{p.name || p.id}</h3>
          <span class="badge badge-active">{p.models?.length || 0} models</span>
        </div>
        {#if p.description}
          <p class="muted" style="font-size:.8rem; margin-top:.3rem">{p.description}</p>
        {/if}
        {#if p.baseUrl}
          <p class="muted" style="font-size:.7rem; margin-top:.5rem">{p.baseUrl}</p>
        {/if}
      </div>
    {/each}
  </div>
{:else}
  <p class="muted">No providers available</p>
{/if}

<style>
  .provider-card { transition: transform 0.15s; }
  .provider-card:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
  .provider-header { display: flex; justify-content: space-between; align-items: start; }
</style>
