// fudrouter SPA — fetch wrapper with credentials
const API = (() => {
  async function request(method, path, body) {
    const opts = {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text, status: res.status }; }
    if (!res.ok && !data.error) data.error = `HTTP ${res.status}`;
    return data;
  }

  return {
    get: (p) => request('GET', p),
    post: (p, b) => request('POST', p, b),
    put: (p, b) => request('PUT', p, b),
    patch: (p, b) => request('PATCH', p, b),
    del: (p, b) => request('DELETE', p, b),

    // Auth
    authStatus: () => request('GET', '/api/auth/status'),
    login: (pw) => request('POST', '/api/auth/login', { password: pw }),
    logout: () => request('POST', '/api/auth/logout'),
    init: (pw) => request('POST', '/api/init', { password: pw }),

    // Health/version
    health: () => request('GET', '/api/health'),
    version: () => request('GET', '/api/version'),

    // Settings
    settings: () => request('GET', '/api/settings'),
    updateSettings: (patch) => request('POST', '/api/settings', patch),

    // Keys
    listKeys: () => request('GET', '/api/keys'),
    createKey: (name) => request('POST', '/api/keys', { name }),
    deleteKey: (id) => request('DELETE', `/api/keys/${id}`),

    // Connections
    listConnections: () => request('GET', '/api/connections'),
    createConnection: (data) => request('POST', '/api/connections', data),
    updateConnection: (id, data) => request('PUT', `/api/connections/${id}`, data),
    deleteConnection: (id) => request('DELETE', `/api/connections/${id}`),
    testConnection: (id) => request('POST', `/api/connections/${id}/test`),

    // Providers & models
    providers: () => request('GET', '/api/providers'),
    provider: (id) => request('GET', `/api/providers/${id}`),
    providerModels: (id) => request('GET', `/api/providers/${id}/models`),
    modelsAvailability: () => request('GET', '/api/models/availability'),
    modelsCustom: () => request('GET', '/api/models/custom'),
    modelsDisabled: () => request('GET', '/api/models/disabled'),
    setModelsDisabled: (data) => request('POST', '/api/models/disabled', data),
    modelsAlias: () => request('GET', '/api/models/alias'),
    catalogSync: () => request('POST', '/api/models/catalog-sync'),
    v1Models: () => request('GET', '/api/v1/models'),

    // Combos
    listCombos: () => request('GET', '/api/combos'),
    createCombo: (data) => request('POST', '/api/combos', data),
    updateCombo: (id, data) => request('PUT', `/api/combos/${id}`, data),
    deleteCombo: (id) => request('DELETE', `/api/combos/${id}`),

    // Nodes
    listNodes: () => request('GET', '/api/provider-nodes'),
    createNode: (data) => request('POST', '/api/provider-nodes', data),
    updateNode: (id, data) => request('PUT', `/api/provider-nodes/${id}`, data),
    deleteNode: (id) => request('DELETE', `/api/provider-nodes/${id}`),

    // Proxy pools
    listPools: () => request('GET', '/api/proxy-pools'),
    createPool: (data) => request('POST', '/api/proxy-pools', data),
    deletePool: (id) => request('DELETE', `/api/proxy-pools/${id}`),

    // Usage
    usageStats: () => request('GET', '/api/usage/stats'),
    usageHistory: () => request('GET', '/api/usage/history'),

    // Tunnel/headroom/mitm/pxpipe
    tunnelStatus: () => request('GET', '/api/tunnel/status'),
    mitmStatus: () => request('GET', '/api/mitm/status'),
    headroomStatus: () => request('GET', '/api/headroom/status'),
    pxpipeStatus: () => request('GET', '/api/pxpipe/status'),

    // Pricing / locale
    pricing: () => request('GET', '/api/pricing'),
    locale: () => request('GET', '/api/locale'),
    setLocale: (loc) => request('POST', '/api/locale', { locale: loc }),

    // Media providers
    mediaProvidersByKind: () => request('GET', '/api/media-providers/by-kind'),

    // OAuth
    oauthProviders: () => request('GET', '/api/oauth/providers'),
    oauthStart: (provider, redirectUri) => request('POST', `/api/oauth/${provider}/start`, { redirectUri }),
    oauthStatus: (provider, sessionId) => request('GET', `/api/oauth/${provider}/status?sessionId=${sessionId}`),
    oauthPoll: (provider, sessionId) => request('POST', `/api/oauth/${provider}/poll`, { sessionId }),
    oauthRefresh: () => request('POST', '/api/oauth/refresh'),
    oauthRefreshOne: (provider) => request('POST', `/api/oauth/${provider}/refresh`, {}),

    // Cursor
    cursorAutoImport: () => request('POST', '/api/oauth/cursor/auto-import'),
    cursorImport: (data) => request('POST', '/api/oauth/cursor/import', data),

    // Kiro
    kiroSocialAuthorize: (idp) => request('POST', '/api/oauth/kiro/social-authorize', { idp }),
    kiroImport: (data) => request('POST', '/api/oauth/kiro/import', data),
    kiroAPIKey: (data) => request('POST', '/api/oauth/kiro/api-key', data),
    kiroDeviceStart: (data) => request('POST', '/api/oauth/kiro/device-code', data),
    kiroDevicePoll: (sessionId) => request('POST', '/api/oauth/kiro/device-poll', { sessionId }),

    // Codex
    codexStart: (redirectUri) => request('POST', '/api/oauth/codex/start', { redirectUri }),
    codexImport: (data) => request('POST', '/api/oauth/codex/import-token', data),
    codexRefresh: (refreshToken) => request('POST', '/api/oauth/codex/refresh', { refreshToken }),
    codexUsage: (token) => request('GET', `/api/oauth/codex/usage?token=${encodeURIComponent(token || '')}`),
    codexReset: (token) => request('POST', '/api/oauth/codex/reset-credits', { token }),

    // Updater
    updateStatus: () => request('GET', '/api/version/update'),
    updateStart: () => request('POST', '/api/version/update'),
  };
})();
