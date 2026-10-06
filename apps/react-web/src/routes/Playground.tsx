import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Reveal } from '../components/Reveal';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { api, type RunMetrics } from '../lib/api';

interface Model { slug: string; name: string }

export function PlaygroundPage() {
  const [models, setModels] = useState<Model[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('Say OK.');
  const [streaming, setStreaming] = useState(false);
  const [text, setText] = useState('');
  const [metrics, setMetrics] = useState<RunMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.models().then((d) => {
      if (d) {
        setModels(d.models.map(({ slug, name }) => ({ slug, name })));
        setModel(d.models[0]?.slug ?? '');
      } else setLoadError(true);
    });
  }, []);

  async function run() {
    setStreaming(true);
    setText('');
    setMetrics(null);
    setError(null);
    try {
      const res = await fetch('/api/playground/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: true }),
      });
      if (!res.ok || !res.body) {
        const failed = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(failed?.error?.message ?? 'The run failed to start.');
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let raw = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        raw += decoder.decode(value, { stream: true });
        let out = '';
        for (const line of raw.split('\n')) {
          if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
          try {
            const chunk = JSON.parse(line.slice(6)) as { choices?: { delta?: { content?: unknown } }[] };
            const delta = chunk.choices?.[0]?.delta?.content;
            if (typeof delta === 'string') out += delta;
          } catch { /* partial frame */ }
        }
        setText(out || raw);
        const marker = 'event: metrics\ndata: ';
        const at = raw.lastIndexOf(marker);
        if (at >= 0) {
          try {
            setMetrics(JSON.parse(raw.slice(at + marker.length).split('\n')[0]) as RunMetrics);
          } catch { /* partial frame */ }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message.slice(0, 500) : 'The stream failed.');
    } finally {
      setStreaming(false);
    }
  }

  return (
    <Reveal>
      <div className="stack">
        <h1>Playground</h1>
        <p className="lede muted">Run a real request through the router — same auth, limits, routing and billing as production.</p>
        {loadError ? <p className="error">The model catalog could not be loaded — reload in a moment.</p> : null}
        <div className="panels">
          <section>
            <h2>Configuration</h2>
            <label className="muted">Model
              <select value={model} onChange={(e) => setModel(e.target.value)} style={{ display: 'block', width: '100%', height: 'var(--control-h-md)' }}>
                {models.map((m) => <option key={m.slug} value={m.slug}>{m.name}</option>)}
              </select>
            </label>
          </section>
          <section>
            <h2>Prompt</h2>
            <Input value={prompt} onChange={(e) => setPrompt(e.target.value)} aria-label="User prompt" />
            <div className="row" style={{ marginTop: 'var(--space-md)' }}>
              <Button onClick={() => void run()} disabled={streaming || model === ''}>{streaming ? 'Running…' : 'Run (stream)'}</Button>
            </div>
          </section>
          <section>
            <h2>Response</h2>
            {error ? <p><strong>{error}</strong></p> : text ? <pre>{text}</pre> : <p className="muted">No run yet — run a request to see its completion here.</p>}
          </section>
          <section>
            <h2>Metrics</h2>
            {metrics ? (
              <dl className="metrics">
                <dt>Provider</dt><dd className="num">{metrics.provider ?? '—'}</dd>
                <dt>Model</dt><dd className="num">{metrics.actualModel ?? '—'}</dd>
                <dt>Tokens in</dt><dd className="num">{metrics.tokensIn ?? '—'}</dd>
                <dt>Tokens out</dt><dd className="num">{metrics.tokensOut ?? '—'}</dd>
                <dt>Tokens total</dt><dd className="num">{metrics.tokensTotal ?? '—'}</dd>
                <dt>TTFT</dt><dd className="num">{metrics.ttftMs ?? '—'}</dd>
                <dt>Latency</dt><dd className="num">{metrics.latencyMs ?? '—'}</dd>
                <dt>Cost (micro)</dt><dd className="num">{metrics.costMicro ?? '—'}</dd>
                <dt>Request ID</dt><dd className="num">{metrics.requestId ?? '—'}</dd>
              </dl>
            ) : <p className="muted">A run's ledger numbers land here.</p>}
          </section>
        </div>
        <p className="muted">Signed out? <Link to="/signup">Get an API key</Link> to run real requests.</p>
      </div>
    </Reveal>
  );
}
