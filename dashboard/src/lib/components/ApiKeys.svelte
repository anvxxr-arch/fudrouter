<script lang="ts">
  import { onMount } from 'svelte';
  import { apiKeys, loadApiKeys, createKey, deleteKey } from '../stores/app';

  onMount(() => {
    loadApiKeys();
  });

  let newKeyName = '';
  let createdKey: string | null = null;

  async function handleCreate() {
    if (!newKeyName) return;
    const res = await createKey(newKeyName);
    createdKey = res.key;
    newKeyName = '';
    await loadApiKeys();
  }

  async function handleDelete(id: string) {
    if (confirm('Delete this API key?')) {
      await deleteKey(id);
    }
  }

  function copyKey(key: string) {
    navigator.clipboard.writeText(key);
  }
</script>

<div class="space-y-6">
  <div class="flex items-center justify-between">
    <div>
      <h3 class="text-xl font-semibold text-white">API Keys</h3>
      <p class="text-sm text-gray-400 mt-1">Manage access keys for the Go API</p>
    </div>
  </div>

  <div class="bg-card border border-border rounded-xl p-4">
    <h4 class="text-sm font-semibold text-white mb-3">Create New Key</h4>
    <div class="flex gap-2">
      <input
        bind:value={newKeyName}
        class="flex-1 bg-surface border border-border rounded-lg px-3 py-2 text-white text-sm"
        placeholder="Key name (e.g., My App)"
      />
      <button
        on:click={handleCreate}
        disabled={!newKeyName}
        class="bg-accent hover:bg-glow disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm transition-colors"
      >
        Create
      </button>
    </div>

    {#if createdKey}
      <div class="mt-3 bg-green-900/20 border border-green-800 rounded-lg p-3">
        <p class="text-xs text-green-400 mb-1">Key created (copy it now — it won't be shown again):</p>
        <code class="text-xs text-green-300 break-all">{createdKey}</code>
      </div>
    {/if}
  </div>

  <div class="space-y-2">
    {#each $apiKeys as key}
      <div class="bg-card border border-border rounded-xl p-4 flex items-center justify-between">
        <div>
          <h4 class="font-medium text-white">{key.name}</h4>
          <p class="text-xs text-gray-400 font-mono">{key.key}</p>
          {#if key.machineId}
            <p class="text-xs text-gray-500">Machine: {key.machineId}</p>
          {/if}
        </div>
        <div class="flex items-center gap-2">
          <span class="text-xs px-2 py-0.5 rounded-full {key.isActive ? 'bg-green-900/30 text-green-400' : 'bg-gray-800 text-gray-500'}">
            {key.isActive ? 'Active' : 'Inactive'}
          </span>
          <button on:click={() => copyKey(key.key)} class="text-xs bg-surface hover:bg-border text-gray-300 px-3 py-1.5 rounded-lg transition-colors border border-border">
            Copy
          </button>
          <button on:click={() => handleDelete(key.id)} class="text-xs bg-red-900/20 hover:bg-red-900/40 text-red-300 px-3 py-1.5 rounded-lg transition-colors border border-red-900/30">
            Delete
          </button>
        </div>
      </div>
    {/each}
  </div>

  {#if $apiKeys.length === 0}
    <div class="text-center py-12 text-gray-500">
      <p>No API keys yet. Create one to get started.</p>
    </div>
  {/if}
</div>
