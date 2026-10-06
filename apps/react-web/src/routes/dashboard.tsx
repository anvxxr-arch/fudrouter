import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { apiGet, apiPost } from "../lib/server";
import { DashShell } from "../components/DashShell";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Table } from "../components/ui/table";

function Page({ title, lede, children }: { title: string; lede: string; children?: ReactNode }) {
  return (<div className="stack"><h1>{title}</h1><p className="lede muted">{lede}</p>{children}</div>);
}
function useLoad<T>(path: string, tick = 0): { data: T | null; error: string | null; loading: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    setLoading(true);
    apiGet<T>(path)
      .then((v) => { if (live) { setData(v); setError(v ? null : "Failed to load"); } })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : "Failed to load"); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [path, tick]);
  return { data, error, loading };
}
function LoadState({ loading, error }: { loading: boolean; error: string | null }) {
  if (loading) return <p className="muted">Loading…</p>;
  if (error) return <p className="error">{error}</p>;
  return null;
}
function fmtDate(v: string | null) {
  if (!v) return "—";
  try {
    return new Date(v).toLocaleString();
  } catch {
    return v;
  }
}
function fmtMicro(v: string | null | undefined) {
  if (v === null || v === undefined) return "—";
  try {
    const micro = BigInt(v);
    const sign = micro < 0n ? "-" : "";
    const abs = micro < 0n ? -micro : micro;
    return `${sign}$${(Number(abs) / 1_000_000).toFixed(2)}`;
  } catch {
    return String(v);
  }
}

export function DashboardHome() {
  const { data: d, error, loading } = useLoad<{ totals: { requests: number; tokensIn: number; tokensOut: number; cost: string }; activeKeys: number; recent: { id: string; createdAt: string; model_slug: string | null; tokens_in: number; tokens_out: number; cost: string; status: string }[]; series: { day: string; requests: number; tokens: number; cost: string }[] }>("/api/pages/dashboard");
  return (<DashShell><Page title="Dashboard" lede="Usage, keys, and spend at a glance.">
    <LoadState loading={loading} error={error} />
    {d ? (<>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <Card title="Requests" desc={String(d.totals.requests)} />
        <Card title="Tokens in" desc={String(d.totals.tokensIn)} />
        <Card title="Tokens out" desc={String(d.totals.tokensOut)} />
        <Card title="Active keys" desc={String(d.activeKeys)} />
      </div>
      <h2>Recent requests</h2>
      <Table head={["ID", "When", "Model", "Tokens", "Status"]} rows={d.recent.map((r) => [r.id.slice(0, 12) + "…", fmtDate(r.createdAt), r.model_slug ?? "—", String(Number(r.tokens_in) + Number(r.tokens_out)), r.status])} />
      <h2>Last 14 days</h2>
      <Table head={["Day", "Requests", "Tokens"]} rows={d.series.map((s) => [s.day, String(s.requests), String(s.tokens)])} />
    </>) : null}
    <div className="row"><Link to="/dashboard/projects/new"><Button>New project</Button></Link></div>
  </Page></DashShell>);
}

