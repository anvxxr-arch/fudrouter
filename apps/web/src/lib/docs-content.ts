/**
 * The docs tree content (PRD §131–133) — one typed module, one page per topic.
 *
 * Markdown is the `lib/markdown.ts` subset (## / ### headings, - lists, inline
 * `code`, **bold**, `[text](href)` http(s)/root-relative links, fenced code).
 * Everything is authored here as data so the `/docs/[...slug]` route is markup
 * and lookup, never content-in-a-template. Content rules from the guides
 * apply here too: say only what the code does, no invented limits or SLAs.
 *
 * URL shape: /docs/<category-slug>/<page-slug> (the [...slug] rest param
 * receives "category-slug/page-slug"). /docs (empty slug) is the index.
 */
export interface DocPage {
	/** Page slug within its category — the last URL segment. */
	slug: string;
	title: string;
	markdown: string;
}
export interface DocCategory {
	slug: string;
	title: string;
	pages: DocPage[];
}
/** One page flattened for lookup and prev/next — `path` is the rest param. */
export interface DocEntry {
	path: string;
	categoryTitle: string;
	slug: string;
	title: string;
	markdown: string;
}

const QUICKSTART = `Five steps from nothing to a request that shows up in your logs. Each step
links to the dashboard page that performs it.

## 1. Create an account

Open [/signup](/signup) and create an account, or sign in with Discord from
[/login](/login). A signup provisions your workspace, a default project and
three environments (Development, Staging, Production) — nothing to set up
before step 2.

## 2. Create a project

Projects hold the environments, keys and logs for one application. Create one
at [/dashboard/projects/new](/dashboard/projects/new) and name it after what
the keys will serve. Every project starts with the three default environments.

## 3. Generate an API key

Inside the project, open **API Keys** and generate a key for the environment
you want to call from. Keys are shown exactly once and look like
\`sk-ar-<prefix>_<secret>\` — only \`sha256(secret)\` is stored, so copy it into
your secret manager before leaving the page.

## 4. First request

Send a chat completion to \`POST /v1/chat/completions\` with the \`sk-ar-\` key as
the bearer token. Any OpenAI-compatible client works; plain \`curl\` is enough
to verify the wiring:

\`\`\`text
curl https://ai.karepmuwes.my.id/v1/chat/completions \\
  -H "Authorization: Bearer sk-ar-YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "grok-4.6", "messages": [{"role": "user", "content": "hello"}]}'
\`\`\`

The response body is the chat-completion shape your SDK expects, including a
\`usage\` block. Model slugs are listed on [/models](/models).

Rather than writing the wiring by hand, [/dashboard/connect](/dashboard/connect)
generates the config for a coding agent or editor — base URL, key and model
already filled in.

## 5. View request logs

Every call writes one ledger row. Open
[/dashboard/usage](/dashboard/usage) to see it: model, provider, tokens, cost,
latency and an error code when the call failed. If step 4 returned a body,
the row is already there.`;

const API_AUTHENTICATION = `Every API call authenticates with one header: the \`sk-ar-\` key from your
dashboard, sent as a bearer token.

\`\`\`text
Authorization: Bearer sk-ar-YOUR_KEY
\`\`\`

A missing, malformed or revoked key gets \`401\` with an
\`AUTHENTICATION_ERROR\`. Keys are stored hash-only (\`sha256(secret)\`), so a
secret cannot be recovered — generate a new key instead.

A key is bound to a workspace and can be scoped to a project and environment.
That scope decides which models and routing policy apply, and where the
request lands in your logs.`;

const API_MODELS = `\`GET /v1/models\` is served natively by the router: it lists the models your
key can actually reach, in the OpenAI list shape (\`object: "list"\` with
\`data\` entries carrying \`id\` and \`object: "model"\`).

\`\`\`text
curl https://ai.karepmuwes.my.id/v1/models \\
  -H "Authorization: Bearer sk-ar-YOUR_KEY"
\`\`\`

Only published, reachable models appear — the same gate the request path
applies. The public catalog at [/models](/models) is the browsable version of
the same data, and [/models/compare](/models/compare) compares models side by
side.

The \`id\` is the canonical model slug: use it as \`model\` in chat completions.
See [Model identifiers](/docs/models/identifiers).`;

