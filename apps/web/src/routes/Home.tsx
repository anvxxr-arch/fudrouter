import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AuroraBackground } from '../components/AuroraBackground';
import { Reveal } from '../components/Reveal';
import { Button } from '../components/ui/button';
import { CodeBlock } from '../components/ui/code-block';
import { api, API_BASE_DISPLAY } from '../lib/api';
import type { Metrics } from '../lib/api';
import './Home.css';

// The public surface is pricing and docs, and `/` used to hand the visitor
// straight to /pricing (App.tsx rendered <Navigate>). That made the one URL a
// person is most likely to type a page with nothing on it: the product's
// positioning lived in lib/seo.ts and nowhere a visitor could read it.
//
// This page is assembled entirely from what the design system already
// specified and what the withdrawal left behind: .hero/.hero-split/
// .metrics-strip/.grid3 and .display-xl in styles.css (the block still headed
// "home (moved from Home.tsx inline <style>)"), AuroraBackground, and CodeBlock
// — all of which had zero consumers once Home.tsx was deleted. Nothing new is
// invented here; the marketing layer is wired back up rather than rebuilt, so
// the measured fixes those rules carry (the aurora's full-bleed mask, the
// metrics strip's left rail, the shiny headline's base colour) come along for
// free.
//
// The headline uses .shiny-text through .display-xl rather than plain text
// because styles.css:481 sets --shiny-base for exactly that pairing, and the
// sweep is the one piece of motion on the page that is not a fade. It is
// decorative: the text is fully legible with the animation disabled, and
// .shiny-text-disabled is what a reduced-motion caller would reach for.

const CURL_SAMPLE = `curl https://fudrouter.my.id/v1/chat/completions \\
  -H "Authorization: Bearer $FUDRouter_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{ "role": "user", "content": "Hello" }],
    "stream": true
  }'`;

// The hero tabs reuse CodeBlock rather than forking it: its bar already
// renders the language label and a copy button with the plain-HTTP clipboard
// fallback, so switching tabs is a prop change and nothing else. Python, Node
// and Go interpolate API_BASE_DISPLAY — the same origin CURL_SAMPLE hardcodes
// — so an operator overriding VITE_PUBLIC_API_BASE_URL re-points every sample
// at once. The Go sample omits streaming: the Go SDK idiom is a consumer loop,
// and a demonstration snippet is not the place for it.
const SAMPLES = [
  { name: 'curl', label: 'cURL', code: CURL_SAMPLE },
  {
    name: 'python',
    label: 'Python',
    code: `from openai import OpenAI

client = OpenAI(
    base_url="${API_BASE_DISPLAY}/v1",
    api_key="YOUR_FUDROUTER_API_KEY",
)
resp = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "Hello"}],
    stream=True,
)`,
  },
  {
    name: 'node',
    label: 'Node',
    code: `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${API_BASE_DISPLAY}/v1",
  apiKey: process.env.FUDRouter_API_KEY,
});
const stream = await client.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Hello" }],
  stream: true,
});`,
  },
  {
    name: 'go',
    label: 'Go',
    code: `client := openai.NewClient(
    option.WithBaseURL("${API_BASE_DISPLAY}/v1"),
    option.WithAPIKey(os.Getenv("FUDRouter_API_KEY")),
)
resp, err := client.Chat.Completions.New(ctx, openai.ChatCompletionNewParams{
    Model:    "gpt-4o-mini",
    Messages: []openai.ChatCompletionMessageParam{openai.UserMessage("Hello")},
})`,
  },
] as const;

// Three claims, not a feature grid. Each one is a thing the router actually
// does and a visitor can verify from the docs, rather than an adjective.
const PILLARS = [
  {
    title: 'One key, every model',
    body: 'Point a client at one endpoint and switch models by name. No per-provider SDK, no second account.',
  },
  {
    title: 'Metered per request',
    body: 'Every call is logged with tokens, cost and latency. Usage is auditable rather than inferred from an invoice.',
  },
  {
    title: 'Fails over, not out',
    body: 'A provider error walks to the next candidate instead of surfacing. Limits and budgets are enforced before the call.',
  },
] as const;

