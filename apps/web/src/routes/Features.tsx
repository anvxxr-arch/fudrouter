import { Link } from 'react-router-dom';
import { Reveal } from '../components/Reveal';
import { Badge, type Tone } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';

type FeatureStatus = 'GA' | 'Beta' | 'Planned';

// Badge tone per status: GA is the shipped default (ok), Beta is a warning to
// a buyer, Planned is informational. One map so a status rename cannot leave a
// card with the wrong color.
const STATUS_TONE: Record<FeatureStatus, Tone> = { GA: 'ok', Beta: 'warn', Planned: 'info' };

interface Feature {
  title: string;
  desc: string;
  status: FeatureStatus;
}

// Every claim here is backed by the repo: fallback/health in
// backend/go/internal/routing, micro-unit billing in the credit_ledger path,
// multi-tenant hierarchy in EffectiveLimits, budget gate returning 402
// INSUFFICIENT_CREDITS, audit_log via writeAudit, alias rewrite in
// ResolveModel. The Planned rows are the roadmap, not shipped features —
// they are labeled so the grid cannot oversell.
const FEATURES: Feature[] = [
  {
    title: 'Automatic fallback',
    desc: 'When a provider fails, the request walks the candidate list and retries the next provider without client involvement.',
    status: 'GA',
  },
  {
    title: 'Combo routing',
    desc: 'Compose an ordered fallback chain of models per request, with per-step conditions. On the roadmap for Q4 2026 — the data plane routes by capability and health today, not by a user-authored combo.',
    status: 'Planned',
  },
  {
    title: 'Credit billing',
    desc: 'Integer micro-units end to end — no floating point in the ledger. One credit_ledger row per request with an idempotency key.',
    status: 'GA',
  },
  {
    title: 'Multi-tenant',
    desc: 'workspace → project → api_key hierarchy; limits resolve as the MIN across platform, workspace, project, environment and key.',
    status: 'GA',
  },
  {
    title: 'Budget gate',
    desc: 'A zero balance refuses the request with HTTP 402 INSUFFICIENT_CREDITS before it reaches a provider. The hard stop gates admission, not in-flight spend.',
    status: 'GA',
  },
  {
    title: 'Audit log',
    desc: 'Every mutation writes an audit_log row through writeAudit, with secrets redacted before storage.',
    status: 'GA',
  },
  {
    title: 'Provider health / circuit breaker',
    desc: 'Per-connection credential pools rotate round-robin with a fail cooldown, so a flapping provider stops receiving traffic.',
    status: 'GA',
  },
  {
    title: 'Model rewrite (alias)',
    desc: 'ResolveModel maps aliases to canonical slugs, so a client can keep its model name while the backend moves.',
    status: 'GA',
  },
  {
    title: 'Token compression',
    desc: 'Compress request context before it is billed or forwarded. On the roadmap for Q4 2026.',
    status: 'Planned',
  },
  {
    title: 'Batch API',
    desc: 'Submit a batch of completions and let the router schedule them against provider rate limits. On the roadmap for Q4 2026.',
    status: 'Planned',
  },
  {
    title: 'MCP / A2A',
    desc: 'Serve MCP and agent-to-agent protocols natively from the gateway. On the roadmap for Q1 2027.',
    status: 'Planned',
  },
];

interface CompareRow {
  feature: string;
  us: string;
  nine: string;
  omni: string;
  lite: string;
}

