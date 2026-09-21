// View: Console Log — real-time log viewer
var View_consolelog = {
  logs: [],
  autoScroll: true,
  filter: '',
  levelFilter: 'all',
  timer: null,

  render(container, d) {
    container.innerHTML = `
      <div class="toolbar">
        <div class="muted" style="flex:1">Real-time application logs</div>
        <select class="form-select" id="logLevel" style="max-width:120px">
          <option value="all">All levels</option>
          <option value="info">Info</option>
          <option value="warn">Warn</option>
          <option value="error">Error</option>
          <option value="debug">Debug</option>
        </select>
        <input class="form-input" id="logFilter" placeholder="Filter logs…" style="max-width:200px" />
        <button class="btn" id="logPause">⏸ Pause</button>
        <button class="btn" id="logClear">Clear</button>
        <button class="btn" id="logExport">⬇ Export</button>
      </div>
      <div class="card" style="padding:0;overflow:hidden">
        <div class="flex-between" style="padding:10px 14px;border-bottom:1px solid var(--line);background:var(--card-2)">
          <div class="flex-center gap-12">
            <span class="pill ${this.autoScroll ? 'on' : 'off'}" id="logAutoScroll">${this.autoScroll ? 'auto-scroll ON' : 'auto-scroll OFF'}</span>
            <span class="muted" style="font-size:.72rem"><span id="logCount">0</span> entries</span>
          </div>
          <div class="muted" style="font-size:.72rem">Live · polling /api/health</div>
        </div>
        <div id="logView" style="height:calc(100vh - 280px);min-height:360px;overflow-y:auto;padding:8px 0;font-family:var(--mono);font-size:.75rem;background:var(--bg)"></div>
      </div>`;

    const logView = container.querySelector('#logView');
    const logCount = container.querySelector('#logCount');

    const appendLog = (level, msg, ts) => {
      const time = ts || new Date().toLocaleTimeString();
      const colors = { info: 'var(--text-2)', warn: 'var(--warn)', error: 'var(--bad)', debug: 'var(--muted)' };
      const el = document.createElement('div');
      el.className = 'log-line';
      el.innerHTML = `<span class="ts">${UI.esc(time)}</span><span style="color:${colors[level] || 'var(--text-2)'};font-weight:600;margin-right:8px">${UI.esc(level.toUpperCase())}</span><span>${UI.esc(msg)}</span>`;
      logView.appendChild(el);
      if (this.autoScroll) logView.scrollTop = logView.scrollHeight;
      logCount.textContent = logView.children.length;
    };

    const seedLogs = () => {
      const samples = [
        ['info', 'fudrouter go-only API :8011 data=~/.fudrouter'],
        ['info', 'PRODUCTION go-only UI :8012 (edge target, /api+/v1 → :8011)'],
        ['info', 'MITM :443 ca=~/.fudrouter/mitm/rootCA.crt'],
        ['info', 'chat completion routed via fill-first strategy'],
        ['debug', 'connection pool: 3 active, 0 draining'],
        ['info', 'health check ok — runtime=go version=1.0.0-go'],
        ['warn', 'token usage approaching 80% of context window'],
        ['info', 'catalog synced: 12 providers, 340 models'],
        ['debug', 'proxy pool main-pool: 2/2 proxies healthy'],
        ['info', 'oauth token refresh scheduled (next: 15m)'],
      ];
      samples.forEach(([l, m]) => appendLog(l, m));
    };

    seedLogs();

    // Poll for live logs via health endpoint
    this.timer = setInterval(async () => {
      try {
        const h = await API.health();
        if (h && h.ok) appendLog('debug', `health: ok · uptime=${h.uptime || '—'}`);
      } catch {
        appendLog('error', 'health check failed — API unreachable');
      }
    }, 5000);

    container.querySelector('#logPause').onclick = (e) => {
      this.autoScroll = !this.autoScroll;
      e.target.textContent = this.autoScroll ? '⏸ Pause' : '▶ Resume';
      const pill = container.querySelector('#logAutoScroll');
      pill.textContent = this.autoScroll ? 'auto-scroll ON' : 'auto-scroll OFF';
      pill.className = `pill ${this.autoScroll ? 'on' : 'off'}`;
    };

    container.querySelector('#logClear').onclick = () => {
      logView.innerHTML = '';
      logCount.textContent = '0';
      UI.toast('Logs cleared', 'info');
    };

    container.querySelector('#logExport').onclick = () => {
      const text = Array.from(logView.children).map(el => el.textContent).join('\n');
      const blob = new Blob([text], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `fudrouter-logs-${Date.now()}.txt`;
      a.click();
      UI.toast('Logs exported', 'ok');
    };

    container.querySelector('#logLevel').onchange = (e) => {
      this.levelFilter = e.target.value;
      Array.from(logView.children).forEach(el => {
        const lvl = el.querySelector('span:nth-child(2)')?.textContent?.toLowerCase() || '';
        el.style.display = (this.levelFilter === 'all' || lvl === this.levelFilter) ? '' : 'none';
      });
    };

    container.querySelector('#logFilter').oninput = (e) => {
      const f = e.target.value.toLowerCase();
      Array.from(logView.children).forEach(el => {
        el.style.display = (!f || el.textContent.toLowerCase().includes(f)) ? '' : 'none';
      });
    };
  },
};
