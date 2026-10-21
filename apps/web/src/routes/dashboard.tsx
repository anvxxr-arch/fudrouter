import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { apiGet, apiPost } from "../lib/server";
import { ConsoleLayout } from "../components/ConsoleLayout";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Table } from "../components/ui/table";
import { StatCard, pctDelta } from "../components/stat-card";
import "./dashboard.css";

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
  if (loading) return <p className="muted" role="status" aria-live="polite">Loading…</p>;
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

type SeriesPoint = { day: string; requests: number; tokens: number; cost: string; errors: number; tokensIn: number; tokensOut: number };
type FiringAlert = { id: string; alertId: string; alertName: string; projectId: string | null; conditionType: string; value: string; message: string; triggeredAt: string | null };
type DashboardData = { totals: { requests: number; tokensIn: number; tokensOut: number; cost: string }; activeKeys: number; recent: { id: string; createdAt: string; model_slug: string | null; providerName: string | null; tokens_in: number; tokens_out: number; cost: string; latency_ms: number; status: string }[]; series: SeriesPoint[]; byModel: { slug: string; requests: number; cost: string }[]; range: number; workspaceId: string; workspaceCreatedAt: string | null; balanceMicro: string; firingAlerts: FiringAlert[] };

// The series always ends today (pages.mjs materialises one entry per day from
// `since`), whatever range was requested, so the last entry is today and the
// one before it is yesterday.
function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
function TokenChart({ series }: { series: SeriesPoint[] }) {
  const w = 720, h = 220, padL = 44, padR = 12, padT = 12, padB = 26;
  const max = Math.max(...series.map((s) => Math.max(s.tokensIn, s.tokensOut)), 1);
  const x = (i: number) => padL + (i / Math.max(series.length - 1, 1)) * (w - padL - padR);
  const y = (v: number) => padT + (1 - v / max) * (h - padT - padB);
  const line = (key: "tokensIn" | "tokensOut") => series.map((s, i) => `${x(i).toFixed(1)},${y(s[key]).toFixed(1)}`).join(" ");
  const area = (key: "tokensIn" | "tokensOut") => `${x(0).toFixed(1)},${y(0).toFixed(1)} ${line(key)} ${x(series.length - 1).toFixed(1)},${y(0).toFixed(1)}`;
  const first = series[0]?.day ?? "", last = series[series.length - 1]?.day ?? "";
  return (<svg className="token-chart" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Daily input and output tokens from ${first} to ${last}. Peak ${fmtCompact(max)} tokens.`}>
    <line className="token-chart-axis" x1={padL} y1={y(max)} x2={w - padR} y2={y(max)} />
    <text className="token-chart-tick" x={padL - 6} y={y(max) + 4} textAnchor="end">{fmtCompact(max)}</text>
    <polygon className="token-chart-area token-chart-area--in" points={area("tokensIn")} />
    <polyline className="token-chart-line token-chart-line--in" points={line("tokensIn")} />
    <polygon className="token-chart-area token-chart-area--out" points={area("tokensOut")} />
    <polyline className="token-chart-line token-chart-line--out" points={line("tokensOut")} />
    <text className="token-chart-tick" x={padL} y={h - 8}>{first}</text>
    <text className="token-chart-tick" x={w - padR} y={h - 8} textAnchor="end">{last}</text>
  </svg>);
}

// Onboarding checklist (spec §19 item 7). Shown only while the workspace is
// under a week old AND has no key yet — once a key exists the member has
// already done the work the banner asks for, so it stops nagging. Two steps
// only: sign-up auto-provisions a project, so a project step would be green on
// the first render and could never change state before the banner hides.
// Dismissal is per-workspace in localStorage: switching workspaces must not
// carry a dismissal across, and a member with two workspaces sees each one's
// own checklist.
const ONBOARDING_KEY = "fudrouter.onboarding.dismissed";
const ONBOARDING_MAX_AGE_MS = 7 * 86_400_000;
function OnboardingBanner({ d }: { d: DashboardData }) {
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    try { setDismissed(localStorage.getItem(`${ONBOARDING_KEY}:${d.workspaceId}`) === "1"); } catch { setDismissed(false); }
  }, [d.workspaceId]);
  const createdAt = d.workspaceCreatedAt ? new Date(d.workspaceCreatedAt).getTime() : NaN;
  const young = Number.isFinite(createdAt) && Date.now() - createdAt < ONBOARDING_MAX_AGE_MS;
  const steps = [
    { label: "Create your first API key", to: "/dashboard/keys", done: d.activeKeys > 0 },
    { label: "Send a request", to: "/docs/getting-started/quickstart", done: d.totals.requests > 0 },
  ];
  if (dismissed || !young || d.activeKeys > 0) return null;
  const done = steps.filter((s) => s.done).length;
  return (<Card className="onboarding">
    <div className="row onboarding-head">
      <h2 className="card-title">Get started</h2>
      <Button variant="ghost" size="sm" className="onboarding-dismiss" aria-label="Dismiss the getting-started checklist" onClick={() => {
        setDismissed(true);
        try { localStorage.setItem(`${ONBOARDING_KEY}:${d.workspaceId}`, "1"); } catch { /* private mode: the banner returns next visit */ }
      }}>✕</Button>
    </div>
    <div className="onboarding-track" role="progressbar" aria-valuenow={done} aria-valuemin={0} aria-valuemax={2} aria-label={`${done} of 2 setup steps complete`}>
      <span className="onboarding-fill" style={{ width: `${(done / 2) * 100}%` }} />
    </div>
    <ol className="onboarding-steps">
      {steps.map((s) => (<li key={s.to} className={s.done ? "onboarding-step onboarding-step--done" : "onboarding-step"}>
        <span aria-hidden="true">{s.done ? "✓" : "○"}</span>
        <Link to={s.to}>{s.label}</Link>
        <span className="muted">{s.done ? "done" : "pending"}</span>
      </li>))}
    </ol>
  </Card>);
}

export function DashboardHome() {
  // The range is the server's closed vocabulary (7|30|90, default 30); the
  // response echoes it back so the active button never disagrees with the
  // series actually rendered.
  const [range, setRange] = useState(30);
  const { data: d, error, loading } = useLoad<DashboardData>(`/api/pages/dashboard?range=${range}`);
  const series = d?.series ?? [];
  const today = series[series.length - 1];
  const yesterday = series[series.length - 2];
  // `totals` is the handler's unbounded count(*), so this means "never sent a
  // request" — which is what the card claims. Deriving it from the series
  // instead would call an account empty merely because its traffic predates
  // the selected range.
  const empty = (d?.totals.requests ?? 0) === 0;
  const topModel = d?.byModel?.[0];
  return (<ConsoleLayout><Page title="Dashboard" lede="Usage, keys, and spend at a glance.">
    <LoadState loading={loading} error={error} />
    {d ? (<>
      <OnboardingBanner d={d} />
      <div className="row" style={{ flexWrap: "wrap" }}>
        <StatCard title="Requests today" value={String(today?.requests ?? 0)} delta={today && yesterday ? pctDelta(today.requests, yesterday.requests) : undefined} spark={series.map((s) => s.requests)} />
        <StatCard title="Tokens today" value={fmtCompact(today ? today.tokensIn + today.tokensOut : 0)} delta={today && yesterday ? pctDelta(today.tokensIn + today.tokensOut, yesterday.tokensIn + yesterday.tokensOut) : undefined} spark={series.map((s) => s.tokensIn + s.tokensOut)} />
        <StatCard title="Errors today" value={String(today?.errors ?? 0)}>
          <p className={`stat-sub num ${today && today.requests > 0 ? (today.errors / today.requests < 0.01 ? "stat-rate--ok" : today.errors / today.requests <= 0.05 ? "stat-rate--warn" : "stat-rate--bad") : ""}`}>{today && today.requests > 0 ? `${((today.errors / today.requests) * 100).toFixed(1)}% error rate` : "no requests"}</p>
        </StatCard>
        <StatCard title="Credit balance" value={fmtMicro(d.balanceMicro)}>
          <Link to="/dashboard/billing/credits">Manage credits</Link>
        </StatCard>
      </div>
      {/* Live conditions, not a checklist: no dismiss. Workspace-level alerts
          carry no project, so only project alerts get a link to their page. */}
      {d.firingAlerts.length > 0 ? (
        <Card titleAs="h2" title="Alerts">
          <ul className="alert-list">
            {d.firingAlerts.map((a) => (<li key={a.id} className="alert-row">
              <Badge tone="warn">{a.conditionType.replace(/_/g, " ")}</Badge>
              <span className="alert-name">{a.alertName}</span>
              <span className="num">{a.value}</span>
              <span className="muted">{fmtDate(a.triggeredAt)}</span>
              {a.projectId ? <Link to={`/dashboard/projects/${a.projectId}/alerts`}>View</Link> : null}
            </li>))}
          </ul>
        </Card>
      ) : null}
      <div className="row" style={{ flexWrap: "wrap" }}>
        {[7, 30, 90].map((n) => (<Button key={n} size="sm" variant={d.range === n ? "primary" : "secondary"} onClick={() => setRange(n)}>{n}d</Button>))}
      </div>
      {empty ? (
        <Card titleAs="h2" title="No traffic yet" desc="Mint a key and send a request.">
          <Link to="/dashboard/keys">Go to keys</Link>
        </Card>
      ) : (<>
        <h2>Tokens, last {d.range} days</h2>
        <div className="dash-panels">
          <Card titleAs="h3" title="Input vs output tokens" className="dash-chart-card"><TokenChart series={series} /></Card>
          <Card titleAs="h3" title="Top models" className="dash-models-card">
            <ul className="dash-models">
              {(d.byModel ?? []).map((m) => (
                <li key={m.slug}>
                  <span className="dash-model-slug">{m.slug}</span>
                  <span className="dash-model-bar"><span style={{ width: `${topModel && topModel.requests > 0 ? Math.round((m.requests / topModel.requests) * 100) : 0}%` }} /></span>
                  <span className="num dash-model-reqs">{m.requests}</span>
                  <span className="num dash-model-cost">{fmtMicro(m.cost)}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
        <h2>Recent requests</h2>
        {d.recent.length > 0 ? (<>
          <Table head={["Time", "Model", "Provider", "Tokens", "Cost", "Status", "Latency"]} rows={d.recent.map((r) => [
            fmtDate(r.createdAt),
            r.model_slug ?? "—",
            r.providerName ?? "—",
            <span key="t" className="num">{r.tokens_in} / {r.tokens_out}</span>,
            <span key="c" className="num">{fmtMicro(r.cost)}</span>,
            <Badge key="s" tone={r.status === "success" ? "ok" : "warn"}>{r.status.replace(/_/g, " ")}</Badge>,
            <span key="l" className="num">{r.latency_ms} ms</span>,
          ])} />
          <p><Link to="/dashboard/usage">View all</Link></p>
        </>) : <p className="muted">No requests logged yet.</p>}
      </>)}
    </>) : null}
    <div className="row"><Link to="/dashboard/projects/new"><Button>New project</Button></Link></div>
  </Page></ConsoleLayout>);
}

type KeyUsage = { requests: number; tokens: number; costMicro: string };
type KeyRow = {
  id: string; name: string; prefix: string; status: string;
  lastUsedAt: string | null; revokedAt: string | null; createdAt: string | null; expiresAt: string | null;
  projectId: string | null; projectName: string | null;
  environmentId: string | null; environmentName: string | null;
  usage30d: KeyUsage;
};
type KeysData = { keys: KeyRow[] };

// Relative timestamps keep the table scannable; a date library would be a
// dependency for one function.
function relTime(v: string | null): string {
  if (!v) return "never";
  const then = new Date(v).getTime();
  if (Number.isNaN(then)) return "never";
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.round(days / 365);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

// Expired is derived, not stored: revoked wins, then a past expiresAt, then
// the stored status. A project-disabled key surfaces as Disabled so it never
// reads as Active.
function keyStatus(k: KeyRow): { label: string; tone: "ok" | "warn" | "danger" } {
  if (k.revokedAt || k.status === "revoked") return { label: "Revoked", tone: "danger" };
  if (k.expiresAt && new Date(k.expiresAt).getTime() <= Date.now()) return { label: "Expired", tone: "warn" };
  if (k.status === "disabled") return { label: "Disabled", tone: "warn" };
  return { label: "Active", tone: "ok" };
}

// Deliberately trap-free: Escape and backdrop close it, and focus lands on the
// first field, which is all the keyboard support a two-field dialog needs.
// onClose lives in a ref so a parent re-render never re-runs the effect and
// yanks focus back to the first field mid-typing.
function KeysDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close.current(); };
    document.addEventListener("keydown", onKey);
    box.current?.querySelector<HTMLElement>("input, select, textarea, button")?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return (<div className="keys-backdrop" onClick={() => close.current()}>
    <div ref={box} className="keys-dialog" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
      <h2 className="keys-dialog-title">{title}</h2>
      {children}
    </div>
  </div>);
}

function NewKeyModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [secret, setSecret] = useState<{ key: string; name: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState("");
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [copied, setCopied] = useState(false);
  // The project list is best-effort: without it the modal still offers the
  // workspace scope, so a failed load must not block key creation.
  useEffect(() => {
    apiGet<{ projects: { id: string; name: string }[] }>("/api/pages/dashboard/projects")
      .then((d) => setProjects(d.projects ?? []))
      .catch(() => setProjects([]));
  }, []);
  if (secret) {
    return (<KeysDialog title="Key created" onClose={onClose}>
      <p className="keys-warn">This is the only time you&apos;ll see this secret</p>
      <div className="keys-secret"><code>{secret.key}</code></div>
      <div className="row">
        <Button variant="secondary" onClick={() => { navigator.clipboard?.writeText(secret.key).then(() => setCopied(true)).catch(() => {}); }}>{copied ? "Copied" : "Copy"}</Button>
        <Button variant="primary" onClick={() => { onCreated(); onClose(); }}>I&apos;ve saved it</Button>
      </div>
    </KeysDialog>);
  }
  return (<KeysDialog title="New API key" onClose={onClose}>
    <form className="keys-form" onSubmit={(e) => {
      e.preventDefault(); setErr(null); setBusy(true);
      const f = new FormData(e.currentTarget);
      apiPost<{ created: string; name: string }>("/api/pages/dashboard/keys/create", { name: String(f.get("name") ?? ""), projectId: scope || undefined, expiresIn: String(f.get("expiresIn") ?? "never") })
        .then((r) => { setSecret({ key: r.created, name: r.name }); onCreated(); })
        .catch((ex) => setErr(ex instanceof Error ? ex.message : "Create failed"))
        .finally(() => setBusy(false));
    }}>
      <label className="keys-field"><span>Name</span>
        <Input name="name" placeholder="e.g. production-backend" required />
      </label>
      <label className="keys-field"><span>Scope</span>
        <select className="select" value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="">Workspace</option>
          {projects.map((p) => <option key={p.id} value={p.id}>Project: {p.name}</option>)}
        </select>
      </label>
      <label className="keys-field"><span>Expiry</span>
        <select className="select" name="expiresIn" defaultValue="never">
          <option value="never">Never</option>
          <option value="30d">30 days</option>
          <option value="90d">90 days</option>
          <option value="1y">1 year</option>
        </select>
      </label>
      {err ? <p className="error">{err}</p> : null}
      <div className="row">
        <Button type="submit" variant="primary" disabled={busy}>{busy ? "Creating…" : "Create"}</Button>
        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
      </div>
    </form>
  </KeysDialog>);
}

function RevokeDialog({ apiKey, onClose, onRevoked }: { apiKey: KeyRow; onClose: () => void; onRevoked: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (<KeysDialog title="Revoke key" onClose={onClose}>
    <p>Revoke <code className="keys-prefix">sk-ar-{apiKey.prefix}_</code>? Requests using it will immediately fail with 401, and this cannot be undone.</p>
    {err ? <p className="error">{err}</p> : null}
    <div className="row">
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button variant="destructive" disabled={busy} onClick={() => {
        setErr(null); setBusy(true);
        apiPost("/api/pages/dashboard/keys/revoke", { id: apiKey.id })
          .then(() => { onRevoked(); onClose(); })
          .catch((ex) => setErr(ex instanceof Error ? ex.message : "Revoke failed"))
          .finally(() => setBusy(false));
      }}>{busy ? "Revoking…" : "Revoke"}</Button>
    </div>
  </KeysDialog>);
}

export function KeysPage() {
  const [tick, setTick] = useState(0);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<KeyRow | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const { data: d, error, loading } = useLoad<KeysData>("/api/pages/dashboard/keys", tick);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const keys = d?.keys ?? [];
  const byUsage = [...keys].sort((a, b) => b.usage30d.requests - a.usage30d.requests);
  const copyPrefix = (k: KeyRow) => {
    navigator.clipboard?.writeText(`sk-ar-${k.prefix}_`).then(() => { setCopied(k.id); window.setTimeout(() => setCopied(null), 1600); }).catch(() => {});
  };
  return (<ConsoleLayout>
    <div className="stack">
      <div className="keys-head">
        <h1>API keys</h1>
        <Button variant="primary" onClick={() => setCreating(true)}>New key</Button>
      </div>
      <p className="lede muted">Create, scope and revoke the keys your apps authenticate with.</p>
      <div className="keys-info" role="note">
        <p>Keys are stored as SHA-256 hashes — the secret itself is never saved. A lost secret cannot be recovered, so create a new key instead.</p>
      </div>
      <LoadState loading={loading} error={error} />
      {!loading && !error && keys.length === 0 ? (
        <div className="keys-empty">
          <p className="muted">No API keys yet.</p>
          <Button variant="primary" onClick={() => setCreating(true)}>New key</Button>
        </div>
      ) : null}
      {keys.length > 0 ? (
        <Table head={["Name", "Key", "Created", "Last used", "Requests (30d)", "Status", ""]} rows={keys.map((k) => {
          const st = keyStatus(k);
          return [
            <div key="name" className="keys-name">{k.name}<Badge tone={k.projectName ? "info" : "default"}>{k.projectName ? `project:${k.projectName}` : "workspace"}</Badge></div>,
            <div key="key" className="keys-key"><code>sk-ar-{k.prefix}_<span className="keys-mask">••••••••••••</span></code><Button size="sm" variant="ghost" onClick={() => copyPrefix(k)}>{copied === k.id ? "Copied" : "Copy prefix"}</Button></div>,
            <span key="created" title={fmtDate(k.createdAt)}>{relTime(k.createdAt)}</span>,
            <span key="used" title={fmtDate(k.lastUsedAt)}>{relTime(k.lastUsedAt)}</span>,
            <span key="reqs" className="num">{k.usage30d.requests}</span>,
            <Badge key="status" tone={st.tone}>{st.label}</Badge>,
            <Button key="revoke" size="sm" variant="secondary" disabled={st.label === "Revoked"} onClick={() => setRevoking(k)}>Revoke</Button>,
          ];
        })} />
      ) : null}
      {keys.length > 0 ? (<>
        <h2>Usage per key</h2>
        <Table head={["Key", "Requests 30d", "Tokens 30d", "Cost 30d"]} rows={byUsage.map((k) => [
          <span key="k">{k.name} <code className="keys-prefix">sk-ar-{k.prefix}_</code></span>,
          <span key="r" className="num">{k.usage30d.requests}</span>,
          <span key="t" className="num">{k.usage30d.tokens}</span>,
          <span key="c" className="num">{fmtMicro(k.usage30d.costMicro)}</span>,
        ])} />
      </>) : null}
    </div>
    {creating ? <NewKeyModal onClose={() => setCreating(false)} onCreated={refresh} /> : null}
    {revoking ? <RevokeDialog apiKey={revoking} onClose={() => setRevoking(null)} onRevoked={refresh} /> : null}
  </ConsoleLayout>);
}

type UsageBreakdownRow = { key: string; label: string; requests: number; totalTokens: number; costMicro: string };
type UsageData = {
	totals: { requests: number; tokensIn: number; tokensOut: number; costMicro: string };
	latency: { p50: number; p95: number; p99: number };
	breakdowns: { byDay: { day: string; requests: number; totalTokens: number; costMicro: string }[]; byProject: UsageBreakdownRow[]; byEnvironment: UsageBreakdownRow[]; byApiKey: UsageBreakdownRow[]; byModel: UsageBreakdownRow[]; byProvider: UsageBreakdownRow[] };
	errorsByDay: { day: string; errors: number }[];
	latencyByDay: { day: string; p50: number; p95: number; p99: number }[];
	facets: { models: { key: string; label: string }[]; providers: { key: string; label: string }[] };
};
type UsageLogRow = { id: string; createdAt: string; requestedModel: string | null; modelSlug: string | null; providerName: string | null; attempts: number; fallbackUsed: boolean; tokensIn: number; tokensOut: number; costMicro: string; latencyMs: number; ttftMs: number | null; status: string; errorCode: string | null };
type UsageLogData = { rows: UsageLogRow[]; total: number; page: number; pages: number };
const USAGE_STATUSES = ["success", "client_error", "provider_error", "timeout", "rate_limited", "cancelled", "internal_error"];

// Inline SVG line chart: one polyline per series, y scaled to the shared max.
// No charting dependency — the console ships none and this is the whole need.
function LineChart({ series, ariaLabel }: { series: { cls: string; values: number[] }[]; ariaLabel: string }) {
	const W = 600, H = 180, PAD = 8;
	const n = series[0]?.values.length ?? 0;
	const max = Math.max(1, ...series.flatMap((s) => s.values));
	const x = (i: number) => PAD + (n <= 1 ? 0 : (i * (W - 2 * PAD)) / (n - 1));
	const y = (v: number) => H - PAD - (v / max) * (H - 2 * PAD);
	return (
		<svg className="usage-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel} preserveAspectRatio="none">
			{series.map((s) => (
				<polyline key={s.cls} className={s.cls} points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ")} />
			))}
		</svg>
	);
}

function UsageBars({ rows, unit }: { rows: UsageBreakdownRow[]; unit: string }) {
	const max = Math.max(1, ...rows.map((r) => r.requests));
	return (
		<ul className="usage-bars">
			{rows.map((r) => (
				<li key={r.key}>
					<span className="usage-bar-label" title={r.label}>{r.label}</span>
					<span className="usage-bar-track"><span className="usage-bar-fill" style={{ width: `${(r.requests / max) * 100}%` }} /></span>
					<span className="usage-bar-reqs">{r.requests}</span>
					<span className="usage-bar-cost">{fmtMicro(r.costMicro)}</span>
				</li>
			))}
			{rows.length === 0 ? <li className="muted">No {unit} in range.</li> : null}
		</ul>
	);
}

export function UsagePage() {
	const [days, setDays] = useState(30);
	const [filters, setFilters] = useState({ model: "", provider: "", status: "" });
	const [page, setPage] = useState(1);
	const [open, setOpen] = useState<UsageLogRow | null>(null);
	const [copied, setCopied] = useState(false);
	const qs = new URLSearchParams({ days: String(days) });
	if (filters.model) qs.set("model", filters.model);
	if (filters.provider) qs.set("provider", filters.provider);
	if (filters.status) qs.set("status", filters.status);
	const query = qs.toString();
	const { data: d, error, loading } = useLoad<UsageData>(`/api/pages/dashboard/usage?${query}`);
	const { data: log, error: logError, loading: logLoading } = useLoad<UsageLogData>(`/api/pages/dashboard/usage/requests?${query}&page=${page}`);
	const setFilter = (k: "model" | "provider" | "status", v: string) => { setFilters((f) => ({ ...f, [k]: v })); setPage(1); };
	const reset = () => { setFilters({ model: "", provider: "", status: "" }); setPage(1); };
	const errByDay: Record<string, number> = {};
	for (const r of d?.errorsByDay ?? []) errByDay[r.day] = r.errors;
	// Labels for the active-filter summary; facets are unfiltered so the
	// selects keep every option while a filter is active.
	const labelOf = (list: { key: string; label: string }[], key: string) => list.find((x) => x.key === key)?.label ?? key;
	const active = [
		filters.model && `model ${labelOf(d?.facets.models ?? [], filters.model)}`,
		filters.provider && `provider ${labelOf(d?.facets.providers ?? [], filters.provider)}`,
		filters.status && `status ${filters.status.replace(/_/g, " ")}`,
	].filter(Boolean).join(" · ");

	// Escape closes the drawer; the backdrop click is handled inline.
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(null); };
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open]);

	const empty = !!d && d.totals.requests === 0;
	return (<ConsoleLayout><Page title="Usage" lede="Metered calls.">
		<div className="row" style={{ flexWrap: "wrap" }}>
			{[1, 7, 30, 90].map((n) => (<Button key={n} size="sm" variant={days === n ? "primary" : "secondary"} onClick={() => { setDays(n); setPage(1); }}>{n}d</Button>))}
			<select className="usage-select" aria-label="Filter by model" value={filters.model} onChange={(e) => setFilter("model", e.target.value)}>
				<option value="">All models</option>
				{(d?.facets.models ?? []).map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
			</select>
			<select className="usage-select" aria-label="Filter by provider" value={filters.provider} onChange={(e) => setFilter("provider", e.target.value)}>
				<option value="">All providers</option>
				{(d?.facets.providers ?? []).map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
			</select>
			<select className="usage-select" aria-label="Filter by status" value={filters.status} onChange={(e) => setFilter("status", e.target.value)}>
				<option value="">All statuses</option>
				{USAGE_STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
			</select>
			<Button size="sm" variant="ghost" onClick={reset}>Reset</Button>
		</div>
		<LoadState loading={loading} error={error} />
		{d ? (empty ? (
			<p className="muted">No traffic in this range. <Link to="/dashboard/keys">Create an API key</Link> to start sending requests.</p>
		) : (<>
			<div className="row" style={{ flexWrap: "wrap" }}>
				<Card titleAs="h2" title="Requests" desc={String(d.totals.requests)} />
				<Card titleAs="h2" title="Tokens" desc={`${d.totals.tokensIn + d.totals.tokensOut} (${d.totals.tokensIn} in / ${d.totals.tokensOut} out)`} />
				<Card titleAs="h2" title="Cost" desc={fmtMicro(d.totals.costMicro)} />
				<Card titleAs="h2" title="Median latency" desc={`${d.latency.p50} ms`} />
			</div>
			<div className="usage-charts">
				<div className="card usage-chart-card">
					<h3 className="card-title">Requests per day</h3>
					<LineChart ariaLabel={`Requests per day over the last ${days} days: total and errors`} series={[
						{ cls: "usage-line--req", values: d.breakdowns.byDay.map((r) => r.requests) },
						{ cls: "usage-line--err", values: d.breakdowns.byDay.map((r) => errByDay[r.day] ?? 0) },
					]} />
					<p className="usage-legend"><span className="usage-chip usage-chip--req" /> total <span className="usage-chip usage-chip--err" /> errors</p>
				</div>
				<div className="card usage-chart-card">
					<h3 className="card-title">Latency per day</h3>
					<LineChart ariaLabel={`Latency percentiles per day over the last ${days} days: p50, p95 and p99`} series={[
						{ cls: "usage-line--p50", values: d.latencyByDay.map((r) => r.p50) },
						{ cls: "usage-line--p95", values: d.latencyByDay.map((r) => r.p95) },
						{ cls: "usage-line--p99", values: d.latencyByDay.map((r) => r.p99) },
					]} />
					<p className="usage-legend"><span className="usage-chip usage-chip--p50" /> p50 <span className="usage-chip usage-chip--p95" /> p95 <span className="usage-chip usage-chip--p99" /> p99</p>
				</div>
			</div>
			<div className="usage-panels">
				<div className="card">
					<h3 className="card-title">By model</h3>
					<UsageBars rows={d.breakdowns.byModel} unit="models" />
				</div>
				<div className="card">
					<h3 className="card-title">By provider</h3>
					<UsageBars rows={d.breakdowns.byProvider} unit="providers" />
				</div>
			</div>
			<h2>Request log</h2>
			<p className="muted">{active ? `Filtered by ${active}. ` : ""}{log ? `${log.total} requests · page ${log.page} of ${log.pages}` : ""}</p>
			<LoadState loading={logLoading} error={logError} />
			<Table head={["Time", "Model", "Provider", "Tokens in/out", "Cost", "Latency", "Status"]} rows={(log?.rows ?? []).map((r) => [
				<button key={r.id} type="button" className="usage-row-btn" onClick={() => { setOpen(r); setCopied(false); }} aria-label={`Open details for request ${r.id}`}>{fmtDate(r.createdAt)}</button>,
				r.modelSlug ?? r.requestedModel ?? "—",
				r.providerName ?? "—",
				`${r.tokensIn} / ${r.tokensOut}`,
				fmtMicro(r.costMicro),
				`${r.latencyMs} ms`,
				r.status,
			])} />
			<div className="row">
				<Button size="sm" variant="secondary" disabled={!log || log.page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Prev</Button>
				<Button size="sm" variant="secondary" disabled={!log || log.page >= log.pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
			</div>
		</>)) : null}
		{open ? (
			<div className="usage-drawer-backdrop" onClick={() => setOpen(null)}>
				<div className="usage-drawer" role="dialog" aria-modal="true" aria-label="Request details" onClick={(e) => e.stopPropagation()}>
					<div className="row usage-drawer-head">
						<h3>Request</h3>
						<Button size="sm" variant="ghost" onClick={() => setOpen(null)}>Close</Button>
					</div>
					<p className="usage-drawer-id"><code>{open.id}</code>
						<Button size="sm" variant="secondary" onClick={() => { navigator.clipboard?.writeText(open.id).then(() => setCopied(true)).catch(() => {}); }}>{copied ? "Copied" : "Copy id"}</Button>
					</p>
					<dl className="usage-drawer-grid">
						<dt>Created</dt><dd>{fmtDate(open.createdAt)}</dd>
						<dt>Requested model</dt><dd>{open.requestedModel ?? "—"}</dd>
						<dt>Served model</dt><dd>{open.modelSlug ?? "—"}</dd>
						<dt>Provider</dt><dd>{open.providerName ?? "—"}</dd>
						<dt>Attempts</dt><dd>{open.attempts}{open.fallbackUsed ? " (fallback used)" : ""}</dd>
						<dt>Tokens in</dt><dd>{open.tokensIn}</dd>
						<dt>Tokens out</dt><dd>{open.tokensOut}</dd>
						<dt>Cost</dt><dd>{fmtMicro(open.costMicro)}</dd>
						<dt>Latency</dt><dd>{open.latencyMs} ms</dd>
						<dt>TTFT</dt><dd>{open.ttftMs == null ? "—" : `${open.ttftMs} ms`}</dd>
						<dt>Status</dt><dd>{open.status}</dd>
						<dt>Error code</dt><dd>{open.errorCode ?? "—"}</dd>
					</dl>
				</div>
			</div>
		) : null}
	</Page></ConsoleLayout>);
}

export function BillingPage() {
  const [tick, setTick] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const { data: d, error, loading } = useLoad<{ currency: string; status: string; workspaceName: string; canWrite: boolean; balanceMicro: string; warningThresholdMicro: string; hardStopThresholdMicro: string; period: { start: string; end: string; spentMicro: string; requests: number } }>("/api/pages/dashboard/billing", tick);
  return (<ConsoleLayout><Page title="Billing" lede="Thresholds, credits, invoices, payment methods.">
    <div className="row" style={{ flexWrap: "wrap" }}>
      <Link to="/dashboard/billing/credits"><Button variant="secondary">Credits</Button></Link>
      <Link to="/dashboard/billing/invoices"><Button variant="secondary">Invoices</Button></Link>
      <Link to="/dashboard/billing/payment-methods"><Button variant="secondary">Payment methods</Button></Link>
    </div>
    <LoadState loading={loading} error={error} />
    {d ? (<>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <Card titleAs="h2" title="Balance" desc={fmtMicro(d.balanceMicro)} />
        <Card titleAs="h2" title="Status" desc={d.status} />
        <Card titleAs="h2" title="This month" desc={`${fmtMicro(d.period.spentMicro)} · ${d.period.requests} reqs`} />
      </div>
      {d.canWrite ? (
        <form onSubmit={(e) => {
          e.preventDefault(); setErr(null);
          const f = new FormData(e.currentTarget);
          apiPost("/api/pages/dashboard/billing/thresholds", { warn: String(f.get("warn") ?? ""), suspend: String(f.get("suspend") ?? "") })
            .then(() => setTick((t) => t + 1))
            .catch((ex) => setErr(ex instanceof Error ? ex.message : "Save failed"));
        }}>
          <div className="row"><Input aria-label="Warn threshold" name="warn" placeholder="Warn threshold" /><Input aria-label="Suspend threshold" name="suspend" placeholder="Suspend threshold" /><Button type="submit">Save</Button></div>
        </form>
      ) : <p className="muted">Read-only: you need billing.write to change thresholds.</p>}
      {err ? <p className="error">{err}</p> : null}
    </>) : null}
  </Page></ConsoleLayout>);
}

type CreditsLedgerRow = { id: string; type: string; amountMicro: string; currency: string; requestId: string | null; description: string | null; createdAt: string; balanceAfterMicro: string };
type CreditsData = {
	currency: string;
	balanceMicro: string;
	rows: CreditsLedgerRow[];
	addCreditKey: string;
	page: number;
	pages: number;
	total: number;
	thresholds: { warningMicro: string; hardStopMicro: string };
	series: { day: string; series: { label: string; costMicro: string }[] }[];
	breakdowns: { byModel: UsageBreakdownRow[]; byProject: UsageBreakdownRow[] };
};

// Ledger types map to the shared badge tones: money in is ok, metered spend
// is neutral, manual corrections are warn.
const CREDIT_BADGE: Record<string, string> = { credit_purchase: "badge badge-ok", refund: "badge badge-ok", top_up: "badge badge-ok", adjustment: "badge badge-warn" };
const CREDIT_LABEL: Record<string, string> = { credit_purchase: "Top-up", usage_charge: "Usage", adjustment: "Adjustment", refund: "Refund" };

// Stacked bars: one column per day, one segment per series. Pure SVG — the
// console ships no charting dependency and this is the whole need.
function SpendChart({ series }: { series: CreditsData["series"] }) {
	const W = 720, H = 200, PAD_L = 48, PAD_R = 8, PAD_T = 8, PAD_B = 24;
	const labels = series[0]?.series.map((s) => s.label) ?? [];
	const totals = series.map((d) => d.series.reduce((acc, s) => acc + BigInt(s.costMicro), 0n));
	const max = totals.reduce((acc, v) => (v > acc ? v : acc), 1n);
	const barW = (W - PAD_L - PAD_R) / Math.max(series.length, 1);
	const y = (v: bigint) => H - PAD_B - Number((v * 1000n) / max) / 1000 * (H - PAD_T - PAD_B);
	const first = series[0]?.day ?? "", last = series[series.length - 1]?.day ?? "";
	const total = totals.reduce((acc, v) => acc + v, 0n);
	return (
		<svg className="credits-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Daily spend by model from ${first} to ${last}. Total ${fmtMicro(total.toString())} across ${labels.length} series.`}>
			<line className="credits-chart-axis" x1={PAD_L} y1={H - PAD_B} x2={W - PAD_R} y2={H - PAD_B} />
			<text className="credits-chart-tick" x={PAD_L - 6} y={H - PAD_B + 4} textAnchor="end">{fmtMicro(max.toString())}</text>
			{series.map((d, i) => {
				let acc = 0n;
				const x = PAD_L + i * barW;
				return (
					<g key={d.day}>
						{d.series.map((s, j) => {
							const v = BigInt(s.costMicro);
							const y0 = y(acc);
							acc += v;
							const y1 = y(acc);
							return <rect key={s.label} className={`credits-chart-seg credits-chart-seg--${j % 6}`} x={x + 1} y={y1} width={Math.max(barW - 2, 1)} height={Math.max(y0 - y1, 0)} />;
						})}
					</g>
				);
			})}
			<text className="credits-chart-tick" x={PAD_L} y={H - 6}>{first}</text>
			<text className="credits-chart-tick" x={W - PAD_R} y={H - 6} textAnchor="end">{last}</text>
		</svg>
	);
}

