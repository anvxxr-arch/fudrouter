// View: Overview — system status, live charts, health
var View_overview = {
  render(container, d) {
    const h = d.health || {};
    const u = d.usage || {};
    const v = d.version || {};
    const conns = d.connections || [];
    const keys = d.keys || [];
    const providers = d.providers || [];
    const active = conns.filter(c => c.isActive).length;
    const tunnel = d.tunnelStatus;
    const mitm = d.mitmStatus;

    // Stats cards
    const stats = [
      { value: conns.length, label: 'Connections', delta: `${active} active` },
      { value: keys.length, label: 'API Keys' },
      { value: UI.num(u.totalRequests || 0), label: 'Total Requests' },
      { value: UI.num(u.promptTokens || 0), label: 'Prompt Tokens' },
      { value: UI.num(u.completionTokens || 0), label: 'Completion Tokens' },
      { value: providers.length, label: 'Providers' },
    ];

    const tunnelCard = tunnel ? `
      <div class="card">
        <div class="card-title">Tunnel (cloudflared)</div>
        <div class="flex-center gap-12">
          <div>
            <span class="pill ${tunnel.enabled ? 'on' : 'off'}">${tunnel.enabled ? 'running' : 'stopped'}</span>
          </div>
          ${tunnel.hostname ? `<span class="text-2">${UI.esc(tunnel.hostname)}</span>` : ''}
        </div>
        ${tunnel.target ? `<div class="muted mt-8">→ ${UI.esc(tunnel.target)}</div>` : ''}
      </div>` : '';

    const mitmCard = mitm ? `
      <div class="card">
        <div class="card-title">MITM Proxy</div>
        <div class="flex-center gap-12 mb-8">
          <span class="pill ${mitm.caExists ? 'on' : 'off'}">${mitm.caExists ? 'CA ready' : 'CA missing'}</span>
          ${mitm.listening && (mitm.listening['443'] || mitm.listening['8443'])
            ? `<span class="pill on">listening</span>`
            : `<span class="pill off">not listening</span>`}
        </div>
        ${mitm.caPath ? `<div class="muted text-2" style="font-size:.75rem">${UI.esc(mitm.caPath)}</div>` : ''}
        ${mitm.targets && mitm.targets.length ? `
          <div class="mt-8"><span class="text-2">Targets:</span></div>
          <div class="btn-group mt-8">${mitm.targets.map(t => `<span class="tag">${UI.esc(t)}</span>`).join('')}</div>
        ` : ''}
      </div>` : '';

    container.innerHTML = `
      <div class="grid">
        ${stats.map(s => `
          <div class="card stat-card">
            <div class="value">${s.value}</div>
            <div class="label">${s.label}</div>
            ${s.delta ? `<div class="delta up">${UI.esc(s.delta)}</div>` : ''}
          </div>
        `).join('')}
      </div>

      <div class="grid grid-2">
        <div class="card">
          <div class="card-title">Live Requests</div>
          <div class="chart-wrap"><canvas id="reqChart" class="chart-canvas"></canvas></div>
        </div>
        <div class="card">
          <div class="card-title">Provider Distribution</div>
          <div id="provDist"></div>
        </div>
      </div>

      <div class="grid grid-2">
        ${tunnelCard}
        ${mitmCard}
      </div>

      <div class="grid grid-2">
        <div class="card">
          <div class="card-title">Health</div>
          <div class="code-block">${UI.esc(JSON.stringify(h, null, 2))}</div>
        </div>
        <div class="card">
          <div class="card-title">Version</div>
          <div class="code-block">${UI.esc(JSON.stringify(v, null, 2))}</div>
          ${d.settings ? `<div class="mt-8"><div class="card-title">Runtime Settings</div><div class="code-block">${UI.esc(JSON.stringify(d.settings, null, 2))}</div></div>` : ''}
        </div>
      </div>
    `;

    // Draw charts after render
    requestAnimationFrame(() => {
      this.drawReqChart(d.history);
      this.drawProvDist(u, conns);
    });
  },

  drawReqChart(history) {
    const canvas = document.getElementById('reqChart');
    if (!canvas || !history || !history.length) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width = canvas.offsetWidth * 2;
    const h = canvas.height = canvas.offsetHeight * 2;
    ctx.scale(2, 2);
    const cw = w / 2;
    const ch = h / 2;

    // Group by minute buckets
    const buckets = {};
    const now = Date.now();
    const hourAgo = now - 3600000;
    for (let i = 0; i < 60; i++) buckets[i] = 0;
    history.forEach(r => {
      const t = new Date(r.timestamp).getTime();
      if (t > hourAgo) {
        const idx = Math.floor((t - hourAgo) / 60000);
        if (idx >= 0 && idx < 60) buckets[idx]++;
      }
    });
    const vals = Object.values(buckets);
    const max = Math.max(...vals, 1);

    // Draw
    ctx.clearRect(0, 0, cw, ch);
    const gradient = ctx.createLinearGradient(0, 0, 0, ch);
    gradient.addColorStop(0, 'rgba(246,130,31,0.3)');
    gradient.addColorStop(1, 'rgba(246,130,31,0.0)');

    ctx.beginPath();
    ctx.moveTo(0, ch);
    vals.forEach((v, i) => {
      const x = (i / 59) * cw;
      const y = ch - (v / max) * ch * 0.9;
      ctx.lineTo(x, y);
    });
    ctx.lineTo(cw, ch);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.beginPath();
    vals.forEach((v, i) => {
      const x = (i / 59) * cw;
      const y = ch - (v / max) * ch * 0.9;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#f6821f';
    ctx.lineWidth = 2;
    ctx.stroke();
  },

  drawProvDist(usage, conns) {
    const el = document.getElementById('provDist');
    if (!el) return;
    const byProv = {};
    if (usage.byProvider) {
      Object.assign(usage.byProvider);
    }
    // From connections
    conns.forEach(c => {
      byProv[c.provider] = (byProv[c.provider] || 0) + 1;
    });

    const entries = Object.entries(byProv);
    if (!entries.length) { el.innerHTML = UI.empty('📊', 'No provider data'); return; }
    const max = Math.max(...entries.map(e => e[1]));
    el.innerHTML = entries.map(([p, n]) => `
      <div class="mb-8">
        <div class="flex-between mb-8"><span>${UI.esc(p)}</span><span class="muted">${n}</span></div>
        <div style="height:6px;background:var(--line);border-radius:3px;overflow:hidden">
          <div style="width:${(n/max)*100}%;height:100%;background:var(--acc);border-radius:3px;transition:width .6s"></div>
        </div>
      </div>
    `).join('');
  },
};
