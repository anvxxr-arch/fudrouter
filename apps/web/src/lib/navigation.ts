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

// Public chrome is Models, Pricing, Changelog and Docs. The provider directory
// and legal pages are still withdrawn, so their registry entries went with
// them — a `to` left here with no route behind it is a nav item that 404s,
// which is exactly what the deleted /models entries had become before the
// catalogue page came back. `/` and
// `/login` stay as registry-only entries (nav: false) because they are still
// public ROUTES: the head test asserts every public route has SEO metadata, so
// dropping them here would hide that check rather than satisfy it.
export const PUBLIC_NAV: readonly NavItem[] = [
  { to: "/", label: "Home", scope: "public", cap: null, nav: false },
  { to: "/pricing", label: "Pricing", scope: "public", cap: null, nav: true },
  { to: "/features", label: "Features", scope: "public", cap: null, nav: true },
  { to: "/integrations", label: "Integrations", scope: "public", cap: null, nav: true },
  { to: "/models", label: "Models", scope: "public", cap: null, nav: true },
  { to: "/changelog", label: "Changelog", scope: "public", cap: null, nav: true },
  { to: "/docs", label: "Docs", scope: "public", cap: null, nav: true },
  { to: "/docs/*", label: "Docs section", scope: "public", cap: null, nav: false },
  { to: "/login", label: "Log in", scope: "public", cap: null, nav: false },
  // Security, Terms and Privacy are public ROUTES kept in the registry so the
  // head test's "every public route has SEO metadata" check sees them. The top
  // nav bar stays at Models/Pricing/Features/Integrations/Changelog/Docs; these
  // three are footer links, so they are registry-only (nav: false).
  { to: "/security", label: "Security", scope: "public", cap: null, nav: false },
  { to: "/status", label: "Status", scope: "public", cap: null, nav: false },
  { to: "/terms", label: "Terms", scope: "public", cap: null, nav: false },
  { to: "/privacy", label: "Privacy", scope: "public", cap: null, nav: false },
  // `/signup` is deliberately absent: it is a redirect to /login, not a page
  // with its own chrome. A registry entry would keep advertising a destination
  // that exists only to forward. The head test still knows the path (see
  // lib/seo.ts), so it keeps answering 200 + noindex instead of a soft 404.
];

// Member console. Primary bar is Overview, Keys, Usage, Logs, Playground and
// the account capability surfaces (limits, budgets, aliases, routing, alerts)
// plus Billing and Settings; every other /dashboard/* route the router serves
// is registry-only (nav: false) so the guard table and the listing cannot
// drift.
export const CONSOLE_NAV: readonly NavItem[] = [
  { to: "/dashboard", label: "Overview", scope: "console", cap: "member", nav: true },
  { to: "/dashboard/keys", label: "Keys", scope: "console", cap: "member", nav: true },
  { to: "/dashboard/usage", label: "Usage", scope: "console", cap: "member", nav: true },
  { to: "/dashboard/logs", label: "Logs", scope: "console", cap: "member", nav: true },
  { to: "/dashboard/playground", label: "Playground", scope: "console", cap: "member", nav: true },
  { to: "/dashboard/limits", label: "Limits", scope: "console", cap: "member", nav: true },
  { to: "/dashboard/budgets", label: "Budgets", scope: "console", cap: "member", nav: true },
  { to: "/dashboard/aliases", label: "Aliases", scope: "console", cap: "member", nav: true },
  { to: "/dashboard/routing", label: "Routing", scope: "console", cap: "member", nav: true },
  { to: "/dashboard/alerts", label: "Alerts", scope: "console", cap: "member", nav: true },
  { to: "/dashboard/billing", label: "Billing", scope: "console", cap: "member", nav: true },
  { to: "/dashboard/billing/credits", label: "Credits", scope: "console", cap: "member", nav: false },
  { to: "/dashboard/billing/invoices", label: "Invoices", scope: "console", cap: "member", nav: false },
  { to: "/dashboard/billing/payment-methods", label: "Payment methods", scope: "console", cap: "member", nav: false },
  { to: "/dashboard/account", label: "Account", scope: "console", cap: "member", nav: false },
  { to: "/dashboard/settings", label: "Settings", scope: "console", cap: "member", nav: true },
];

// Admin console. Caps mirror server/lib/rbac.mjs SECTION_CAPS exactly (plus
// /admin itself = admin.view); labels keep AdminNav's lowercase section names
// so the rendered bar is byte-identical.
export const ADMIN_NAV: readonly NavItem[] = [
  { to: "/admin", label: "Overview", scope: "admin", cap: "admin.view", nav: true },
  { to: "/admin/access", label: "Access", scope: "admin", cap: "admin.access", nav: true },
  { to: "/admin/analytics", label: "Analytics", scope: "admin", cap: "admin.view", nav: true },
  { to: "/admin/billing", label: "Billing", scope: "admin", cap: "admin.billing", nav: true },
  { to: "/admin/connections", label: "Connections", scope: "admin", cap: "admin.ops", nav: true },
  { to: "/admin/health", label: "Health", scope: "admin", cap: "admin.ops", nav: true },
  { to: "/admin/incidents", label: "Incidents", scope: "admin", cap: "admin.ops", nav: true },
  { to: "/admin/keys", label: "Keys", scope: "admin", cap: "admin.keys", nav: true },
  { to: "/admin/models", label: "Models", scope: "admin", cap: "admin.models", nav: true },
  { to: "/admin/providers", label: "Providers", scope: "admin", cap: "admin.providers", nav: true },
  { to: "/admin/requests", label: "Requests", scope: "admin", cap: "admin.requests", nav: true },
  { to: "/admin/routing", label: "Routing", scope: "admin", cap: "admin.ops", nav: true },
  { to: "/admin/security", label: "Security", scope: "admin", cap: "admin.audit", nav: true },
  { to: "/admin/settings", label: "Settings", scope: "admin", cap: "admin.settings", nav: true },
  { to: "/admin/system", label: "System", scope: "admin", cap: "admin.ops", nav: true },
  { to: "/admin/traffic", label: "Traffic", scope: "admin", cap: "admin.ops", nav: true },
  { to: "/admin/users", label: "Users", scope: "admin", cap: "admin.users", nav: true },
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
