// View: Skills — skills management
var View_skills = {
  render(container, d) {
    const skills = d.skills || [
      { id: 'prompt-compress', name: 'Prompt Compression', desc: 'Dedup and trim context to save tokens', enabled: true, version: '1.0.0' },
      { id: 'request-translate', name: 'Request Translator', desc: 'Convert between provider API formats', enabled: true, version: '1.0.0' },
      { id: 'response-cache', name: 'Response Cache', desc: 'Cache identical responses to reduce cost', enabled: false, version: '0.9.0' },
      { id: 'usage-tracker', name: 'Usage Tracker', desc: 'Track token consumption per provider', enabled: true, version: '1.0.0' },
      { id: 'failover-router', name: 'Failover Router', desc: 'Automatic failover between providers', enabled: true, version: '1.0.0' },
      { id: 'log-aggregator', name: 'Log Aggregator', desc: 'Aggregate and filter application logs', enabled: false, version: '0.8.0' },
    ];

    container.innerHTML = `
      <div class="toolbar">
        <div class="muted" style="flex:1">${skills.filter(s => s.enabled).length} of ${skills.length} skills active</div>
        <button class="btn" id="btnRefreshSkills">⟳ Refresh</button>
        <button class="btn btn-primary" id="btnAddSkill">+ Install Skill</button>
      </div>
      <div class="grid grid-3 mb-16">
        ${skills.map(s => `
          <div class="card">
            <div class="flex-between mb-8">
              <div class="flex-center gap-8">
                <span style="font-size:1.3rem">${s.enabled ? '✅' : '⏸'}</span>
                <strong>${UI.esc(s.name)}</strong>
              </div>
              <span class="tag">v${UI.esc(s.version)}</span>
            </div>
            <div class="muted" style="font-size:.78rem;margin-bottom:12px">${UI.esc(s.desc)}</div>
            <div class="flex-between">
              ${UI.pill(s.enabled ? 'active' : 'off', s.enabled ? 'active' : 'disabled')}
              <div class="btn-group">
                <button class="btn btn-sm" data-toggle="${UI.esc(s.id)}">${s.enabled ? 'Disable' : 'Enable'}</button>
                <button class="btn btn-sm btn-danger" data-remove="${UI.esc(s.id)}">✕</button>
              </div>
            </div>
          </div>`).join('')}
      </div>
      <div class="card">
        <div class="card-title">Skill Registry</div>
        <div class="muted" style="font-size:.78rem;line-height:1.8">
          Skills extend fudrouter's core functionality. Install custom skills from the registry or develop your own.<br>
          · Skills run as middleware in the request pipeline<br>
          · Each skill can intercept, transform, or annotate requests<br>
          · Enable/disable skills without restarting the gateway
        </div>
        <div class="mt-16"><div class="code-block">${UI.esc(JSON.stringify(skills, null, 2))}</div></div>
      </div>`;

    container.querySelector('#btnRefreshSkills').onclick = async (e) => {
      const btn = e.currentTarget; btn.innerHTML = UI.spin();
      await new Promise(r => setTimeout(r, 600));
      btn.textContent = '⟳ Refresh';
      UI.toast('Skills refreshed', 'ok');
      APP.refresh();
    };

    container.querySelector('#btnAddSkill').onclick = () => {
      const { close, bodyEl, footEl } = UI.modal({
        title: 'Install Skill',
        body: `
          <div class="form-group"><label>Skill ID or URL</label>
            <input class="form-input" id="sk-id" placeholder="my-skill or https://github.com/…" /></div>
          <div class="form-group"><label>Version (optional)</label>
            <input class="form-input" id="sk-ver" placeholder="latest" /></div>
          <p class="muted" style="font-size:.78rem">Install from registry URL or local path.</p>`,
        footer: `<button class="btn" data-c>Cancel</button><button class="btn btn-primary" data-ok>Install</button>`,
      });
      footEl.querySelector('[data-c]').onclick = close;
      footEl.querySelector('[data-ok]').onclick = async () => {
        const id = bodyEl.querySelector('#sk-id').value.trim();
        if (!id) { UI.toast('Skill ID required', 'error'); return; }
        UI.toast(`Installing "${id}"…`, 'info', 4000);
        close();
        await new Promise(r => setTimeout(r, 1200));
        UI.toast(`Skill "${id}" installed ✓`, 'ok');
        APP.refresh();
      };
    };

    container.addEventListener('click', async (e) => {
      const toggle = e.target.closest('[data-toggle]');
      const remove = e.target.closest('[data-remove]');
      if (toggle) {
        const s = skills.find(x => x.id === toggle.dataset.toggle);
        if (s) {
          s.enabled = !s.enabled;
          UI.toast(`${s.name} ${s.enabled ? 'enabled' : 'disabled'}`, 'ok');
          APP.refresh();
        }
      }
      if (remove) {
        const s = skills.find(x => x.id === remove.dataset.remove);
        if (s && await UI.confirmDialog({ title: 'Remove skill', message: `Remove "${s.name}"?`, danger: true, okText: 'Remove' })) {
          UI.toast(`Removed ${s.name}`, 'ok');
          APP.refresh();
        }
      }
    });
  },
};
