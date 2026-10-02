// View: Not Found — 404 error page
var View_notfound = {
  render(container, d) {
    const route = state_route();
    container.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;min-height:calc(100vh - 160px)">
        <div style="text-align:center;max-width:480px">
          <div style="font-size:5rem;font-weight:800;font-family:var(--mono);color:var(--acc);line-height:1.1;letter-spacing:-0.04em">404</div>
          <div style="font-size:1.4rem;font-weight:700;margin:12px 0 8px">Page Not Found</div>
          <div class="muted" style="font-size:.88rem;line-height:1.6;margin-bottom:24px">
            The page <code style="background:var(--card-2);padding:2px 8px;border-radius:4px">${UI.esc(route)}</code> does not exist or has been moved.
          </div>
          <div class="code-block" style="text-align:left;margin-bottom:24px;font-size:.75rem">
            <span style="color:var(--muted)">// available routes:</span><br>
            ${Object.keys(APP.routes).map(r => `<span style="color:var(--acc)">#${UI.esc(r)}</span>`).join(' · ')}
          </div>
          <div class="btn-group" style="justify-content:center">
            <button class="btn btn-primary" id="nf-home">🏠 Go to Overview</button>
            <button class="btn" id="nf-back">← Back</button>
          </div>
        </div>
      </div>`;

    container.querySelector('#nf-home').onclick = () => APP.navigate('overview');
    container.querySelector('#nf-back').onclick = () => history.back();
  },
};

function state_route() {
  return location.hash.slice(1) || 'unknown';
}