export function KeysPage() {
  const [tick, setTick] = useState(0);
  const [created, setCreated] = useState<{ key: string; name: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { data: d, error, loading } = useLoad<{ keys: { id: string; name: string; prefix: string; status: string; lastUsedAt: string | null; createdAt: string | null }[] }>("/api/pages/dashboard/keys", tick);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return (<DashShell><Page title="API keys" lede="Create and revoke keys.">
    <LoadState loading={loading} error={error} />
    <form onSubmit={(e) => {
      e.preventDefault(); setErr(null);
      const f = new FormData(e.currentTarget);
      apiPost<{ created: string; name: string }>("/api/pages/dashboard/keys/create", { name: String(f.get("name") ?? "") })
        .then((r) => { setCreated({ key: r.created, name: r.name }); (e.target as HTMLFormElement).reset(); refresh(); })
        .catch((ex) => setErr(ex instanceof Error ? ex.message : "Create failed"));
    }}>
      <div className="row"><Input name="name" placeholder="Key name" required /><Button type="submit">Create</Button></div>
    </form>
    {err ? <p className="error">{err}</p> : null}
    {created ? <Card title="New key — copy it now, it will never be shown again" desc={created.key} /> : null}
    <Table head={["Name", "Prefix", "Status", "Last used", "Created", ""]} rows={(d?.keys ?? []).map((k) => [k.name, k.prefix, k.status, fmtDate(k.lastUsedAt), fmtDate(k.createdAt), k.status === "revoked" ? "—" : <Button key={k.id} size="sm" variant="secondary" onClick={() => apiPost("/api/pages/dashboard/keys/revoke", { id: k.id }).then(refresh).catch((ex) => setErr(ex instanceof Error ? ex.message : "Revoke failed"))}>Revoke</Button>])} />
  </Page></DashShell>);
}

export function UsagePage() {
  const [days, setDays] = useState(30);
  const { data: d, error, loading } = useLoad<{ totals: { requests: number; tokensIn: number; tokensOut: number; costMicro: string }; breakdowns: { byDay: { day: string; requests: number; totalTokens: number; costMicro: string }[]; byProject: { key: string; label: string; requests: number; totalTokens: number; costMicro: string }[] } }>(`/api/pages/dashboard/usage?days=${days}`);
  return (<DashShell><Page title="Usage" lede="Metered calls.">
    <div className="row">
      {[1, 7, 30, 90].map((n) => (<Button key={n} size="sm" variant={days === n ? "primary" : "secondary"} onClick={() => setDays(n)}>{n}d</Button>))}
    </div>
    <LoadState loading={loading} error={error} />
    {d ? (<>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <Card title="Requests" desc={String(d.totals.requests)} />
        <Card title="Tokens in" desc={String(d.totals.tokensIn)} />
        <Card title="Tokens out" desc={String(d.totals.tokensOut)} />
        <Card title="Cost" desc={fmtMicro(d.totals.costMicro)} />
      </div>
      <h2>By day</h2>
      <Table head={["Day", "Requests", "Tokens", "Cost"]} rows={d.breakdowns.byDay.map((r) => [r.day, String(r.requests), String(r.totalTokens), fmtMicro(r.costMicro)])} />
      <h2>By project</h2>
      <Table head={["Project", "Requests", "Tokens", "Cost"]} rows={d.breakdowns.byProject.map((r) => [r.label, String(r.requests), String(r.totalTokens), fmtMicro(r.costMicro)])} />
    </>) : null}
  </Page></DashShell>);
}

export function BillingPage() {
  const [tick, setTick] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const { data: d, error, loading } = useLoad<{ currency: string; status: string; workspaceName: string; canWrite: boolean; balanceMicro: string; warningThresholdMicro: string; hardStopThresholdMicro: string; period: { start: string; end: string; spentMicro: string; requests: number } }>("/api/pages/dashboard/billing", tick);
  return (<DashShell><Page title="Billing" lede="Thresholds, credits, invoices, payment methods.">
    <div className="row" style={{ flexWrap: "wrap" }}>
      <Link to="/dashboard/billing/credits"><Button variant="secondary">Credits</Button></Link>
      <Link to="/dashboard/billing/invoices"><Button variant="secondary">Invoices</Button></Link>
      <Link to="/dashboard/billing/payment-methods"><Button variant="secondary">Payment methods</Button></Link>
    </div>
    <LoadState loading={loading} error={error} />
    {d ? (<>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <Card title="Balance" desc={fmtMicro(d.balanceMicro)} />
        <Card title="Status" desc={d.status} />
        <Card title="This month" desc={`${fmtMicro(d.period.spentMicro)} · ${d.period.requests} reqs`} />
      </div>
      {d.canWrite ? (
        <form onSubmit={(e) => {
          e.preventDefault(); setErr(null);
          const f = new FormData(e.currentTarget);
          apiPost("/api/pages/dashboard/billing/thresholds", { warn: String(f.get("warn") ?? ""), suspend: String(f.get("suspend") ?? "") })
            .then(() => setTick((t) => t + 1))
            .catch((ex) => setErr(ex instanceof Error ? ex.message : "Save failed"));
        }}>
          <div className="row"><Input name="warn" placeholder="Warn threshold" /><Input name="suspend" placeholder="Suspend threshold" /><Button type="submit">Save</Button></div>
        </form>
      ) : <p className="muted">Read-only: you need billing.write to change thresholds.</p>}
      {err ? <p className="error">{err}</p> : null}
    </>) : null}
  </Page></DashShell>);
}

export function CreditsPage() {
  const [tick, setTick] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const { data: d, error, loading } = useLoad<{ balanceMicro: string; rows: { id: string; type: string; amountMicro: string; currency: string; description: string | null; createdAt: string }[] }>("/api/pages/dashboard/billing/credits", tick);
  return (<DashShell><Page title="Credits" lede="Ledger and balance.">
    <LoadState loading={loading} error={error} />
    {d ? <Card title="Balance" desc={fmtMicro(d.balanceMicro)} /> : null}
    <form onSubmit={(e) => {
      e.preventDefault(); setErr(null);
      const f = new FormData(e.currentTarget);
      apiPost("/api/pages/dashboard/billing/credits/add", { amount: String(f.get("amount") ?? "") })
        .then(() => { (e.target as HTMLFormElement).reset(); setTick((t) => t + 1); })
        .catch((ex) => setErr(ex instanceof Error ? ex.message : "Add failed"));
    }}>
      <div className="row"><Input name="amount" placeholder="Amount" required /><Button type="submit">Add</Button></div>
    </form>
    {err ? <p className="error">{err}</p> : null}
    <Table head={["When", "Type", "Amount", "Description"]} rows={(d?.rows ?? []).map((r) => [fmtDate(r.createdAt), r.type, fmtMicro(r.amountMicro), r.description ?? "—"])} />
  </Page></DashShell>);
}

export function InvoicesPage() {
  const [tick, setTick] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const { data: d, error, loading } = useLoad<{ invoices: { id: string; number: string; status: string; amountMicro: string; periodStart: string; periodEnd: string }[] }>("/api/pages/dashboard/billing/invoices", tick);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return (<DashShell><Page title="Invoices" lede="Generate and settle.">
    <LoadState loading={loading} error={error} />
    <Button onClick={() => apiPost("/api/pages/dashboard/billing/invoices/generate", {}).then(refresh).catch((ex) => setErr(ex instanceof Error ? ex.message : "Generate failed"))}>Generate</Button>
    {err ? <p className="error">{err}</p> : null}
    <Table head={["Number", "Period", "Amount", "Status", ""]} rows={(d?.invoices ?? []).map((i) => [i.number, `${fmtDate(i.periodStart)} → ${fmtDate(i.periodEnd)}`, fmtMicro(i.amountMicro), i.status, <span key={i.id} className="row"><Button size="sm" variant="secondary" onClick={() => apiPost("/api/pages/dashboard/billing/invoices/markPaid", { id: i.id }).then(refresh)}>Paid</Button><Button size="sm" variant="ghost" onClick={() => apiPost("/api/pages/dashboard/billing/invoices/void", { id: i.id }).then(refresh)}>Void</Button></span>])} />
  </Page></DashShell>);
}

export function PayMethodsPage() {
  const [tick, setTick] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const { data: d, error, loading } = useLoad<{ intent: { method: string; contact: string; note: string; recordedAt: string } | null }>("/api/pages/dashboard/billing/payment-methods", tick);
  return (<DashShell><Page title="Payment methods" lede="Record how you intend to pay — an operator follows up offline.">
    <LoadState loading={loading} error={error} />
    {d?.intent ? <Card title={d.intent.method} desc={`${d.intent.contact} · ${d.intent.note}`} /> : <p className="muted">No billing intent recorded.</p>}
    <form onSubmit={(e) => {
      e.preventDefault(); setErr(null);
      const f = new FormData(e.currentTarget);
      apiPost("/api/pages/dashboard/billing/payment-methods/record", { method: String(f.get("method") ?? ""), contact: String(f.get("contact") ?? ""), note: String(f.get("note") ?? "") })
        .then(() => setTick((t) => t + 1))
        .catch((ex) => setErr(ex instanceof Error ? ex.message : "Record failed"));
    }}>
      <div className="row"><Input name="method" placeholder="Method" required /><Input name="contact" placeholder="Contact" required /><Input name="note" placeholder="Note" /><Button type="submit">Record</Button></div>
    </form>
    {err ? <p className="error">{err}</p> : null}
  </Page></DashShell>);
}

export function AccountPage() {
  const [tick, setTick] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const { data: d, error, loading } = useLoad<{ account: { id: string; name: string; email: string; role: string | null } | null; timezone: string }>("/api/pages/dashboard/account", tick);
  return (<DashShell><Page title="Account" lede="Profile.">
    <LoadState loading={loading} error={error} />
    {d?.account ? <Card title={d.account.email} desc={`Role: ${d.account.role ?? "—"}`} /> : null}
    <form onSubmit={(e) => {
      e.preventDefault(); setErr(null); setOk(false);
      const f = new FormData(e.currentTarget);
      apiPost("/api/pages/dashboard/account/save", { name: String(f.get("name") ?? ""), timezone: String(f.get("timezone") ?? "") })
        .then(() => { setOk(true); setTick((t) => t + 1); })
        .catch((ex) => setErr(ex instanceof Error ? ex.message : "Save failed"));
    }}>
      <div className="row"><Input name="name" placeholder="Name" defaultValue={d?.account?.name ?? ""} /><Input name="timezone" placeholder="Timezone" defaultValue={d?.timezone ?? ""} /><Button type="submit">Save</Button></div>
    </form>
    {err ? <p className="error">{err}</p> : null}
    {ok ? <p className="muted">Saved.</p> : null}
  </Page></DashShell>);
}

export function WorkspacePage() {
  const [tick, setTick] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const { data: d, error, loading } = useLoad<{ workspace: { id: string; name: string; slug: string; status: string }; owner: { name: string; email: string } | null; projectCount: number; memberCount: number }>("/api/pages/dashboard/workspace", tick);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return (<DashShell><Page title="Workspace" lede={d?.workspace?.name ?? "Workspace settings."}>
    <LoadState loading={loading} error={error} />
    {d ? <Card title={d.workspace.slug} desc={`${d.projectCount} projects · ${d.memberCount} members · owner ${d.owner?.email ?? "—"}`} /> : null}
    <form onSubmit={(e) => {
      e.preventDefault(); setErr(null);
      const f = new FormData(e.currentTarget);
      apiPost("/api/pages/dashboard/workspace/rename", { name: String(f.get("name") ?? "") }).then(refresh).catch((ex) => setErr(ex instanceof Error ? ex.message : "Rename failed"));
    }}>
      <div className="row"><Input name="name" placeholder="Workspace name" /><Button type="submit">Rename</Button></div>
    </form>
    <div className="row" style={{ flexWrap: "wrap" }}>
      <Button variant="secondary" onClick={() => apiPost("/api/pages/dashboard/workspace/archive", {}).then(refresh)}>Archive</Button>
      <Button variant="secondary" onClick={() => apiPost("/api/pages/dashboard/workspace/restore", {}).then(refresh)}>Restore</Button>
    </div>
    {err ? <p className="error">{err}</p> : null}
  </Page></DashShell>);
}

export function TeamMembersPage() {
  const [tick, setTick] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const { data: d, error, loading } = useLoad<{ members: { id: string; name: string; email: string; role: string; roleId: string; status: string }[]; roles: { id: string; name: string }[] }>("/api/pages/dashboard/team/members", tick);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return (<DashShell><Page title="Team members" lede="Invite and manage roles.">
    <LoadState loading={loading} error={error} />
    <form onSubmit={(e) => {
      e.preventDefault(); setErr(null); setInviteLink(null);
      const f = new FormData(e.currentTarget);
      apiPost<{ invited: string; invitedLink?: string }>("/api/pages/dashboard/team/members/invite", { email: String(f.get("email") ?? ""), roleId: String(f.get("roleId") ?? "") })
        .then((r) => { if (r.invitedLink) setInviteLink(r.invitedLink); (e.target as HTMLFormElement).reset(); refresh(); })
        .catch((ex) => setErr(ex instanceof Error ? ex.message : "Invite failed"));
    }}>
      <div className="row">
        <Input name="email" placeholder="Email" required />
        <select name="roleId">{(d?.roles ?? []).map((r) => (<option key={r.id} value={r.id}>{r.name}</option>))}</select>
        <Button type="submit">Invite</Button>
      </div>
    </form>
    {inviteLink ? <Card title="Invite link — copy it now" desc={inviteLink} /> : null}
    {err ? <p className="error">{err}</p> : null}
    <Table head={["Name", "Email", "Role", "Status", "Actions"]} rows={(d?.members ?? []).map((m) => [m.name, m.email, m.role, m.status, <span key={m.id} className="row">
      <select defaultValue={m.roleId} onChange={(e) => apiPost("/api/pages/dashboard/team/members/changeRole", { memberId: m.id, roleId: e.target.value }).then(refresh).catch((ex) => setErr(ex instanceof Error ? ex.message : "Role change failed"))}>
        {(d?.roles ?? []).map((r) => (<option key={r.id} value={r.id}>{r.name}</option>))}
      </select>
      <Button size="sm" variant="ghost" onClick={() => {
        const confirm = window.prompt(`Type the member's name "${m.name}" exactly to confirm removal`);
        if (confirm === null) return;
        apiPost("/api/pages/dashboard/team/members/remove", { memberId: m.id, confirm }).then(refresh).catch((ex) => setErr(ex instanceof Error ? ex.message : "Remove failed"));
      }}>Remove</Button>
    </span>])} />
  </Page></DashShell>);
}

export function TeamInvitesPage() {
  const [tick, setTick] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const { data: d, error, loading } = useLoad<{ invitations: { id: string; identifier: string; email: string; name: string; expiresAt: string }[] }>("/api/pages/dashboard/team/invitations", tick);
  return (<DashShell><Page title="Invitations" lede="Pending invites.">
    <LoadState loading={loading} error={error} />
    {err ? <p className="error">{err}</p> : null}
    <Table head={["Email", "Name", "Expires", ""]} rows={(d?.invitations ?? []).map((i) => [i.email, i.name, fmtDate(i.expiresAt), <Button key={i.id} size="sm" variant="ghost" onClick={() => apiPost("/api/pages/dashboard/team/invitations/revoke", { identifier: i.identifier }).then(() => setTick((t) => t + 1)).catch((ex) => setErr(ex instanceof Error ? ex.message : "Revoke failed"))}>Revoke</Button>])} />
  </Page></DashShell>);
}

export function TeamRolesPage() {
  const [tick, setTick] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const { data: d, error, loading } = useLoad<{ roles: { id: string; name: string; custom: boolean; permissions: string[]; memberCount: number }[] }>("/api/pages/dashboard/team/roles", tick);
  return (<DashShell><Page title="Roles" lede="Builtin and custom roles.">
    <LoadState loading={loading} error={error} />
    <form onSubmit={(e) => {
      e.preventDefault(); setErr(null);
      const f = new FormData(e.currentTarget);
      apiPost("/api/pages/dashboard/team/roles/create", { name: String(f.get("name") ?? "") })
        .then(() => { (e.target as HTMLFormElement).reset(); setTick((t) => t + 1); })
        .catch((ex) => setErr(ex instanceof Error ? ex.message : "Create failed"));
    }}>
      <div className="row"><Input name="name" placeholder="Role name" required /><Button type="submit">Create</Button></div>
    </form>
    {err ? <p className="error">{err}</p> : null}
    <Table head={["Name", "Custom", "Permissions", "Members"]} rows={(d?.roles ?? []).map((r) => [r.name, r.custom ? "yes" : "builtin", String(r.permissions.length), String(r.memberCount)])} />
  </Page></DashShell>);
}

export function ProjectNewPage() {
  const [err, setErr] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);
  return (<DashShell><Page title="New project" lede="Create a project.">
    <form onSubmit={(e) => {
      e.preventDefault(); setErr(null);
      const f = new FormData(e.currentTarget);
      apiPost<{ id: string }>("/api/pages/dashboard/projects/create", { name: String(f.get("name") ?? ""), description: String(f.get("description") ?? "") })
        .then((r) => setCreatedId(r.id))
        .catch((ex) => setErr(ex instanceof Error ? ex.message : "Create failed"));
    }}>
      <div className="row"><Input name="name" placeholder="Project name" required /><Input name="description" placeholder="Description" /><Button type="submit">Create</Button></div>
    </form>
    {err ? <p className="error">{err}</p> : null}
    {createdId ? <p><Link to={"/dashboard/projects/" + createdId}>Open project</Link></p> : null}
  </Page></DashShell>);
}

