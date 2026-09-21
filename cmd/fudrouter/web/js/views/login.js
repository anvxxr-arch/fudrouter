// View: Login — dedicated login page
var View_login = {
  render(container, d) {
    const auth = d.authStatus || {};
    const hasPassword = auth.hasPassword !== false;

    container.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;min-height:calc(100vh - 120px)">
        <div class="card" style="max-width:420px;width:100%">
          <div style="text-align:center;margin-bottom:24px">
            <div style="font-size:2.5rem;margin-bottom:8px">🦊</div>
            <h2 style="font-size:1.2rem;font-weight:700">fudrouter</h2>
            <div class="muted" style="font-size:.78rem">Sign in to your dashboard</div>
          </div>
          ${hasPassword ? `
            <div class="form-group"><label>Password</label>
              <input class="form-input" id="login-pw" type="password" placeholder="Enter admin password" style="font-size:1rem;padding:12px 14px" /></div>
            <button class="btn btn-primary" id="login-btn" style="width:100%;padding:12px;font-size:.9rem">Sign In</button>
          ` : `
            <div class="muted" style="font-size:.78rem;margin-bottom:16px">No password configured. Set one to secure your dashboard.</div>
            <div class="form-group"><label>New Password</label>
              <input class="form-input" id="login-new-pw" type="password" placeholder="Create admin password" /></div>
            <div class="form-group"><label>Confirm Password</label>
              <input class="form-input" id="login-cnf-pw" type="password" placeholder="Confirm password" /></div>
            <button class="btn btn-primary" id="login-btn" style="width:100%;padding:12px;font-size:.9rem">Set Password & Continue</button>
          `}
          <div id="login-err" class="mt-16" style="color:var(--bad);font-size:.78rem;text-align:center;display:none"></div>
          <div class="mt-16 muted" style="font-size:.72rem;text-align:center">
            Runtime: ${UI.esc(auth.runtime || 'go')} · v${d.version?.currentVersion || '?'}
          </div>
        </div>
      </div>`;

    const input = container.querySelector('#login-pw') || container.querySelector('#login-new-pw');
    const btn = container.querySelector('#login-btn');
    const err = container.querySelector('#login-err');

    const doLogin = async () => {
      if (hasPassword) {
        const pw = input.value;
        if (!pw) { err.textContent = 'Password required'; err.style.display = 'block'; return; }
        btn.disabled = true; btn.innerHTML = UI.spin();
        const res = await API.login(pw);
        if (res.ok) { UI.toast('Welcome back', 'ok'); APP.refresh(); }
        else { err.textContent = res.error || 'Login failed'; err.style.display = 'block'; btn.disabled = false; btn.textContent = 'Sign In'; }
      } else {
        const pw = container.querySelector('#login-new-pw').value;
        const cnf = container.querySelector('#login-cnf-pw').value;
        if (!pw || pw.length < 6) { err.textContent = 'Password must be at least 6 characters'; err.style.display = 'block'; return; }
        if (pw !== cnf) { err.textContent = 'Passwords do not match'; err.style.display = 'block'; return; }
        btn.disabled = true; btn.innerHTML = UI.spin();
        const res = await API.init(pw);
        if (res.ok) { UI.toast('Password set — signing in', 'ok'); APP.refresh(); }
        else { err.textContent = res.error || 'Failed'; err.style.display = 'block'; btn.disabled = false; btn.textContent = 'Set Password & Continue'; }
      }
    };

    btn.onclick = doLogin;
    if (input) {
      input.focus();
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
    }
  },
};