const API_CHAT = `\`POST /v1/chat/completions\` is served natively: the router authenticates,
applies the bound routing policy, picks a provider, meters tokens and writes
the ledger row before returning. The wire format is the OpenAI chat
completions shape.

Request body (the fields the playground sends; unknown fields pass through to
the provider):

- \`model\` — required. Canonical slug, model alias, or \`fudrouter/*\` virtual.
- \`messages\` — required. \`[{ "role": "user", "content": "…" }]\`. A system
  prompt is just a message with \`role: "system"\`.
- \`stream\` — \`true\` for SSE. See [Streaming](/docs/api/streaming).
- \`temperature\` — 0 to 2, provider permitting.
- \`max_tokens\` — positive integer cap on the completion.

\`\`\`text
curl https://ai.karepmuwes.my.id/v1/chat/completions \\
  -H "Authorization: Bearer sk-ar-YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "grok-4.6", "messages": [{"role": "user", "content": "hello"}]}'
\`\`\`

A successful response is a chat completion: \`choices[].message.content\` for
the text and a \`usage\` block (\`prompt_tokens\`, \`completion_tokens\`,
\`total_tokens\`). Failures return the error shape from
[Errors](/docs/api/errors).`;

const API_RESPONSES = `\`POST /v1/responses\` is forwarded pass-through: the router authenticates,
meters and logs the call, then forwards the request body to the selected
provider unchanged and returns its response.

The forwarding is conditional on the body carrying a \`model\` field — that is
what routing keys off. Without it the request is rejected as an
\`INVALID_REQUEST\`.

This path is forwarded, not reimplemented: request and response shapes are
whatever the upstream accepts and returns. Chat completions is the native
path if you need guarantees about behavior.`;

const API_EMBEDDINGS = `\`POST /v1/embeddings\` is forwarded pass-through: the router authenticates,
meters and logs the call, then forwards the request body to the selected
provider unchanged and returns its embedding response.

The forwarding is conditional on the body carrying a \`model\` field — that is
what routing keys off. Without it the request is rejected as an
\`INVALID_REQUEST\`.

This path is forwarded, not reimplemented: the request and response shapes
are whatever the upstream accepts and returns.`;

const API_ERRORS = `Failures return a 4xx or 5xx status with one JSON body:

\`\`\`json
{"error": {"message": "what went wrong"}}
\`\`\`

\`error.message\` is a human-readable sentence. The machine-readable code is
the platform error taxonomy:

- \`AUTHENTICATION_ERROR\` — missing, malformed or revoked key (\`401\`)
- \`AUTHORIZATION_ERROR\` — the key may not do this (\`403\`)
- \`RATE_LIMITED\` — a key limit was hit (\`429\`)
- \`INSUFFICIENT_CREDITS\` — the billing account cannot cover the call (\`402\`)
- \`INVALID_REQUEST\` — malformed body or missing \`model\` (\`400\`)
- \`MODEL_NOT_FOUND\` — the slug or alias serves nothing (\`404\`)
- \`CONTEXT_TOO_LONG\` — input exceeds the model's context (\`413\`)
- \`UNSUPPORTED_PARAMETER\` — a parameter the route cannot honor
- \`CONTENT_REJECTED\` — the provider refused the content
- \`PROVIDER_TIMEOUT\` — the attempt hit its deadline (\`504\`)
- \`PROVIDER_UNAVAILABLE\` / \`CIRCUIT_OPEN\` — no usable route right now
- \`UPSTREAM_ERROR\` — the provider failed (\`5xx\`)
- \`INTERNAL_ERROR\` — anything on this side of the wire (\`500\`)

\`4xx\` statuses mean the request must change before retrying; \`5xx\` statuses
are retryable. The dashboard playground and the request logs show the same
codes — the request id in the
[x-fudrouter-request-id](/docs/api/headers) header ties them together.`;

const API_RATE_LIMITS = `Limits are configured per key and environment — there are no global numbers
to code against. Each API key carries its own limits (requests per minute,
tokens per minute and spend), and the bound policy decides what applies to a
given call.

When a call exceeds a configured limit the router answers \`429\` with a
\`RATE_LIMITED\` error and does not forward the request. Limits that must not
move: none are published here on purpose — check the key's configuration in
the dashboard for the values that apply to your traffic.`;

const API_HEADERS = `## Request

One header authenticates a call:

\`\`\`text
Authorization: Bearer sk-ar-YOUR_KEY
\`\`\`

Optional per-request headers are documented on their endpoints (for example
the routing strategy override the playground uses).

## Response

Every response — success or failure — carries the \`x-fudrouter-\` headers:

- \`x-fudrouter-request-id\` — the ledger id for this call. Quote it in
  support requests; it is the join key across logs, usage and billing.
- \`x-fudrouter-model\` — the model that actually served the request.
- \`x-fudrouter-provider\` — the provider that served it.
- \`x-fudrouter-latency\` — total router-side latency in milliseconds.

When a call fails over, these name the route that answered (or the last one
tried), and the request log records every attempt.`;