export function CreditsPage() {
	const [tick, setTick] = useState(0);
	const [page, setPage] = useState(1);
	const [err, setErr] = useState<string | null>(null);
	const { data: d, error, loading } = useLoad<CreditsData>(`/api/pages/dashboard/billing/credits?page=${page}`, tick);
	const rows = d?.rows ?? [];
	const warn = BigInt(d?.thresholds.warningMicro ?? "0");
	const hard = BigInt(d?.thresholds.hardStopMicro ?? "0");
	const balance = BigInt(d?.balanceMicro ?? "0");
	// Scale the bar to the larger of balance and warning so the marker is
	// always visible; a zero balance still shows the threshold position.
	const scale = balance > warn ? balance : warn;
	const pct = (v: bigint) => (scale === 0n ? 0 : Number((v * 10000n) / scale) / 100);
	const state = balance < hard ? "bad" : balance < warn ? "warn" : "ok";
	const stateText = state === "bad" ? "Below hard-stop threshold" : state === "warn" ? "Below warning threshold" : "Above warning threshold";
	return (<ConsoleLayout><Page title="Credits" lede="Ledger and balance.">
		<LoadState loading={loading} error={error} />
		{d ? (
			<div className="credits-balance">
				<p className="credits-balance-figure num">{fmtMicro(d.balanceMicro)}</p>
				<p className={`credits-balance-state credits-balance-state--${state}`}>{stateText} · warning {fmtMicro(d.thresholds.warningMicro)} · hard stop {fmtMicro(d.thresholds.hardStopMicro)}</p>
				<div className="credits-balance-track" role="img" aria-label={`Balance ${fmtMicro(d.balanceMicro)}. Warning threshold ${fmtMicro(d.thresholds.warningMicro)}, hard stop ${fmtMicro(d.thresholds.hardStopMicro)}.`}>
					<span className="credits-balance-fill" style={{ width: `${Math.min(pct(balance), 100)}%` }} />
					<span className="credits-balance-marker credits-balance-marker--warn" style={{ left: `${Math.min(pct(warn), 100)}%` }} />
					<span className="credits-balance-marker credits-balance-marker--hard" style={{ left: `${Math.min(pct(hard), 100)}%` }} />
				</div>
			</div>
		) : null}
		<form onSubmit={(e) => {
			e.preventDefault(); setErr(null);
			const f = new FormData(e.currentTarget);
			apiPost("/api/pages/dashboard/billing/credits/add", { amount: String(f.get("amount") ?? "") })
				.then(() => { (e.target as HTMLFormElement).reset(); setTick((t) => t + 1); })
				.catch((ex) => setErr(ex instanceof Error ? ex.message : "Add failed"));
		}}>
			<div className="row"><Input aria-label="Amount" name="amount" placeholder="Amount" required /><Button type="submit">Add</Button></div>
		</form>
		{err ? <p className="error">{err}</p> : null}
		{d && d.series.length > 0 ? (
			<div className="card credits-chart-card">
				<h2 className="card-title">Spend by model · last 30 days</h2>
				<SpendChart series={d.series} />
				<ul className="credits-legend">
					{(d.series[0]?.series ?? []).map((s, i) => (<li key={s.label}><span className={`credits-legend-swatch credits-chart-seg--${i % 6}`} />{s.label}</li>))}
				</ul>
			</div>
		) : null}
		<div className="credits-panels">
			<div className="card">
				<h2 className="card-title">By model · last 30 days</h2>
				<UsageBars rows={d?.breakdowns.byModel ?? []} unit="models" />
			</div>
			<div className="card">
				<h2 className="card-title">By project · last 30 days</h2>
				<UsageBars rows={d?.breakdowns.byProject ?? []} unit="projects" />
			</div>
		</div>
		<h2>Ledger</h2>
		{rows.length === 0 ? (
			<p className="muted">No ledger entries yet — credits appear here after a top-up or a metered request.</p>
		) : (
			<>
				<Table head={["When", "Type", "Description", "Amount", "Balance after"]} rows={rows.map((r) => [
					fmtDate(r.createdAt),
					<span key={r.id} className={CREDIT_BADGE[r.type] ?? "badge"}>{CREDIT_LABEL[r.type] ?? r.type}</span>,
					r.description ?? "—",
					<span className={BigInt(r.amountMicro) < 0n ? "credits-amount" : "credits-amount credits-amount--pos"}>{BigInt(r.amountMicro) < 0n ? "" : "+"}{fmtMicro(r.amountMicro)}</span>,
					fmtMicro(r.balanceAfterMicro),
				])} />
				<div className="row">
					<Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Prev</Button>
					<Button size="sm" variant="secondary" disabled={!d || page >= d.pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
					<span className="muted">page {d?.page ?? page} of {d?.pages ?? 1}</span>
				</div>
			</>
		)}
	</Page></ConsoleLayout>);
}

export function InvoicesPage() {
  const [tick, setTick] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const { data: d, error, loading } = useLoad<{ invoices: { id: string; number: string; status: string; amountMicro: string; periodStart: string; periodEnd: string }[] }>("/api/pages/dashboard/billing/invoices", tick);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return (<ConsoleLayout><Page title="Invoices" lede="Generate and settle.">
    <LoadState loading={loading} error={error} />
    <Button onClick={() => apiPost("/api/pages/dashboard/billing/invoices/generate", {}).then(refresh).catch((ex) => setErr(ex instanceof Error ? ex.message : "Generate failed"))}>Generate</Button>
    {err ? <p className="error">{err}</p> : null}
    <Table head={["Number", "Period", "Amount", "Status", ""]} rows={(d?.invoices ?? []).map((i) => [i.number, `${fmtDate(i.periodStart)} → ${fmtDate(i.periodEnd)}`, fmtMicro(i.amountMicro), i.status, <span key={i.id} className="row"><Button size="sm" variant="secondary" onClick={() => apiPost("/api/pages/dashboard/billing/invoices/markPaid", { id: i.id }).then(refresh).catch((ex) => setErr(ex instanceof Error ? ex.message : "Mark-paid failed"))}>Paid</Button><Button size="sm" variant="ghost" onClick={() => apiPost("/api/pages/dashboard/billing/invoices/void", { id: i.id }).then(refresh).catch((ex) => setErr(ex instanceof Error ? ex.message : "Void failed"))}>Void</Button></span>])} />
  </Page></ConsoleLayout>);
}

export function PayMethodsPage() {
  const [tick, setTick] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const { data: d, error, loading } = useLoad<{ intent: { method: string; contact: string; note: string; recordedAt: string } | null }>("/api/pages/dashboard/billing/payment-methods", tick);
  return (<ConsoleLayout><Page title="Payment methods" lede="Record how you intend to pay — an operator follows up offline.">
    <LoadState loading={loading} error={error} />
    {d?.intent ? <Card title={d.intent.method} desc={`${d.intent.contact} · ${d.intent.note}`} /> : <p className="muted">No billing intent recorded.</p>}
    <form onSubmit={(e) => {
      e.preventDefault(); setErr(null);
      const f = new FormData(e.currentTarget);
      apiPost("/api/pages/dashboard/billing/payment-methods/record", { method: String(f.get("method") ?? ""), contact: String(f.get("contact") ?? ""), note: String(f.get("note") ?? "") })
        .then(() => setTick((t) => t + 1))
        .catch((ex) => setErr(ex instanceof Error ? ex.message : "Record failed"));
    }}>
      <div className="row"><Input aria-label="Method" name="method" placeholder="Method" required /><Input aria-label="Contact" name="contact" placeholder="Contact" required /><Input aria-label="Note" name="note" placeholder="Note" /><Button type="submit">Record</Button></div>
    </form>
    {err ? <p className="error">{err}</p> : null}
  </Page></ConsoleLayout>);
}

export function AccountPage() {
  const [tick, setTick] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const { data: d, error, loading } = useLoad<{ account: { id: string; name: string; email: string; role: string | null } | null; timezone: string }>("/api/pages/dashboard/account", tick);
  return (<ConsoleLayout><Page title="Account" lede="Profile.">
    <LoadState loading={loading} error={error} />
    {d?.account ? <Card title={d.account.email} desc={`Role: ${d.account.role ?? "—"}`} /> : null}
    <form onSubmit={(e) => {
      e.preventDefault(); setErr(null); setOk(false);
      const f = new FormData(e.currentTarget);
      apiPost("/api/pages/dashboard/account/save", { name: String(f.get("name") ?? ""), timezone: String(f.get("timezone") ?? "") })
        .then(() => { setOk(true); setTick((t) => t + 1); })
        .catch((ex) => setErr(ex instanceof Error ? ex.message : "Save failed"));
    }}>
      <div className="row"><Input aria-label="Name" name="name" placeholder="Name" defaultValue={d?.account?.name ?? ""} /><Input aria-label="Timezone" name="timezone" placeholder="Timezone" defaultValue={d?.timezone ?? ""} /><Button type="submit">Save</Button></div>
    </form>
    {err ? <p className="error">{err}</p> : null}
    {ok ? <p className="muted">Saved.</p> : null}
  </Page></ConsoleLayout>);
}

export function WorkspacePage() {
  const [tick, setTick] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const { data: d, error, loading } = useLoad<{ workspace: { id: string; name: string; slug: string; status: string }; owner: { name: string; email: string } | null; projectCount: number; memberCount: number }>("/api/pages/dashboard/workspace", tick);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return (<ConsoleLayout><Page title="Workspace" lede={d?.workspace?.name ?? "Workspace settings."}>
    <LoadState loading={loading} error={error} />
    {d ? <Card title={d.workspace.slug} desc={`${d.projectCount} projects · ${d.memberCount} members · owner ${d.owner?.email ?? "—"}`} /> : null}
    <form onSubmit={(e) => {
      e.preventDefault(); setErr(null);
      const f = new FormData(e.currentTarget);
      apiPost("/api/pages/dashboard/workspace/rename", { name: String(f.get("name") ?? "") }).then(refresh).catch((ex) => setErr(ex instanceof Error ? ex.message : "Rename failed"));
    }}>
      <div className="row"><Input aria-label="Workspace name" name="name" placeholder="Workspace name" /><Button type="submit">Rename</Button></div>
    </form>
    <div className="row" style={{ flexWrap: "wrap" }}>
      <Button variant="secondary" onClick={() => apiPost("/api/pages/dashboard/workspace/archive", {}).then(refresh).catch((ex) => setErr(ex instanceof Error ? ex.message : "Archive failed"))}>Archive</Button>
      <Button variant="secondary" onClick={() => apiPost("/api/pages/dashboard/workspace/restore", {}).then(refresh).catch((ex) => setErr(ex instanceof Error ? ex.message : "Restore failed"))}>Restore</Button>
    </div>
    {err ? <p className="error">{err}</p> : null}
  </Page></ConsoleLayout>);
}

export function TeamMembersPage() {
  const [tick, setTick] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const { data: d, error, loading } = useLoad<{ members: { id: string; name: string; email: string; role: string; roleId: string; status: string }[]; roles: { id: string; name: string }[] }>("/api/pages/dashboard/team/members", tick);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return (<ConsoleLayout><Page title="Team members" lede="Invite and manage roles.">
    <LoadState loading={loading} error={error} />
    <form onSubmit={(e) => {
      e.preventDefault(); setErr(null); setInviteLink(null);
      const f = new FormData(e.currentTarget);
      apiPost<{ invited: string; invitedLink?: string }>("/api/pages/dashboard/team/members/invite", { email: String(f.get("email") ?? ""), roleId: String(f.get("roleId") ?? "") })
        .then((r) => { if (r.invitedLink) setInviteLink(r.invitedLink); (e.target as HTMLFormElement).reset(); refresh(); })
        .catch((ex) => setErr(ex instanceof Error ? ex.message : "Invite failed"));
    }}>
      <div className="row">
        <Input aria-label="Email" name="email" placeholder="Email" required />
        <select aria-label="Role for new member" name="roleId">{(d?.roles ?? []).map((r) => (<option key={r.id} value={r.id}>{r.name}</option>))}</select>
        <Button type="submit">Invite</Button>
      </div>
    </form>
    {inviteLink ? <Card title="Invite link — copy it now" desc={inviteLink} /> : null}
    {err ? <p className="error">{err}</p> : null}
    <Table head={["Name", "Email", "Role", "Status", "Actions"]} rows={(d?.members ?? []).map((m) => [m.name, m.email, m.role, m.status, <span key={m.id} className="row">
      <select aria-label={`Role for ${m.name}`} defaultValue={m.roleId} onChange={(e) => apiPost("/api/pages/dashboard/team/members/changeRole", { memberId: m.id, roleId: e.target.value }).then(refresh).catch((ex) => setErr(ex instanceof Error ? ex.message : "Role change failed"))}>
        {(d?.roles ?? []).map((r) => (<option key={r.id} value={r.id}>{r.name}</option>))}
      </select>
      <Button size="sm" variant="ghost" onClick={() => {
        const confirm = window.prompt(`Type the member's name "${m.name}" exactly to confirm removal`);
        if (confirm === null) return;
        apiPost("/api/pages/dashboard/team/members/remove", { memberId: m.id, confirm }).then(refresh).catch((ex) => setErr(ex instanceof Error ? ex.message : "Remove failed"));
      }}>Remove</Button>
    </span>])} />
  </Page></ConsoleLayout>);
}

export function TeamInvitesPage() {
  const [tick, setTick] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const { data: d, error, loading } = useLoad<{ invitations: { id: string; identifier: string; email: string; name: string; expiresAt: string }[] }>("/api/pages/dashboard/team/invitations", tick);
  return (<ConsoleLayout><Page title="Invitations" lede="Pending invites.">
    <LoadState loading={loading} error={error} />
    {err ? <p className="error">{err}</p> : null}
    <Table head={["Email", "Name", "Expires", ""]} rows={(d?.invitations ?? []).map((i) => [i.email, i.name, fmtDate(i.expiresAt), <Button key={i.id} size="sm" variant="ghost" onClick={() => apiPost("/api/pages/dashboard/team/invitations/revoke", { identifier: i.identifier }).then(() => setTick((t) => t + 1)).catch((ex) => setErr(ex instanceof Error ? ex.message : "Revoke failed"))}>Revoke</Button>])} />
  </Page></ConsoleLayout>);
}

export function TeamRolesPage() {
  const [tick, setTick] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const { data: d, error, loading } = useLoad<{ roles: { id: string; name: string; custom: boolean; permissions: string[]; memberCount: number }[] }>("/api/pages/dashboard/team/roles", tick);
  return (<ConsoleLayout><Page title="Roles" lede="Builtin and custom roles.">
    <LoadState loading={loading} error={error} />
    <form onSubmit={(e) => {
      e.preventDefault(); setErr(null);
      const f = new FormData(e.currentTarget);
      apiPost("/api/pages/dashboard/team/roles/create", { name: String(f.get("name") ?? "") })
        .then(() => { (e.target as HTMLFormElement).reset(); setTick((t) => t + 1); })
        .catch((ex) => setErr(ex instanceof Error ? ex.message : "Create failed"));
    }}>
      <div className="row"><Input aria-label="Role name" name="name" placeholder="Role name" required /><Button type="submit">Create</Button></div>
    </form>
    {err ? <p className="error">{err}</p> : null}
    <Table head={["Name", "Custom", "Permissions", "Members"]} rows={(d?.roles ?? []).map((r) => [r.name, r.custom ? "yes" : "builtin", String(r.permissions.length), String(r.memberCount)])} />
  </Page></ConsoleLayout>);
}

export function ProjectNewPage() {
  const [err, setErr] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);
  return (<ConsoleLayout><Page title="New project" lede="Create a project.">
    <form onSubmit={(e) => {
      e.preventDefault(); setErr(null);
      const f = new FormData(e.currentTarget);
      apiPost<{ id: string }>("/api/pages/dashboard/projects/create", { name: String(f.get("name") ?? ""), description: String(f.get("description") ?? "") })
        .then((r) => setCreatedId(r.id))
        .catch((ex) => setErr(ex instanceof Error ? ex.message : "Create failed"));
    }}>
      <div className="row"><Input aria-label="Project name" name="name" placeholder="Project name" required /><Input aria-label="Description" name="description" placeholder="Description" /><Button type="submit">Create</Button></div>
    </form>
    {err ? <p className="error">{err}</p> : null}
    {createdId ? <p><Link to={"/dashboard/projects/" + createdId}>Open project</Link></p> : null}
  </Page></ConsoleLayout>);
}

