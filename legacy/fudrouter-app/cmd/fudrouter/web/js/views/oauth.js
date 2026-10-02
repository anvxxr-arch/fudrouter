// View: OAuth — provider grid with status + login flows
var View_oauth = {
  meta: {
    xai: { name: 'xAI / Grok', icon: 'xai', desc: 'PKCE browser flow' },
    qoder: { name: 'Qoder', icon: 'qoder', desc: 'Device code flow' },
    'xiaomi-mimo': { name: 'Xiaomi MiMo', icon: 'xiaomi-mimo', desc: 'ECDH web flow' },
    kiro: { name: 'AWS Kiro', icon: 'kiro', desc: 'Social, device or import' },
    cursor: { name: 'Cursor IDE', icon: 'cursor', desc: 'Token import / auto-import' },
    codex: { name: 'OpenAI Codex', icon: 'codex', desc: 'PKCE browser flow' },
  },

  render(container, d) {
    const providers = d.oauthProviders && d.oauthProviders.length ? d.oauthProviders : Object.keys(this.meta).map(id => ({ id, name: this.meta[id].name, flow: this.meta[id].desc }));
    const oauthConns = (d.connections || []).filter(c => (c.authType || '').toLowerCase() === 'oauth');

    container.innerHTML = `
      <div class="toolbar">
        <div class="muted" style="flex:1">${oauthConns.length} linked account${oauthConns.length === 1 ? '' : 's'}</div>
        <button class="btn" id="btnRefreshAll">⟳ Refresh Tokens</button>
      </div>
      <div class="grid grid-3 mb-16">
        ${providers.map(p => {
          const m = this.meta[p.id] || { name: p.name || p.id, desc: p.flow || '' };
          const linked = oauthConns.filter(c => c.provider === p.id || (p.id === 'xai' && ['grok', 'grok-cli'].includes(c.provider)));
          return `<div class="card" data-prov="${UI.esc(p.id)}">
            <div class="flex-between mb-8">
              <div class="flex-center gap-8">
                <img class="provider-logo" src="/providers/${UI.esc(m.icon || p.id)}.png" onerror="this.style.visibility='hidden'" />
                <strong>${UI.esc(m.name)}</strong>
              </div>
              ${linked.length ? UI.pill('active', `${linked.length} linked`) : UI.pill('off', 'none')}
            </div>
            <div class="muted" style="font-size:.78rem">${UI.esc(m.desc)}</div>
            ${linked.length ? `<div class="mt-8">${linked.map(c => `<div class="muted" style="font-size:.72rem">· ${UI.esc(c.name || c.email || c.id)}</div>`).join('')}</div>` : ''}
            <div class="mt-16 btn-group">
              <button class="btn btn-sm btn-primary" data-login="${UI.esc(p.id)}">Login</button>
              ${p.id === 'cursor' ? `<button class="btn btn-sm" data-auto="cursor">Auto-import</button>` : ''}
              ${p.id === 'kiro' ? `<button class="btn btn-sm" data-kiro-device="kiro">Device</button><button class="btn btn-sm" data-kiro-import="kiro">Import</button>` : ''}
              ${p.id === 'codex' ? `<button class="btn btn-sm" data-codex-import="codex">Import</button>` : ''}
            </div>
          </div>`;
        }).join('')}
      </div>
      ${oauthConns.length ? `
      <div class="card">
        <div class="card-title">Linked Accounts</div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Provider</th><th>Account</th><th>Priority</th><th>Status</th><th></th></tr></thead>
            <tbody>${oauthConns.map(c => `
              <tr>
                <td><div class="flex-center gap-8">
                  <img class="provider-logo" src="/providers/${UI.esc(c.provider)}.png" onerror="this.style.visibility='hidden'" />
                  ${UI.esc(c.provider)}</div></td>
                <td>${UI.esc(c.name || c.email || c.id)}</td>
                <td>${c.priority ?? '—'}</td>
                <td>${UI.pill(c.isActive ? 'active' : 'off', c.isActive ? 'active' : 'off')}</td>
                <td class="text-right"><button class="btn btn-sm btn-danger" data-unlink="${UI.esc(c.id)}">Unlink</button></td>
              </tr>`).join('')}</tbody>
          </table>
        </div>
      </div>` : ''}`;

    container.querySelector('#btnRefreshAll').onclick = async (e) => {
      const btn = e.currentTarget; btn.innerHTML = UI.spin();
      const r = await API.oauthRefresh();
      btn.textContent = '⟳ Refresh Tokens';
      if (r.ok) { UI.toast(`Refreshed ${r.refreshed || 0} token(s)`, 'ok'); APP.refresh(); }
      else UI.toast(r.error || 'Refresh failed', 'error');
    };

    container.addEventListener('click', (e) => {
      const login = e.target.closest('[data-login]');
      const auto = e.target.closest('[data-auto]');
      const kiroDevice = e.target.closest('[data-kiro-device]');
      const kiroImport = e.target.closest('[data-kiro-import]');
      const codexImport = e.target.closest('[data-codex-import]');
      const unlink = e.target.closest('[data-unlink]');
      if (login) this.startFlow(login.dataset.login);
      if (auto) this.cursorAutoImport();
      if (kiroDevice) this.kiroDevice();
      if (kiroImport) this.kiroImport();
      if (codexImport) this.codexImport();
      if (unlink) this.unlink(unlink.dataset.unlink);
    });
  },

  async startFlow(provider) {
    try {
      if (provider === 'cursor') { this.cursorImport(); return; }
      if (provider === 'kiro') { this.kiroSocial(); return; }
      const r = await API.oauthStart(provider);
      if (r.error) { UI.toast(r.error, 'error', 6000); return; }
      if (r.authUrl) {
        window.open(r.authUrl, '_blank', 'width=520,height=720');
        UI.toast('Browser window opened — complete login there', 'info', 6000);
        if (provider === 'qoder' && r.sessionId) this.pollQoder(r.sessionId);
      } else if (r.sessionId) {
        this.pollSession(provider, r.sessionId);
      }
    } catch (e) { UI.toast('OAuth failed: ' + e.message, 'error', 6000); }
  },

  pollSession(provider, sessionId, attempts = 0) {
    if (attempts > 60) { UI.toast('OAuth polling timed out', 'warn'); return; }
    setTimeout(async () => {
      try {
        const r = await API.oauthStatus(provider, sessionId);
        if (r.status === 'done') { UI.toast('Account linked ✓', 'ok'); APP.refresh(); return; }
        if (r.status === 'error') { UI.toast(r.error || 'OAuth error', 'error'); return; }
        this.pollSession(provider, sessionId, attempts + 1);
      } catch { this.pollSession(provider, sessionId, attempts + 1); }
    }, 2000);
  },

  pollQoder(sessionId, attempts = 0) {
    if (attempts > 90) { UI.toast('Device flow timed out', 'warn'); return; }
    setTimeout(async () => {
      try {
        const r = await API.oauthPoll('qoder', sessionId);
        if (r.status === 'done') { UI.toast('Qoder linked ✓', 'ok'); APP.refresh(); return; }
        if (r.status === 'error') { UI.toast(r.error || 'Qoder error', 'error'); return; }
        this.pollQoder(sessionId, attempts + 1);
      } catch { this.pollQoder(sessionId, attempts + 1); }
    }, 2000);
  },

  async cursorAutoImport() {
    UI.toast('Scanning for Cursor credentials…', 'info');
    const r = await API.cursorAutoImport();
    if (r.found) { UI.toast('Cursor account imported ✓', 'ok'); APP.refresh(); }
    else UI.toast(r.message || 'No Cursor credentials found on host', 'warn', 6000);
  },

  cursorImport() {
    const { close, bodyEl, footEl } = UI.modal({
      title: 'Import Cursor Token',
      body: `
        <div class="form-group"><label>Access Token</label><input class="form-input" id="ci-token" placeholder="eyJ…" /></div>
        <div class="form-group"><label>Machine ID</label><input class="form-input" id="ci-machine" placeholder="a1b2c3…" /></div>`,
      footer: `<button class="btn" data-c>Cancel</button><button class="btn btn-primary" data-ok>Import</button>`,
    });
    footEl.querySelector('[data-c]').onclick = close;
    footEl.querySelector('[data-ok]').onclick = async () => {
      const r = await API.cursorImport({
        accessToken: bodyEl.querySelector('#ci-token').value.trim(),
        machineId: bodyEl.querySelector('#ci-machine').value.trim(),
      });
      if (r.error) { UI.toast(r.error, 'error', 6000); return; }
      UI.toast('Cursor imported ✓', 'ok'); close(); APP.refresh();
    };
  },

  kiroSocial() {
    const { close, bodyEl, footEl } = UI.modal({
      title: 'Kiro — Social Login',
      body: `
        <div class="form-group"><label>Identity Provider</label>
          <select class="form-select" id="ks-idp">
            <option value="google">Google</option><option value="github">GitHub</option>
          </select></div>
        <p class="muted" style="font-size:.78rem">Opens a browser window. After login, paste the callback URL below.</p>
        <div class="form-group mt-8"><label>Callback URL (after login)</label><input class="form-input" id="ks-cb" placeholder="https://prod.us-east-1.auth.…/sso?code=…" /></div>`,
      footer: `<button class="btn" data-c>Cancel</button><button class="btn btn-primary" data-ok>Start</button>`,
    });
    let sessionId = null;
    footEl.querySelector('[data-c]').onclick = close;
    footEl.querySelector('[data-ok]').onclick = async () => {
      const idp = bodyEl.querySelector('#ks-idp').value;
      const cb = bodyEl.querySelector('#ks-cb').value.trim();
      if (!cb) {
        const r = await API.kiroSocialAuthorize(idp);
        if (r.error) { UI.toast(r.error, 'error', 6000); return; }
        sessionId = r.sessionId;
        window.open(r.authUrl, '_blank', 'width=520,height=720');
        footEl.querySelector('[data-ok]').textContent = 'Exchange';
        bodyEl.querySelector('#ks-cb').focus();
        return;
      }
      const r = await API.post('/api/oauth/kiro/social-exchange', { sessionId, callbackUrl: cb });
      if (r.error) { UI.toast(r.error, 'error', 6000); return; }
      UI.toast('Kiro linked ✓', 'ok'); close(); APP.refresh();
    };
  },

  kiroDevice() {
    const { close, bodyEl, footEl } = UI.modal({
      title: 'Kiro — Device Code',
      body: `<div id="kd-body"><p class="muted">Starting device flow… ${UI.spin()}</p></div>`,
      footer: `<button class="btn" data-c>Close</button>`,
    });
    footEl.querySelector('[data-c]').onclick = close;
    (async () => {
      const r = await API.kiroDeviceStart({});
      const body = bodyEl.querySelector('#kd-body');
      if (r.error) { body.innerHTML = `<p class="err">${UI.esc(r.error)}</p>`; return; }
      body.innerHTML = `
        <p class="text-2">Open the URL and enter the code:</p>
        <div class="code-block mt-8">${UI.esc(r.authUrl || '')}</div>
        <div class="mt-8 text-center"><span class="pill acc" style="font-size:1.1rem">${UI.esc(r.userCode || '—')}</span></div>
        <p class="muted mt-8 text-center" id="kd-status">waiting…</p>`;
      if (r.authUrl) window.open(r.authUrl, '_blank');
      const poll = async (n = 0) => {
        if (n > 90 || !document.body.contains(body)) return;
        const st = await API.kiroDevicePoll(r.sessionId);
        const stEl = body.querySelector('#kd-status');
        if (st.status === 'done') { UI.toast('Kiro linked ✓', 'ok'); close(); APP.refresh(); return; }
        if (st.error) { if (stEl) stEl.textContent = st.error; setTimeout(() => poll(n + 1), 3000); return; }
        if (stEl) stEl.textContent = 'waiting for authorization…';
        setTimeout(() => poll(n + 1), 3000);
      };
      poll();
    })();
  },

  kiroImport() {
    const { close, bodyEl, footEl } = UI.modal({
      title: 'Kiro — Import Refresh Token',
      body: `
        <div class="form-group"><label>Refresh Token</label><textarea class="form-input" id="ki-rt" style="min-height:80px;font-family:var(--mono)"></textarea></div>
        <div class="form-row">
          <div class="form-group"><label>Client ID</label><input class="form-input" id="ki-cid" /></div>
          <div class="form-group"><label>Client Secret</label><input class="form-input" id="ki-cs" type="password" /></div>
        </div>
        <div class="form-group"><label>Region</label><input class="form-input" id="ki-region" value="us-east-1" /></div>`,
      footer: `<button class="btn" data-c>Cancel</button><button class="btn btn-primary" data-ok>Import</button>`,
    });
    footEl.querySelector('[data-c]').onclick = close;
    footEl.querySelector('[data-ok]').onclick = async () => {
      const r = await API.kiroImport({
        refreshToken: bodyEl.querySelector('#ki-rt').value.trim(),
        clientId: bodyEl.querySelector('#ki-cid').value.trim(),
        clientSecret: bodyEl.querySelector('#ki-cs').value.trim(),
        region: bodyEl.querySelector('#ki-region').value.trim(),
      });
      if (r.error) { UI.toast(r.error, 'error', 6000); return; }
      UI.toast('Kiro imported ✓', 'ok'); close(); APP.refresh();
    };
  },

  codexImport() {
    const { close, bodyEl, footEl } = UI.modal({
      title: 'Codex — Import Token',
      body: `<div class="form-group"><label>Access Token</label><textarea class="form-input" id="cx-token" style="min-height:80px;font-family:var(--mono)"></textarea></div>`,
      footer: `<button class="btn" data-c>Cancel</button><button class="btn btn-primary" data-ok>Import</button>`,
    });
    footEl.querySelector('[data-c]').onclick = close;
    footEl.querySelector('[data-ok]').onclick = async () => {
      const r = await API.codexImport({ accessToken: bodyEl.querySelector('#cx-token').value.trim() });
      if (r.error) { UI.toast(r.error, 'error', 6000); return; }
      UI.toast('Codex imported ✓', 'ok'); close(); APP.refresh();
    };
  },

  async unlink(id) {
    if (await UI.confirmDialog({ title: 'Unlink account', message: 'Remove this OAuth connection?', danger: true, okText: 'Unlink' })) {
      const r = await API.deleteConnection(id);
      if (r.ok) { UI.toast('Unlinked', 'ok'); APP.refresh(); } else UI.toast(r.error || 'Failed', 'error');
    }
  },
};