function Proj({ children }: { children: ReactNode }) {
  const { projectId } = useParams();
  return (<DashShell>
    <nav className="row" style={{ flexWrap: "wrap" }}>
      <Link to={"/dashboard/projects/" + projectId}><Button variant="ghost" size="sm">Overview</Button></Link>
      <Link to={"/dashboard/projects/" + projectId + "/keys"}><Button variant="ghost" size="sm">Keys</Button></Link>
      <Link to={"/dashboard/projects/" + projectId + "/limits"}><Button variant="ghost" size="sm">Limits</Button></Link>
      <Link to={"/dashboard/projects/" + projectId + "/routing"}><Button variant="ghost" size="sm">Routing</Button></Link>
      <Link to={"/dashboard/projects/" + projectId + "/requests"}><Button variant="ghost" size="sm">Requests</Button></Link>
      <Link to={"/dashboard/projects/" + projectId + "/playground"}><Button variant="ghost" size="sm">Playground</Button></Link>
      <Link to={"/dashboard/projects/" + projectId + "/settings"}><Button variant="ghost" size="sm">Settings</Button></Link>
    </nav>
    {children}
  </DashShell>);
}

export function ProjectPage() {
  const { projectId } = useParams();
  const [tick, setTick] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const { data: d, error, loading } = useLoad<{ project: { id: string; name: string; slug: string; description: string | null; status: string } }>("/api/pages/projects/" + projectId, tick);
  return (<Proj><Page title={d?.project?.name ?? "Project"} lede={projectId ?? ""}>
    <LoadState loading={loading} error={error} />
    {d?.project ? <Card title={d.project.slug} desc={`${d.project.status} · ${d.project.description ?? "—"}`} /> : null}
    <form onSubmit={(e) => {
      e.preventDefault(); setErr(null);
      const f = new FormData(e.currentTarget);
      apiPost("/api/pages/projects/" + projectId + "/update", { name: String(f.get("name") ?? ""), slug: String(f.get("slug") ?? ""), description: String(f.get("description") ?? ""), status: String(f.get("status") ?? "active") })
        .then(() => setTick((t) => t + 1))
        .catch((ex) => setErr(ex instanceof Error ? ex.message : "Update failed"));
    }}>
      <div className="row"><Input name="name" placeholder="New name" /><Input name="slug" placeholder="Slug" /><Input name="description" placeholder="Description" /><Input name="status" placeholder="Status" /><Button type="submit">Save</Button></div>
    </form>
    <Button variant="secondary" onClick={() => apiPost("/api/pages/projects/" + projectId + "/archive", {}).then(() => setTick((t) => t + 1)).catch((ex) => setErr(ex instanceof Error ? ex.message : "Archive failed"))}>Archive</Button>
    {err ? <p className="error">{err}</p> : null}
  </Page></Proj>);
}

