import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Reveal } from '../components/Reveal';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Table } from '../components/ui/table';
import { api, formatContext, formatPricePer1M, type CatalogModel } from '../lib/api';

export function ModelsPage() {
  const [params, setParams] = useSearchParams();
  const [models, setModels] = useState<CatalogModel[]>([]);
  const search = params.get('search') ?? '';
  useEffect(() => {
    void api.models().then((d) => {
      if (d) setModels(d.models);
    });
  }, []);
  const q = search.trim().toLowerCase();
  const rows = models.filter((m) =>
    q === '' || m.name.toLowerCase().includes(q) || m.slug.toLowerCase().includes(q) || (m.developer ?? '').toLowerCase().includes(q),
  );
  return (
    <Reveal>
      <div className="stack">
        <h1>Models</h1>
        <p className="lede muted">Every model this deployment serves through the OpenAI-compatible API.</p>
        <form className="row" onSubmit={(e) => e.preventDefault()}>
          <Input type="search" placeholder="name, slug, developer" value={search} aria-label="Search models"
            onChange={(e) => setParams(e.target.value ? { search: e.target.value } : {})} style={{ maxWidth: 320 }} />
          <span className="muted">Showing <span className="num">{rows.length}</span> of <span className="num">{models.length}</span></span>
        </form>
        <div className="table-wrap">
          <Table
            head={['Model', 'Developer', 'Providers', 'Input', 'Output', 'Context', 'Status']}
            rows={rows.map((m) => [
              <span key="m"><Link to={`/models/${encodeURIComponent(m.slug)}`}>{m.name}</Link><br /><code className="muted">{m.slug}</code></span>,
              m.developer ?? '—',
              <span key="p" className="num">{m.providers.length}</span>,
              <span key="i" className="num">{formatPricePer1M(m.price.inputPriceMicro)}</span>,
              <span key="o" className="num">{formatPricePer1M(m.price.outputPriceMicro)}</span>,
              <span key="c" className="num">{formatContext(m.context)}</span>,
              <Badge key="s" tone={m.providers.some((p) => p.status === 'available') ? 'ok' : 'warn'}>
                {m.providers.some((p) => p.status === 'available') ? 'Available' : 'Degraded'}
              </Badge>,
            ])}
          />
        </div>
        <div className="row"><Link to="/models/compare"><Button variant="secondary">Compare models</Button></Link></div>
      </div>
    </Reveal>
  );
}

export function ModelDetailPage() {
  const { slug } = useParams();
  const [model, setModel] = useState<CatalogModel | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (slug) void api.model(slug).then((d) => {
      if (d?.model) setModel(d.model);
      else setMissing(true);
    });
  }, [slug]);
  if (missing) return <div className="stack"><h1>Model not found</h1><p className="muted">No published model has that identifier.</p><Link to="/models">Browse the model catalog.</Link></div>;
  if (!model) return <div className="stack"><h1>Models</h1><p className="muted">Loading…</p></div>;
  return (
    <Reveal>
      <div className="stack">
        <h1>{model.name}</h1>
        <p className="lede muted"><code>{model.slug}</code> · {formatContext(model.context)} context</p>
        <div className="table-wrap">
          <Table head={['Provider', 'Status', 'Input / 1M', 'Output / 1M']}
            rows={model.providers.map((p) => [
              p.providerName,
              <Badge key="s" tone={p.status === 'available' ? 'ok' : 'warn'}>{p.status}</Badge>,
              <span key="i" className="num">{formatPricePer1M((p.price ?? model.price).inputPriceMicro)}</span>,
              <span key="o" className="num">{formatPricePer1M((p.price ?? model.price).outputPriceMicro)}</span>,
            ])} />
        </div>
        <pre>{`curl https://ai.karepmuwes.my.id/v1/chat/completions \\\n  -H "Authorization: Bearer $FUDROUTER_KEY" \\\n  -d '{"model": "${model.slug}", "messages": [{"role": "user", "content": "hello"}]}'`}</pre>
      </div>
    </Reveal>
  );
}

export function ComparePage() {
  const [params] = useSearchParams();
  const [columns, setColumns] = useState<CatalogModel[]>([]);
  const [missing, setMissing] = useState<string[]>([]);
  useEffect(() => {
    const slugs = (params.get('models') ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 4);
    if (slugs.length === 0) return;
    void api.compare(slugs).then((d) => {
      if (d) { setColumns(d.columns); setMissing(d.missing); }
    });
  }, [params]);
  if (columns.length === 0) {
    return (
      <div className="stack">
        <h1>Compare</h1>
        <p className="muted">Pick up to 4 models: <code>?models=a,b,c</code></p>
        <Link to="/models">Browse the model catalog.</Link>
      </div>
    );
  }
  const facts: { label: string; of: (m: CatalogModel) => string }[] = [
    { label: 'Input / 1M', of: (m) => formatPricePer1M(m.price.inputPriceMicro) },
    { label: 'Output / 1M', of: (m) => formatPricePer1M(m.price.outputPriceMicro) },
    { label: 'Context', of: (m) => formatContext(m.context) },
    { label: 'Providers', of: (m) => String(m.providers.length) },
  ];
  return (
    <Reveal>
      <div className="stack">
        <h1>Compare</h1>
        {missing.length > 0 && <p className="muted">Unknown slugs skipped: {missing.join(', ')}</p>}
        <div className="table-wrap">
          <Table head={['', ...columns.map((c) => c.name)]}
            rows={facts.map((f) => [f.label, ...columns.map((c) => <span key={c.slug} className="num">{f.of(c)}</span>)])} />
        </div>
      </div>
    </Reveal>
  );
}