function Proj({ children }: { children: ReactNode }) {
  return (<ConsoleLayout>{children}</ConsoleLayout>);
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
      <div className="row"><Input aria-label="New name" name="name" placeholder="New name" /><Input aria-label="Slug" name="slug" placeholder="Slug" /><Input aria-label="Description" name="description" placeholder="Description" /><Input aria-label="Status" name="status" placeholder="Status" /><Button type="submit">Save</Button></div>
    </form>
    <Button variant="secondary" onClick={() => apiPost("/api/pages/projects/" + projectId + "/archive", {}).then(() => setTick((t) => t + 1)).catch((ex) => setErr(ex instanceof Error ? ex.message : "Archive failed"))}>Archive</Button>
    {err ? <p className="error">{err}</p> : null}
  </Page></Proj>);
}

function ProjectKeys({ projectId }: { projectId: string }) {
  const [tick, setTick] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [rotating, setRotating] = useState<{ id: string; name: string } | null>(null);
  const [rotated, setRotated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: d, error, loading } = useLoad<{ environments: { id: string; name: string }[]; keys: { id: string; name: string; prefix: string; status: string; environmentName: string | null; createdAt: string }[] }>(`/api/pages/projects/${projectId}/keys`, tick);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const flip = (k: { id: string; status: string }) => {
    setErr(null); setCreated(null);
    const enable = k.status !== "active";
    apiPost(`/api/pages/projects/${projectId}/keys/${k.id}/${enable ? "enable" : "disable"}`)
      .then(refresh)
      .catch((ex) => setErr(ex instanceof Error ? ex.message : `${enable ? "Enable" : "Disable"} failed`));
  };
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
        <Input aria-label="Key name" name="name" placeholder="Key name" required />
        <select aria-label="Environment for new key" name="environmentId">{(d?.environments ?? []).map((env) => (<option key={env.id} value={env.id}>{env.name}</option>))}</select>
        <Button type="submit">Create</Button>
      </div>
    </form>
    {created ? <Card title="New key — copy it now" desc={created} /> : null}
    {err ? <p className="error">{err}</p> : null}
    <Table head={["Name", "Prefix", "Status", "Env", "Created", ""]} rows={(d?.keys ?? []).map((k) => [k.name, k.prefix, k.status, k.environmentName ?? "—", fmtDate(k.createdAt), <span key={k.id} className="row">
      <Button size="sm" variant="secondary" onClick={() => flip(k)}>{k.status === "active" ? "Disable" : "Enable"}</Button>
      <Button size="sm" variant="ghost" onClick={() => { setErr(null); setRotated(null); setRotating({ id: k.id, name: k.name }); }}>Rotate</Button>
      <Button size="sm" variant="destructive" onClick={() => {
        setErr(null); setCreated(null);
        if (!window.confirm(`Revoke ${k.name}? Requests using it will immediately fail with 401, and this cannot be undone.`)) return;
        apiPost(`/api/pages/projects/${projectId}/keys/${k.id}/revoke`, { confirm: k.name })
          .then(refresh)
          .catch((ex) => setErr(ex instanceof Error ? ex.message : "Revoke failed"));
      }}>Revoke</Button>
    </span>])} />
    {rotating ? (<KeysDialog title={`Rotate ${rotating.name}`} onClose={() => setRotating(null)}>
      <p>The current secret stops working immediately and a new one is issued. Copy the new secret before closing — it is shown once.</p>
      {err ? <p className="error">{err}</p> : null}
      <div className="row">
        <Button variant="secondary" onClick={() => setRotating(null)}>Cancel</Button>
        <Button variant="primary" disabled={busy} onClick={() => {
          setErr(null); setBusy(true);
          apiPost<{ created: string }>(`/api/pages/projects/${projectId}/keys/${rotating.id}/rotate`, { confirm: rotating.name })
            .then((r) => { setRotated(r.created); refresh(); })
            .catch((ex) => setErr(ex instanceof Error ? ex.message : "Rotate failed"))
            .finally(() => setBusy(false));
        }}>{busy ? "Rotating…" : "Rotate"}</Button>
      </div>
    </KeysDialog>) : null}
    {rotated ? (<KeysDialog title="Key rotated" onClose={() => { setRotated(null); setRotating(null); }}>
      <p className="keys-warn">This is the only time you&apos;ll see this secret</p>
      <div className="keys-secret"><code>{rotated}</code></div>
      <div className="row">
        <Button variant="secondary" onClick={() => { navigator.clipboard?.writeText(rotated).catch(() => {}); }}>Copy</Button>
        <Button variant="primary" onClick={() => { setRotated(null); setRotating(null); }}>I&apos;ve saved it</Button>
      </div>
    </KeysDialog>) : null}
  </>);
}

