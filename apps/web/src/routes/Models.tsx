import { useEffect, useState } from 'react';
import { Reveal } from '../components/Reveal';
import { Button } from '../components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table';
import { api, formatContext, formatPricePer1M, type CatalogModel } from '../lib/api';

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

const fieldCls =
  'form-control w-full';

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
      <div className="grid gap-6">
        <h1>Models</h1>
        <p className="measure text-lg text-muted-foreground">
          Every model the router can serve, with its price per 1M tokens. Prices are the ones the
          router bills.
        </p>

        <form
          className="grid items-end gap-4 [grid-template-columns:repeat(auto-fit,minmax(11rem,1fr))]"
          onSubmit={(e) => {
            e.preventDefault();
            // Re-query by identity change; the effect keys on `filters`.
            setFilters((f) => ({ ...f }));
          }}
        >
          <label className="grid gap-1">
            <span className="eyebrow">Search</span>
            <input
              type="search"
              placeholder="Search models…"
              value={filters.search}
              onChange={(e) => set('search', e.target.value)}
              className={fieldCls}
            />
          </label>
          <label className="grid gap-1">
            <span className="eyebrow">Developer</span>
            <select className={fieldCls} value={filters.developer} onChange={(e) => set('developer', e.target.value)}>
              <option value="">All</option>
              {developers.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </label>
          <label className="grid gap-1">
            <span className="eyebrow">Provider</span>
            <select className={fieldCls} value={filters.provider} onChange={(e) => set('provider', e.target.value)}>
              <option value="">All</option>
              {providers.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </label>
          <label className="grid gap-1">
            <span className="eyebrow">Min context</span>
            <select className={fieldCls} value={filters.minContext} onChange={(e) => set('minContext', e.target.value)}>
              {CONTEXT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <label className="grid gap-1">
            <span className="eyebrow">Max input price</span>
            <select className={fieldCls} value={filters.maxInputPrice} onChange={(e) => set('maxInputPrice', e.target.value)}>
              {PRICE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <label className="grid gap-1">
            <span className="eyebrow">Capability</span>
            <select className={fieldCls} value={filters.capability} onChange={(e) => set('capability', e.target.value)}>
              {CAPABILITY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <label className="grid gap-1">
            <span className="eyebrow">Sort</span>
            <select className={fieldCls} value={filters.sort} onChange={(e) => set('sort', e.target.value)}>
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <div className="flex gap-2">
            <Button type="submit" variant="secondary">Apply</Button>
            <Button type="button" variant="secondary" onClick={() => setFilters(EMPTY_FILTERS)}>
              Reset
            </Button>
          </div>
        </form>

        <p className="m-0 text-muted-foreground" role="status">
          {loading ? 'Loading…' : `Showing ${models.length} of ${total} models`}
        </p>

        {error ? (
          <p className="error-text" role="alert">
            Models could not be loaded.{' '}
            <Button type="button" variant="secondary" onClick={() => setFilters((f) => ({ ...f }))}>
              Retry
            </Button>
          </p>
        ) : null}

        {!error && !loading && models.length === 0 ? (
          <p className="text-muted-foreground">
            No models match these filters.{' '}
            <Button type="button" variant="secondary" onClick={() => setFilters(EMPTY_FILTERS)}>
              Reset
            </Button>
          </p>
        ) : null}

        <section aria-labelledby="models-table">
          <h2 id="models-table" className="sr-only">Model catalog</h2>
          <Table>
            <TableHeader>
              <TableRow className="border-b border-border">
                <TableHead>Model</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Context</TableHead>
                <TableHead>Input $/1M</TableHead>
                <TableHead>Output $/1M</TableHead>
                <TableHead>Capabilities</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {models.map((m) => (
                <TableRow key={m.slug}>
                  <TableCell>
                    <span className="whitespace-normal">
                      {m.name}
                      {m.slug !== m.name && (
                        <>
                          <br />
                          <code className="text-xs text-muted-foreground">{m.slug}</code>
                        </>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {m.providers.length ? m.providers.map((p) => p.providerName).join(', ') : '—'}
                  </TableCell>
                  <TableCell className="font-mono text-muted-foreground tabular-nums">{formatContext(m.context)}</TableCell>
                  <TableCell className="font-mono text-muted-foreground tabular-nums">{formatPricePer1M(m.price.inputPriceMicro)}</TableCell>
                  <TableCell className="font-mono text-muted-foreground tabular-nums">{formatPricePer1M(m.price.outputPriceMicro)}</TableCell>
                  <TableCell>
                    <span className="flex flex-wrap gap-1">
                      {Object.entries(m.capabilities)
                        .filter(([, v]) => v === true)
                        .map(([k]) => CAP_LABELS[k] ?? k)
                        .map((label) => (
                          <span key={label} className="inline-block rounded-full border border-border px-2 text-xs text-muted-foreground whitespace-nowrap">
                            {label}
                          </span>
                        ))}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      </div>
    </Reveal>
  );
}
