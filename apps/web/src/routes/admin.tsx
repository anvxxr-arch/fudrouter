import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate, useParams } from "react-router-dom";
import { apiGet } from "../lib/server";
import { ROLE_CAPS } from "../lib/caps";
import { ADMIN_NAV, filterNav } from "../lib/navigation";
import { useSession } from "../components/guards";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Badge } from "../components/ui/badge";
import { Table } from "../components/ui/table";
import { StatCard, pctDelta } from "../components/stat-card";
import { fmtMicro, fmtMicroShort } from "../lib/money";
import "./dashboard.css";

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
  const { pathname } = useLocation();
  const navigate = useNavigate();
  // 17 pills wrap into four rows at 390px: 140px of chrome, 16.6% of the screen,
  // before the page title. A native select is one 44px control, uses the OS
  // picker, and needs no horizontal scroll or bespoke sheet. The pill row is
  // hidden at that width rather than removed, so the desktop bar is unchanged.
  const current = items.find((i) => (i.to === "/admin" ? pathname === "/admin" : pathname.startsWith(i.to)))?.to ?? "/admin";
  return (<>
    <nav className="row admin-nav" aria-label="Admin" style={{ flexWrap: "wrap" }}>
      {items.map((i) => (
        <NavLink key={i.to} to={i.to} end={i.to === "/admin"}>
          <Button variant="ghost" size="sm">{i.label}</Button>
        </NavLink>
      ))}
    </nav>
    <select
      className="admin-nav-select"
      aria-label="Admin section"
      value={current}
      onChange={(e) => navigate(e.currentTarget.value)}
    >
      {items.map((i) => (<option key={i.to} value={i.to}>{i.label}</option>))}
    </select>
  </>);
}

// `console-main` carries the console type scale (h1 32px instead of the 48px
// marketing ramp). The admin tree had no such scope, so "Admin" rendered at the
// same weight as the landing hero -- 48px of chrome before any data.
function Page({ title, lede, children }: { title: string; lede: string; children?: ReactNode }) {
  return (<div className="stack console-main"><AdminNav /><h1>{title}</h1><p className="lede muted">{lede}</p>{children}</div>);
}

function useLoad<T>(path: string, tick = 0): { d: T | null; err: string | null } {
  const [d, setD] = useState<T | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setD(null); setErr(null);
    apiGet<T>(path).then((v) => { if (live) setD(v); }).catch((e: Error) => { if (live) setErr(/403/.test(e.message) ? "Forbidden — your role lacks the capability for this section." : "Load failed (" + e.message + ")."); });
    return () => { live = false; };
  }, [path, tick]);
  return { d, err };
}

function State({ err, d, children }: { err: string | null; d: unknown; children: (v: never) => ReactNode }) {
  if (err) return (<Card title="Unavailable" desc={err} />);
  if (!d) return (<Card desc="Loading…" />);
  return (<>{children(d as never)}</>);
}

// Count keys arrive as camelCase/snake_case and several views printed them
// verbatim, so the bar read "activeKeys" and the model summary read "published".
// One labeler for every generic count map.
const humanKey = (k: string) =>
  k.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^\w/, (c) => c.toUpperCase());
const fmtDate = (v: unknown) => { try { return v ? new Date(String(v)).toLocaleString() : "—"; } catch { return String(v ?? "—"); } };
// Same ledger, same rendering: lib/money.ts is the only formatter. This file
// used to truncate the cents and skip grouping, so the admin KPI read
// "$102055.00" for the balance the member dashboard showed as "$102,054.94".
const fmtUsd = (micro: unknown) => fmtMicro(micro as string | null | undefined);

// apiPost in lib/server.ts throws "path: status" and drops the body, so a
// refused admin action ("you cannot ban yourself") is indistinguishable from a
// transport failure. Read the server's {error} message so the operator sees why.
async function postJSON<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && (data.error as string)) || path + ": " + res.status);
  return data as T;
}

// Display label per count key. The API returns camelCase keys and they were
// rendered verbatim, so the overview read "activeKeys 70".
const INVENTORY = [
  ["providers", "Providers"],
  ["models", "Models"],
  ["connections", "Connections"],
  ["activeKeys", "Active keys"],
  ["users", "Users"],
] as const;
type Overview = { counts: Record<string, number | string>; series: { day: string; requests: number; tokens: number; costMicro: string }[]; revenueMtdMicro: string; topConsumers: { keyId: string | null; keyName: string; email: string; requests: number; costMicro: string }[]; recent: { id: string; createdAt: string; requestedModel: string | null; latencyMs: number; status: string }[] };
export function AdminHome() {
  const { d, err } = useLoad<Overview>("/api/admin/overview");
  // Billing and users are cap-gated sections (admin.billing / admin.users): a
  // role with admin.view but without them gets a 403 here, so each section
  // renders only when its fetch resolves rather than showing an error card.
  const billing = useLoad<Billing>("/api/admin/billing");
  const users = useLoad<Users>("/api/admin/users");
  return (<Page title="Admin" lede="Platform overview.">
    <State err={err} d={d}>{(v: Overview) => {
      const today = v.series[v.series.length - 1];
      const yesterday = v.series[v.series.length - 2];
      return (<>
        <div className="row row--cards" style={{ flexWrap: "wrap" }}>
          <StatCard title="Requests" value={String(v.counts.requests)} delta={today && yesterday ? pctDelta(today.requests, yesterday.requests) : undefined} spark={v.series.map((s) => s.requests)} />
          <StatCard title="Tokens" value={String(v.counts.tokens)} delta={today && yesterday ? pctDelta(today.tokens, yesterday.tokens) : undefined} spark={v.series.map((s) => s.tokens)} />
          <StatCard title="Cost" value={fmtUsd(v.counts.costMicro)} delta={today && yesterday ? pctDelta(Number(BigInt(today.costMicro || "0")), Number(BigInt(yesterday.costMicro || "0"))) : undefined} spark={v.series.map((s) => Number(BigInt(s.costMicro || "0")))} />
          <StatCard
            title="Revenue MTD"
            value={fmtUsd(v.revenueMtdMicro)}
            spark={billing.d ? billing.d.monthly.map((m) => m.series.reduce((a, s) => a + Math.max(Number(s.totalMicro || "0"), 0), 0) / 1_000_000) : undefined}
          />
        </div>
        {/* Inventory was five `Card title={rawKey} desc={count}` blocks in the
            same flex row as the KPI cards: a different component, a different
            height, no figure styling, and the raw keys ("activeKeys") printed
            as labels. Same component, same row, human labels. */}
        <h2 className="dash-h">Inventory</h2>
        <div className="row row--cards" style={{ flexWrap: "wrap" }}>
          {INVENTORY.map(([key, label]) => (
            <StatCard key={key} title={label} value={String(v.counts[key] ?? "—")} />
          ))}
        </div>
        {billing.d ? (<>
          <h2 className="dash-h">Ledger inflow, last 12 months</h2>
          <RevenueChart monthly={billing.d.monthly} />
        </>) : null}
        {users.d ? (<>
          <h2>Recent signups</h2>
          <Table head={["Email", "Role", "Created", "First request"]} rows={users.d.users.slice(0, 8).map((u) => [u.email, u.role ?? "—", fmtDate(u.createdAt), u.firstRequestAt ? fmtDate(u.firstRequestAt) : "—"])} />
        </>) : null}
        <h2>Top consumers</h2>
        <Table head={["Key", "Owner", "Requests", "Cost"]} numeric={[2, 3]} rows={v.topConsumers.map((t) => [t.keyName, t.email, String(t.requests), fmtUsd(t.costMicro)])} />
        <h2>Recent requests</h2>
        <Table head={["ID", "Model", "Latency ms", "Status", "At"]} numeric={[2]} rows={v.recent.map((r) => [r.id, r.requestedModel ?? "—", String(r.latencyMs), r.status, fmtDate(r.createdAt)])} />
      </>);
    }}</State>
  </Page>);
}

