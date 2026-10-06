import { Suspense } from 'react';
import { NavLink, Outlet } from 'react-router-dom';

const links = [
  { to: '/models', label: 'Models' },
  { to: '/providers', label: 'Providers' },
  { to: '/pricing', label: 'Pricing' },
  { to: '/playground', label: 'Playground' },
  { to: '/docs', label: 'Docs' },
  { to: '/status', label: 'Status' },
] as const;

export function Layout() {
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
              aria-current={undefined}
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
          <Suspense fallback={<p className="muted">Loading…</p>}>
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
