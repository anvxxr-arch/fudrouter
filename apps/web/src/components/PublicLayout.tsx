import { Suspense } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { PUBLIC_NAV, filterNav } from '../lib/navigation';

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
        <NavLink to="/login">Log in</NavLink>
        <NavLink className="cta" to="/signup">
          Get started
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
        <span>© fudrouter — commercial AI router</span>
        <span className="legal">
          <NavLink to="/status">Status</NavLink>
          <NavLink to="/docs">Docs</NavLink>
          <NavLink to="/pricing">Pricing</NavLink>
        </span>
      </footer>
    </>
  );
}
