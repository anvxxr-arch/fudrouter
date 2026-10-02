// View: Settings — tunnel, MITM, CA download, locale, require-login, strategy
var View_settings = {
  render(container, d) {
    const s = d.settings || {};
    const mitm = d.mitmStatus || {};
    const tunnel = d.tunnelStatus || {};
    const locale = d.locale || 'en';

    container.innerHTML = `
      <div class="grid grid-2">
        <div class="card">
          <div class="card-title">Routing</div>
          <div class="form-group"><label>Fallback Strategy</label>
            <select class="form-select" id="st-strategy">
              <option value="fill-first" ${s.fallbackStrategy === 'fill-first' ? 'selected' : ''}>fill-first — try connections in priority order</option>
              <option value="round-robin" ${s.fallbackStrategy === 'round-robin' ? 'selected' : ''}>round-robin — distribute across connections</option>
              <option value="race" ${s.fallbackStrategy === 'race' ? 'selected' : ''}>race — first response wins</option>
            </select></div>
          <div class="form-group"><label>Locale</label>
            <select class="form-select" id="st-locale">
              ${['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'de', 'fr', 'es', 'ru', 'ar', 'hi', 'id', 'vi', 'th', 'pt-BR'].map(l =>
                `<option value="${l}" ${locale === l ? 'selected' : ''}>${l}</option>`).join('')}
            </select></div>
          <button class="btn btn-primary" id="st-save">Save Settings</button>
        </div>

        <div class="card">
          <div class="card-title">Security</div>
          <div class="form-group"><label class="flex-center gap-8" style="cursor:pointer">
            <input type="checkbox" id="st-require" ${(s.requireLogin) ? 'checked' : ''} style="width:auto" /> Require login for dashboard</label></div>
          <p class="muted" style="font-size:.78rem">When enabled, the dashboard and API require an authenticated session. API keys (Bearer) always pass.</p>
          <div class="mt-16"><button class="btn" id="st-logout">Logout</button></div>
        </div>

        <div class="card">
          <div class="card-title">Tunnel (cloudflared)</div>
          <div class="flex-center gap-12">
            ${UI.pill(tunnel.enabled ? 'active' : 'off', tunnel.enabled ? 'running' : 'stopped')}
            ${tunnel.hostname ? `<span class="text-2">${UI.esc(tunnel.hostname)}</span>` : ''}
          </div>
          ${tunnel.target ? `<div class="muted mt-8">→ ${UI.esc(tunnel.target)}</div>` : ''}
          <p class="muted mt-8" style="font-size:.78rem">Managed via systemd (cloudflared service).</p>
        </div>

        <div class="card">
          <div class="card-title">MITM Proxy</div>
          <div class="flex-center gap-12 mb-8">
            ${UI.pill(mitm.caExists ? 'active' : 'off', mitm.caExists ? 'CA ready' : 'CA missing')}
            ${(mitm.listening && (mitm.listening['443'] || mitm.listening['8443']))
              ? UI.pill('active', 'listening :443/:8443') : UI.pill('off', 'not listening')}
          </div>
          ${mitm.caPath ? `<div class="muted" style="font-size:.75rem;font-family:var(--mono)">${UI.esc(mitm.caPath)}</div>` : ''}
          <div class="mt-8"><span class="text-2" style="font-size:.78rem">Intercepted targets:</span></div>
          <div class="btn-group mt-8">${(mitm.targets || []).map(t => `<span class="tag">${UI.esc(t)}</span>`).join('')}</div>
          <div class="mt-16 btn-group">
            <a class="btn btn-primary" href="/mitm/rootCA.crt" download="fudrouter-rootCA.crt">⬇ Download CA Cert</a>
            <button class="btn" id="ca-copy">Copy CA path</button>
          </div>
          <p class="muted mt-8" style="font-size:.72rem">Install into your OS/browser trust store as a root CA to route MITM targets (antigravity, copilot, kiro, cursor) through fudrouter.</p>
        </div>

        <div class="card">
          <div class="card-title">Runtime Info</div>
          <div class="code-block" id="rt-info">loading…</div>
        </div>

        <div class="card">
          <div class="card-title">Self-Update</div>
          <p class="muted" style="font-size:.78rem">Build latest from source, replace binary, and restart via PM2. Detached updater reports progress at <code>:20129/update/status</code>.</p>
          <div class="mt-16 btn-group">
            <button class="btn btn-primary" id="st-update">⟳ Update & Restart</button>
            <a class="btn" href="http://127.0.0.1:20129/update/status" target="_blank">Status</a>
          </div>
          <div id="st-update-log" class="code-block mt-8 hidden"></div>
        </div>

        <div class="card">
          <div class="card-title">Raw Settings JSON</div>
          <div class="code-block">${UI.esc(JSON.stringify(s, null, 2))}</div>
        </div>
      </div>`;

    // Runtime info from /api/health + /api/version
    API.health().then(h => {
      API.version().then(v => {
        const el = container.querySelector('#rt-info');
        if (el) el.textContent = JSON.stringify({
          runtime: h.runtime, version: v.currentVersion, mode: v.mode,
          api: ':8011', ui: ':8012', mitm: ':443/:8443',
          goVersion: h.goVersion || 'go', uptime: h.uptime || '—', timestamp: h.timestamp,
        }, null, 2);
      });
    });

    container.querySelector('#st-save').onclick = async (e) => {
      const btn = e.currentTarget; btn.innerHTML = UI.spin();
      const patch = { fallbackStrategy: container.querySelector('#st-strategy').value };
      const r = await API.updateSettings(patch);
      const r2 = await API.setLocale(container.querySelector('#st-locale').value);
      btn.textContent = 'Save Settings';
      if (r.error) UI.toast(r.error, 'error');
      else { UI.toast('Settings saved', 'ok'); APP.refresh(); }
    };

    container.querySelector('#st-require').onchange = async (e) => {
      const r = await API.updateSettings({ requireLogin: e.target.checked });
      if (r.error) { UI.toast(r.error, 'error'); e.target.checked = !e.target.checked; }
      else UI.toast(`Login requirement ${e.target.checked ? 'enabled' : 'disabled'}`, 'ok');
    };

    container.querySelector('#st-logout').onclick = async () => {
      await API.logout();
      UI.toast('Logged out', 'ok');
      setTimeout(() => location.reload(), 600);
    };

    container.querySelector('#st-update').onclick = async (e) => {
      if (!confirm('Build latest from source and restart fudrouter? This will briefly interrupt service.')) return;
      const btn = e.currentTarget;
      btn.innerHTML = UI.spin();
      const log = container.querySelector('#st-update-log');
      log.classList.remove('hidden');
      log.textContent = 'spawning updater...';
      const r = await API.updateStart();
      btn.textContent = '⟳ Update & Restart';
      if (r.error) { UI.toast(r.error, 'error'); log.textContent = r.error; return; }
      UI.toast('updater spawned — watching progress', 'info', 4000);
      const iv = setInterval(async () => {
        const s = await API.updateStatus();
        if (s.status) {
          log.textContent = `phase: ${s.status.phase}\nattempt: ${s.status.attempt}/${s.status.maxRetries}\nlog:\n${(s.status.log||[]).join('\n')}`;
          if (s.status.done) {
            clearInterval(iv);
            if (s.status.success) UI.toast('update complete — app restarted', 'ok', 6000);
            else UI.toast('update failed: ' + (s.status.error || 'unknown'), 'error', 8000);
            setTimeout(() => location.reload(), 3000);
          }
        }
      }, 2000);
    };

    container.querySelector('#ca-copy').onclick = () => {
      const p = mitm.caPath || '~/.fudrouter/mitm/rootCA.crt';
      navigator.clipboard?.writeText(p).then(
        () => UI.toast('Path copied: ' + p, 'ok'),
        () => UI.toast(p, 'info', 6000));
    };
  },
};
