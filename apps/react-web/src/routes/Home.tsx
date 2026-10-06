import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AuroraBackground } from '../components/AuroraBackground';
import { FluidOrb } from '../components/FluidOrb';
import { Reveal } from '../components/Reveal';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { api, formatContext } from '../lib/api';

const CODE_SAMPLE = `import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.FUDROUTER_KEY,
  baseURL: "https://ai.karepmuwes.my.id/v1",
});

const res = await client.chat.completions.create({
  model: "grok-4.6",
  messages: [{ role: "user", content: "hello" }],
});`;

const FEATURES = [
  { title: 'Provider network', body: 'One key reaches providers across the network. Model availability is published from live catalog data, and a model served by more than one provider keeps every route open.', href: '/providers', link: 'Browse providers' },
  { title: 'Smart routing', body: 'Each request is scored across candidate routes — price, latency, reliability and capacity — under your routing policy.', href: '/docs/routing/routing', link: 'How routing works' },
  { title: 'Fallback', body: 'A rate limit, timeout or outage on one route retries on the next candidate instead of failing your call.', href: '/docs/routing/fallback', link: 'Fallback and retries' },
  { title: 'Observability', body: 'Every call writes one ledger row: model, provider, tokens, cost, latency and an error code when it failed.', href: '/docs/observability/observability', link: 'What gets recorded' },
  { title: 'Cost optimization', body: 'Normalized per-1M prices let the router prefer the cheaper route at equal quality.', href: '/pricing', link: 'See pricing' },
  { title: 'OpenAI compatibility', body: 'Point any OpenAI-compatible client at one base URL. Chat Completions, Models, Responses and Embeddings speak the wire format your SDK already knows.', href: '/docs/compatibility/openai-compatibility', link: 'Compatibility notes' },
];

const FALLBACK_METRICS = { models: 284, providers: 9, calls: 435, latencyMs: null as number | null };

export function HomePage() {
  const [metrics, setMetrics] = useState(FALLBACK_METRICS);
  const [samples, setSamples] = useState<{ slug: string; name: string; context: number | null }[]>([]);
  useEffect(() => {
    void api.metrics().then((d) => {
      if (!d) return;
      setMetrics({
        models: d.metrics.models ?? FALLBACK_METRICS.models,
        providers: d.metrics.providers ?? FALLBACK_METRICS.providers,
        calls: d.metrics.calls ?? FALLBACK_METRICS.calls,
        latencyMs: d.metrics.latencyMs,
      });
      setSamples(d.sampleModels.slice(0, 6));
    });
  }, []);
  const strip = [
    { label: 'Available models', value: metrics.models.toLocaleString('en-US') },
    { label: 'Providers in network', value: String(metrics.providers) },
    { label: 'Calls served', value: metrics.calls.toLocaleString('en-US') },
    { label: 'Latency (24h)', value: metrics.latencyMs === null ? '—' : `${metrics.latencyMs.toLocaleString()}ms` },
  ];
  return (
    <Reveal>
      <div className="stack">
        <section className="hero">
          <AuroraBackground />
          <p className="fr-label">Commercial AI router</p>
          <h1 className="display-xl">Unified API for AI models.<br />Connect once. Route anywhere.</h1>
          <div className="hero-split">
            <div className="hero-copy">
              <p className="lede">One OpenAI-compatible key reaches every model and provider in the network — routed, metered and logged per request.</p>
              <div className="row">
                <Link to="/signup"><Button size="lg">Get API Key</Button></Link>
                <Link to="/models"><Button size="lg" variant="secondary">Explore Models</Button></Link>
                <Link to="/docs"><Button size="lg" variant="ghost">Read Docs</Button></Link>
              </div>
            </div>
            <figure className="hero-code">
              <figcaption className="fr-label">OpenAI SDK</figcaption>
              <pre>{CODE_SAMPLE}</pre>
            </figure>
          </div>
          <div aria-hidden="true"><FluidOrb size={320} color="#1A73F2" /></div>
        </section>
        <section className="metrics-strip">
          {strip.map((m) => (
            <div key={m.label}><div className="num" style={{ fontSize: 'var(--text-h4)' }}>{m.value}</div><div className="muted">{m.label}</div></div>
          ))}
        </section>
        {samples.length > 0 && (
          <section>
            <h2>Available models</h2>
            <div className="grid3">
              {samples.map((m) => (
                <Card key={m.slug} title={m.name} desc={`${m.slug} · ${formatContext(m.context)} context`} />
              ))}
            </div>
          </section>
        )}
        {FEATURES.map((f) => (
          <section key={f.title}>
            <h2>{f.title}</h2>
            <p className="muted">{f.body}</p>
            <Link to={f.href}>{f.link}</Link>
          </section>
        ))}
        <section>
          <h2>Start with one key.</h2>
          <p className="muted">Sign up, mint a key, and point a client at the API.</p>
          <Link to="/signup"><Button>Get API Key</Button></Link>
        </section>
        <style>{`.hero { position: relative; } .hero-split { display: flex; flex-wrap: wrap; gap: var(--space-xl); align-items: flex-start; } .hero-copy { flex: 1 1 20rem; display: grid; gap: var(--space-md); } .hero-code { flex: 1 1 24rem; margin: 0; max-width: 34rem; } .metrics-strip { display: flex; flex-wrap: wrap; gap: var(--space-lg); padding: var(--space-lg); } .grid3 { display: grid; gap: var(--space-md); grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr)); } .display-xl { font-size: var(--text-display); letter-spacing: var(--tracking-display); line-height: var(--lh-display); } .fr-label { color: var(--color-text-muted); font-size: var(--text-caption); font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }`}</style>
      </div>
    </Reveal>
  );
}
