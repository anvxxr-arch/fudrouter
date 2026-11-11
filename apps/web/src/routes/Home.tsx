import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AuroraBackground } from '../components/AuroraBackground';
import { CountUp } from '../components/CountUp';
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
  -H "Authorization: Bearer $FUDROUTER_API_KEY" \\
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
  apiKey: process.env.FUDROUTER_API_KEY,
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
    option.WithAPIKey(os.Getenv("FUDROUTER_API_KEY")),
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
                logs.tsx. The panel is wired with id/aria-controls so a screen
                reader announces the swap — `aria-selected` alone changes the
                tab's state without saying what it now shows. */}
            <div className="home-tabs" role="tablist" aria-label="Code sample language">
              {SAMPLES.map((s, i) => (
                <button
                  key={s.name}
                  type="button"
                  role="tab"
                  id={`home-sample-tab-${s.name}`}
                  aria-selected={sample === i}
                  aria-controls="home-sample-panel"
                  className="home-tab"
                  onClick={() => setSample(i)}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <div id="home-sample-panel" role="tabpanel" aria-labelledby={`home-sample-tab-${SAMPLES[sample].name}`}>
              <CodeBlock code={SAMPLES[sample].code} name={SAMPLES[sample].name} />
            </div>
            <p className="home-base-url">
              Base URL: <code>{API_BASE_DISPLAY}</code> — change it to yours.
            </p>
          </div>
        </div>
      </Reveal>
      <Reveal delay={60}>
        {shown.length > 0 ? (
          <div className="metrics-strip">
            {shown.map((f) => (
              <div key={f.label}>
                <div className="num">
                  <CountUp value={f.value as number} format={f.format} />
                </div>
                <div className="muted">{f.label}</div>
              </div>
            ))}
          </div>
        ) : null}
      </Reveal>
      <div className="grid3">
          {PILLARS.map((p, i) => (
            <Reveal key={p.title} className="card" delay={i * 90}>
              {/* h2, not h3: these three cards are the first subsections under
                  the hero's h1, and an h3 here skipped a level (h1 -> h3 ->
                  h2) for a screen reader's outline. .card-title sets the size,
                  so the rung is unchanged — see the note on .card-title in
                  styles.css for why it sits on the h5 step. */}
              <h2 className="card-title">{p.title}</h2>
              <p className="card-desc">{p.body}</p>
            </Reveal>
          ))}
      </div>

      <div className="home-body">
        <Reveal as="section" className="home-section" aria-labelledby="home-compare">
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
        </Reveal>

        <Reveal as="section" className="home-section" aria-labelledby="home-how">
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
        </Reveal>

        <Reveal as="section" className="home-section" aria-labelledby="home-faq">
          <h2 id="home-faq">Questions</h2>
          <div className="home-faq">
            {FAQ.map((f) => (
              <details key={f.q}>
                <summary>{f.q}</summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </Reveal>

        <Reveal as="section" className="home-cta" aria-labelledby="home-cta">
          <h2 id="home-cta">Start routing in five minutes.</h2>
          <div className="row">
            <Link to="/login">
              <Button>Get started</Button>
            </Link>
            <span className="muted">Then mint a key and point a client at the API.</span>
          </div>
        </Reveal>
      </div>
    </div>
  );
}

export default HomePage;
