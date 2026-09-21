const BASE = '/api'

async function request(path, options = {}) {
  const res = await fetch(BASE + path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...options
  })
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`)
  return res.json()
}

export const api = {
  health: () => request('/health'),
  version: () => request('/version'),
  authStatus: () => request('/auth/status'),
  
  // Settings
  getSettings: () => request('/settings'),
  updateSettings: (data) => request('/settings', { method: 'POST', body: JSON.stringify(data) }),
  
  // API Keys
  getKeys: () => request('/keys'),
  createKey: (data) => request('/keys', { method: 'POST', body: JSON.stringify(data) }),
  deleteKey: (id) => request(`/keys/${id}`, { method: 'DELETE' }),
  
  // Connections
  getConnections: async () => { const d = await request('/connections'); return d.connections || d },
  createConnection: (data) => request('/connections', { method: 'POST', body: JSON.stringify(data) }),
  updateConnection: (id, data) => request(`/connections/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteConnection: (id) => request(`/connections/${id}`, { method: 'DELETE' }),
  
  // Combos
  getCombos: async () => { const d = await request('/combos'); return d.combos || d },
  createCombo: (data) => request('/combos', { method: 'POST', body: JSON.stringify(data) }),
  updateCombo: (id, data) => request(`/combos/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteCombo: (id) => request(`/combos/${id}`, { method: 'DELETE' }),
  
  // Nodes
  getNodes: async () => { const d = await request('/nodes'); return d.nodes || d },
  createNode: (data) => request('/nodes', { method: 'POST', body: JSON.stringify(data) }),
  deleteNode: (id) => request(`/nodes/${id}`, { method: 'DELETE' }),
  
  // Proxy Pools
  getProxyPools: async () => { const d = await request('/proxypools'); return d.proxypools || d.proxies || d },
  createPool: (data) => request('/proxypools', { method: 'POST', body: JSON.stringify(data) }),
  deletePool: (id) => request(`/proxypools/${id}`, { method: 'DELETE' }),
  
  // MITM
  getMitmStatus: () => request('/mitm/status'),
  getMitmTargets: () => request('/mitm/targets'),
  
  // Models & Catalog
  getModels: async () => { const d = await request('/models'); return d.models || d },
  getCatalog: async () => { const d = await request('/catalog/models'); return d.models || d },
  getProviders: async () => { const d = await request('/providers'); return d.providers || d },
  
  // Usage
  getUsageStats: () => request('/usage/stats'),
  getUsageHistory: async () => { const d = await request('/usage/history'); return d.history || d },
  
  // Update
  getUpdateStatus: () => request('/update/status'),
  startUpdate: () => request('/update/start', { method: 'POST' })
}
