/**
 * Admin guides — explanatory copy for the staff console surface.
 *
 * Pages render these through `<Guide>`, they do not embed a private essay.
 * Adding a page is a new entry here plus one tag at the call site.
 *
 * Rules for an entry:
 * - Say only what the code actually does. No invented limits, credits, or SLAs.
 * - A fact's term is a label; its detail is a value. Do not shout the value.
 * - Keep it short enough that an operation page still leads with its form.
 *
 * Split out of the single 754-line `guides.ts` by audience so each file can be
 * read and edited on its own; `$lib/guides` composes the three back into one map.
 */
import type { Guide } from '$lib/guides-types';

export const ADMIN_GUIDES = {
	admin: {
		audience: 'admin',
		sections: [
			{
				title: 'How to read the overview',
				lede: 'Deployment-wide. A member dashboard is the same shape scoped to one account.',
				facts: [
					{
						term: 'Providers / models',
						detail: 'Rows in the catalog, not "healthy right now". Reachability is Connections.'
					},
					{ term: 'Active keys', detail: 'Unrevoked keys across every user.' },
					{
						term: 'Users',
						detail: 'Accounts, including banned ones. The Users page splits status.'
					},
					{
						term: 'Tokens / cost',
						detail: 'Sum of the request log. Cost is micro-units shown as USD.'
					},
					{
						term: 'Top consumers',
						detail:
							'Sorted by cost, not by request count. A cheap high-volume key will not lead this table.'
					},
					{ term: 'Recent', detail: 'Newest calls across users. The filterable log is Requests.' }
				]
			}
		]
	},
	'admin-providers': {
		audience: 'admin',
		sections: [
			{
				title: 'What a provider row means',
				lede: 'Credentials are encrypted on write and never selected back into this page.',
				facts: [
					{
						term: 'active',
						detail: 'Eligible for routing, together with an active model on that provider.'
					},
					{
						term: 'dev',
						detail:
							'Hidden from the data plane unless ROUTER_ALLOW_DEV_PROVIDERS is set. Use this for a non-commercial upstream.'
					},
					{
						term: 'disabled',
						detail:
							'Not selected. The row stays so you can turn it back on without re-entering the secret.'
					},
					{
						term: 'Priority',
						detail:
							'Stored and shown. The current selector does not order by it — do not assume a lower number wins a call.'
					},
					{
						term: 'Headers',
						detail:
							"Default headers sent upstream, one Name: value per line. They are not the caller's headers."
					}
				]
			},
			{
				title: 'The provider detail page',
				lede: 'One upstream per page: usage, quota, rate limit, routing, credentials, its catalog, and a playground.',
				facts: [
					{
						term: 'Fetch models',
						detail:
							'Reads GET <baseUrl>/models with one stored credential and marks each row: already in catalog, hidden, or not seeded. Filter by free / paid / no price, then enable or disable exactly what is shown.'
					},
					{
						term: 'Upstream id vs slug',
						detail:
							'An upstream id is not always the routable slug — Google lists models/gemini-3.6-flash while the catalog stores gemini-3.6-flash. Matching ignores a leading models/ prefix; a newly enabled model keeps the id the upstream reported.'
					},
					{
						term: 'Test credential',
						detail:
							'A real GET /models per credential, so it proves the key works rather than that it exists. The response headers that start x-ratelimit are shown as the observed rate limit.'
					},
					{
						term: 'Playground',
						detail:
							'A real chat straight to the upstream with the stored credential. No system prompt, no tools, nothing written to the request log — and the model does not have to be published to be tested.'
					},
					{
						term: 'Empty reply',
						detail:
							'A reasoning model can spend the whole token budget before it answers; the trace is shown instead of a blank box. Treat that as a slow model, not a dead one.'
					}
				]
			}
		]
	},
	'admin-models': {
		audience: 'admin',
		sections: [
			{
				title: 'What the catalog stores',
				facts: [
					{
						term: 'Slug',
						detail:
							'What the client sends as model. Public pages and the data plane both key off it.'
					},
					{
						term: 'Prices',
						detail:
							'USD per 1M tokens, stored as micro-units. Input and output are separate columns.'
					},
					{
						term: 'active',
						detail:
							'The published status. It is the switch this page exists to flip — see Publishing below.'
					},
					{
						term: 'Provider',
						detail:
							'Which upstream the slug is attached to. A model on a disabled provider still will not route.'
					},
					{
						term: 'Delete',
						detail:
							'Removes the row. In-flight clients start getting an unknown-model response; old log lines keep the slug text.'
					}
				]
			},
			{
				title: 'Publishing',
				lede: 'Publishing is a decision, so it is a button rather than a side effect of editing prices. Two gates decide whether a slug is reachable, and both must be open.',
				facts: [
					{
						term: 'Model gate',
						detail:
							'The row must be published (status active). dev and disabled are drafts — neither serves and neither is advertised.'
					},
					{
						term: 'Provider gate',
						detail:
							'The provider must be active, or dev while the dev-provider opt-in is on. A published model on an off provider stays unreachable.'
					},
					{
						term: 'Reachable',
						detail:
							'The badge that joins both gates. "live" means a client can call it now; otherwise the badge names the gate that is shut.'
					},
					{
						term: 'Bulk',
						detail:
							'Tick rows and publish or unpublish them together. "Select all" acts on the rows the current filter shows, not the whole catalog.'
					},
					{
						term: 'Whole provider',
						detail:
							'One click publishes or unpublishes every model a provider owns. Use it when a whole upstream stops serving instead of clicking 200 rows.'
					},
					{
						term: 'Public effect',
						detail:
							'Publishing is what puts a slug on /models and /pricing. Unpublishing removes it from both and makes the router answer 404 for it.'
					}
				]
			}
		]
	},
	'admin-keys': {
		audience: 'admin',
		sections: [
			{
				title: 'Minting for someone else',
				facts: [
					{
						term: 'Owner',
						detail: 'The key is charged and logged against that user, not against you.'
					},
					{
						term: 'Secret',
						detail: 'Shown once in the success alert. The table keeps the prefix.'
					},
					{
						term: 'Rate limit',
						detail: 'Requests per minute, stored on the key. Blank means no cap stored.'
					},
					{
						term: 'Monthly cap',
						detail: 'USD per month, stored as micro-units. Blank means no cap stored.'
					},
					{
						term: 'Enforcement',
						detail:
							'The data plane does not read these limits yet. Saving them records the contract; it does not throttle today.'
					}
				]
			}
		]
	},
	'admin-users': {
		audience: 'admin',
		sections: [
			{
				title: 'Roles are capability sets',
				lede: 'Pages check a capability, not role === admin. A new role is a line in the map, not a new route.',
				facts: [
					{ term: 'user', detail: 'Member only: dashboard, keys, usage, account.' },
					{
						term: 'finance_admin',
						detail:
							'Member, plus admin overview, users, and the billing capability. The admin billing page is not shipped yet; member metering lives at /dashboard/billing.'
					},
					{
						term: 'ops_admin',
						detail: 'Member, plus overview, providers, models, requests, and connections.'
					},
					{
						term: 'admin',
						detail: 'Every capability, including ones whose pages are not built yet.'
					},
					{
						term: 'Ban',
						detail:
							'Flips the banned flag. You cannot ban yourself. This page does not claim the data plane rejects the flag on its own.'
					},
					{ term: 'Demote', detail: 'You cannot remove your own admin role. Another admin has to.' }
				]
			}
		]
	},
	'admin-requests': {
		audience: 'admin',
		sections: [
			{
				title: 'How to read the log',
				lede: 'Newest 200 calls, optionally filtered. This is not a full export.',
				facts: [
					{
						term: 'success',
						detail: 'The upstream answered and the router logged a completed call.'
					},
					{
						term: 'upstream_error',
						detail: 'The provider responded with a failure the router classified as upstream.'
					},
					{
						term: 'error',
						detail:
							'A router-side failure. The error column carries the stored string when there is one.'
					},
					{
						term: 'Key',
						detail: 'Prefix only. Enough to join to API Keys, not enough to replay the call.'
					},
					{
						term: 'Not stored',
						detail: 'Prompt and completion bodies. Do not look for them in this table.'
					}
				]
			}
		]
	},
	'admin-connections': {
		audience: 'admin',
		sections: [
			{
				title: 'Traffic versus reachability',
				lede: 'The counts are from the request log. The Test button is a live probe, separate from those counts.',
				facts: [
					{
						term: 'In use',
						detail:
							'The provider that served the newest logged call. One row, not a load-balancer weight.'
					},
					{
						term: 'Test',
						detail:
							"Decrypts that provider's credential and GETs its /models, 8 second timeout. The secret stays in the action."
					},
					{
						term: 'Avg latency',
						detail: 'Mean of logged calls for that provider, not the probe you just ran.'
					},
					{
						term: 'Errors',
						detail:
							'Logged failures attributed to that provider. A green probe does not clear history.'
					}
				]
			}
		]
	},
	'admin-audit-log': {
		audience: 'admin',
		sections: [
			{
				title: 'Reading an audit entry',
				lede: 'One row per mutating admin action, written in the same transaction as the change.',
				facts: [
					{ term: 'Changes', detail: 'The before/after diff. Secret-valued keys are dropped, never shown.' },
					{ term: 'Actor', detail: 'The signed-in user, or `system` for background writes.' },
					{ term: 'Action', detail: 'Dot notation: `credential.rotate`, `provider.update`.' }
				]
			}
		]
	},
	'admin-provider-connections': {
		audience: 'admin',
		sections: [
			{
				title: 'Connections',
				lede: 'Endpoints for one provider. Credentials hang off a connection, and every base_url is SSRF-checked on write.',
				facts: [
					{ term: 'Auth type', detail: 'bearer, oauth, header or query — how the credential is attached.' },
					{ term: 'Priority', detail: 'Lower wins inside the provider; health filtering runs first.' },
					{ term: 'Health', detail: 'healthy, degraded, unhealthy or unknown, written by the data plane.' }
				]
			}
		]
	},
	'admin-model-detail': {
		audience: 'admin',
		sections: [
			{
				title: 'One canonical model',
				lede: 'The customer-facing model: modality, context, capabilities and the providers mapped to it.',
				facts: [
					{ term: 'Slug', detail: 'What customers send as `model`. Aliases resolve to this.' },
					{ term: 'Capabilities', detail: 'Explicit false removes a candidate; a missing key is not a claim.' },
					{ term: 'Mappings', detail: 'The provider_model rows that can serve this model.' }
				]
			}
		]
	},
	'admin-provider-credentials': {
		audience: 'admin',
		sections: [
			{
				title: 'Credential pool',
				lede: 'One row per upstream account on a connection. The secret is shown once at creation and is never readable again.',
				facts: [
					{
						term: 'Buckets',
						detail: 'Every credential counts once: healthy, rate limited, cooldown, invalid, disabled, unknown.'
					},
					{
						term: 'Cooldown',
						detail: 'A credential in cooldown is skipped until cooldown_until passes.'
					},
					{ term: 'Weight', detail: "Relative share of traffic inside the connection, alongside priority." },
					{
						term: 'Rotate',
						detail: 'Stores a new secret on the same row. The old one is destroyed; nothing logs either.'
					}
				]
			}
		]
	},
	'admin-model-mappings': {
		audience: 'admin',
		sections: [
			{
				title: 'Provider mappings',
				lede: 'Which upstream model serves a canonical model. One canonical model can map to many providers.',
				facts: [
					{ term: 'Provider model id', detail: 'The upstream name sent in the request body.' },
					{
						term: 'Overrides',
						detail: 'Capabilities and context here beat the canonical values; empty means inherit.'
					},
					{ term: 'Disabled', detail: 'A disabled mapping is not a routable candidate until re-enabled.' }
				]
			}
		]
	},
	'admin-model-pricing': {
		audience: 'admin',
		sections: [
			{
				title: 'Versioned prices',
				lede: 'A price change is a new version row. History is never edited, so past bills stay reproducible.',
				facts: [
					{ term: 'Effective from/until', detail: 'The window a version was live in. Open until = current.' },
					{ term: 'Preview', detail: 'Shows the new version before it is applied; nothing is written.' },
					{
						term: 'Units',
						detail: 'Micro-units of currency per 1M tokens. A NULL cached or reasoning price falls back to input/output.'
					}
				]
			}
		]
	},
	'admin-model-sync': {
		audience: 'admin',
		sections: [
			{
				title: 'Catalog sync',
				lede: 'Diff the upstream catalog against local mappings, then apply what you select.',
				facts: [
					{ term: 'Diff', detail: 'Additions, removals and changes. A fetch never deletes a canonical model on its own.' },
					{ term: 'Apply', detail: 'Writes only the rows you ticked, and each write is audit-logged.' }
				]
			}
		]
	},
	'admin-routing': {
		audience: 'admin',
		sections: [
			{
				title: 'How routing is resolved',
				lede: 'Environment, then project, then workspace, then the platform default strategy.',
				facts: [
					{ term: 'Strategy', detail: 'balanced, lowest_cost, lowest_latency, highest_reliability and friends.' },
					{ term: 'Fallback', detail: 'Retryable errors move to the next candidate within the request deadline.' },
					{ term: 'This page', detail: 'Shows the policies in force and where each one applies.' }
				]
			}
		]
	},
	'admin-routing-policies': {
		audience: 'admin',
		sections: [
			{
				title: 'Routing policies',
				lede: 'A policy bundles strategy, attempts, timeout and constraints for one scope.',
				facts: [
					{ term: 'Scope', detail: 'Detached policies are platform-wide; scoped ones bind to a workspace, project or environment.' },
					{ term: 'Max attempts', detail: 'Includes the first try. Two attempts means one retry.' },
					{ term: 'Constraints', detail: 'Price, latency and availability caps a candidate must meet.' }
				]
			}
		]
	},
	'admin-routing-strategies': {
		audience: 'admin',
		sections: [
			{
				title: 'Strategies',
				lede: 'How the router ranks candidates after constraints. The scoring formula is internal and may change.',
				facts: [
					{ term: 'balanced', detail: 'Weighted mix of price, latency, reliability and capacity.' },
					{ term: 'lowest_cost / lowest_latency', detail: 'Single-signal ranking over the candidate set.' },
					{ term: 'provider_priority', detail: 'The provider priority column decides, ignoring observed traffic.' },
					{ term: 'round_robin / random', detail: 'Even spread across candidates; simulated order is deterministic.' }
				]
			}
		]
	},
	'admin-routing-fallbacks': {
		audience: 'admin',
		sections: [
			{
				title: 'Fallback order',
				lede: 'Retryable failures move down the candidate list until the deadline runs out.',
				facts: [
					{ term: 'Retryable', detail: 'Rate limited, timeout, unavailable, circuit open, transport errors.' },
					{ term: 'Never retried', detail: 'Invalid request, context too long, model not found, content rejected.' },
					{ term: 'Deadline', detail: 'An attempt that cannot finish inside request_timeout_ms is never started.' }
				]
			}
		]
	},
	'admin-routing-circuit-breakers': {
		audience: 'admin',
		sections: [
			{
				title: 'Circuit breakers',
				lede: 'Configuration here; the open/closed state lives in Valkey and degrades to closed when it is unreachable.',
				facts: [
					{ term: 'Target', detail: 'One provider, connection or model. Uniquely keyed by target.' },
					{ term: 'Open', detail: 'failure_threshold failures inside window_seconds trip the breaker for open_ms.' },
					{ term: 'Half open', detail: 'After the cooldown, half_open_probes trial requests decide whether to close.' }
				]
			}
		]
	},
	'admin-routing-simulations': {
		audience: 'admin',
		sections: [
			{
				title: 'What a simulation is',
				lede: 'Candidate ranking for a hypothetical request. No inference runs and no upstream is contacted.',
				facts: [
					{ term: 'Candidates', detail: 'Provider, connection, estimated cost, health, score and why it ranks there.' },
					{ term: 'Token estimate', detail: 'Yours to set; it drives the estimated cost column only.' },
					{ term: 'Score', detail: 'Derived from the selected strategy over price, latency, reliability and priority.' }
				]
			}
		]
	},
	'admin-traffic': {
		audience: 'admin',
		sections: [
			{
				title: 'Platform traffic rules',
				lede: 'Hard limits every scope is capped by. A tighter level may lower a limit, never raise it.',
				facts: [
					{ term: 'Hard limits', detail: 'Requests per minute, tokens per minute, concurrency — stored in system settings.' },
					{ term: 'Effective limit', detail: 'The minimum across platform, workspace, project, environment and key.' }
				]
			}
		]
	},
	'admin-traffic-rate-limits': {
		audience: 'admin',
		sections: [
			{
				title: 'Rate limits by scope',
				lede: 'One row per workspace, project, environment or key. Counters live in Valkey; the rules live here.',
				facts: [
					{ term: 'Scope', detail: 'The subject the limits apply to. Unset fields inherit from the scope above.' },
					{ term: 'Spend caps', detail: 'Daily and monthly caps in micro-units; a breach returns INSUFFICIENT_CREDITS or 429.' }
				]
			}
		]
	},
	'admin-traffic-throttling': {
		audience: 'admin',
		sections: [
			{
				title: 'Throttling view',
				lede: 'Recent rejections, grouped by which limit tripped. Read-only: this is what the counters are doing.',
				facts: [
					{ term: 'Window', detail: 'Fixed windows per counter; a window starts at the first request in it.' },
					{ term: 'Concurrency', detail: 'In-flight gauge per scope, decremented when the response finishes.' }
				]
			}
		]
	},
	'admin-traffic-queues': {
		audience: 'admin',
		sections: [
			{
				title: 'Queues',
				lede: 'Work waiting on background jobs and in-flight requests by scope.',
				facts: [
					{ term: 'Pending jobs', detail: 'Queued work by type, from the job table. Retry and cancel live in Jobs.' },
					{ term: 'In flight', detail: 'Current concurrency counters per scope, from Valkey.' }
				]
			}
		]
	},
	'admin-request-detail': {
		audience: 'admin',
		sections: [
			{
				title: 'What you are looking at',
				lede: 'One call: resolved routing, every attempt, tokens, cost and timing.',
				facts: [
					{
						term: 'Bodies',
						detail: 'The raw prompt and response are shown only when retention keeps content; otherwise "not retained".'
					},
					{ term: 'Attempts', detail: 'Each try in order, with the reason that candidate won and why it was retried.' },
					{ term: 'Cost snapshot', detail: 'The prices this call was billed at; later price changes never rewrite it.' }
				]
			}
		]
	},
	'admin-analytics': {
		audience: 'admin',
		sections: [
			{
				title: 'Analytics',
				lede: 'Usage rolled up by hour and day — the ranges the raw request log cannot scan cheaply.',
				facts: [
					{ term: 'Buckets', detail: 'usage_hourly and usage_daily, summed by workspace, project, model and provider.' },
					{ term: 'Cost', detail: 'Micro-units summed from the rollups, shown as USD.' }
				]
			}
		]
	},
	'admin-health': {
		audience: 'admin',
		sections: [
			{
				title: 'Health',
				lede: 'Observed outcomes per provider and connection over recent traffic, plus the stored health state.',
				facts: [
					{ term: 'Success rate', detail: 'From the request log, not a synthetic probe.' },
					{ term: 'Health state', detail: 'The connection health_status written by the data plane.' }
				]
			}
		]
	},
	'admin-user-detail': {
		audience: 'admin',
		sections: [
			{
				title: 'One account',
				lede: 'Workspaces, projects, usage, billing and key metadata for a single user.',
				facts: [
					{ term: 'Suspend', detail: 'Blocks sign-in and kills live sessions immediately. Audit-logged.' },
					{ term: 'Last activity', detail: 'The newest request or session timestamp on record.' }
				]
			}
		]
	},
	'admin-workspaces': {
		audience: 'admin',
		sections: [
			{
				title: 'Workspaces',
				lede: 'Every workspace with its owner, members and spend.',
				facts: [
					{ term: 'Status', detail: 'active, archived or suspended. Suspension stops API traffic for the workspace.' },
					{ term: 'Spend', detail: 'Sum of the workspace request log and its billing balance.' }
				]
			}
		]
	},
	'admin-workspace-detail': {
		audience: 'admin',
		sections: [
			{
				title: 'One workspace',
				lede: 'Members, projects, usage and billing for a single workspace.',
				facts: [
					{ term: 'Members', detail: 'Each member has a role row; builtin roles live at workspace scope NULL.' },
					{ term: 'Suspend', detail: 'Suspends the workspace and every environment in it. Audit-logged.' }
				]
			}
		]
	},
	'admin-projects': {
		audience: 'admin',
		sections: [
			{
				title: 'Projects',
				lede: 'Every project with its workspace, environments and usage.',
				facts: [
					{ term: 'Environments', detail: 'development, staging, production and custom, each with its own keys.' },
					{ term: 'Status', detail: 'active, archived or suspended, independent of the workspace.' }
				]
			}
		]
	},
	'admin-project-detail': {
		audience: 'admin',
		sections: [
			{
				title: 'One project',
				lede: 'Environments, keys, usage and the routing policy in force for a single project.',
				facts: [
					{ term: 'Routing', detail: 'Project policy first, else the workspace one, else the platform default.' },
					{ term: 'Keys', detail: 'API key metadata only — the secret is not stored and cannot be shown.' }
				]
			}
		]
	},
	'admin-billing': {
		audience: 'admin',
		sections: [
			{
				title: 'Revenue',
				lede: 'The credit ledger platform-wide, with invoices and manual adjustments.',
				facts: [
					{ term: 'Ledger', detail: 'Every posting is signed micro-units. Balance is the sum; the account column is a cache.' },
					{ term: 'Adjustment', detail: 'A manual credit or debit. Writes its own ledger row and audit entry.' },
					{ term: 'Invoices', detail: 'draft, open, paid, void or uncollectible.' }
				]
			}
		]
	},
	'admin-security': {
		audience: 'admin',
		sections: [
			{
				title: 'Security rules',
				lede: 'Threshold rules over request and audit traffic. SQL counts, not machine learning.',
				facts: [
					{ term: 'Action', detail: 'log records the signal; block also refuses the subject.' },
					{ term: 'Kind', detail: 'Request spikes, auth failures, key rotation, IP spread, budget burn, errors, credential abuse.' }
				]
			}
		]
	},
	'admin-security-abuse': {
		audience: 'admin',
		sections: [
			{
				title: 'Abuse signals',
				lede: 'Rules evaluated over recent windows, newest window first. Each signal names the count that tripped it.',
				facts: [
					{ term: 'Window', detail: 'The rule config carries window_seconds and the threshold for that window.' },
					{ term: 'Value', detail: 'What was observed — shown next to the threshold so you can judge it.' }
				]
			}
		]
	},
	'admin-security-blocked-ips': {
		audience: 'admin',
		sections: [
			{
				title: 'Blocked addresses',
				lede: 'Client addresses and subnets refused at the edge. Stored as block-action security rules.',
				facts: [
					{ term: 'Match', detail: 'A single address or a CIDR subnet.' },
					{ term: 'Effect', detail: 'Blocked traffic is refused before it can consume quota.' }
				]
			}
		]
	},
	'admin-security-blocked-keys': {
		audience: 'admin',
		sections: [
			{
				title: 'Blocked keys',
				lede: 'API keys refused at the edge, kept here so a block can be reviewed and lifted.',
				facts: [
					{ term: 'Key metadata', detail: 'Prefix and name only. The secret is not stored and cannot be shown.' },
					{ term: 'Versus revoke', detail: 'A block is reviewable; revoking a key is permanent and lives in API Keys.' }
				]
			}
		]
	},
	'admin-system': {
		audience: 'admin',
		sections: [
			{
				title: 'System',
				lede: 'PostgreSQL, Valkey, workers and the job queue. Every number here is read live.',
				facts: [
					{ term: 'Health', detail: 'Aggregate status for the status page and the health drill-downs.' },
					{ term: 'Metrics', detail: 'Traffic and error counts from the request log over recent windows.' }
				]
			}
		]
	},
	'admin-system-health': {
		audience: 'admin',
		sections: [
			{
				title: 'Component health',
				lede: 'Health snapshots per component, for the status page.',
				facts: [
					{ term: 'Source', detail: 'system_event health snapshots plus open incidents.' },
					{ term: 'Status page', detail: 'Components derive from this state; an open incident overrides it.' }
				]
			}
		]
	},
	'admin-system-metrics': {
		audience: 'admin',
		sections: [
			{
				title: 'Metrics',
				lede: 'Request volume, error mix and latency percentiles from the request log.',
				facts: [
					{ term: 'Percentiles', detail: 'P50/P95/P99 of logged latency, per window bucket.' },
					{ term: 'Window', detail: 'Bucketed by minute or hour depending on the range picked.' }
				]
			}
		]
	},
	'admin-system-valkey': {
		audience: 'admin',
		sections: [
			{
				title: 'Valkey',
				lede: 'The cache and counter layer. Losing it loses no business data — PostgreSQL is authoritative.',
				facts: [
					{ term: 'INFO', detail: 'Memory, clients, ops/sec, hit rate, evictions and latency from the server itself.' },
					{ term: 'Namespaces', detail: 'Key counts by prefix: rate limits, concurrency, spend, health, circuits, caches.' },
					{ term: 'Degrades open', detail: 'When Valkey is down, counters are skipped and caches read cold.' }
				]
			}
		]
	},
	'admin-system-database': {
		audience: 'admin',
		sections: [
			{
				title: 'Database',
				lede: 'PostgreSQL state: connections, slow activity, table growth and dead rows.',
				facts: [
					{ term: 'pg_stat_activity', detail: 'Connection count and queries currently running.' },
					{ term: 'Dead rows', detail: 'From pg_stat_user_tables — bloat the autovacuum has not reclaimed.' },
					{ term: 'Migration version', detail: 'The last row in schema_migration.' }
				]
			}
		]
	},
	'admin-system-workers': {
		audience: 'admin',
		sections: [
			{
				title: 'Workers',
				lede: 'Background workers claiming jobs from PostgreSQL with FOR UPDATE SKIP LOCKED.',
				facts: [
					{ term: 'Claim', detail: 'A worker takes a pending job and holds lock:job:{id} in Valkey while it runs.' },
					{ term: 'Running', detail: 'Jobs in flight right now, with their attempt counts.' }
				]
			}
		]
	},
	'admin-system-jobs': {
		audience: 'admin',
		sections: [
			{
				title: 'Job queue',
				lede: 'Every background job with status, attempts and the error that stopped it.',
				facts: [
					{ term: 'Retry', detail: 'Requeues a failed job with a fresh attempt budget. Audit-logged.' },
					{ term: 'Cancel', detail: 'Marks a pending or running job cancelled. Audit-logged.' },
					{ term: 'Payload', detail: 'The job arguments. Shown as stored; secrets are redacted at write.' }
				]
			}
		]
	},
	'admin-system-events': {
		audience: 'admin',
		sections: [
			{
				title: 'System events',
				lede: 'Operational events, newest first, filterable by type.',
				facts: [
					{ term: 'Type', detail: 'What happened, e.g. a health snapshot or a job failure.' },
					{ term: 'Resource', detail: 'The subject the event is about, when it has one.' }
				]
			}
		]
	},
	'admin-settings': {
		audience: 'admin',
		sections: [
			{
				title: 'Platform settings',
				lede: 'Registration, retention, defaults and maintenance mode. Every change is audit-logged.',
				facts: [
					{ term: 'Retention', detail: 'How long metadata and content are kept. Content capture is opt-in.' },
					{ term: 'Default routing', detail: 'The platform policy used when no scope defines one.' },
					{ term: 'Maintenance', detail: 'Maintenance mode refuses new API traffic while enabled.' }
				]
			}
		]
	},
	'admin-settings-feature-flags': {
		audience: 'admin',
		sections: [
			{
				title: 'Feature flags',
				lede: 'Rollouts behind a name. Reading code checks the flag; flipping one is audit-logged.',
				facts: [
					{ term: 'Enabled', detail: 'The on/off gate every reader checks first.' },
					{ term: 'Rollout', detail: 'A jsonb shape the reader interprets — percentage, cohort or allowlist.' }
				]
			}
		]
	},
	'admin-incidents': {
		audience: 'admin',
		sections: [
			{
				title: 'Incidents',
				lede: 'One row per incident with a timeline of updates. The status page reads these.',
				facts: [
					{ term: 'Severity', detail: 'minor, major or critical.' },
					{ term: 'Timeline', detail: 'Updates move through investigating, identified, monitoring, resolved.' },
					{ term: 'Resolved', detail: 'Resolution time is recorded on the incident itself.' }
				]
			}
		]
	}
} as const satisfies Record<string, Guide>;
