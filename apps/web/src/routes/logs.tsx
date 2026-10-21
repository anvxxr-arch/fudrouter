import { useEffect, useState } from "react";
import { apiGet } from "../lib/server";
import { ConsoleLayout } from "../components/ConsoleLayout";
import { Button } from "../components/ui/button";
import { Table } from "../components/ui/table";

// House style mirrors dashboard.tsx: local Page/useLoad/LoadState/fmtDate so
// the page stays self-contained until registration wires it into a shared
// module (Phase 2 owns that move).
function Page({ title, lede, children }: { title: string; lede: string; children?: React.ReactNode }) {
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

// The server's closed status vocabulary (pages.mjs REQUEST_STATUSES, mirrored
// from admin.mjs): normalizeStatus can return `error`/`upstream_error`, so the
// filter must offer every value the table can display.
const LOG_STATUSES = ["success", "client_error", "provider_error", "timeout", "rate_limited", "cancelled", "internal_error", "error", "upstream_error"];
const LOG_DAYS = [1, 7, 30, 90];

type LogRow = { id: string; createdAt: string; requestedModel: string | null; modelSlug: string | null; providerName: string | null; attempts: number; fallbackUsed: boolean; tokensIn: number; tokensOut: number; costMicro: string; latencyMs: number; ttftMs: number | null; status: string; errorCode: string | null };
type LogData = { rows: LogRow[]; total: number; page: number; pages: number };

const TABS = ["Requests", "Console", "Activity"] as const;
type Tab = (typeof TABS)[number];

// The account request log has no per-id detail endpoint (the project-scoped
// one died with /api/pages/projects/**), so the drawer renders the row the
// list already returned: every field here is on LogRow, nothing invented.
function RequestDetailDrawer({ row, onClose }: { row: LogRow; onClose: () => void }) {
  return (<div className="usage-drawer-backdrop" onClick={onClose}>
    <div className="usage-drawer" role="dialog" aria-modal="true" aria-label="Request details" onClick={(e) => e.stopPropagation()}>
      <div className="row usage-drawer-head">
        <h3>Request</h3>
        <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
      </div>
      <p className="usage-drawer-id"><code>{row.id}</code></p>
      <dl className="usage-drawer-grid">
        <dt>Created</dt><dd>{fmtDate(row.createdAt)}</dd>
        <dt>Status</dt><dd>{row.status}</dd>
        <dt>Requested model</dt><dd>{row.requestedModel ?? "—"}</dd>
        <dt>Served model</dt><dd>{row.modelSlug ?? "—"}</dd>
        <dt>Provider</dt><dd>{row.providerName ?? "—"}</dd>
        <dt>Attempts</dt><dd>{row.attempts}{row.fallbackUsed ? " (fallback used)" : ""}</dd>
        <dt>Tokens in</dt><dd>{row.tokensIn}</dd>
        <dt>Tokens out</dt><dd>{row.tokensOut}</dd>
        <dt>Cost</dt><dd>{fmtMicro(row.costMicro)}</dd>
        <dt>Latency</dt><dd>{row.latencyMs} ms</dd>
        <dt>TTFT</dt><dd>{row.ttftMs == null ? "—" : `${row.ttftMs} ms`}</dd>
        <dt>Error code</dt><dd>{row.errorCode ?? "—"}</dd>
      </dl>
    </div>
  </div>);
}

function RequestsTab() {
  const [days, setDays] = useState(30);
  const [filters, setFilters] = useState({ status: "", model: "", key: "" });
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<LogRow | null>(null);
  const qs = new URLSearchParams({ days: String(days) });
  if (filters.status) qs.set("status", filters.status);
  if (filters.model) qs.set("model", filters.model);
  if (filters.key) qs.set("key", filters.key);
  const query = qs.toString();
  const { data: log, error, loading } = useLoad<LogData>(`/api/pages/dashboard/usage/requests?${query}&page=${page}`);
  const setFilter = (k: "status" | "model" | "key", v: string) => { setFilters((f) => ({ ...f, [k]: v })); setPage(1); };
  const reset = () => { setFilters({ status: "", model: "", key: "" }); setPage(1); };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (<>
    <div className="row" style={{ flexWrap: "wrap" }}>
      {LOG_DAYS.map((n) => (<Button key={n} size="sm" variant={days === n ? "primary" : "secondary"} onClick={() => { setDays(n); setPage(1); }}>{n}d</Button>))}
      <select className="usage-select" aria-label="Filter by status" value={filters.status} onChange={(e) => setFilter("status", e.target.value)}>
        <option value="">All statuses</option>
        {LOG_STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
      </select>
      <input className="usage-select" style={{ width: "14rem" }} aria-label="Filter by model" placeholder="Model id or slug" value={filters.model} onChange={(e) => setFilter("model", e.target.value)} />
      <input className="usage-select" style={{ width: "14rem" }} aria-label="Filter by API key" placeholder="API key id" value={filters.key} onChange={(e) => setFilter("key", e.target.value)} />
      <Button size="sm" variant="ghost" onClick={reset}>Reset</Button>
    </div>
    <p className="muted">{log ? `${log.total} requests · page ${log.page} of ${log.pages}` : ""}</p>
    <LoadState loading={loading} error={error} />
    <Table head={["Time", "Model", "Provider", "Tokens in/out", "Cost", "Latency", "Status"]} rows={(log?.rows ?? []).map((r) => [
      <button key={r.id} type="button" className="usage-row-btn" onClick={() => setOpen(r)} aria-label={`Open details for request ${r.id}`}>{fmtDate(r.createdAt)}</button>,
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
    {open ? <RequestDetailDrawer row={open} onClose={() => setOpen(null)} /> : null}
  </>);
}

export function LogsPage() {
  const [tab, setTab] = useState<Tab>("Requests");
  return (<ConsoleLayout><Page title="Logs" lede="Requests, console and activity.">
    <div role="tablist" aria-label="Log views" className="row">
      {TABS.map((t) => (
        <Button
          key={t}
          size="sm"
          variant={tab === t ? "primary" : "secondary"}
          role="tab"
          aria-selected={tab === t}
          onClick={() => setTab(t)}
        >{t}</Button>
      ))}
    </div>
    <div role="tabpanel" aria-label={`${tab} view`}>
      {tab === "Requests" ? <RequestsTab /> : (
        <div className="card">
          <h3 className="card-title">{tab}</h3>
          <p className="muted">{tab === "Console"
            ? "Application console logs are not exposed to members."
            : "Account activity is not exposed to members."}</p>
        </div>
      )}
    </div>
    <p className="muted">Request logs are retained for 90 days.</p>
  </Page></ConsoleLayout>);
}
