<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../lib/api/client';
  import { providers, activeProvider } from '../stores/app';

  let models: any[] = [];
  let loading = false;
  let error = '';

  onMount(() => {
    if ($activeProvider) {
      loadModels($activeProvider);
    }
  });

  async function loadModels(providerId: string) {
    loading = true;
    error = '';
    try {
      const res = await api.listProviderModels(providerId);
      models = res.models;
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }

  $: if ($activeProvider) {
    loadModels($activeProvider);
  }
</script>

<div class="space-y-6">
  <div class="flex items-center justify-between">
    <div>
      <h3 class="text-xl font-semibold text-white">Model Browser</h3>
      <p class="text-sm text-gray-400 mt-1">Browse available models per provider</p>
    </div>
    <select
      bind:value={$activeProvider}
      class="bg-surface border border-border rounded-lg px-3 py-2 text-white text-sm"
    >
      <option value="">Select provider</option>
      {#each $providers as p}
        <option value={p.id}>{p.name}</option>
      {/each}
    </select>
  </div>

  {#if loading}
    <div class="text-center py-12 text-gray-500">Loading models...</div>
  {:else if error}
    <div class="bg-red-900/30 border border-red-800 text-red-300 px-4 py-3 rounded-lg">{error}</div>
  {:else if $activeProvider}
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      {#each models as model}
        <div class="bg-card border border-border rounded-lg p-3">
          <div class="flex items-center justify-between mb-1">
            <span class="text-sm font-medium text-white">{model.id || model.name || 'Unknown'}</span>
            {#if model.owned_by}
              <span class="text-xs text-gray-500">{model.owned_by}</span>
            {/if}
          </div>
          {#if model.description}
            <p class="text-xs text-gray-400">{model.description}</p>
          {/if}
        </div>
      {/each}
    </div>
    {#if models.length === 0}
      <div class="text-center py-12 text-gray-500">No models found for this provider</div>
    {/if}
  {:else}
    <div class="text-center py-12 text-gray-500">Select a provider to browse models</div>
  {/if}
</div>
