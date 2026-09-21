<script lang="ts">
  import { onMount } from 'svelte';
  import { providers, loadProviders, activeProvider } from '../stores/app';

  onMount(() => {
    loadProviders();
  });

  function selectProvider(id: string) {
    activeProvider.set(id);
  }
</script>

<div class="space-y-6">
  <div class="flex items-center justify-between">
    <div>
      <h3 class="text-xl font-semibold text-white">Providers</h3>
      <p class="text-sm text-gray-400 mt-1">Available AI providers and their status</p>
    </div>
    <button
      on:click={loadProviders}
      class="text-sm bg-surface hover:bg-border text-gray-300 px-4 py-2 rounded-lg transition-colors border border-border"
    >
      🔄 Refresh
    </button>
  </div>

  <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
    {#each $providers as provider}
      <button
        on:click={() => selectProvider(provider.id)}
        class="bg-card border border-border rounded-xl p-4 text-left hover:border-accent/50 transition-colors group"
      >
        <div class="flex items-start justify-between mb-2">
          <h4 class="font-semibold text-white group-hover:text-glow transition-colors">{provider.name}</h4>
          <span class="text-xs bg-surface text-gray-400 px-2 py-0.5 rounded-full">{provider.id}</span>
        </div>
        {#if provider.description}
          <p class="text-sm text-gray-400 mb-3">{provider.description}</p>
        {/if}
        {#if provider.authModes}
          <div class="flex flex-wrap gap-1">
            {#each provider.authModes as mode}
              <span class="text-xs bg-accent/10 text-glow px-2 py-0.5 rounded-full border border-accent/20">{mode}</span>
            {/each}
          </div>
        {/if}
      </button>
    {/each}
  </div>

  {#if $providers.length === 0}
    <div class="text-center py-12 text-gray-500">
      <p>No providers available</p>
    </div>
  {/if}
</div>
