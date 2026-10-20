import { Suspense, useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { PUBLIC_NAV, filterNav } from '../lib/navigation';
import { api, type StatusPayload } from '../lib/api';

// The footer's "all systems operational" dot. It reads the same /api/status
// the status page reads, once per page load — no polling. It shows a green dot
// ONLY when the response says every component is operational AND the incident
// history actually loaded. A failed fetch, `incidents: null` (the incident
// query threw — the database is unreachable) or an unknown overall state all
// render the bare link: "we could not check" must never read as "all clear".
function StatusDot() {
  const [state, setState] = useState<StatusPayload['overall'] | null>(null);
  useEffect(() => {
    void api.status().then((d) => {
      if (d && (d.incidents ?? null) !== null && d.overall.state === 'operational') setState(d.overall);
    });
  }, []);
  if (!state) return null;
  return (
    <span className="status-dot" role="img" aria-label={state.label}>
      <span className="status-dot-ok" aria-hidden="true" />
    </span>
  );
}

// Links come from the shared registry (src/lib/navigation.ts) instead of a
// local array: the nav bar and the route guard table were two lists that had to
// agree, and nothing made them. The registry is the listing; caps.ts +
// guards.tsx remain the enforcement.
export function PublicLayout() {
  const links = filterNav(PUBLIC_NAV, null);
  return (
    <>
      <a className="skip-link" href="#content">
        Skip to content
      </a>
      <header className="pub">
        <NavLink className="brand" to="/">
          fudrouter
        </NavLink>
        <nav aria-label="Primary">
          {links.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              className={({ isActive }) => (isActive ? 'active' : undefined)}
            >
              {l.label}
            </NavLink>
          ))}
        </nav>
        <span className="spacer" />
        {/* One door. Two buttons (“Log in” + “Get started”) both led to the
            same Discord round trip once signup stopped being a separate page. */}
        <NavLink className="cta" to="/login">
          Log in
        </NavLink>
      </header>
      <main className="shell">
        <div id="content">
          <Suspense fallback={<p className="muted" role="status" aria-live="polite">Loading…</p>}>
            <Outlet />
          </Suspense>
        </div>
      </main>
      <footer className="foot">
        <div className="foot-cols">
          <div className="foot-brand">
            <strong>fudrouter</strong>
            <span>One API key, every model.</span>
          </div>
          <div className="foot-col">
            <p className="fr-label">Product</p>
            <ul>
              <li><NavLink to="/features">Features</NavLink></li>
              <li><NavLink to="/integrations">Integrations</NavLink></li>
              <li><NavLink to="/models">Models</NavLink></li>
              <li><NavLink to="/pricing">Pricing</NavLink></li>
              <li><NavLink to="/changelog">Changelog</NavLink></li>
              <li><NavLink to="/login">Log in</NavLink></li>
            </ul>
          </div>
          <div className="foot-col">
            <p className="fr-label">Docs</p>
            <ul>
              <li><NavLink to="/docs">Documentation</NavLink></li>
              <li><NavLink to="/docs/getting-started/quickstart">Quickstart</NavLink></li>
              <li><NavLink to="/docs/api/authentication">Authentication</NavLink></li>
              <li><NavLink to="/docs/routing/fallback">Routing and fallback</NavLink></li>
              <li><NavLink to="/docs/observability/observability">What gets recorded</NavLink></li>
              <li><NavLink to="/docs/api/errors">Error reference</NavLink></li>
            </ul>
          </div>
          <div className="foot-col">
            <p className="fr-label">Company</p>
            <ul>
              <li><NavLink to="/security">Security</NavLink></li>
              <li><NavLink to="/terms">Terms</NavLink></li>
              <li><NavLink to="/privacy">Privacy</NavLink></li>
            </ul>
          </div>
          <div className="foot-col">
            <p className="fr-label">Status</p>
            <ul>
              <li>
                <NavLink to="/status">
                  System status
                  <StatusDot />
                </NavLink>
              </li>
            </ul>
          </div>
        </div>
        <span>© 2026 fudrouter</span>
      </footer>
    </>
  );
}
