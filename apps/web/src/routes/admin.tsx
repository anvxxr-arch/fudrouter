import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useParams } from "react-router-dom";
import { apiGet } from "../lib/server";
import { ADMIN_NAV, filterNav } from "../lib/navigation";
import { useSession } from "../components/guards";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Table } from "../components/ui/table";

// The admin bar is the registry's "admin" scope filtered by the session's role,
// exactly as ConsoleLayout does for "console". It used to render a local
// SECTIONS array with no cap check at all, so every admin-role user saw links to
// all 17 sections and the ones their role lacked bounced to "/" via
// RequireRouteCap -- a button that 403s, on every admin page (Page wraps this).
// ADMIN_NAV carries the same labels and the caps, so filtering here renders the
// same bar for `admin` and hides what the guard would refuse.
export function AdminNav() {
  const user = useSession();
  const items = filterNav(ADMIN_NAV, user?.role ?? null);
  return (<nav className="row" aria-label="Admin" style={{ flexWrap: "wrap" }}>
    {items.map((i) => (
      <NavLink key={i.to} to={i.to} end={i.to === "/admin"}>
        <Button variant="ghost" size="sm">{i.label}</Button>
      </NavLink>
    ))}
  </nav>);
}

function Page({ title, lede, children }: { title: string; lede: string; children?: ReactNode }) {
  return (<div className="stack"><AdminNav /><h1>{title}</h1><p className="lede muted">{lede}</p>{children}</div>);
}

function useLoad<T>(path: string): { d: T | null; err: string | null } {
  const [d, setD] = useState<T | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setD(null); setErr(null);
    apiGet<T>(path).then((v) => { if (live) setD(v); }).catch((e: Error) => { if (live) setErr(/403/.test(e.message) ? "Forbidden — your role lacks the capability for this section." : "Load failed (" + e.message + ")."); });
    return () => { live = false; };
  }, [path]);
  return { d, err };
}

function State({ err, d, children }: { err: string | null; d: unknown; children: (v: never) => ReactNode }) {
  if (err) return (<Card title="Unavailable" desc={err} />);
  if (!d) return (<Card desc="Loading…" />);
  return (<>{children(d as never)}</>);
}

const fmtDate = (v: unknown) => { try { return v ? new Date(String(v)).toLocaleString() : "—"; } catch { return String(v ?? "—"); } };
const fmtUsd = (micro: unknown) => { try { const m = BigInt(String(micro ?? "0")); const neg = m < 0n; const a = neg ? -m : m; return (neg ? "-" : "") + "$" + (a / 1000000n).toString() + "." + (a % 1000000n).toString().padStart(6, "0").slice(0, 2); } catch { return String(micro ?? "—"); } };

type Overview = { counts: Record<string, number | string>; topConsumers: { keyId: string | null; keyName: string; email: string; requests: number; costMicro: string }[]; recent: { id: string; createdAt: string; requestedModel: string | null; latencyMs: number; status: string }[] };
export function AdminHome() {
  const { d, err } = useLoad<Overview>("/api/admin/overview");
  return (<Page title="Admin" lede="Platform overview.">
    <State err={err} d={d}>{(v: Overview) => (<>
      <div className="row" style={{ flexWrap: "wrap" }}>
        {Object.entries(v.counts).map(([k, n]) => <Card key={k} title={k} desc={String(n)} />)}
      </div>
      <h2>Top consumers</h2>
      <Table head={["Key", "Owner", "Requests", "Cost"]} rows={v.topConsumers.map((t) => [t.keyName, t.email, String(t.requests), fmtUsd(t.costMicro)])} />
      <h2>Recent requests</h2>
      <Table head={["ID", "Model", "Latency ms", "Status", "At"]} rows={v.recent.map((r) => [r.id, r.requestedModel ?? "—", String(r.latencyMs), r.status, fmtDate(r.createdAt)])} />
    </>)}</State>
  </Page>);
}

