import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Reveal } from '../components/Reveal';
import { Button } from '../components/ui/button';
import { Table } from '../components/ui/table';
import { api, formatContext, formatPricePer1M } from '../lib/api';

interface Tier {
  name: string;
  price: string;
  period: string;
  blurb: string;
  features: string[];
  cta: string;
  to: string;
  highlight?: boolean;
}

// One plain const so the marketing copy is auditable in one place. Every
// number here is a plan price, not a token allowance: the free tier's model
// list is whatever the gateway's freebuff pool serves, and quoting a token
// count we cannot back with data would be a promise the ledger can't keep.
const TIERS: Tier[] = [
  {
    name: 'Free',
    price: '$0',
    period: 'forever',
    blurb: 'Free-tier models, metered per token.',
    features: ['Free-tier models', '1 API key', 'Community support'],
    cta: 'Start free',
    to: '/login',
  },
  {
    name: 'Pro',
    price: '$20',
    period: 'per month',
    blurb: 'Every model, with fallback routing.',
    features: ['All models', '10 API keys', 'Fallback routing', 'Email support'],
    cta: 'Get Pro',
    to: '/login',
    highlight: true,
  },
  {
    name: 'Team',
    price: '$99',
    period: 'per month',
    blurb: 'For teams that need an audit trail.',
    features: ['Multi-project', 'Audit log', 'Priority support'],
    cta: 'Get Team',
    to: '/login',
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    period: 'annual',
    blurb: 'Your provider credentials, your terms.',
    features: ['Dedicated provider credentials', 'SSO', 'NET-30 invoicing'],
    cta: 'Read the docs',
    to: '/docs',
  },
];

// The only public routes are /, /pricing, /docs, /docs/* and /login — every
// CTA above points at one of them. /signup redirects to /login, so nothing
// links there directly.
const FAQ: { q: string; a: string }[] = [
  {
    q: 'Do unused credits expire?',
    a: 'No. Credits you top up stay on your balance until you spend them, however long that takes.',
  },
  {
    q: 'What happens when my balance hits zero?',
    a: 'The request is refused with HTTP 402 (INSUFFICIENT_CREDITS) before it reaches a provider. There is no overage and no negative balance — top up and retry.',
  },
  {
    q: 'How is each request billed?',
    a: 'Every request writes one credit_ledger row when it finishes, with an idempotency key so a retry cannot double-charge. The row records the tokens actually used, not an estimate.',
  },
  {
    q: 'What do the price columns mean?',
    a: 'Input is the per-1M-token rate for prompt tokens, cached input is the discounted rate for prompt tokens the provider has already seen, and output is the rate for tokens the model generates. All three are normalized to micro-dollars per 1M tokens.',
  },
  {
    q: 'Why is cached input cheaper?',
    a: 'Providers charge less for prompt tokens they have already processed, so the router passes that discount through at the same rate it receives it.',
  },
  {
    q: 'What is in the free tier?',
    a: 'The models the gateway serves from its free provider pool, one API key, and community support. Usage is metered the same way as paid tiers — per token, from your balance.',
  },
  {
    q: 'Can prices change?',
    a: 'Yes. Model prices track the upstream providers and can change. The table on this page always shows the current rates; a request is billed at the rate in effect when it runs.',
  },
  {
    q: 'Do you offer invoices or refunds?',
    a: 'Not yet. There is no invoice or refund flow implemented — billing today is prepaid credits only. Enterprise plans are quoted individually with NET-30 terms.',
  },
];

/** Inline check mark for tier feature lists. Inherits color via currentColor. */
function Check() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" className="pricing-check">
      <path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Credit flow diagram: top-up feeds the balance, each request draws it down
 * through a ledger entry, and a low balance raises a threshold alert. Pure
 * SVG so it inherits the theme (currentColor / CSS vars only).
 */
