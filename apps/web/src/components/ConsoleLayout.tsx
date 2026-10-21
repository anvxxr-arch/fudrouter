import { useState, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { CONSOLE_NAV, filterNav } from "../lib/navigation";
import { useSession } from "./guards";

// The console bar is the registry's "console" scope filtered by the session's
// role -- the same caps the server enforces (requireCap/section caps). A nav
// item the guard would refuse is not rendered; a route with no entry is
// registry-only. Migration 0019 made the user account the tenant, so the
// workspace/project switchers that used to sit above these links are gone.
export function ConsoleLayout({ children }: { children: ReactNode }) {
  const user = useSession();
  const items = filterNav(CONSOLE_NAV, user?.role ?? null);
  const [collapsed, setCollapsed] = useState(false);
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
          </nav>
        )}
      </aside>
      <div className="console-main">{children}</div>
    </div>
  );
}
