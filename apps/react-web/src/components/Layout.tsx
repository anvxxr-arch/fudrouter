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
          <Outlet />
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
      <style>{`
        .pub { display: flex; flex-wrap: wrap; gap: var(--space-md); align-items: center; padding: var(--space-md) var(--space-lg); border-bottom: 1px solid var(--color-border); }
        .pub a { display: inline-flex; align-items: center; min-height: 24px; }
        .brand { color: var(--color-text); font-weight: 700; }
        .brand:hover { text-decoration: none; }
        .pub nav { display: flex; flex-wrap: wrap; gap: var(--space-md); }
        .pub nav a { padding: var(--space-xs) 0; border-bottom: 2px solid transparent; color: var(--color-text-muted); font-size: var(--text-sm); }
        .pub nav a:hover { color: var(--color-text); text-decoration: none; }
        .pub nav a.active { border-bottom-color: var(--primary); color: var(--color-text); }
        .spacer { margin-left: auto; }
        .cta { padding: var(--space-sm) var(--space-md); background: var(--primary); color: var(--on-primary); border-radius: var(--radius-md); font-size: var(--text-sm); font-weight: 600; }
        .cta:hover { background: var(--primary-hover); text-decoration: none; }
        .shell { max-width: 1100px; margin: 0 auto; padding: var(--space-lg); }
        .foot { display: flex; flex-wrap: wrap; gap: var(--space-md); align-items: center; justify-content: space-between; max-width: 1100px; margin: 0 auto; padding: var(--space-lg); color: var(--color-text-muted); font-size: var(--text-sm); }
        .foot .legal { display: flex; gap: var(--space-md); }
      `}</style>
    </>
  );
}
