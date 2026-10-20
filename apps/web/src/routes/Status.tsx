import { useEffect, useState } from 'react';
import { Badge, type Tone } from '../components/ui/badge';
import { Table } from '../components/ui/table';
import { api, type StatusPayload } from '../lib/api';

// The state vocabulary is the server's (public.mjs STATUS_COMPONENTS /
// STATE_LABELS): operational, degraded, partial-outage, major-outage,
// maintenance, plus null = "we could not determine this". Nothing here invents
// a status word — a page that says "fine" when the server said "unknown" is
// the failure mode this whole page exists to avoid.
const STATE_TONES: Record<string, Tone> = {
  operational: 'ok',
  degraded: 'warn',
  'partial-outage': 'warn',
  'major-outage': 'danger',
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
      <div className="stack">
        <h1>Status</h1>
        <p className="error" role="alert">
          The status page could not be loaded — reload in a moment.
        </p>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="stack">
        <h1>Status</h1>
        <p className="muted" role="status">
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
    <div className="stack">
      <h1>Status</h1>
      <p className="lede muted">Health of the data plane that answers your API calls.</p>

      <section aria-labelledby="status-overall">
        <h2 id="status-overall" className="sr-only">
          Overall status
        </h2>
        <p className="row flex-wrap">
          <Badge tone={(overall.state && STATE_TONES[overall.state]) || 'default'}>{overall.label}</Badge>
          {probe.service && <span className="muted">{probe.service}</span>}
        </p>
      </section>

      <section aria-labelledby="status-components">
        <h2 id="status-components">Components</h2>
        <div className="table-wrap">
          <Table
            head={['Component', 'Status', 'Derived from']}
            rows={components.map((c) => [
              <span key="c">
                <strong>{c.label}</strong>
                <br />
                <span className="muted">{c.description}</span>
              </span>,
              <Badge key="s" tone={(c.state && STATE_TONES[c.state]) || 'default'}>
                {c.stateLabel}
              </Badge>,
              <span key="b" className="muted">
                {c.basis}
              </span>,
            ])}
          />
        </div>
      </section>

      <section aria-labelledby="status-incidents">
        <h2 id="status-incidents">Incidents</h2>
        {incidentsUnknown ? (
          // null means the incident query threw: the database was unreachable.
          // That is "unknown", never "no incidents" — the two must not read the
          // same, or an outage looks like an all-clear.
          <p className="muted" role="status">
            Incident history could not be loaded — the incident database is unreachable, so recent incidents are unknown.
          </p>
        ) : incidents.length === 0 ? (
          <p className="muted">No incidents recorded.</p>
        ) : (
          <div className="table-wrap">
            <Table
              head={['Incident', 'Severity', 'Status', 'Started']}
              rows={incidents.map((i) => [
                <span key="t">
                  <strong>{i.title}</strong>
                  <br />
                  <span className="muted">{i.componentLabel}</span>
                </span>,
                <Badge key="s">{i.severity}</Badge>,
                <Badge key="st">{i.statusLabel}</Badge>,
                <span key="d" className="num">
                  {fmtDate(i.startedAt)}
                </span>,
              ])}
            />
          </div>
        )}
      </section>

      <section aria-labelledby="status-probe">
        <h2 id="status-probe">Data plane probe</h2>
        <div className="table-wrap">
          <Table
            head={['Check', 'Result']}
            rows={[
              [
                <span key="r">Reachability</span>,
                probe.ok ? (
                  <Badge key="ok" tone="ok">
                    Reachable
                  </Badge>
                ) : (
                  <Badge key="bad" tone="danger">
                    {probe.error ?? 'Unreachable'}
                  </Badge>
                ),
              ],
              [
                <span key="m">Models served</span>,
                <span key="mv" className="num">
                  {probe.models ?? '—'}
                </span>,
              ],
              [
                <span key="l">Latency</span>,
                <span key="lv" className="num">
                  {probe.latencyMs} ms
                </span>,
              ],
              [
                <span key="c">Checked at</span>,
                <span key="cv" className="num">
                  {fmtDate(probe.checkedAt)}
                </span>,
              ],
            ]}
          />
        </div>
      </section>

      {dbErrorRequestId && (
        <section aria-labelledby="status-dberror">
          <h2 id="status-dberror">Support reference</h2>
          <p className="muted">
            The incident database could not be read. Quote this reference when contacting support:{' '}
            <code>{dbErrorRequestId}</code>
          </p>
        </section>
      )}
    </div>
  );
}