function ProjectKeys({ projectId }: { projectId: string }) {
  const [tick, setTick] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const { data: d, error, loading } = useLoad<{ environments: { id: string; name: string }[]; keys: { id: string; name: string; prefix: string; status: string; environmentName: string | null; createdAt: string }[] }>(`/api/pages/projects/${projectId}/keys`, tick);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return (<>
    <LoadState loading={loading} error={error} />
    <form onSubmit={(e) => {
      e.preventDefault(); setErr(null); setCreated(null);
      const f = new FormData(e.currentTarget);
      apiPost<{ created: string }>(`/api/pages/projects/${projectId}/keys/create`, { name: String(f.get("name") ?? ""), environmentId: String(f.get("environmentId") ?? "") })
        .then((r) => { setCreated(r.created); refresh(); })
        .catch((ex) => setErr(ex instanceof Error ? ex.message : "Create failed"));
    }}>
      <div className="row">
        <Input name="name" placeholder="Key name" required />
        <select name="environmentId">{(d?.environments ?? []).map((env) => (<option key={env.id} value={env.id}>{env.name}</option>))}</select>
        <Button type="submit">Create</Button>
      </div>
    </form>
    {created ? <Card title="New key — copy it now" desc={created} /> : null}
    {err ? <p className="error">{err}</p> : null}
    <Table head={["Name", "Prefix", "Status", "Env", "Created", ""]} rows={(d?.keys ?? []).map((k) => [k.name, k.prefix, k.status, k.environmentName ?? "—", fmtDate(k.createdAt), <span key={k.id} className="row">
      <Button size="sm" variant="secondary" onClick={() => apiPost(`/api/pages/projects/${projectId}/keys/enable`, { id: k.id }).then(refresh)}>Enable</Button>
      <Button size="sm" variant="ghost" onClick={() => apiPost(`/api/pages/projects/${projectId}/keys/disable`, { id: k.id }).then(refresh)}>Disable</Button>
    </span>])} />
  </>);
}