// Stacked bars: one column per month, one segment per ledger type. Pure SVG --
// the console ships no charting dependency and this is the whole need.
//
// The first cut was unreadable at 1280px, for four separate reasons:
//   - the only y-axis label sat at the axis baseline instead of at the top of
//     the tallest bar, so "$102054.93" read as a value on the zero line;
//   - only the first and last month were labelled, so the single bar carrying
//     data could not be attributed to a month;
//   - a ledger type that never moved in the window still got a legend row
//     (four of six), and no gridlines meant no intermediate value was readable;
//   - negative entries (usage_charge can be a reversal) were stacked as if they
//     were inflow: the rect height clamped at 0 while the accumulator kept
//     moving down, so every later segment was drawn against a wrong baseline.
// Revenue here is gross inflow, so non-positive entries are excluded from both
// the bar and the total rather than silently collapsing the stack.
function RevenueChart({ monthly }: { monthly: { month: string; series: { type: string; totalMicro: string }[] }[] }) {
  const W = 720, H = 200, PAD_L = 56, PAD_R = 8, PAD_T = 12, PAD_B = 30;
  const pos = (v: string | null | undefined) => { const b = BigInt(v || "0"); return b > 0n ? b : 0n; };
  const typeOrder = monthly[0]?.series.map((s) => s.type) ?? [];
  const colorOf = (t: string) => Math.max(typeOrder.indexOf(t), 0) % 6;
  const totals = monthly.map((m) => m.series.reduce((acc, s) => acc + pos(s.totalMicro), 0n));
  const max = totals.reduce((acc, v) => (v > acc ? v : acc), 0n);
  const total = totals.reduce((acc, v) => acc + v, 0n);
  const used = typeOrder.filter((t) => monthly.some((m) => pos(m.series.find((s) => s.type === t)?.totalMicro) > 0n));
  const first = monthly[0]?.month ?? "", last = monthly[monthly.length - 1]?.month ?? "";
  if (monthly.length === 0 || total === 0n) {
    return <Card desc={`No ledger entries between ${first || "—"} and ${last || "—"}.`} />;
  }
  const barW = (W - PAD_L - PAD_R) / monthly.length;
  const plotH = H - PAD_T - PAD_B;
  const y = (v: bigint) => H - PAD_B - Number((v * 10_000n) / max) / 10_000 * plotH;
  // 0 / 50% / 100% of the tallest bar. Reading a stacked bar without these was
  // guesswork -- the only label sat on the baseline.
  const ticks = [0n, max / 2n, max];
  return (<>
    <div className="credits-chart-wrap">
      <svg className="credits-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Gross ledger inflow by type, ${first} to ${last}. Total ${fmtUsd(total.toString())}.`}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line className={i === 0 ? "credits-chart-axis" : "credits-chart-grid"} x1={PAD_L} y1={y(t)} x2={W - PAD_R} y2={y(t)} />
            <text className="credits-chart-tick" x={PAD_L - 8} y={y(t) + 4} textAnchor="end">{fmtMicroShort(t.toString())}</text>
          </g>
        ))}
        {monthly.map((m, i) => {
          let acc = 0n;
          const x = PAD_L + i * barW;
          return (<g key={m.month}>
            {/* A zero month drew nothing at all, so 10 of 12 columns looked
                like a chart that failed to render rather than "no activity". */}
            {totals[i] === 0n ? <rect className="credits-chart-empty" x={x + 1} y={H - PAD_B - 2} width={Math.max(barW - 2, 1)} height={2} /> : null}
            {m.series.map((s) => {
              const v = pos(s.totalMicro);
              if (v === 0n) return null;
              const y0 = y(acc);
              acc += v;
              const y1 = y(acc);
              return <rect key={s.type} className={`credits-chart-seg credits-chart-seg--${colorOf(s.type)}`} x={x + 1} y={y1} width={Math.max(barW - 2, 1)} height={Math.max(y0 - y1, 0.5)} />;
            })}
            {/* Every month is labelled, not just the endpoints: the one bar with
                data was otherwise unattributable. YYYY-MM fits inside a 55-unit
                column at 10px mono, so no rotation is needed. */}
            <text className="credits-chart-tick credits-chart-month" x={x + barW / 2} y={H - 8} textAnchor="middle">{m.month}</text>
          </g>);
        })}
      </svg>
    </div>
    <ul className="credits-legend">
      {used.map((t) => (<li key={t}><span className={`credits-legend-swatch credits-chart-seg--${colorOf(t)}`} />{t}</li>))}
    </ul>
  </>);
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
      <Table head={["Model", "Req", "OK", "Tok in", "Tok out", "Cost", "p50", "p95", "p99"]} numeric={[1, 2, 3, 4, 5, 6, 7, 8]} rows={v.byModel.map((r) => [r.name, String(r.requests), String(r.successes), String(r.tokensIn), String(r.tokensOut), fmtUsd(r.costMicro), String(r.p50), String(r.p95), String(r.p99)])} />
      <h2>By provider</h2>
      <Table head={["Provider", "Req", "OK", "Cost", "p50", "p95", "p99"]} numeric={[1, 2, 3, 4, 5, 6]} rows={v.byProvider.map((r) => [r.name, String(r.requests), String(r.successes), fmtUsd(r.costMicro), String(r.p50), String(r.p95), String(r.p99)])} />
    </>)}</State>
  </>);
}

type Billing = { accounts: { id: string; accountEmail: string; currency: string; status: string; warningThresholdMicro: string; hardStopThresholdMicro: string; balanceMicro: string; ledgerSumMicro: string }[]; totals: { type: string; totalMicro: string }[]; monthly: { month: string; series: { type: string; totalMicro: string }[] }[]; recent: { id: string; accountEmail: string; type: string; amountMicro: string; currency: string; requestId: string | null; description: string | null; createdBy: string | null; createdAt: string }[]; invoices: { id: string; accountEmail: string; number: string; periodStart: string; periodEnd: string; amountMicro: string; currency: string; status: string; issuedAt: string | null; paidAt: string | null }[] };
function BillingView() {
  const { d, err } = useLoad<Billing>("/api/admin/billing");
  return (<State err={err} d={d}>{(v: Billing) => (<>
    <h2>Accounts (balance is a cache — ledger sum is truth)</h2>
    <Table head={["Account", "Status", "Balance", "Ledger sum", "Drift", "Warn", "Hard stop"]} numeric={[2, 3, 4, 5, 6]} rows={v.accounts.map((a) => [a.accountEmail, a.status, fmtUsd(a.balanceMicro), fmtUsd(a.ledgerSumMicro), a.balanceMicro === a.ledgerSumMicro ? "—" : fmtUsd(String(BigInt(a.balanceMicro) - BigInt(a.ledgerSumMicro))), fmtUsd(a.warningThresholdMicro), fmtUsd(a.hardStopThresholdMicro)])} />
    <h2>Ledger totals by type</h2>
    <Table head={["Type", "Total"]} numeric={[1]} rows={v.totals.map((t) => [t.type, fmtUsd(t.totalMicro)])} />
    <h2>Recent ledger entries</h2>
    <Table head={["Account", "Type", "Amount", "Request", "Description", "At"]} numeric={[2]} rows={v.recent.map((r) => [r.accountEmail, r.type, fmtUsd(r.amountMicro), r.requestId ?? "—", (r.description ?? "—").slice(0, 80), fmtDate(r.createdAt)])} />
    <h2>Invoices</h2>
    <Table head={["Number", "Account", "Amount", "Status", "Period", "Paid"]} numeric={[2]} rows={v.invoices.map((i) => [i.number, i.accountEmail, fmtUsd(i.amountMicro), i.status, fmtDate(i.periodStart).slice(0, 10) + " → " + fmtDate(i.periodEnd).slice(0, 10), i.paidAt ? fmtDate(i.paidAt) : "—"])} />
  </>)}</State>);
}

type Connections = { connections: { id: string; name: string; baseUrl: string; region: string | null; authType: string; priority: number; enabled: boolean; healthStatus: string; providerName: string; credentialTotal: number; credentialHealthy: number }[] };
function ConnectionsView() {
  const { d, err } = useLoad<Connections>("/api/admin/connections");
  return (<State err={err} d={d}>{(v: Connections) => (
    <Table head={["Provider", "Connection", "Base URL", "Region", "Prio", "Enabled", "Health", "Creds ok/total"]} numeric={[4, 7]} rows={v.connections.map((c) => [c.providerName, c.name, c.baseUrl, c.region ?? "—", String(c.priority), String(c.enabled), c.healthStatus, c.credentialHealthy + "/" + c.credentialTotal])} />
  )}</State>);
}

