<script>
  import { onMount } from 'svelte'
  import { api } from '../lib/api.js'
  
  let connections = $state([])
  let selectedConn = $state('')
  let model = $state('')
  let message = $state('')
  let response = $state('')
  let streaming = $state(false)
  let loading = $state(false)
  let latency = $state(null)
  let error = $state(null)
  
  onMount(async () => {
    try {
      connections = await api.getConnections()
      if (connections.length > 0) {
        selectedConn = connections[0].id
        model = connections[0].provider + '/default'
      }
    } catch (e) {
      console.error(e)
    }
  })
  
  async function send() {
    loading = true
    error = null
    response = ''
    streaming = true
    const start = Date.now()
    
    try {
      const res = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + (connections.find(c => c.id === selectedConn)?.apiKey || 'sk-test'),
          'X-Connection-ID': selectedConn
        },
        body: JSON.stringify({
          model: model,
          messages: [{ role: 'user', content: message }],
          stream: true
        })
      })
      
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`)
      }
      
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const text = decoder.decode(value)
        const lines = text.split('\n')
        for (const line of lines) {
          if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            try {
              const json = JSON.parse(line.substring(6))
              const content = json.choices?.[0]?.delta?.content || json.choices?.[0]?.message?.content || ''
              if (content) response += content
            } catch (e) {}
          }
        }
      }
      
      latency = Date.now() - start
    } catch (e) {
      error = e.message
      latency = Date.now() - start
    }
    
    loading = false
    streaming = false
  }
</script>

<h1>Chat Test</h1>

<div class="grid grid-2">
  <div class="card">
    <h2>Request</h2>
    <div style="display:flex; flex-direction:column; gap:.8rem; margin-top:.8rem">
      <label>
        <span class="field-label">Connection</span>
        <select class="input" bind:value={selectedConn}>
          {#each connections as c}
            <option value={c.id}>{c.name} ({c.provider})</option>
          {/each}
        </select>
      </label>
      <label>
        <span class="field-label">Model</span>
        <input class="input" bind:value={model} placeholder="provider/model" />
      </label>
      <label>
        <span class="field-label">Message</span>
        <textarea class="input" rows="6" bind:value={message} placeholder="Type your message..."></textarea>
      </label>
      <button class="btn btn-primary" onclick={send} disabled={loading || !message}>
        {loading ? 'Sending...' : 'Send'}
      </button>
    </div>
  </div>
  
  <div class="card">
    <div style="display:flex; justify-content:space-between; align-items:center">
      <h2>Response</h2>
      {#if latency}
        <span class="muted" style="font-size:.8rem">{latency}ms</span>
      {/if}
    </div>
    <div class="response-box">
      {#if error}
        <p style="color: var(--danger)">{error}</p>
      {:else if streaming}
        <div class="loading-dots">{response}<span class="cursor">▊</span></div>
      {:else if response}
        <pre>{response}</pre>
      {:else}
        <p class="muted" style="text-align:center; padding:2rem">Response will appear here...</p>
      {/if}
    </div>
  </div>
</div>

<style>
  .field-label { display: block; font-size: .75rem; color: var(--text-muted); margin-bottom: .2rem; text-transform: uppercase; }
  textarea { resize: vertical; min-height: 100px; }
  .response-box { margin-top: 1rem; min-height: 300px; }
  pre { white-space: pre-wrap; word-break: break-word; font-size: .85rem; line-height: 1.6; }
  .cursor { animation: blink 1s infinite; }
  @keyframes blink { 0%, 50% { opacity: 1; } 51%, 100% { opacity: 0; } }
</style>
