// Route gating for the SPA: which path needs which capability, and whether the
// signed-in user holds it.
//
// The role -> capability table is NOT here. It lives in @fudrouter/platform/rbac
// -- the same table the server enforces from -- and is re-exported below. This
// file used to hold its own copy, and a server-side test compared the two by
// parsing THIS file's source text; a UI that gates on a table the API does not
// enforce shows controls that 403, so there is one table now.
//
// What belongs here is what is genuinely the SPA's business: the route-prefix ->
// cap map, its longest-prefix match, and the compound check `hasCap` that a
// guard component calls with the session's role.
import { capsFor, ROLE_CAPS, type Capability } from "@fudrouter/platform/rbac";

export { capsFor, ROLE_CAPS };
export type { Capability };

export function hasCap(role: string | null | undefined, cap: Capability): boolean {
  return capsFor(role ?? null).has(cap);
}

export const ROUTE_CAPS: [string, Capability][] = [
  ["/admin/access", "admin.access"],
  ["/admin/providers", "admin.providers"], ["/admin/models", "admin.models"],
  ["/admin/keys", "admin.keys"], ["/admin/users", "admin.users"],
  ["/admin/requests", "admin.requests"], ["/admin/connections", "admin.ops"],
  ["/admin/billing", "admin.billing"], ["/admin/settings", "admin.settings"],
  ["/admin/security", "admin.audit"], ["/admin/incidents", "admin.ops"],
  ["/admin/system", "admin.ops"], ["/admin/traffic", "admin.ops"],
  ["/admin/routing", "admin.ops"], ["/admin/health", "admin.ops"],
  ["/admin/analytics", "admin.view"], ["/admin", "admin.view"],
  ["/dashboard", "member"],
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