const API_STREAMING = `Set \`"stream": true\` on \`POST /v1/chat/completions\` and the response is
Server-Sent Events (\`text/event-stream\`): one \`data:\` frame per chunk in the
OpenAI chunk shape, terminated by a \`data: [DONE]\` line.

The final chunk carries the \`usage\` object (\`prompt_tokens\`,
\`completion_tokens\`, \`total_tokens\`) — the router asks the provider for usage
on streaming calls, so a stream is metered exactly like a buffered one.

\`\`\`text
data: {"id":"…","choices":[{"delta":{"content":"Hello"}}]}

data: {"id":"…","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":34,"total_tokens":46}}

data: [DONE]
\`\`\`

If the upstream fails mid-stream the SSE just ends early; the request log
still records the attempt and its error. Time to first token is recorded per
request as TTFT and shown in the logs.`;

const MODELS_MODELS = `A model in this platform is one upstream model served through one provider,
published under a canonical slug. The router refuses to serve a slug that is
not published and reachable — so the catalog and the request path always
agree.

Browse what is live at [/models](/models) and compare models side by side at
[/models/compare](/models/compare). The provider network behind them is on
[/providers](/providers).

Prices are normalized to micro-units per 1M tokens so routes can be compared
(and billed) without floating-point money.`;

const MODELS_IDENTIFIERS = `A request names its model with a \`model\` field. Three kinds of identifier
work:

- **Canonical slug** — the stable id from the catalog (\`grok-4.6\`). Use this
  in code you control end to end.
- **Model alias** — a name your workspace defines (for example
  \`production-chat\`) that points at a target list. The alias is what your
  application sends, so targets can change without a redeploy.
- **Virtual form** — \`fudrouter/*\` names, resolved by the routing policy.

Whatever identifier you send, the response and the request log tell you what
actually ran: \`x-fudrouter-model\` on the response and the request log's model
fields record the resolved slug, not the alias you asked for.

To generate a ready-to-paste config for your tool using any of these
identifiers, open [/dashboard/connect](/dashboard/connect).`;

const ROUTING_ROUTING = `Routing picks one route per request. The candidates are the reachable
connections serving the requested model; each is scored on price, latency,
reliability and capacity under the policy bound to the key.

The strategy decides how the winner is chosen: balanced (a blended score),
lowest cost, lowest latency, highest reliability, provider priority,
weighted, round robin or random. A key's bound policy sets the default; a
caller can override the strategy per request without loosening the policy's
attempt caps, timeouts or constraints.

The winning route is never hidden: the provider and model come back on the
response headers ([Headers](/docs/api/headers)) and every attempt is in the
request log. See [Fallback](/docs/routing/fallback) for what happens when the
winner fails.`;

const ROUTING_FALLBACK = `When an attempt fails in a retryable way, the router tries the next candidate
route instead of failing your call. Retryable failures are rate limits,
timeouts, provider unavailability, open circuits, provider-side 5xx errors
and transport errors.

Not retryable — the call fails immediately: invalid requests, unsupported
parameters, context-too-long, unknown models, authorization failures and
content rejections. Retrying those cannot succeed and would only burn
attempts.

Each request has an overall deadline: the router never starts an attempt
that cannot finish inside it. Attempts, the fallback flag and the failing
error are all recorded on the request log, so "this call cost two attempts"
is readable per request in [Usage](/docs/usage/usage).`;

const PROJECTS_PROJECTS = `The hierarchy is workspace → project → environment → API key.

- **Workspace** — the billing and team boundary. Members, roles and the
  billing account live here.
- **Project** — one application. Its keys, aliases, routing policy and logs
  hang off it.
- **Environment** — Development, Staging and Production are created with each
  project. Keys and limits are per environment, so a staging key cannot spend
  production money.
- **API key** — scoped to the project and environment it was made in. See
  [API Keys](/docs/api-keys/api-keys).

Create projects at [/dashboard/projects/new](/dashboard/projects/new); usage
and request logs break down by project and environment.`;

