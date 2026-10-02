<script>
  import { onMount } from 'svelte'
  import Overview from './routes/Overview.svelte'
  import Landing from './routes/Landing.svelte'
  import Connections from './routes/Connections.svelte'
  import Providers from './routes/Providers.svelte'
  import Models from './routes/Models.svelte'
  import Settings from './routes/Settings.svelte'
  import Combos from './routes/Combos.svelte'
  import ProxyPools from './routes/ProxyPools.svelte'
  import Usage from './routes/Usage.svelte'
  import Quota from './routes/Quota.svelte'
  import Pricing from './routes/Pricing.svelte'
  import Mitm from './routes/Mitm.svelte'
  import CliTools from './routes/CliTools.svelte'
  import ApiKeys from './routes/ApiKeys.svelte'
  import Logs from './routes/Logs.svelte'
  import Update from './routes/Update.svelte'
  import OAuth from './routes/OAuth.svelte'
  import Login from './routes/Login.svelte'
  import CustomModels from './routes/CustomModels.svelte'
  import ChatTest from './routes/ChatTest.svelte'

  let currentRoute = $state(window.location.pathname)
  let sidebarCollapsed = $state(false)
  let mobileOpen = $state(false)

  function goto(path) {
    window.history.pushState({}, '', path)
    currentRoute = path
    mobileOpen = false
  }

  function toggleSidebar() {
    sidebarCollapsed = !sidebarCollapsed
  }

  onMount(() => {
    window.addEventListener('popstate', () => {
      currentRoute = window.location.pathname
    })
    const checkMobile = () => {
      if (window.innerWidth < 768) {
        sidebarCollapsed = true
        mobileOpen = false
      }
    }
    checkMobile()
    window.addEventListener('resize', checkMobile)
  })
  
  function route(page) {
    return currentRoute === page || currentRoute.startsWith(page + '/')
  }
</script>

