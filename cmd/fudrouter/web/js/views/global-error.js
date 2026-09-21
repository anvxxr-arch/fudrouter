// View: Global Error — 500 error page with reload button
var View_globalerror = {
  render(container, d) {
    const err = d._error || {};
    const message = err.message || 'An unexpected error occurred';
    const stack = err.stack || '';

    container.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;min-height:calc(100vh - 160px)">
        <div style="text-align:center;max-width:560px">
          <div style="font-size:5rem;font-weight:800;font-family:var(--mono);color:var(--bad);line-height:1.1;letter-spacing:-0.04em">500</div>
          <div style="font-size:1.4rem;font-weight:700;margin:12px 0 8px">Something Went Wrong</div>
          <div class="muted" style="font-size:.88rem;line-height:1.6;margin-bottom:24px">
            The application encountered an internal error. Try reloading the page.
          </div>
          <div class="code-block" style="text-align:left;margin-bottom:24px;font-size:.78rem;color:var(--bad)">
            <strong>Error:</strong> ${UI.esc(message)}${stack ? `<br><br><strong>Stack:</strong><br>${UI.esc(stack)}` : ''}
          </div>
          <div class="btn-group" style="justify-content:center">
            <button class="btn btn-primary" id="ge-reload">⟳ Reload Page</button>
            <button class="btn" id="ge-home">🏠 Go to Overview</button>
            <button class="btn" id="ge-copy">📋 Copy Error</button>
          </div>
          <div class="mt-16 muted" style="font-size:.72rem">
            Runtime: go · v${d.version?.currentVersion || '?'} · ${UI.fullTs(new Date().toISOString())}
          </div>
        </div>
      </div>`;

    container.querySelector('#ge-reload').onclick = () => location.reload();
    container.querySelector('#ge-home').onclick = () => { location.hash = 'overview'; location.reload(); };
    container.querySelector('#ge-copy').onclick = () => {
      const text = `Error: ${message}\nStack: ${stack}\nTime: ${new Date().toISOString()}`;
      navigator.clipboard?.writeText(text).then(
        () => UI.toast('Error copied to clipboard', 'ok'),
        () => UI.toast('Copy failed — select text manually', 'warn')
      );
    };
  },
};