type Analytics = { from: string; to: string; usingRollups: boolean; byModel: { id: string; name: string; requests: number; successes: number; tokensIn: number; tokensOut: number; costMicro: string; p50: number; p95: number; p99: number }[]; byProvider: { id: string; name: string; requests: number; successes: number; costMicro: string; p50: number; p95: number; p99: number }[] };
function AnalyticsView() {
  const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const qs = [from ? "from=" + from : "", to ? "to=" + to : ""].filter(Boolean).join("&");
  const { d, err } = useLoad<Analytics>("/api/admin/analytics" + (qs ? "?" + qs : ""));
  return (<>
    <form className="row" onSubmit={(e) => e.preventDefault()}>
      <Input aria-label="from YYYY-MM-DD" placeholder="from YYYY-MM-DD" value={from} onChange={(e) => setFrom(e.currentTarget.value)} />
      <Input aria-label="to YYYY-MM-DD" placeholder="to YYYY-MM-DD" value={to} onChange={(e) => setTo(e.currentTarget.value)} />
    </form>
    <State err={err} d={d}>{(v: Analytics) => (<>
      <Card desc={"Window " + v.from + " → " + v.to + " · source: " + (v.usingRollups ? "usage_daily rollups" : "request_log fallback")} />
      <h2>By model</h2>
      <Table head={["Model", "Req", "OK", "Tok in", "Tok out", "Cost", "p50", "p95", "p99"]} rows={v.byModel.map((r) => [r.name, String(r.requests), String(r.successes), String(r.tokensIn), String(r.tokensOut), fmtUsd(r.costMicro), String(r.p50), String(r.p95), String(r.p99)])} />
      <h2>By provider</h2>
      <Table head={["Provider", "Req", "OK", "Cost", "p50", "p95", "p99"]} rows={v.byProvider.map((r) => [r.name, String(r.requests), String(r.successes), fmtUsd(r.costMicro), String(r.p50), String(r.p95), String(r.p99)])} />
    </>)}</State>
  </>);
}

type Billing = { accounts: { id: string; workspaceName: string; currency: string; status: string; warningThresholdMicro: string; hardStopThresholdMicro: string; balanceMicro: string; ledgerSumMicro: string }[]; totals: { type: string; totalMicro: string }[]; recent: { id: string; workspaceName: string; type: string; amountMicro: string; currency: string; requestId: string | null; description: string | null; createdBy: string | null; createdAt: string }[]; invoices: { id: string; workspaceName: string; number: string; periodStart: string; periodEnd: string; amountMicro: string; currency: string; status: string; issuedAt: string | null; paidAt: string | null }[] };
function BillingView() {
  const { d, err } = useLoad<Billing>("/api/admin/billing");
  return (<State err={err} d={d}>{(v: Billing) => (<>
    <h2>Accounts (balance is a cache — ledger sum is truth)</h2>
    <Table head={["Workspace", "Status", "Balance", "Ledger sum", "Drift", "Warn", "Hard stop"]} rows={v.accounts.map((a) => [a.workspaceName, a.status, fmtUsd(a.balanceMicro), fmtUsd(a.ledgerSumMicro), a.balanceMicro === a.ledgerSumMicro ? "—" : fmtUsd(String(BigInt(a.balanceMicro) - BigInt(a.ledgerSumMicro))), fmtUsd(a.warningThresholdMicro), fmtUsd(a.hardStopThresholdMicro)])} />
    <h2>Ledger totals by type</h2>
    <Table head={["Type", "Total"]} rows={v.totals.map((t) => [t.type, fmtUsd(t.totalMicro)])} />
    <h2>Recent ledger entries</h2>
    <Table head={["Workspace", "Type", "Amount", "Request", "Description", "At"]} rows={v.recent.map((r) => [r.workspaceName, r.type, fmtUsd(r.amountMicro), r.requestId ?? "—", (r.description ?? "—").slice(0, 80), fmtDate(r.createdAt)])} />
    <h2>Invoices</h2>
    <Table head={["Number", "Workspace", "Amount", "Status", "Period", "Paid"]} rows={v.invoices.map((i) => [i.number, i.workspaceName, fmtUsd(i.amountMicro), i.status, fmtDate(i.periodStart).slice(0, 10) + " → " + fmtDate(i.periodEnd).slice(0, 10), i.paidAt ? fmtDate(i.paidAt) : "—"])} />
  </>)}</State>);
}

