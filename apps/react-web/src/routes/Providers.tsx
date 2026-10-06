import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Reveal } from '../components/Reveal';
import { Badge } from '../components/ui/badge';
import { Table } from '../components/ui/table';
import { api, formatContext, formatMs, formatPricePer1M, type ProviderRow } from '../lib/api';

export function ProvidersPage() {
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  useEffect(() => {
    void api.providers().then((d) => {
      if (d) setProviders(d.providers);
    });
  }, []);
  return (
    <Reveal>
      <div className="stack">
        <h1>Providers</h1>
        <p className="lede muted">The upstream AI providers this network routes to, and how each one is doing.</p>
        <div className="table-wrap">
          <Table
            head={['Provider', 'Status', 'Models', 'Latency (P50 / P95)', 'Availability']}
            rows={providers.map((r) => [
              <Link key="n" to={`/providers/${encodeURIComponent(r.slug ?? r.name)}`}>{r.name}</Link>,
              <Badge key="s" tone={r.status === 'operational' ? 'ok' : 'warn'}>{r.status === 'operational' ? 'Operational' : 'Degraded'}</Badge>,
              <span key="m" className="num">{r.modelCount}</span>,
              <span key="l" className="num">{r.p50Ms === null && r.p95Ms === null ? '—' : `${formatMs(r.p50Ms)} / ${formatMs(r.p95Ms)}`}</span>,
              <span key="a" className="num">{r.availability === null ? '—' : `${(r.availability * 100).toFixed(1)}%`}</span>,
            ])}
          />
        </div>
        <p className="muted">Latency and availability are observed from real requests; a dash means no traffic yet.</p>
      </div>
    </Reveal>
  );
}

export function ProviderDetailPage() {
  const { slug } = useParams();
  const [row, setRow] = useState<ProviderRow | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (slug) void api.provider(slug).then((d) => {
      if (d?.provider) setRow(d.provider);
      else setMissing(true);
    });
  }, [slug]);
  if (missing) return <div className="stack"><h1>Provider not found</h1><p className="muted">No provider in the public catalog matches this name.</p><Link to="/providers">Browse the provider directory.</Link></div>;
  if (!row) return <div className="stack"><h1>Providers</h1><p className="muted">Loading…</p></div>;
  return (
    <Reveal>
      <div className="stack">
        <h1>{row.name}</h1>
        <p className="lede muted">
          <Badge tone={row.status === 'operational' ? 'ok' : 'warn'}>{row.status}</Badge>
          {' '}· {row.modelCount} models · {formatContext(null) === '—' ? `${formatMs(row.p50Ms)} p50` : ''}
        </p>
        <div className="table-wrap">
          <Table head={['Fact', 'Value']} rows={[
            ['Models served', <span key="m" className="num">{row.modelCount}</span>],
            ['Capabilities', row.capabilities.length ? row.capabilities.join(', ') : '—'],
            ['Regions', row.regions.length ? row.regions.join(', ') : '—'],
            ['Latency P50', <span key="p5" className="num">{formatMs(row.p50Ms)}</span>],
            ['Latency P95', <span key="p9" className="num">{formatMs(row.p95Ms)}</span>],
          ]} />
        </div>
        <Link to="/providers">Back to directory</Link>
      </div>
    </Reveal>
  );
}