function FlowDiagram() {
  const nodes = [
    { x: 10, y: 10, label: 'Top-up' },
    { x: 150, y: 10, label: 'Balance' },
    { x: 290, y: 10, label: 'Request' },
    { x: 290, y: 90, label: 'Ledger entry' },
    { x: 150, y: 90, label: 'Balance down' },
    { x: 10, y: 90, label: 'Threshold alert' },
  ];
  const edges: { x1: number; y1: number; x2: number; y2: number }[] = [
    { x1: 62, y1: 30, x2: 150, y2: 30 },
    { x1: 202, y1: 30, x2: 290, y2: 30 },
    { x1: 310, y1: 42, x2: 310, y2: 90 },
    { x1: 290, y1: 110, x2: 202, y2: 110 },
    { x1: 150, y1: 110, x2: 62, y2: 110 },
  ];
  return (
    <svg viewBox="0 0 400 140" className="pricing-flow" role="img" aria-label="Credit flow: top-up adds to balance, a request draws it down through a ledger entry, and a low balance raises a threshold alert">
      <title>Credit flow</title>
      <desc>Top-up feeds the credit balance. A request draws from the balance and writes a ledger entry, which decreases the balance. When the balance falls below the threshold, a threshold alert is raised.</desc>
      {edges.map((e, i) => (
        <g key={i} className="pricing-flow-edge">
          <line x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} markerEnd="url(#pricing-arrow)" />
        </g>
      ))}
      <defs>
        <marker id="pricing-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 8 4 0 8z" fill="currentColor" />
        </marker>
      </defs>
      {nodes.map((n) => (
        <g key={n.label} className="pricing-flow-node">
          <rect x={n.x} y={n.y} width="120" height="40" rx="8" />
          <text x={n.x + 60} y={n.y + 25} textAnchor="middle">{n.label}</text>
        </g>
      ))}
    </svg>
  );
}

interface CalcModel {
  slug: string;
  name: string;
  inputMicro: bigint | null;
  outputMicro: bigint | null;
}

/** Same micro-unit parse as formatPricePer1M, kept local: api.ts is the
 *  display-formatting module and this page needs the raw integer. */
function microPer1M(value: string | null): bigint | null {
  if (value === null) return null;
  const [whole = '0', frac = ''] = value.trim().split('.');
  return BigInt(whole) * 1_000_000n + BigInt((frac + '000000').slice(0, 6));
}

function money(micro: bigint): string {
  const neg = micro < 0n;
  const abs = neg ? -micro : micro;
  // Integer formatting, no float. Two decimals normally; four sub-cent so a
  // real $0.0004 never flattens to $0.00; six below $0.0001, where four would
  // still print a nonzero cost as zero — the ledger's unit is the micro.
  const whole = abs / 1_000_000n;
  const frac = abs % 1_000_000n;
  const digits = abs >= 10_000n || abs === 0n ? 2 : abs >= 100n ? 4 : 6;
  const scale = 10n ** BigInt(digits);
  const fracUnits = (frac * scale) / 1_000_000n;
  const fracStr = fracUnits.toString().padStart(digits, '0');
  return `${neg ? '-' : ''}$${whole}.${fracStr}`;
}

/** Mirrors cost.go divRound exactly: zero short-circuit, then
 *  (tokens × price + 500_000) / 1_000_000 — half-up, BigInt only. */
function divRound(tokens: bigint, priceMicro: bigint): bigint {
  if (tokens === 0n || priceMicro === 0n) return 0n;
  return (tokens * priceMicro + 500_000n) / 1_000_000n;
}

