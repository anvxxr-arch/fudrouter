import { Link } from 'react-router-dom';
import { Badge, type Tone } from '../components/ui/badge';
import { Card } from '../components/ui/card';

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
    body: 'Only the SHA-256 hash of a key secret is stored; the plaintext is shown once at creation and a lost key is replaced, never recovered. A key rotates in place, and every key is scoped to the project and environment it was minted in.',
  },
  {
    title: 'Your data stays minimal',
    body: 'A request writes one ledger row — model, provider, token counts, cost, latency, status, client IP. Prompt and response bodies are not recorded unless content capture is explicitly enabled for the workspace.',
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

const COMPLIANCE: { name: string; status: string; tone: Tone; body: string }[] = [
  {
    name: 'GDPR',
    // "Ready" implied a self-serve export/erasure path. There is none: no
    // account-deletion, data-export or danger-zone route exists in
    // pages.mjs or anywhere in the tree — a human does it after an email.
    status: 'On request',
    tone: 'info',
    body: 'Access, export and erasure requests are handled manually by the operator on request — email privacy@your-domain with your workspace ID. There is no self-serve export tool yet.',
  },
  {
    name: 'SOC 2 Type II',
    status: 'In progress',
    tone: 'warn',
    body: 'The controls are being documented and evidenced. We are not certified, and this page will not claim otherwise until an auditor says so.',
  },
  {
    name: 'Penetration test',
    status: 'Not yet scheduled',
    tone: 'default',
    body: 'No external test has been commissioned yet. When one is booked the date goes here, not before.',
  },
];

const DISCLOSURE_SCOPE = [
  'In scope: the console, the router and the public API.',
  'Out of scope: the upstream providers\u2019 own infrastructure, and anything needing physical access to the host.',
  'We acknowledge a report within 2 business days.',
  'We aim to ship a fix or a mitigation within 30 days of acknowledgement.',
  'Please do not test against another workspace\u2019s data, and do not run automated scans against the shared host.',
];

export function SecurityPage() {
  return (
    <div className="stack">
      <section aria-labelledby="security-hero">
        <h1 id="security-hero">Security you can hand to your CISO</h1>
        <p className="lede">
          FUDRouter is a hosted AI router: one API key, many upstream providers, metered per request. This page is the short
          version of how it is deployed and what it does with your data — the long version, with the code paths named, is in
          the security documentation.
        </p>
        <p>
          <Link to="/docs/security">Read the security documentation</Link>
        </p>
      </section>

      <section aria-labelledby="security-trust">
        <h2 id="security-trust">At a glance</h2>
        <div className="row flex-wrap">
          {TRUST.map((t) => (
            <Badge key={t}>{t}</Badge>
          ))}
        </div>
      </section>

      <section aria-labelledby="security-pillars">
        <h2 id="security-pillars">What that means for you</h2>
        <div className="cat-grid">
          {PILLARS.map((p) => (
            <Card key={p.title} title={p.title} desc={p.body} />
          ))}
        </div>
      </section>

      <section aria-labelledby="security-infra">
        <h2 id="security-infra">Infrastructure</h2>
        <div className="table-wrap">
          <table className="fr">
            <thead>
              <tr>
                <th>Layer</th>
                <th>Measure</th>
              </tr>
            </thead>
            <tbody>
              {LAYERS.map(([layer, measure]) => (
                <tr key={layer}>
                  <td>{layer}</td>
                  <td>{measure}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="security-compliance">
        <h2 id="security-compliance">Compliance status</h2>
        <div className="cat-grid">
          {COMPLIANCE.map((c) => (
            <Card key={c.name} title={c.name}>
              <p className="row">
                <Badge tone={c.tone}>{c.status}</Badge>
              </p>
              <p className="card-desc">{c.body}</p>
            </Card>
          ))}
        </div>
      </section>

      <section aria-labelledby="security-disclosure">
        <h2 id="security-disclosure">Reporting a vulnerability</h2>
        {/* .doc-prose is the repo's existing prose class (Docs.css) and the only
            one that restores list markers the base reset strips. */}
        <div className="doc-prose">
          <p>
            Email <code>security@your-domain</code> with a description of the issue and how to reproduce it. We would rather
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
