import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check } from 'lucide-react';
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
import { api, formatContext, formatPricePer1M, priceMicro } from '../lib/api';

// Derive the per-day figure from the displayed price string instead of adding a
// second hard-coded number per plan: one price, one source, nothing to drift.
// `Rp 30.000` + 7 days -> `Rp 4.286`, rounded to whole rupiah like the rest of
// the page. Returns an empty string for a malformed price so the row collapses
// rather than printing `NaN`.
function formatPerDay(price: string, days: number): string {
  const digits = price.replace(/[^\d]/g, '');
  if (!digits || !days) return '';
  const per = Math.round(parseInt(digits, 10) / days);
  return 'Rp ' + per.toLocaleString('id-ID');
}

interface Tier {
  name: string;
  days: number;
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
    days: 1,
    price: 'Rp 5.000',
    period: '1 day',
    blurb: 'A single day of access.',
    features: ['All models', '1 API key', 'Up to 3 IPs', '5 concurrent requests'],
    cta: 'Buy 1 day',
    to: '/login',
  },
  {
    name: '3 Days',
    days: 3,
    price: 'Rp 12.000',
    period: '3 days',
    blurb: 'A long weekend of access.',
    features: ['All models', '1 API key', 'Up to 3 IPs', '5 concurrent requests'],
    cta: 'Buy 3 days',
    to: '/login',
  },
  {
    name: '7 Days',
    days: 7,
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
    days: 14,
    price: 'Rp 50.000',
    period: '14 days',
    blurb: 'Two weeks of access.',
    features: ['All models', '1 API key', 'Up to 3 IPs', '5 concurrent requests'],
    cta: 'Buy 14 days',
    to: '/login',
  },
  {
    name: '28 Days',
    days: 28,
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
    <svg viewBox="0 0 400 140" className="h-auto w-full" role="img" aria-label="Credit flow: top-up adds to balance, a request draws it down through a ledger entry, and a low balance raises a threshold alert">
      <title>Credit flow</title>
      <desc>Top-up feeds the credit balance. A request draws from the balance and writes a ledger entry, which decreases the balance. When the balance falls below the threshold, a threshold alert is raised.</desc>
      <style>{`
        .flow-node rect { fill: var(--card); stroke: var(--border); }
        .flow-node text { fill: var(--foreground); font-family: var(--font-mono); font-size: 13px; }
        .flow-edge line { stroke: var(--border); stroke-width: 1.5; }
      `}</style>
      {edges.map((e, i) => (
        <g key={i} className="flow-edge">
          <line x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} markerEnd="url(#pricing-arrow)" />
        </g>
      ))}
      <defs>
        <marker id="pricing-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 8 4 0 8z" fill="currentColor" />
        </marker>
      </defs>
      {nodes.map((n) => (
        <g key={n.label} className="flow-node">
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

interface PriceCellProps {
  value: string | null;
}
function PriceCell({ value }: PriceCellProps) {
  return <span className="font-mono text-right tabular-nums whitespace-nowrap">{formatPricePer1M(value)}</span>;
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
      <div className="grid gap-6">
        <h1>Pricing</h1>
        <p className="measure text-lg text-muted-foreground">Buy time, not tokens. One API key, every model, no per-request metering.</p>

        <section aria-labelledby="pricing-plans">
          <h2 id="pricing-plans">Plans</h2>
          <div className="flex flex-wrap justify-center items-stretch gap-4">
            {TIERS.map((t) => (
              <div
                key={t.name}
                className={
                  t.highlight
                    ? 'relative flex basis-80 max-w-[22rem] min-w-0 flex-col gap-2 rounded-lg border-2 border-[var(--primary)] bg-[var(--card)] p-5'
                    : 'relative flex basis-80 max-w-[22rem] min-w-0 flex-col gap-2 surface p-5'
                }
              >
                {t.highlight ? (
                  <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-[var(--primary)] px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-[var(--primary-foreground)]">
                    Most popular
                  </span>
                ) : null}
                <h3 className="text-lg">{t.name}</h3>
                <p className="m-0 flex flex-col gap-0.5 stat-figure">
                  <span className="font-mono tabular-nums">{t.price}</span>
                  <span className="text-xs font-normal tracking-normal text-muted-foreground">{t.period}</span>
                </p>
                <p className="m-0 text-xs text-muted-foreground">
                  <span className="font-mono tabular-nums text-foreground">{formatPerDay(t.price, t.days)}</span> / day
                </p>
                <p className="m-0 min-h-[3em] text-sm text-muted-foreground">{t.blurb}</p>
                <ul className="m-0 mb-2 grid gap-1 p-0 text-sm">
                  {t.features.map((f) => (
                    <li key={f} className="flex items-start gap-2">
                      <Check className="mt-0.5 size-3.5 flex-none text-[var(--primary)]" aria-hidden="true" /> {f}
                    </li>
                  ))}
                </ul>
                <Link to={t.to} className="mt-auto">
                  <Button variant={t.highlight ? 'default' : 'secondary'} className="w-full">
                    {t.cta}
                  </Button>
                </Link>
              </div>
            ))}
          </div>
        </section>

        <section aria-labelledby="pricing-credits">
          <h2 id="pricing-credits">How subscriptions work</h2>
          <div className="grid items-start gap-8 lg:grid-cols-2">
            <ol className="m-0 grid gap-4 p-0">
              <li className="relative pl-12">
                <span className="absolute left-0 top-0 grid size-8 place-items-center rounded-full border border-border font-mono text-sm text-[var(--chart-3)]">1</span>
                <strong>Pick a plan.</strong> Choose one of the five windows above. The price is the whole cost — there is no per-token charge on top.
              </li>
              <li className="relative pl-12">
                <span className="absolute left-0 top-0 grid size-8 place-items-center rounded-full border border-border font-mono text-sm text-[var(--chart-3)]">2</span>
                <strong>Pay by QRIS.</strong> Checkout shows a QRIS code for the exact amount. Pay it, then send the payment proof back.
              </li>
              <li className="relative pl-12">
                <span className="absolute left-0 top-0 grid size-8 place-items-center rounded-full border border-border font-mono text-sm text-[var(--chart-3)]">3</span>
                <strong>An admin confirms it.</strong> The admin is notified on Discord and Telegram with your proof. On confirmation your API key is published and your window starts.
              </li>
            </ol>
            <FlowDiagram />
          </div>
        </section>

        <section aria-labelledby="pricing-calc">
          <h2 id="pricing-calc">Cost calculator</h2>
          <div className="grid items-start gap-6 lg:grid-cols-2">
            <div className="grid content-start gap-4">
              <label className="grid gap-1">
                <span className="eyebrow">Requests per day</span>
                <input type="range" min={0} max={100000} step={100} value={reqPerDay} onChange={(e) => setReqPerDay(Number(e.target.value))} className="w-full accent-[var(--primary)]" />
                <span className="font-mono tabular-nums">{reqPerDay.toLocaleString('en-US')}</span>
              </label>
              <label className="grid gap-1">
                <span className="eyebrow">Average tokens per request</span>
                <input type="range" min={100} max={100000} step={100} value={tokensPerReq} onChange={(e) => setTokensPerReq(Number(e.target.value))} className="w-full accent-[var(--primary)]" />
                <span className="font-mono tabular-nums">{tokensPerReq.toLocaleString('en-US')}</span>
              </label>
              <label className="grid gap-1">
                <span className="eyebrow">Model</span>
                <select
                  className="form-control w-full"
                  value={modelSlug ?? ''}
                  onChange={(e) => setModelSlug(e.target.value)}
                >
                  {models.map((m) => (
                    <option key={m.slug} value={m.slug}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {selected && calc ? (
              <div className="grid content-start gap-4">
                {[
                  { label: 'Tokens / month', value: calc.tokensMonth.toLocaleString('en-US') },
                  { label: 'Estimated cost / month', value: money(calc.costMicro) },
                  { label: 'Cost per request', value: calc.perReq === null ? '—' : money(calc.perReq) },
                ].map((r) => (
                  <div key={r.label} className="grid gap-0.5 rounded-md border border-border bg-[var(--card)] p-4">
                    <span className="eyebrow">{r.label}</span>
                    <span className="stat-figure">{r.value}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="grid content-start gap-4">
                <p className="text-sm text-muted-foreground measure">
                  {selected
                    ? 'This model has no output price in the catalog, so no estimate can be computed for it.'
                    : 'Loading the model catalog…'}
                </p>
              </div>
            )}
            <p className="text-sm text-muted-foreground measure col-span-full">
              Assumes 60% of tokens are input and 40% output. Estimate only — credits are metered per request from the ledger, and the tier prices above are plan prices, not token allowances. Input and output only; cached-input and reasoning tokens bill at their own rates. The figure is a projection from your inputs, not a quote.
            </p>
          </div>
        </section>

        <section aria-labelledby="pricing-table">
          <h2 id="pricing-table">Model pricing table</h2>
          <p className="measure text-lg text-muted-foreground">Pay per token — no seat fees. One API key, every model. All prices normalized per 1M tokens.</p>
          {error ? <p className="error-text" role="alert">Pricing could not be loaded — reload in a moment.</p> : null}
          {groups.map((g) => (
            <section key={g.developer}>
              <h3 className="text-lg">
                {g.developer} <span className="font-normal text-muted-foreground">· {g.models.length}</span>
              </h3>
              <Table>
                <TableHeader>
                  <TableRow className="border-b border-border">
                    <TableHead>Model</TableHead>
                    <TableHead>Input</TableHead>
                    <TableHead>Cached input</TableHead>
                    <TableHead>Output</TableHead>
                    <TableHead className="text-right">Context</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {g.models.map((m) => (
                    <TableRow key={m.slug}>
                      <TableCell>
                        <span className="whitespace-normal">
                          {m.name}
                          {m.slug !== m.name && (
                            <>
                              <br />
                              <code className="font-mono text-xs text-muted-foreground">{m.slug}</code>
                            </>
                          )}
                        </span>
                      </TableCell>
                      {m.variesByProvider ? (
                        <>
                          <TableCell colSpan={3} className="text-muted-foreground">varies by provider</TableCell>
                        </>
                      ) : (
                        <>
                          <TableCell><PriceCell value={m.price.inputPriceMicro} /></TableCell>
                          <TableCell><PriceCell value={m.price.cachedInputPriceMicro} /></TableCell>
                          <TableCell><PriceCell value={m.price.outputPriceMicro} /></TableCell>
                        </>
                      )}
                      <TableCell className="text-right font-mono text-muted-foreground tabular-nums">{formatContext(m.context)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </section>
          ))}
        </section>

        <section aria-labelledby="pricing-faq">
          <h2 id="pricing-faq">Billing FAQ</h2>
          <div className="measure grid gap-2">
            {FAQ.map((f) => (
              <details key={f.q} className="rounded-md border border-border bg-[var(--card)]">
                <summary className="cursor-pointer rounded-md px-4 py-2 font-semibold">{f.q}</summary>
                <p className="m-0 border-t border-border px-4 py-2 text-sm text-muted-foreground">{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="border-t border-border pt-6" aria-labelledby="pricing-cta">
          <h2 id="pricing-cta">Start free. Upgrade when you need to.</h2>
          <div className="flex flex-wrap items-center gap-3">
            <Link to="/login"><Button>Get started</Button></Link>
            <span className="text-muted-foreground">Then mint a key and point a client at the API.</span>
          </div>
        </section>
      </div>
    </Reveal>
  );
}
