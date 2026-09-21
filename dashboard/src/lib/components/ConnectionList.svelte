<script lang="ts">
  import { onMount } from 'svelte';
  import { connections, loadConnections, createConnection, updateConnection, deleteConnection, testConnection, providers } from '../stores/app';

  onMount(() => {
    loadConnections();
  });

  let showForm = false;
  let editingId: string | null = null;
  let form = {
    provider: '',
    name: '',
    authType: 'apikey',
    base_url: '',
    apiKey: '',
    priority: 0,
    isActive: true,
  };

  function resetForm() {
    form = { provider: '', name: '', authType: 'apikey', base_url: '', apiKey: '', priority: 0, isActive: true };
    editingId = null;
    showForm = false;
  }

  function editConnection(conn: any) {
    editingId = conn.id;
    form = {
      provider: conn.provider,
      name: conn.name,
      authType: conn.authType || 'apikey',
      base_url: conn.base_url || '',
      apiKey: '',
      priority: conn.priority || 0,
      isActive: conn.isActive,
    };
    showForm = true;
  }

  async function handleSubmit() {
    if (!form.provider || !form.name) return;
    if (editingId) {
      await updateConnection(editingId, form);
    } else {
      await createConnection(form);
    }
    resetForm();
  }

  async function handleDelete(id: string) {
    if (confirm('Delete this connection?')) {
      await deleteConnection(id);
    }
  }

  async function handleTest(id: string) {
    const res = await testConnection(id);
    alert(`Status: ${res.status}\nMessage: ${res.message}`);
  }
</script>

<div class="space-y-6">
  <div class="flex items-center justify-between">
    <div>
      <h3 class="text-xl font-semibold text-white">Connections</h3>
      <p class="text-sm text-gray-400 mt-1">Manage your provider connections</p>
    </div>
    <button
      on:click={() => { resetForm(); showForm = true; }}
      class="text-sm bg-accent hover:bg-glow text-white px-4 py-2 rounded-lg transition-colors"
    >
      + Add Connection
    </button>
  </div>

  {#if showForm}
    <div class="bg-card border border-border rounded-xl p-4">
      <h4 class="text-sm font-semibold text-white mb-3">{editingId ? 'Edit' : 'New'} Connection</h4>
      <form on:submit|preventDefault={handleSubmit} class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label class="block text-xs text-gray-400 mb-1">Provider</label>
          <select bind:value={form.provider} class="w-full bg-surface border border-border rounded-lg px-3 py-2 text-white text-sm">
            <option value="">Select provider</option>
            {#each $providers as p}
              <option value={p.id}>{p.name}</option>
            {/each}
          </select>
        </div>
        <div>
          <label class="block text-xs text-gray-400 mb-1">Name</label>
          <input bind:value={form.name} class="w-full bg-surface border border-border rounded-lg px-3 py-2 text-white text-sm" placeholder="My Connection" />
        </div>
        <div>
          <label class="block text-xs text-gray-400 mb-1">Auth Type</label>
          <select bind:value={form.authType} class="w-full bg-surface border border-border rounded-lg px-3 py-2 text-white text-sm">
            <option value="apikey">API Key</option>
            <option value="oauth">OAuth</option>
          </select>
        </div>
        <div>
          <label class="block text-xs text-gray-400 mb-1">Base URL</label>
          <input bind:value={form.base_url} class="w-full bg-surface border border-border rounded-lg px-3 py-2 text-white text-sm" placeholder="https://api.example.com" />
        </div>
        <div>
          <label class="block text-xs text-gray-400 mb-1">API Key</label>
          <input bind:value={form.apiKey} type="password" class="w-full bg-surface border border-border rounded-lg px-3 py-2 text-white text-sm" placeholder="sk-..." />
        </div>
        <div>
          <label class="block text-xs text-gray-400 mb-1">Priority</label>
          <input bind:value={form.priority} type="number" class="w-full bg-surface border border-border rounded-lg px-3 py-2 text-white text-sm" />
        </div>
        <div class="md:col-span-2 flex items-center gap-3">
          <label class="flex items-center gap-2 text-sm text-gray-300">
            <input type="checkbox" bind:checked={form.isActive} class="rounded" />
            Active
          </label>
        </div>
        <div class="md:col-span-2 flex gap-2">
          <button type="submit" class="bg-accent hover:bg-glow text-white px-4 py-2 rounded-lg text-sm transition-colors">
            {editingId ? 'Update' : 'Create'}
          </button>
          <button type="button" on:click={resetForm} class="bg-surface hover:bg-border text-gray-300 px-4 py-2 rounded-lg text-sm transition-colors border border-border">
            Cancel
          </button>
        </div>
      </form>
    </div>
  {/if}

  <div class="space-y-2">
    {#each $connections as conn}
      <div class="bg-card border border-border rounded-xl p-4 flex items-center justify-between">
        <div class="flex items-center gap-4">
          <div class="w-10 h-10 rounded-lg bg-surface flex items-center justify-center text-lg">
            {conn.authType === 'oauth' ? '🔐' : '🔑'}
          </div>
          <div>
            <h4 class="font-medium text-white">{conn.name}</h4>
            <p class="text-xs text-gray-400">{conn.provider} · {conn.authType} · Priority {conn.priority}</p>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-xs px-2 py-0.5 rounded-full {conn.isActive ? 'bg-green-900/30 text-green-400' : 'bg-gray-800 text-gray-500'}">
            {conn.isActive ? 'Active' : 'Inactive'}
          </span>
          <button on:click={() => handleTest(conn.id)} class="text-xs bg-surface hover:bg-border text-gray-300 px-3 py-1.5 rounded-lg transition-colors border border-border">
            Test
          </button>
          <button on:click={() => editConnection(conn)} class="text-xs bg-surface hover:bg-border text-gray-300 px-3 py-1.5 rounded-lg transition-colors border border-border">
            Edit
          </button>
          <button on:click={() => handleDelete(conn.id)} class="text-xs bg-red-900/20 hover:bg-red-900/40 text-red-300 px-3 py-1.5 rounded-lg transition-colors border border-red-900/30">
            Delete
          </button>
        </div>
      </div>
    {/each}
  </div>

  {#if $connections.length === 0}
    <div class="text-center py-12 text-gray-500">
      <p>No connections yet. Add your first provider connection.</p>
    </div>
  {/if}
</div>
