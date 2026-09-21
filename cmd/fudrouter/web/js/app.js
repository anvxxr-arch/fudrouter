// fudrouter SPA — main app: hash router, state, refresh loop
const APP = (() => {
  const state = {
    route: 'overview',
    data: {
      health: null, version: null, settings: null, authStatus: null,
      connections: [], keys: [], providers: [], usage: null, history: [],
      combos: [], pools: [], nodes: [], customProviders: [],
      tunnelStatus: null, mitmStatus: null, headroomStatus: null, pxpipeStatus: null,
      oauthProviders: [], modelsAvailability: [], locale: 'en', pricing: {},
      quotaData: {}, mediaProvidersByKind: {},
    },
    refreshTimer: null,
  };

  const routes = {
    overview:    { title: 'Overview',     sub: 'System status and live metrics' },
    connections: { title: 'Connections',  sub: 'Provider connections — CRUD, test, OAuth' },
    providers:   { title: 'Providers',    sub: 'Provider management with new provider wizard' },
    models:      { title: 'Models',       sub: 'Catalog browser, search and sync' },
    combos:      { title: 'Combos',       sub: 'Routing rules and failover groups' },
    proxypools:  { title: 'Proxy Pools',  sub: 'Outbound proxy pools' },
    usage:       { title: 'Usage',        sub: 'Token consumption and request history' },
    quota:       { title: 'Quota',        sub: 'Quota tracking per OAuth account' },
    pricing:     { title: 'Pricing',      sub: 'Pricing and cost management' },
    mitm:        { title: 'MITM',         sub: 'MITM management with cert/hosts UI' },
    clitools:    { title: 'CLI Tools',    sub: 'CLI tools integration for Claude Code, Codex, Cursor, Cline, RooCode' },
    mediaprov:   { title: 'Media Providers', sub: 'TTS, Image Gen, Web Search, Embeddings, STT' },
    oauth:       { title: 'OAuth',        sub: 'Link third-party AI provider accounts' },
    settings:    { title: 'Settings',     sub: 'Tunnel, MITM, security and locale' },
    chat:        { title: 'Chat Tester',  sub: 'Test routing via chat completions' },
    tokensaver:  { title: 'Token Saver',  sub: 'Prompt compression via PxPipe stats & monitoring' },
    translator:  { title: 'Translator',   sub: 'Request/response translation debugger' },
    consolelog:  { title: 'Console Log',  sub: 'Real-time log viewer' },
    skills:      { title: 'Skills',       sub: 'Skills management' },
    profile:     { title: 'Profile',      sub: 'User profile and account settings' },
    endpoint:    { title: 'Endpoint',     sub: 'Endpoint testing' },
    basicchat:   { title: 'Basic Chat',   sub: 'Basic chat tester' },
    login:       { title: 'Login',        sub: 'Sign in to dashboard' },
    callback:    { title: 'OAuth Callback', sub: 'Authorization complete' },
  };

  const views = {};
  const viewNames = [
    'overview', 'connections', 'providers', 'models', 'combos', 'proxypools', 'usage', 'quota', 'pricing', 'mitm', 'clitools', 'mediaprov', 'oauth', 'settings', 'chat',
    'tokensaver', 'translator', 'consolelog', 'skills', 'profile', 'endpoint', 'basicchat',
    'login', 'callback', 'notfound', 'globalerror',
  ];

  function registerViews() {
    viewNames.forEach(name => {
      const v = window['View_' + name];
      if (v && v.render) views[name] = v;
    });
  }

  function navigate(route) {
    if (!routes[route]) route = 'overview';
    state.route = route;
    if (location.hash !== '#' + route) location.hash = route;
    updateNav();
    renderView();
  }

  function updateNav() {
    document.querySelectorAll('.nav-item').forEach(el =>
      el.classList.toggle('active', el.dataset.route === state.route));
    // close mobile sidebar on nav
    document.querySelector('.sidebar')?.classList.remove('open');
    document.querySelector('.sidebar-backdrop')?.classList.remove('show');
  }

  function renderView() {
    const main = document.getElementById('main');
    const r = routes[state.route];
    if (!r) return;
    main.innerHTML = `
      <div class="page-head"><h2>${r.title}</h2><div class="sub">${r.sub}</div></div>
      <div class="view" id="view-container">${UI.spin()}</div>`;
    const container = document.getElementById('view-container');
    const view = views[state.route];
    if (view) {
      try { view.render(container, state.data); }
      catch (e) {
        console.error('View error:', e);
        container.innerHTML = `<div class="card"><p class="muted">View error: ${UI.esc(e.message)}</p></div>`;
      }
    } else {
      container.innerHTML = `<div class="card"><p class="muted">View not available.</p></div>`;
    }
  }

  function updateSidebar(d) {
    const h = d.health, v = d.version;
    const verEl = document.getElementById('sb-version');
    const healthEl = document.getElementById('sb-health');
    if (v && verEl) verEl.textContent = `go · v${v.currentVersion || '?'}`;
    if (healthEl) {
      if (h && h.ok) { healthEl.textContent = 'healthy'; healthEl.style.color = 'var(--ok)'; }
      else { healthEl.textContent = 'unreachable'; healthEl.style.color = 'var(--bad)'; }
    }
  }

  async function refresh() {
    const d = state.data;
    const rs = await Promise.allSettled([
      API.health(), API.version(), API.authStatus(), API.settings(),
      API.listConnections(), API.listKeys(), API.providers(),
      API.usageStats(), API.usageHistory(), API.listCombos(), API.listPools(),
      API.tunnelStatus(), API.mitmStatus(), API.headroomStatus(), API.pxpipeStatus(),
      API.oauthProviders(), API.modelsAvailability(), API.locale(), API.pricing(),
      API.listNodes(), API.mediaProvidersByKind(),
    ]);
    const [health, version, authStatus, settings, conns, keys, providers, usage, history, combos, pools, tunnel, mitm, headroom, pxpipe, oauthProv, modelsAvail, locale, pricing, nodes, mediaByKind] = rs.map(r => r.status === 'fulfilled' ? r.value : null);
    if (health) d.health = health;
    if (version) d.version = version;
    if (authStatus) d.authStatus = authStatus;
    if (settings) d.settings = settings;
    if (conns) d.connections = conns.connections || [];
    if (keys) d.keys = keys.keys || [];
    if (providers) d.providers = providers.providers || [];
    if (usage) d.usage = usage;
    if (history) d.history = history.history || [];
    if (combos) d.combos = combos.combos || [];
    if (pools) d.pools = pools.pools || [];
    if (tunnel) d.tunnelStatus = tunnel;
    if (mitm) d.mitmStatus = mitm;
    if (headroom) d.headroomStatus = headroom;
    if (pxpipe) d.pxpipeStatus = pxpipe;
    if (oauthProv) d.oauthProviders = oauthProv.providers || [];
    if (modelsAvail) d.modelsAvailability = modelsAvail.models || [];
    if (locale) d.locale = locale.locale || 'en';
    if (pricing) d.pricing = pricing.pricing || {};
    if (nodes) d.customProviders = nodes.nodes || [];
    if (mediaByKind) d.mediaProvidersByKind = mediaByKind || {};

    updateSidebar(d);
    renderView();
  }

  async function checkAuth() {
    try {
      const auth = await API.authStatus();
      state.data.authStatus = auth;
      if (auth.requireLogin && !auth.authenticated) return await showLogin();
      return true;
    } catch { return true; }
  }

  function showLogin() {
    return new Promise((resolve) => {
      const { close, bodyEl, footEl } = UI.modal({
        title: 'Authentication Required',
        body: `<div class="form-group"><label>Password</label>
          <input class="form-input" type="password" id="login-pw" placeholder="Admin password" /></div>`,
        footer: `<button class="btn btn-primary" id="login-btn">Login</button>`,
      });
      const input = bodyEl.querySelector('#login-pw');
      const btn = footEl.querySelector('#login-btn');
      input.focus();
      input.addEventListener('keydown', e => { if (e.key === 'Enter') btn.click(); });
      btn.onclick = async () => {
        const pw = input.value;
        if (!pw) { UI.toast('Password required', 'error'); return; }
        btn.disabled = true; btn.innerHTML = UI.spin();
        const res = await API.login(pw);
        if (res.ok) { close(); UI.toast('Logged in', 'ok'); resolve(true); }
        else { UI.toast(res.error || 'Login failed', 'error'); btn.disabled = false; btn.textContent = 'Login'; }
      };
    });
  }

  function setupSidebar() {
    const backdrop = document.createElement('div');
    backdrop.className = 'sidebar-backdrop';
    document.body.appendChild(backdrop);
    document.querySelector('.sidebar-toggle')?.addEventListener('click', () => {
      document.querySelector('.sidebar').classList.toggle('open');
      backdrop.classList.toggle('show');
    });
    backdrop.addEventListener('click', () => {
      document.querySelector('.sidebar').classList.remove('open');
      backdrop.classList.remove('show');
    });
  }

  function init() {
    registerViews();
    document.querySelectorAll('.nav-item').forEach(el =>
      el.addEventListener('click', () => navigate(el.dataset.route)));
    window.addEventListener('hashchange', () => navigate(location.hash.slice(1)));
    setupSidebar();

    checkAuth().then(ok => {
      if (ok) {
        refresh();
        state.refreshTimer = setInterval(refresh, 15000);
      }
    });
  }

  return { state, routes, views, navigate, refresh, init };
})();

document.addEventListener('DOMContentLoaded', APP.init);
