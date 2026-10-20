import { Link } from 'react-router-dom';
import { Card } from '../components/ui/card';

// Both documents are one file because they share the TOC shell and the
// "last updated" line, and a visitor who lands on /terms is one click from
// /privacy. The section arrays are data, not JSX, so the TOC and the body
// cannot drift: the anchors are generated from the same list the sections
// render from.

interface Section {
  id: string;
  title: string;
  body: string;
  list?: string[];
}

const TERMS: Section[] = [
  {
    id: 'definitions',
    title: 'Definitions',
    body: 'A few words this document uses in a specific sense.',
    list: [
      'Service — the FUDRouter console, the router that serves /v1, and the documentation.',
      'Account — the user record created on first sign-in, plus the workspace it provisions.',
      'Workspace — the billing and access boundary. Projects, environments and API keys live inside one.',
      'Credits — the prepaid balance metered against each request.',
      'Content — the prompts you send and the completions you receive.',
    ],
  },
  {
    id: 'account-registration-eligibility',
    title: 'Account registration & eligibility',
    body: 'You sign in with Discord; the first sign-in provisions your account, workspace, a default project and three environments. You are responsible for what happens under your account, and for keeping access to it.',
    list: [
      'You must be old enough to form a binding contract where you live.',
      'One human per account. Sharing a login is how an audit trail stops being one.',
      'You must be able to receive email at the address on the account.',
    ],
  },
  {
    id: 'acceptable-use',
    title: 'Acceptable use',
    body: 'Use the service lawfully and do not use it to attack anything. In particular:',
    list: [
      'No probing, scanning or load-testing the shared host or another workspace.',
      'No bypassing rate limits, budgets or the SSRF guard.',
      'No reselling access to the service without a written agreement.',
      'No content that is unlawful where you are or where we operate.',
    ],
  },
  {
    id: 'service-description-sla',
    title: 'Service description & SLA',
    body: 'The service is a hosted router: one OpenAI-compatible endpoint, one key, many upstream providers, with per-request metering and fallback. Availability is measured as the share of requests that receive a response rather than a transport or 5xx error, excluding scheduled maintenance announced in advance.',
    list: [
      'Paid plans: 99.9% monthly availability.',
      'Free plan: 99.5% monthly availability.',
      'A miss is credited, not paid out — see Credits & payment.',
    ],
  },
  {
    id: 'credits-payment',
    title: 'Credits & payment',
    body: 'Billing is metered per request: each call is priced from the normalized per-1M-token price of the route that served it, and the charge lands on the request\u2019s ledger row when the call ends. Money is stored in integer micro-units, so a total never passes through a floating-point number.',
    list: [
      'Credits do not expire. An unused balance is not a liability and is not forfeited.',
      'A zero balance returns HTTP 402 before the request reaches a provider. There is no overage and no negative balance.',
      'Refunds are issued when we miss the SLA above, and otherwise at our discretion.',
    ],
  },
  {
    id: 'price-changes',
    title: 'Price changes',
    body: 'Prices can change. When they do, existing balances keep their value and you get notice before the new price applies to you.',
    list: ['At least 30 days\u2019 notice by email before a price change takes effect.'],
  },
  {
    id: 'your-content',
    title: 'Your content',
    body: 'Your prompts and completions are yours. We do not train on them, and we do not record them unless content capture is explicitly enabled for your workspace. What we do keep is the request\u2019s metadata — model, provider, token counts, cost, latency, status and client IP — which is what the ledger and the usage pages are built from.',
  },
  {
    id: 'our-liability',
    title: 'Our liability',
    body: 'The service is provided as it is. To the extent liability cannot be excluded altogether, our total liability for any claim is capped at the fees you paid us in the twelve months before the claim arose. Neither of us is liable for indirect or consequential loss, including lost profit or lost data.',
  },
  {
    id: 'indemnification',
    title: 'Indemnification',
    body: 'You agree to cover claims brought against us by a third party arising from your use of the service — including the content you send through it and your breach of the acceptable-use terms above.',
  },
  {
    id: 'termination',
    title: 'Termination',
    body: 'You can stop using the service at any time, and ask us to delete your account. We can suspend or terminate an account that breaches these terms, and we will say why unless the law or a security concern says we cannot.',
    list: [
      'On termination your keys stop working immediately.',
      'Request metadata is retained for the period in the privacy policy, then deleted.',
      'An unused credit balance is refunded on request when we terminate for our own convenience, not for a breach.',
    ],
  },
  {
    id: 'data-processing',
    title: 'Data processing',
    body: 'We process account and usage data to run the service, meter requests and keep the ledger honest. The privacy policy is the detailed statement of what is collected, why, how long it is kept and who else touches it; where the two documents overlap, the privacy policy governs.',
  },
  {
    id: 'governing-law',
    title: 'Governing law',
    body: 'These terms are governed by the law of the jurisdiction stated in the signed order form, or otherwise the operator\u2019s principal place of business. The courts of that jurisdiction have exclusive jurisdiction over any dispute.',
  },
  {
    id: 'changes-to-terms',
    title: 'Changes to terms',
    body: 'These terms can change. A material change is announced by email at least 30 days before it takes effect, and the date at the top of this page moves with it. Continuing to use the service after that date means you accept the revised terms.',
  },
  {
    id: 'contact',
    title: 'Contact',
    body: 'Questions about these terms go to legal@your-domain. Security reports go to security@your-domain instead — see the security page for what to include.',
  },
];