type Connections = { connections: { id: string; name: string; baseUrl: string; region: string | null; authType: string; priority: number; enabled: boolean; healthStatus: string; providerName: string; credentialTotal: number; credentialHealthy: number }[] };
function ConnectionsView() {
  const { d, err } = useLoad<Connections>("/api/admin/connections");
  return (<State err={err} d={d}>{(v: Connections) => (
    <Table head={["Provider", "Connection", "Base URL", "Region", "Prio", "Enabled", "Health", "Creds ok/total"]} rows={v.connections.map((c) => [c.providerName, c.name, c.baseUrl, c.region ?? "—", String(c.priority), String(c.enabled), c.healthStatus, c.credentialHealthy + "/" + c.credentialTotal])} />
  )}</State>);
}

type Health = { providers: { id: string; name: string; status: string; requests: number; successes: number; p95: number; errorMix: { code: string; n: number }[] }[]; connections: { id: string; name: string; region: string | null; enabled: boolean; healthStatus: string; requests: number; successes: number; p95: number; errorMix: { code: string; n: number }[]; credentialsTotal: number; credentialsHealthy: number }[] };
function HealthView() {
  const { d, err } = useLoad<Health>("/api/admin/health");
  return (<State err={err} d={d}>{(v: Health) => (<>
    <Card titleAs="h2" title="Observed outcomes" desc="Last 24h from the request log — not synthetic probes." />
    <h2>Providers</h2>
    <Table head={["Provider", "Status", "Req/OK", "p95 ms", "Error mix"]} rows={v.providers.map((p) => [p.name, p.status, p.requests + "/" + p.successes, String(p.p95), p.errorMix.map((e) => e.code + "×" + e.n).join(", ") || "—"])} />
    <h2>Connections</h2>
    <Table head={["Connection", "Health", "Req/OK", "p95 ms", "Creds", "Errors"]} rows={v.connections.map((c) => [c.name, c.healthStatus, c.requests + "/" + c.successes, String(c.p95), c.credentialsHealthy + "/" + c.credentialsTotal, c.errorMix.map((e) => e.code + "×" + e.n).join(", ") || "—"])} />
  </>)}</State>);
}

type Incidents = { incidents: { id: string; title: string; component: string; severity: string; status: string; startedAt: string; resolvedAt: string | null; updates: { id: string; status: string; message: string; createdAt: string }[] }[] };
function IncidentsView() {
  const { d, err } = useLoad<Incidents>("/api/admin/incidents");
  return (<State err={err} d={d}>{(v: Incidents) => (<>
    {v.incidents.map((i) => (<Card key={i.id} title={i.title + " · " + i.severity + " · " + i.status} desc={i.component + " · started " + fmtDate(i.startedAt) + (i.resolvedAt ? " · resolved " + fmtDate(i.resolvedAt) : "")}>
      <Table head={["At", "Status", "Message"]} rows={i.updates.map((u) => [fmtDate(u.createdAt), u.status, u.message])} />
    </Card>))}
    {v.incidents.length === 0 ? <Card desc="No incidents." /> : null}
  </>)}</State>);
}

type Keys = { users: { id: string; email: string }[]; keys: { id: string; name: string; prefix: string; status: string; email: string; workspaceName: string | null; projectName: string | null; environmentName: string | null; rpm: number | null; monthlyCapMicro: string | null; lastUsedAt: string | null; createdAt: string; usage: { requests: number; tokensIn: number; tokensOut: number; cost: string } }[] };
function KeysView() {
  const { d, err } = useLoad<Keys>("/api/admin/keys");
  return (<State err={err} d={d}>{(v: Keys) => (
    <Table head={["Name", "Owner", "Prefix", "Status", "Scope", "Req", "Cost", "RPM", "Last used"]} rows={v.keys.map((k) => [k.name, k.email, k.prefix, k.status, [k.workspaceName, k.projectName, k.environmentName].filter(Boolean).join(" / ") || "user", String(k.usage.requests), fmtUsd(k.usage.cost), k.rpm === null ? "—" : String(k.rpm), k.lastUsedAt ? fmtDate(k.lastUsedAt) : "—"])} />
  )}</State>);
}

