import { Link } from 'react-router-dom';
import { Badge } from '../components/ui/badge';
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

// Six claims, each one a mechanism the deployment actually carries rather than
// an adjective. The compliance cards below are the only place a status is
// stated instead of a mechanism, and they say "in progress" / "not yet
// scheduled" / "on request" on purpose: a badge claiming a certification we
// do not hold is the single line on this page a CISO checks first.
const TRUST = [
  'Loopback-only services',
  'Encrypted credentials',
  'Hash-only API keys',
  // "Immutable" would promise a constraint the schema does not carry:
  // audit_log has no trigger, no RLS policy and no revoked UPDATE/DELETE
  // grant — 0006_platform_schema.sql:672 states the append-only guarantee
  // lives in application code. The chip claims only what the writers do.
  'Append-only audit log',
  'SSRF guard on both planes',
  // The Cloudflare tunnel's ingress rule for this app was removed
  // (docs/decommission-log.md), so the tunnel cannot be claimed as the way
  // in. Caddy is the documented TLS terminator and the only ingress hop
  // (ecosystem.config.cjs), asserted against the live Caddyfile by
  // ops/verify/caddy-forwarded-ip.sh.
  'HTTPS via reverse proxy',
];

const PILLARS = [
  {
    title: 'Your keys stay yours',
    body: 'Only the SHA-256 hash of a key secret is stored; the plaintext is shown once at creation and a lost key is replaced, never recovered. A key rotates in place, and every key is scoped to the account that minted it.',
  },
  {
    title: 'Your data stays minimal',
    body: 'A request writes one ledger row — model, provider, token counts, cost, latency, status, client IP. Prompt and response bodies are not recorded unless content capture is explicitly enabled for the account.',
  },
  {
    title: 'Your blast radius stays small',
    body: 'The console and the router are separate processes with separate deployments. The router re-authenticates every key, re-resolves its limits and re-guards every upstream dial on its own, so a compromised console cannot mint traffic the router accepts.',
  },
];

const LAYERS: [string, string][] = [
  // The Cloudflare tunnel's ingress rule for this app was removed
  // (docs/decommission-log.md); Caddy is the documented TLS terminator and
  // the only ingress hop (ecosystem.config.cjs), asserted against the live
  // Caddyfile by ops/verify/caddy-forwarded-ip.sh.
  ['Ingress', 'Caddy reverse proxy, automatic HTTPS'],
  ['Services', 'loopback 127.0.0.1'],
  ['Database', 'Postgres with a dedicated app role'],
  ['Cache', 'Valkey protected-mode + requirepass'],
  // fail2ban and unattended-upgrades appear nowhere in the repo — no config,
  // no unit, no doc — so the row was dropped rather than restated as
  // something equally unverifiable.
  ['Reverse proxy', 'Caddy with automatic HTTPS'],
];

const COMPLIANCE: { name: string; status: string; variant: 'ok' | 'warn' | 'default' | 'info'; body: string }[] = [
  {
    name: 'GDPR',
    // "Ready" implied a self-serve export/erasure path. There is none: no
    // account-deletion, data-export or danger-zone route exists in
    // pages.mjs or anywhere in the tree — a human does it after an email.
    status: 'On request',
    variant: 'info',
    body: 'Access, export and erasure requests are handled manually by the operator on request — email privacy@fudrouter.my.id with your account email. There is no self-serve export tool yet.',
  },
  {
    name: 'SOC 2 Type II',
    status: 'In progress',
    variant: 'warn',
    body: 'The controls are being documented and evidenced. We are not certified, and this page will not claim otherwise until an auditor says so.',
  },
  {
    name: 'Penetration test',
    status: 'Not yet scheduled',
    variant: 'default',
    body: 'No external test has been commissioned yet. When one is booked the date goes here, not before.',
  },
];

const DISCLOSURE_SCOPE = [
  'In scope: the console, the router and the public API.',
  'Out of scope: the upstream providers\u2019 own infrastructure, and anything needing physical access to the host.',
  'We acknowledge a report within 2 business days.',
  'We aim to ship a fix or a mitigation within 30 days of acknowledgement.',
  'Please do not test against another customer\u2019s data, and do not run automated scans against the shared host.',
];

// Restores list markers and prose spacing for the native <ul> below — the base
// reset strips markers, and a scoped sheet is the one way to reach them.
const PROSE_STYLES = `
.security-prose { display: grid; gap: 1rem; max-width: 34rem; align-content: start; }
.security-prose > * { min-width: 0; }
.security-prose p { margin: 0; color: #e2e8f0; }
.security-prose ul { margin: 0; padding-left: 1.5rem; list-style: disc; color: #cbd5e1; }
.security-prose li + li { margin-top: 0.25rem; }
.security-prose li::marker { color: #64748b; }
.security-prose code { font-family: var(--font-mono); font-size: 0.85em; color: #e2e8f0; }
`;

export function SecurityPage() {
  return (
    <div className="grid gap-6">
      <style dangerouslySetInnerHTML={{ __html: PROSE_STYLES }} />
      <section className="grid gap-2" aria-labelledby="security-hero">
        <h1 id="security-hero">Security you can hand to your CISO</h1>
        <p className="measure text-lg text-muted-foreground">
          FUDRouter is a hosted AI router: one API key, many upstream providers, metered per request. This page is the short
          version of how it is deployed and what it does with your data — the long version, with the code paths named, is in
          the security documentation.
        </p>
        <p>
          <Link className="link" to="/docs/security">Read the security documentation</Link>
        </p>
      </section>

      <section className="grid gap-2" aria-labelledby="security-trust">
        <h2 id="security-trust">At a glance</h2>
        <div className="flex flex-wrap items-center gap-2">
          {TRUST.map((t) => (
            <Badge key={t} variant="outline">{t}</Badge>
          ))}
        </div>
      </section>

      <section className="grid gap-2" aria-labelledby="security-pillars">
        <h2 id="security-pillars">What that means for you</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {PILLARS.map((p) => (
            <Card key={p.title}>
              <CardHeader>
                <CardTitle>{p.title}</CardTitle>
              </CardHeader>
              <CardContent>
                <CardDescription>{p.body}</CardDescription>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section className="grid gap-2" aria-labelledby="security-infra">
        <h2 id="security-infra">Infrastructure</h2>
        <Table>
          <TableHeader>
            <TableRow className="border-b border-border">
              <TableHead>Layer</TableHead>
              <TableHead>Measure</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {LAYERS.map(([layer, measure]) => (
              <TableRow key={layer}>
                <TableCell>{layer}</TableCell>
                <TableCell className="text-muted-foreground">{measure}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>

      <section className="grid gap-2" aria-labelledby="security-compliance">
        <h2 id="security-compliance">Compliance status</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {COMPLIANCE.map((c) => (
            <Card key={c.name}>
              <CardHeader>
                <CardTitle>{c.name}</CardTitle>
                <CardDescription>
                  <Badge variant={c.variant}>{c.status}</Badge>
                </CardDescription>
              </CardHeader>
              <CardContent>
                <CardDescription>{c.body}</CardDescription>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section className="grid gap-2" aria-labelledby="security-disclosure">
        <h2 id="security-disclosure">Reporting a vulnerability</h2>
        <div className="security-prose">
          <p>
            Email <code>security@fudrouter.my.id</code> with a description of the issue and how to reproduce it. We would rather
            hear about something small than read about it later.
          </p>
          <ul>
            {DISCLOSURE_SCOPE.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}