<div class="app-layout">
  <aside class="sidebar" class:collapsed={sidebarCollapsed} class:mobile-open={mobileOpen}>
    <button class="brand" onclick={() => goto('/')} title="fudrouter">
      <span class="fox">🦊</span>
      <span class="name" class:hidden={sidebarCollapsed}>fudrouter</span>
    </button>

    <button class="collapse-btn" onclick={toggleSidebar} title={sidebarCollapsed ? 'Expand' : 'Collapse'}>
      {#if sidebarCollapsed}→{:else}←{/if}
    </button>

    <nav>
      <button class="nav-item" class:active={route('/marketing')} onclick={() => goto('/marketing')} title="Landing">
        <span class="nav-icon">🌐</span>
        <span class="nav-text" class:hidden={sidebarCollapsed}>Landing</span>
      </button>
      <button class="nav-item" class:active={route('/')} onclick={() => goto('/')} title="Overview">
        <span class="nav-icon">📊</span>
        <span class="nav-text" class:hidden={sidebarCollapsed}>Overview</span>
      </button>
      <button class="nav-item" class:active={route('/connections')} onclick={() => goto('/connections')} title="Connections">
        <span class="nav-icon">🔌</span>
        <span class="nav-text" class:hidden={sidebarCollapsed}>Connections</span>
      </button>
      <button class="nav-item" class:active={route('/providers')} onclick={() => goto('/providers')} title="Providers">
        <span class="nav-icon">🏗️</span>
        <span class="nav-text" class:hidden={sidebarCollapsed}>Providers</span>
      </button>
      <button class="nav-item" class:active={route('/models')} onclick={() => goto('/models')} title="Models">
        <span class="nav-icon">🧠</span>
        <span class="nav-text" class:hidden={sidebarCollapsed}>Models</span>
      </button>
      <button class="nav-item" class:active={route('/combos')} onclick={() => goto('/combos')} title="Combos">
        <span class="nav-icon">🔀</span>
        <span class="nav-text" class:hidden={sidebarCollapsed}>Combos</span>
      </button>
      <button class="nav-item" class:active={route('/proxypools')} onclick={() => goto('/proxypools')} title="Proxy Pools">
        <span class="nav-icon">🌐</span>
        <span class="nav-text" class:hidden={sidebarCollapsed}>Proxy Pools</span>
      </button>
      <button class="nav-item" class:active={route('/usage')} onclick={() => goto('/usage')} title="Usage">
        <span class="nav-icon">📈</span>
        <span class="nav-text" class:hidden={sidebarCollapsed}>Usage</span>
      </button>
      <button class="nav-item" class:active={route('/quota')} onclick={() => goto('/quota')} title="Quota">
        <span class="nav-icon">📊</span>
        <span class="nav-text" class:hidden={sidebarCollapsed}>Quota</span>
      </button>
      <button class="nav-item" class:active={route('/pricing')} onclick={() => goto('/pricing')} title="Pricing">
        <span class="nav-icon">💰</span>
        <span class="nav-text" class:hidden={sidebarCollapsed}>Pricing</span>
      </button>
      <button class="nav-item" class:active={route('/mitm')} onclick={() => goto('/mitm')} title="MITM">
        <span class="nav-icon">🔒</span>
        <span class="nav-text" class:hidden={sidebarCollapsed}>MITM</span>
      </button>
      <button class="nav-item" class:active={route('/clitools')} onclick={() => goto('/clitools')} title="CLI Tools">
        <span class="nav-icon">🛠️</span>
        <span class="nav-text" class:hidden={sidebarCollapsed}>CLI Tools</span>
      </button>
      <button class="nav-item" class:active={route('/custommodels')} onclick={() => goto('/custommodels')} title="Custom Models">
        <span class="nav-icon">🧩</span>
        <span class="nav-text" class:hidden={sidebarCollapsed}>Custom Models</span>
      </button>
      <button class="nav-item" class:active={route('/chattest')} onclick={() => goto('/chattest')} title="Chat Test">
        <span class="nav-icon">💬</span>
        <span class="nav-text" class:hidden={sidebarCollapsed}>Chat Test</span>
      </button>
      <button class="nav-item" class:active={route('/apikeys')} onclick={() => goto('/apikeys')} title="API Keys">
        <span class="nav-icon">🔑</span>
        <span class="nav-text" class:hidden={sidebarCollapsed}>API Keys</span>
      </button>
      <button class="nav-item" class:active={route('/oauth')} onclick={() => goto('/oauth')} title="OAuth">
        <span class="nav-icon">🔗</span>
        <span class="nav-text" class:hidden={sidebarCollapsed}>OAuth</span>
      </button>
      <button class="nav-item" class:active={route('/logs')} onclick={() => goto('/logs')} title="Logs">
        <span class="nav-icon">📋</span>
        <span class="nav-text" class:hidden={sidebarCollapsed}>Logs</span>
      </button>
      <button class="nav-item" class:active={route('/update')} onclick={() => goto('/update')} title="Update">
        <span class="nav-icon">🔄</span>
        <span class="nav-text" class:hidden={sidebarCollapsed}>Update</span>
      </button>
      <button class="nav-item" class:active={route('/settings')} onclick={() => goto('/settings')} title="Settings">
        <span class="nav-icon">⚙️</span>
        <span class="nav-text" class:hidden={sidebarCollapsed}>Settings</span>
      </button>
    </nav>
  </aside>

  <!-- Mobile overlay -->
  <div class="mobile-overlay" class:open={mobileOpen} onclick={() => mobileOpen = false}></div>

  <!-- Mobile top bar -->
  <button class="mobile-toggle" onclick={() => mobileOpen = !mobileOpen}>
    ☰
  </button>

  <main class="main">
    {#if route('/marketing')}
      <Landing />
    {:else if route('/')}
      <Overview />
    {:else if route('/connections')}
      <Connections />
    {:else if route('/providers')}
      <Providers />
    {:else if route('/models')}
      <Models />
    {:else if route('/combos')}
      <Combos />
    {:else if route('/proxypools')}
      <ProxyPools />
    {:else if route('/usage')}
      <Usage />
    {:else if route('/quota')}
      <Quota />
    {:else if route('/pricing')}
      <Pricing />
    {:else if route('/mitm')}
      <Mitm />
    {:else if route('/clitools')}
      <CliTools />
    {:else if route('/custommodels')}
      <CustomModels />
    {:else if route('/chattest')}
      <ChatTest />
    {:else if route('/apikeys')}
      <ApiKeys />
    {:else if route('/oauth')}
      <OAuth />
    {:else if route('/logs')}
      <Logs />
    {:else if route('/update')}
      <Update />
    {:else if route('/settings')}
      <Settings />
    {:else if route('/login')}
      <Login />
    {:else}
      <Overview />
    {/if}
  </main>
</div>


