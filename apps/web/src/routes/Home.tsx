import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AuroraBackground } from '../components/AuroraBackground';
import { FluidOrb } from '../components/FluidOrb';
import { Reveal } from '../components/Reveal';
import { ShinyText } from '../components/reactbits/ShinyText';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { api, formatContext, API_BASE_DISPLAY, type Metrics } from '../lib/api';

const CODE_SAMPLE = `import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.FUDROUTER_KEY,
  baseURL: "${API_BASE_DISPLAY}/v1",
});

const res = await client.chat.completions.create({
  model: "grok-4.6",
  messages: [{ role: "user", content: "hello" }],
});`;

const FEATURES = [
  { title: 'Smart routing', body: 'Each request is scored across candidate routes — price, latency, reliability and capacity — under your routing policy.', href: '/docs/routing/routing', link: 'How routing works' },
  { title: 'Fallback', body: 'A rate limit, timeout or outage on one route retries on the next candidate instead of failing your call.', href: '/docs/routing/fallback', link: 'Fallback and retries' },
  { title: 'Observability', body: 'Every call writes one ledger row: model, provider, tokens, cost, latency and an error code when it failed.', href: '/docs/observability/observability', link: 'What gets recorded' },
  { title: 'Cost optimization', body: 'Normalized per-1M prices let the router prefer the cheaper route at equal quality.', href: '/pricing', link: 'See pricing' },
  { title: 'OpenAI compatibility', body: 'Point any OpenAI-compatible client at one base URL. Chat Completions, Models, Responses and Embeddings speak the wire format your SDK already knows.', href: '/docs/compatibility/openai-compatibility', link: 'Compatibility notes' },
];

export function HomePage() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [samples, setSamples] = useState<{ slug: string; name: string; context: number | null }[]>([]);
  useEffect(() => {
    void api.metrics().then((d) => {
      if (!d) return;
      setMetrics(d.metrics);
      setSamples(d.sampleModels.slice(0, 6));
    });
  }, []);
  const strip = [
    { label: 'Available models', value: metrics?.models?.toLocaleString('en-US') ?? '—' },
    { label: 'Providers in network', value: metrics?.providers === null || metrics?.providers === undefined ? '—' : String(metrics.providers) },
    { label: 'Calls served', value: metrics?.calls?.toLocaleString('en-US') ?? '—' },
    { label: 'Latency (24h)', value: metrics?.latencyMs === null || metrics?.latencyMs === undefined ? '—' : `${metrics.latencyMs.toLocaleString()}ms` },
  ];
  return (
    <Reveal>
      <div className="stack">
        <section className="hero">
          <AuroraBackground />
          <p className="fr-label">Commercial AI router</p>
          <ShinyText text="Unified API for AI models." tag="h1" className="display-xl" speed={3} />
          <ShinyText text="Connect once. Route anywhere." tag="p" className="display-xl" speed={3} />
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
          {metrics === null && <p className="muted" style={{ flexBasis: '100%' }}>Live metrics unavailable</p>}
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
      </div>
    </Reveal>
  );
}
