import { useEffect, useState } from 'react';
import { Reveal } from '../components/Reveal';
import { Button } from '../components/ui/button';
import { Table } from '../components/ui/table';
import { api, formatContext, formatPricePer1M, type CatalogModel } from '../lib/api';
import './Models.css';

// The server's filter vocabulary (public.mjs): minContext is in THOUSANDS and
// the price caps are decimal USD, so the option values below are wire values,
// not display strings.
const CONTEXT_OPTIONS: { label: string; value: string }[] = [
  { label: 'All', value: '' },
  { label: '128k+', value: '128' },
  { label: '200k+', value: '200' },
  { label: '1M+', value: '1000' },
];

const PRICE_OPTIONS: { label: string; value: string }[] = [
  { label: 'All', value: '' },
  { label: '≤ $1', value: '1' },
  { label: '≤ $5', value: '5' },
  { label: '≤ $15', value: '15' },
];

// One capability filter (value `yes`) rather than one select per capability:
// the server accepts per-capability any/yes/no, but a six-select filter bar is
// more chrome than a model picker needs.
const CAPABILITY_OPTIONS: { label: string; value: string }[] = [
  { label: 'All', value: '' },
  { label: 'Tool calling', value: 'tools' },
  { label: 'Vision', value: 'vision' },
  { label: 'Reasoning', value: 'reasoning' },
  { label: 'Structured output', value: 'structured_output' },
  { label: 'Streaming', value: 'streaming' },
];

const SORT_OPTIONS: { label: string; value: string }[] = [
  { label: 'Name', value: 'name' },
  { label: 'Input price', value: 'input-price' },
  { label: 'Output price', value: 'output-price' },
  { label: 'Context', value: 'context' },
  { label: 'Popularity', value: 'popularity' },
  { label: 'Latency', value: 'latency' },
  { label: 'Availability', value: 'availability' },
];

interface Filters {
  search: string;
  developer: string;
  provider: string;
  minContext: string;
  maxInputPrice: string;
  capability: string;
  sort: string;
}

const EMPTY_FILTERS: Filters = {
  search: '',
  developer: '',
  provider: '',
  minContext: '',
  maxInputPrice: '',
  capability: '',
  sort: 'name',
};

// Chips only for capabilities the server reports as true; null is "unknown",
// and rendering an unknown as a chip would advertise a feature the router
// cannot guarantee.
const CAP_LABELS: Record<string, string> = {
  tools: 'tools',
  vision: 'vision',
  reasoning: 'reasoning',
  structured_output: 'structured output',
  streaming: 'streaming',
};

function paramsOf(f: Filters): Record<string, string> {
  const params: Record<string, string> = {};
  if (f.search) params.search = f.search;
  if (f.developer) params.developer = f.developer;
  if (f.provider) params.provider = f.provider;
  if (f.minContext) params.minContext = f.minContext;
  if (f.maxInputPrice) params.maxInputPrice = f.maxInputPrice;
  if (f.capability) params[f.capability] = 'yes';
  if (f.sort && f.sort !== 'name') params.sort = f.sort;
  return params;
}

