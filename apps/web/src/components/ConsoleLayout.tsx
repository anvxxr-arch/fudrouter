import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, useParams } from "react-router-dom";
import { apiGet, apiPost, type ShellData } from "../lib/server";
import { CONSOLE_NAV, filterNav } from "../lib/navigation";
import { useSession } from "./guards";
import { Button } from "./ui/button";
export function useShell() {
  const [shell, setShell] = useState<ShellData | null>(null);
  useEffect(() => {
    apiGet<{ shell: ShellData }>("/api/pages/shell")
      .then((d) => setShell(d.shell))
      .catch(() => setShell({ workspaces: [], workspaceId: null, projects: [], projectId: null, environments: [], environmentId: null }));
  }, []);
  return shell;
}
function Switcher({ label, items, active, onPick }: { label: string; items: { id: string; name: string }[]; active: string | null; onPick: (id: string) => void }) {
  return (
    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
      <span className="muted">{label}</span>
      <select value={active ?? ""} onChange={(e) => onPick(e.target.value)}>
        <option value="">—</option>
        {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
      </select>
    </label>
  );
}
// The console bar is the registry's "console" scope filtered by the session's
// role -- the same caps the server enforces (requireCap/section caps). A nav
// item the guard would refuse is not rendered; a route with no entry is
// registry-only. The URL param items (project pages) are not nav items.
export function ConsoleLayout({ children }: { children: ReactNode }) {
  const shell = useShell();
  const user = useSession();
  const params = useParams();
  const pid = params.projectId ?? shell?.projectId ?? null;
  const items = filterNav(CONSOLE_NAV, user?.role ?? null);
  const [collapsed, setCollapsed] = useState(false);
  const switchWs = (id: string) => apiPost("/api/pages/workspace/switch", { workspaceId: id }).then(() => location.reload());
  const switchProj = (id: string) => apiPost(`/api/pages/projects/${id}/switch`, {}).then(() => location.reload());
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
        {!collapsed && (<>
          <div className="stack" style={{ gap: "var(--space-sm)" }}>
            {shell ? (<>
              <Switcher label="Workspace" items={shell.workspaces} active={shell.workspaceId} onPick={switchWs} />
              <Switcher label="Project" items={shell.projects} active={pid} onPick={switchProj} />
            </>) : <span className="muted">Loading shell…</span>}
          </div>
          <nav className="console-side-nav" aria-label="Dashboard">
            {items.map((i) => (
              <NavLink key={i.to} to={i.to} end={i.to === "/dashboard"} className={({ isActive }) => (isActive ? "current" : undefined)}>
                {i.label}
              </NavLink>
            ))}
            {pid ? <Link to={"/dashboard/projects/" + pid + "/playground"}>Playground</Link> : null}
          </nav>
        </>)}
      </aside>
      <div className="console-main">{children}</div>
    </div>
  );
}
