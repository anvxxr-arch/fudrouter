// Shared navigation registry: the single table that drives every nav bar.
//
// Why one table: nav used to be inline in three places -- PublicLayout (public
// links), ConsoleLayout (dashboard buttons), admin.tsx AdminNav (section list)
// -- while the guards lived in two more (caps.ts ROUTE_CAPS for the SPA,
// rbac.mjs SECTION_CAPS for the server). A nav item the guard refuses is a
// button that 403s; a guarded route with no nav entry is unreachable. The
// registry keeps the *listing* in one place and the *enforcement* in the
// existing tables: every item names the capability the server enforces, so the
// cap must agree with requiredCap()'s longest-prefix match on the same path.
//
// Server remains the enforcement path: filtering here only hides controls.
// Guards (RequireAuth/RequireCap/RequireRouteCap in components/guards.tsx +
// requireCap in server/index.mjs) still refuse; a client-side filter never
// grants.
import { hasCap, requiredCap, type Capability } from "./caps";

export type NavScope = "public" | "console" | "admin";

export interface NavItem {
  /** Absolute path or path pattern (":param" segments match one segment). */
  to: string;
  label: string;
  scope: NavScope;
  /** Capability the server enforces for this path; null = public. */
  cap: Capability | null;
  /** Show in the nav bar (false = registry-only: route exists, not listed). */
  nav: boolean;
}

// Public chrome mirrors components/Layout.tsx links verbatim so the refactor
// changes no pixels: Models, Providers, Pricing, Docs.
export const PUBLIC_NAV: readonly NavItem[] = [
  { to: "/", label: "Home", scope: "public", cap: null, nav: false },
  { to: "/models", label: "Models", scope: "public", cap: null, nav: true },
  { to: "/models/compare", label: "Compare", scope: "public", cap: null, nav: false },
  { to: "/models/:slug", label: "Model detail", scope: "public", cap: null, nav: false },
  { to: "/providers", label: "Providers", scope: "public", cap: null, nav: false },
  { to: "/providers/:slug", label: "Provider detail", scope: "public", cap: null, nav: false },
  { to: "/pricing", label: "Pricing", scope: "public", cap: null, nav: true },
  { to: "/docs", label: "Docs", scope: "public", cap: null, nav: true },
  { to: "/docs/*", label: "Docs section", scope: "public", cap: null, nav: false },
  { to: "/changelog", label: "Changelog", scope: "public", cap: null, nav: false },
  { to: "/changelog/:slug", label: "Changelog entry", scope: "public", cap: null, nav: false },
  { to: "/legal/terms", label: "Terms", scope: "public", cap: null, nav: false },
  { to: "/legal/privacy", label: "Privacy", scope: "public", cap: null, nav: false },
  { to: "/login", label: "Log in", scope: "public", cap: null, nav: false },
  { to: "/signup", label: "Sign up", scope: "public", cap: null, nav: false },
];

// Member console. Primary bar mirrors DashShell.tsx verbatim (Overview, Keys,
// Usage, Billing, Team, Workspace, Playground-conditional); every other
// /dashboard/* route the router serves is registry-only (nav: false) so the
// guard table and the listing cannot drift.
export const CONSOLE_NAV: readonly NavItem[] = [
  { to: "/dashboard", label: "Overview", scope: "console", cap: "member", nav: true },
  { to: "/dashboard/keys", label: "Keys", scope: "console", cap: "member", nav: true },
  { to: "/dashboard/usage", label: "Usage", scope: "console", cap: "member", nav: true },
  { to: "/dashboard/billing", label: "Billing", scope: "console", cap: "member", nav: true },
  { to: "/dashboard/billing/credits", label: "Credits", scope: "console", cap: "member", nav: false },
  { to: "/dashboard/billing/invoices", label: "Invoices", scope: "console", cap: "member", nav: false },
  { to: "/dashboard/billing/payment-methods", label: "Payment methods", scope: "console", cap: "member", nav: false },
  { to: "/dashboard/account", label: "Account", scope: "console", cap: "member", nav: false },
  { to: "/dashboard/workspace", label: "Workspace", scope: "console", cap: "member", nav: true },
  { to: "/dashboard/team/members", label: "Team", scope: "console", cap: "member", nav: true },
  { to: "/dashboard/team/invitations", label: "Invitations", scope: "console", cap: "member", nav: false },
  { to: "/dashboard/team/roles", label: "Roles", scope: "console", cap: "member", nav: false },
  { to: "/dashboard/projects/new", label: "New project", scope: "console", cap: "member", nav: false },
  { to: "/dashboard/projects/:projectId", label: "Project", scope: "console", cap: "member", nav: false },
  { to: "/dashboard/projects/:projectId/playground", label: "Playground", scope: "console", cap: "member", nav: false },
  { to: "/dashboard/projects/:projectId/:name", label: "Project section", scope: "console", cap: "member", nav: false },
  { to: "/invite/:token", label: "Invitation", scope: "console", cap: "member", nav: false },
];

// Admin console. Caps mirror server/lib/rbac.mjs SECTION_CAPS exactly (plus
// /admin itself = admin.view); labels keep AdminNav's lowercase section names
// so the rendered bar is byte-identical.
export const ADMIN_NAV: readonly NavItem[] = [
  { to: "/admin", label: "Overview", scope: "admin", cap: "admin.view", nav: true },
  { to: "/admin/analytics", label: "analytics", scope: "admin", cap: "admin.view", nav: true },
  { to: "/admin/billing", label: "billing", scope: "admin", cap: "admin.billing", nav: true },
  { to: "/admin/connections", label: "connections", scope: "admin", cap: "admin.ops", nav: true },
  { to: "/admin/health", label: "health", scope: "admin", cap: "admin.ops", nav: true },
  { to: "/admin/incidents", label: "incidents", scope: "admin", cap: "admin.ops", nav: true },
  { to: "/admin/keys", label: "keys", scope: "admin", cap: "admin.keys", nav: true },
  { to: "/admin/models", label: "models", scope: "admin", cap: "admin.models", nav: true },
  { to: "/admin/projects", label: "projects", scope: "admin", cap: "admin.users", nav: true },
  { to: "/admin/providers", label: "providers", scope: "admin", cap: "admin.providers", nav: true },
  { to: "/admin/requests", label: "requests", scope: "admin", cap: "admin.requests", nav: true },
  { to: "/admin/routing", label: "routing", scope: "admin", cap: "admin.ops", nav: true },
  { to: "/admin/security", label: "security", scope: "admin", cap: "admin.audit", nav: true },
  { to: "/admin/settings", label: "settings", scope: "admin", cap: "admin.settings", nav: true },
  { to: "/admin/system", label: "system", scope: "admin", cap: "admin.ops", nav: true },
  { to: "/admin/traffic", label: "traffic", scope: "admin", cap: "admin.ops", nav: true },
  { to: "/admin/users", label: "users", scope: "admin", cap: "admin.users", nav: true },
  { to: "/admin/workspaces", label: "workspaces", scope: "admin", cap: "admin.users", nav: true },
  { to: "/admin/:section/:id", label: "Detail", scope: "admin", cap: "admin.view", nav: false },
];

export const navigationRegistry: readonly NavItem[] = [...PUBLIC_NAV, ...CONSOLE_NAV, ...ADMIN_NAV];

/**
 * Items of one scope that `role` may see (nav: true only). Hiding only -- the
 * guards and the server remain the enforcement path.
 */
export function filterNav(items: readonly NavItem[], role: string | null | undefined): NavItem[] {
  return items.filter((i) => i.nav && (!i.cap || hasCap(role ?? null, i.cap)));
}

export { requiredCap };