type Models = { providers: { id: string; name: string; status: string }[]; models: { id: string; slug: string; providerName: string; status: string; served: boolean; currency: string; inputPriceMicro: string; outputPriceMicro: string; mappingCount: number }[]; summary: { id: string; name: string; status: string; total: number; published: number; served: number }[]; counts: Record<string, number> };
function ModelsView() {
  const { d, err } = useLoad<Models>("/api/admin/models");
  return (<State err={err} d={d}>{(v: Models) => (<>
    <div className="row" style={{ flexWrap: "wrap" }}>
      {Object.entries(v.counts).map(([k, n]) => <Card key={k} title={k} desc={String(n)} />)}
    </div>
    <h2>Per-provider</h2>
    <Table head={["Provider", "Status", "Total", "Published", "Served"]} rows={v.summary.map((s) => [s.name, s.status, String(s.total), String(s.published), String(s.served)])} />
    <h2>Models</h2>
    <Table head={["Slug", "Provider", "Status", "Served", "In / 1M", "Out / 1M", "Mappings"]} rows={v.models.map((m) => [m.slug, m.providerName, m.status, String(m.served), fmtUsd(m.inputPriceMicro), fmtUsd(m.outputPriceMicro), String(m.mappingCount)])} />
  </>)}</State>);
}

type Projects = { projects: { id: string; name: string; slug: string; status: string; workspaceName: string; environments: number; keys: number; requests: number; cost: string; createdAt: string }[] };
function ProjectsView() {
  const { d, err } = useLoad<Projects>("/api/admin/projects");
  return (<State err={err} d={d}>{(v: Projects) => (
    <Table head={["Project", "Workspace", "Status", "Envs", "Keys", "Req", "Cost"]} rows={v.projects.map((p) => [p.name + " (" + p.slug + ")", p.workspaceName, p.status, String(p.environments), String(p.keys), String(p.requests), fmtUsd(p.cost)])} />
  )}</State>);
}

type Providers = { providers: { id: string; name: string; slug: string | null; status: string; tier: string; enabled: boolean; priority: number; modelCount: number; connectionCount: number; credentials: { total: number; healthy: number; unknown: number; bad: number } }[] };
function ProvidersView() {
  const { d, err } = useLoad<Providers>("/api/admin/providers");
  return (<State err={err} d={d}>{(v: Providers) => (
    <Table head={["Provider", "Slug", "Status", "Tier", "Prio", "Models", "Conns", "Creds ok/total/bad"]} rows={v.providers.map((p) => [p.name, p.slug ?? "—", p.status, p.tier, String(p.priority), String(p.modelCount), String(p.connectionCount), p.credentials.healthy + "/" + p.credentials.total + "/" + p.credentials.bad])} />
  )}</State>);
}