// Every claim below is a thing the router does, stated the way the docs state
// it. The migration banner names no command: ops/import-9router-backup.mjs is
// an operator script that reads a local SQLite backup, not something a visitor
// can run, so the banner says what can be brought across and points at /docs.
const WITHOUT = [
  'A quota dies mid-task and the call fails with it.',
  'Base URLs get swapped by hand when a provider changes.',
  'No per-request cost trail — the invoice is the only record.',
  'Provider keys scattered across configs and CI secrets.',
] as const;

const WITH = [
  'Automatic fallback walks to the next provider on a retryable failure.',
  'One OpenAI-compatible endpoint, one key, every model behind it.',
  'A per-request credit ledger: tokens, cost, latency, status.',
  'Credentials encrypted at rest, plus an audit trail on every change.',
] as const;

const STEPS = [
  {
    title: 'Providers are connected for you',
    body: 'The platform connects providers once, on the operator side. Credentials are encrypted at rest and decrypted only in the data plane, so the console never holds a usable key — your work starts at the key, not at provider setup.',
  },
  {
    title: 'Routing with fallback',
    body: 'Candidates are ordered by the policy bound to your key. If a credential fails, it is skipped for five minutes and the next candidate is tried, so one bad account does not fail your call.',
  },
  {
    title: 'Point your client at the base URL',
    body: 'Set the base URL and your key in any OpenAI-compatible client. Nothing else changes — the model name selects the route.',
  },
] as const;

const FAQ: { q: string; a: string }[] = [
  {
    q: 'How are API keys stored?',
    a: 'Only the SHA-256 hash of the secret is stored. The plaintext key is shown once at creation and cannot be recovered — a lost key is replaced, never retrieved.',
  },
  {
    q: 'Do you store prompts and responses?',
    a: 'No. Each request writes one ledger row with the model, provider, tokens, cost, latency, status and client IP. Prompt and response bodies are not stored.',
  },
  {
    q: 'What happens when my credit runs out?',
    a: 'The request is refused with HTTP 402 INSUFFICIENT_CREDITS before it reaches a provider. There is no overage and no negative balance.',
  },
  {
    q: 'Which providers are supported?',
    a: 'Whatever is configured in the provider catalog. The catalog and the request path are the same list, so a model on the pricing page is a model the router can serve.',
  },
  {
    q: 'Can I self-host it?',
    a: 'No. Self-hosting is not supported — this is a hosted service only.',
  },
  {
    q: 'I am coming from 9Router. Can I migrate?',
    a: 'Provider keys and model aliases can be brought across. The docs cover what maps and what does not.',
  },
];

