import { Suspense, useId, useRef, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { Menu, X, ChevronRight } from 'lucide-react';
import { useSession } from "./guards";
import { PUBLIC_NAV, filterNav } from '../lib/navigation';
import { api, type StatusPayload } from '../lib/api';
import { Button } from '@/components/ui/button';
import { Sheet, SheetClose, SheetContent, SheetTitle } from '@/components/ui/sheet';

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
    <span className="inline-flex size-2 items-center justify-center" role="img" aria-label={state.label}>
      <span className="size-2 rounded-full bg-[var(--primary)]" aria-hidden="true" />
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
      <a className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:text-foreground focus:ring-2 focus:ring-ring" href="#content">
        Skip to content
      </a>
      {consoleRoute ? null : (
        <header
          ref={headerRef}
          className="shell-gutter sticky top-0 z-50 flex h-[var(--header-h)] items-center gap-4 border-b border-border bg-background/80 backdrop-blur-xl data-[scrolled=true]:border-border-strong data-[scrolled=true]:bg-background/95"
        >
          <NavLink
            to="/"
            className="flex flex-none items-center gap-2 font-semibold text-foreground hover:no-underline"
          >
            <span className="brand-dot" aria-hidden="true" />
            fudrouter
          </NavLink>
          {/* Desktop nav. Hidden below 720px, where the sheet takes over. */}
          <nav className="hidden min-w-0 flex-none flex-wrap gap-4 overflow-x-auto md:flex" aria-label="Primary">
            {links.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                className={({ isActive }) =>
                  `relative inline-flex min-h-11 items-center whitespace-nowrap px-0.5 text-sm transition-colors after:absolute after:inset-x-0 after:bottom-2 after:h-0.5 after:origin-center after:rounded-sm ${
                    isActive
                      ? 'text-foreground after:scale-x-100 after:bg-[var(--primary)]'
                      : 'text-muted-foreground hover:text-foreground after:scale-x-0 after:bg-[var(--primary)] hover:after:scale-x-100'
                  }`
                }
              >
                {l.label}
              </NavLink>
            ))}
          </nav>
          <span className="ml-auto" />
          {/* One door. Two buttons (“Log in” + “Get started”) both led to the
              same Discord round trip once signup stopped being a separate page.
              The console renders inside this layout, so an authenticated visitor
              was still offered "Log in" on /dashboard -- a dead end that looks
              like the session was lost. One label, switched by session. */}
          <Button asChild size="sm" className="hidden md:inline-flex">
            <NavLink to={user ? "/dashboard" : "/login"}>
              {user ? "Dashboard" : "Log in"}
            </NavLink>
          </Button>
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetContent side="bottom" showCloseButton={false} className="gap-0 bg-background px-4 pb-6 pt-4" aria-describedby={undefined}>
              <SheetTitle className="sr-only">Menu</SheetTitle>
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-2 font-semibold text-foreground">
                  <span className="brand-dot" aria-hidden="true" />
                  fudrouter
                </span>
                <SheetClose asChild>
                  <button
                    type="button"
                    className="inline-flex size-11 items-center justify-center rounded-md border border-border text-muted-foreground hover:text-foreground"
                    aria-label="Close menu"
                  >
                    <X className="size-5" />
                  </button>
                </SheetClose>
              </div>
              {/* The sheet opens from the bottom, so the grabber explains where
                  the surface came from without promising a drag that is not
                  wired. */}
              <div className="mx-auto mt-0 h-1 w-12 flex-none rounded-full bg-muted" aria-hidden="true" />
              <nav className="mt-2 grid gap-1" aria-label="Primary">
                {links.map((l) => (
                  <SheetClose asChild key={l.to}>
                    <NavLink
                      to={l.to}
                      className={({ isActive }) =>
                        `flex min-h-[52px] items-center justify-between rounded-md px-3 text-base transition-colors ${
                          isActive
                            ? 'bg-[var(--accent)] font-semibold text-foreground'
                            : 'text-muted-foreground hover:bg-[var(--accent)] hover:text-foreground'
                        }`
                      }
                    >
                      {l.label}
                      <ChevronRight className="size-4 text-muted-foreground" />
                    </NavLink>
                  </SheetClose>
                ))}
              </nav>
              <SheetClose asChild>
                <Button asChild size="lg" className="mt-2 w-full" variant={user ? 'secondary' : 'default'}>
                  <NavLink to={user ? "/dashboard" : "/login"}>
                    {user ? "Dashboard" : "Log in"}
                  </NavLink>
                </Button>
              </SheetClose>
            </SheetContent>
          </Sheet>
          {/* Burger: visible only below 720px. The shadcn Sheet closes on
              Escape / outside tap / the X, with focus return handled by Radix
              Dialog, so this button only has to open it. */}
          <button
            type="button"
            className="inline-grid size-11 flex-none place-items-center rounded-md border border-border text-foreground md:hidden"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <Menu className="size-5" />
          </button>
          <span
            className="pointer-events-none absolute inset-x-0 -bottom-px h-0.5 origin-left scale-x-[var(--scroll-progress,0)] bg-gradient-to-r from-[var(--primary)] to-emerald-400"
            aria-hidden="true"
          />
        </header>
      )}

      <main className="mx-auto w-full max-w-(--shell-max) px-6 py-8">
        <div id="content">
          <Suspense fallback={<p className="text-muted-foreground" role="status" aria-live="polite">Loading…</p>}>
            <Outlet />
          </Suspense>
        </div>
      </main>
      <footer className="mx-auto flex w-full max-w-(--shell-max) flex-wrap items-center justify-between gap-4 px-6 py-6 text-sm text-muted-foreground">
        <div className="flex w-full flex-wrap gap-6 md:flex-nowrap">
          <div className="min-w-0 flex-shrink-0">
            <strong className="block text-foreground">fudrouter</strong>
            <span>One API key, every model.</span>
            <span className="mt-2 block">© 2026 fudrouter</span>
          </div>
          <div className="grid flex-1 grid-cols-2 gap-6 sm:grid-cols-4">
            <div className="flex flex-col gap-2">
              <p className="eyebrow">Product</p>
              <ul className="grid gap-2">
                <li><NavLink className="hover:text-foreground hover:underline" to="/features">Features</NavLink></li>
                <li><NavLink className="hover:text-foreground hover:underline" to="/integrations">Integrations</NavLink></li>
                <li><NavLink className="hover:text-foreground hover:underline" to="/models">Models</NavLink></li>
                <li><NavLink className="hover:text-foreground hover:underline" to="/pricing">Pricing</NavLink></li>
                <li><NavLink className="hover:text-foreground hover:underline" to="/changelog">Changelog</NavLink></li>
                <li><NavLink className="hover:text-foreground hover:underline" to="/login">Log in</NavLink></li>
              </ul>
            </div>
            <div className="flex flex-col gap-2">
              <p className="eyebrow">Docs</p>
              <ul className="grid gap-2">
                <li><NavLink className="hover:text-foreground hover:underline" to="/docs">Documentation</NavLink></li>
                <li><NavLink className="hover:text-foreground hover:underline" to="/docs/getting-started/quickstart">Quickstart</NavLink></li>
                <li><NavLink className="hover:text-foreground hover:underline" to="/docs/api/authentication">Authentication</NavLink></li>
                <li><NavLink className="hover:text-foreground hover:underline" to="/docs/routing/fallback">Routing and fallback</NavLink></li>
                <li><NavLink className="hover:text-foreground hover:underline" to="/docs/observability/observability">What gets recorded</NavLink></li>
                <li><NavLink className="hover:text-foreground hover:underline" to="/docs/api/errors">Error reference</NavLink></li>
              </ul>
            </div>
            <div className="flex flex-col gap-2">
              <p className="eyebrow">Company</p>
              <ul className="grid gap-2">
                <li><NavLink className="hover:text-foreground hover:underline" to="/security">Security</NavLink></li>
                <li><NavLink className="hover:text-foreground hover:underline" to="/terms">Terms</NavLink></li>
                <li><NavLink className="hover:text-foreground hover:underline" to="/privacy">Privacy</NavLink></li>
              </ul>
            </div>
            <div className="flex flex-col gap-2">
              <p className="eyebrow">Status</p>
              <ul className="grid gap-2">
                <li>
                  <NavLink className="inline-flex items-center gap-1.5 hover:text-foreground hover:underline" to="/status">
                    System status
                    <StatusDot />
                  </NavLink>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </footer>
    </>
  );
}