type Health = { providers: { id: string; name: string; status: string; requests: number; successes: number; p95: number; errorMix: { code: string; n: number }[] }[]; connections: { id: string; name: string; region: string | null; enabled: boolean; healthStatus: string; requests: number; successes: number; p95: number; errorMix: { code: string; n: number }[]; credentialsTotal: number; credentialsHealthy: number }[] };
function HealthView() {
  const { d, err } = useLoad<Health>("/api/admin/health");
  return (<State err={err} d={d}>{(v: Health) => (<>
    <Card titleAs="h2" title="Observed outcomes" desc="Last 24h from the request log — not synthetic probes." />
    <h2>Providers</h2>
    <Table head={["Provider", "Status", "Req/OK", "p95 ms", "Error mix"]} numeric={[2, 3, 4]} rows={v.providers.map((p) => [p.name, p.status, p.requests + "/" + p.successes, String(p.p95), p.errorMix.map((e) => e.code + "×" + e.n).join(", ") || "—"])} />
    <h2>Connections</h2>
    <Table head={["Connection", "Health", "Req/OK", "p95 ms", "Creds", "Errors"]} numeric={[2, 3]} rows={v.connections.map((c) => [c.name, c.healthStatus, c.requests + "/" + c.successes, String(c.p95), c.credentialsHealthy + "/" + c.credentialsTotal, c.errorMix.map((e) => e.code + "×" + e.n).join(", ") || "—"])} />
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

type Keys = { users: { id: string; email: string }[]; keys: { id: string; name: string; prefix: string; status: string; email: string; rpm: number | null; monthlyCapMicro: string | null; lastUsedAt: string | null; createdAt: string; usage: { requests: number; tokensIn: number; tokensOut: number; cost: string } }[] };
function KeysView() {
  const { d, err } = useLoad<Keys>("/api/admin/keys");
  return (<State err={err} d={d}>{(v: Keys) => (
    <Table head={["Name", "Owner", "Prefix", "Status", "Req", "Cost", "RPM", "Last used"]} numeric={[4, 5, 6]} rows={v.keys.map((k) => [k.name, k.email, k.prefix, k.status, String(k.usage.requests), fmtUsd(k.usage.cost), k.rpm === null ? "—" : String(k.rpm), k.lastUsedAt ? fmtDate(k.lastUsedAt) : "—"])} />
  )}</State>);
}

type Models = { providers: { id: string; name: string; status: string }[]; models: { id: string; providerId: string; name: string; slug: string; family: string | null; developer: string | null; description: string | null; modality: unknown; context: number | null; maxOutput: number | null; capabilities: Record<string, boolean>; providerName: string; status: string; served: boolean; currency: string; inputPriceMicro: string; outputPriceMicro: string; mappingCount: number }[]; summary: { id: string; name: string; status: string; total: number; published: number; served: number }[]; counts: Record<string, number> };
// The server's own vocabulary (admin.mjs MODEL_STATUSES), not a second copy:
// a status the select offers but the server rejects is a 400 the operator
// cannot explain.
const MODEL_STATUSES = ["active", "deprecated", "sunset", "disabled"];
const CAPABILITY_FLAGS = ["tools", "vision", "reasoning", "structured_output", "streaming"];
type ModelRow = Models["models"][number];
type PricePreview = { preview: true; modelSlug: string; current: { version: number; inputPriceMicro: string; outputPriceMicro: string } | null; nextVersion: number; proposal: { modelId: string; providerModelId: string | null; currency: string; inputPrice: string; cachedInputPrice: string | null; outputPrice: string; reasoningPrice: string | null; effectiveFrom: string } };
type SyncProvider = { id: string; name: string };
type SyncFetch = { fetched: { url: string; latencyMs: number; total: number; providerId: string; providerName: string; upstreamCount: number; checkedCount: number; additions: { slug: string; name: string; providerModelId: string; json: string }[]; changes: { id: string; slug: string; providerModelId: string; reasons: string[]; json: string }[]; removals: { id: string; slug: string; providerModelId: string }[] } };
// One dialog for both modes: the create and update bodies differ only by `id`
// and the price fields, so two components would be the same form twice.
function ModelModal({ model, providers, onClose, onSaved }: { model: ModelRow | null; providers: { id: string; name: string }[]; onClose: () => void; onSaved: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [caps, setCaps] = useState<Record<string, boolean>>(() => (model?.capabilities ?? {}) as Record<string, boolean>);
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close.current(); };
    document.addEventListener("keydown", onKey);
    box.current?.querySelector<HTMLElement>("input, select, textarea, button")?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    const f = new FormData(e.currentTarget);
    const body: Record<string, unknown> = {
      name: String(f.get("name") ?? ""),
      slug: String(f.get("slug") ?? ""),
      family: String(f.get("family") ?? ""),
      developer: String(f.get("developer") ?? ""),
      description: String(f.get("description") ?? ""),
      modality: String(f.get("modality") ?? "") || "{}",
      capabilities: JSON.stringify(caps),
      status: String(f.get("status") ?? ""),
      currency: String(f.get("currency") ?? "") || "USD",
      context: String(f.get("context") ?? ""),
      maxOutput: String(f.get("maxOutput") ?? ""),
    };
    const path = model ? "/api/admin/models/update" : "/api/admin/models/create";
    if (model) body.id = model.id;
    else {
      body.providerId = String(f.get("providerId") ?? "");
      body.inputUsd = String(f.get("inputUsd") ?? "");
      body.outputUsd = String(f.get("outputUsd") ?? "");
      body.providerModelId = String(f.get("providerModelId") ?? "");
    }
    postJSON<{ message: string }>(path, body)
      .then(() => { onSaved(); onClose(); })
      .catch((ex) => setErr(ex instanceof Error ? ex.message : "Save failed"))
      .finally(() => setBusy(false));
  };
  return (<div className="keys-backdrop" onClick={() => close.current()}>
    <div ref={box} className="keys-dialog" role="dialog" aria-modal="true" aria-label={model ? "Edit model" : "New model"} onClick={(e) => e.stopPropagation()}>
      <h2 className="keys-dialog-title">{model ? "Edit " + model.slug : "New model"}</h2>
      <form className="keys-form" onSubmit={submit}>
        {model ? null : <label className="keys-field"><span>Provider</span>
          <select className="select" name="providerId" required defaultValue={providers[0]?.id ?? ""}>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>}
        <label className="keys-field"><span>Name</span><Input name="name" defaultValue={model?.name ?? ""} required /></label>
        <label className="keys-field"><span>Slug</span><Input name="slug" defaultValue={model?.slug ?? ""} required /></label>
        <label className="keys-field"><span>Family</span><Input name="family" defaultValue={model?.family ?? ""} /></label>
        <label className="keys-field"><span>Developer</span><Input name="developer" defaultValue={model?.developer ?? ""} /></label>
        <label className="keys-field"><span>Description</span><Input name="description" defaultValue={model?.description ?? ""} /></label>
        <label className="keys-field"><span>Modality (JSON)</span><Input name="modality" defaultValue={model ? JSON.stringify(model.modality ?? {}) : ""} placeholder='{"input":["text"]}' /></label>
        <label className="keys-field"><span>Status</span>
          <select className="select" name="status" defaultValue={model?.status ?? "active"}>
            {MODEL_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="keys-field"><span>Currency</span><Input name="currency" defaultValue={model?.currency ?? "USD"} maxLength={3} /></label>
        <label className="keys-field"><span>Context</span><Input name="context" type="number" min={1} defaultValue={model?.context ?? ""} /></label>
        <label className="keys-field"><span>Max output</span><Input name="maxOutput" type="number" min={1} defaultValue={model?.maxOutput ?? ""} /></label>
        {model ? null : <>
          <label className="keys-field"><span>Input $/1M</span><Input name="inputUsd" defaultValue="0" required /></label>
          <label className="keys-field"><span>Output $/1M</span><Input name="outputUsd" defaultValue="0" required /></label>
          <label className="keys-field"><span>Upstream model id</span><Input name="providerModelId" placeholder="defaults to slug" /></label>
        </>}
        <fieldset className="keys-field">
          <span>Capabilities</span>
          <div className="row" style={{ flexWrap: "wrap" }}>
            {CAPABILITY_FLAGS.map((c) => (
              <label key={c} className="ps-check">
                <input type="checkbox" checked={!!caps[c]} onChange={(e) => setCaps((m) => ({ ...m, [c]: e.currentTarget.checked }))} />
                {c.replace(/_/g, " ")}
              </label>
            ))}
          </div>
        </fieldset>
        {err ? <p className="error" role="alert">{err}</p> : null}
        <div className="row">
          <Button type="submit" variant="primary" disabled={busy}>{busy ? "Saving…" : model ? "Save" : "Create"}</Button>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </div>
  </div>);
}
// Inline price edit: the server's contract is preview-then-apply, and apply
// refuses without the literal `approved: 'on'` tick, so the confirm row is the
// only place that tick is ever sent.
function PriceCell({ model, field, onApplied }: { model: ModelRow; field: "inputPriceMicro" | "outputPriceMicro"; onApplied: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [preview, setPreview] = useState<PricePreview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const start = () => { setValue((Number(model[field]) / 1_000_000).toString()); setEditing(true); setPreview(null); setErr(null); };
  const run = async () => {
    setErr(null);
    setBusy(true);
    const body = { modelId: model.id, currency: model.currency, inputPrice: field === "inputPriceMicro" ? value : String(Number(model.inputPriceMicro) / 1_000_000), outputPrice: field === "outputPriceMicro" ? value : String(Number(model.outputPriceMicro) / 1_000_000), effectiveFrom: new Date().toISOString().slice(0, 10) };
    try {
      const p = await postJSON<PricePreview>("/api/admin/models/pricing/preview", body);
      setPreview(p);
    } catch (e) { setErr(e instanceof Error ? e.message : "Preview failed"); }
    finally { setBusy(false); }
  };
  const apply = async () => {
    if (!preview) return;
    if (!window.confirm(`Apply ${preview.modelSlug} v${preview.nextVersion}? The current rule is closed and the new one starts billing.`)) return;
    setErr(null);
    setBusy(true);
    try {
      await postJSON("/api/admin/models/pricing/apply", { ...preview.proposal, approved: "on" });
      setEditing(false);
      setPreview(null);
      onApplied();
    } catch (e) { setErr(e instanceof Error ? e.message : "Apply failed"); }
    finally { setBusy(false); }
  };
  if (!editing) return (<button type="button" className="usage-row-btn num" onClick={start} title="Edit price">{fmtUsd(model[field])}</button>);
  return (<span className="mw-price">
    <span className="row">
      <Input aria-label={field} className="num" style={{ width: "6rem" }} value={value} onChange={(e) => setValue(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void run(); } }} />
      <Button size="sm" variant="secondary" disabled={busy || !value.trim()} onClick={() => void run()}>{busy ? "…" : "Preview"}</Button>
      <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setPreview(null); }}>Cancel</Button>
    </span>
    {preview ? <span className="stack" style={{ gap: "var(--space-xs)" }}>
      <span className="meta">v{preview.current?.version ?? 0} → v{preview.nextVersion} · in {fmtUsd(preview.proposal.inputPrice + "000000")} · out {fmtUsd(preview.proposal.outputPrice + "000000")}</span>
      <Button size="sm" variant="primary" disabled={busy} onClick={() => void apply()}>Apply v{preview.nextVersion}</Button>
    </span> : null}
    {err ? <span className="error" role="alert">{err}</span> : null}
  </span>);
}
function SyncPanel({ onApplied }: { onApplied: () => void }) {
  const [providers, setProviders] = useState<SyncProvider[] | null>(null);
  const [fetched, setFetched] = useState<SyncFetch["fetched"] | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    apiGet<{ providers: SyncProvider[] }>("/api/admin/models/sync")
      .then((d) => setProviders(d.providers ?? []))
      .catch((e: Error) => setErr(e.message));
  }, []);
  const fetchFor = async (p: SyncProvider) => {
    setErr(null);
    setBusy(true);
    try {
      const r = await postJSON<SyncFetch>("/api/admin/models/sync/fetch", { providerId: p.id, tier: "all" });
      setFetched(r.fetched);
      setTicked(new Set());
    } catch (e) { setErr(e instanceof Error ? e.message : "Fetch failed"); }
    finally { setBusy(false); }
  };
  const apply = async () => {
    if (!fetched) return;
    const add = [...fetched.additions].filter((a) => ticked.has(a.json)).map((a) => a.json);
    const change = [...fetched.changes].filter((c) => ticked.has(c.json)).map((c) => c.json);
    if (!add.length && !change.length) { setErr("Nothing ticked to apply"); return; }
    if (!window.confirm(`Apply ${add.length} addition(s) and ${change.length} change(s) for ${fetched.providerName}?`)) return;
    setErr(null);
    setBusy(true);
    try {
      await postJSON("/api/admin/models/sync/apply", { providerId: fetched.providerId, add, change });
      setFetched(null);
      setTicked(new Set());
      onApplied();
    } catch (e) { setErr(e instanceof Error ? e.message : "Apply failed"); }
    finally { setBusy(false); }
  };
  const toggle = (json: string) => setTicked((s) => { const n = new Set(s); if (n.has(json)) n.delete(json); else n.add(json); return n; });
  return (<Card title="Catalog sync" desc="Fetch a provider's upstream model list and apply the diff.">
    {err ? <p className="error" role="alert">{err}</p> : null}
    <div className="row" style={{ flexWrap: "wrap" }}>
      {(providers ?? []).map((p) => (
        <Button key={p.id} size="sm" variant="secondary" disabled={busy} onClick={() => void fetchFor(p)}>Fetch {p.name}</Button>
      ))}
      {providers && providers.length === 0 ? <span className="muted">No providers.</span> : null}
    </div>
    {fetched ? <div className="stack" style={{ gap: "var(--space-sm)", marginTop: "var(--space-md)" }}>
      <p className="meta">{fetched.providerName} · {fetched.latencyMs} ms · upstream {fetched.upstreamCount} · checked {fetched.checkedCount} · +{fetched.additions.length} ~{fetched.changes.length} -{fetched.removals.length}</p>
      {fetched.additions.map((a) => (
        <label key={a.json} className="ps-check">
          <input type="checkbox" checked={ticked.has(a.json)} onChange={() => toggle(a.json)} />
          <span><Badge tone="ok">add</Badge> {a.slug}</span>
        </label>
      ))}
      {fetched.changes.map((c) => (
        <label key={c.json} className="ps-check">
          <input type="checkbox" checked={ticked.has(c.json)} onChange={() => toggle(c.json)} />
          <span><Badge tone="warn">change</Badge> {c.slug} — {c.reasons.join("; ")}</span>
        </label>
      ))}
      {fetched.removals.map((r) => (
        <div key={r.id} className="ps-check"><Badge tone="danger">remove</Badge> {r.slug} <span className="muted">(not applied by sync)</span></div>
      ))}
      <div className="row">
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void apply()}>Apply ticked</Button>
      </div>
    </div> : null}
  </Card>);
}
function ModelsView() {
  const [tick, setTick] = useState(0);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [bulkStatus, setBulkStatus] = useState("active");
  const [modal, setModal] = useState<{ model: ModelRow | null } | null>(null);
  const { d, err } = useLoad<Models>("/api/admin/models", tick);
  const run = async (fn: () => Promise<unknown>) => { setActionErr(null); try { await fn(); setTick((n) => n + 1); } catch (e) { setActionErr(e instanceof Error ? e.message : String(e)); } };
  return (<State err={err} d={d}>{(v: Models) => {
    const needle = q.trim().toLowerCase();
    const rows = v.models.filter((m) => (!status || m.status === status) && (!needle || m.slug.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle) || m.providerName.toLowerCase().includes(needle)));
    const allSel = rows.length > 0 && rows.every((m) => sel.has(m.id));
    const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
    return (<>
      {actionErr ? <p className="error" role="alert">{actionErr}</p> : null}
      <div className="row" style={{ flexWrap: "wrap" }}>
        {Object.entries(v.counts).map(([k, n]) => <Card key={k} title={humanKey(k)} desc={String(n)} />)}
      </div>
      <h2>Per-provider</h2>
      <Table head={["Provider", "Status", "Total", "Published", "Served"]} numeric={[2, 4]} rows={v.summary.map((s) => [s.name, s.status, String(s.total), String(s.published), String(s.served)])} />
      <SyncPanel onApplied={() => setTick((n) => n + 1)} />
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
        <h2>Models</h2>
        <Button size="sm" variant="primary" onClick={() => setModal({ model: null })}>New model</Button>
      </div>
      <form className="row" onSubmit={(e) => e.preventDefault()} style={{ flexWrap: "wrap" }}>
        <Input aria-label="model filter" placeholder="filter by slug, name or provider" value={q} onChange={(e) => setQ(e.currentTarget.value)} />
        <select className="select" aria-label="status filter" style={{ width: "auto" }} value={status} onChange={(e) => setStatus(e.currentTarget.value)}>
          <option value="">All statuses</option>
          {MODEL_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </form>
      {sel.size > 0 ? <form className="row" onSubmit={(e) => { e.preventDefault(); if (!window.confirm(`Set status to ${bulkStatus} on ${sel.size} model(s)?`)) return; void run(async () => { await postJSON("/api/admin/models/bulk", { ids: [...sel], status: bulkStatus }); setSel(new Set()); }); }} style={{ flexWrap: "wrap" }}>
        <span className="meta">{sel.size} selected</span>
        <select className="select" aria-label="bulk status" style={{ width: "auto" }} value={bulkStatus} onChange={(e) => setBulkStatus(e.currentTarget.value)}>
          {MODEL_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <Button size="sm" variant="primary" type="submit">Apply status</Button>
        <Button size="sm" variant="ghost" type="button" onClick={() => setSel(new Set())}>Clear</Button>
      </form> : null}
      <Table head={["", "Slug", "Provider", "Status", "Served", "In / 1M", "Out / 1M", "Mappings", "Actions"]} numeric={[4, 5, 6, 7]} rows={rows.map((m) => [
        <input key={m.id} type="checkbox" className="mw-check" aria-label={"select " + m.slug} checked={sel.has(m.id)} onChange={() => toggle(m.id)} />,
        <span key="s" className="keys-name">{m.slug}{m.name !== m.slug ? <span className="muted"> · {m.name}</span> : null}</span>,
        m.providerName, m.status, String(m.served),
        <PriceCell key="i" model={m} field="inputPriceMicro" onApplied={() => setTick((n) => n + 1)} />,
        <PriceCell key="o" model={m} field="outputPriceMicro" onApplied={() => setTick((n) => n + 1)} />,
        String(m.mappingCount),
        <span key="a" className="row">
          <Button size="sm" variant="secondary" onClick={() => setModal({ model: m })}>Edit</Button>
          <Button size="sm" variant="destructive" onClick={() => { if (window.confirm(`Delete model ${m.slug}? Models with request history cannot be deleted.`)) void run(() => postJSON("/api/admin/models/delete", { id: m.id })); }}>Delete</Button>
        </span>,
      ])} />
      <p className="meta">{rows.length} of {v.models.length} models · <button type="button" className="usage-row-btn" onClick={() => setSel(allSel ? new Set() : new Set(rows.map((m) => m.id)))}>{allSel ? "Clear selection" : "Select all (filtered)"}</button></p>
      {modal ? <ModelModal model={modal.model} providers={v.providers} onClose={() => setModal(null)} onSaved={() => setTick((n) => n + 1)} /> : null}
    </>);
  }}</State>);
}

type Providers = { providers: { id: string; name: string; slug: string | null; description: string | null; type: string | null; status: string; tier: string; homepage: string | null; documentationUrl: string | null; enabled: boolean; priority: number; modelCount: number; connectionCount: number; credentials: { total: number; healthy: number; unknown: number; bad: number } }[] };
type ProviderRow = Providers["providers"][number];
// The server's own vocabulary (admin.mjs PROVIDER_STATUSES), not a second copy:
// a status the select offers but the server rejects is a 400 the operator
// cannot explain.
const PROVIDER_STATUSES = ["operational", "degraded", "disabled", "maintenance", "outage"];
const PROVIDER_TIERS = ["commercial", "dev"];
function ProviderModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close.current(); };
    document.addEventListener("keydown", onKey);
    box.current?.querySelector<HTMLElement>("input, select, textarea, button")?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    const f = new FormData(e.currentTarget);
    postJSON("/api/admin/providers/create", {
      name: String(f.get("name") ?? ""),
      slug: String(f.get("slug") ?? ""),
      description: String(f.get("description") ?? ""),
      type: String(f.get("type") ?? ""),
      status: String(f.get("status") ?? ""),
      tier: String(f.get("tier") ?? ""),
      homepage: String(f.get("homepage") ?? ""),
      documentationUrl: String(f.get("documentationUrl") ?? ""),
      priority: String(f.get("priority") ?? ""),
      enabled: f.get("enabled") === "on",
    })
      .then(() => { onSaved(); onClose(); })
      .catch((ex) => setErr(ex instanceof Error ? ex.message : "Create failed"))
      .finally(() => setBusy(false));
  };
  return (<div className="keys-backdrop" onClick={() => close.current()}>
    <div ref={box} className="keys-dialog" role="dialog" aria-modal="true" aria-label="New provider" onClick={(e) => e.stopPropagation()}>
      <h2 className="keys-dialog-title">New provider</h2>
      <form className="keys-form" onSubmit={submit}>
        <label className="keys-field"><span>Name</span><Input name="name" required /></label>
        <label className="keys-field"><span>Slug</span><Input name="slug" required /></label>
        <label className="keys-field"><span>Description</span><Input name="description" /></label>
        <label className="keys-field"><span>Type</span><Input name="type" placeholder="e.g. openai-compatible" /></label>
        <label className="keys-field"><span>Status</span>
          <select className="select" name="status" defaultValue="operational">
            {PROVIDER_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="keys-field"><span>Tier</span>
          <select className="select" name="tier" defaultValue="commercial">
            {PROVIDER_TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="keys-field"><span>Priority</span><Input name="priority" type="number" defaultValue="100" required /></label>
        <label className="keys-field"><span>Homepage</span><Input name="homepage" placeholder="https://…" /></label>
        <label className="keys-field"><span>Documentation URL</span><Input name="documentationUrl" placeholder="https://…" /></label>
        <label className="ps-check"><input type="checkbox" name="enabled" defaultChecked /> Enabled</label>
        {err ? <p className="error" role="alert">{err}</p> : null}
        <div className="row">
          <Button type="submit" variant="primary" disabled={busy}>{busy ? "Creating…" : "Create"}</Button>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </div>
  </div>);
}
function ProvidersView() {
  const [tick, setTick] = useState(0);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState<ProviderRow | null>(null);
  const [modal, setModal] = useState(false);
  const { d, err } = useLoad<Providers>("/api/admin/providers", tick);
  const run = async (fn: () => Promise<unknown>) => { setActionErr(null); try { await fn(); setTick((n) => n + 1); } catch (e) { setActionErr(e instanceof Error ? e.message : String(e)); } };
  return (<State err={err} d={d}>{(v: Providers) => {
    const needle = q.trim().toLowerCase();
    const rows = v.providers.filter((p) => (!status || p.status === status) && (!needle || p.name.toLowerCase().includes(needle) || (p.slug ?? "").toLowerCase().includes(needle)));
    return (<>
      {actionErr ? <p className="error" role="alert">{actionErr}</p> : null}
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
        <h2>Providers</h2>
        <Button size="sm" variant="primary" onClick={() => setModal(true)}>New provider</Button>
      </div>
      <form className="row" onSubmit={(e) => e.preventDefault()} style={{ flexWrap: "wrap" }}>
        <Input aria-label="provider filter" placeholder="filter by name or slug" value={q} onChange={(e) => setQ(e.currentTarget.value)} />
        <select className="select" aria-label="status filter" style={{ width: "auto" }} value={status} onChange={(e) => setStatus(e.currentTarget.value)}>
          <option value="">All statuses</option>
          {/* Legacy rows can carry a status outside the declared vocabulary
              (the test DB has "active"), so the options are the union: an
              observed status must stay selectable or its rows vanish. */}
          {PROVIDER_STATUSES.concat(v.providers.map((p) => p.status)).filter((s, i, all) => all.indexOf(s) === i).map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <span className="muted">Showing {rows.length} of {v.providers.length} providers</span>
      </form>
      <Table head={["Provider", "Slug", "Status", "Tier", "Prio", "Models", "Conns", "Creds ok/total/bad", "Actions"]} numeric={[4, 5, 6, 7]} rows={rows.map((p) => [
        <button key="n" type="button" className="usage-row-btn" onClick={() => setOpen(p)} aria-label={"Open details for provider " + p.name}>{p.name}</button>,
        p.slug ?? "—", p.status, p.tier, String(p.priority), String(p.modelCount), String(p.connectionCount), p.credentials.healthy + "/" + p.credentials.total + "/" + p.credentials.bad,
        <span key="a" className="row">
          {/* `disable`/`enable` are MODEL-level endpoints (disable 400s without
              a slug list; enable publishes model payloads), so the provider's
              own `enabled` flag is only writable through `update` — and update
              nulls every field it is not given, hence the full row is echoed. */}
          <Button size="sm" onClick={() => run(() => postJSON("/api/admin/providers/update", { id: p.id, name: p.name, slug: p.slug ?? "", description: p.description ?? "", type: p.type ?? "", status: p.status, tier: p.tier, homepage: p.homepage ?? "", documentationUrl: p.documentationUrl ?? "", priority: p.priority, enabled: !p.enabled }))}>{p.enabled ? "Disable" : "Enable"}</Button>
          <Button size="sm" variant="destructive" onClick={() => { if (window.confirm(`Delete provider ${p.name}? Providers with request history cannot be deleted.`)) void run(() => postJSON("/api/admin/providers/delete", { id: p.id })); }}>Delete</Button>
        </span>,
      ])} />
      {open ? <ProviderDetail provider={open} tick={tick} onClose={() => setOpen(null)} onChanged={() => setTick((n) => n + 1)} /> : null}
      {modal ? <ProviderModal onClose={() => setModal(false)} onSaved={() => setTick((n) => n + 1)} /> : null}
    </>);
  }}</State>);
}

// Detail drawer: the same backdrop/Escape idiom as the usage page's request
// drawer. The three GETs are separate endpoints (the detail handler's
// credentials are labels without ids, so the actions need the credentials
// endpoint's rows), and each is loaded independently so one failure does not
// blank the whole panel.
type ProviderDetailData = { provider: { id: string; name: string; slug: string | null; description: string | null; type: string | null; status: string; tier: string; homepage: string | null; documentationUrl: string | null; enabled: boolean; baseUrl: string | null; priority: number; createdAt: string }; connections: { id: string; name: string; slug: string | null; baseUrl: string; region: string | null; authType: string; timeoutMs: number; priority: number; enabled: boolean; healthStatus: string }[]; credentials: { count: number; labels: { label: string; index: number; status: string; connection: string }[]; healthy: number; unknown: number; bad: number; cooldown: number } };
type ProviderConnections = { provider: { id: string; name: string }; connections: { id: string; name: string; slug: string | null; baseUrl: string; region: string | null; authType: string; timeoutMs: number; priority: number; enabled: boolean; healthStatus: string; credentialCount: number; credentialHealthy: number }[] };
type ProviderCredentials = { provider: { id: string; name: string }; connections: { id: string; name: string; slug: string | null }[]; credentials: { id: string; connectionId: string; name: string; status: string; priority: number; weight: number; lastUsedAt: string | null; lastSuccessAt: string | null; lastErrorAt: string | null; cooldownUntil: string | null; metadata: unknown; createdAt: string; updatedAt: string; connectionName: string }[]; pool: { total: number; buckets: Record<string, number> } };
// Raw `select *` rows: Postgres column names, not the camelCase the
// drizzle-typed endpoints return.
type Breakers = { breakers: { id: string; target: string; target_id: string; failure_threshold: number; window_seconds: number; open_ms: number; half_open_probes: number; enabled: boolean; state: string }[] };
const CRED_TONE: Record<string, "ok" | "warn" | "danger" | "default"> = { healthy: "ok", rate_limited: "warn", cooldown: "warn", auth_failed: "danger", invalid: "danger", disabled: "default", unknown: "default" };
function ProviderDetail({ provider, tick, onClose, onChanged }: { provider: ProviderRow; tick: number; onClose: () => void; onChanged: () => void }) {
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rotating, setRotating] = useState<ProviderCredentials["credentials"][number] | null>(null);
  const [newSecret, setNewSecret] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close.current(); };
    document.addEventListener("keydown", onKey);
    box.current?.querySelector<HTMLElement>("button")?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  // `tick` is the parent's reload counter: without it every action inside the
  // drawer (revoke, rotate, validate) would leave the panel showing the state
  // from before the click until it was closed and reopened.
  const detail = useLoad<ProviderDetailData>("/api/admin/providers/" + provider.id, tick);
  const conns = useLoad<ProviderConnections>("/api/admin/providers/" + provider.id + "/connections", tick);
  const creds = useLoad<ProviderCredentials>("/api/admin/providers/" + provider.id + "/credentials", tick);
  const breakers = useLoad<Breakers>("/api/admin/routing/circuit-breakers", tick);
  const health = useLoad<Health>("/api/admin/health", tick);
  // Returns false when the server rejected the action, so callers can keep the
  // operator's typed secret in place instead of clearing it on a failure.
  const run = async (fn: () => Promise<unknown>) => { setActionErr(null); setBusy(true); try { await fn(); onChanged(); return true; } catch (e) { setActionErr(e instanceof Error ? e.message : String(e)); return false; } finally { setBusy(false); } };
  return (<div className="usage-drawer-backdrop" onClick={onClose}>
    <div ref={box} className="usage-drawer usage-drawer--wide" role="dialog" aria-modal="true" aria-label={"Provider " + provider.name} onClick={(e) => e.stopPropagation()}>
      <div className="row usage-drawer-head">
        <h3>{provider.name}</h3>
        <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
      </div>
      {actionErr ? <p className="error" role="alert">{actionErr}</p> : null}
      {notice ? <p className="ps-ok" role="status">{notice}</p> : null}
      <State err={detail.err} d={detail.d}>{(v: ProviderDetailData) => (<>
        <h4>Provider</h4>
        <dl className="usage-drawer-grid">
          <dt>Slug</dt><dd>{v.provider.slug ?? "—"}</dd>
          <dt>Status</dt><dd>{v.provider.status}</dd>
          <dt>Tier</dt><dd>{v.provider.tier}</dd>
          <dt>Priority</dt><dd className="num">{v.provider.priority}</dd>
          <dt>Enabled</dt><dd>{v.provider.enabled ? "yes" : "no"}</dd>
          <dt>Type</dt><dd>{v.provider.type ?? "—"}</dd>
          <dt>Base URL</dt><dd>{v.provider.baseUrl ?? "—"}</dd>
          <dt>Homepage</dt><dd>{v.provider.homepage ?? "—"}</dd>
          <dt>Docs</dt><dd>{v.provider.documentationUrl ?? "—"}</dd>
          <dt>Created</dt><dd>{fmtDate(v.provider.createdAt)}</dd>
        </dl>
        {v.provider.description ? <p className="muted">{v.provider.description}</p> : null}
      </>)}</State>
      <h4>Connections</h4>
      <State err={conns.err} d={conns.d}>{(v: ProviderConnections) => (
        v.connections.length === 0 ? <p className="muted">No connections.</p> : (
          <Table head={["Connection", "Base URL", "Region", "Prio", "Enabled", "Health", "Creds ok/total"]} numeric={[3, 6]} rows={v.connections.map((c) => [c.name, c.baseUrl, c.region ?? "—", String(c.priority), String(c.enabled), c.healthStatus, c.credentialHealthy + "/" + c.credentialCount])} />
        )
      )}</State>
      <h4>Credentials</h4>
      <State err={creds.err} d={creds.d}>{(v: ProviderCredentials) => {
        // testCredential probes the FIRST connection's pool by POSITION
        // (admin.mjs: it picks that connection ordered by priority,id and
        // validates `body.index`), not by credential id. Reproduce both
        // orderings so a click can never probe a different key: connection by
        // (priority, id), then credentials by (priority, id) — not the
        // credentials endpoint's (priority, name).
        const byPriorityId = (a: { id: string; priority: number }, b: { id: string; priority: number }) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        const probeConn = [...(conns.d?.connections ?? [])].sort(byPriorityId)[0]?.id ?? "";
        const probePool = v.credentials.filter((c) => c.connectionId === probeConn).sort(byPriorityId);
        return (<>
        {v.credentials.length === 0 ? <p className="muted">No credentials.</p> : (
          <Table head={["Name", "Key", "Status", "Last success", "Cooldown", "Prio", "Actions"]} numeric={[5]} rows={v.credentials.map((c) => {
            const index = probePool.findIndex((x) => x.id === c.id);
            return [
              <span key="n" className="keys-name">{c.name}</span>,
              // The endpoints never return key material — only the name and
              // status — so the mask is the whole display, not a redaction.
              <code key="k" className="keys-prefix">••••••••••••</code>,
              <Badge key="s" tone={CRED_TONE[c.status] ?? "default"}>{c.status}</Badge>,
              <span key="v">{c.lastSuccessAt ? fmtDate(c.lastSuccessAt) : c.lastUsedAt ? "used " + fmtDate(c.lastUsedAt) : "—"}</span>,
              <span key="q">{c.cooldownUntil && new Date(c.cooldownUntil).getTime() > Date.now() ? "until " + fmtDate(c.cooldownUntil) : "—"}</span>,
              <span key="p" className="num">{c.priority}</span>,
              <span key="a" className="row">
                <Button size="sm" variant="secondary" disabled={busy || index < 0} title={index < 0 ? "Validation probes the first connection's pool only" : undefined} onClick={() => void (async () => {
                  setActionErr(null); setNotice(null); setBusy(true);
                  try {
                    const r = await postJSON<{ credentialTest: { label: string; ok: boolean; status: number | null; latencyMs: number; modelCount: number; error: string | null } }>("/api/admin/providers/" + provider.id + "/testCredential", { providerId: provider.id, index });
                    const t = r.credentialTest;
                    setNotice(t.ok ? `Validated ${t.label}: HTTP ${t.status} · ${t.modelCount} models · ${t.latencyMs} ms` : `Validate failed for ${t.label}: ${t.error ?? "HTTP " + t.status}`);
                    onChanged();
                  } catch (e) { setActionErr(e instanceof Error ? e.message : String(e)); }
                  finally { setBusy(false); }
                })()}>Validate</Button>
                <Button size="sm" disabled={busy} onClick={() => { setRotating(c); setNewSecret(""); setActionErr(null); setNotice(null); }}>Rotate</Button>
                <Button size="sm" variant="destructive" disabled={busy} onClick={() => { if (window.confirm(`Revoke credential ${c.name}? It stops being used for routing immediately.`)) void run(() => postJSON("/api/admin/providers/credentials/revoke", { id: c.id, confirm: "on" })); }}>Revoke</Button>
              </span>,
            ];
          })} />
        )}
        <form className="keys-form" onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const f = new FormData(form);
          // The response echoes `secretOnce`; it is deliberately dropped — the
          // operator just typed the secret, and it must not reach the DOM.
          void run(() => postJSON("/api/admin/providers/credentials/create", {
            providerId: provider.id,
            connectionId: String(f.get("connectionId") ?? ""),
            name: String(f.get("name") ?? ""),
            secret: String(f.get("secret") ?? ""),
            priority: String(f.get("priority") ?? ""),
            weight: String(f.get("weight") ?? ""),
          })).then((ok) => { if (ok) form.reset(); });
        }}>
          <h4>Add credential</h4>
          <label className="keys-field"><span>Connection</span>
            <select className="select" name="connectionId" required defaultValue={v.connections[0]?.id ?? ""}>
              {v.connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="keys-field"><span>Name</span><Input name="name" required /></label>
          <label className="keys-field"><span>Secret</span><Input name="secret" type="password" autoComplete="off" required /></label>
          <label className="keys-field"><span>Priority</span><Input name="priority" type="number" defaultValue="100" required /></label>
          <label className="keys-field"><span>Weight</span><Input name="weight" type="number" defaultValue="100" required /></label>
          <Button type="submit" variant="primary" size="sm" disabled={busy || v.connections.length === 0}>Add credential</Button>
          {v.connections.length === 0 ? <span className="muted">A connection is required before a credential can be added.</span> : null}
        </form>
        </>);
      }}</State>
      {rotating ? (<div className="keys-form">
        <h4>Rotate {rotating.name}</h4>
        <label className="keys-field"><span>New secret</span><Input type="password" autoComplete="off" value={newSecret} onChange={(e) => setNewSecret(e.currentTarget.value)} /></label>
        <div className="row">
          <Button size="sm" variant="primary" disabled={busy || !newSecret.trim()} onClick={() => {
            if (!window.confirm(`Rotate credential ${rotating.name}? The current secret stops working immediately.`)) return;
            // `secretOnce` in the response is dropped on purpose (see create).
            void run(() => postJSON("/api/admin/providers/credentials/rotate", { id: rotating.id, secret: newSecret, confirm: "on" })).then((ok) => { if (ok) { setRotating(null); setNewSecret(""); } });
          }}>Rotate</Button>
          <Button size="sm" variant="ghost" onClick={() => setRotating(null)}>Cancel</Button>
        </div>
      </div>) : null}
      <h4>Circuit breakers</h4>
      <State err={breakers.err} d={breakers.d}>{(v: Breakers) => {
        const rows = v.breakers.filter((x) => x.target === "provider" && x.target_id === provider.id);
        return rows.length === 0 ? <p className="muted">No breaker configured for this provider.</p> : (
          <Table head={["State", "Failures", "Window s", "Open ms", "Half-open probes", "Enabled"]} numeric={[1, 2, 3, 4]} rows={rows.map((b) => [b.state, String(b.failure_threshold), String(b.window_seconds), String(b.open_ms), String(b.half_open_probes), String(b.enabled)])} />
        );
      }}</State>
      <h4>Observed outcomes (24h)</h4>
      <State err={health.err} d={health.d}>{(v: Health) => {
        const p = v.providers.find((x) => x.id === provider.id);
        if (!p) return <p className="muted">No requests logged for this provider in the last 24h.</p>;
        return (<>
          <Table head={["Requests / successes", "p95 ms", "Error mix"]} numeric={[0, 1, 2]} rows={[[p.requests + " / " + p.successes, String(p.p95), p.errorMix.map((e) => e.code + "×" + e.n).join(", ") || "—"]]} />
          {/* The health endpoint aggregates the 24h window per provider and
              carries no hourly series, so a per-hour chart would be drawn from
              invented points. The aggregates are the honest surface. */}
          <p className="muted">Hourly latency and error series are not available — the health endpoint reports 24h aggregates only.</p>
        </>);
      }}</State>
    </div>
  </div>);
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
      <Table head={["ID", "At", "User", "Model", "Provider", "Status", "Latency", "Tokens", "Cost"]} numeric={[6, 7, 8]} rows={v.rows.map((r) => [r.id.slice(0, 12) + "…", fmtDate(r.createdAt), r.email ?? "—", r.modelSlug ?? r.requestedModel ?? "—", r.providerName ?? "—", r.errorCode ? r.status + ":" + r.errorCode : r.status, String(r.latencyMs), (r.tokensIn + r.tokensOut).toString(), fmtUsd(r.cost)])} />
    )}</State>
  </>);
}