type AliasTarget = { modelId: string; slug: string; status: string; developer: string | null; position: number };
type AliasRow = { id: string; name: string; description: string | null; enabled: boolean; scope: string; targets: AliasTarget[] };
type AliasModel = { id: string; slug: string; name: string; status: string; developer: string | null };
type AliasesData = { project: { id: string; name: string; slug: string }; aliases: AliasRow[]; models: AliasModel[] };

function ProjectAliases({ projectId }: { projectId: string }) {
  const [tick, setTick] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<AliasRow | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: d, error, loading } = useLoad<AliasesData>(`/api/pages/projects/${projectId}/aliases`, tick);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const aliases = d?.aliases ?? [];
  const models = d?.models ?? [];
  return (<>
    <LoadState loading={loading} error={error} />
    <div className="ps-note" role="note">
      <p>An alias is a stable name clients call instead of a model slug. Point it at a different model later and no client code changes.</p>
    </div>
    <form className="ps-form" onSubmit={(e) => {
      e.preventDefault(); setErr(null); setOk(null);
      const f = new FormData(e.currentTarget);
      const name = String(f.get("name") ?? "").trim();
      apiPost<{ created: string }>(`/api/pages/projects/${projectId}/aliases/create`, {
        name,
        scope: String(f.get("scope") ?? "project"),
        targets: f.getAll("targets").map((v) => String(v)),
        description: String(f.get("description") ?? "").trim() || undefined,
      })
        .then(() => { (e.target as HTMLFormElement).reset(); setOk(`Alias "${name}" created.`); refresh(); })
        .catch((ex) => setErr(ex instanceof Error ? ex.message : "Create failed"));
    }}>
      <label className="ps-field"><span>Alias name</span>
        <Input name="name" placeholder="e.g. fast" required />
      </label>
      <label className="ps-field"><span>Target models</span>
        <select className="select" name="targets" multiple size={6} required>
          {models.map((m) => (<option key={m.id} value={m.id}>{m.slug}{m.name && m.name !== m.slug ? ` — ${m.name}` : ""}</option>))}
        </select>
      </label>
      <label className="ps-field"><span>Scope</span>
        <select className="select" name="scope" defaultValue="project">
          <option value="project">This project</option>
          <option value="workspace">Whole workspace</option>
        </select>
      </label>
      <label className="ps-field"><span>Description</span>
        <Input name="description" placeholder="Optional" />
      </label>
      <div className="ps-form-actions">
        <Button type="submit" variant="primary">Create alias</Button>
      </div>
    </form>
    {err ? <p className="error">{err}</p> : null}
    {ok ? <p className="ps-ok" role="status">{ok}</p> : null}
    {!loading && !error && aliases.length === 0 ? (
      <div className="ps-empty">
        <p className="muted">No aliases yet. Rename <code>fast</code> → a real slug so clients don&apos;t break when you switch models.</p>
      </div>
    ) : null}
    {aliases.length > 0 ? (
      <Table head={["Alias", "Targets", "Scope", "Status", ""]} rows={aliases.map((a) => [
        <div key="n" className="ps-alias-name"><code>{a.name}</code>{a.description ? <span className="muted">— {a.description}</span> : null}</div>,
        <span key="t" className="ps-targets">{a.targets.length > 0 ? a.targets.map((t) => (<code key={t.modelId} className="ps-target">{t.slug}</code>)) : <span className="muted">no targets</span>}</span>,
        <Badge key="s" tone={a.scope === "project" ? "info" : a.scope === "workspace" ? "default" : "warn"}>{a.scope}</Badge>,
        <Badge key="e" tone={a.enabled ? "ok" : "warn"}>{a.enabled ? "enabled" : "disabled"}</Badge>,
        <Button key="d" size="sm" variant="secondary" disabled={a.scope === "global"} title={a.scope === "global" ? "Global aliases are read-only" : undefined} onClick={() => { setErr(null); setDeleting(a); }}>Delete</Button>,
      ])} />
    ) : null}
    {deleting ? (<KeysDialog title="Delete alias" onClose={() => setDeleting(null)}>
      <p>Delete <code className="keys-prefix">{deleting.name}</code>? Clients calling this alias will immediately fail with an unknown-model error, and this cannot be undone.</p>
      {err ? <p className="error">{err}</p> : null}
      <div className="row">
        <Button variant="secondary" onClick={() => setDeleting(null)}>Cancel</Button>
        <Button variant="destructive" disabled={busy} onClick={() => {
          setErr(null); setBusy(true);
          apiPost(`/api/pages/projects/${projectId}/aliases/delete`, { id: deleting.id })
            .then(() => { const gone = deleting.name; setDeleting(null); setOk(`Alias "${gone}" deleted.`); refresh(); })
            .catch((ex) => setErr(ex instanceof Error ? ex.message : "Delete failed"))
            .finally(() => setBusy(false));
        }}>{busy ? "Deleting…" : "Delete"}</Button>
      </div>
    </KeysDialog>) : null}
  </>);
}

