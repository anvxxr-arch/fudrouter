import { Link } from 'react-router-dom';
import { Reveal } from '../components/Reveal';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table';

type FeatureStatus = 'GA' | 'Beta';

// Badge variant per status: GA is the shipped default (ok), Beta is a warning
// to a buyer. One map so a status rename cannot leave a card with the wrong
// color.
const STATUS_VARIANT: Record<FeatureStatus, 'ok' | 'warn'> = { GA: 'ok', Beta: 'warn' };

interface Feature {
  title: string;
  desc: string;
  status: FeatureStatus;
}

// Every claim here is backed by the repo: fallback/health in
// backend/go/internal/routing, micro-unit billing in the credit_ledger path,
// the platform → account → api_key limit chain in EffectiveLimits, budget gate
// returning 402 INSUFFICIENT_CREDITS, audit_log via writeAudit, alias rewrite
// in ResolveModel. The Planned rows are the roadmap, not shipped features —
// they are labeled so the grid cannot oversell.
const FEATURES: Feature[] = [
  {
    title: 'Automatic fallback',
    desc: 'When a provider fails, the request walks the candidate list and retries the next provider without client involvement.',
    status: 'GA',
  },
  {
    title: 'Credit billing',
    desc: 'Integer micro-units end to end — no floating point in the ledger. One credit_ledger row per request with an idempotency key.',
    status: 'GA',
  },
  {
    title: 'Per-account limits',
    desc: 'Account and key scopes; a limit resolves as the MIN across platform, account and key.',
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
  { feature: 'Per-account isolation (account → api_key)', us: '✓', nine: '—', omni: '—', lite: '—' },
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
      <div className="grid gap-6">
        <h1>Features</h1>
        <p className="measure text-lg text-muted-foreground">Everything in the router, and what's coming.</p>

        <section className="grid gap-2" aria-labelledby="features-grid">
          <h2 id="features-grid">What ships today</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <Card key={f.title}>
                <CardHeader>
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle>{f.title}</CardTitle>
                    <Badge variant={STATUS_VARIANT[f.status]}>{f.status}</Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <CardDescription>{f.desc}</CardDescription>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        <section className="grid gap-2" aria-labelledby="features-compare">
          <h2 id="features-compare">How we compare</h2>
          <Table>
            <TableHeader>
              <TableRow className="border-b border-border">
                <TableHead>Feature</TableHead>
                <TableHead>fudrouter</TableHead>
                <TableHead>9Router</TableHead>
                <TableHead>OmniRoute</TableHead>
                <TableHead>LiteLLM</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {COMPARISON.map((r) => (
                <TableRow key={r.feature}>
                  <TableCell className="whitespace-normal">{r.feature}</TableCell>
                  <TableCell>{r.us}</TableCell>
                  <TableCell>{r.nine}</TableCell>
                  <TableCell>{r.omni}</TableCell>
                  <TableCell>{r.lite}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="measure text-sm text-muted-foreground">
            Cells marked — are capabilities this project has not verified against the vendor's own documentation. Only the 9Router column carries
            entries, because the migration guide in this repository documents exactly what imports from it.
          </p>
        </section>

        <section className="grid gap-2" aria-labelledby="features-roadmap">
          <h2 id="features-roadmap">Roadmap</h2>
          <ol className="m-0 grid gap-2 p-0">
            {ROADMAP.map((q) => (
              <li key={q.quarter} className="text-muted-foreground">
                <strong className="text-foreground">{q.quarter}:</strong> {q.items.join(', ')}
              </li>
            ))}
          </ol>
        </section>

        <section className="border-t border-border pt-6" aria-labelledby="features-cta">
          <h2 id="features-cta">Read the details</h2>
          <div className="flex flex-wrap items-center gap-3">
            <Link to="/docs">
              <Button>Read the docs</Button>
            </Link>
          </div>
        </section>
      </div>
    </Reveal>
  );
}
