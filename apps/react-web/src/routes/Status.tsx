import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Reveal } from '../components/Reveal';
import { Badge } from '../components/ui/badge';
import { Table } from '../components/ui/table';
import { api, type StatusPayload } from '../lib/api';

type IncidentRow = NonNullable<StatusPayload['incidents']>[number];

const STATE_TONES: Record<string, 'ok' | 'warn' | 'danger' | 'info'> = {
  operational: 'ok',
  degraded: 'warn',
  'partial-outage': 'warn',
  'major-outage': 'danger',
  maintenance: 'info',
};

export function StatusPage() {
  const [data, setData] = useState<StatusPayload | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    void api.status().then((d) => {
      if (d) setData(d);
      else setError(true);
    });
  }, []);
  if (error) return <div className="stack"><h1>Status</h1><p className="error" role="alert">The status page could not be loaded — reload in a moment.</p></div>;
  if (!data) return <div className="stack"><h1>Status</h1><p className="muted">Checking the data plane…</p></div>;
  return (
    <Reveal>
      <div className="stack">
        <h1>Status</h1>
        <p className="lede muted">Health of the data plane that answers your API calls.</p>
        <p><strong>{data.overall.label}</strong>{data.probe.service && <span className="muted"> · {data.probe.service}</span>}</p>
        <p className="meta muted"><span className="num">probe {data.probe.latencyMs} ms</span></p>
        <h2>Components</h2>
        <div className="table-wrap">
          <Table head={['Component', 'Status', 'Derived from']}
            rows={data.components.map((c) => [
              <span key="c"><strong>{c.label}</strong><br /><span className="muted">{c.description}</span></span>,
              c.state ? <Badge key="s" tone={STATE_TONES[c.state] ?? 'info'}>{c.stateLabel}</Badge> : <Badge key="s">Unknown</Badge>,
              <span key="b" className="muted">{c.basis}</span>,
            ])} />
        </div>
        <h2>Incidents</h2>
        {data.incidents === null ? (
          <p className="muted">Incident history could not be loaded — reload in a moment.</p>
        ) : data.incidents.length === 0 ? (
          <p className="muted">No incidents recorded.</p>
        ) : (
          <div className="table-wrap">
            <Table head={['Incident', 'Severity', 'Status', 'Started']}
              rows={data.incidents.map((i) => [
                <Link key="t" to={`/status/incidents/${i.id}`}>{i.title}</Link>,
                <Badge key="s">{i.severity}</Badge>,
                <Badge key="st">{i.statusLabel}</Badge>,
                <span key="d" className="num">{i.startedAt}</span>,
              ])} />
          </div>
        )}
      </div>
    </Reveal>
  );
}

export function IncidentDetailPage() {
  const { id } = useParams();
  const [incident, setIncident] = useState<IncidentRow | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    void api.status().then((d) => {
      const row = d?.incidents?.find((i) => i.id === id) ?? null;
      if (row) setIncident(row);
      else setMissing(true);
    });
  }, [id]);
  if (missing) return <div className="stack"><h1>Incident not found</h1><Link to="/status">Back to status.</Link></div>;
  if (!incident) return <div className="stack"><h1>Status</h1><p className="muted">Loading…</p></div>;
  return (
    <div className="stack">
      <h1>{incident.title}</h1>
      <p className="muted">{incident.statusLabel} · {incident.componentLabel} · {incident.startedAt}</p>
      <Link to="/status">Back to status.</Link>
    </div>
  );
}