export function PricingPage() {
  const [groups, setGroups] = useState<{ developer: string; models: { slug: string; name: string; price: { inputPriceMicro: string | null; cachedInputPriceMicro: string | null; outputPriceMicro: string | null }; context: number | null; variesByProvider: boolean }[] }[]>([]);
  const [error, setError] = useState(false);
  const [reqPerDay, setReqPerDay] = useState(1000);
  const [tokensPerReq, setTokensPerReq] = useState(2000);
  const [modelSlug, setModelSlug] = useState<string | null>(null);
  useEffect(() => {
    void api.pricing().then((d) => {
      if (d) {
        setGroups(d.groups);
        // Default to the most expensive model by output price so the
        // calculator's first estimate is an upper bound, never a surprise.
        const flat = d.groups.flatMap((g) => g.models);
        let best: CalcModel | null = null;
        for (const m of flat) {
          const out = microPer1M(m.price.outputPriceMicro);
          if (out === null) continue;
          if (best === null || out > (best.outputMicro ?? 0n)) {
            best = { slug: m.slug, name: m.name, inputMicro: microPer1M(m.price.inputPriceMicro), outputMicro: out };
          }
        }
        if (best) setModelSlug(best.slug);
      } else setError(true);
    });
  }, []);
  const models: CalcModel[] = useMemo(
    () =>
      groups.flatMap((g) =>
        g.models.map((m) => ({
          slug: m.slug,
          name: m.name,
          inputMicro: microPer1M(m.price.inputPriceMicro),
          outputMicro: microPer1M(m.price.outputPriceMicro),
        })),
      ),
    [groups],
  );
  const selected = models.find((m) => m.slug === modelSlug) ?? null;
  const calc = useMemo(() => {
    // A model with no output price cannot be estimated — substituting zero
    // would quote free output, so the calculator goes unavailable instead.
    if (!selected || selected.inputMicro === null || selected.outputMicro === null) return null;
    const reqMonth = BigInt(reqPerDay) * 30n;
    const tokensMonth = reqMonth * BigInt(tokensPerReq);
    // One input, split 60% input / 40% output — the assumption is stated
    // under the results, not hidden in the arithmetic.
    const outTokens = (tokensMonth * 40n) / 100n;
    const inTokens = tokensMonth - outTokens;
    const costMicro = divRound(inTokens, selected.inputMicro) + divRound(outTokens, selected.outputMicro);
    const perReq = reqMonth === 0n ? null : costMicro / reqMonth;
    return { tokensMonth, costMicro, perReq };
  }, [selected, reqPerDay, tokensPerReq]);

  return (
    <Reveal>
      <div className="stack">
        <h1>Pricing</h1>
        <p className="lede muted">Pay for what you use. Credits never expire. No per-seat fees.</p>

        <section aria-labelledby="pricing-plans">
          <h2 id="pricing-plans">Plans</h2>
          <div className="pricing-tiers">
            {TIERS.map((t) => (
              <div key={t.name} className={t.highlight ? 'pricing-tier pricing-tier--pro' : 'pricing-tier'}>
                {t.highlight ? <span className="pricing-tier-badge">Most popular</span> : null}
                <h3>{t.name}</h3>
                <p className="pricing-tier-price">
                  <span className="num">{t.price}</span> <span className="muted">{t.period}</span>
                </p>
                <p className="muted text-sm">{t.blurb}</p>
                <ul className="pricing-features">
                  {t.features.map((f) => (
                    <li key={f}>
                      <Check /> {f}
                    </li>
                  ))}
                </ul>
                <Link to={t.to}>
                  <Button variant={t.highlight ? 'primary' : 'secondary'} className="w-full">
                    {t.cta}
                  </Button>
                </Link>
              </div>
            ))}
          </div>
        </section>

        <section aria-labelledby="pricing-credits">
          <h2 id="pricing-credits">How credits work</h2>
          <div className="pricing-credits">
            <ol className="pricing-steps">
              <li>
                <strong>Top up.</strong> Add credits to your balance from the billing page. Credits never expire — an unused balance is not a liability.
              </li>
              <li>
                <strong>Every request writes a ledger row.</strong> When a request finishes, one <code>credit_ledger</code> row records the tokens actually used, with an idempotency key so a retry cannot double-charge.
              </li>
              <li>
                <strong>Zero balance returns 402.</strong> When the balance is exhausted the request is refused with HTTP 402 <code>INSUFFICIENT_CREDITS</code> at admission, before it reaches a provider. There is no overage charge — a request at a zero balance is refused before it reaches a provider.
              </li>
            </ol>
            <FlowDiagram />
          </div>
        </section>

        <section aria-labelledby="pricing-calc">
          <h2 id="pricing-calc">Cost calculator</h2>
          <div className="pricing-calc">
            <div className="pricing-calc-controls">
              <label>
                <span className="fr-label">Requests per day</span>
                <input type="range" min={0} max={100000} step={100} value={reqPerDay} onChange={(e) => setReqPerDay(Number(e.target.value))} />
                <span className="num">{reqPerDay.toLocaleString('en-US')}</span>
              </label>
              <label>
                <span className="fr-label">Average tokens per request</span>
                <input type="range" min={100} max={100000} step={100} value={tokensPerReq} onChange={(e) => setTokensPerReq(Number(e.target.value))} />
                <span className="num">{tokensPerReq.toLocaleString('en-US')}</span>
              </label>
              <label>
                <span className="fr-label">Model</span>
                <select className="select" value={modelSlug ?? ''} onChange={(e) => setModelSlug(e.target.value)}>
                  {models.map((m) => (
                    <option key={m.slug} value={m.slug}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {selected && calc ? (
              <div className="pricing-calc-results">
                <div>
                  <span className="fr-label">Tokens / month</span>
                  <span className="num">{calc.tokensMonth.toLocaleString('en-US')}</span>
                </div>
                <div>
                  <span className="fr-label">Estimated cost / month</span>
                  <span className="num">{money(calc.costMicro)}</span>
                </div>
                <div>
                  <span className="fr-label">Cost per request</span>
                  <span className="num">{calc.perReq === null ? '—' : money(calc.perReq)}</span>
                </div>
              </div>
            ) : (
              <div className="pricing-calc-results">
                <p className="muted text-sm">
                  {selected
                    ? 'This model has no output price in the catalog, so no estimate can be computed for it.'
                    : 'Loading the model catalog…'}
                </p>
              </div>
            )}
            <p className="muted text-sm">
              Assumes 60% of tokens are input and 40% output. Estimate only — credits are metered per request from the ledger, and the tier prices above are plan prices, not token allowances. Input and output only; cached-input and reasoning tokens bill at their own rates. The figure is a projection from your inputs, not a quote.
            </p>
          </div>
        </section>

        <section aria-labelledby="pricing-table">
          <h2 id="pricing-table">Model pricing table</h2>
          <p className="lede muted">Pay per token — no seat fees. One API key, every model. All prices normalized per 1M tokens.</p>
          {error ? <p className="error" role="alert">Pricing could not be loaded — reload in a moment.</p> : null}
          {groups.map((g) => (
            <section key={g.developer}>
              <h3>{g.developer} <span className="muted">· {g.models.length}</span></h3>
              <div className="table-wrap">
                <Table
                  head={['Model', 'Input', 'Cached input', 'Output', 'Context']}
                  rows={g.models.map((m) => [
                    // The model name is TEXT, not a link. It pointed at
                    // /models/:slug, and that page is withdrawn — every name in
                    // this table was a 404 while /pricing itself stayed indexable,
                    // which is the worst shape a link can have. When a per-model
                    // page comes back, this is the line that becomes a <Link>
                    // again.
                    <span key="m">{m.name}{m.slug !== m.name && <><br /><code className="muted">{m.slug}</code></>}</span>,
                    ...(m.variesByProvider
                      ? [<span key="v" className="muted">varies by provider</span>]
                      : [
                          <span key="i" className="num">{formatPricePer1M(m.price.inputPriceMicro)}</span>,
                          <span key="c" className="num">{formatPricePer1M(m.price.cachedInputPriceMicro)}</span>,
                          <span key="o" className="num">{formatPricePer1M(m.price.outputPriceMicro)}</span>,
                        ]),
                    <span key="x" className="num">{formatContext(m.context)}</span>,
                  ])}
                />
              </div>
            </section>
          ))}
        </section>

        <section aria-labelledby="pricing-faq">
          <h2 id="pricing-faq">Billing FAQ</h2>
          <div className="pricing-faq">
            {FAQ.map((f) => (
              <details key={f.q}>
                <summary>{f.q}</summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="pricing-cta" aria-labelledby="pricing-cta">
          <h2 id="pricing-cta">Start free. Upgrade when you need to.</h2>
          <div className="row">
            <Link to="/login"><Button>Get started</Button></Link>
            <span className="muted">Then mint a key and point a client at the API.</span>
          </div>
        </section>
      </div>
    </Reveal>
  );
}
