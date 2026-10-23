import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { apiGet, apiPost } from "../lib/server";
import { ConsoleLayout } from "../components/ConsoleLayout";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Table } from "../components/ui/table";
import { StatCard, pctDelta } from "../components/stat-card";
import { fmtMicro } from "../lib/money";
import "./dashboard.css";

// `actions` is the page-level toolbar (the range selector). It used to be a
// bare row wedged between the KPI cards and the first section heading, which
// left it floating under the cards and reading as if it belonged to the first
// card only -- and it controls every figure on the page.
function Page({ title, lede, actions, children }: { title: string; lede: string; actions?: ReactNode; children?: ReactNode }) {
  return (<div className="stack">
    <div className="dash-head">
      <div className="dash-head-text"><h1>{title}</h1><p className="lede muted">{lede}</p></div>
      {actions ? <div className="row dash-head-actions">{actions}</div> : null}
    </div>
    {children}
  </div>);
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
// Micro-dollars are formatted by lib/money.ts: the console and the dashboard
// used to disagree about the same ledger ("$102055.00" vs "$102,054.94").

type SeriesPoint = { day: string; requests: number; tokens: number; cost: string; errors: number; tokensIn: number; tokensOut: number };
type FiringAlert = { id: string; alertId: string; alertName: string; conditionType: string; value: string; message: string; triggeredAt: string | null };
type DashboardData = { userId: string; totals: { requests: number; tokensIn: number; tokensOut: number; cost: string }; activeKeys: number; recent: { id: string; createdAt: string; model_slug: string | null; providerName: string | null; tokens_in: number; tokens_out: number; cost: string; latency_ms: number; status: string }[]; series: SeriesPoint[]; byModel: { slug: string; requests: number; cost: string }[]; range: number; accountCreatedAt: string | null; balanceMicro: string; firingAlerts: FiringAlert[] };

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

// Onboarding checklist (spec §19 item 7). Shown only while the account is
// under a week old AND has no key yet — once a key exists the user has
// already done the work the banner asks for, so it stops nagging. Two steps
// only: sign-up provisions the account, so an account step would be green on
// the first render and could never change state before the banner hides.
// Dismissal is per-account in localStorage keyed by the user id.
const ONBOARDING_KEY = "fudrouter.onboarding.dismissed";
const ONBOARDING_MAX_AGE_MS = 7 * 86_400_000;
function OnboardingBanner({ d }: { d: DashboardData }) {
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    try { setDismissed(localStorage.getItem(`${ONBOARDING_KEY}:${d.userId}`) === "1"); } catch { setDismissed(false); }
  }, [d.userId]);
  const createdAt = d.accountCreatedAt ? new Date(d.accountCreatedAt).getTime() : NaN;
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
        try { localStorage.setItem(`${ONBOARDING_KEY}:${d.userId}`, "1"); } catch { /* private mode: the banner returns next visit */ }
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
  const rangePicker = [7, 30, 90].map((n) => (
    <Button key={n} size="sm" variant={d?.range === n ? "primary" : "secondary"} onClick={() => setRange(n)}>{n}d</Button>
  ));
  return (<ConsoleLayout><Page title="Dashboard" lede="Usage, keys, and spend at a glance." actions={d ? rangePicker : null}>
    <LoadState loading={loading} error={error} />
    {d ? (<>
      <OnboardingBanner d={d} />
      <div className="row row--cards" style={{ flexWrap: "wrap" }}>
        <StatCard title="Requests today" value={String(today?.requests ?? 0)} delta={today && yesterday ? pctDelta(today.requests, yesterday.requests) : undefined} spark={series.map((s) => s.requests)} />
        <StatCard title="Tokens today" value={fmtCompact(today ? today.tokensIn + today.tokensOut : 0)} delta={today && yesterday ? pctDelta(today.tokensIn + today.tokensOut, yesterday.tokensIn + yesterday.tokensOut) : undefined} spark={series.map((s) => s.tokensIn + s.tokensOut)} />
        <StatCard title="Errors today" value={String(today?.errors ?? 0)}>
          <p className={`stat-sub num ${today && today.requests > 0 ? (today.errors / today.requests < 0.01 ? "stat-rate--ok" : today.errors / today.requests <= 0.05 ? "stat-rate--warn" : "stat-rate--bad") : ""}`}>{today && today.requests > 0 ? `${((today.errors / today.requests) * 100).toFixed(1)}% error rate` : "no requests"}</p>
        </StatCard>
        <StatCard title="Credit balance" value={fmtMicro(d.balanceMicro)}>
          <Link to="/dashboard/billing/credits">Manage credits</Link>
        </StatCard>
      </div>
      {/* Live conditions, not a checklist: no dismiss. Alerts are
          account-scoped, so each one links to the account alerts page. */}
      {d.firingAlerts.length > 0 ? (
        <Card titleAs="h2" title="Alerts">
          <ul className="alert-list">
            {d.firingAlerts.map((a) => (<li key={a.id} className="alert-row">
              <Badge tone="warn">{a.conditionType.replace(/_/g, " ")}</Badge>
              <span className="alert-name">{a.alertName}</span>
              <span className="num">{a.value}</span>
              <span className="muted">{fmtDate(a.triggeredAt)}</span>
              <Link to="/dashboard/alerts">View</Link>
            </li>))}
          </ul>
        </Card>
      ) : null}
      {empty ? (
        <Card titleAs="h2" title="No traffic yet" desc="Mint a key and send a request.">
          <Link to="/dashboard/keys">Go to keys</Link>
        </Card>
      ) : (<>
        <h2 className="dash-h">Tokens</h2>
        <div className="dash-panels">
          <Card titleAs="h3" title="Input vs output tokens" className="dash-chart-card"><TokenChart series={series} /></Card>
          <Card titleAs="h3" title="Top models" className="dash-models-card">
            <ul className="dash-models">
              {(d.byModel ?? []).map((m) => (
                <li key={m.slug}>
                  <span className="dash-model-slug" title={m.slug}>{m.slug}</span>
                  <span className="num dash-model-reqs">{m.requests}</span>
                  <span className="num dash-model-cost">{fmtMicro(m.cost)}</span>
                  <span className="dash-model-bar" aria-hidden="true"><span style={{ width: `${topModel && topModel.requests > 0 ? Math.round((m.requests / topModel.requests) * 100) : 0}%` }} /></span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
        <h2 className="dash-h">Recent requests</h2>
        {d.recent.length > 0 ? (<>
          <Table head={["Time", "Model", "Provider", "Tokens", "Cost", "Status", "Latency"]} numeric={[3, 4, 6]} rows={d.recent.map((r) => [
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
  </Page></ConsoleLayout>);
}

type KeyUsage = { requests: number; tokens: number; costMicro: string };
type KeyRow = {
  id: string; name: string; prefix: string; status: string;
  lastUsedAt: string | null; revokedAt: string | null; createdAt: string | null; expiresAt: string | null;
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
// the stored status. A disabled key surfaces as Disabled so it never reads as
// Active.
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
  const [copied, setCopied] = useState(false);
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
      apiPost<{ created: string; name: string }>("/api/pages/dashboard/keys/create", { name: String(f.get("name") ?? ""), expiresIn: String(f.get("expiresIn") ?? "never") })
        .then((r) => { setSecret({ key: r.created, name: r.name }); onCreated(); })
        .catch((ex) => setErr(ex instanceof Error ? ex.message : "Create failed"))
        .finally(() => setBusy(false));
    }}>
      <label className="keys-field"><span>Name</span>
        <Input name="name" placeholder="e.g. production-backend" required />
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
      <p className="lede muted">Create and revoke the keys your apps authenticate with.</p>
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
        <Table head={["Name", "Key", "Created", "Last used", "Requests (30d)", "Status", ""]} numeric={[4]} rows={keys.map((k) => {
          const st = keyStatus(k);
          return [
            <div key="name" className="keys-name">{k.name}</div>,
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
        <Table head={["Key", "Requests 30d", "Tokens 30d", "Cost 30d"]} numeric={[1, 2, 3]} rows={byUsage.map((k) => [
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
	breakdowns: { byDay: { day: string; requests: number; totalTokens: number; costMicro: string }[]; byApiKey: UsageBreakdownRow[]; byModel: UsageBreakdownRow[]; byProvider: UsageBreakdownRow[] };
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
			<Table head={["Time", "Model", "Provider", "Tokens in/out", "Cost", "Latency", "Status"]} numeric={[3, 4, 5]} rows={(log?.rows ?? []).map((r) => [
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
  const { data: d, error, loading } = useLoad<{ currency: string; status: string; canWrite: boolean; balanceMicro: string; warningThresholdMicro: string; hardStopThresholdMicro: string; period: { start: string; end: string; spentMicro: string; requests: number } }>("/api/pages/dashboard/billing", tick);
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
	breakdowns: { byModel: UsageBreakdownRow[] };
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
		</div>
		<h2>Ledger</h2>
		{rows.length === 0 ? (
			<p className="muted">No ledger entries yet — credits appear here after a top-up or a metered request.</p>
		) : (
			<>
				<Table head={["When", "Type", "Description", "Amount", "Balance after"]} numeric={[3, 4]} rows={rows.map((r) => [
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

// ---- account capability surfaces (limits, budgets, aliases, routing, alerts) ----
//
// Migration 0019 made the user account the tenant, so these five were project
// sub-pages and are now their own console routes pointed at the
// account-scoped /api/pages/* endpoints. The tables and form grids are the
// same .ps-* idioms the project pages used: only the scope vocabulary moved
// from {workspace,project,environment} to {account,api_key}.

type LimitValues = { rpm: string; tpm: string; rpd: string; tpd: string; concurrency: string; dailySpendMicro: string; monthlySpendMicro: string };
const LIMIT_FIELDS = [
  { key: "rpm", label: "Requests / min" },
  { key: "tpm", label: "Tokens / min" },
  { key: "rpd", label: "Requests / day" },
  { key: "tpd", label: "Tokens / day" },
  { key: "concurrency", label: "Concurrency" },
  { key: "dailySpendMicro", label: "Daily spend ($)" },
  { key: "monthlySpendMicro", label: "Monthly spend ($)" },
] as const;
type LimitChainRow = { metric: string; label: string; effective: string | null; boundAtLabel: string | null; byLevel: Record<string, string | null> };
type LimitEditor = { scope: string; scopeId: string; label: string; row: { id: string; values: LimitValues } | null };
type LimitsData = {
  queryError: string | null; labels: Record<string, string>; levelLabels: Record<string, string>;
  chain: LimitChainRow[]; editors: LimitEditor[];
  keyRows: { id: string; name: string; values: LimitValues }[];
};

// The server already renders spend metrics in dollars (microsToInput), so a
// spend column is only labelled differently — no second conversion here.

function LimitEditorCard({ ed, onSaved }: { ed: LimitEditor; onSaved: () => void }) {
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);
  return (<Card title={ed.label} className="ps-card">
    <form className="ps-form" onSubmit={(e) => {
      e.preventDefault(); setStatus(null); setBusy(true);
      const f = new FormData(e.currentTarget);
      const body: Record<string, string> = { scope: ed.scope, scopeId: ed.scopeId };
      for (const field of LIMIT_FIELDS) body[field.key] = String(f.get(field.key) ?? "").trim();
      apiPost(`/api/pages/limits/save`, body)
        .then(() => { setStatus({ ok: true, msg: "Saved." }); onSaved(); })
        .catch((ex) => setStatus({ ok: false, msg: ex instanceof Error ? ex.message : "Save failed" }))
        .finally(() => setBusy(false));
    }}>
      <div className="ps-fields">
        {LIMIT_FIELDS.map((field) => (<label key={field.key} className="ps-field"><span>{field.label}</span><Input name={field.key} inputMode="decimal" defaultValue={ed.row?.values[field.key] ?? ""} /></label>))}
      </div>
      <div className="ps-card-actions">
        <Button type="submit" variant="primary" disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
        {ed.row ? (
          <Button type="button" variant="ghost" disabled={busy} onClick={() => {
            setStatus(null); setBusy(true);
            apiPost(`/api/pages/limits/remove`, { scope: ed.scope, scopeId: ed.scopeId })
              .then(() => { setStatus({ ok: true, msg: "Override cleared." }); onSaved(); })
              .catch((ex) => setStatus({ ok: false, msg: ex instanceof Error ? ex.message : "Clear failed" }))
              .finally(() => setBusy(false));
          }}>Clear override</Button>
        ) : null}
        {status ? <p className={status.ok ? "ps-ok" : "error"}>{status.msg}</p> : null}
      </div>
    </form>
  </Card>);
}

export function LimitsPage() {
  const [tick, setTick] = useState(0);
  const { data: d, error, loading } = useLoad<LimitsData>("/api/pages/limits", tick);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const chain = d?.chain ?? [];
  const editors = d?.editors ?? [];
  const keyRows = d?.keyRows ?? [];
  const levelKeys = Object.keys(d?.levelLabels ?? {});
  return (<ConsoleLayout><Page title="Limits" lede="Rate and spend limits for your account and keys.">
    <LoadState loading={loading} error={error} />
    <div className="ps-note" role="note">
      <p>The router enforces the tightest value across the chain — platform, then account, then key. An override only ever lowers a limit.</p>
    </div>
    {d?.queryError ? <p className="error">{d.queryError}</p> : null}
    {chain.length > 0 ? (
      <Table head={["Metric", "Effective", "Bound at", ...levelKeys.map((l) => d?.levelLabels[l] ?? l)]} rows={chain.map((c) => {
        const spend = c.metric === "dailySpendMicro" || c.metric === "monthlySpendMicro";
        return [
          c.label,
          <span key="e" className="ps-effective">{c.effective === null ? "no limit" : spend ? `$${c.effective}` : c.effective}</span>,
          <span key="b" className="ps-bound">{c.boundAtLabel ?? "—"}</span>,
          ...levelKeys.map((l) => <span key={l}>{c.byLevel[l] == null ? "—" : spend ? `$${c.byLevel[l]}` : c.byLevel[l]}</span>),
        ];
      })} />
    ) : null}
    <div className="ps-cards">
      {editors.map((ed) => (<LimitEditorCard key={ed.scope + ed.scopeId} ed={ed} onSaved={refresh} />))}
    </div>
    {keyRows.length > 0 ? (<>
      <h2>Per-key limits</h2>
      <Table head={["Key", ...LIMIT_FIELDS.map((f) => f.label)]} rows={keyRows.map((k) => [
        k.name,
        ...LIMIT_FIELDS.map((f) => <span key={f.key}>{k.values[f.key] === "" ? "—" : f.key === "dailySpendMicro" || f.key === "monthlySpendMicro" ? `$${k.values[f.key]}` : k.values[f.key]}</span>),
      ])} />
      <p className="muted">Per-key overrides are read-only on this page; the account card above is what it writes.</p>
    </>) : null}
  </Page></ConsoleLayout>);
}

type BudgetRow = { id: string; scope: string; scopeLabel: string; period: string; amountMicro: string; warnPercent: number; criticalPercent: number; actionAt100: string; consumedMicro: string; percent: number; state: string };
type BudgetsData = { denied: boolean; queryError: string | null; periods: string[]; actions: string[]; budgets: BudgetRow[] };
type KeyOption = { id: string; name: string };
const BUDGET_TONE: Record<string, "ok" | "warn" | "danger"> = { ok: "ok", warn: "warn", critical: "danger", exceeded: "danger" };

export function BudgetsPage() {
  const [tick, setTick] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [editing, setEditing] = useState<BudgetRow | null>(null);
  const [scope, setScope] = useState("account");
  const { data: d, error, loading } = useLoad<BudgetsData>("/api/pages/budgets", tick);
  const { data: keyData } = useLoad<{ keys: KeyOption[] }>("/api/pages/keys");
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const budgets = d?.budgets ?? [];
  const periods = d?.periods ?? [];
  const actions = d?.actions ?? [];
  const keys = keyData?.keys ?? [];
  const startEdit = (b: BudgetRow | null) => { setErr(null); setOk(null); setEditing(b); setScope("account"); };
  return (<ConsoleLayout><Page title="Budgets" lede="Spend caps per period for the account and its keys.">
    <LoadState loading={loading} error={error} />
    {err ? <p className="error">{err}</p> : null}
    {ok ? <p className="ps-ok">{ok}</p> : null}
    <form className="ps-form" onSubmit={(e) => {
      e.preventDefault(); setErr(null); setOk(null);
      const f = new FormData(e.currentTarget);
      apiPost<{ saved: string }>("/api/pages/budgets/save", {
        scope,
        scopeId: scope === "api_key" ? String(f.get("scopeId") ?? "") : undefined,
        period: String(f.get("period") ?? ""),
        amount: String(f.get("amount") ?? "").trim(),
        warnPercent: String(f.get("warnPercent") ?? "").trim(),
        criticalPercent: String(f.get("criticalPercent") ?? "").trim(),
        actionAt100: String(f.get("actionAt100") ?? ""),
      })
        .then(() => { setOk(editing ? "Budget updated." : "Budget saved."); setEditing(null); (e.target as HTMLFormElement).reset(); refresh(); })
        .catch((ex) => setErr(ex instanceof Error ? ex.message : "Save failed"));
    }}>
      <label className="ps-field"><span>Scope</span>
        <select className="select" name="scope" value={scope} disabled={editing !== null} onChange={(e) => setScope(e.target.value)}>
          <option value="account">Account (all keys)</option>
          <option value="api_key">One API key</option>
        </select>
      </label>
      {scope === "api_key" ? (
        <label className="ps-field"><span>API key</span>
          <select className="select" name="scopeId" defaultValue="" required>
            <option value="">Pick a key</option>
            {keys.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
          </select>
        </label>
      ) : null}
      <label className="ps-field"><span>Period</span>
        <select className="select" name="period" defaultValue={editing?.period ?? periods[0] ?? "monthly"}>
          {periods.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </label>
      <label className="ps-field"><span>Amount ($)</span><Input name="amount" inputMode="decimal" required defaultValue={editing ? (Number(BigInt(editing.amountMicro)) / 1_000_000).toFixed(2) : ""} /></label>
      <label className="ps-field"><span>Warn at (%)</span><Input name="warnPercent" inputMode="numeric" defaultValue={editing ? String(editing.warnPercent) : "70"} /></label>
      <label className="ps-field"><span>Critical at (%)</span><Input name="criticalPercent" inputMode="numeric" defaultValue={editing ? String(editing.criticalPercent) : "90"} /></label>
      <label className="ps-field"><span>At 100%</span>
        <select className="select" name="actionAt100" defaultValue={editing?.actionAt100 ?? "block"}>
          {actions.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </label>
      <div className="ps-form-actions pr-actions">
        <Button type="submit" variant="primary">{editing ? "Save budget" : "Add budget"}</Button>
        {editing ? <Button type="button" variant="ghost" onClick={() => startEdit(null)}>Cancel</Button> : null}
      </div>
    </form>
    {!loading && !error && budgets.length === 0 ? (
      <div className="ps-empty"><p className="muted">No budgets yet. Create one above so this account&apos;s spend is capped and you are told before it is.</p></div>
    ) : null}
    {budgets.length > 0 ? (
      <Table head={["Scope", "Period", "Amount", "Consumed", "State", "Actions"]} rows={budgets.map((b) => [
        b.scopeLabel,
        b.period,
        <span key="a" className="num">{fmtMicro(b.amountMicro)}</span>,
        <span key="c" className="row">
          <span className="usage-bar-track" style={{ width: "6rem" }}><span className="usage-bar-fill" style={{ width: `${Math.min(Math.max(b.percent, 0), 100)}%` }} /></span>
          <span className="num">{b.percent}%</span>
        </span>,
        <Badge key="s" tone={BUDGET_TONE[b.state] ?? "default"}>{b.state}</Badge>,
        <span key="x" className="row">
          {b.scope === "account" ? <Button size="sm" variant="secondary" onClick={() => startEdit(b)}>Edit</Button> : null}
          <Button size="sm" variant="ghost" onClick={() => {
            setErr(null); setOk(null);
            if (!window.confirm(`Delete the ${b.period} budget for ${b.scopeLabel}? Spend stops being capped and this cannot be undone.`)) return;
            apiPost("/api/pages/budgets/remove", { id: b.id })
              .then(() => { setOk(`Budget for ${b.scopeLabel} deleted.`); refresh(); })
              .catch((ex) => setErr(ex instanceof Error ? ex.message : "Delete failed"));
          }}>Delete</Button>
        </span>,
      ])} />
    ) : null}
  </Page></ConsoleLayout>);
}

type AliasTarget = { modelId: string; slug: string };
type AliasRow = { id: string; name: string; description: string | null; enabled: boolean; scope: string; targets: AliasTarget[] };
type AliasModel = { id: string; slug: string; name: string; status: string; developer: string | null };
type AliasesData = { aliases: AliasRow[]; models: AliasModel[] };

export function AliasesPage() {
  const [tick, setTick] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<AliasRow | null>(null);
  const { data: d, error, loading } = useLoad<AliasesData>("/api/pages/aliases", tick);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const aliases = d?.aliases ?? [];
  const models = d?.models ?? [];
  return (<ConsoleLayout><Page title="Aliases" lede="Stable names your apps can ask for instead of a model id.">
    <LoadState loading={loading} error={error} />
    <div className="ps-note" role="note">
      <p>An alias resolves to its targets in order. Account aliases are yours to edit; global aliases are platform-owned and read-only.</p>
    </div>
    {err ? <p className="error">{err}</p> : null}
    {ok ? <p className="ps-ok">{ok}</p> : null}
    <form className="ps-form" onSubmit={(e) => {
      e.preventDefault(); setErr(null); setOk(null); setBusy(true);
      const f = new FormData(e.currentTarget);
      const name = String(f.get("name") ?? "").trim();
      apiPost<{ created: string }>("/api/pages/aliases/create", {
        name,
        scope: String(f.get("scope") ?? "account"),
        modelIds: f.getAll("modelIds").map((v) => String(v)),
        description: String(f.get("description") ?? "").trim() || undefined,
      })
        .then(() => { setOk(`Alias "${name}" created.`); (e.target as HTMLFormElement).reset(); refresh(); })
        .catch((ex) => setErr(ex instanceof Error ? ex.message : "Create failed"))
        .finally(() => setBusy(false));
    }}>
      <label className="ps-field"><span>Name</span><Input name="name" placeholder="e.g. fast" required /></label>
      <label className="ps-field"><span>Scope</span>
        <select className="select" name="scope" defaultValue="account">
          <option value="account">This account</option>
          <option value="global">Global (read-only once created)</option>
        </select>
      </label>
      <label className="ps-field"><span>Targets (in fallback order)</span>
        <select className="select" name="modelIds" multiple size={4} required>
          {models.map((m) => <option key={m.id} value={m.id}>{m.slug}</option>)}
        </select>
      </label>
      <label className="ps-field"><span>Description</span><Input name="description" placeholder="What this alias is for" /></label>
      <div className="ps-form-actions pr-actions">
        <Button type="submit" variant="primary" disabled={busy}>{busy ? "Creating…" : "Create alias"}</Button>
      </div>
    </form>
    {!loading && !error && aliases.length === 0 ? (
      <div className="ps-empty"><p className="muted">No aliases yet.</p></div>
    ) : null}
    {aliases.length > 0 ? (
      <Table head={["Name", "Targets", "Scope", "State", ""]} rows={aliases.map((a) => [
        <span key="n" className="ps-alias-name">{a.name}{a.description ? <span className="muted">{a.description}</span> : null}</span>,
        <span key="t" className="ps-targets">{a.targets.length > 0 ? a.targets.map((t) => (<code key={t.modelId} className="ps-target">{t.slug}</code>)) : <span className="muted">no targets</span>}</span>,
        <Badge key="s" tone={a.scope === "account" ? "info" : "default"}>{a.scope}</Badge>,
        <Badge key="e" tone={a.enabled ? "ok" : "warn"}>{a.enabled ? "enabled" : "disabled"}</Badge>,
        <Button key="d" size="sm" variant="secondary" disabled={a.scope === "global"} title={a.scope === "global" ? "Global aliases are read-only" : undefined} onClick={() => { setErr(null); setDeleting(a); }}>Delete</Button>,
      ])} />
    ) : null}
    {deleting ? (<KeysDialog title="Delete alias" onClose={() => setDeleting(null)}>
      <p>Delete <code className="keys-prefix">{deleting.name}</code>? Requests naming it fall back to normal model resolution. This cannot be undone.</p>
      <div className="row">
        <Button variant="secondary" onClick={() => setDeleting(null)}>Cancel</Button>
        <Button variant="destructive" onClick={() => {
          apiPost(`/api/pages/aliases/delete`, { id: deleting.id })
            .then(() => { const gone = deleting.name; setDeleting(null); setOk(`Alias "${gone}" deleted.`); refresh(); })
            .catch((ex) => setErr(ex instanceof Error ? ex.message : "Delete failed"));
        }}>Delete</Button>
      </div>
    </KeysDialog>) : null}
  </Page></ConsoleLayout>);
}

type PolicyConstraints = Record<string, unknown>;
type PolicyWeights = Record<string, number | undefined>;
type RoutingPolicy = {
  id: string; name: string; strategy: string; enabled: boolean; maxAttempts: number; requestTimeoutMs: number; fallbackEnabled: boolean;
  scope: string; providerPreferences: { order: string[] }; modelPreferences: { order: string[] }; constraints: PolicyConstraints; weights: PolicyWeights;
};
type RoutingData = { policies: RoutingPolicy[]; strategies: string[]; providers: { slug: string; name: string }[]; models: { slug: string; name: string }[] };

// The update endpoint replaces the whole policy, so the dialog must resend the
// fields the form does not show (constraints, weights, orders) or editing a
// name would silently clear them. The parser accepts the snake_case keys.
function policyBody(p: RoutingPolicy, over: Record<string, unknown>) {
  return {
    id: p.id,
    name: p.name,
    strategy: p.strategy,
    enabled: p.enabled,
    maxAttempts: p.maxAttempts,
    requestTimeoutMs: p.requestTimeoutMs,
    fallbackEnabled: p.fallbackEnabled,
    providerOrder: p.providerPreferences?.order ?? [],
    modelOrder: p.modelPreferences?.order ?? [],
    max_input_price_micro: p.constraints?.max_input_price_micro,
    max_output_price_micro: p.constraints?.max_output_price_micro,
    max_p95_latency_ms: p.constraints?.max_p95_latency_ms,
    min_availability: p.constraints?.min_availability,
    allowed_providers: p.constraints?.allowed_providers,
    blocked_providers: p.constraints?.blocked_providers,
    region_preference: p.constraints?.region_preference,
    weights: p.weights ?? {},
    ...over,
  };
}

function PolicyDialog({ policy, strategies, onClose, onSaved }: { policy: RoutingPolicy; strategies: string[]; onClose: () => void; onSaved: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (<KeysDialog title={`Edit ${policy.name}`} onClose={onClose}>
    <form className="ps-dialog-form" onSubmit={(e) => {
      e.preventDefault(); setErr(null); setBusy(true);
      const f = new FormData(e.currentTarget);
      apiPost(`/api/pages/routing/update`, policyBody(policy, {
        name: String(f.get("name") ?? "").trim(),
        strategy: String(f.get("strategy") ?? policy.strategy),
        enabled: f.get("enabled") === "on",
        maxAttempts: Number(f.get("maxAttempts") ?? policy.maxAttempts),
      }))
        .then(() => { onSaved(); onClose(); })
        .catch((ex) => setErr(ex instanceof Error ? ex.message : "Update failed"))
        .finally(() => setBusy(false));
    }}>
      <label className="ps-field"><span>Name</span><Input name="name" defaultValue={policy.name} required /></label>
      <label className="ps-field"><span>Strategy</span>
        <select className="select" name="strategy" defaultValue={policy.strategy}>
          {strategies.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
        </select>
      </label>
      <label className="ps-field"><span>Max attempts (1–8)</span><Input name="maxAttempts" inputMode="numeric" defaultValue={String(policy.maxAttempts)} /></label>
      <label className="ps-check"><input type="checkbox" name="enabled" defaultChecked={policy.enabled} /> enabled</label>
      {err ? <p className="error">{err}</p> : null}
      <div className="row">
        <Button type="submit" variant="primary" disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
      </div>
    </form>
  </KeysDialog>);
}

export function RoutingPage() {
  const [tick, setTick] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [editing, setEditing] = useState<RoutingPolicy | null>(null);
  const [deleting, setDeleting] = useState<RoutingPolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: d, error, loading } = useLoad<RoutingData>("/api/pages/routing", tick);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const policies = d?.policies ?? [];
  const strategies = d?.strategies ?? [];
  const accountPolicies = policies.filter((p) => p.scope !== "platform");
  const platformDefault = policies.find((p) => p.scope === "platform") ?? null;
  return (<ConsoleLayout><Page title="Routing" lede="How a request picks its provider and model.">
    <LoadState loading={loading} error={error} />
    <div className="ps-note" role="note">
      <p>Your account policy applies to every key unless a tighter one exists. The platform default applies when your account defines none.</p>
    </div>
    <Card titleAs="h2" title="Platform default" desc={platformDefault ? `${platformDefault.name} · ${platformDefault.strategy.replace(/_/g, " ")}` : "none"} />
    {err ? <p className="error">{err}</p> : null}
    {ok ? <p className="ps-ok">{ok}</p> : null}
    <form className="ps-form" onSubmit={(e) => {
      e.preventDefault(); setErr(null); setOk(null); setBusy(true);
      const f = new FormData(e.currentTarget);
      const name = String(f.get("name") ?? "").trim();
      apiPost<{ created: string }>("/api/pages/routing/create", {
        name,
        strategy: String(f.get("strategy") ?? strategies[0] ?? "balanced"),
        maxAttempts: Number(f.get("maxAttempts") ?? 2),
        requestTimeoutMs: Number(f.get("requestTimeoutMs") ?? 30000),
        fallbackEnabled: f.get("fallbackEnabled") === "on",
      })
        .then(() => { setOk(`Policy "${name}" created.`); (e.target as HTMLFormElement).reset(); refresh(); })
        .catch((ex) => setErr(ex instanceof Error ? ex.message : "Create failed"))
        .finally(() => setBusy(false));
    }}>
      <label className="ps-field"><span>Name</span><Input name="name" placeholder="e.g. production" required /></label>
      <label className="ps-field"><span>Strategy</span>
        <select className="select" name="strategy" defaultValue={strategies[0] ?? "balanced"}>
          {strategies.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
        </select>
      </label>
      <label className="ps-field"><span>Max attempts (1–8)</span><Input name="maxAttempts" inputMode="numeric" defaultValue="2" /></label>
      <label className="ps-field"><span>Timeout (ms)</span><Input name="requestTimeoutMs" inputMode="numeric" defaultValue="30000" /></label>
      <label className="ps-check"><input type="checkbox" name="fallbackEnabled" defaultChecked /> fallback on failure</label>
      <div className="ps-form-actions pr-actions">
        <Button type="submit" variant="primary" disabled={busy}>{busy ? "Creating…" : "Create policy"}</Button>
      </div>
    </form>
    {!loading && !error && accountPolicies.length === 0 ? (
      <div className="ps-empty"><p className="muted">No account policies yet — the platform default applies.</p></div>
    ) : null}
    {accountPolicies.length > 0 ? (
      <Table head={["Name", "Strategy", "Attempts", "Fallback", "State", "Actions"]} rows={accountPolicies.map((p) => [
        p.name,
        p.strategy.replace(/_/g, " "),
        <span key="a" className="num">{p.maxAttempts}</span>,
        p.fallbackEnabled ? "yes" : "no",
        <Badge key="s" tone={p.enabled ? "ok" : "warn"}>{p.enabled ? "enabled" : "disabled"}</Badge>,
        <span key="x" className="row">
          <Button size="sm" variant="secondary" onClick={() => { setErr(null); setEditing(p); }}>Edit</Button>
          <Button size="sm" variant="ghost" onClick={() => {
            setErr(null); setOk(null);
            apiPost(`/api/pages/routing/update`, policyBody(p, { enabled: !p.enabled }))
              .then(() => { setOk(`${p.name} ${p.enabled ? "disabled" : "enabled"}.`); refresh(); })
              .catch((ex) => setErr(ex instanceof Error ? ex.message : "Update failed"));
          }}>{p.enabled ? "Disable" : "Enable"}</Button>
          <Button size="sm" variant="ghost" onClick={() => { setErr(null); setOk(null); setDeleting(p); }}>Delete</Button>
        </span>,
      ])} />
    ) : null}
    {editing ? <PolicyDialog policy={editing} strategies={strategies} onClose={() => setEditing(null)} onSaved={refresh} /> : null}
    {deleting ? (<KeysDialog title="Delete policy" onClose={() => setDeleting(null)}>
      <p>Delete <code className="keys-prefix">{deleting.name}</code>? Requests fall back to the platform default. This cannot be undone.</p>
      <div className="row">
        <Button variant="secondary" onClick={() => setDeleting(null)}>Cancel</Button>
        <Button variant="destructive" onClick={() => {
          apiPost(`/api/pages/routing/delete`, { id: deleting.id })
            .then(() => { const gone = deleting.name; setDeleting(null); setOk(`Policy "${gone}" deleted.`); refresh(); })
            .catch((ex) => setErr(ex instanceof Error ? ex.message : "Delete failed"));
        }}>Delete</Button>
      </div>
    </KeysDialog>) : null}
  </Page></ConsoleLayout>);
}

type AlertCondition = { type: string; threshold: number; windowSeconds: number | null; baselineRate: number | null };
type AlertView = { id: string; name: string; enabled: boolean; channel: string; condition: AlertCondition };
type AlertEventRow = { id: string; alertId: string; alertName: string; triggeredAt: string; value: string; message: string; state: string; resolvedAt: string | null; deliveredAt: string | null };
type AlertsData = { denied: boolean; queryError: string | null; conditionTypes: string[]; channels: string[]; alerts: AlertView[]; events: AlertEventRow[] };

// Threshold units per condition, mirroring the server's vocabulary: the
// placeholder is the only place the form says what number to type.
const ALERT_UNITS: Record<string, string> = {
  error_rate: "fraction, e.g. 0.05",
  latency: "milliseconds",
  budget_threshold: "percent of budget",
  credit_threshold: "dollars",
  fallback_rate: "fraction, e.g. 0.2",
  provider_availability: "fraction, e.g. 0.9",
  unusual_key_traffic: "requests per window",
};

export function AlertsPage() {
  const [tick, setTick] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<AlertView | null>(null);
  const [alertType, setAlertType] = useState("error_rate");
  const { data: d, error, loading } = useLoad<AlertsData>("/api/pages/alerts", tick);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const alerts = d?.alerts ?? [];
  const events = d?.events ?? [];
  const conditionTypes = d?.conditionTypes ?? [];
  const channels = d?.channels ?? [];
  const toggle = (a: AlertView) => {
    setErr(null); setOk(null);
    apiPost(`/api/pages/alerts/update`, {
      id: a.id, name: a.name, type: a.condition.type, threshold: String(a.condition.threshold),
      windowSeconds: a.condition.windowSeconds ? String(a.condition.windowSeconds) : "",
      baselineRate: a.condition.baselineRate === null ? "" : String(a.condition.baselineRate),
      channel: a.channel, enabled: !a.enabled,
    })
      .then(() => { setOk(`${a.name} ${a.enabled ? "disabled" : "enabled"}.`); refresh(); })
      .catch((ex) => setErr(ex instanceof Error ? ex.message : "Update failed"));
  };
  return (<ConsoleLayout><Page title="Alerts" lede="Conditions that notify you before a problem becomes an outage.">
    <LoadState loading={loading} error={error} />
    <div className="ps-note" role="note">
      <p>Alerts are account-wide. Each one watches every key's traffic, so a single rule covers the whole account.</p>
    </div>
    {err ? <p className="error">{err}</p> : null}
    {ok ? <p className="ps-ok">{ok}</p> : null}
    <form className="ps-form" onSubmit={(e) => {
      e.preventDefault(); setErr(null); setOk(null); setBusy(true);
      const f = new FormData(e.currentTarget);
      const name = String(f.get("name") ?? "").trim();
      apiPost<{ saved: string }>("/api/pages/alerts/create", {
        name,
        type: String(f.get("type") ?? ""),
        threshold: String(f.get("threshold") ?? "").trim(),
        windowSeconds: String(f.get("windowSeconds") ?? "").trim(),
        baselineRate: String(f.get("baselineRate") ?? "").trim(),
        channel: String(f.get("channel") ?? "inapp"),
        enabled: true,
      })
        .then(() => { setOk(`Alert "${name}" created.`); (e.target as HTMLFormElement).reset(); refresh(); })
        .catch((ex) => setErr(ex instanceof Error ? ex.message : "Create failed"))
        .finally(() => setBusy(false));
    }}>
      <label className="ps-field"><span>Name</span><Input name="name" placeholder="e.g. error spike" required /></label>
      <label className="ps-field"><span>Condition</span>
        <select className="select" name="type" value={alertType} onChange={(e) => setAlertType(e.target.value)}>
          {conditionTypes.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
        </select>
      </label>
      <label className="ps-field"><span>Threshold</span><Input name="threshold" inputMode="decimal" placeholder={ALERT_UNITS[alertType] ?? "threshold"} required /></label>
      <label className="ps-field"><span>Window (seconds)</span><Input name="windowSeconds" inputMode="numeric" placeholder="300" /></label>
      <label className="ps-field"><span>Baseline rate</span><Input name="baselineRate" inputMode="decimal" placeholder="optional" /></label>
      <label className="ps-field"><span>Channel</span>
        <select className="select" name="channel" defaultValue={channels[0] ?? "inapp"}>
          {channels.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </label>
      <div className="ps-form-actions pr-actions">
        <Button type="submit" variant="primary" disabled={busy}>{busy ? "Creating…" : "Create alert"}</Button>
      </div>
    </form>
    {!loading && !error && alerts.length === 0 ? (
      <div className="ps-empty"><p className="muted">No alerts yet. Create one above to be told when this account&apos;s error rate, latency or spend crosses a line.</p></div>
    ) : null}
    {alerts.length > 0 ? (
      <Table head={["Name", "Condition", "Threshold", "Channel", "State", "Actions"]} rows={alerts.map((a) => [
        a.name,
        a.condition.type.replace(/_/g, " "),
        <span key="t" className="num">{`${a.condition.threshold}${a.condition.windowSeconds ? ` / ${a.condition.windowSeconds}s` : ""}`}</span>,
        a.channel,
        <Badge key="s" tone={a.enabled ? "ok" : "warn"}>{a.enabled ? "enabled" : "disabled"}</Badge>,
        <span key="x" className="row">
          <Button size="sm" variant="secondary" onClick={() => toggle(a)}>{a.enabled ? "Disable" : "Enable"}</Button>
          <Button size="sm" variant="ghost" onClick={() => { setErr(null); setOk(null); setDeleting(a); }}>Delete</Button>
        </span>,
      ])} />
    ) : null}
    {events.length > 0 ? (<>
      <h2>Recent firings</h2>
      <Table head={["Alert", "Triggered", "Value", "State", "Resolved"]} rows={events.map((e) => [
        e.alertName,
        fmtDate(e.triggeredAt),
        e.value,
        e.state,
        e.resolvedAt ? fmtDate(e.resolvedAt) : "—",
      ])} />
    </>) : null}
    {deleting ? (<KeysDialog title="Delete alert" onClose={() => setDeleting(null)}>
      <p>Delete <code className="keys-prefix">{deleting.name}</code>? You stop being told when this condition fires.</p>
      <div className="row">
        <Button variant="secondary" onClick={() => setDeleting(null)}>Cancel</Button>
        <Button variant="destructive" onClick={() => {
          apiPost(`/api/pages/alerts/remove`, { id: deleting.id })
            .then(() => { const gone = deleting.name; setDeleting(null); setOk(`Alert "${gone}" deleted.`); refresh(); })
            .catch((ex) => setErr(ex instanceof Error ? ex.message : "Delete failed"));
        }}>Delete</Button>
      </div>
    </KeysDialog>) : null}
  </Page></ConsoleLayout>);
}
