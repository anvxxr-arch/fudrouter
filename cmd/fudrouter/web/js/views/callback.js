// View: Callback — OAuth callback handler with auto-close
var View_callback = {
  render(container, d) {
    const params = new URLSearchParams(location.hash.split('?')[1] || location.search);
    const code = params.get('code') || params.get('state');
    const error = params.get('error');
    const provider = params.get('provider') || 'unknown';

    container.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;min-height:calc(100vh - 120px)">
        <div class="card" style="max-width:440px;width:100%;text-align:center">
          <div style="font-size:2.5rem;margin-bottom:12px">${error ? '❌' : '✅'}</div>
          <h2 style="font-size:1.1rem;font-weight:700;margin-bottom:8px">
            ${error ? 'Authorization Failed' : 'Authorization Complete'}
          </h2>
          <div class="muted" style="font-size:.82rem;margin-bottom:20px;line-height:1.6">
            ${error
              ? `Error: ${UI.esc(error)}${params.get('error_description') ? ` — ${UI.esc(params.get('error_description'))}` : ''}`
              : `Successfully authorized with ${UI.esc(provider)}. This window will close automatically.`}
          </div>
          ${!error ? `
            <div class="code-block" style="text-align:left;margin-bottom:16px;font-size:.72rem">
              provider: ${UI.esc(provider)}<br>
              code: ${UI.esc(code?.slice(0, 20) || '')}…<br>
              status: exchanging token…
            </div>
          ` : ''}
          <div class="btn-group" style="justify-content:center">
            <button class="btn btn-primary" id="cb-close">Close Window</button>
            <button class="btn" id="cb-back">Back to Dashboard</button>
          </div>
          <div class="mt-16 muted" style="font-size:.72rem" id="cb-countdown"></div>
        </div>
      </div>`;

    container.querySelector('#cb-close').onclick = () => window.close();
    container.querySelector('#cb-back').onclick = () => { location.hash = 'overview'; };

    if (!error) {
      // Auto-close countdown
      let secs = 5;
      const countdownEl = container.querySelector('#cb-countdown');
      const iv = setInterval(() => {
        secs--;
        if (secs > 0) countdownEl.textContent = `Closing in ${secs}s…`;
        else { clearInterval(iv); window.close(); }
      }, 1000);

      // Notify parent window if opened via window.opener
      try {
        if (window.opener && window.opener !== window) {
          window.opener.postMessage({ type: 'fudrouter-oauth', provider, code }, '*');
        }
      } catch {}
    }
  },
};