function ProjectLimits({ projectId }: { projectId: string }) {
  const [tick, setTick] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const { data: d, error, loading } = useLoad<{ editors: { scope: string; scopeId: string; label: string; row: { id: string; values: Record<string, string> } | null }[] }>(`/api/pages/projects/${projectId}/limits`, tick);
  return (<>
    <LoadState loading={loading} error={error} />
    {err ? <p className="error">{err}</p> : null}
    {(d?.editors ?? []).map((ed) => (
      <form key={ed.scope + ed.scopeId} onSubmit={(e) => {
        e.preventDefault(); setErr(null);
        const f = new FormData(e.currentTarget);
        const body: Record<string, string> = { scope: ed.scope, scopeId: ed.scopeId };
        for (const k of ["rpm", "tpm", "rpd", "tpd", "concurrency", "dailySpendMicro", "monthlySpendMicro"]) body[k] = String(f.get(k) ?? "");
        apiPost(`/api/pages/projects/${projectId}/limits/save`, body).then(() => setTick((t) => t + 1)).catch((ex) => setErr(ex instanceof Error ? ex.message : "Save failed"));
      }}>
        <h3>{ed.label}</h3>
        <div className="row" style={{ flexWrap: "wrap" }}>
          {(["rpm", "tpm", "rpd", "tpd", "concurrency", "dailySpendMicro", "monthlySpendMicro"] as const).map((k) => (
            <Input key={k} name={k} placeholder={k} defaultValue={ed.row?.values[k] ?? ""} />
          ))}
          <Button type="submit">Save</Button>
        </div>
      </form>
    ))}
  </>);
}