type LimitValues = Record<string, string>;
type LimitEditor = { scope: string; scopeId: string; label: string; row: { id: string; values: LimitValues } | null };
type LimitChainRow = { metric: string; label: string; spend: boolean; effective: string | null; boundAt: string | null; boundAtLabel: string | null; byLevel: Record<string, string | null> };
type LimitsData = {
  queryError: string | null; projectId: string; projectName: string;
  labels: Record<string, string>; levelLabels: Record<string, string>;
  chain: LimitChainRow[]; editors: LimitEditor[];
  keyRows: { id: string; name: string; values: LimitValues }[];
};
const LIMIT_FIELDS = ["rpm", "tpm", "rpd", "tpd", "concurrency", "dailySpendMicro", "monthlySpendMicro"] as const;
const LIMIT_LEVELS = ["platform", "workspace", "project", "environment", "api_key"] as const;

// The limits endpoints speak decimal dollars ("12.50") while fmtMicro takes
// micros; convert at the edge so one formatter serves both spellings.
function fmtLimitMoney(v: string | null | undefined) {
  if (v === null || v === undefined || v === "") return "—";
  const micro = Math.round(Number(v) * 1_000_000);
  return Number.isFinite(micro) ? fmtMicro(String(micro)) : String(v);
}

function LimitEditorCard({ projectId, ed, labels, onSaved }: { projectId: string; ed: LimitEditor; labels: Record<string, string>; onSaved: () => void }) {
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const hasRow = ed.row !== null;
  return (
    <Card titleAs="h3" title={ed.label} className="ps-card" desc={hasRow ? "Override set — wins over the levels above it" : "No override — the effective value comes from the chain"}>
      <form className="ps-fields" onSubmit={(e) => {
        e.preventDefault(); setStatus(null); setBusy(true);
        const f = new FormData(e.currentTarget);
        const body: Record<string, string> = { scope: ed.scope, scopeId: ed.scopeId };
        for (const k of LIMIT_FIELDS) body[k] = String(f.get(k) ?? "").trim();
        apiPost(`/api/pages/projects/${projectId}/limits/save`, body)
          .then(() => { setStatus({ ok: true, msg: "Saved." }); onSaved(); })
          .catch((ex) => setStatus({ ok: false, msg: ex instanceof Error ? ex.message : "Save failed" }))
          .finally(() => setBusy(false));
      }}>
        {LIMIT_FIELDS.map((k) => (
          <label key={k} className="ps-field"><span>{labels[k] ?? k}</span>
            <Input name={k} inputMode="decimal" placeholder="inherit" defaultValue={ed.row?.values[k] ?? ""} />
          </label>
        ))}
        <div className="ps-card-actions">
          <Button type="submit" variant="primary" disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
          {hasRow ? <Button type="button" variant="ghost" disabled={busy} onClick={() => {
            setStatus(null); setBusy(true);
            apiPost(`/api/pages/projects/${projectId}/limits/remove`, { scope: ed.scope, scopeId: ed.scopeId })
              .then(() => { setStatus({ ok: true, msg: "Override cleared." }); onSaved(); })
              .catch((ex) => setStatus({ ok: false, msg: ex instanceof Error ? ex.message : "Clear failed" }))
              .finally(() => setBusy(false));
          }}>Clear override</Button> : null}
        </div>
        {status ? <p className={status.ok ? "ps-ok" : "error"} role="status">{status.msg}</p> : null}
      </form>
    </Card>
  );
}

function ProjectLimits({ projectId }: { projectId: string }) {
  const [tick, setTick] = useState(0);
  const { data: d, error, loading } = useLoad<LimitsData>(`/api/pages/projects/${projectId}/limits`, tick);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const labels = d?.labels ?? {};
  const levelLabels = d?.levelLabels ?? {};
  const chain = d?.chain ?? [];
  const editors = d?.editors ?? [];
  const keyRows = d?.keyRows ?? [];
  return (<>
    <LoadState loading={loading} error={error} />
    {d?.queryError ? <p className="error">{d.queryError}</p> : null}
    <div className="ps-note" role="note">
      <p>The router enforces the tightest value across the chain — platform, workspace, project, environment, then key. An override only ever lowers a limit.</p>
    </div>
    {chain.length > 0 ? (
      <Table head={["Metric", "Effective", "Bound at", ...LIMIT_LEVELS.map((l) => levelLabels[l] ?? l)]} rows={chain.map((c) => [
        c.label,
        <span key="e" className="num ps-effective">{c.spend ? fmtLimitMoney(c.effective) : c.effective ?? "—"}</span>,
        c.boundAtLabel ?? "—",
        ...LIMIT_LEVELS.map((l) => {
          const v = c.byLevel[l] ?? null;
          return <span key={l} className={l === c.boundAt ? "num ps-bound" : "num muted"}>{v == null || v === "" ? "—" : c.spend ? fmtLimitMoney(v) : v}</span>;
        }),
      ])} />
    ) : null}
    <h2>Overrides</h2>
    <div className="ps-cards">
      {editors.map((ed) => (<LimitEditorCard key={ed.scope + ed.scopeId + (ed.row?.id ?? "none")} projectId={projectId} ed={ed} labels={labels} onSaved={refresh} />))}
    </div>
    {keyRows.length > 0 ? (<>
      <h2>Per-key limits</h2>
      <Table head={["Key", ...LIMIT_FIELDS.map((k) => labels[k] ?? k)]} rows={keyRows.map((k) => [
        k.name,
        ...LIMIT_FIELDS.map((f) => {
          const v = k.values[f] ?? "";
          return <span key={f} className="num">{v === "" ? "—" : f === "dailySpendMicro" || f === "monthlySpendMicro" ? fmtLimitMoney(v) : v}</span>;
        }),
      ])} />
      <p className="muted">Per-key overrides are read-only here — the save endpoint accepts workspace, project and environment scopes only.</p>
    </>) : null}
  </>);
}

type BudgetRow = {
  id: string; scope: string; scopeLabel: string; period: string;
  amountMicro: string; warnPercent: number; criticalPercent: number; actionAt100: string;
  windowFrom: string; windowTo: string; consumedMicro: string; percent: number; state: string;
};
type BudgetsData = {
  denied: boolean; queryError: string | null; projectId: string; projectName: string;
  periods: string[]; actions: string[]; environments: { id: string; name: string }[]; budgets: BudgetRow[];
};
const BUDGET_TONE: Record<string, "ok" | "warn" | "danger"> = { ok: "ok", warn: "warn", critical: "danger", exceeded: "danger" };