const APIKEYS_KEYS = `An API key is the \`sk-ar-<prefix>_<secret>\` string your client sends as a
bearer token. The plaintext is shown once at creation; only
\`sha256(secret)\` is stored, so a lost key is replaced, never recovered.

A key belongs to one user and is scoped to a workspace, and optionally to a
project and environment. Its scope and bound policy decide which models it
can reach, its rate and spend limits, and where its requests log.

Keys are managed at [/dashboard/keys](/dashboard/keys) or inside a project.
Rotate or revoke from the same pages — revocation takes effect immediately
for new requests. The playground runs in a key's context without ever knowing
its secret: it mints a short-lived run key scoped exactly like the original
and reclaims it when the run ends.`;

const USAGE_USAGE = `Every API call writes exactly one ledger row when it finishes: request id,
model, provider, tokens in and out, cost, latency, TTFT, attempts and an
error code when it failed. The ledger is append-only — it is the financial
and usage record.

Your view of it is [/dashboard/usage](/dashboard/usage): the request list
plus per-model and per-project totals. Cost is computed per request from the
normalized price of the route that served it, in integer micro-units — the
same number that appears in billing.

The request id (\`x-fudrouter-request-id\`) joins the ledger to the response
you received; when something looks wrong, that id is the one thing support
needs.`;

const OBSERVABILITY_OBSERVABILITY = `Observability is the request log, and it is deliberately one place. No
sampling, no separate tracing store: if a call happened, a row exists.

Per request: what was asked (model, key, project, environment), what ran
(resolved model, provider, connection, attempts, fallback), what it cost
(tokens, cost), how it went (status, error code, latency, TTFT) and when
(start, end). The playground's metrics panel reads the same rows as your
logs — there is no second source of truth.

Cross-surface, one id ties it together:
[\`x-fudrouter-request-id\`](/docs/api/headers) on the response is the ledger
row's id.`;

const BILLING_BILLING = `Billing is metered per request. Each call is priced from the normalized
per-1M-token price of the route that served it — input and output tokens are
billed separately — and the cost lands on the request's ledger row the moment
the call ends.

Money is stored and added in integer micro-units (1e-6 of the currency);
prices and totals never pass through a floating-point number. The per-request
cost is what rolls up in [Usage](/docs/usage/usage) and what the billing
account is charged against.

Invoices, credits, transactions and payment methods live at
[/dashboard/billing](/dashboard/billing). Per-model prices are on
[/pricing](/pricing).`;

const SDKS_SDKS = `There is no proprietary SDK to install. Every OpenAI-compatible client works
against this platform with two settings: the base URL and your \`sk-ar-\` key.

\`\`\`text
base URL: https://ai.karepmuwes.my.id/v1
api key:  sk-ar-YOUR_KEY
\`\`\`

The OpenAI official SDKs (Python, Node.js, Go, .NET) and community clients
that speak the chat completions wire format all qualify. Point one at the
base URL above, use a canonical slug from [/models](/models) as the model,
and calls route, meter and log exactly like any other request.

What is native versus forwarded is listed in
[Compatibility](/docs/compatibility/openai-compatibility).`;

const COMPATIBILITY_COMPAT = `The wire format is OpenAI-compatible at the \`/v1\` base URL
(\`https://ai.karepmuwes.my.id/v1\`): an OpenAI SDK sends chat completions and
lists models without code changes beyond the base URL and key.

- **Native** — \`POST /v1/chat/completions\` and \`GET /v1/models\` are
  implemented by the router itself: routing, metering, streaming and errors
  are platform behavior.
- **Forwarded pass-through** — \`POST /v1/responses\` and
  \`POST /v1/embeddings\` are authenticated, metered and logged here, then
  forwarded to the provider unchanged (conditional on the body carrying
  \`model\`). Their behavior is the upstream's behavior.

Streaming is OpenAI-style SSE ([Streaming](/docs/api/streaming)) and usage is
reported in the same \`usage\` block shape. Anything not listed here is
untested — ask before relying on it.`;

const REFERENCE_REFERENCE = `The short answers, in one place.

## Endpoints

- \`POST /v1/chat/completions\` — native. [Chat Completions](/docs/api/chat-completions)
- \`GET /v1/models\` — native. [Models](/docs/api/models)
- \`POST /v1/responses\` — forwarded pass-through. [Responses](/docs/api/responses)
- \`POST /v1/embeddings\` — forwarded pass-through. [Embeddings](/docs/api/embeddings)
- \`GET /health\` — unauthenticated liveness probe (pings the database; \`503\`
  when it is unreachable). Used by the [status page](/status).

## Conventions

- Authentication: \`Authorization: Bearer sk-ar-…\` —
  [Authentication](/docs/api/authentication)
- Errors: \`{"error": {"message": "…"}}\` plus the taxonomy code —
  [Errors](/docs/api/errors)
- Response headers: \`x-fudrouter-request-id\` / \`-model\` / \`-provider\` /
  \`-latency\` — [Headers](/docs/api/headers)
- Prices: integer micro-units per 1M tokens, input and output separate —
  [Pricing](/pricing)
- Ids: prefixed (\`req_\`, \`mdl_\`, \`prv_\`, \`sk-ar-\`) and unique across the
  platform.`;