function ProjectRouting({ projectId }: { projectId: string }) {
  const [tick, setTick] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const { data: d, error, loading } = useLoad<{ policies: { id: string; name: string; strategy: string; enabled: boolean; scope: string; boundEnvironments: string[] }[]; bindings: { environmentId: string; environmentName: string; policyName: string | null }[] }>(`/api/pages/projects/${projectId}/routing`, tick);
  return (<>
    <LoadState loading={loading} error={error} />
    <form onSubmit={(e) => {
      e.preventDefault(); setErr(null);
      const f = new FormData(e.currentTarget);
      apiPost(`/api/pages/projects/${projectId}/routing/create`, { name: String(f.get("name") ?? ""), strategy: String(f.get("strategy") ?? "balanced"), scope: String(f.get("scope") ?? "project") })
        .then(() => { (e.target as HTMLFormElement).reset(); setTick((t) => t + 1); })
        .catch((ex) => setErr(ex instanceof Error ? ex.message : "Create failed"));
    }}>
      <div className="row"><Input name="name" placeholder="Policy name" required /><Input name="strategy" placeholder="Strategy" /><Input name="scope" placeholder="project|workspace" /><Button type="submit">Create</Button></div>
    </form>
    {err ? <p className="error">{err}</p> : null}
    <Table head={["Name", "Strategy", "Enabled", "Scope", "Bound envs", ""]} rows={(d?.policies ?? []).map((p) => [p.name, p.strategy, p.enabled ? "yes" : "no", p.scope, p.boundEnvironments.join(", ") || "—", <Button key={p.id} size="sm" variant="ghost" onClick={() => apiPost(`/api/pages/projects/${projectId}/routing/delete`, { id: p.id }).then(() => setTick((t) => t + 1))}>Delete</Button>])} />
    <h3>Environment bindings</h3>
    <Table head={["Environment", "Policy"]} rows={(d?.bindings ?? []).map((b) => [b.environmentName, b.policyName ?? "—"])} />
  </>);
}