type Requests = { rows: { id: string; createdAt: string; email: string | null; keyName: string | null; requestedModel: string | null; modelSlug: string | null; providerName: string | null; status: string; errorCode: string | null; latencyMs: number; tokensIn: number; tokensOut: number; cost: string }[]; providers: { id: string; name: string }[] };
function RequestsView() {
  const [status, setStatus] = useState(""); const [model, setModel] = useState("");
  const qs = [status ? "status=" + encodeURIComponent(status) : "", model ? "model=" + encodeURIComponent(model) : ""].filter(Boolean).join("&");
  const { d, err } = useLoad<Requests>("/api/admin/requests" + (qs ? "?" + qs : ""));
  return (<>
    <form className="row" onSubmit={(e) => e.preventDefault()}>
      <Input aria-label="status filter" placeholder="status filter" value={status} onChange={(e) => setStatus(e.currentTarget.value)} />
      <Input aria-label="model filter" placeholder="model filter" value={model} onChange={(e) => setModel(e.currentTarget.value)} />
    </form>
    <State err={err} d={d}>{(v: Requests) => (
      <Table head={["ID", "At", "User", "Model", "Provider", "Status", "Latency", "Tokens", "Cost"]} rows={v.rows.map((r) => [r.id.slice(0, 12) + "…", fmtDate(r.createdAt), r.email ?? "—", r.modelSlug ?? r.requestedModel ?? "—", r.providerName ?? "—", r.errorCode ? r.status + ":" + r.errorCode : r.status, String(r.latencyMs), (r.tokensIn + r.tokensOut).toString(), fmtUsd(r.cost)])} />
    )}</State>
  </>);
}

type Routing = { policies: { id: string; name: string; strategy: string; enabled: boolean; maxAttempts: number; fallbackEnabled: boolean; scope: string; scopeName: string }[]; chain: { environment: string; project: string; workspace: string; policyId: string | null; policyName: string | null }[]; platformDefaultId: string | null; platformDefaultName: string | null };
function RoutingView() {
  const { d, err } = useLoad<Routing>("/api/admin/routing");
  return (<State err={err} d={d}>{(v: Routing) => (<>
    <Card titleAs="h2" title="Platform default" desc={v.platformDefaultName ?? v.platformDefaultId ?? "none"} />
    <h2>Policies</h2>
    <Table head={["Name", "Scope", "Strategy", "Enabled", "Attempts", "Fallback"]} rows={v.policies.map((p) => [p.name, p.scopeName, p.strategy, String(p.enabled), String(p.maxAttempts), String(p.fallbackEnabled)])} />
    <h2>Resolution chain (environment → policy)</h2>
    <Table head={["Workspace", "Project", "Environment", "Policy"]} rows={v.chain.map((c) => [c.workspace, c.project, c.environment, c.policyName ?? "—"])} />
  </>)}</State>);
}

type Security = { rules: { id: string; name: string; kind: string; config: unknown; enabled: boolean; action: string }[] };
function SecurityView() {
  const { d, err } = useLoad<Security>("/api/admin/security");
  return (<State err={err} d={d}>{(v: Security) => (
    <Table head={["Name", "Kind", "Action", "Enabled", "Config"]} rows={v.rules.map((r) => [r.name, r.kind, r.action, String(r.enabled), JSON.stringify(r.config)])} />
  )}</State>);
}

type Settings = { maintenance: boolean; genericPassthrough: boolean; registration: boolean; retention: Record<string, number>; defaultRoutingPolicyId: string; hardLimits: { rpm: number; tpm: number; concurrency: number }; policies: { id: string; name: string; strategy: string }[]; accounts: { workspaceId: string; warningMicro: string; hardStopMicro: string }[] };
function SettingsView() {
  const { d, err } = useLoad<Settings>("/api/admin/settings");
  return (<State err={err} d={d}>{(v: Settings) => (<>
    <div className="row" style={{ flexWrap: "wrap" }}>
      <Card titleAs="h2" title="maintenance" desc={String(v.maintenance)} />
      <Card titleAs="h2" title="generic_passthrough" desc={String(v.genericPassthrough)} />
      <Card titleAs="h2" title="registration" desc={String(v.registration)} />
      <Card titleAs="h2" title="default_routing_policy" desc={v.defaultRoutingPolicyId || "none"} />
      <Card titleAs="h2" title="hard limits" desc={"rpm " + v.hardLimits.rpm + " · tpm " + v.hardLimits.tpm + " · concurrency " + v.hardLimits.concurrency} />
    </div>
    <h2>Retention (days)</h2>
    <Table head={["Scope", "Days"]} rows={Object.entries(v.retention).map(([k, n]) => [k, String(n)])} />
    <h2>Routing policies</h2>
    <Table head={["Name", "Strategy"]} rows={v.policies.map((p) => [p.name, p.strategy])} />
    <h2>Billing thresholds ({v.accounts.length} accounts)</h2>
    <Table head={["Workspace ID", "Warning", "Hard stop"]} rows={v.accounts.slice(0, 50).map((a) => [a.workspaceId, fmtUsd(a.warningMicro), fmtUsd(a.hardStopMicro)])} />
  </>)}</State>);
}