// Competitor cells carry only what this repository's own migration
// documentation asserts about 9Router (ops/import-9router-backup.mjs reads its
// providerConnections/providerNodes rows; Home.tsx and the migration doc both
// state provider keys and model aliases import). Everything else is an em dash
// — an unverified cell, not a negative claim about the vendor.
const COMPARISON: CompareRow[] = [
  { feature: 'Automatic fallback', us: '✓', nine: '—', omni: '—', lite: '—' },
  { feature: 'Combo routing', us: 'Planned', nine: '—', omni: '—', lite: '—' },
  { feature: 'Credit billing (integer micro-units)', us: '✓', nine: '—', omni: '—', lite: '—' },
  { feature: 'Multi-tenant (workspace → project → api_key)', us: '✓', nine: '—', omni: '—', lite: '—' },
  { feature: 'Budget gate (402 before provider)', us: '✓', nine: '—', omni: '—', lite: '—' },
  { feature: 'Audit log', us: '✓', nine: '—', omni: '—', lite: '—' },
  { feature: 'Provider health / circuit breaker', us: '✓', nine: '—', omni: '—', lite: '—' },
  { feature: 'Model rewrite (alias)', us: '✓', nine: '✓', omni: '—', lite: '—' },
  { feature: 'Two-plane security', us: '✓', nine: '—', omni: '—', lite: '—' },
  { feature: 'SSRF guard on every upstream dial', us: '✓', nine: '—', omni: '—', lite: '—' },
  { feature: 'Postgres backend', us: '✓', nine: '—', omni: '—', lite: '—' },
  { feature: 'Go data plane', us: '✓', nine: '—', omni: '—', lite: '—' },
  { feature: 'Self-host', us: '✓', nine: '—', omni: '—', lite: '—' },
  { feature: 'Provider connections (importable)', us: '✓', nine: '✓', omni: '—', lite: '—' },
  { feature: 'Migration from 9Router', us: '✓', nine: '—', omni: '—', lite: '—' },
  { feature: 'Token compression', us: 'Planned', nine: '—', omni: '—', lite: '—' },
  { feature: 'Batch API', us: 'Planned', nine: '—', omni: '—', lite: '—' },
];

const ROADMAP: { quarter: string; items: string[] }[] = [
  { quarter: 'Q4 2026', items: ['Token compression', 'Batch API', 'Combo routing'] },
  { quarter: 'Q1 2027', items: ['MCP server', 'A2A'] },
  { quarter: 'Q2 2027', items: ['Media providers'] },
  { quarter: 'Q3 2027', items: ['Enterprise SSO', 'Advanced RBAC'] },
];

export function FeaturesPage() {
  return (
    <Reveal>
      <div className="stack">
        <h1>Features</h1>
        <p className="lede muted">Everything in the router, and what's coming.</p>

        <section aria-labelledby="features-grid">
          <h2 id="features-grid">What ships today</h2>
          <div className="cat-grid">
            {FEATURES.map((f) => (
              <Card key={f.title}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <h3 className="card-title">{f.title}</h3>
                  <Badge tone={STATUS_TONE[f.status]}>{f.status}</Badge>
                </div>
                <p className="card-desc">{f.desc}</p>
              </Card>
            ))}
          </div>
        </section>

        <section aria-labelledby="features-compare">
          <h2 id="features-compare">How we compare</h2>
          <div className="table-wrap">
            <table className="fr">
              <thead>
                <tr>
                  <th>Feature</th>
                  <th>fudrouter</th>
                  <th>9Router</th>
                  <th>OmniRoute</th>
                  <th>LiteLLM</th>
                </tr>
              </thead>
              <tbody>
                {COMPARISON.map((r) => (
                  <tr key={r.feature}>
                    <td>{r.feature}</td>
                    <td>{r.us}</td>
                    <td>{r.nine}</td>
                    <td>{r.omni}</td>
                    <td>{r.lite}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted text-sm">
            Cells marked — are capabilities this project has not verified against the vendor's own documentation. Only the 9Router column carries
            entries, because the migration guide in this repository documents exactly what imports from it.
          </p>
        </section>

        <section aria-labelledby="features-roadmap">
          <h2 id="features-roadmap">Roadmap</h2>
          <ol>
            {ROADMAP.map((q) => (
              <li key={q.quarter}>
                <strong>{q.quarter}:</strong> {q.items.join(', ')}
              </li>
            ))}
          </ol>
        </section>

        <section className="pricing-cta" aria-labelledby="features-cta">
          <h2 id="features-cta">Read the details</h2>
          <div className="row">
            <Link to="/docs">
              <Button>Read the docs →</Button>
            </Link>
          </div>
        </section>
      </div>
    </Reveal>
  );
}
