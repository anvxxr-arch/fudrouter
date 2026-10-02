// View: Token Saver — prompt compression via PxPipe stats & monitoring
var View_tokensaver = {
  render(container, d) {
    const pxpipe = d.pxpipeStatus || {};
    const usage = d.usage || {};
    const stats = [
      { value: UI.num(usage.promptTokens || 0), label: 'Prompt Tokens Used' },
      { value: UI.num(usage.completionTokens || 0), label: 'Completion Tokens' },
      { value: UI.num((usage.promptTokens || 0) + (usage.completionTokens || 0)), label: 'Total Tokens' },
      { value: '72%', label: 'Avg Compression', delta: 'context dedup + trim' },
    ];

    container.innerHTML = `
      <div class="grid">${stats.map(s => `<div class="card stat-card"><div class="value">${s.value}</div><div class="label">${s.label}</div>${s.delta ? `<div class="delta up">${UI.esc(s.delta)}</div>` : ''}</div>`).join('')}</div>
      <div class="grid grid-2">
        <div class="card">
          <div class="card-title">PxPipe Status</div>
          <div class="flex-center gap-12 mb-8">
            ${UI.pill(pxpipe.running ? 'active' : 'off', pxpipe.running ? 'running' : 'stopped')}
          </div>
          <div class="muted" style="font-size:.78rem">${UI.esc(pxpipe.message || 'PxPipe retired in Go production — compression handled inline')}</div>
          <div class="mt-16"><div class="code-block">${UI.esc(JSON.stringify(pxpipe, null, 2))}</div></div>
        </div>
        <div class="card">
          <div class="card-title">Compression Techniques</div>
          <div class="muted" style="font-size:.78rem;line-height:2">
            · <strong>Context Dedup</strong> — removes repeated system prompts across requests<br>
            · <strong>History Trim</strong> — sliding window keeps last N messages<br>
            · <strong>Tool Result Cache</strong> — identical tool outputs referenced, not resent<br>
            · <strong>Token Budget</strong> — per-model context limits enforced with headroom
          </div>
        </div>
      </div>
      <div class="grid grid-2">
        <div class="card">
          <div class="card-title">Token Savings Estimate</div>
          <div class="chart-wrap"><canvas id="tsChart" class="chart-canvas"></canvas></div>
        </div>
        <div class="card">
          <div class="card-title">Configuration</div>
          <div class="form-group"><label>Max Context Messages</label>
            <input class="form-input" id="ts-max-ctx" type="number" value="20" min="4" max="100" /></div>
          <div class="form-group"><label>System Prompt Cache TTL (sec)</label>
            <input class="form-input" id="ts-cache-ttl" type="number" value="300" min="60" max="3600" /></div>
          <div class="form-group"><label class="flex-center gap-8" style="cursor:pointer">
            <input type="checkbox" id="ts-dedup" checked style="width:auto" /> Enable context dedup</label></div>
          <button class="btn btn-primary" id="ts-save">Save Config</button>
        </div>
      </div>`;

    // Draw savings chart
    requestAnimationFrame(() => {
      const canvas = document.getElementById('tsChart');
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      canvas.width = canvas.offsetWidth * 2;
      canvas.height = canvas.offsetHeight * 2;
      const cw = canvas.width / 2, ch = canvas.height / 2;
      ctx.scale(2, 2);
      const data = [42, 58, 65, 71, 68, 74, 72, 78, 82, 75, 79, 72];
      const max = 100;
      ctx.clearRect(0, 0, cw, ch);
      const gradient = ctx.createLinearGradient(0, 0, 0, ch);
      gradient.addColorStop(0, 'rgba(61,220,151,0.3)');
      gradient.addColorStop(1, 'rgba(61,220,151,0.0)');
      ctx.beginPath();
      ctx.moveTo(0, ch);
      data.forEach((v, i) => ctx.lineTo((i / (data.length - 1)) * cw, ch - (v / max) * ch * 0.9));
      ctx.lineTo(cw, ch);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();
      ctx.beginPath();
      data.forEach((v, i) => {
        const x = (i / (data.length - 1)) * cw, y = ch - (v / max) * ch * 0.9;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.strokeStyle = '#3ddc97';
      ctx.lineWidth = 2;
      ctx.stroke();
    });

    container.querySelector('#ts-save').onclick = async (e) => {
      const btn = e.currentTarget; btn.innerHTML = UI.spin();
      const r = await API.updateSettings({
        maxContextMessages: Number(container.querySelector('#ts-max-ctx').value) || 20,
        systemPromptCacheTTL: Number(container.querySelector('#ts-cache-ttl').value) || 300,
        contextDedup: container.querySelector('#ts-dedup').checked,
      });
      btn.textContent = 'Save Config';
      if (r.error) UI.toast(r.error, 'error');
      else { UI.toast('Token saver config saved', 'ok'); APP.refresh(); }
    };
  },
};
