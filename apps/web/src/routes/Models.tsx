import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { api, formatPricePer1M, formatTokens, type CatalogModel } from '../lib/api';
import './sekai.css';

// ─── SEKAI Gateway port: model catalogue as a card grid ─────────────────────
// The live SEKAI catalogue page (sekaigateway.xyz/id) is a card grid, not a
// table: each model is a card with the provider's monogram, the model name, its
// `provider/model` slug with a copy button, a context-window figure, a max-output
// figure, input-type tags and — behind the public `/api/models` — per-provider
// pricing. This page mirrors that surface FUDRouter's own data: the card grid,
// the provider monogram, the copy-slug affordance and the input-type filter are
// the SEKAI UI; the table's numbers (latency, availability) are the rows FUDRouter
// already publishes through the same endpoint. Filters stay server-side where the
// server already speaks them, so the catalog never lies about what can be routed.

const CONTEXT_OPTIONS: { label: string; value: string }[] = [
  { label: 'All contexts', value: '' },
  { label: '128k+', value: '128' },
  { label: '200k+', value: '200' },
  { label: '1M+', value: '1000' },
];

const PRICE_OPTIONS: { label: string; value: string }[] = [
  { label: 'Any price', value: '' },
  { label: '≤ $1', value: '1' },
  { label: '≤ $5', value: '5' },
  { label: '≤ $15', value: '15' },
];

const CAPABILITY_OPTIONS: { label: string; value: string }[] = [
  { label: 'Any capability', value: '' },
  { label: 'Tool calling', value: 'tools' },
  { label: 'Vision', value: 'vision' },
  { label: 'Reasoning', value: 'reasoning' },
  { label: 'Structured output', value: 'structured_output' },
  { label: 'Streaming', value: 'streaming' },
];

