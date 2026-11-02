import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Reveal } from '../components/Reveal';
import { Button } from '../components/ui/button';
import { Table } from '../components/ui/table';
import { api, formatContext, formatPricePer1M, priceMicro } from '../lib/api';

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
// number here is a SUBSCRIPTION price (owner directive 2026-10-31): the member
// buys time, not tokens. The five plans and their prices are the same five the
// platform's `payments.ts` plan table and the migration's CHECK constraint
// pin — a price shown here that the checkout does not charge would be a lie.
const TIERS: Tier[] = [
  {
    name: '1 Day',
    price: 'Rp 5.000',
    period: '1 day',
    blurb: 'A single day of access.',
    features: ['All models', '1 API key', 'Up to 3 IPs', '5 concurrent requests'],
    cta: 'Buy 1 day',
    to: '/login',
  },
  {
    name: '3 Days',
    price: 'Rp 12.000',
    period: '3 days',
    blurb: 'A long weekend of access.',
    features: ['All models', '1 API key', 'Up to 3 IPs', '5 concurrent requests'],
    cta: 'Buy 3 days',
    to: '/login',
  },
  {
    name: '7 Days',
    price: 'Rp 30.000',
    period: '7 days',
    blurb: 'A full week, the most popular plan.',
    features: ['All models', '1 API key', 'Up to 3 IPs', '5 concurrent requests'],
    cta: 'Buy 7 days',
    to: '/login',
    highlight: true,
  },
  {
    name: '14 Days',
    price: 'Rp 50.000',
    period: '14 days',
    blurb: 'Two weeks of access.',
    features: ['All models', '1 API key', 'Up to 3 IPs', '5 concurrent requests'],
    cta: 'Buy 14 days',
    to: '/login',
  },
  {
    name: '28 Days',
    price: 'Rp 90.000',
    period: '28 days',
    blurb: 'A full month, the best value.',
    features: ['All models', '1 API key', 'Up to 3 IPs', '5 concurrent requests'],
    cta: 'Buy 28 days',
    to: '/login',
  },
];

// The only public routes are /, /pricing, /docs, /docs/* and /login — every
// CTA above points at one of them. /signup redirects to /login, so nothing
// links there directly.
const FAQ: { q: string; a: string }[] = [
  {
    q: 'How do I pay?',
    a: 'Pick a plan and pay the QRIS code shown at checkout. Send the payment proof back, and an admin confirms it — your API key is published the moment it is confirmed.',
  },
  {
    q: 'How long does confirmation take?',
    a: 'An admin is notified on Discord and Telegram the moment you claim a payment. Confirmation is manual, so it depends on the admin being online — usually minutes.',
  },
  {
    q: 'What happens when my subscription expires?',
    a: 'Your key stops serving requests. You have a 24-hour grace window to renew before the key is restricted; renewing any time restores access immediately.',
  },
  {
    q: 'How many API keys can I have?',
    a: 'Exactly one. Each member has a single key, so there is nothing to juggle and nothing to leak twice.',
  },
  {
    q: 'How many IPs can use my key?',
    a: 'Up to three. The first three addresses your key is used from are remembered; a fourth is refused. This is what stops a leaked key from being shared around.',
  },
  {
    q: 'How many requests can run at once?',
    a: 'Five concurrent requests per key. Each request can stream up to 150 tokens per second from the upstream.',
  },
  {
    q: 'Do you offer refunds?',
    a: 'No. A subscription is a prepaid window of time; once it is confirmed it is not refundable. Confirm the plan before you pay.',
  },
  {
    q: 'Can I stack plans?',
    a: 'Yes. Buying a second plan while one is active extends your access — the windows add up.',
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
// The catalog value is already micro-dollars per 1M tokens -- the unit the
// ledger bills in. Parsing it as dollars and multiplying by 1e6 inflated every
// estimate by a factor of a million.
function microPer1M(value: string | null): bigint | null {
  if (value === null) return null;
  return priceMicro(value);
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
        <p className="lede muted">Buy time, not tokens. One API key, every model, no per-request metering.</p>

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
          <h2 id="pricing-credits">How subscriptions work</h2>
          <div className="pricing-credits">
            <ol className="pricing-steps">
              <li>
                <strong>Pick a plan.</strong> Choose one of the five windows above. The price is the whole cost — there is no per-token charge on top.
              </li>
              <li>
                <strong>Pay by QRIS.</strong> Checkout shows a QRIS code for the exact amount. Pay it, then send the payment proof back.
              </li>
              <li>
                <strong>An admin confirms it.</strong> The admin is notified on Discord and Telegram with your proof. On confirmation your API key is published and your window starts.
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