type Routing = { policies: { id: string; name: string; strategy: string; enabled: boolean; maxAttempts: number; fallbackEnabled: boolean; scope: string; scopeName: string }[]; chain: { account: string; policyId: string | null; policyName: string | null }[]; platformDefaultId: string | null; platformDefaultName: string | null };
function RoutingView() {
  const { d, err } = useLoad<Routing>("/api/admin/routing");
  return (<State err={err} d={d}>{(v: Routing) => (<>
    <Card titleAs="h2" title="Platform default" desc={v.platformDefaultName ?? v.platformDefaultId ?? "none"} />
    <h2>Policies</h2>
    <Table head={["Name", "Scope", "Strategy", "Enabled", "Attempts", "Fallback"]} numeric={[4]} rows={v.policies.map((p) => [p.name, p.scopeName, p.strategy, String(p.enabled), String(p.maxAttempts), String(p.fallbackEnabled)])} />
    <h2>Resolution chain (account → policy)</h2>
    <Table head={["Account", "Policy"]} rows={v.chain.map((c) => [c.account, c.policyName ?? "—"])} />
  </>)}</State>);
}

type Security = { rules: { id: string; name: string; kind: string; config: unknown; enabled: boolean; action: string }[] };
type Audit = { rows: { id: string; actorUserId: string | null; actorKind: string; actorEmail: string | null; action: string; resource: string | null; resourceId: string | null; ip: string | null; before: unknown; after: unknown; metadata: unknown; createdAt: string }[]; actions: { action: string; n: number }[]; page: number; action: string };
function SecurityView() {
  const { d, err } = useLoad<Security>("/api/admin/security");
  const [page, setPage] = useState(1);
  const [action, setAction] = useState("");
  const qs = "/api/admin/security/audit-log?page=" + page + (action ? "&action=" + encodeURIComponent(action) : "");
  const a = useLoad<Audit>(qs);
  // before/after are arbitrary JSON or null, so a raw interpolation would print
  // "null → null" for every create/delete row; collapse both sides to "—".
  const changes = (x: unknown) => x == null ? "—" : JSON.stringify(x).slice(0, 80);
  return (<State err={err} d={d}>{(v: Security) => (<>
    <Table head={["Name", "Kind", "Action", "Enabled", "Config"]} rows={v.rules.map((r) => [r.name, r.kind, r.action, String(r.enabled), JSON.stringify(r.config)])} />
    <h2>Audit log</h2>
    <form className="row" onSubmit={(e) => e.preventDefault()}>
      <select aria-label="Filter by action" value={action} onChange={(e) => { setAction(e.currentTarget.value); setPage(1); }}>
        <option value="">All actions</option>
        {a.d ? a.d.actions.map((x) => <option key={x.action} value={x.action}>{x.action} ({x.n})</option>) : null}
      </select>
    </form>
    <State err={a.err} d={a.d}>{(w: Audit) => (<>
      <Table head={["At", "Actor", "Action", "Resource", "IP", "Changes"]} rows={w.rows.map((r) => {
        const b = changes(r.before); const f = changes(r.after);
        return [fmtDate(r.createdAt), r.actorEmail ?? r.actorKind, r.action, (r.resource ?? "—") + (r.resourceId ? "/" + r.resourceId : ""), r.ip ?? "—", b === "—" && f === "—" ? "—" : b + " → " + f];
      })} />
      <div className="row">
        <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Prev</Button>
        <span className="muted">Page {w.page}</span>
        {/* The endpoint reports no total, so a short page is the only end-of-data signal. */}
        <Button size="sm" disabled={w.rows.length < 100} onClick={() => setPage((p) => p + 1)}>Next</Button>
      </div>
    </>)}</State>
  </>)}</State>);
}

