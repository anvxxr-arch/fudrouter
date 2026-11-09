import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { X, Check } from 'lucide-react';
import { cn } from 'cn';
import { AuroraBackground } from '../components/AuroraBackground';
import { CountUp } from '../components/CountUp';
import { Reveal } from '../components/Reveal';
import { Button } from '../components/ui/button';
import { CodeBlock } from '../components/ui/code-block';
import { api, API_BASE_DISPLAY } from '../lib/api';
import type { Metrics } from '../lib/api';

// The public surface is pricing and docs, and `/` used to hand the visitor
// straight to /pricing (App.tsx rendered <Navigate>). That made the one URL a
// person is most likely to type a page with nothing on it: the product's
// positioning lived in lib/seo.ts and nowhere a visitor could read it.
//
// This page is assembled entirely from what the design system already
// specified: the hero lockup, the metrics strip, the pillar cards, the
// before/after, the three-panel flow and the FAQ. The markup is Tailwind +
// shadcn primitives; the only bespoke surface left is AuroraBackground, which
// is data-free decoration.

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
    <div className="relative isolate">
      <AuroraBackground />
      <Reveal>
        <p className="eyebrow">one API key, every model</p>
        <h1 className="display-xl">
          Route to any model.<br />Pay for what you use.
        </h1>
        <p className="mt-6 measure text-lg text-muted-foreground">
          A commercial AI router with per-request metering, rate limits and an auditable ledger. One endpoint, one key, every
          provider behind it.
        </p>
        <div className="mt-8 flex flex-wrap gap-8 items-start">
          <div className="grid min-w-0 flex-1 basis-80 gap-4">
            <div className="flex flex-wrap gap-3">
              <Link to="/login">
                <Button>Get started</Button>
              </Link>
              <Link to="/pricing">
                <Button variant="outline">See pricing</Button>
              </Link>
            </div>
            <p className="measure text-muted-foreground">Then mint a key and point a client at the API.</p>
          </div>
          <div className="min-w-0 flex-1 basis-96 max-w-[34rem]">
            <CodeBlock
              code={SAMPLES[sample].code}
              name={SAMPLES[sample].name}
              tabs={SAMPLES.map((s) => s.label)}
              activeTab={sample}
              onTabChange={setSample}
            />
            <p className="mt-2 text-sm text-muted-foreground">
              Base URL: <code className="font-mono text-xs">{API_BASE_DISPLAY}</code> — change it to yours.
            </p>
          </div>
        </div>
      </Reveal>
      <Reveal delay={60}>
        {shown.length > 0 ? (
          <div className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
            {shown.map((f, i) => (
              <div key={f.label} className={cn('relative min-w-0', i > 0 && 'lg:border-l lg:border-border lg:pl-6')}>
                <div className="stat-figure">
                  <CountUp value={f.value as number} format={f.format} />
                </div>
                <div className="mt-1 text-sm text-muted-foreground">{f.label}</div>
              </div>
            ))}
          </div>
        ) : null}
      </Reveal>
      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {PILLARS.map((p, i) => (
            <Reveal
              key={p.title}
              className="flex h-full flex-col gap-2 surface p-5"
              delay={i * 90}
            >
              <h3 className="text-lg">{p.title}</h3>
              <p className="text-sm text-muted-foreground">{p.body}</p>
            </Reveal>
          ))}
      </div>

      <div className="mt-10 grid gap-16">
        <Reveal as="section" className="grid gap-4 content-start" aria-labelledby="home-compare">
          <h2 id="home-compare">The difference a router makes</h2>
          <div className="grid grid-cols-1 gap-8 items-start lg:grid-cols-2">
            <div className="grid content-start gap-2">
              <p className="eyebrow">Without a router</p>
              <ul className="grid gap-2">
                {WITHOUT.map((w) => (
                  <li key={w} className="flex items-start gap-2 text-muted-foreground">
                    <X className="mt-0.5 size-3.5 flex-none text-[var(--destructive)]" aria-hidden="true" /> {w}
                  </li>
                ))}
              </ul>
            </div>
            <div className="grid content-start gap-2">
              <p className="eyebrow">With FUDRouter</p>
              <ul className="grid gap-2">
                {WITH.map((w) => (
                  <li key={w} className="flex items-start gap-2 text-muted-foreground">
                    <Check className="mt-0.5 size-3.5 flex-none text-[var(--primary)]" aria-hidden="true" /> {w}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Reveal>

        <Reveal as="section" className="grid gap-4 content-start" aria-labelledby="home-how">
          <h2 id="home-how">How it works</h2>
          {/* Panels, not a numbered list: the spec asks for a flow diagram, and
              the sequence is carried by the <ol> itself plus the rendered
              counter, so the arrows are decoration rather than the only
              ordering cue. Panel 3's copyable line reuses CodeBlock instead of
              a second clipboard implementation — the hero already carries the
              full cURL sample, so duplicating it here would put the same
              content twice on one page. */}
          <ol className="grid grid-cols-1 gap-8 lg:grid-cols-3">
            {STEPS.map((s, i) => (
              <li key={s.title} className="relative grid content-start gap-2 surface p-5">
                <span
                  className="grid size-8 place-items-center rounded-full border border-border font-mono text-sm text-[var(--chart-3)]"
                  aria-hidden="true"
                >
                  {i + 1}
                </span>
                <h3 className="text-lg">{s.title}</h3>
                <p className="m-0 text-muted-foreground">{s.body}</p>
                {i === STEPS.length - 1 ? <CodeBlock code={API_BASE_DISPLAY} name="base url" /> : null}
              </li>
            ))}
          </ol>
        </Reveal>

        <Reveal as="section" className="grid gap-4 content-start" aria-labelledby="home-faq">
          <h2 id="home-faq">Questions</h2>
          <div className="measure">
            {FAQ.map((f) => (
              <details key={f.q} className="rounded-md border border-border bg-[var(--card)]">
                <summary className="cursor-pointer rounded-md px-4 py-2 font-semibold">{f.q}</summary>
                <p className="m-0 border-t border-border px-4 py-2 text-sm text-muted-foreground">{f.a}</p>
              </details>
            ))}
          </div>
        </Reveal>

        <Reveal as="section" className="grid gap-4 border-t border-border pt-6" aria-labelledby="home-cta">
          <h2 id="home-cta">Start routing in five minutes.</h2>
          <div className="flex flex-wrap gap-3 items-center">
            <Link to="/login">
              <Button>Get started</Button>
            </Link>
            <span className="text-muted-foreground">Then mint a key and point a client at the API.</span>
          </div>
        </Reveal>
      </div>
    </div>
  );
}

export default HomePage;