type System = { database: { size: string; connections: number } | null; valkey: string; backlog: number; jobCounts: { status: string; n: number }[]; openIncidents: { id: string; title: string; component: string; severity: string; status: string; startedAt: string }[]; events: { id: string; type: string; resource: string | null; resourceId: string | null; createdAt: string }[] };
function SystemView() {
  const { d, err } = useLoad<System>("/api/admin/system");
  return (<State err={err} d={d}>{(v: System) => (<>
    <div className="row" style={{ flexWrap: "wrap" }}>
      <Card titleAs="h2" title="database" desc={v.database ? v.database.size + " · " + v.database.connections + " conns" : "unavailable"} />
      <Card titleAs="h2" title="valkey" desc={v.valkey} />
      <Card titleAs="h2" title="job backlog" desc={String(v.backlog)} />
    </div>
    <h2>Jobs by status</h2>
    <Table head={["Status", "Count"]} rows={v.jobCounts.map((j) => [j.status, String(j.n)])} />
    <h2>Open incidents</h2>
    <Table head={["Title", "Component", "Severity", "Status", "Started"]} rows={v.openIncidents.map((i) => [i.title, i.component, i.severity, i.status, fmtDate(i.startedAt)])} />
    <h2>Recent system events</h2>
    <Table head={["Type", "Resource", "At"]} rows={v.events.map((e) => [e.type, (e.resource ?? "") + (e.resourceId ? "/" + e.resourceId : "") || "—", fmtDate(e.createdAt)])} />
  </>)}</State>);
}

type Traffic = { hard: { rpm: number; tpm: number; concurrency: number } | null };
function TrafficView() {
  const { d, err } = useLoad<Traffic>("/api/admin/traffic");
  return (<State err={err} d={d}>{(v: Traffic) => (
    <Card titleAs="h2" title="Platform hard limits" desc={v.hard ? "rpm " + v.hard.rpm + " · tpm " + v.hard.tpm + " · concurrency " + v.hard.concurrency : "not set — no platform ceiling configured"} />
  )}</State>);
}

type Users = { users: { id: string; name: string; email: string; role: string | null; banned: boolean | null; workspaces: number; projects: number; keys: number; requests: number; cost: string; lastActivity: string | null; createdAt: string }[]; roles: string[] };
function UsersView() {
  const { d, err } = useLoad<Users>("/api/admin/users");
  return (<State err={err} d={d}>{(v: Users) => (
    <Table head={["Email", "Name", "Role", "Banned", "WS", "Keys", "Req", "Cost", "Last activity"]} rows={v.users.map((u) => [u.email, u.name, u.role ?? "—", String(!!u.banned), String(u.workspaces), String(u.keys), String(u.requests), fmtUsd(u.cost), u.lastActivity ? fmtDate(u.lastActivity) : "—"])} />
  )}</State>);
}

type Workspaces = { workspaces: { id: string; name: string; slug: string; status: string; ownerEmail: string | null; members: number; projects: number; requests: number; cost: string; balanceMicro: string; createdAt: string }[] };
function WorkspacesView() {
  const { d, err } = useLoad<Workspaces>("/api/admin/workspaces");
  return (<State err={err} d={d}>{(v: Workspaces) => (
    <Table head={["Workspace", "Owner", "Status", "Members", "Projects", "Req", "Cost", "Balance"]} rows={v.workspaces.map((w) => [w.name + " (" + w.slug + ")", w.ownerEmail ?? "—", w.status, String(w.members), String(w.projects), String(w.requests), fmtUsd(w.cost), fmtUsd(w.balanceMicro)])} />
  )}</State>);
}