// Input-type filter maps 1:1 onto SEKAI's segmented control. FUDRouter's
// /api/models reports the modality.type per model; filters are client-side on
// that field (the server does not expose a modality facet).
const INPUT_TYPES: { label: string; value: string }[] = [
  { label: 'All inputs', value: '' },
  { label: 'Teks', value: 'text' },
  { label: 'Gambar', value: 'image' },
  { label: 'Audio', value: 'audio' },
  { label: 'Video', value: 'video' },
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

const CAP_LABELS: Record<string, string> = {
  tools: 'tools',
  vision: 'vision',
  reasoning: 'reasoning',
  structured_output: 'structured output',
  streaming: 'streaming',
};

interface Filters {
  search: string;
  developer: string;
  provider: string;
  minContext: string;
  maxInputPrice: string;
  capability: string;
  sort: string;
  inputType: string;
}

const EMPTY_FILTERS: Filters = {
  search: '',
  developer: '',
  provider: '',
  minContext: '',
  maxInputPrice: '',
  capability: '',
  sort: 'name',
  inputType: '',
};

function paramsOf(f: Filters): Record<string, string> {
  const params: Record<string, string> = {};
  if (f.search.trim()) params.search = f.search.trim();
  if (f.developer) params.developer = f.developer;
  if (f.provider) params.provider = f.provider;
  if (f.minContext) params.minContext = f.minContext;
  if (f.maxInputPrice) params.maxInputPrice = f.maxInputPrice;
  if (f.capability) params[f.capability] = 'yes';
  if (f.sort && f.sort !== 'name') params.sort = f.sort;
  return params;
}

/** Monogram for a provider: first two letters, uppercase — the SEKAI "logo" stand-in. */
function monogram(name: string): string {
  const clean = name.replace(/[^A-Za-z0-9]/g, '');
  return (clean.slice(0, 2) || name.slice(0, 2) || '?').toUpperCase();
}

/** Input-type tags from the model's modality. */
function inputTags(m: CatalogModel): string[] {
  const t = m.modality?.type ?? '';
  const known = ['text', 'image', 'audio', 'video'];
  const base = t
    .toLowerCase()
    .split(/[,+]/)
    .map((s) => s.trim())
    .filter((s) => known.includes(s));
  // A model with no modality metadata shows nothing rather than a wrong claim.
  return base;
}

export function ModelsPage() {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [total, setTotal] = useState(0);
  const [developers, setDevelopers] = useState<string[]>([]);
  const [providers, setProviders] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

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

  // Input-type filtering happens client-side over the fetched batch: the server
  // filters on context/price/capability, and modality is the one facet it does
  // not expose. Two models that differ only in modality would collapse into one
  // card if we returned nothing to the server, so the visible grid is the post-
  // filter list while `total` still reflects the server's answer.
  const visible = useMemo(
    () =>
      filters.inputType
        ? models.filter((m) => inputTags(m).includes(filters.inputType))
        : models,
    [models, filters.inputType],
  );

  function set<K extends keyof Filters>(key: K, value: string) {
    setFilters((f) => ({ ...f, [key]: value }));
  }

  async function copySlug(slug: string) {
    try {
      await navigator.clipboard.writeText(slug);
      setCopied(slug);
      setTimeout(() => setCopied((c) => (c === slug ? null : c)), 1400);
    } catch {
      // Clipboard may be blocked on a plain-HTTP origin; select-on-copy is the
      // fallback affordance (the slug is user-select: all).
    }
  }

  return (
    <div className="sekai-root">
      <div className="sekai-inner">
        {/* Hero — SEKAI voice: "Cek modelnya. Lihat spesifikasinya." */}
        <header className="sekai-hero">
          <p className="sekai-kicker">Catalog model</p>
          <h1>Cek modelnya. Lihat spesifikasinya.</h1>
          <p className="lede">
            Bandingkan context window, jenis input, dan tarif tiap model. Harga adalah tarif yang
            di-tagih router per 1M token, dibaca langsung dari katalog.
          </p>
          <div className="sekai-hero-actions">
            <Link to="/pricing">
              <Button>Lihat harga lengkap</Button>
            </Link>
            <Link to="/docs">
              <Button variant="secondary">Mulai pakai</Button>
            </Link>
          </div>
        </header>

        {/* Filter bar — search + provider + context + price + capability + sort */}
        <form
          className="sekai-filters"
          onSubmit={(e) => {
            e.preventDefault();
            setFilters((f) => ({ ...f }));
          }}
        >
          <label className="sekai-search">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
              <path d="M20 20l-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <input
              type="search"
              placeholder="Cari model…"
              value={filters.search}
              onChange={(e) => set('search', e.target.value)}
            />
            <span className="sekai-count" role="status">
              {loading ? '…' : `${visible.length} / ${total}`}
            </span>
          </label>
          <select
            className="sekai-provider"
            aria-label="Provider"
            value={filters.provider}
            onChange={(e) => set('provider', e.target.value)}
          >
            <option value="">Semua penyedia</option>
            {providers.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <select
            className="sekai-provider"
            aria-label="Context window"
            value={filters.minContext}
            onChange={(e) => set('minContext', e.target.value)}
          >
            {CONTEXT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <select
            className="sekai-provider"
            aria-label="Max input price"
            value={filters.maxInputPrice}
            onChange={(e) => set('maxInputPrice', e.target.value)}
          >
            {PRICE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <select
            className="sekai-provider"
            aria-label="Capability"
            value={filters.capability}
            onChange={(e) => set('capability', e.target.value)}
          >
            {CAPABILITY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <select
            className="sekai-provider"
            aria-label="Sort"
            value={filters.sort}
            onChange={(e) => set('sort', e.target.value)}
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </form>

        {/* Input-type segmented control — SEKAI's "Semua input / Teks / Gambar / Audio / Video" */}
        <div className="sekai-inputs" role="group" aria-label="Filter jenis input">
          {INPUT_TYPES.map((t) => (
            <button
              key={t.value}
              type="button"
              className="sekai-input-btn"
              aria-pressed={filters.inputType === t.value}
              onClick={() => set('inputType', t.value)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Grid — the SEKAI card catalogue */}
        {error ? (
          <div className="sekai-state" role="alert">
            <p>Model tidak bisa dimuat.</p>
            <Button type="button" variant="secondary" onClick={() => setFilters((f) => ({ ...f }))}>
              Coba lagi
            </Button>
          </div>
        ) : loading ? (
          <div className="sekai-state" role="status">Loading…</div>
        ) : visible.length === 0 ? (
          <div className="sekai-state">
            <p>Tidak ada model yang cocok dengan filter ini.</p>
            <Button type="button" variant="secondary" onClick={() => setFilters(EMPTY_FILTERS)}>
              Reset filter
            </Button>
          </div>
        ) : (
          <>
            {/* h1 -> card h3 skips a level; axe `heading-order` flags it. Hidden
                heading restores the outline without changing the layout. */}
            <h2 className="sr-only">Model catalog</h2>
            <div className="sekai-grid">
            {visible.map((m) => {
              const firstProvider = m.providers[0]?.providerName ?? '—';
              const tags = inputTags(m);
              return (
                <article className="sekai-card" key={m.id ?? m.slug}>
                  <div className="sekai-card-head">
                    <span className="sekai-logo" aria-hidden="true">{monogram(firstProvider)}</span>
                    <span className="sekai-provider-name">{firstProvider}</span>
                  </div>
                  <div>
                    <h3>{m.name}</h3>
                    <div className="sekai-slug-row" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)', marginTop: 'var(--space-xs)' }}>
                      <code className="sekai-slug">{m.slug}</code>
                      <button
                        type="button"
                        className="sekai-copy"
                        onClick={() => void copySlug(m.slug)}
                        aria-label={`Salin ID ${m.slug}`}
                      >
                        {copied === m.slug ? 'Disalin ✓' : 'Salin ID'}
                      </button>
                    </div>
                  </div>
                  <dl className="sekai-specs">
                    <div className="sekai-spec">
                      <dt className="sk-label">Context window</dt>
                      <dd className="sk-val">{m.context ? formatTokens(m.context) : '—'}</dd>
                    </div>
                    <div className="sekai-spec">
                      <dt className="sk-label">Output maks. {firstProvider !== '—' ? '· ' + formatPricePer1M(m.price.outputPriceMicro) : ''}</dt>
                      <dd className="sk-val">{m.maxOutput ? formatTokens(m.maxOutput) : '—'}</dd>
                    </div>
                  </dl>
                  <div className="sekai-tags">
                    {tags.map((t) => (
                      <span key={t} className="sekai-tag">{t}</span>
                    ))}
                    {Object.entries(m.capabilities)
                      .filter(([, v]) => v === true)
                      .map(([k]) => CAP_LABELS[k] ?? k)
                      .map((label) => (
                        <span key={label} className="sekai-tag">{label}</span>
                      ))}
                  </div>
                </article>
              );
            })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default ModelsPage;
