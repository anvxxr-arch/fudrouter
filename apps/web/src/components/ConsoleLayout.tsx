import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { CONSOLE_NAV, filterNav } from "../lib/navigation";
import { hasCap } from "../lib/caps";
import { useSession } from "./guards";

// The console bar is the registry's "console" scope filtered by the session's
// role -- the same caps the server enforces (requireCap/section caps). A nav
// item the guard would refuse is not rendered; a route with no entry is
// registry-only. Migration 0019 made the user account the tenant, so the
// workspace/project switchers that used to sit above these links are gone.
//
// Below 720px the sidebar does not stack -- it stacked at 468px, 62% of a
// 390x844 screen spent before any data. It is replaced by a 44px section bar
// (hidden on desktop) whose Menu button opens the same bottom-sheet pattern the
// public header uses (.pub-sheet styles are shared on purpose; one sheet
// implementation means one place for focus, Escape and scroll-lock behaviour).
export function ConsoleLayout({ children }: { children: ReactNode }) {
  const user = useSession();
  const items = filterNav(CONSOLE_NAV, user?.role ?? null);
  const [collapsed, setCollapsed] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const burgerRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();
  const current =
    items.find((i) => (i.to === "/dashboard" ? pathname === "/dashboard" : pathname.startsWith(i.to)))
      ?.label ?? "Dashboard";
  // /admin had no inbound link anywhere in the app: the 17-section registry was
  // only reachable by typing the URL, so the surface existed but nobody could
  // find it. One entry, gated by the same cap the route guard enforces.
  const isAdmin = hasCap(user?.role ?? null, "admin.view");

  // Navigating closes the sheet; without this the new page renders under an
  // overlay that is still covering it.
  useEffect(() => {
    setSheetOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!sheetOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSheetOpen(false);
    };
    document.addEventListener("keydown", onKey);
    // The sheet is fixed; the page behind it must not scroll under a thumb.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const first = sheetRef.current?.querySelector<HTMLElement>(".pub-sheet-link");
    first?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      // Focus returns to the button that opened the sheet so a keyboard user
      // does not land at the top of the document.
      burgerRef.current?.focus();
    };
  }, [sheetOpen]);

  return (
    <div className={"console-shell" + (collapsed ? " collapsed" : "")}>
      <aside className="console-side">
        <button
          type="button"
          className="console-side-toggle"
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={() => setCollapsed((c) => !c)}
        >
          {collapsed ? "»" : "«"}
        </button>
        {!collapsed && (
          <nav className="console-side-nav" aria-label="Dashboard">
            {items.map((i) => (
              <NavLink key={i.to} to={i.to} end={i.to === "/dashboard"} className={({ isActive }) => (isActive ? "current" : undefined)}>
                {i.label}
              </NavLink>
            ))}
            {isAdmin ? (
              <NavLink to="/admin" end className="console-side-admin">Admin console →</NavLink>
            ) : null}
          </nav>
        )}
      </aside>
      <div className="console-mobile-bar">
        <span className="console-mobile-title">{current}</span>
        <button
          ref={burgerRef}
          type="button"
          className="console-mobile-btn"
          aria-haspopup="dialog"
          aria-expanded={sheetOpen}
          onClick={() => setSheetOpen(true)}
        >
          Menu
        </button>
      </div>
      <div className="pub-sheet" data-open={sheetOpen} aria-hidden={!sheetOpen}>
        <button type="button" className="pub-sheet-backdrop" aria-label="Close menu" tabIndex={-1} onClick={() => setSheetOpen(false)} />
        <div ref={sheetRef} className="pub-sheet-panel" role="dialog" aria-modal="true" aria-label="Console menu">
          <div className="pub-sheet-grip" aria-hidden="true" />
          <nav className="pub-sheet-nav" aria-label="Console">
            {items.map((i, n) => (
              <NavLink
                key={i.to}
                to={i.to}
                end={i.to === "/dashboard"}
                style={{ "--i": n } as CSSProperties}
                className={({ isActive }) => (isActive ? "pub-sheet-link active" : "pub-sheet-link")}
              >
                {i.label}
                <span className="pub-sheet-chevron" aria-hidden="true">→</span>
              </NavLink>
            ))}
            {isAdmin ? (
              <NavLink
                to="/admin"
                end
                style={{ "--i": items.length } as CSSProperties}
                className={({ isActive }) => (isActive ? "pub-sheet-link active" : "pub-sheet-link")}
              >
                Admin console
                <span className="pub-sheet-chevron" aria-hidden="true">→</span>
              </NavLink>
            ) : null}
          </nav>
        </div>
      </div>
      <div className="console-main">{children}</div>
    </div>
  );
}