// The save endpoint upserts on (scope, scope_id, period) and reads no id, so an
// edit is the same POST as a create with the row prefilled. It also means the
// payload must carry the scope_id, and the GET response only names the
// environment in scopeLabel — so environment budgets are create-only here rather
// than risk writing a same-named environment's row.
function ProjectBudgets({ projectId }: { projectId: string }) {
  const [tick, setTick] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [editing, setEditing] = useState<BudgetRow | null>(null);
  const [envScope, setEnvScope] = useState(false);
  const { data: d, error, loading } = useLoad<BudgetsData>(`/api/pages/projects/${projectId}/budgets`, tick);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const budgets = d?.budgets ?? [];
  const periods = d?.periods ?? [];
  const actions = d?.actions ?? [];
  const environments = d?.environments ?? [];
  const startEdit = (b: BudgetRow | null) => { setErr(null); setOk(null); setEditing(b); setEnvScope(false); };
  return (<>
    <LoadState loading={loading} error={error} />
    {d?.queryError ? <p className="error">{d.queryError}</p> : null}
    <div className="ps-note" role="note">
      <p>A budget caps spend over a window. Crossing the warning or critical percentage raises an alert; only <code>block</code> refuses the request once 100% is reached.</p>
    </div>
    <form key={editing?.id ?? "new"} className="ps-form" onSubmit={(e) => {
      e.preventDefault(); setErr(null); setOk(null);
      const f = new FormData(e.currentTarget);
      apiPost<{ saved: string }>(`/api/pages/projects/${projectId}/budgets/save`, {
        scope: envScope ? "environment" : "project",
        environmentId: envScope ? String(f.get("environmentId") ?? "") : undefined,
        period: String(f.get("period") ?? ""),
        amount: String(f.get("amount") ?? "").trim(),
        warnPercent: String(f.get("warnPercent") ?? "").trim(),
        criticalPercent: String(f.get("criticalPercent") ?? "").trim(),
        actionAt100: String(f.get("actionAt100") ?? "block"),
      })
        .then(() => { setOk(editing ? "Budget updated." : "Budget created."); startEdit(null); refresh(); })
        .catch((ex) => setErr(ex instanceof Error ? ex.message : "Save failed"));
    }}>
      <label className="ps-field"><span>Period</span>
        <select className="select" name="period" defaultValue={editing?.period ?? periods[0] ?? "monthly"}>
          {periods.map((p) => (<option key={p} value={p}>{p}</option>))}
        </select>
      </label>
      <label className="ps-field"><span>Amount ($)</span>
        <Input name="amount" inputMode="decimal" placeholder="25.00" defaultValue={editing ? microToInput(Number(editing.amountMicro)) : ""} required />
      </label>
      <label className="ps-field"><span>Warn at (%)</span>
        <Input name="warnPercent" inputMode="numeric" placeholder="70" defaultValue={editing ? String(editing.warnPercent) : ""} />
      </label>
      <label className="ps-field"><span>Critical at (%)</span>
        <Input name="criticalPercent" inputMode="numeric" placeholder="90" defaultValue={editing ? String(editing.criticalPercent) : ""} />
      </label>
      <label className="ps-field"><span>At 100%</span>
        <select className="select" name="actionAt100" defaultValue={editing?.actionAt100 ?? "block"}>
          {actions.map((a) => (<option key={a} value={a}>{a}</option>))}
        </select>
      </label>
      <label className="ps-field"><span>Scope</span>
        <select className="select" name="scope" value={envScope ? "environment" : "project"} onChange={(e) => setEnvScope(e.target.value === "environment")}>
          <option value="project">This project</option>
          <option value="environment">One environment</option>
        </select>
      </label>
      {envScope ? (
        <label className="ps-field"><span>Environment</span>
          <select className="select" name="environmentId" defaultValue="" required>
            {environments.map((en) => (<option key={en.id} value={en.id}>{en.name}</option>))}
          </select>
        </label>
      ) : null}
      <div className="ps-form-actions">
        <Button type="submit" variant="primary">{editing ? "Save budget" : "Create budget"}</Button>
        {editing ? <Button type="button" variant="ghost" onClick={() => startEdit(null)}>Cancel</Button> : null}
      </div>
    </form>
    {err ? <p className="error">{err}</p> : null}
    {ok ? <p className="ps-ok" role="status">{ok}</p> : null}
    {!loading && !error && budgets.length === 0 ? (
      <div className="ps-empty">
        <p className="muted">No budgets yet. Create one above so this project&apos;s spend is capped and you are told before it is.</p>
      </div>
    ) : null}
    {budgets.length > 0 ? (
      <Table head={["Scope", "Period", "Amount", "Used", "Used %", "State", "At 100%", "Warn / critical", ""]} rows={budgets.map((b) => [
        b.scopeLabel,
        b.period,
        fmtMicro(b.amountMicro),
        fmtMicro(b.consumedMicro),
        <span key="p" className="num">{b.percent}%</span>,
        <Badge key="s" tone={BUDGET_TONE[b.state] ?? "default"}>{b.state}</Badge>,
        b.actionAt100,
        `${b.warnPercent}% / ${b.criticalPercent}%`,
        <span key="a" className="row">
          {b.scope === "project" ? <Button size="sm" variant="secondary" onClick={() => startEdit(b)}>Edit</Button> : null}
          {b.scope === "workspace" ? <span className="muted">workspace</span> : (
            <Button size="sm" variant="ghost" onClick={() => {
              setErr(null); setOk(null);
              if (!window.confirm(`Delete the ${b.period} budget for ${b.scopeLabel}? Spend stops being capped and this cannot be undone.`)) return;
              apiPost(`/api/pages/projects/${projectId}/budgets/remove`, { id: b.id })
                .then(() => { setOk(`Budget for ${b.scopeLabel} deleted.`); refresh(); })
                .catch((ex) => setErr(ex instanceof Error ? ex.message : "Delete failed"));
            }}>Delete</Button>
          )}
        </span>,
      ])} />
    ) : null}
    {budgets.some((b) => b.scope !== "project") ? (
      <p className="muted">Environment and workspace budgets are read-only here — the save response does not name the scope they were written to, so an edit could land on the wrong row.</p>
    ) : null}
  </>);
}

type PolicyConstraints = {
  max_input_price_micro?: number; max_output_price_micro?: number; max_p95_latency_ms?: number;
  min_availability?: number; allowed_providers?: string[]; blocked_providers?: string[]; region_preference?: string;
};
type PolicyWeights = { price?: number; latency?: number; reliability?: number; capacity?: number };
type RoutingPolicy = {
  id: string; name: string; strategy: string; enabled: boolean;
  maxAttempts: number; requestTimeoutMs: number; fallbackEnabled: boolean;
  scope: string; providerPreferences: { order: string[] }; modelPreferences: { order: string[] };
  constraints: PolicyConstraints; weights: PolicyWeights; boundEnvironments: string[];
};
type RoutingData = {
  project: { id: string; name: string; slug: string };
  policies: RoutingPolicy[];
  bindings: { environmentId: string; environmentName: string; policyId: string | null; policyName: string | null }[];
  strategies: string[]; providers: { slug: string; name: string }[]; models: { slug: string; name: string }[];
};