type Settings = { maintenance: boolean; genericPassthrough: boolean; registration: boolean; retention: Record<string, number>; defaultRoutingPolicyId: string; hardLimits: { rpm: number; tpm: number; concurrency: number }; policies: { id: string; name: string; strategy: string }[]; accounts: { userId: string; warningMicro: string; hardStopMicro: string }[] };
type Flags = { flags: { id: string; name: string; description: string; enabled: boolean; rollout: unknown; updatedAt: string }[] };
function SettingsView() {
  const [tick, setTick] = useState(0);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const { d, err } = useLoad<Settings>("/api/admin/settings", tick);
  const f = useLoad<Flags>("/api/admin/settings/feature-flags", tick);
  const run = async (fn: () => Promise<unknown>) => { setActionErr(null); try { await fn(); setTick((n) => n + 1); } catch (e) { setActionErr(e instanceof Error ? e.message : String(e)); } };
  // v arrives asynchronously, so each form reads its values from FormData on
  // submit rather than mirroring them into state that would go stale on refetch
  // (useLoad nulls d while reloading, which remounts the forms with fresh defaults).
  const usd = (micro: string) => { try { return (BigInt(micro) / 1000000n).toString(); } catch { return "0"; } };
  const submit = (path: string, build: (fd: FormData) => unknown) => (e: React.FormEvent<HTMLFormElement>) => { e.preventDefault(); run(() => postJSON(path, build(new FormData(e.currentTarget)))); };
  const on = (fd: FormData, k: string) => fd.get(k) === "on";
  return (<State err={err} d={d}>{(v: Settings) => (<>
    {actionErr ? <p className="error" role="alert">{actionErr}</p> : null}
    <h2>General</h2>
    <form className="row" onSubmit={submit("/api/admin/settings/updateGeneral", (fd) => ({ maintenance: on(fd, "maintenance"), generic_passthrough: on(fd, "generic_passthrough") }))}>
      <label className="row"><input type="checkbox" name="maintenance" defaultChecked={v.maintenance} /> maintenance</label>
      <label className="row"><input type="checkbox" name="generic_passthrough" defaultChecked={v.genericPassthrough} /> generic_passthrough</label>
      <Button size="sm" type="submit">Save</Button>
    </form>
    <h2>Registration</h2>
    <form className="row" onSubmit={submit("/api/admin/settings/updateRegistration", (fd) => ({ registration: on(fd, "registration") }))}>
      <label className="row"><input type="checkbox" name="registration" defaultChecked={v.registration} /> open registration</label>
      <Button size="sm" type="submit">Save</Button>
    </form>
    <h2>Retention (days)</h2>
    <form className="row" onSubmit={submit("/api/admin/settings/updateRetention", (fd) => ({ request_metadata_days: fd.get("request_metadata_days"), request_content_days: fd.get("request_content_days"), system_events_days: fd.get("system_events_days"), audit_logs_days: fd.get("audit_logs_days") }))}>
      {Object.entries(v.retention).map(([k, n]) => <Input key={k} aria-label={k} name={k} type="number" defaultValue={String(n)} />)}
      <Button size="sm" type="submit">Save</Button>
    </form>
    <h2>Default routing policy</h2>
    <form className="row" onSubmit={submit("/api/admin/settings/updateDefaultRouting", (fd) => ({ policyId: fd.get("policyId") }))}>
      <select aria-label="Default routing policy" name="policyId" defaultValue={v.defaultRoutingPolicyId}>
        {v.policies.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <Button size="sm" type="submit">Save</Button>
    </form>
    <h2>Hard limits</h2>
    <form className="row" onSubmit={submit("/api/admin/settings/updateHardLimits", (fd) => ({ rpm: fd.get("rpm"), tpm: fd.get("tpm"), concurrency: fd.get("concurrency") }))}>
      <Input aria-label="rpm" name="rpm" type="number" defaultValue={String(v.hardLimits.rpm)} />
      <Input aria-label="tpm" name="tpm" type="number" defaultValue={String(v.hardLimits.tpm)} />
      <Input aria-label="concurrency" name="concurrency" type="number" defaultValue={String(v.hardLimits.concurrency)} />
      <Button size="sm" type="submit">Save</Button>
    </form>
    <h2>Billing defaults</h2>
    <form className="row" onSubmit={submit("/api/admin/settings/setBillingDefaults", (fd) => ({ warningUsd: fd.get("warningUsd"), hardStopUsd: fd.get("hardStopUsd") }))}>
      <Input aria-label="Warning USD" name="warningUsd" defaultValue={usd(v.accounts[0]?.warningMicro ?? "0")} />
      <Input aria-label="Hard stop USD" name="hardStopUsd" defaultValue={usd(v.accounts[0]?.hardStopMicro ?? "0")} />
      <Button size="sm" type="submit">Save</Button>
    </form>
    <h2>Routing policies</h2>
    <Table head={["Name", "Strategy"]} rows={v.policies.map((p) => [p.name, p.strategy])} />
    <h2>Feature flags</h2>
    <State err={f.err} d={f.d}>{(w: Flags) => (<>
      <Table head={["Name", "Description", "Enabled", "Rollout", "Updated", "Actions"]} numeric={[3]} rows={w.flags.map((x) => [x.name, x.description, String(x.enabled), JSON.stringify(x.rollout), fmtDate(x.updatedAt),
        <span key={x.id} className="row">
          <Button size="sm" onClick={() => run(() => postJSON("/api/admin/settings/feature-flags/toggle", { id: x.id }))}>{x.enabled ? "Disable" : "Enable"}</Button>
          <Button size="sm" variant="destructive" onClick={() => { if (window.confirm("Delete feature flag " + x.name + "?")) run(() => postJSON("/api/admin/settings/feature-flags/delete", { id: x.id })); }}>Delete</Button>
        </span>])} />
      <form className="row" onSubmit={submit("/api/admin/settings/feature-flags/create", (fd) => ({ name: fd.get("name"), description: fd.get("description"), enabled: on(fd, "enabled"), rollout: fd.get("rollout") }))}>
        <Input aria-label="Flag name" name="name" placeholder="name" />
        <Input aria-label="Flag description" name="description" placeholder="description" />
        <Input aria-label="Rollout JSON" name="rollout" defaultValue="{}" />
        <label className="row"><input type="checkbox" name="enabled" /> enabled</label>
        <Button size="sm" type="submit">Create</Button>
      </form>
    </>)}</State>
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
    <Table head={["Status", "Count"]} numeric={[1]} rows={v.jobCounts.map((j) => [j.status, String(j.n)])} />
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

// The server validates setRole against ROLE_CAPS (admin.mjs), so the select's
// options come from that same table rather than a second copy in this file.
const ROLES = Object.keys(ROLE_CAPS);
type Users = { users: { id: string; name: string; email: string; role: string | null; banned: boolean | null; firstRequestAt: string | null; keys: number; requests: number; cost: string; lastSeenAt: string | null; createdAt: string }[] };
function UsersView() {
  const [tick, setTick] = useState(0);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [q, setQ] = useState(""); const [role, setRole] = useState(""); const [status, setStatus] = useState("");
  const [sel, setSel] = useState<string[]>([]); const [bulkRole, setBulkRole] = useState(ROLES[0]);
  const { d, err } = useLoad<Users>("/api/admin/users", tick);
  const run = async (fn: () => Promise<unknown>) => { setActionErr(null); try { await fn(); setTick((n) => n + 1); } catch (e) { setActionErr(e instanceof Error ? e.message : String(e)); } };
  // The endpoint takes no params, so filtering is client-side over the loaded
  // list; the ids are re-derived per render so a refetch drops stale selections.
  const filtered = (v: Users) => v.users.filter((u) => {
    const needle = q.trim().toLowerCase();
    if (needle && !(u.email.toLowerCase().includes(needle) || u.name.toLowerCase().includes(needle))) return false;
    if (role && u.role !== role) return false;
    if (status === "banned" && !u.banned) return false;
    if (status === "active" && !!u.banned) return false;
    return true;
  });
  const active = [q.trim() ? 1 : 0, role ? 1 : 0, status ? 1 : 0].reduce((a, b) => a + b, 0);
  const reset = () => { setQ(""); setRole(""); setStatus(""); setSel([]); };
  // Sequential, not parallel: each handler writes an audit row in its own
  // transaction and a burst on one pool is needless contention. A refusal
  // (self-targeting, privilege escalation) stops the batch and surfaces.
  const bulk = async (fn: (id: string) => Promise<unknown>) => {
    setActionErr(null);
    try { for (const id of sel) await fn(id); setSel([]); setTick((n) => n + 1); }
    catch (e) { setActionErr(e instanceof Error ? e.message : String(e)); }
  };
  return (<State err={err} d={d}>{(v: Users) => {
    const rows = filtered(v);
    const ids = rows.map((u) => u.id);
    const allSel = ids.length > 0 && ids.every((id) => sel.includes(id));
    const bannedSel = sel.filter((id) => v.users.find((u) => u.id === id)?.banned).length;
    return (<>
    {actionErr ? <p className="error" role="alert">{actionErr}</p> : null}
    <form className="row" onSubmit={(e) => e.preventDefault()}>
      <Input aria-label="search users" placeholder="Search email or name" value={q} onChange={(e) => setQ(e.currentTarget.value)} />
      <select className="select" aria-label="role filter" value={role} onChange={(e) => setRole(e.currentTarget.value)}>
        <option value="">All roles</option>
        {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
      </select>
      <select className="select" aria-label="status filter" value={status} onChange={(e) => setStatus(e.currentTarget.value)}>
        <option value="">All statuses</option>
        <option value="active">Active</option>
        <option value="banned">Banned</option>
      </select>
      {active > 0 ? <Button size="sm" variant="ghost" onClick={reset}>Reset</Button> : null}
      <span className="muted">Showing {rows.length} of {v.users.length} users</span>
    </form>
    {sel.length > 0 ? (
      <div className="row" role="group" aria-label="Bulk actions">
        <span className="muted">{sel.length} selected</span>
        <select className="select" aria-label="bulk role" value={bulkRole} onChange={(e) => setBulkRole(e.currentTarget.value)}>
          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <Button size="sm" onClick={() => bulk((id) => postJSON("/api/admin/users/setRole", { id, role: bulkRole }))}>Set role</Button>
        <Button size="sm" onClick={() => bulk((id) => postJSON("/api/admin/users/toggleBan", { id }))}>{bannedSel * 2 > sel.length ? "Unban" : "Ban"} {sel.length}</Button>
        <Button size="sm" variant="ghost" onClick={() => setSel([])}>Clear</Button>
      </div>
    ) : null}
    {rows.length === 0 ? (
      <div className="ps-empty">
        <p className="muted">No users match these filters</p>
        <Button size="sm" variant="secondary" onClick={reset}>Reset</Button>
      </div>
    ) : (
    <Table head={[<input key="all" type="checkbox" aria-label="Select all filtered users" checked={allSel} onChange={(e) => setSel(e.currentTarget.checked ? ids : [])} />, "Email", "Name", "Role", "Banned", "Keys", "Req", "Cost", "Last activity", "Actions"]} numeric={[5, 6, 7]} rows={rows.map((u) => [
      <input key={u.id} type="checkbox" aria-label={"Select " + u.email} checked={sel.includes(u.id)} onChange={(e) => setSel((s) => e.currentTarget.checked ? [...s, u.id] : s.filter((x) => x !== u.id))} />,
      u.email, u.name,
      <select key={u.id} value={u.role ?? ""} onChange={(e) => run(() => postJSON("/api/admin/users/setRole", { id: u.id, role: e.currentTarget.value }))}>
        {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
      </select>,
      String(!!u.banned), String(u.keys), String(u.requests), fmtUsd(u.cost), u.lastSeenAt ? fmtDate(u.lastSeenAt) : "—",
      <span key={u.id} className="row">
        <Button size="sm" onClick={() => run(() => postJSON("/api/admin/users/toggleBan", { id: u.id }))}>{u.banned ? "Unban" : "Ban"}</Button>
        <Button size="sm" onClick={() => { if (window.confirm("Suspend " + u.email + "? Their sessions are revoked.")) run(() => postJSON("/api/admin/users/suspend", { id: u.id, confirm: "on" })); }}>Suspend</Button>
        <Button size="sm" onClick={() => { if (window.confirm("Disable all access for " + u.email + "? This also disables every API key they own.")) run(() => postJSON("/api/admin/users/disableAccess", { id: u.id, confirm: "on" })); }}>Disable access</Button>
      </span>])} />
    )}
    </>)}}</State>);
}

const VIEWS: Record<string, { lede: string; el: () => ReactNode }> = {
  analytics: { lede: "Usage rollups with request-log fallback and exact latency percentiles.", el: AnalyticsView },
  billing: { lede: "Billing accounts, credit ledger, and invoices.", el: BillingView },
  connections: { lede: "Provider connections and credential health. Secrets never leave the server.", el: ConnectionsView },
  health: { lede: "Observed provider and connection health over the last 24h.", el: HealthView },
  incidents: { lede: "Status-page incidents with timelines.", el: IncidentsView },
  keys: { lede: "API key metadata and per-key usage. Hashes never leave the server.", el: KeysView },
  models: { lede: "Model catalog, effective prices, and publish state.", el: ModelsView },
  providers: { lede: "Providers with model, connection, and credential counts.", el: ProvidersView },
  requests: { lede: "Request log. Bodies never cross this boundary.", el: RequestsView },
  routing: { lede: "Routing policies and the account resolution chain.", el: RoutingView },
  security: { lede: "Abuse-signal rules. Enforcement lists live on their own pages.", el: SecurityView },
  settings: { lede: "Platform settings, retention, limits, and billing defaults.", el: SettingsView },
  system: { lede: "Database, queue backlog, incidents, and events.", el: SystemView },
  traffic: { lede: "Platform hard limits — the ceiling every scope is capped by.", el: TrafficView },
  users: { lede: "Accounts with usage and activity.", el: UsersView },
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

const LIST_KEYS = ["incidents", "connections", "providers", "models", "users", "keys", "policies", "rules", "rows", "accounts", "recent", "topConsumers", "openIncidents", "events"] as const;
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
