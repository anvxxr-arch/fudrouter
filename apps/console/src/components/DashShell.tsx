import { useEffect, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { apiGet, apiPost, type ShellData } from "../lib/server";
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
export function DashShell({ children }: { children: ReactNode }) {
  const shell = useShell();
  const params = useParams();
  const pid = params.projectId ?? shell?.projectId ?? null;
  const switchWs = (id: string) => apiPost("/api/pages/workspace/switch", { workspaceId: id }).then(() => location.reload());
  const switchProj = (id: string) => apiPost(`/api/pages/projects/${id}/switch`, {}).then(() => location.reload());
  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: "wrap" }}>
        {shell ? (<>
          <Switcher label="Workspace" items={shell.workspaces} active={shell.workspaceId} onPick={switchWs} />
          <Switcher label="Project" items={shell.projects} active={pid} onPick={switchProj} />
        </>) : <span className="muted">Loading shell…</span>}
      </div>
      <nav className="row" aria-label="Dashboard" style={{ flexWrap: "wrap" }}>
        <Link to="/dashboard"><Button variant="ghost" size="sm">Overview</Button></Link>
        <Link to="/dashboard/keys"><Button variant="ghost" size="sm">Keys</Button></Link>
        <Link to="/dashboard/usage"><Button variant="ghost" size="sm">Usage</Button></Link>
        <Link to="/dashboard/billing"><Button variant="ghost" size="sm">Billing</Button></Link>
        <Link to="/dashboard/team/members"><Button variant="ghost" size="sm">Team</Button></Link>
        <Link to="/dashboard/workspace"><Button variant="ghost" size="sm">Workspace</Button></Link>
        {pid ? <Link to={"/dashboard/projects/" + pid + "/playground"}><Button variant="ghost" size="sm">Playground</Button></Link> : null}
      </nav>
      {children}
    </div>
  );
}