function microToInput(v: number) {
  const n = BigInt(Math.trunc(v));
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

// parsePolicyFormBody treats an absent field as "reset to default", so an
// update must round-trip every field the policy already carries or the save
// silently drops it.
function policyBody(p: RoutingPolicy, over: { name?: string; strategy?: string; enabled?: boolean; maxAttempts?: number; requestTimeoutMs?: number; fallbackEnabled?: boolean }): Record<string, unknown> {
  const c = p.constraints;
  return {
    id: p.id,
    name: over.name ?? p.name,
    strategy: over.strategy ?? p.strategy,
    enabled: over.enabled ?? p.enabled,
    scope: p.scope,
    maxAttempts: over.maxAttempts ?? p.maxAttempts,
    requestTimeoutMs: over.requestTimeoutMs ?? p.requestTimeoutMs,
    fallbackEnabled: over.fallbackEnabled ?? p.fallbackEnabled,
    providerOrder: p.providerPreferences.order,
    modelOrder: p.modelPreferences.order,
    maxInputPriceMicro: c.max_input_price_micro == null ? "" : microToInput(c.max_input_price_micro),
    maxOutputPriceMicro: c.max_output_price_micro == null ? "" : microToInput(c.max_output_price_micro),
    maxP95LatencyMs: c.max_p95_latency_ms == null ? "" : String(c.max_p95_latency_ms),
    minAvailability: c.min_availability == null ? "" : String(c.min_availability),
    allowedProviders: c.allowed_providers ?? [],
    blockedProviders: c.blocked_providers ?? [],
    regionPreference: c.region_preference ?? "",
    weightPrice: p.weights.price ?? "", weightLatency: p.weights.latency ?? "",
    weightReliability: p.weights.reliability ?? "", weightCapacity: p.weights.capacity ?? "",
  };
}

function PolicyDialog({ projectId, policy, strategies, onClose, onSaved }: { projectId: string; policy: RoutingPolicy; strategies: string[]; onClose: () => void; onSaved: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (<KeysDialog title={`Edit ${policy.name}`} onClose={onClose}>
    <form className="ps-dialog-form" onSubmit={(e) => {
      e.preventDefault(); setErr(null); setBusy(true);
      const f = new FormData(e.currentTarget);
      apiPost(`/api/pages/projects/${projectId}/routing/update`, policyBody(policy, {
        name: String(f.get("name") ?? "").trim(),
        strategy: String(f.get("strategy") ?? policy.strategy),
        enabled: f.get("enabled") === "on",
        maxAttempts: Number(f.get("maxAttempts") ?? policy.maxAttempts),
        requestTimeoutMs: Number(f.get("requestTimeoutMs") ?? policy.requestTimeoutMs),
        fallbackEnabled: f.get("fallbackEnabled") === "on",
      }))
        .then(() => { onSaved(); onClose(); })
        .catch((ex) => setErr(ex instanceof Error ? ex.message : "Update failed"))
        .finally(() => setBusy(false));
    }}>
      <label className="ps-field"><span>Name</span><Input name="name" defaultValue={policy.name} required /></label>
      <label className="ps-field"><span>Strategy</span>
        <select className="select" name="strategy" defaultValue={policy.strategy}>
          {strategies.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </label>
      <label className="ps-field"><span>Max attempts (1–8)</span><Input name="maxAttempts" inputMode="numeric" defaultValue={String(policy.maxAttempts)} /></label>
      <label className="ps-field"><span>Request timeout (ms)</span><Input name="requestTimeoutMs" inputMode="numeric" defaultValue={String(policy.requestTimeoutMs)} /></label>
      <label className="ps-check"><input type="checkbox" name="enabled" defaultChecked={policy.enabled} /> Enabled</label>
      <label className="ps-check"><input type="checkbox" name="fallbackEnabled" defaultChecked={policy.fallbackEnabled} /> Fall back to the next candidate</label>
      <p className="muted">Scope: {policy.scope}. Provider and model order, constraints and weights are preserved as saved.</p>
      {err ? <p className="error">{err}</p> : null}
      <div className="row">
        <Button type="submit" variant="primary" disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
      </div>
    </form>
  </KeysDialog>);
}

function ProjectRouting({ projectId }: { projectId: string }) {
  const [tick, setTick] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [editing, setEditing] = useState<RoutingPolicy | null>(null);
  const [deleting, setDeleting] = useState<RoutingPolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: d, error, loading } = useLoad<RoutingData>(`/api/pages/projects/${projectId}/routing`, tick);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const policies = d?.policies ?? [];
  const strategies = d?.strategies ?? [];
  return (<>
    <LoadState loading={loading} error={error} />
    <form className="ps-form" onSubmit={(e) => {
      e.preventDefault(); setErr(null); setOk(null);
      const f = new FormData(e.currentTarget);
      apiPost<{ created: string }>(`/api/pages/projects/${projectId}/routing/create`, {
        name: String(f.get("name") ?? "").trim(),
        strategy: String(f.get("strategy") ?? "balanced"),
        scope: String(f.get("scope") ?? "project"),
        maxAttempts: Number(f.get("maxAttempts") ?? 2),
        requestTimeoutMs: Number(f.get("requestTimeoutMs") ?? 30000),
        fallbackEnabled: f.get("fallbackEnabled") === "on",
        enabled: f.get("enabled") === "on",
      })
        .then(() => { (e.target as HTMLFormElement).reset(); setOk("Policy created."); refresh(); })
        .catch((ex) => setErr(ex instanceof Error ? ex.message : "Create failed"));
    }}>
      <label className="ps-field"><span>Policy name</span>
        <Input name="name" placeholder="e.g. cost-first" required />
      </label>
      <label className="ps-field"><span>Strategy</span>
        <select className="select" name="strategy" defaultValue="balanced">
          {strategies.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </label>
      <label className="ps-field"><span>Scope</span>
        <select className="select" name="scope" defaultValue="project">
          <option value="project">This project</option>
          <option value="workspace">Whole workspace</option>
        </select>
      </label>
      <label className="ps-field"><span>Max attempts (1–8)</span><Input name="maxAttempts" inputMode="numeric" defaultValue="2" /></label>
      <label className="ps-field"><span>Request timeout (ms)</span><Input name="requestTimeoutMs" inputMode="numeric" defaultValue="30000" /></label>
      <label className="ps-check"><input type="checkbox" name="enabled" defaultChecked /> Enabled</label>
      <label className="ps-check"><input type="checkbox" name="fallbackEnabled" defaultChecked /> Fall back to the next candidate</label>
      <div className="ps-form-actions">
        <Button type="submit" variant="primary">Create policy</Button>
      </div>
    </form>
    {err ? <p className="error">{err}</p> : null}
    {ok ? <p className="ps-ok" role="status">{ok}</p> : null}
    {!loading && !error && policies.length === 0 ? (
      <div className="ps-empty">
        <p className="muted">No routing policies yet. Create one to choose how the router picks between candidates.</p>
      </div>
    ) : null}
    {policies.length > 0 ? (
      <Table head={["Name", "Strategy", "Enabled", "Scope", "Bound envs", ""]} rows={policies.map((p) => [
        <span key="n"><code>{p.name}</code></span>,
        p.strategy,
        <Badge key="e" tone={p.enabled ? "ok" : "warn"}>{p.enabled ? "enabled" : "disabled"}</Badge>,
        p.scope,
        p.boundEnvironments.join(", ") || "—",
        <span key="a" className="row">
          <Button size="sm" variant="secondary" onClick={() => { setErr(null); setEditing(p); }}>Edit</Button>
          <Button size="sm" variant="ghost" onClick={() => {
            setErr(null); setOk(null);
            apiPost(`/api/pages/projects/${projectId}/routing/update`, policyBody(p, { enabled: !p.enabled }))
              .then(() => { setOk(`${p.name} ${p.enabled ? "disabled" : "enabled"}.`); refresh(); })
              .catch((ex) => setErr(ex instanceof Error ? ex.message : "Update failed"));
          }}>{p.enabled ? "Disable" : "Enable"}</Button>
          <Button size="sm" variant="secondary" onClick={() => { setErr(null); setDeleting(p); }}>Delete</Button>
        </span>,
      ])} />
    ) : null}
    <h3>Environment bindings</h3>
    <Table head={["Environment", "Policy"]} rows={(d?.bindings ?? []).map((b) => [b.environmentName, b.policyName ?? "—"])} />
    {editing ? <PolicyDialog projectId={projectId} policy={editing} strategies={strategies} onClose={() => setEditing(null)} onSaved={refresh} /> : null}
    {deleting ? (<KeysDialog title="Delete policy" onClose={() => setDeleting(null)}>
      <p>Delete <code className="keys-prefix">{deleting.name}</code>? Environments bound to it fall back to the default routing behaviour. This cannot be undone.</p>
      {err ? <p className="error">{err}</p> : null}
      <div className="row">
        <Button variant="secondary" onClick={() => setDeleting(null)}>Cancel</Button>
        <Button variant="destructive" disabled={busy} onClick={() => {
          setErr(null); setBusy(true);
          apiPost(`/api/pages/projects/${projectId}/routing/delete`, { id: deleting.id })
            .then(() => { const gone = deleting.name; setDeleting(null); setOk(`Policy "${gone}" deleted.`); refresh(); })
            .catch((ex) => setErr(ex instanceof Error ? ex.message : "Delete failed"))
            .finally(() => setBusy(false));
        }}>{busy ? "Deleting…" : "Delete"}</Button>
      </div>
    </KeysDialog>) : null}
  </>);
}

type ReqRow = {
	id: string; createdAt: string; status: string; storedStatus: string; tone: "success" | "warning" | "neutral" | "danger";
	requestedModel: string | null; modelSlug: string | null; providerName: string | null;
	latencyMs: number; ttftMs: number | null; tokensIn: number; tokensOut: number; totalTokens: number;
	costMicro: string; currency: string; keyName: string | null; keyPrefix: string | null;
	clientIp: string | null; httpStatus: number | null; attempts: number; fallbackUsed: boolean;
};
type ReqOptions = { models: string[]; providers: { id: string; name: string | null }[]; keys: { id: string; name: string | null; prefix: string | null }[]; environments: { id: string; name: string | null }[]; endpoints: string[] };
type ReqData = { denied: boolean; queryError: string | null; projectId: string; projectName: string; filters: Record<string, string>; statuses: string[]; options: ReqOptions; rows: ReqRow[]; nextCursor: string | null; nextHref: string | null };
type ReqFilters = { from: string; to: string; status: string; model: string; provider: string; key: string; env: string; endpoint: string; requestId: string; minLatency: string; maxLatency: string; minCost: string; maxCost: string };
const EMPTY_REQ_FILTERS: ReqFilters = { from: "", to: "", status: "", model: "", provider: "", key: "", env: "", endpoint: "", requestId: "", minLatency: "", maxLatency: "", minCost: "", maxCost: "" };

// The endpoint reads minCost/maxCost as micro-dollar integers (BigInt), so the
// dollar inputs must be converted here — sending "0.05" would parse as null.
function dollarsToMicro(v: string): string | null {
	const s = v.trim();
	if (!/^\d+(\.\d{1,6})?$/.test(s)) return null;
	const [whole, frac = ""] = s.split(".");
	return (BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0"))).toString();
}

function reqQuery(f: ReqFilters, cursor: string | null): string {
	const q = new URLSearchParams();
	const put = (k: string, v: string) => { if (v.trim()) q.set(k, v.trim()); };
	put("from", f.from); put("to", f.to); put("status", f.status); put("model", f.model); put("provider", f.provider);
	put("key", f.key); put("env", f.env); put("endpoint", f.endpoint); put("requestId", f.requestId);
	put("minLatency", f.minLatency); put("maxLatency", f.maxLatency);
	const minMicro = dollarsToMicro(f.minCost); if (minMicro) q.set("minCost", minMicro);
	const maxMicro = dollarsToMicro(f.maxCost); if (maxMicro) q.set("maxCost", maxMicro);
	if (cursor) q.set("cursor", cursor);
	return q.toString();
}

const REQ_TONE_BADGE = { success: "ok", warning: "warn", neutral: "default", danger: "danger" } as const;

type ReqDetailAttempt = { id: string; attempt: number; providerName: string | null; providerId: string | null; connectionId: string | null; httpStatus: number | null; errorCode: string | null; retryable: boolean | null; latencyMs: number | null; ttftMs: number | null; providerCostMicro: string | null; reason: string | null; startedAt: string | null; finishedAt: string | null };
type ReqDetailRow = {
  id: string; createdAt: string | null; status: string; storedStatus: string; endpoint: string | null;
  projectName: string | null; environmentName: string | null; keyName: string | null; keyPrefix: string | null;
  requestedModel: string | null; resolvedSlug: string | null; providerName: string | null; providerId: string | null;
  strategy: string | null; tokensIn: number; tokensOut: number; totalTokens: number; costMicro: string;
  currency: string | null; providerCostMicro: string | null; ttftMs: number | null; latencyMs: number | null;
  attemptsCount: number | null; fallbackUsed: boolean | null; stream: boolean | null;
  error: string | null; errorCode: string | null; httpStatus: number | null;
};
type ReqDetailData = { denied: boolean; projectId: string; project: { id: string; name: string }; row: ReqDetailRow | null; attempts: ReqDetailAttempt[]; timing: { stage: string; ms: number }[]; content: { state: string; requestBody: string | null; responseBody: string | null } | null };

// The detail endpoint is a separate GET from the list, so the drawer owns its
// own load: a 404 or a 403 must surface inside the drawer rather than blank the
// table behind it.
function ProjectRequestDetail({ projectId, requestId, onClose }: { projectId: string; requestId: string; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const { data, error, loading } = useLoad<ReqDetailData>(`/api/pages/projects/${projectId}/requests/${requestId}`);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    box.current?.querySelector<HTMLElement>("button")?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const row = data?.row ?? null;
  const attempts = data?.attempts ?? [];
  const timing = data?.timing ?? [];
  const content = data?.content ?? null;
  return (<div className="usage-drawer-backdrop" onClick={onClose}>
    <div ref={box} className="usage-drawer usage-drawer--wide" role="dialog" aria-modal="true" aria-label="Request details" onClick={(e) => e.stopPropagation()}>
      <div className="row usage-drawer-head">
        <h3>Request</h3>
        <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
      </div>
      <p className="usage-drawer-id"><code>{requestId}</code>
        <Button size="sm" variant="secondary" onClick={() => { navigator.clipboard?.writeText(requestId).then(() => setCopied(true)).catch(() => {}); }}>{copied ? "Copied" : "Copy id"}</Button>
      </p>
      {loading ? <p className="muted" role="status" aria-live="polite">Loading…</p> : null}
      {error ? <p className="error" role="alert">{error}</p> : null}
      {!loading && !error && !row ? <p className="muted">This request is no longer in this project&apos;s log.</p> : null}
      {row ? (<>
        <dl className="usage-drawer-grid">
          <dt>Created</dt><dd>{fmtDate(row.createdAt)}</dd>
          <dt>Status</dt><dd>{row.status}{row.httpStatus == null ? "" : ` · HTTP ${row.httpStatus}`}</dd>
          <dt>Endpoint</dt><dd>{row.endpoint ?? "—"}</dd>
          <dt>Requested model</dt><dd>{row.requestedModel ?? "—"}</dd>
          <dt>Resolved model</dt><dd>{row.resolvedSlug ?? "—"}</dd>
          <dt>Provider</dt><dd>{row.providerName ?? "—"}</dd>
          <dt>Strategy</dt><dd>{row.strategy ?? "—"}</dd>
          <dt>Environment</dt><dd>{row.environmentName ?? "—"}</dd>
          <dt>API key</dt><dd>{row.keyName ? `${row.keyName}${row.keyPrefix ? ` (${row.keyPrefix})` : ""}` : "—"}</dd>
          <dt>Tokens in</dt><dd>{row.tokensIn}</dd>
          <dt>Tokens out</dt><dd>{row.tokensOut}</dd>
          <dt>Tokens total</dt><dd>{row.totalTokens}</dd>
          <dt>Cost</dt><dd>{fmtMicro(row.costMicro)} {row.currency ?? ""}</dd>
          <dt>Provider cost</dt><dd>{row.providerCostMicro == null ? "—" : fmtMicro(row.providerCostMicro)}</dd>
          <dt>Latency</dt><dd>{row.latencyMs == null ? "—" : `${row.latencyMs} ms`}</dd>
          <dt>TTFT</dt><dd>{row.ttftMs == null ? "—" : `${row.ttftMs} ms`}</dd>
          <dt>Attempts</dt><dd>{row.attemptsCount ?? attempts.length}{row.fallbackUsed ? " (fallback used)" : ""}</dd>
          <dt>Streamed</dt><dd>{row.stream == null ? "—" : row.stream ? "yes" : "no"}</dd>
          <dt>Error</dt><dd>{row.error ? `${row.errorCode ? `${row.errorCode}: ` : ""}${row.error}` : "—"}</dd>
        </dl>
        {timing.length > 0 ? (<>
          <h4>Timing</h4>
          <dl className="usage-drawer-grid">
            {timing.map((t) => (<div key={t.stage} style={{ display: "contents" }}>
              <dt>{t.stage}</dt><dd>{t.ms} ms</dd>
            </div>))}
          </dl>
        </>) : null}
        {attempts.length > 0 ? (<>
          <h4>Attempts</h4>
          <Table head={["#", "Provider", "HTTP", "Latency", "TTFT", "Reason"]} rows={attempts.map((a) => [
            String(a.attempt),
            a.providerName ?? "—",
            a.httpStatus == null ? "—" : String(a.httpStatus),
            a.latencyMs == null ? "—" : `${a.latencyMs} ms`,
            a.ttftMs == null ? "—" : `${a.ttftMs} ms`,
            a.reason ?? a.errorCode ?? "—",
          ])} />
        </>) : null}
        <h4>Bodies</h4>
        {content && content.state !== "hidden" && (content.requestBody || content.responseBody) ? (
          <dl className="usage-drawer-grid">
            <dt>Request</dt><dd><code>{content.requestBody}</code></dd>
            <dt>Response</dt><dd><code>{content.responseBody}</code></dd>
          </dl>
        ) : <p className="muted">Not retained</p>}
      </>) : null}
    </div>
  </div>);
}

function RequestDrawer({ row, onClose }: { row: ReqRow; onClose: () => void }) {
	const box = useRef<HTMLDivElement>(null);
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
		document.addEventListener("keydown", onKey);
		box.current?.querySelector<HTMLElement>("button")?.focus();
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);
	const fallback = row.requestedModel != null && row.modelSlug != null && row.requestedModel !== row.modelSlug;
	return (<div className="usage-drawer-backdrop" onClick={onClose}>
		<div ref={box} className="usage-drawer" role="dialog" aria-modal="true" aria-label="Request details" onClick={(e) => e.stopPropagation()}>
			<div className="row usage-drawer-head">
				<h3>Request</h3>
				<Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
			</div>
			<p className="usage-drawer-id"><code>{row.id}</code>
				<Button size="sm" variant="secondary" onClick={() => { navigator.clipboard?.writeText(row.id).then(() => setCopied(true)).catch(() => {}); }}>{copied ? "Copied" : "Copy id"}</Button>
			</p>
			<dl className="usage-drawer-grid">
				<dt>Created</dt><dd>{fmtDate(row.createdAt)}</dd>
				<dt>Status</dt><dd>{row.status}{row.httpStatus == null ? "" : ` · HTTP ${row.httpStatus}`}</dd>
				<dt>Requested model</dt><dd>{row.requestedModel ?? "—"}</dd>
				<dt>Served model</dt><dd className={fallback ? "pr-fallback" : undefined}>{row.modelSlug ?? "—"}{fallback ? " (fallback)" : ""}</dd>
				<dt>Provider</dt><dd>{row.providerName ?? "—"}</dd>
				<dt>API key</dt><dd>{row.keyName ? `${row.keyName}${row.keyPrefix ? ` (${row.keyPrefix})` : ""}` : "—"}</dd>
				<dt>Client IP</dt><dd>{row.clientIp ?? "—"}</dd>
				<dt>Tokens in</dt><dd>{row.tokensIn}</dd>
				<dt>Tokens out</dt><dd>{row.tokensOut}</dd>
				<dt>Tokens total</dt><dd>{row.totalTokens}</dd>
				<dt>Cost</dt><dd>{fmtMicro(row.costMicro)} {row.currency}</dd>
				<dt>Latency</dt><dd>{row.latencyMs} ms</dd>
				<dt>TTFT</dt><dd>{row.ttftMs == null ? "—" : `${row.ttftMs} ms`}</dd>
				<dt>Attempts</dt><dd>{row.attempts}{row.fallbackUsed ? " (fallback used)" : ""}</dd>
			</dl>
		</div>
	</div>);
}

function ProjectRequests({ projectId }: { projectId: string }) {
	const [draft, setDraft] = useState<ReqFilters>(EMPTY_REQ_FILTERS);
	const [applied, setApplied] = useState<ReqFilters>(EMPTY_REQ_FILTERS);
	// The cursor is forward-only, so Previous is a stack of cursors already
	// visited rather than an offset.
	const [stack, setStack] = useState<string[]>([]);
	const [open, setOpen] = useState<ReqRow | null>(null);
	const [detailId, setDetailId] = useState<string | null>(null);
	const query = reqQuery(applied, stack.length ? stack[stack.length - 1] : null);
	const { data: d, error, loading } = useLoad<ReqData>(`/api/pages/projects/${projectId}/requests?${query}`);
	const rows = d?.rows ?? [];
	const active = Object.values(applied).filter((v) => v.trim()).length;
	const set = (k: keyof ReqFilters, v: string) => setDraft((f) => ({ ...f, [k]: v }));
	const apply = () => { setApplied(draft); setStack([]); };
	const reset = () => { setDraft(EMPTY_REQ_FILTERS); setApplied(EMPTY_REQ_FILTERS); setStack([]); };
	const next = () => { if (d?.nextCursor) setStack((s) => [...s, d.nextCursor as string]); };
	const prev = () => setStack((s) => s.slice(0, -1));
	return (<>
		<LoadState loading={loading} error={error} />
		{d?.queryError ? <p className="error" role="alert">{d.queryError}</p> : null}
		<form className="ps-form pr-filters" onSubmit={(e) => { e.preventDefault(); apply(); }}>
			<label className="ps-field"><span>From</span><Input type="date" value={draft.from} onChange={(e) => set("from", e.target.value)} /></label>
			<label className="ps-field"><span>To</span><Input type="date" value={draft.to} onChange={(e) => set("to", e.target.value)} /></label>
			<label className="ps-field"><span>Status</span>
				<select className="select" value={draft.status} onChange={(e) => set("status", e.target.value)}>
					<option value="">All statuses</option>
					{(d?.statuses ?? []).map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
				</select>
			</label>
			<label className="ps-field"><span>Model</span>
				<select className="select" value={draft.model} onChange={(e) => set("model", e.target.value)}>
					<option value="">All models</option>
					{(d?.options.models ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
				</select>
			</label>
			<label className="ps-field"><span>Provider</span>
				<select className="select" value={draft.provider} onChange={(e) => set("provider", e.target.value)}>
					<option value="">All providers</option>
					{(d?.options.providers ?? []).map((p) => <option key={p.id} value={p.id}>{p.name ?? p.id}</option>)}
				</select>
			</label>
			<label className="ps-field"><span>API key</span>
				<select className="select" value={draft.key} onChange={(e) => set("key", e.target.value)}>
					<option value="">All keys</option>
					{(d?.options.keys ?? []).map((k) => <option key={k.id} value={k.id}>{k.name ?? k.id}{k.prefix ? ` (${k.prefix})` : ""}</option>)}
				</select>
			</label>
			<label className="ps-field"><span>Environment</span>
				<select className="select" value={draft.env} onChange={(e) => set("env", e.target.value)}>
					<option value="">All environments</option>
					{(d?.options.environments ?? []).map((e) => <option key={e.id} value={e.id}>{e.name ?? e.id}</option>)}
				</select>
			</label>
			<label className="ps-field"><span>Endpoint</span>
				<select className="select" value={draft.endpoint} onChange={(e) => set("endpoint", e.target.value)}>
					<option value="">All endpoints</option>
					{(d?.options.endpoints ?? []).map((e) => <option key={e} value={e}>{e}</option>)}
				</select>
			</label>
			<label className="ps-field"><span>Request ID</span><Input value={draft.requestId} placeholder="req_…" onChange={(e) => set("requestId", e.target.value)} /></label>
			<label className="ps-field"><span>Min latency (ms)</span><Input type="number" min="0" value={draft.minLatency} onChange={(e) => set("minLatency", e.target.value)} /></label>
			<label className="ps-field"><span>Max latency (ms)</span><Input type="number" min="0" value={draft.maxLatency} onChange={(e) => set("maxLatency", e.target.value)} /></label>
			<label className="ps-field"><span>Min cost ($)</span><Input value={draft.minCost} placeholder="0.00" onChange={(e) => set("minCost", e.target.value)} /></label>
			<label className="ps-field"><span>Max cost ($)</span><Input value={draft.maxCost} placeholder="0.00" onChange={(e) => set("maxCost", e.target.value)} /></label>
			<div className="ps-form-actions pr-actions">
				<Button type="submit" variant="primary">Apply</Button>
				<Button type="button" variant="ghost" onClick={reset}>Reset</Button>
				<span className="pr-count">{active === 0 ? "No filters" : `${active} filter${active === 1 ? "" : "s"} active`}</span>
			</div>
		</form>
		{!loading && !error && rows.length === 0 ? (
			active === 0 ? (
				<p className="muted">No requests yet — send one with an API key.</p>
			) : (
				<div className="ps-empty">
					<p className="muted">No requests match these filters</p>
					<Button size="sm" variant="secondary" onClick={reset}>Reset</Button>
				</div>
			)
		) : (
			<>
				<Table head={["Time", "Status", "Model", "Provider", "Tokens", "Cost", "Latency", "Attempts", ""]} rows={rows.map((r) => [
					<button key={r.id} type="button" className="usage-row-btn" onClick={() => setOpen(r)} aria-label={`Open details for request ${r.id}`}>{fmtDate(r.createdAt)}</button>,
					<Badge key="s" tone={REQ_TONE_BADGE[r.tone]}>{r.status.replace(/_/g, " ")}</Badge>,
					r.modelSlug ?? r.requestedModel ?? "—",
					r.providerName ?? "—",
					`${r.tokensIn} / ${r.tokensOut}`,
					fmtMicro(r.costMicro),
					<span key="l" className="pr-latency">{r.latencyMs} ms{r.fallbackUsed ? <Badge tone="warn">fallback</Badge> : null}</span>,
					String(r.attempts),
					<Button key="d" size="sm" variant="secondary" onClick={() => setDetailId(r.id)}>Details</Button>,
				])} />
				<div className="row pr-pager">
					<Button size="sm" variant="secondary" disabled={stack.length === 0} onClick={prev}>Previous</Button>
					<span className="muted">Page {stack.length + 1}</span>
					<Button size="sm" variant="secondary" disabled={!d?.nextCursor} onClick={next}>Next</Button>
				</div>
			</>
		)}
		{open ? <RequestDrawer row={open} onClose={() => setOpen(null)} /> : null}
		{detailId ? <ProjectRequestDetail projectId={projectId} requestId={detailId} onClose={() => setDetailId(null)} /> : null}
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
      <div className="row"><Input aria-label="Name" name="name" placeholder="Name" defaultValue={d?.project?.name ?? ""} /><Input aria-label="Slug" name="slug" placeholder="Slug" defaultValue={d?.project?.slug ?? ""} /><Input aria-label="Description" name="description" placeholder="Description" defaultValue={d?.project?.description ?? ""} /><Input aria-label="Status" name="status" placeholder="Status" defaultValue={d?.project?.status ?? ""} /><Button type="submit">Save</Button></div>
    </form>
    {err ? <p className="error">{err}</p> : null}
    {ok ? <p className="muted">Saved.</p> : null}
  </>);
}

type AlertConditionView = { type: string; threshold: number; windowSeconds: number; baselineRate: number | null };
type AlertView = { id: string; name: string; enabled: boolean; channel: string; condition: AlertConditionView; createdAt: string; updatedAt: string };
type AlertEventRow = { id: string; alertId: string; alertName: string; triggeredAt: string; value: string; message: string; state: string; resolvedAt: string | null; deliveredAt: string | null };
type AlertsData = { denied: boolean; queryError: string | null; projectId: string; projectName: string; conditionTypes: string[]; channels: string[]; alerts: AlertView[]; workspaceAlerts: AlertView[]; events: AlertEventRow[] };

// Threshold units per condition, mirroring the server's CONDITION_UNITS: the
// form's placeholder is the only place the user learns what number to type.
const ALERT_UNITS: Record<string, string> = {
  error_rate: "ratio 0–1 (0.05 = 5%)",
  latency: "milliseconds",
  budget_threshold: "micro-units",
  credit_threshold: "micro-units",
  fallback_rate: "ratio 0–1",
  provider_availability: "ratio 0–1",
  unusual_key_traffic: "ratio 0–1",
};

function ProjectAlerts({ projectId }: { projectId: string }) {
  const [tick, setTick] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<AlertView | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: d, error, loading } = useLoad<AlertsData>(`/api/pages/projects/${projectId}/alerts`, tick);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const alerts = d?.alerts ?? [];
  const workspaceAlerts = d?.workspaceAlerts ?? [];
  const events = d?.events ?? [];
  const conditionTypes = d?.conditionTypes ?? [];
  const channels = d?.channels ?? [];
  const toggle = (a: AlertView) => {
    setErr(null); setOk(null);
    apiPost(`/api/pages/projects/${projectId}/alerts/update`, {
      id: a.id, name: a.name, type: a.condition.type, threshold: String(a.condition.threshold),
      windowSeconds: a.condition.windowSeconds ? String(a.condition.windowSeconds) : "",
      baselineRate: a.condition.baselineRate === null ? "" : String(a.condition.baselineRate),
      channel: a.channel, enabled: !a.enabled,
    })
      .then(() => { setOk(`Alert "${a.name}" ${a.enabled ? "disabled" : "enabled"}.`); refresh(); })
      .catch((ex) => setErr(ex instanceof Error ? ex.message : "Update failed"));
  };
  return (<>
    <LoadState loading={loading} error={error} />
    {d?.queryError ? <p className="error" role="alert">{d.queryError}</p> : null}
    <div className="ps-note" role="note">
      <p>An alert watches one condition over a window and fires when the value crosses the threshold. <code>inapp</code> always fires (the events below are the surface); <code>email</code> and <code>webhook</code> fan out on top.</p>
    </div>
    <form className="ps-form" onSubmit={(e) => {
      e.preventDefault(); setErr(null); setOk(null);
      const f = new FormData(e.currentTarget);
      apiPost<{ saved: string }>(`/api/pages/projects/${projectId}/alerts/create`, {
        name: String(f.get("name") ?? "").trim(),
        type: String(f.get("type") ?? ""),
        threshold: String(f.get("threshold") ?? "").trim(),
        windowSeconds: String(f.get("windowSeconds") ?? "").trim(),
        baselineRate: String(f.get("baselineRate") ?? "").trim(),
        channel: String(f.get("channel") ?? "inapp"),
        enabled: f.get("enabled") !== null,
      })
        .then(() => { (e.target as HTMLFormElement).reset(); setOk("Alert created."); refresh(); })
        .catch((ex) => setErr(ex instanceof Error ? ex.message : "Create failed"));
    }}>
      <label className="ps-field"><span>Alert name</span>
        <Input name="name" placeholder="e.g. error spike" required />
      </label>
      <label className="ps-field"><span>Condition</span>
        <select className="select" name="type" defaultValue={conditionTypes[0] ?? "error_rate"}>
          {conditionTypes.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
        </select>
      </label>
      <label className="ps-field"><span>Threshold</span>
        <Input name="threshold" inputMode="decimal" placeholder={ALERT_UNITS[conditionTypes[0] ?? "error_rate"] ?? "value"} required />
      </label>
      <label className="ps-field"><span>Window (seconds)</span>
        <Input name="windowSeconds" inputMode="numeric" placeholder="300" />
      </label>
      <label className="ps-field"><span>Baseline rate</span>
        <Input name="baselineRate" inputMode="decimal" placeholder="optional" />
      </label>
      <label className="ps-field"><span>Channel</span>
        <select className="select" name="channel" defaultValue="inapp">
          {channels.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </label>
      <label className="ps-check"><input type="checkbox" name="enabled" defaultChecked /> Enabled</label>
      <div className="ps-form-actions">
        <Button type="submit" variant="primary">Create alert</Button>
      </div>
    </form>
    {err ? <p className="error">{err}</p> : null}
    {ok ? <p className="ps-ok" role="status">{ok}</p> : null}
    {!loading && !error && alerts.length === 0 ? (
      <div className="ps-empty">
        <p className="muted">No alerts yet. Create one above to be told when this project&apos;s error rate, latency or spend crosses a line.</p>
      </div>
    ) : null}
    {alerts.length > 0 ? (
      <Table head={["Name", "Condition", "Threshold", "Channel", "Status", "Last triggered", ""]} rows={alerts.map((a) => {
        const last = events.find((e) => e.alertId === a.id);
        return [
          a.name,
          a.condition.type.replace(/_/g, " "),
          `${a.condition.threshold}${a.condition.windowSeconds ? ` / ${a.condition.windowSeconds}s` : ""}`,
          a.channel,
          <Badge key="e" tone={a.enabled ? "ok" : "warn"}>{a.enabled ? "enabled" : "disabled"}</Badge>,
          last ? fmtDate(last.triggeredAt) : "—",
          <span key="a" className="row">
            <Button size="sm" variant="secondary" onClick={() => toggle(a)}>{a.enabled ? "Disable" : "Enable"}</Button>
            <Button size="sm" variant="ghost" onClick={() => { setErr(null); setDeleting(a); }}>Delete</Button>
          </span>,
        ];
      })} />
    ) : null}
    {workspaceAlerts.length > 0 ? (
      <>
        <h2>Workspace alerts</h2>
        <p className="muted">These watch the whole workspace, not just this project — edit them from the workspace page.</p>
        <Table head={["Name", "Condition", "Threshold", "Channel", "Status"]} rows={workspaceAlerts.map((a) => [
          a.name,
          a.condition.type.replace(/_/g, " "),
          `${a.condition.threshold}${a.condition.windowSeconds ? ` / ${a.condition.windowSeconds}s` : ""}`,
          a.channel,
          <Badge key="e" tone={a.enabled ? "ok" : "warn"}>{a.enabled ? "enabled" : "disabled"}</Badge>,
        ])} />
      </>
    ) : null}
    <h2>Recent events</h2>
    {!loading && !error && events.length === 0 ? (
      <div className="ps-empty">
        <p className="muted">No events yet — an alert that has never fired has nothing to show here.</p>
      </div>
    ) : (
      <Table head={["Triggered", "Alert", "State", "Value", "Message", "Delivered"]} rows={events.map((e) => [
        fmtDate(e.triggeredAt),
        e.alertName,
        <Badge key="s" tone={e.state === "firing" ? "danger" : "ok"}>{e.state}</Badge>,
        e.value,
        e.message || "—",
        fmtDate(e.deliveredAt),
      ])} />
    )}
    {deleting ? (<KeysDialog title="Delete alert" onClose={() => setDeleting(null)}>
      <p>Delete <code className="keys-prefix">{deleting.name}</code>? Its event history goes with it, and this cannot be undone.</p>
      {err ? <p className="error">{err}</p> : null}
      <div className="row">
        <Button variant="secondary" onClick={() => setDeleting(null)}>Cancel</Button>
        <Button variant="destructive" disabled={busy} onClick={() => {
          setErr(null); setBusy(true);
          apiPost(`/api/pages/projects/${projectId}/alerts/remove`, { id: deleting.id })
            .then(() => { const gone = deleting.name; setDeleting(null); setOk(`Alert "${gone}" deleted.`); refresh(); })
            .catch((ex) => setErr(ex instanceof Error ? ex.message : "Delete failed"))
            .finally(() => setBusy(false));
        }}>{busy ? "Deleting…" : "Delete"}</Button>
      </div>
    </KeysDialog>) : null}
  </>);
}

export function ProjectSubPage({ name }: { name: string }) {
  const { projectId } = useParams();
  const pid = projectId ?? "";
  return (<Proj><Page title={name} lede={"Project " + pid + " / " + name}>
    {name === "keys" ? <ProjectKeys projectId={pid} />
      : name === "aliases" ? <ProjectAliases projectId={pid} />
      : name === "limits" ? <ProjectLimits projectId={pid} />
      : name === "budgets" ? <ProjectBudgets projectId={pid} />
      : name === "routing" ? <ProjectRouting projectId={pid} />
      : name === "requests" ? <ProjectRequests projectId={pid} />
      : name === "alerts" ? <ProjectAlerts projectId={pid} />
      : name === "settings" ? <ProjectSettings projectId={pid} />
      : <p className="muted">Unknown section.</p>}
  </Page></Proj>);
}
export function InvitePage() {
  const { token } = useParams();
  const [inviteErr, setInviteErr] = useState<string | null>(null);
  return (<Page title="Invitation" lede="Accept or decline.">
    {inviteErr ? <p className="error" role="alert">{inviteErr}</p> : null}
    <div className="row">
      <Button onClick={() => apiPost("/api/invite/" + token + "/accept", {}).then(() => (location.href = "/dashboard")).catch((ex) => setInviteErr(ex instanceof Error ? ex.message : "Accept failed"))}>Accept</Button>
      <Button variant="secondary" onClick={() => apiPost("/api/invite/" + token + "/decline", {}).then(() => (location.href = "/")).catch((ex) => setInviteErr(ex instanceof Error ? ex.message : "Decline failed"))}>Decline</Button>
    </div>
  </Page>);
}
