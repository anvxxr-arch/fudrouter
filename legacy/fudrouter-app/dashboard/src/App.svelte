<script lang="ts">
  import { onMount } from 'svelte';
  import { checkAuth, isAuthenticated, isLoading, error, loadAll } from './lib/stores/app';
  import Login from './lib/components/Login.svelte';
  import Dashboard from './lib/components/Dashboard.svelte';

  let ready = false;

  onMount(async () => {
    const authed = await checkAuth();
    if (authed) {
      await loadAll();
    }
    ready = true;
  });
</script>

{#if !ready}
  <div class="flex items-center justify-center min-h-screen bg-ink">
    <div class="text-glow animate-pulse">Loading...</div>
  </div>
{:else if $isAuthenticated}
  <Dashboard />
{:else}
  <Login />
{/if}

{#if $error}
  <div class="fixed bottom-4 right-4 bg-red-900/80 text-red-200 px-4 py-2 rounded-lg text-sm max-w-md">
    {$error}
  </div>
{/if}
