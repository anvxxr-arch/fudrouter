import { useEffect, useState, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { getSession } from "../lib/server";
import { hasCap, requiredCap, type Capability } from "../lib/caps";
import { Skeleton } from "./ui/skeleton";
export type SessionUser = { id: string; name: string; email: string; role?: string | null };

// One session for the whole SPA. Every caller (RequireAuth, RequireCap,
// ConsoleLayout, AdminNav) used to own a private `useState` and fire its own
// /api/auth/get-session; worse, their *loading* states were independent. The
// admin bar reads `filterNav(ADMIN_NAV, role)` and `capsFor(null)` grants no
// `admin.*` cap, so AdminNav rendered an EMPTY bar for one round-trip on every
// admin page before filling in -- a visible flash, and a fresh request per nav
// component. A module-level cache makes it one request and one value, so a bar
// that mounts after its gate has resolved (RequireCap blocks until the session
// is known) initialises from the resolved role and never renders empty.
//
// Safe to cache because a role only changes across a full document load:
// Auth.tsx authenticates with `window.location.href = ...`, so module state is
// discarded on the navigation that could change it.
let sessionCache: SessionUser | null | undefined;
let sessionPending: Promise<void> | null = null;

function LoadingGate() {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="loading-gate">
      <span className="sr-only">Loading…</span>
      <Skeleton lines={3} />
    </div>
  );
}

export function useSession() {
  const [user, setUser] = useState<SessionUser | null | undefined>(sessionCache);
  useEffect(() => {
    if (sessionCache !== undefined) {
      setUser(sessionCache);
      return;
    }
    let live = true;
    sessionPending ??= getSession()
      .then((s) => { sessionCache = s.user; })
      .catch(() => { sessionCache = null; });
    sessionPending.then(() => { if (live) setUser(sessionCache ?? null); });
    return () => { live = false; };
  }, []);
  return user;
}
export function RequireAuth({ children }: { children: ReactNode }) {
  const user = useSession();
  const loc = useLocation();
  if (user === undefined) return <LoadingGate />;
  if (!user) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  return <>{children}</>;
}
export function RequireCap({ cap, children }: { cap: Capability; children: ReactNode }) {
  const user = useSession();
  const loc = useLocation();
  if (user === undefined) return <LoadingGate />;
  if (!user) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  if (!hasCap(user.role ?? null, cap)) return <Navigate to="/" replace />;
  return <>{children}</>;
}
export function RequireRouteCap({ children }: { children: ReactNode }) {
  const loc = useLocation();
  const cap = requiredCap(loc.pathname);
  if (!cap) return <>{children}</>;
  return <RequireCap cap={cap}>{children}</RequireCap>;
}
