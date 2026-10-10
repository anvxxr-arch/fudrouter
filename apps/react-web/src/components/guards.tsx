import { useEffect, useState, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { getSession } from "../lib/server";
import { hasCap, requiredCap, type Capability } from "../lib/caps";
export type SessionUser = { id: string; name: string; email: string; role?: string | null };
export function useSession() {
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    getSession().then((s) => { if (live) setUser(s.user); }).catch(() => { if (live) setUser(null); });
    return () => { live = false; };
  }, []);
  return user;
}
export function RequireAuth({ children }: { children: ReactNode }) {
  const user = useSession();
  const loc = useLocation();
  if (user === undefined) return <p className="muted" role="status" aria-live="polite">Loading…</p>;
  if (!user) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  return <>{children}</>;
}
export function RequireCap({ cap, children }: { cap: Capability; children: ReactNode }) {
  const user = useSession();
  const loc = useLocation();
  if (user === undefined) return <p className="muted" role="status" aria-live="polite">Loading…</p>;
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