const PRIVACY: Section[] = [
  {
    id: 'what-we-collect',
    title: 'What we collect',
    body: 'Two categories, and nothing else.',
    list: [
      'Account data — the name and email from your Discord sign-in, and the workspace, project and environment records provisioned for you.',
      'Usage data — one row per request: model, provider, token counts, cost, latency, status, and the client IP the request came from.',
    ],
  },
  {
    id: 'what-we-do-not-collect',
    title: 'What we do NOT collect',
    body: 'Prompt and response content is not recorded. The request log has columns for it, and they stay empty unless content capture is explicitly enabled for the workspace — an operator setting, off by default, and the retention job blanks anything captured once the window closes.',
  },
  {
    id: 'how-we-use-data',
    title: 'How we use data',
    body: 'To run the service and to bill it accurately.',
    list: [
      'Authenticating your requests and enforcing the limits bound to your key.',
      'Metering each request and writing the ledger row that your invoice is built from.',
      'Showing you your own usage, and diagnosing a failure you report.',
      'Aggregate, de-identified figures for capacity planning. Nothing that identifies you.',
    ],
  },
  {
    id: 'data-retention',
    title: 'Data retention',
    body: 'Three different clocks, because three different kinds of data.',
    list: [
      'Request log — 90 days by default, then deleted.',
      'Ledger — kept for as long as accounting requires, because it is the financial record.',
      'Account data — kept until you ask us to delete it.',
    ],
  },
  {
    id: 'data-sharing',
    title: 'Data sharing',
    body: 'We do not sell your data. It reaches three parties, each for one job:',
    list: [
      'AI providers — your prompt goes to the provider that serves the request. That is the service.',
      'Payment processor — to charge the card behind your credit top-ups.',
      'Hosting — the infrastructure the service runs on.',
    ],
  },
  {
    id: 'international-transfers',
    title: 'International transfers',
    body: 'The service is operated from one place and served worldwide, so your data may be processed outside your own country. Where a transfer needs a safeguard, we rely on the standard contractual clauses the receiving party has in place.',
  },
  {
    id: 'your-rights',
    title: 'Your rights',
    body: 'You can ask us to:',
    list: [
      'Access — tell you what we hold about you.',
      'Export — hand it over in a machine-readable form.',
      'Erase — delete your account data.',
      'Rectify — correct something that is wrong.',
      'Port — move it to another provider.',
    ],
  },
  {
    id: 'cookies-analytics',
    title: 'Cookies & analytics',
    body: 'A session cookie keeps you signed in, and a cookie remembers which workspace you last selected. Beyond that we collect anonymous performance figures — CLS, LCP, INP, FCP and TTFB — from a 10% sample of page loads, with no identifier attached. There is no advertising or cross-site tracking.',
  },
  {
    id: 'security-measures',
    title: 'Security measures',
    body: 'Credentials are encrypted at rest, API keys are stored as hashes, services bind to loopback, and both planes carry their own SSRF guard. The security page has the full list.',
  },
  {
    id: 'children',
    title: 'Children',
    body: 'The service is not directed at children, and we do not knowingly collect data from them. If you believe a child has an account, tell us and we will remove it.',
  },
  {
    id: 'changes',
    title: 'Changes',
    body: 'This policy can change. A material change is announced by email at least 30 days before it takes effect, and the date at the top of this page moves with it.',
  },
  {
    id: 'contact',
    title: 'Contact',
    body: 'Privacy questions and data requests go to privacy@your-domain.',
  },
];

const LAST_UPDATED = '2026-10-19';

function Toc({ sections, label }: { sections: Section[]; label: string }) {
  return (
    <nav className="doc-sidebar" aria-label={label}>
      <section>
        <h2 className="fr-label">Contents</h2>
        <ol>
          {sections.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`}>{s.title}</a>
            </li>
          ))}
        </ol>
      </section>
    </nav>
  );
}

function Doc({ sections }: { sections: Section[] }) {
  return (
    <div className="doc-prose">
      {sections.map((s, i) => (
        <section key={s.id} aria-labelledby={s.id}>
          <h2 id={s.id}>
            {i + 1}. {s.title}
          </h2>
          <p>{s.body}</p>
          {s.list ? (
            <ul>
              {s.list.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ))}
    </div>
  );
}

export function TermsPage() {
  return (
    <div className="stack">
      <div>
        <h1>Terms of Service</h1>
        <p className="lede muted">Last updated: {LAST_UPDATED}</p>
      </div>
      <div className="doc-layout">
        <Toc sections={TERMS} label="Contents" />
        <Doc sections={TERMS} />
      </div>
      <p className="muted">
        Questions? <a href="mailto:legal@your-domain">legal@your-domain</a>
      </p>
    </div>
  );
}

export function PrivacyPage() {
  return (
    <div className="stack">
      <div>
        <h1>Privacy Policy</h1>
        <p className="lede muted">Last updated: {LAST_UPDATED}</p>
      </div>
      <div className="doc-layout">
        <Toc sections={PRIVACY} label="Contents" />
        <Doc sections={PRIVACY} />
      </div>
      <Card title="Want your data?">
        <p className="card-desc">
          Email <a href="mailto:privacy@your-domain">privacy@your-domain</a> with your workspace ID. We respond within 30
          days.
        </p>
      </Card>
      <p className="muted">
        How we protect it is on the <Link to="/security">security page</Link>.
      </p>
    </div>
  );
}