function ProjectRequests({ projectId }: { projectId: string }) {
  const { data: d, error, loading } = useLoad<{ rows: { id: string; createdAt: string; status: string; requestedModel: string | null; modelSlug: string | null; latencyMs: number; tokensIn: number; tokensOut: number; costMicro: string }[] }>(`/api/pages/projects/${projectId}/requests`);
  return (<>
    <LoadState loading={loading} error={error} />
    <Table head={["ID", "When", "Status", "Model", "Latency", "Tokens", "Cost"]} rows={(d?.rows ?? []).map((r) => [r.id.slice(0, 12) + "…", fmtDate(r.createdAt), r.status, r.modelSlug ?? r.requestedModel ?? "—", String(r.latencyMs), String(r.tokensIn + r.tokensOut), fmtMicro(r.costMicro)])} />
  </>);
}

function ProjectSettings({ projectId }: { projectId: string }) {
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const { data: d, error, loading } = useLoad<{ project: { name: string; slug: string; description: string | null; status: string } }>(`/api/pages/projects/${projectId}/settings`);
  return (<>
    <LoadState loading={loading} error={error} />
    <form onSubmit={(e) => {
      e.preventDefault(); setErr(null); setOk(false);
      const f = new FormData(e.currentTarget);
      apiPost(`/api/pages/projects/${projectId}/update`, { name: String(f.get("name") ?? ""), slug: String(f.get("slug") ?? ""), description: String(f.get("description") ?? ""), status: String(f.get("status") ?? "active") })
        .then(() => setOk(true))
        .catch((ex) => setErr(ex instanceof Error ? ex.message : "Update failed"));
    }}>
      <div className="row"><Input name="name" placeholder="Name" defaultValue={d?.project?.name ?? ""} /><Input name="slug" placeholder="Slug" defaultValue={d?.project?.slug ?? ""} /><Input name="description" placeholder="Description" defaultValue={d?.project?.description ?? ""} /><Input name="status" placeholder="Status" defaultValue={d?.project?.status ?? ""} /><Button type="submit">Save</Button></div>
    </form>
    {err ? <p className="error">{err}</p> : null}
    {ok ? <p className="muted">Saved.</p> : null}
  </>);
}

