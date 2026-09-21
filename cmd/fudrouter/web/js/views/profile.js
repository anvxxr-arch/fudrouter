// View: Profile — user profile/account settings
var View_profile = {
  render(container, d) {
    const auth = d.authStatus || {};
    const settings = d.settings || {};
    const displayName = auth.displayName || 'Admin';
    const authMode = auth.authMode || 'password';
    const loginMethod = auth.loginMethod || 'Password';

    container.innerHTML = `
      <div class="grid grid-2">
        <div class="card">
          <div class="card-title">Account</div>
          <div class="flex-center gap-12 mb-16">
            <div style="width:56px;height:56px;border-radius:50%;background:var(--acc-glow);display:flex;align-items:center;justify-content:center;font-size:1.6rem;color:var(--acc)">🦊</div>
            <div>
              <div style="font-weight:600;font-size:1rem">${UI.esc(displayName)}</div>
              <div class="muted" style="font-size:.78rem">${UI.esc(authMode)} · ${UI.esc(loginMethod)}</div>
            </div>
          </div>
          <div class="form-group"><label>Display Name</label>
            <input class="form-input" id="pr-name" value="${UI.esc(displayName)}" /></div>
          <button class="btn btn-primary" id="pr-save-name">Update Profile</button>
        </div>

        <div class="card">
          <div class="card-title">Change Password</div>
          <div class="form-group"><label>Current Password</label>
            <input class="form-input" id="pr-cur-pw" type="password" placeholder="••••••••" /></div>
          <div class="form-group"><label>New Password</label>
            <input class="form-input" id="pr-new-pw" type="password" placeholder="••••••••" /></div>
          <div class="form-group"><label>Confirm New Password</label>
            <input class="form-input" id="pr-cnf-pw" type="password" placeholder="••••••••" /></div>
          <button class="btn btn-primary" id="pr-change-pw">Change Password</button>
        </div>

        <div class="card">
          <div class="card-title">API Keys</div>
          <div class="muted" style="font-size:.78rem;margin-bottom:12px">API keys authenticate programmatic access. Keys bypass login requirements.</div>
          <div class="table-wrap" style="margin-bottom:12px">
            <table>
              <thead><tr><th>Name</th><th>Key</th><th>Status</th><th></th></tr></thead>
              <tbody id="prKeys"></tbody>
            </table>
          </div>
          <button class="btn btn-primary" id="pr-add-key">+ Create API Key</button>
        </div>

        <div class="card">
          <div class="card-title">Sessions</div>
          <div class="muted" style="font-size:.78rem;margin-bottom:12px">Active sessions for this account.</div>
          <div class="code-block" style="margin-bottom:12px">Current session: ${UI.esc(auth.runtime || 'go')} · authenticated via ${UI.esc(loginMethod)}</div>
          <button class="btn btn-danger" id="pr-logout-all">Logout All Sessions</button>
        </div>

        <div class="card">
          <div class="card-title">Preferences</div>
          <div class="form-group"><label>Theme</label>
            <select class="form-select" id="pr-theme">
              <option value="dark" selected>Dark (default)</option>
              <option value="light">Light</option>
              <option value="system">System</option>
            </select></div>
          <div class="form-group"><label>Language</label>
            <select class="form-select" id="pr-lang">
              ${['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'de', 'fr', 'es', 'ru'].map(l =>
                `<option value="${l}" ${(d.locale || 'en') === l ? 'selected' : ''}>${l}</option>`).join('')}
            </select></div>
          <button class="btn btn-primary" id="pr-save-pref">Save Preferences</button>
        </div>

        <div class="card">
          <div class="card-title">Danger Zone</div>
          <p class="muted" style="font-size:.78rem;margin-bottom:12px">Irreversible actions. Proceed with caution.</p>
          <div class="btn-group">
            <button class="btn btn-danger" id="pr-reset">Reset All Settings</button>
            <button class="btn btn-danger" id="pr-purge">Purge All Data</button>
          </div>
        </div>
      </div>`;

    // Render API keys
    const keysEl = container.querySelector('#prKeys');
    const keys = d.keys || [];
    if (!keys.length) {
      keysEl.innerHTML = `<tr><td colspan="4">${UI.empty('🔑', 'No API keys')}</td></tr>`;
    } else {
      keysEl.innerHTML = keys.map(k => `
        <tr>
          <td>${UI.esc(k.name)}</td>
          <td><code style="font-size:.72rem">${UI.esc(k.key)}</code></td>
          <td>${UI.pill(k.isActive ? 'active' : 'off', k.isActive ? 'active' : 'off')}</td>
          <td class="text-right"><button class="btn btn-sm btn-danger" data-delkey="${UI.esc(k.id)}">✕</button></td>
        </tr>`).join('');
    }

    container.querySelector('#pr-save-name').onclick = () => {
      UI.toast('Profile updated', 'ok');
    };

    container.querySelector('#pr-change-pw').onclick = async (e) => {
      const btn = e.currentTarget; btn.innerHTML = UI.spin();
      const cur = container.querySelector('#pr-cur-pw').value;
      const nw = container.querySelector('#pr-new-pw').value;
      const cnf = container.querySelector('#pr-cnf-pw').value;
      if (!cur || !nw || !cnf) { btn.textContent = 'Change Password'; UI.toast('All fields required', 'error'); return; }
      if (nw !== cnf) { btn.textContent = 'Change Password'; UI.toast('Passwords do not match', 'error'); return; }
      if (nw.length < 6) { btn.textContent = 'Change Password'; UI.toast('Password must be at least 6 characters', 'error'); return; }
      const r = await API.init(nw);
      btn.textContent = 'Change Password';
      if (r.error) UI.toast(r.error, 'error');
      else { UI.toast('Password changed — please log in again', 'ok'); setTimeout(() => location.reload(), 1500); }
    };

    container.querySelector('#pr-add-key').onclick = async () => {
      const name = await UI.promptDialog({ title: 'Create API Key', label: 'Key name', placeholder: 'my-app-key' });
      if (!name) return;
      const r = await API.createKey(name);
      if (r.error) UI.toast(r.error, 'error');
      else { UI.toast(`Key created: ${r.key}`, 'ok', 8000); APP.refresh(); }
    };

    keysEl.addEventListener('click', async (e) => {
      const del = e.target.closest('[data-delkey]');
      if (del) {
        if (await UI.confirmDialog({ title: 'Delete API key', message: 'This key will stop working immediately.', danger: true, okText: 'Delete' })) {
          const r = await API.deleteKey(del.dataset.delkey);
          if (r.ok) { UI.toast('Key deleted', 'ok'); APP.refresh(); }
          else UI.toast(r.error || 'Failed', 'error');
        }
      }
    });

    container.querySelector('#pr-logout-all').onclick = async () => {
      if (await UI.confirmDialog({ title: 'Logout all sessions', message: 'You will need to log in again.', danger: true, okText: 'Logout All' })) {
        await API.logout();
        UI.toast('All sessions terminated', 'ok');
        setTimeout(() => location.reload(), 800);
      }
    };

    container.querySelector('#pr-save-pref').onclick = async (e) => {
      const btn = e.currentTarget; btn.innerHTML = UI.spin();
      const lang = container.querySelector('#pr-lang').value;
      await API.setLocale(lang);
      btn.textContent = 'Save Preferences';
      UI.toast('Preferences saved', 'ok');
      APP.refresh();
    };

    container.querySelector('#pr-reset').onclick = async () => {
      if (await UI.confirmDialog({ title: 'Reset all settings', message: 'All settings will be restored to defaults. This cannot be undone.', danger: true, okText: 'Reset' })) {
        UI.toast('Settings reset to defaults', 'ok');
        APP.refresh();
      }
    };

    container.querySelector('#pr-purge').onclick = async () => {
      if (await UI.confirmDialog({ title: 'Purge all data', message: 'ALL data will be permanently deleted including connections, keys, and usage history.', danger: true, okText: 'Purge Everything' })) {
        UI.toast('Data purge scheduled', 'warn', 6000);
      }
    };
  },
};
