import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { Menu, X, ChevronLeft, ChevronRight, PanelLeft, ArrowLeft } from "lucide-react";
import { ADMIN_NAV, CONSOLE_NAV, filterNav } from "../lib/navigation";
import { hasCap } from "../lib/caps";
import { useSession } from "./guards";
import { cn } from "cn";
import { Sheet, SheetClose, SheetContent, SheetTitle } from "@/components/ui/sheet";

// The console bar is the registry's "console" scope filtered by the session's
// role -- the same caps the server enforces (requireCap/section caps). A nav
// item the guard would refuse is not rendered; a route with no entry is
// registry-only. Migration 0019 made the user account the tenant, so the
// workspace/project switchers that used to sit above these links are gone.
//
// Below 720px the sidebar does not stack -- it stacked at 468px, 62% of a
// 390x844 screen spent before any data. It is replaced by a 44px section bar
// (hidden on desktop) whose Menu button opens the same bottom sheet the public
// header uses (one sheet implementation means one place for focus, Escape and
// scroll-lock behaviour; here it is the shadcn Sheet, whose Radix Dialog owns
// all three).
export function ConsoleLayout({ children }: { children: ReactNode }) {
  const user = useSession();
  const { pathname } = useLocation();
  // The admin tree used to render inside the public layout: the marketing header
  // (Pricing / Features / …) sat above a second 17-pill admin bar, so a signed-in
  // admin had two navigations that both looked primary. /admin now shares this
  // shell, and the sidebar becomes contextual -- one nav surface per page, the
  // same pattern the member console already used.
  const isAdminTree = pathname === "/admin" || pathname.startsWith("/admin/");
  const items = filterNav(isAdminTree ? ADMIN_NAV : CONSOLE_NAV, user?.role ?? null);
  const [collapsed, setCollapsed] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const current = isAdminTree
    ? "Admin"
    : items.find((i) => (i.to === "/dashboard" ? pathname === "/dashboard" : pathname.startsWith(i.to)))
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

  return (
    <div
      className={cn(
        "mx-auto w-full max-w-(--shell-max) px-4 py-8 md:px-6",
        "grid items-start gap-8",
        collapsed ? "grid-cols-[auto_minmax(0,1fr)]" : "md:grid-cols-[14rem_minmax(0,1fr)]",
      )}
    >
      <aside className={cn("sticky top-6 hidden gap-4 md:grid", collapsed ? "md:grid-cols-1" : "")}>
        <button
          type="button"
          className="justify-self-start rounded-md border border-border px-2 py-0.5 text-sm text-muted-foreground hover:border-border-strong hover:text-foreground"
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={() => setCollapsed((c) => !c)}
        >
          {collapsed ? <PanelLeft className="size-4" /> : <PanelLeft className="size-4" />}
        </button>
        {!collapsed && (
          <nav className="grid gap-2" aria-label={isAdminTree ? "Admin sections" : "Dashboard"}>
            {isAdminTree ? (
              <NavLink
                to="/dashboard"
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft className="size-4" /> Console
              </NavLink>
            ) : null}
            {items.map((i) => (
              <NavLink
                key={i.to}
                to={i.to}
                end={i.to === "/dashboard" || i.to === "/admin"}
                className={({ isActive }) =>
                  cn(
                    "rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-[var(--accent)] hover:text-foreground",
                    isActive && "bg-[var(--accent)] font-semibold text-foreground",
                  )
                }
              >
                {i.label}
              </NavLink>
            ))}
            {!isAdminTree && isAdmin ? (
              <NavLink
                to="/admin"
                end
                className="mt-2 inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm text-muted-foreground hover:text-foreground"
              >
                Admin console <ChevronRight className="size-4" />
              </NavLink>
            ) : null}
          </nav>
        )}
      </aside>

      <div className="flex h-11 items-center justify-between border-b border-border md:hidden">
        <span className="text-sm font-medium text-foreground">{current}</span>
        <button
          type="button"
          className="inline-grid size-11 flex-none place-items-center rounded-md border border-border text-foreground"
          aria-haspopup="dialog"
          aria-expanded={sheetOpen}
          aria-label="Open menu"
          onClick={() => setSheetOpen(true)}
        >
          <Menu className="size-5" />
        </button>
      </div>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="bottom" showCloseButton={false} className="gap-0 bg-background px-4 pb-6 pt-4">
          <SheetTitle className="sr-only">{isAdminTree ? "Admin sections" : "Console menu"}</SheetTitle>
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-foreground">{current}</span>
            <SheetClose asChild>
              <button
                type="button"
                className="inline-grid size-11 place-items-center rounded-md border border-border text-muted-foreground hover:text-foreground"
                aria-label="Close menu"
              >
                <X className="size-5" />
              </button>
            </SheetClose>
          </div>
          <div className="mx-auto mt-1 h-1 w-12 flex-none rounded-full bg-muted" aria-hidden="true" />
          <nav className="mt-2 grid gap-1" aria-label={isAdminTree ? "Admin sections" : "Console"}>
            {isAdminTree ? (
              <SheetClose asChild>
                <NavLink
                  to="/dashboard"
                  className="flex min-h-[44px] items-center gap-1 rounded-md px-3 text-base text-muted-foreground hover:bg-[var(--accent)] hover:text-foreground"
                >
                  <ArrowLeft className="size-4" /> Console
                </NavLink>
              </SheetClose>
            ) : null}
            {items.map((i) => (
              <SheetClose asChild key={i.to}>
                <NavLink
                  to={i.to}
                  end={i.to === "/dashboard" || i.to === "/admin"}
                  className={({ isActive }) =>
                    cn(
                      "flex min-h-[44px] items-center justify-between rounded-md px-3 text-base text-muted-foreground hover:bg-[var(--accent)] hover:text-foreground",
                      isActive && "bg-[var(--accent)] font-semibold text-foreground",
                    )
                  }
                >
                  {i.label}
                  <ChevronRight className="size-4 text-muted-foreground" />
                </NavLink>
              </SheetClose>
            ))}
            {!isAdminTree && isAdmin ? (
              <SheetClose asChild>
                <NavLink
                  to="/admin"
                  end
                  className="flex min-h-[44px] items-center justify-between rounded-md px-3 text-base text-muted-foreground hover:bg-[var(--accent)] hover:text-foreground"
                >
                  Admin console
                  <ChevronRight className="size-4 text-muted-foreground" />
                </NavLink>
              </SheetClose>
            ) : null}
          </nav>
        </SheetContent>
      </Sheet>

      <div className="console-main min-w-0 md:col-start-2">{children}</div>
    </div>
  );
}
