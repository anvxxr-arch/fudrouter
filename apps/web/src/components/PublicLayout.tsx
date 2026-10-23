import { Suspense, useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { useSession } from "./guards";
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
  const user = useSession();
  // Mobile navigation is a sheet, not a scrolling rail. Six links never fit
  // beside the brand and the login button on a phone, and a horizontally
  // scrolling row hides half of them behind a gesture nobody is told about
  // (measured: a 34px fade still read as the word “Integratic” cut in half).
  // A sheet shows every destination at once, at a size a thumb can hit, and it
  // costs one 44px button in the header instead of a second nav row.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();
  const burgerRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();
  // /dashboard and /admin render ConsoleLayout, which brings its own chrome
  // (sidebar, 44px mobile bar, sheet). This layout kept rendering the marketing
  // header above them, so every console page opened with Pricing / Features /
  // Integrations / Models / Changelog / Docs -- 68px of links a signed-in
  // operator never wants, directly above the nav they do want.
  const consoleRoute = pathname === "/dashboard" || pathname.startsWith("/dashboard/")
    || pathname === "/admin" || pathname.startsWith("/admin/");

  // Navigating closes the sheet. Without this the new page renders underneath
  // an overlay that is still covering it.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    // The sheet is fixed and the page behind it must not scroll under a thumb.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const first = sheetRef.current?.querySelector<HTMLElement>('.pub-sheet-link');
    first?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      // Focus goes back to the button that opened the sheet, so a keyboard
      // user does not land at the top of the document.
      burgerRef.current?.focus();
    };
  }, [menuOpen]);
  // The header is sticky, so it needs to know two things the CSS cannot: how far
  // the page has been read (the progress rail) and whether the page has moved at
  // all (the solid background). Both are written as a CSS variable / data
  // attribute from one rAF-throttled scroll listener — no state, so scrolling
  // never re-renders the tree.
  const headerRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const doc = document.documentElement;
      const max = doc.scrollHeight - window.innerHeight;
      const y = window.scrollY;
      const p = max > 0 ? Math.min(1, Math.max(0, y / max)) : 0;
      el.style.setProperty('--scroll-progress', p.toFixed(4));
      el.dataset.scrolled = y > 8 ? 'true' : 'false';
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
  return (
    <>
      <a className="skip-link" href="#content">
        Skip to content
      </a>
      {consoleRoute ? null : (<header className="pub" ref={headerRef}>
        <NavLink className="brand" to="/">
          fudrouter
        </NavLink>
        {/* Desktop nav. Hidden at <=720px, where the sheet takes over. */}
        <nav className="pub-nav" aria-label="Primary">
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
        {/* The console renders inside this layout, so an authenticated visitor
            was still offered "Log in" on /dashboard -- a dead end that looks
            like the session was lost. One label, switched by session. */}
        <NavLink className="cta pub-cta" to={user ? "/dashboard" : "/login"}>
          {user ? "Dashboard" : "Log in"}
        </NavLink>
        <button
          ref={burgerRef}
          type="button"
          className="menu-btn"
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={menuOpen}
          aria-controls={menuId}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <span className="menu-bars" data-open={menuOpen} aria-hidden="true" />
        </button>
        <span className="pub-progress" aria-hidden="true" />
      </header>)}

      {/* Mobile sheet. Kept mounted and hidden with `visibility` so the panel
          can animate both ways and so closed links leave the tab order. The
          backdrop is a button, not a div, so it is reachable by assistive tech
          as the close action it is. */}
      {consoleRoute ? null : (<div className="pub-sheet" id={menuId} data-open={menuOpen} aria-hidden={!menuOpen}>
        <button
          type="button"
          className="pub-sheet-backdrop"
          aria-label="Close menu"
          tabIndex={-1}
          onClick={() => setMenuOpen(false)}
        />
        <div
          ref={sheetRef}
          className="pub-sheet-panel"
          role="dialog"
          aria-modal="true"
          aria-label="Menu"
        >
          {/* No header row inside the sheet and no second close button: the
              burger above the scrim has already crossed into an X and every
              tap outside the panel closes it (the scrim's whole surface is the
              close button), so a row reading “MENU ×” would say the same thing
              twice. The grabber is the only furniture — it explains where the
              surface came from without promising a drag that is not wired. */}
          <div className="pub-sheet-grip" aria-hidden="true" />
          <nav className="pub-sheet-nav" aria-label="Primary">
            {links.map((l, i) => (
              <NavLink
                key={l.to}
                to={l.to}
                style={{ '--i': i } as CSSProperties}
                className={({ isActive }) =>
                  isActive ? 'pub-sheet-link active' : 'pub-sheet-link'
                }
              >
                {l.label}
                <span className="pub-sheet-chevron" aria-hidden="true">→</span>
              </NavLink>
            ))}
          </nav>
          <NavLink className="cta pub-sheet-cta" to={user ? "/dashboard" : "/login"}>
            {user ? "Dashboard" : "Log in"}
          </NavLink>
        </div>
      </div>)}
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