/** Inline X marker for the "without" column. Inherits color via currentColor. */
function Cross() {
  return (
    <svg className="home-mark home-mark--no" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** Inline check marker for the "with" column. Inherits color via currentColor. */
function Check() {
  return (
    <svg className="home-mark home-mark--yes" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Two-plane architecture diagram. The asymmetry is the point: the client→data
// plane edge is the heavy hot path (/v1/* on :8100) while the client→control
// plane edge is a thin dashed management path (the console on :3000) — the
// control plane is not in the request path. Coordinates are hand-placed for
// the 720×300 viewBox. The svg used to scale down intact on narrow screens,
// which rendered the 13px labels at ~7px on a 375px phone; below 640px the
// narrow group swaps in a portrait chain with larger type instead.
function ArchDiagram() {
  return (
    <>
      <svg className="arch arch-wide" viewBox="0 0 720 300" role="img" aria-labelledby="arch-title arch-desc">
      <title id="arch-title">Two-plane architecture</title>
      <desc id="arch-desc">A client sends inference requests directly to the data plane on port 8100, which authenticates, applies limits and dials the upstream provider. The control plane on port 3000 serves the console — auth, billing, admin — and is not in the request path. Both planes read Postgres and Valkey.</desc>
      <defs>
        <marker id="arch-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 8 4 0 8z" className="arch-arrowhead" />
        </marker>
        <marker id="arch-arrow-hot" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 8 4 0 8z" className="arch-arrowhead arch-arrowhead--hot" />
        </marker>
      </defs>
      <g className="arch-edge arch-edge--hot">
        <line x1={130} y1={128} x2={250} y2={82} markerEnd="url(#arch-arrow-hot)" />
      </g>
      <g className="arch-edge arch-edge--mgmt">
        <line x1={130} y1={156} x2={250} y2={208} markerEnd="url(#arch-arrow)" />
      </g>
      <g className="arch-edge arch-edge--hot">
        <line x1={420} y1={82} x2={600} y2={82} markerEnd="url(#arch-arrow-hot)" />
      </g>
      <g className="arch-edge">
        <line x1={420} y1={100} x2={480} y2={126} markerEnd="url(#arch-arrow)" />
      </g>
      <g className="arch-edge">
        <line x1={420} y1={108} x2={480} y2={196} markerEnd="url(#arch-arrow)" />
      </g>
      <g className="arch-edge">
        <line x1={400} y1={190} x2={515} y2={154} markerEnd="url(#arch-arrow)" />
      </g>
      <g className="arch-edge">
        <line x1={420} y1={212} x2={480} y2={204} markerEnd="url(#arch-arrow)" />
      </g>
      <text className="arch-label" x={190} y={74} textAnchor="middle">hot path · /v1/*</text>
      <text className="arch-label" x={190} y={197} textAnchor="middle">console</text>
      <g className="arch-node">
        <rect x={20} y={120} width={110} height={44} rx={8} />
        <text x={75} y={147} textAnchor="middle">Client</text>
      </g>
      <g className="arch-node">
        <rect x={250} y={60} width={170} height={60} rx={8} />
        <text x={335} y={80} textAnchor="middle">Data plane</text>
        <text className="arch-sub" x={335} y={96} textAnchor="middle">:8100 · auth, limits</text>
        <text className="arch-sub" x={335} y={109} textAnchor="middle">upstream dial</text>
      </g>
      <g className="arch-node">
        <rect x={250} y={190} width={170} height={60} rx={8} />
        <text x={335} y={210} textAnchor="middle">Control plane</text>
        <text className="arch-sub" x={335} y={226} textAnchor="middle">:3000 · console, auth</text>
        <text className="arch-sub" x={335} y={239} textAnchor="middle">billing, admin</text>
      </g>
      <g className="arch-node">
        <rect x={480} y={110} width={130} height={44} rx={8} />
        <text x={545} y={137} textAnchor="middle">Postgres</text>
      </g>
      <g className="arch-node">
        <rect x={480} y={180} width={130} height={44} rx={8} />
        <text x={545} y={207} textAnchor="middle">Valkey</text>
      </g>
      <g className="arch-node">
        <rect x={600} y={60} width={100} height={44} rx={8} />
        <text x={650} y={87} textAnchor="middle">Provider</text>
      </g>
    </svg>
    <svg className="arch arch-narrow" viewBox="0 0 360 270" role="img" aria-labelledby="arch-title-n arch-desc-n">
      <title id="arch-title-n">Two-plane architecture</title>
      <desc id="arch-desc-n">A client sends inference requests directly to the data plane on port 8100, which authenticates, applies limits and dials the upstream provider. The control plane on port 3000 serves the console — auth, billing, admin — and is not in the request path. Both planes read Postgres and Valkey.</desc>
      <defs>
        <marker id="arch-arrow-n" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 8 4 0 8z" className="arch-arrowhead" />
        </marker>
        <marker id="arch-arrow-hot-n" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 8 4 0 8z" className="arch-arrowhead arch-arrowhead--hot" />
        </marker>
      </defs>
      <g className="arch-edge arch-edge--hot">
        <line x1={180} y1={38} x2={180} y2={62} markerEnd="url(#arch-arrow-hot-n)" />
      </g>
      <g className="arch-edge arch-edge--mgmt">
        <polyline points="110,21 4,21 4,217 10,217" markerEnd="url(#arch-arrow-n)" />
      </g>
      <g className="arch-edge arch-edge--hot">
        <line x1={250} y1={107} x2={258} y2={107} markerEnd="url(#arch-arrow-hot-n)" />
      </g>
      <g className="arch-edge">
        <line x1={250} y1={140} x2={258} y2={192} markerEnd="url(#arch-arrow-n)" />
      </g>
      <g className="arch-edge">
        <line x1={250} y1={148} x2={258} y2={242} markerEnd="url(#arch-arrow-n)" />
      </g>
      <g className="arch-edge">
        <line x1={250} y1={192} x2={258} y2={192} markerEnd="url(#arch-arrow-n)" />
      </g>
      <g className="arch-edge">
        <line x1={250} y1={242} x2={258} y2={242} markerEnd="url(#arch-arrow-n)" />
      </g>
      <text className="arch-label" x={190} y={54} textAnchor="start">hot path · /v1/*</text>
      <text className="arch-label" x={10} y={166} textAnchor="start">console</text>
      <g className="arch-node">
        <rect x={110} y={4} width={140} height={34} rx={8} />
        <text x={180} y={27} textAnchor="middle">Client</text>
      </g>
      <g className="arch-node">
        <rect x={4} y={62} width={246} height={90} rx={8} />
        <text x={127} y={88} textAnchor="middle">Data plane</text>
        <text className="arch-sub" x={127} y={112} textAnchor="middle">:8100 · auth, limits</text>
        <text className="arch-sub" x={127} y={134} textAnchor="middle">upstream dial</text>
      </g>
      <g className="arch-node">
        <rect x={4} y={172} width={246} height={90} rx={8} />
        <text x={127} y={198} textAnchor="middle">Control plane</text>
        <text className="arch-sub" x={127} y={222} textAnchor="middle">:3000 · console, auth</text>
        <text className="arch-sub" x={127} y={244} textAnchor="middle">billing, admin</text>
      </g>
      <g className="arch-node">
        <rect x={258} y={62} width={94} height={90} rx={8} />
        <text x={305} y={112} textAnchor="middle">Provider</text>
      </g>
      <g className="arch-node">
        <rect x={258} y={172} width={94} height={40} rx={8} />
        <text x={305} y={197} textAnchor="middle">Postgres</text>
      </g>
      <g className="arch-node">
        <rect x={258} y={222} width={94} height={40} rx={8} />
        <text x={305} y={247} textAnchor="middle">Valkey</text>
      </g>
    </svg>
    </>
  );
}

export function HomePage() {
  // The strip reads the same public metrics endpoint the docs page links to.
  // It is the only dynamic element on the page and it degrades to nothing:
  // a failure hides the strip rather than showing an error, because a broken
  // figure is worse than an absent one on a landing page. The endpoint answers
  // { metrics, sampleModels } and each figure is nullable, so a null is treated
  // exactly like a failure — that figure stays hidden rather than printing "0".
  // The rule is per figure, not per strip: the strip renders whenever at least
  // one figure has a value, and each figure renders only when it has one.
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  // Hero code tabs: index into SAMPLES rather than a name lookup, so the
  // selected sample is always a real entry and the tab buttons stay plain
  // buttons (role=tab/aria-selected, the shape logs.tsx already uses).
  const [sample, setSample] = useState(0);
  useEffect(() => {
    let live = true;
    void api
      .metrics()
      .then((d) => {
        const m = d?.metrics;
        if (live && m) setMetrics(m);
      })
      .catch(() => {
        // Deliberately silent: see the note above.
      });
    return () => {
      live = false;
    };
  }, []);

  const figures: { value: number | null; label: string; format: (n: number) => string }[] = [
    { value: metrics?.models ?? null, label: 'models live', format: (n) => n.toLocaleString('en-US') },
    { value: metrics?.providers ?? null, label: 'providers connected', format: (n) => n.toLocaleString('en-US') },
    { value: metrics?.calls24h ?? null, label: 'requests served (24h)', format: (n) => n.toLocaleString('en-US') },
    { value: metrics?.p50Ms ?? null, label: 'median latency', format: (n) => `${n.toLocaleString('en-US')} ms` }
  ];
  const shown = figures.filter((f) => f.value != null);

  return (
    <div className="hero">
      <AuroraBackground />
      <Reveal>
        <p className="fr-label">one API key, every model</p>
        <h1 className="display-xl shiny-text">Route to any model.<br />Pay for what you use.</h1>
        <p className="lede">
          A commercial AI router with per-request metering, rate limits and an auditable ledger. One endpoint, one key, every
          provider behind it.
        </p>
        <div className="hero-split">
          <div className="hero-copy">
            <div className="row">
              <Link to="/login">
                <Button>Get started</Button>
              </Link>
              <Link to="/pricing">
                <Button variant="secondary">See pricing</Button>
              </Link>
            </div>
            <p className="muted">Then mint a key and point a client at the API.</p>
          </div>
          <div className="hero-code">
            {/* role=tab buttons rather than a tab library: four static tabs
                need keyboard reachability (buttons are natively focusable and
                activatable), not arrow-key roving focus. Same pattern as
                logs.tsx. */}
            <div className="home-tabs" role="tablist" aria-label="Code sample language">
              {SAMPLES.map((s, i) => (
                <button
                  key={s.name}
                  type="button"
                  role="tab"
                  aria-selected={sample === i}
                  className="home-tab"
                  onClick={() => setSample(i)}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <CodeBlock code={SAMPLES[sample].code} name={SAMPLES[sample].name} />
            <p className="home-base-url">
              Base URL: <code>{API_BASE_DISPLAY}</code> — change it to yours.
            </p>
          </div>
        </div>
        {shown.length > 0 ? (
          <div className="metrics-strip">
            {shown.map((f) => (
              <div key={f.label}>
                <div className="num">{f.format(f.value as number)}</div>
                <div className="muted">{f.label}</div>
              </div>
            ))}
          </div>
        ) : null}
        <div className="grid3">
          {PILLARS.map((p) => (
            <div key={p.title} className="card">
              <h3 className="card-title">{p.title}</h3>
              <p className="card-desc">{p.body}</p>
            </div>
          ))}
        </div>
      </Reveal>

      <div className="home-body">
        <section className="home-section" aria-labelledby="home-compare">
          <h2 id="home-compare">The difference a router makes</h2>
          <div className="home-compare">
            <div className="home-col">
              <p className="fr-label">Without a router</p>
              <ul className="home-list">
                {WITHOUT.map((w) => (
                  <li key={w}>
                    <Cross /> {w}
                  </li>
                ))}
              </ul>
            </div>
            <div className="home-col">
              <p className="fr-label">With FUDRouter</p>
              <ul className="home-list">
                {WITH.map((w) => (
                  <li key={w}>
                    <Check /> {w}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section className="home-section" aria-labelledby="home-how">
          <h2 id="home-how">How it works</h2>
          {/* Panels, not a numbered list: the spec asks for a flow diagram, and
              the sequence is carried by the <ol> itself plus the rendered
              counter, so the arrows are decoration rather than the only
              ordering cue. Panel 3's copyable line reuses CodeBlock instead of
              a second clipboard implementation — the hero already carries the
              full cURL sample, so duplicating it here would put the same
              content twice on one page. */}
          <ol className="home-flow">
            {STEPS.map((s, i) => (
              <li key={s.title} className="home-flow-panel">
                <span className="home-flow-num" aria-hidden="true">{i + 1}</span>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
                {i === STEPS.length - 1 ? <CodeBlock code={API_BASE_DISPLAY} name="base url" /> : null}
              </li>
            ))}
          </ol>
        </section>

        <section className="home-section" aria-labelledby="home-planes">
          <h2 id="home-planes">Two planes, not one</h2>
          <ArchDiagram />
          <div className="home-prose">
            <p>
              The console is not a security boundary. It manages keys, limits and billing, but it cannot mint traffic the router
              accepts: the data plane re-authenticates every key, re-resolves its limits and re-guards SSRF independently, so a
              compromised console buys an attacker nothing on the hot path.
            </p>
            <p>
              Both planes carry their own SSRF guard, and neither trusts the other's answer about where a request may go. The
              details are in the <Link to="/docs">docs</Link>.
            </p>
          </div>
        </section>

        <section className="home-banner" aria-labelledby="home-migrate">
          <h2 id="home-migrate">Coming from 9Router?</h2>
          <p>
            Provider keys and model aliases can be brought across. The <Link to="/docs">docs</Link> cover what maps and what does
            not.
          </p>
        </section>

        <section className="home-section" aria-labelledby="home-faq">
          <h2 id="home-faq">Questions</h2>
          <div className="home-faq">
            {FAQ.map((f) => (
              <details key={f.q}>
                <summary>{f.q}</summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="home-cta" aria-labelledby="home-cta">
          <h2 id="home-cta">Start routing in five minutes.</h2>
          <div className="row">
            <Link to="/login">
              <Button>Get started</Button>
            </Link>
            <span className="muted">Then mint a key and point a client at the API.</span>
          </div>
        </section>
      </div>
    </div>
  );
}

export default HomePage;