export function ProjectSubPage({ name }: { name: string }) {
  const { projectId } = useParams();
  const pid = projectId ?? "";
  return (<Proj><Page title={name} lede={"Project " + pid + " / " + name}>
    {name === "keys" ? <ProjectKeys projectId={pid} />
      : name === "limits" ? <ProjectLimits projectId={pid} />
      : name === "routing" ? <ProjectRouting projectId={pid} />
      : name === "requests" ? <ProjectRequests projectId={pid} />
      : name === "settings" ? <ProjectSettings projectId={pid} />
      : <p className="muted">Unknown section.</p>}
  </Page></Proj>);
}
export function PlaygroundPage2() {
  const { projectId } = useParams();
  const [out, setOut] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(model: string, prompt: string) {
    setBusy(true);
    setError(null);
    setOut("");
    try {
      const res = await fetch("/api/playground/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, model, messages: [{ role: "user", content: prompt }] }),
      });
      if (!res.ok || !res.body) {
        const failed = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(failed?.error?.message ?? "The run failed to start.");
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let raw = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        raw += decoder.decode(value, { stream: true });
        let text = "";
        for (const line of raw.split("\n")) {
          if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
          try {
            const chunk = JSON.parse(line.slice(6)) as { choices?: { delta?: { content?: unknown } }[] };
            const delta = chunk.choices?.[0]?.delta?.content;
            if (typeof delta === "string") text += delta;
          } catch { /* partial frame */ }
        }
        setOut(text || raw);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message.slice(0, 500) : "The stream failed.");
    } finally {
      setBusy(false);
    }
  }
  return (<Proj><Page title="Playground" lede="Run a streamed completion.">
    <form onSubmit={(e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      void run(String(f.get("model") ?? "").trim(), String(f.get("prompt") ?? ""));
    }}>
      <div className="row"><Input name="model" placeholder="Model slug" required /><Input name="prompt" placeholder="Prompt" required /><Button type="submit" disabled={busy}>{busy ? "Running…" : "Run"}</Button></div>
    </form>
    {error ? <p className="error">{error}</p> : null}
    {out ? <Card desc={out.slice(0, 4000)} /> : null}
  </Page></Proj>);
}
export function InvitePage() {
  const { token } = useParams();
  return (<Page title="Invitation" lede="Accept or decline.">
    <div className="row">
      <Button onClick={() => apiPost("/api/invite/" + token + "/accept", {}).then(() => (location.href = "/dashboard"))}>Accept</Button>
      <Button variant="secondary" onClick={() => apiPost("/api/invite/" + token + "/decline", {}).then(() => (location.href = "/"))}>Decline</Button>
    </div>
  </Page>);
}
