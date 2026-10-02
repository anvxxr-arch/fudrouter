// View: Quota — quota tracking per OAuth account
var View_quota = {
  render(container, d) {
    const conns = d.connections || [];
    const settings = d.settings || {};
    const quotaData = d.quotaData || {};

    const accountStatuses = [
      { value: 'all', label: 'All accounts' },
      { value: 'active', label: 'Active' },
      { value: 'inactive', label: 'Turned off' },
    ];

    const sortModes = [
      { value: 'default', label: 'Default quota order' },
      { value: 'remaining-asc', label: '% quota: low to high' },
      { value: 'remaining-desc', label: '% quota: high to low' },
    ];

    // Calculate quota for each connection
    const getQuotaInfo = (conn) => {
      const q = quotaData[conn.id];
      if (!q) return null;
      const quotas = q.quotas || [];
      return {
        quotas,
        plan: q.plan,
        message: q.message,
        loading: false,
      };
    };

    const getRemainingPct = (used, total) => {
      if (!total || total === 0) return 100;
      if (!used || used < 0) return 100;
      const pct = Math.round(((total - used) / total) * 100);
      return Math.max(0, Math.min(100, pct));
    };

    const getResetTime = (resetAt) => {
      if (!resetAt) return '-';
      try {
        const reset = new Date(resetAt);
        const now = new Date();
        const diff = reset - now;
        if (diff <= 0) return '-';
        const mins = Math.ceil(diff / 60000);
        if (mins < 60) return `${mins}m`;
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return `${hrs}h ${mins % 60}m`;
        const days = Math.floor(hrs / 24);
        return `${days}d ${hrs % 24}h`;
      } catch { return '-'; }
    };

    const renderQuotaBar = (q) => {
      const remaining = q.remaining !== undefined ? q.remaining : getRemainingPct(q.used, q.total);
      const color = remaining > 70 ? 'var(--ok)' : remaining >= 30 ? 'var(--warn)' : 'var(--bad)';
      return `<div style="height:6px;background:var(--line);border-radius:3px;overflow:hidden">
        <div style="width:${Math.min(remaining, 100)}%;height:100%;background:${color};border-radius:3px;transition:width .6s"></div>
      </div>`;
    };

    const renderQuotaRow = (q) => {
      const remaining = q.remaining !== undefined ? q.remaining : getRemainingPct(q.used, q.total);
      const resetStr = getResetTime(q.resetAt);
      return `<div class="flex-between mb-8">
        <div style="flex:1">
          <div class="flex-between mb-4"><span class="text-2">${UI.esc(q.name)}</span><span class="muted">${resetStr}</span></div>
          ${renderQuotaBar(q)}
          <div class="flex-between mt-4">
            <span class="muted" style="font-size:.72rem">${UI.num(q.used || 0)} / ${q.total ? UI.num(q.total) : '∞'}</span>
            <span style="font-size:.78rem;color:${remaining > 70 ? 'var(--ok)' : remaining >= 30 ? 'var(--warn)' : 'var(--bad)'}">${remaining}%</span>
          </div>
        </div>
      </div>`;
    };

    const renderConnectionQuota = (conn) => {
      const info = getQuotaInfo(conn);
      const isActive = conn.isActive !== false;

      return `<div class="card mb-12 ${isActive ? '' : 'opacity-60'}">
        <div class="flex-between mb-8">
          <div class="flex-center gap-8">
            <img class="provider-logo" src="/providers/${UI.esc(conn.provider)}.png" onerror="this.style.visibility='hidden'" />
            <strong>${UI.esc(conn.name || conn.provider)}</strong>
            ${UI.pill(isActive ? 'active' : 'off', isActive ? 'active' : 'off')}
          </div>
          <div class="btn-group">
            <button class="btn btn-sm" data-refresh-q="${UI.esc(conn.id)}">⟳</button>
            <button class="btn btn-sm btn-danger" data-del-conn="${UI.esc(conn.id)}">✕</button>
          </div>
        </div>
        ${info ? (info.quotas.length > 0
          ? `<div class="mt-8">${info.quotas.map(q => renderQuotaRow(q)).join('')}</div>`
          : `<div class="muted text-center py-16">${UI.empty('📊', info.message || 'No quota data available')}</div>`
        ) : `<div class="muted text-center py-16">${UI.spin()}</div>`}
      </div>`;
    };

    const oauthConns = conns.filter(c => (c.authType || '').toLowerCase() === 'oauth');

    container.innerHTML = `
      <div class="toolbar">
        <div class="muted" style="flex:1">${oauthConns.length} OAuth account${oauthConns.length === 1 ? '' : 's'}</div>
        <select class="form-select" id="qStatus" style="max-width:160px">
          ${accountStatuses.map(s => `<option value="${s.value}">${s.label}</option>`).join('')}
        </select>
        <select class="form-select" id="qSort" style="max-width:200px">
          ${sortModes.map(s => `<option value="${s.value}">${s.label}</option>`).join('')}
        </select>
        <button class="btn" id="btnAutoRefresh">
          <span id="autoRefreshIcon">⏵</span> Auto-refresh
          <span class="muted" id="refreshCountdown"></span>
        </button>
        <button class="btn btn-primary" id="btnRefreshAll">⟳ Refresh All</button>
      </div>

      ${oauthConns.length > 0
        ? `<div id="quotaList">${oauthConns.map(c => renderConnectionQuota(c)).join('')}</div>`
        : `<div class="card text-center py-24">
            ${UI.empty('📊', 'No OAuth accounts connected')}
            <p class="muted mt-8">Connect an OAuth provider (Cursor, Kiro, Codex, Claude, etc.) to track quota usage.</p>
            <button class="btn btn-primary mt-16" id="btnGoOAuth">→ Go to OAuth</button>
          </div>`}
    `;

    // Event handlers
    container.querySelector('#btnRefreshAll').onclick = async (e) => {
      const btn = e.currentTarget; btn.innerHTML = UI.spin();
      // Fetch quota for all connections
      await Promise.allSettled(oauthConns.map(c => API.get(`/api/usage/${c.id}`).then(r => {
        if (r.quotas) quotaData[c.id] = r;
      })));
      btn.textContent = '⟳ Refresh All';
      UI.toast('Quotas refreshed', 'ok');
      this.render(container, d);
    };

    container.querySelector('#qStatus').addEventListener('change', e => {
      const val = e.target.value;
      const cards = container.querySelectorAll('#quotaList > .card');
      cards.forEach(card => {
        const isActive = !card.classList.contains('opacity-60');
        if (val === 'active' && !isActive) card.style.display = 'none';
        else if (val === 'inactive' && isActive) card.style.display = 'none';
        else card.style.display = '';
      });
    });

    container.querySelector('#qSort').addEventListener('change', e => {
      // Re-render with sort
      this.render(container, d);
    });

    container.querySelector('#btnAutoRefresh').onclick = (e) => {
      const icon = container.querySelector('#autoRefreshIcon');
      if (icon.textContent === '⏵') {
        icon.textContent = '⏸';
        UI.toast('Auto-refresh enabled (60s)', 'ok');
      } else {
        icon.textContent = '⏵';
        UI.toast('Auto-refresh disabled', 'info');
      }
    };

    container.querySelector('#btnGoOAuth')?.addEventListener('click', () => APP.navigate('oauth'));

    container.addEventListener('click', async (e) => {
      const refreshQ = e.target.closest('[data-refresh-q]');
      const delConn = e.target.closest('[data-del-conn]');

      if (refreshQ) {
        const btn = refreshQ; btn.innerHTML = UI.spin();
        try {
          const r = await API.get(`/api/usage/${refreshQ.dataset.refreshQ}`);
          quotaData[refreshQ.dataset.refreshQ] = r;
          UI.toast('Quota refreshed', 'ok');
          this.render(container, d);
        } catch (err) {
          UI.toast('Failed to refresh quota', 'error');
          btn.textContent = '⟳';
        }
      }

      if (delConn) {
        if (await UI.confirmDialog({ title: 'Delete connection', message: 'Remove this connection?', danger: true, okText: 'Delete' })) {
          const r = await API.deleteConnection(delConn.dataset.delConn);
          if (r.ok) { UI.toast('Deleted', 'ok'); APP.refresh(); }
          else UI.toast(r.error || 'Delete failed', 'error');
        }
      }
    });
  },
};
