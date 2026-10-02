<script>
  import { onMount } from 'svelte'
  import { api } from '../lib/api.js'
  
  let settings = $state({
    fallbackStrategy: 'fill-first',
    raceTimeout: 30000,
    cooldown: 60000,
    maxRace: 4,
    sticky: 1,
    mitmEnabled: '1',
    chatMode: 'fill-first'
  })
  let loading = $state(true)
  let saved = $state(false)
  
  onMount(async () => {
    try {
      const data = await api.getSettings()
      settings = { ...settings, ...data }
    } catch (e) {
      console.error(e)
    }
    loading = false
  })
  
  async function save() {
    try {
      await api.updateSettings(settings)
      saved = true
      setTimeout(() => saved = false, 2000)
    } catch (e) {
      alert('Failed: ' + e.message)
    }
  }
  
  async function update() {
    try {
      await api.startUpdate()
      alert('Update started!')
    } catch (e) {
      alert('Failed: ' + e.message)
    }
  }
</script>

<h1>Settings</h1>

{#if loading}
  <p class="muted">Loading...</p>
{:else}
<div class="grid grid-2">
  <div class="card">
    <h2>Routing</h2>
    <div class="form-list">
      <label>
        <span class="field-label">Fallback Strategy</span>
        <select class="input" bind:value={settings.fallbackStrategy}>
          <option value="fill-first">Fill First (race by priority)</option>
          <option value="round-robin">Round Robin</option>
        </select>
      </label>
      <label>
        <span class="field-label">Chat Mode</span>
        <select class="input" bind:value={settings.chatMode}>
          <option value="fill-first">Fill First</option>
          <option value="race">Race (parallel)</option>
        </select>
      </label>
      <label>
        <span class="field-label">Race Timeout (ms)</span>
        <input class="input" type="number" bind:value={settings.raceTimeout} />
      </label>
      <label>
        <span class="field-label">Cooldown (ms)</span>
        <input class="input" type="number" bind:value={settings.cooldown} />
      </label>
      <label>
        <span class="field-label">Max Race</span>
        <input class="input" type="number" bind:value={settings.maxRace} />
      </label>
      <label class="checkbox-label">
        <input type="checkbox" bind:checked={settings.sticky} />
        <span>Sticky sessions</span>
      </label>
    </div>
  </div>
  
  <div class="card">
    <h2>MITM</h2>
    <div class="form-list">
      <label class="checkbox-label">
        <input type="checkbox" bind:checked={settings.mitmEnabled} />
        <span>Enable MITM proxy</span>
      </label>
      <p class="muted" style="font-size:.8rem">
        Intercepts traffic to AI coding agents (Claude Code, Kiro, Cursor, Copilot, Windsurf).
        Requires installing root CA into OS/browser trust store.
      </p>
    </div>
  </div>
</div>

<div style="display:flex; gap:.5rem; margin-top:1rem">
  <button class="btn btn-primary" onclick={save}>
    {saved ? '✓ Saved!' : 'Save Settings'}
  </button>
  <button class="btn btn-ghost" onclick={update}>↻ Check for Updates</button>
</div>
{/if}

<style>
  .form-list { display: flex; flex-direction: column; gap: .8rem; margin-top: .8rem; }
  .field-label { display: block; font-size: .75rem; color: var(--text-muted); margin-bottom: .2rem; text-transform: uppercase; }
  .checkbox-label { display: flex; align-items: center; gap: .5rem; cursor: pointer; }
</style>