const VIEWS: Record<string, { lede: string; el: () => ReactNode }> = {
  analytics: { lede: "Usage rollups with request-log fallback and exact latency percentiles.", el: AnalyticsView },
  billing: { lede: "Billing accounts, credit ledger, and invoices.", el: BillingView },
  connections: { lede: "Provider connections and credential health. Secrets never leave the server.", el: ConnectionsView },
  health: { lede: "Observed provider and connection health over the last 24h.", el: HealthView },
  incidents: { lede: "Status-page incidents with timelines.", el: IncidentsView },
  keys: { lede: "API key metadata and per-key usage. Hashes never leave the server.", el: KeysView },
  models: { lede: "Model catalog, effective prices, and publish state.", el: ModelsView },
  projects: { lede: "Customer projects with usage and resource counts.", el: ProjectsView },
  providers: { lede: "Providers with model, connection, and credential counts.", el: ProvidersView },
  requests: { lede: "Request log. Bodies never cross this boundary.", el: RequestsView },
  routing: { lede: "Routing policies and the environment resolution chain.", el: RoutingView },
  security: { lede: "Abuse-signal rules. Enforcement lists live on their own pages.", el: SecurityView },
  settings: { lede: "Platform settings, retention, limits, and billing defaults.", el: SettingsView },
  system: { lede: "Database, queue backlog, incidents, and events.", el: SystemView },
  traffic: { lede: "Platform hard limits — the ceiling every scope is capped by.", el: TrafficView },
  users: { lede: "Accounts with usage and activity.", el: UsersView },
  workspaces: { lede: "Customer workspaces with members, projects, and balances.", el: WorkspacesView },
};

export function AdminSectionRoute() {
  const p = useParams();
  return <AdminSection name={p.name ?? ""} />;
}

export function AdminSection({ name }: { name: string }) {
  const v = VIEWS[name];
  if (!v) return (<Page title={"Admin / " + name} lede="Unknown section."><Card desc="No such admin section." /></Page>);
  const El = v.el;
  return (<Page title={"Admin / " + name} lede={v.lede}><El /></Page>);
}

const LIST_KEYS = ["incidents", "connections", "providers", "models", "users", "keys", "projects", "workspaces", "policies", "rules", "rows", "accounts", "recent", "topConsumers", "openIncidents", "events"] as const;
export function AdminDetail() {
  const p = useParams();
  const section = p.section ?? "";
  const id = p.id ?? "";
  const { d, err } = useLoad<Record<string, unknown>>("/api/admin/" + section);
  return (<Page title={"Admin / " + section + " / " + id} lede="Detail.">
    <State err={err} d={d}>{(v: Record<string, unknown>) => {
      let found: Record<string, unknown> | null = null;
      for (const k of LIST_KEYS) {
        const list = v[k];
        if (Array.isArray(list)) {
          for (const r of list) {
            if (r && typeof r === "object" && "id" in r && (r as { id: unknown }).id === id) { found = r as Record<string, unknown>; break; }
          }
          if (found) break;
        }
      }
      if (!found) return (<Card desc={"No record " + id + " in section " + section + "."} />);
      const entries = Object.entries(found).filter(([k]) => k !== "updates");
      return (<>
        <Table head={["Field", "Value"]} rows={entries.map(([k, val]) => [k, typeof val === "object" ? JSON.stringify(val) : String(val ?? "—")])} />
        {"updates" in found && Array.isArray(found.updates) ? <Table head={["At", "Status", "Message"]} rows={found.updates.map((u) => {
          if (u && typeof u === "object" && "createdAt" in u && "status" in u && "message" in u) {
            const uu = u as { createdAt: unknown; status: unknown; message: unknown };
            return [fmtDate(uu.createdAt), String(uu.status ?? "—"), String(uu.message ?? "—")];
          }
          return ["—", "—", JSON.stringify(u)];
        })} /> : null}
      </>);
    }}</State>
  </Page>);
}