/** The docs tree, in the order the sidebar and index render it. */
export const DOC_CATEGORIES: DocCategory[] = [
	{
		slug: 'getting-started',
		title: 'Getting Started',
		pages: [{ slug: 'quickstart', title: 'Quickstart', markdown: QUICKSTART }]
	},
	{
		slug: 'api',
		title: 'API',
		pages: [
			{ slug: 'authentication', title: 'Authentication', markdown: API_AUTHENTICATION },
			{ slug: 'models', title: 'Models', markdown: API_MODELS },
			{ slug: 'chat-completions', title: 'Chat Completions', markdown: API_CHAT },
			{ slug: 'responses', title: 'Responses', markdown: API_RESPONSES },
			{ slug: 'embeddings', title: 'Embeddings', markdown: API_EMBEDDINGS },
			{ slug: 'errors', title: 'Errors', markdown: API_ERRORS },
			{ slug: 'rate-limits', title: 'Rate Limits', markdown: API_RATE_LIMITS },
			{ slug: 'headers', title: 'Headers', markdown: API_HEADERS },
			{ slug: 'streaming', title: 'Streaming', markdown: API_STREAMING }
		]
	},
	{
		slug: 'models',
		title: 'Models',
		pages: [
			{ slug: 'models', title: 'The model catalog', markdown: MODELS_MODELS },
			{ slug: 'identifiers', title: 'Model identifiers', markdown: MODELS_IDENTIFIERS }
		]
	},
	{
		slug: 'routing',
		title: 'Routing',
		pages: [
			{ slug: 'routing', title: 'How routing works', markdown: ROUTING_ROUTING },
			{ slug: 'fallback', title: 'Fallback and retries', markdown: ROUTING_FALLBACK }
		]
	},
	{
		slug: 'projects',
		title: 'Projects',
		pages: [{ slug: 'projects', title: 'Projects and environments', markdown: PROJECTS_PROJECTS }]
	},
	{
		slug: 'api-keys',
		title: 'API Keys',
		pages: [{ slug: 'api-keys', title: 'API keys', markdown: APIKEYS_KEYS }]
	},
	{
		slug: 'usage',
		title: 'Usage',
		pages: [{ slug: 'usage', title: 'Usage and request logs', markdown: USAGE_USAGE }]
	},
	{
		slug: 'observability',
		title: 'Observability',
		pages: [
			{ slug: 'observability', title: 'What gets recorded', markdown: OBSERVABILITY_OBSERVABILITY }
		]
	},
	{
		slug: 'billing',
		title: 'Billing',
		pages: [{ slug: 'billing', title: 'Metering and billing', markdown: BILLING_BILLING }]
	},
	{
		slug: 'sdks',
		title: 'SDKs',
		pages: [{ slug: 'sdks', title: 'Using an SDK', markdown: SDKS_SDKS }]
	},
	{
		slug: 'compatibility',
		title: 'Compatibility',
		pages: [
			{
				slug: 'openai-compatibility',
				title: 'OpenAI compatibility',
				markdown: COMPATIBILITY_COMPAT
			}
		]
	},
	{
		slug: 'reference',
		title: 'Reference',
		pages: [{ slug: 'reference', title: 'Quick reference', markdown: REFERENCE_REFERENCE }]
	}
];

/** Every page flattened in reading order — prev/next and the index read this. */
export const DOC_FLAT: DocEntry[] = DOC_CATEGORIES.flatMap((category) =>
	category.pages.map((page) => ({
		path: `${category.slug}/${page.slug}`,
		categoryTitle: category.title,
		slug: page.slug,
		title: page.title,
		markdown: page.markdown
	}))
);

/** Lookup by rest param ("category-slug/page-slug"). Case- and slash-sensitive by design. */
export const DOC_BY_PATH: Record<string, DocEntry> = Object.fromEntries(
	DOC_FLAT.map((entry) => [entry.path, entry])
);
