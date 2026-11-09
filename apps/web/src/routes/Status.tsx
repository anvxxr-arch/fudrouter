import { useEffect, useState, type ComponentProps } from 'react';
import { Badge } from '../components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table';
import { api, type StatusPayload } from '../lib/api';

// The state vocabulary is the server's (public.mjs STATUS_COMPONENTS /
// STATE_LABELS): operational, degraded, partial-outage, major-outage,
// maintenance, plus null = "we could not determine this". Nothing here invents
// a status word — a page that says "fine" when the server said "unknown" is
// the failure mode this whole page exists to avoid.

const STATE_VARIANTS: Record<string, NonNullable<ComponentProps<typeof Badge>["variant"]>> = {
  operational: 'ok',
  degraded: 'warn',
  'partial-outage': 'warn',
  'major-outage': 'destructive',
  maintenance: 'info',
};

function fmtDate(v: string | null) {
  if (!v) return "—";
  try {
    return new Date(v).toLocaleString();
  } catch {
    return v;
  }
}

export function StatusPage() {
  const [data, setData] = useState<StatusPayload | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    void api.status().then((d) => {
      // The body is hand-written JSON with no schema. `incidents` may be null by
      // design, but the structural fields must exist; if one is missing the
      // contract broke, and the page's error state is more honest than a table
      // that renders as if it had checked and found nothing.
      if (d && Array.isArray(d.components) && d.probe && d.overall) setData(d);
      else setError(true);
    });
  }, []);

  if (error) {
    return (
      <div className="grid gap-6">
        <h1>Status</h1>
        <p className="error-text" role="alert">
          The status page could not be loaded — reload in a moment.
        </p>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="grid gap-6">
        <h1>Status</h1>
        <p className="text-muted-foreground" role="status">
          Checking the data plane…
        </p>
      </div>
    );
  }

  const { probe, dbErrorRequestId, components, overall } = data;
  // /api/status has no runtime schema. A missing field must degrade to
  // "unknown" (the same path as a null), not throw and blank the page.
  const incidents = data.incidents ?? null;
  const incidentsUnknown = incidents === null;

  return (
    <div className="grid gap-6">
      <h1>Status</h1>
      <p className="measure text-lg text-muted-foreground">Health of the data plane that answers your API calls.</p>

      <section aria-labelledby="status-overall">
        <h2 id="status-overall" className="sr-only">
          Overall status
        </h2>
        <p className="flex flex-wrap items-center gap-2">
          <Badge variant={(overall.state && STATE_VARIANTS[overall.state]) || 'default'}>{overall.label}</Badge>
          {probe.service && <span className="text-muted-foreground">{probe.service}</span>}
        </p>
      </section>

      <section className="grid gap-2" aria-labelledby="status-components">
        <h2 id="status-components">Components</h2>
        <Table>
          <TableHeader>
            <TableRow className="border-b border-border">
              <TableHead>Component</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Derived from</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {components.map((c) => (
              <TableRow key={c.label}>
                <TableCell>
                  <span className="whitespace-normal">
                    <strong>{c.label}</strong>
                    <br />
                    <span className="text-xs text-muted-foreground">{c.description}</span>
                  </span>
                </TableCell>
                <TableCell>
                  <Badge variant={(c.state && STATE_VARIANTS[c.state]) || 'default'}>
                    {c.stateLabel}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {c.basis}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>

      <section className="grid gap-2" aria-labelledby="status-incidents">
        <h2 id="status-incidents">Incidents</h2>
        {incidentsUnknown ? (
          // null means the incident query threw: the database was unreachable.
          // That is "unknown", never "no incidents" — the two must not read the
          // same, or an outage looks like an all-clear.
          <p className="text-muted-foreground" role="status">
            Incident history could not be loaded — the incident database is unreachable, so recent incidents are unknown.
          </p>
        ) : incidents.length === 0 ? (
          <p className="text-muted-foreground">No incidents recorded.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="border-b border-border">
                <TableHead>Incident</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Started</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {incidents.map((i) => (
                <TableRow key={i.title}>
                  <TableCell>
                    <span className="whitespace-normal">
                      <strong>{i.title}</strong>
                      <br />
                      <span className="text-xs text-muted-foreground">{i.componentLabel}</span>
                    </span>
                  </TableCell>
                  <TableCell><Badge variant="secondary">{i.severity}</Badge></TableCell>
                  <TableCell><Badge variant="secondary">{i.statusLabel}</Badge></TableCell>
                  <TableCell className="font-mono text-muted-foreground tabular-nums">{fmtDate(i.startedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <section className="grid gap-2" aria-labelledby="status-probe">
        <h2 id="status-probe">Data plane probe</h2>
        <Table>
          <TableHeader>
            <TableRow className="border-b border-border">
              <TableHead>Check</TableHead>
              <TableHead>Result</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>Reachability</TableCell>
              <TableCell>
                {probe.ok ? (
                  <Badge variant="ok">
                    Reachable
                  </Badge>
                ) : (
                  <Badge variant="destructive">
                    {probe.error ?? 'Unreachable'}
                  </Badge>
                )}
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell>Models served</TableCell>
              <TableCell className="font-mono text-muted-foreground tabular-nums">{probe.models ?? '—'}</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>Latency</TableCell>
              <TableCell className="font-mono text-muted-foreground tabular-nums">{probe.latencyMs} ms</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>Checked at</TableCell>
              <TableCell className="font-mono text-muted-foreground tabular-nums">{fmtDate(probe.checkedAt)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </section>

      {dbErrorRequestId && (
        <section aria-labelledby="status-dberror">
          <h2 id="status-dberror">Support reference</h2>
          <p className="measure text-muted-foreground">
            The incident database could not be read. Quote this reference when contacting support:{' '}
            <code className="font-mono">{dbErrorRequestId}</code>
          </p>
        </section>
      )}
    </div>
  );
}