export function ModelsPage() {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [total, setTotal] = useState(0);
  const [developers, setDevelopers] = useState<string[]>([]);
  const [providers, setProviders] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    void api.models(paramsOf(filters)).then((d) => {
      if (cancelled) return;
      setLoading(false);
      if (d) {
        setModels(d.models);
        setTotal(d.total);
      } else {
        setError(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [filters]);

  // Developer/provider facet options come from the first successful load and
  // are not re-derived per filter change: the server's `options` reflect the
  // whole catalogue, and refetching facets on every keystroke would make the
  // selects flicker while typing.
  useEffect(() => {
    void api.models().then((d) => {
      if (!d) return;
      const devs = new Set<string>();
      const provs = new Set<string>();
      for (const m of d.models) {
        if (m.developer) devs.add(m.developer);
        for (const p of m.providers) provs.add(p.providerName);
      }
      setDevelopers([...devs].sort());
      setProviders([...provs].sort());
    });
  }, []);

  function set<K extends keyof Filters>(key: K, value: string) {
    setFilters((f) => ({ ...f, [key]: value }));
  }

  return (
    <Reveal>
      <div className="stack">
        <h1>Models</h1>
        <p className="lede muted">
          Every model the router can serve, with its price per 1M tokens. Prices are the ones the
          router bills.
        </p>

        <form
          className="models-filters"
          onSubmit={(e) => {
            e.preventDefault();
            // Re-query by identity change; the effect keys on `filters`.
            setFilters((f) => ({ ...f }));
          }}
        >
          <label>
            <span className="fr-label">Search</span>
            <input
              type="search"
              placeholder="Search models…"
              value={filters.search}
              onChange={(e) => set('search', e.target.value)}
            />
          </label>
          <label>
            <span className="fr-label">Developer</span>
            <select className="select" value={filters.developer} onChange={(e) => set('developer', e.target.value)}>
              <option value="">All</option>
              {developers.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="fr-label">Provider</span>
            <select className="select" value={filters.provider} onChange={(e) => set('provider', e.target.value)}>
              <option value="">All</option>
              {providers.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="fr-label">Min context</span>
            <select className="select" value={filters.minContext} onChange={(e) => set('minContext', e.target.value)}>
              {CONTEXT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="fr-label">Max input price</span>
            <select className="select" value={filters.maxInputPrice} onChange={(e) => set('maxInputPrice', e.target.value)}>
              {PRICE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="fr-label">Capability</span>
            <select className="select" value={filters.capability} onChange={(e) => set('capability', e.target.value)}>
              {CAPABILITY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="fr-label">Sort</span>
            <select className="select" value={filters.sort} onChange={(e) => set('sort', e.target.value)}>
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <div className="models-filter-actions">
            <Button type="submit" variant="secondary">Apply</Button>
            <Button type="button" variant="secondary" onClick={() => setFilters(EMPTY_FILTERS)}>
              Reset
            </Button>
          </div>
        </form>

        <p className="models-count muted" role="status">
          {loading ? 'Loading…' : `Showing ${models.length} of ${total} models`}
        </p>

        {error ? (
          <p className="error" role="alert">
            Models could not be loaded.{' '}
            <Button type="button" variant="secondary" onClick={() => setFilters((f) => ({ ...f }))}>
              Retry
            </Button>
          </p>
        ) : null}

        {!error && !loading && models.length === 0 ? (
          <p className="muted">
            No models match these filters.{' '}
            <Button type="button" variant="secondary" onClick={() => setFilters(EMPTY_FILTERS)}>
              Reset
            </Button>
          </p>
        ) : null}

        <section aria-labelledby="models-table">
          <h2 id="models-table" className="visually-hidden">Model catalog</h2>
          <div className="table-wrap">
            <Table
              head={['Model', 'Provider', 'Context', 'Input $/1M', 'Output $/1M', 'Capabilities']}
              rows={models.map((m) => [
                <span key="m">
                  {m.name}
                  {m.slug !== m.name && (
                    <>
                      <br />
                      <code className="muted">{m.slug}</code>
                    </>
                  )}
                </span>,
                <span key="p">{m.providers.length ? m.providers.map((p) => p.providerName).join(', ') : '—'}</span>,
                <span key="x" className="num">{formatContext(m.context)}</span>,
                <span key="i" className="num">{formatPricePer1M(m.price.inputPriceMicro)}</span>,
                <span key="o" className="num">{formatPricePer1M(m.price.outputPriceMicro)}</span>,
                <span key="c" className="models-cap">
                  {Object.entries(m.capabilities)
                    .filter(([, v]) => v === true)
                    .map(([k]) => CAP_LABELS[k] ?? k)
                    .map((label) => (
                      <span key={label} className="models-cap-chip">{label}</span>
                    ))}
                </span>,
              ])}
            />
          </div>
        </section>
      </div>
    </Reveal>
  );
}
