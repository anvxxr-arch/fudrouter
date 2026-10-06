export type Capability =
  | "member" | "admin.view" | "admin.users" | "admin.keys" | "admin.providers"
  | "admin.models" | "admin.requests" | "admin.ops" | "admin.billing"
  | "admin.programs" | "admin.audit" | "admin.settings";
const ROLE_CAPS: Record<string, Capability[]> = {
  user: ["member"],
  finance_admin: ["member", "admin.view", "admin.billing", "admin.users"],
  ops_admin: ["member", "admin.view", "admin.providers", "admin.models", "admin.requests", "admin.ops"],
  admin: ["member", "admin.view", "admin.users", "admin.keys", "admin.providers", "admin.models", "admin.requests", "admin.ops", "admin.billing", "admin.programs", "admin.audit", "admin.settings"],
};
export function capsFor(role?: string | null): Set<Capability> {
  const caps = role && ROLE_CAPS[role] ? ROLE_CAPS[role] : ["member" as Capability];
  return new Set(caps);
}
export function hasCap(role: string | null | undefined, cap: Capability): boolean {
  return capsFor(role ?? null).has(cap);
}
const ROUTE_CAPS: [string, Capability][] = [
  ["/admin/providers", "admin.providers"], ["/admin/models", "admin.models"],
  ["/admin/keys", "admin.keys"], ["/admin/users", "admin.users"],
  ["/admin/requests", "admin.requests"], ["/admin/connections", "admin.ops"],
  ["/admin/billing", "admin.billing"], ["/admin/revenue", "admin.billing"],
  ["/admin/transactions", "admin.billing"], ["/admin/programs", "admin.programs"],
  ["/admin/audit", "admin.audit"], ["/admin/settings", "admin.settings"],
  ["/admin/security", "admin.audit"], ["/admin/incidents", "admin.ops"],
  ["/admin/system", "admin.ops"], ["/admin/traffic", "admin.ops"],
  ["/admin/routing", "admin.ops"], ["/admin/health", "admin.ops"],
  ["/admin/workspaces", "admin.users"], ["/admin/projects", "admin.users"],
  ["/admin/analytics", "admin.view"], ["/admin", "admin.view"],
  ["/dashboard", "member"], ["/invite", "member"],
];
function seg(p: string): string[] { return p.split("/").filter(Boolean); }
function entryMatches(entry: string[], path: string[]): boolean {
  for (let i = 0; i < entry.length; i++) {
    const e = entry[i];
    if (e.startsWith("[...") && e.endsWith("]")) return true;
    if (i >= path.length) return false;
    if (e.startsWith("[") && e.endsWith("]")) continue;
    if (e !== path[i]) return false;
  }
  return true;
}
export function requiredCap(pathname: string): Capability | null {
  const path = seg(pathname);
  let best: { entry: string[]; cap: Capability } | null = null;
  for (const [pattern, cap] of ROUTE_CAPS) {
    const entry = seg(pattern);
    if (!entryMatches(entry, path)) continue;
    if (!best || entry.length > best.entry.length) best = { entry, cap };
  }
  return best ? best.cap : null;
}
export function landingFor(role?: string | null): string {
  return hasCap(role, "admin.view") ? "/admin" : "/dashboard";
}
