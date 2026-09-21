<script lang="ts">
  import { onMount } from 'svelte';
  import { isAuthenticated, activeView, logout, loadAll } from '../stores/app';
  import Sidebar from './Sidebar.svelte';
  import Header from './Header.svelte';
  import ProviderList from './ProviderList.svelte';
  import ConnectionList from './ConnectionList.svelte';
  import ModelBrowser from './ModelBrowser.svelte';
  import UsageStats from './UsageStats.svelte';
  import Settings from './Settings.svelte';
  import LogsStream from './LogsStream.svelte';
  import ApiKeys from './ApiKeys.svelte';
  import Combos from './Combos.svelte';

  onMount(() => {
    loadAll();
  });

  const views = {
    dashboard: UsageStats,
    connections: ConnectionList,
    providers: ProviderList,
    models: ModelBrowser,
    settings: Settings,
    logs: LogsStream,
    keys: ApiKeys,
    combos: Combos,
  };

  $: ActiveComponent = views[$activeView] || UsageStats;
</script>

<div class="min-h-screen bg-ink flex">
  <Sidebar />
  
  <div class="flex-1 flex flex-col min-w-0">
    <Header />
    
    <main class="flex-1 p-6 overflow-auto">
      <ActiveComponent />
    </main>
  </div>
</div>
