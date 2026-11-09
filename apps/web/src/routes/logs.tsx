import { Fragment, useEffect, useState } from "react";
import { apiGet } from "../lib/server";
import { ConsoleLayout } from "../components/ConsoleLayout";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";

// House style mirrors dashboard.tsx: local Page/useLoad/LoadState/fmtDate so
// the page stays self-contained until registration wires it into a shared
// module.
function Page({ title, lede, children }: { title: string; lede: string; children?: React.ReactNode }) {
  return (<div className="grid gap-6"><h1>{title}</h1><p className="measure text-base text-muted-foreground">{lede}</p>{children}</div>);
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
  if (loading) return <p className="text-muted-foreground" role="status" aria-live="polite">Loading…</p>;
  if (error) return <p className="error-text">{error}</p>;
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
  const details: [string, string][] = [
    ["Created", fmtDate(row.createdAt)],
    ["Status", row.status],
    ["Requested model", row.requestedModel ?? "—"],
    ["Served model", row.modelSlug ?? "—"],
    ["Provider", row.providerName ?? "—"],
    ["Attempts", `${row.attempts}${row.fallbackUsed ? " (fallback used)" : ""}`],
    ["Tokens in", String(row.tokensIn)],
    ["Tokens out", String(row.tokensOut)],
    ["Cost", fmtMicro(row.costMicro)],
    ["Latency", `${row.latencyMs} ms`],
    ["TTFT", row.ttftMs == null ? "—" : `${row.ttftMs} ms`],
    ["Error code", row.errorCode ?? "—"],
  ];
  return (
    <div className="fixed inset-0 z-50 bg-black/50" onClick={onClose}>
      <div
        className="absolute right-0 top-0 h-full w-full max-w-md overflow-y-auto border-l border-border bg-[var(--card)] p-6"
        role="dialog"
        aria-modal="true"
        aria-label="Request details"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-lg">Request</h3>
          <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
        </div>
        <p className="mt-2 font-mono text-xs text-muted-foreground"><code>{row.id}</code></p>
        <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm">
          {details.map(([dt, dd]) => (
            <Fragment key={dt}>
              <dt className="text-muted-foreground">{dt}</dt>
              <dd className="m-0 text-foreground">{dd}</dd>
            </Fragment>
          ))}
        </dl>
      </div>
    </div>
  );
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

  const selectCls = "form-control";

  return (<>
    <div className="flex flex-wrap items-center gap-2">
      {LOG_DAYS.map((n) => (<Button key={n} size="sm" variant={days === n ? "default" : "outline"} onClick={() => { setDays(n); setPage(1); }}>{n}d</Button>))}
      <select className={selectCls} aria-label="Filter by status" value={filters.status} onChange={(e) => setFilter("status", e.target.value)}>
        <option value="">All statuses</option>
        {LOG_STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
      </select>
      <Input className="w-56" aria-label="Filter by model" placeholder="Model id or slug" value={filters.model} onChange={(e) => setFilter("model", e.target.value)} />
      <Input className="w-56" aria-label="Filter by API key" placeholder="API key id" value={filters.key} onChange={(e) => setFilter("key", e.target.value)} />
      <Button size="sm" variant="ghost" onClick={reset}>Reset</Button>
    </div>
    <p className="text-muted-foreground">{log ? `${log.total} requests · page ${log.page} of ${log.pages}` : ""}</p>
    <LoadState loading={loading} error={error} />
    <Table>
      <TableHeader>
        <TableRow className="border-b border-border">
          <TableHead>Time</TableHead>
          <TableHead>Model</TableHead>
          <TableHead>Provider</TableHead>
          <TableHead>Tokens in/out</TableHead>
          <TableHead>Cost</TableHead>
          <TableHead>Latency</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {(log?.rows ?? []).map((r) => (
          <TableRow key={r.id}>
            <TableCell>
              <button type="button" className="cursor-pointer text-left link" onClick={() => setOpen(r)} aria-label={`Open details for request ${r.id}`}>{fmtDate(r.createdAt)}</button>
            </TableCell>
            <TableCell>{r.modelSlug ?? r.requestedModel ?? "—"}</TableCell>
            <TableCell>{r.providerName ?? "—"}</TableCell>
            <TableCell className="font-mono tabular-nums">{r.tokensIn} / {r.tokensOut}</TableCell>
            <TableCell className="font-mono tabular-nums">{fmtMicro(r.costMicro)}</TableCell>
            <TableCell className="font-mono tabular-nums">{r.latencyMs} ms</TableCell>
            <TableCell>{r.status}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="secondary" disabled={!log || log.page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Prev</Button>
      <Button size="sm" variant="secondary" disabled={!log || log.page >= log.pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
    </div>
    {open ? <RequestDetailDrawer row={open} onClose={() => setOpen(null)} /> : null}
  </>);
}

export function LogsPage() {
  const [tab, setTab] = useState<Tab>("Requests");
  return (<ConsoleLayout><Page title="Logs" lede="Requests, console and activity.">
    <div role="tablist" aria-label="Log views" className="flex flex-wrap items-center gap-2">
      {TABS.map((t) => (
        <Button
          key={t}
          size="sm"
          variant={tab === t ? "default" : "outline"}
          role="tab"
          aria-selected={tab === t}
          onClick={() => setTab(t)}
        >{t}</Button>
      ))}
    </div>
    <div role="tabpanel" aria-label={`${tab} view`}>
      {tab === "Requests" ? <RequestsTab /> : (
        <div className="surface p-5">
          <h3 className="text-base">{tab}</h3>
          <p className="mt-1 text-muted-foreground">{tab === "Console"
            ? "Application console logs are not exposed to members."
            : "Account activity is not exposed to members."}</p>
        </div>
      )}
    </div>
    <p className="text-muted-foreground">Request logs are retained for 90 days.</p>
  </Page></ConsoleLayout>);
}
