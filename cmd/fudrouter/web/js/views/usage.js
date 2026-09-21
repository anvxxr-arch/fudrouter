// View: Usage — chart + history table + per-provider breakdown
var View_usage = {
  render(container, d) {
    const u = d.usage || {};
    const history = d.history || [];
    const stats = [
      { value: UI.num(u.totalRequests || 0), label: 'Total Requests' },
      { value: UI.num(u.promptTokens || 0), label: 'Prompt Tokens' },
      { value: UI.num(u.completionTokens || 0), label: 'Completion Tokens' },
      { value: UI.num((u.promptTokens || 0) + (u.completionTokens || 0)), label: 'Total Tokens' },
    ];
    container.innerHTML = `
      <div class="grid">${stats.map(s => `<div class="card stat-card"><div class="value">${s.value}</div><div class="label">${s.label}</div></div>`).join('')}</div>
      <div class="grid grid-2 mb-16">
        <div class="card">
          <div class="card-title">Requests — last hour</div>
          <div class="chart-wrap"><canvas id="usageChart" class="chart-canvas"></canvas></div>
        </div>
        <div class="card">
          <div class="card-title">Per-Provider Breakdown</div>
          <div id="usageByProv"></div>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Time</th><th>Provider</th><th>Model</th><th>Tokens (p/c)</th><th>Status</th></tr></thead>
          <tbody id="usageRows"></tbody>
        </table>
      </div>`;
    const rowsEl = container.querySelector('#usageRows');
    if (!history.length) {
      rowsEl.innerHTML = `<tr><td colspan="5">${UI.empty('📈', 'No usage recorded yet')}</td></tr>`;
    } else {
      rowsEl.innerHTML = history.slice(0, 100).map(h => `<tr>
        <td class="muted">${UI.fullTs(h.timestamp)}</td>
        <td><div class="flex-center gap-8">
          <img class="provider-logo" src="/providers/${UI.esc(h.provider)}.png" onerror="this.style.visibility='hidden'" />
          ${UI.esc(h.provider)}</div></td>
        <td><code>${UI.esc(h.model || '—')}</code></td>
        <td class="muted">${UI.num(h.promptTokens || 0)} / ${UI.num(h.completionTokens || 0)}</td>
        <td>${UI.pill(h.status, h.status)}</td>
      </tr>`).join('');
    }
    requestAnimationFrame(() => { this.drawChart(history); this.drawByProv(history); });
  },

  drawChart(history) {
    const canvas = document.getElementById('usageChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = canvas.offsetWidth * 2;
    canvas.height = canvas.offsetHeight * 2;
    const cw = canvas.width / 2, ch = canvas.height / 2;
    ctx.scale(2, 2);
    const now = Date.now(), hourAgo = now - 3600000;
    const buckets = new Array(60).fill(0);
    history.forEach(r => {
      const t = new Date(r.timestamp).getTime();
      if (t >= hourAgo) {
        const idx = Math.floor((t - hourAgo) / 60000);
        if (idx >= 0 && idx < 60) buckets[idx]++;
      }
    });
    const max = Math.max(...buckets, 1);
    const gradient = ctx.createLinearGradient(0, 0, 0, ch);
    gradient.addColorStop(0, 'rgba(246,130,31,0.3)');
    gradient.addColorStop(1, 'rgba(246,130,31,0)');
    ctx.beginPath();
    ctx.moveTo(0, ch);
    buckets.forEach((v, i) => ctx.lineTo((i / 59) * cw, ch - (v / max) * ch * 0.9));
    ctx.lineTo(cw, ch);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.beginPath();
    buckets.forEach((v, i) => {
      const x = (i / 59) * cw, y = ch - (v / max) * ch * 0.9;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#f6821f';
    ctx.lineWidth = 2;
    ctx.stroke();
  },

  drawByProv(history) {
    const el = document.getElementById('usageByProv');
    if (!el) return;
    const byProv = {};
    history.forEach(h => {
      if (!byProv[h.provider]) byProv[h.provider] = { count: 0, tokens: 0 };
      byProv[h.provider].count++;
      byProv[h.provider].tokens += (h.promptTokens || 0) + (h.completionTokens || 0);
    });
    const entries = Object.entries(byProv).sort((a, b) => b[1].count - a[1].count);
    if (!entries.length) { el.innerHTML = UI.empty('📊', 'No data'); return; }
    const max = entries[0][1].count;
    el.innerHTML = entries.map(([p, s]) => `
      <div class="mb-8">
        <div class="flex-between mb-8"><span>${UI.esc(p)}</span><span class="muted">${s.count} req · ${UI.num(s.tokens)} tok</span></div>
        <div style="height:6px;background:var(--line);border-radius:3px;overflow:hidden">
          <div style="width:${(s.count / max) * 100}%;height:100%;background:var(--acc)"></div>
        </div>
      </div>`).join('');
  },
};
