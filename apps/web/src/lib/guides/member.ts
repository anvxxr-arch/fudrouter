/**
 * Member guides — explanatory copy for the signed-in customer surface.
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

export const MEMBER_GUIDES = {
	dashboard: {
		audience: 'member',
		sections: [
			{
				title: 'How to read this',
				lede: 'Everything here is your account only. Cross-user totals live on Admin.',
				facts: [
					{
						term: 'Active keys',
						detail:
							'Keys that have not been revoked. A revoked key still exists; it just cannot call.'
					},
					{ term: 'Requests', detail: 'Count of logged calls, success and failure together.' },
					{ term: 'Tokens', detail: 'Input plus output. Usage splits them if you need the mix.' },
					{
						term: 'Spend',
						detail: 'Sum of stored micro-units, shown as USD. It is not a wallet balance.'
					},
					{
						term: 'Recent',
						detail: 'Newest first. The full log, with latency and the error string, is Usage.'
					}
				]
			}
		]
	},
	keys: {
		audience: 'member',
		sections: [
			{
				title: 'How a key works',
				lede: 'Create is the one action on this page. Revoke is per row, and it is not undo.',
				facts: [
					{
						term: 'Shown once',
						detail: 'The create response is the only time the secret is rendered. Copy it then.'
					},
					{
						term: 'Later',
						detail:
							'The table shows the name and the prefix. That is enough to recognise a key, not enough to call with it.'
					},
					{ term: 'Stored', detail: 'A hash. Staff cannot look the secret up for you.' },
					{
						term: 'Revoke',
						detail:
							'Sets the revoked time. Later calls with that key are rejected. Old log rows stay.'
					},
					{
						term: 'Header',
						detail:
							'Authorization: Bearer, then the full key, against https://ai.karepmuwes.my.id/v1.'
					}
				]
			}
		]
	},
	usage: {
		audience: 'member',
		sections: [
			{
				title: 'How to read the usage totals',
				lede: 'Everything the workspace routed in the window — the numbers, not a request list.',
				facts: [
					{ term: 'Requests', detail: 'Count of logged calls, success and failure together.' },
					{
						term: 'Input / cached / output / reasoning',
						detail: 'The token splits, counted apart and then summed as total tokens.'
					},
					{
						term: 'Cost',
						detail:
							'What customers were charged across the window. It is not a wallet balance.'
					},
					{
						term: 'Credits charged',
						detail:
							'What was posted to the credit ledger for these calls. Charged separately from the cost shown here.'
					},
					{
						term: 'Source',
						detail:
							'Short windows read the raw request log; long windows read the daily rollup. When the rollup is not up to date yet, the page falls back to raw rows and says so.'
					},
					{
						term: 'Breakdowns',
						detail:
							'By day, project, environment, API key, model and provider. A request whose model never resolved rolls up under Unresolved rather than vanishing.'
					}
				]
			}
		]
	},
	account: {
		audience: 'member',
		sections: [
			{
				title: 'What you can change',
				facts: [
					{
						term: 'Name',
						detail: 'Display name in the console. It is not the key prefix and not the email.'
					},
					{
						term: 'Timezone',
						detail:
							'An IANA name, stored on your profile. Tables still render timestamps in UTC until a page formats with it.'
					},
					{
						term: 'Email',
						detail: 'Identity for sign-in and for a deletion request. Not editable on this form.'
					},
					{
						term: 'Role',
						detail:
							'Decides which admin surfaces you can open. A member does not see them. Staff change it under Users.'
					}
				]
			}
		]
	},
	billing: {
		audience: 'member',
		sections: [
			{
				title: 'Balance and thresholds',
				lede: 'The balance is the ledger sum — every posting ever made — never a bare number.',
				facts: [
					{
						term: 'Balance',
						detail:
							'SUM of every ledger amount for this account, in micro-units (1e-6). A cached copy is kept on the account and reconciled from the ledger, but the ledger is the record.'
					},
					{
						term: 'Warning threshold',
						detail:
							'Below this balance the router raises a low-balance alert event. Editable here; the router reads the same values.'
					},
					{
						term: 'Hard-stop threshold',
						detail:
							'At or below this balance the router rejects requests with INSUFFICIENT_CREDITS until credits are added. It must sit at or below the warning threshold.'
					},
					{
						term: 'This period',
						detail:
							'The current UTC calendar month, summed from the ledger. The window rolls over at UTC midnight, not at your local midnight.'
					}
				]
			},
			{
				title: 'How billing works here',
				paragraphs: [
					'Every billed request posts one usage_charge to the ledger, keyed to its request id — a retried request can never be charged twice. Credits are added manually or granted by an administrator; payment processing is out of scope, so nothing here charges a card.'
				]
			}
		]
	},
	'billing.credits': {
		audience: 'member',
		sections: [
			{
				title: 'Reading the ledger',
				facts: [
					{
						term: 'Entry',
						detail:
							'A signed amount and what it was: +$100.00 credit purchase, -$0.00421 request usage, and so on for adjustment, refund, promotion and expiration.'
					},
					{
						term: 'Balance',
						detail:
							'The running ledger balance after the entry — the same sum the overview shows, so a filtered view still shows true history.'
					},
					{
						term: 'Add credits',
						detail:
							'Records a credit_purchase row. Payment processing is out of scope — purchases are manual or admin-granted, and a double submit is one purchase, not two.'
					}
				]
			}
		]
	},
	'billing.transactions': {
		audience: 'member',
		sections: [
			{
				title: 'Transactions',
				lede: 'The raw ledger in export-friendly columns, newest first.',
				facts: [
					{
						term: 'Amount',
						detail: 'Signed micro-units of the row currency: credits positive, charges negative.'
					},
					{
						term: 'Request',
						detail:
							'The request id a usage_charge belongs to. One request, one charge, ever — the idempotency key guarantees it.'
					},
					{
						term: 'Download CSV',
						detail:
							'Exports the rows on this page, with the same columns the table shows. Paging is cursor-based, so a download never re-reads or skips a row.'
					}
				]
			}
		]
	},
	'billing.invoices': {
		audience: 'member',
		sections: [
			{
				title: 'Invoices',
				lede: 'Statements of billed usage. Payment happens offline — an operator records it by hand.',
				facts: [
					{
						term: 'Generate',
						detail:
							'Computes the previous UTC calendar month from the ledger and records it as an invoice, immediately. Scheduled runs arrive later with the invoice job worker.'
					},
					{
						term: 'Status',
						detail: 'draft, open, paid, void or uncollectible. Mark paid attests an offline payment; void cancels collection.'
					},
					{
						term: 'Amount',
						detail: 'What the ledger billed in the invoice period — usage charges, not credit purchases.'
					}
				]
			}
		]
	},
	'billing.paymentMethods': {
		audience: 'member',
		sections: [
			{
				title: 'Payment methods',
				paragraphs: [
					'No payment method is on file and this page does not pretend otherwise: there is no card form and no payment flow. What it records is intent — how this workspace means to pay and who to contact — for an operator to set up billing offline.'
				]
			}
		]
	},
	workspace: {
		audience: 'member',
		sections: [
			{
				title: 'What the workspace owns',
				facts: [
					{
						term: 'Name and slug',
						detail:
							'Renaming changes the name only. The slug is set at creation and stays, so links never break.'
					},
					{
						term: 'Owner',
						detail:
							'One per workspace. The owner can transfer ownership to another active member and steps down to admin in the same action.'
					},
					{
						term: 'Status',
						detail:
							'Active, archived or suspended. Archiving keeps every project, environment and key; restoring puts the workspace back to active.'
					},
					{
						term: 'Projects and members',
						detail: 'Counts of what this workspace currently holds.'
					}
				]
			},
			{
				title: 'Deleting the workspace',
				paragraphs: [
					'Deletion is permanent and needs the workspace name typed exactly. It refuses while projects still exist unless you tick the force option, and the ledger keeps the usage history of everything that was deleted — anonymised, never erased.'
				]
			}
		]
	},
	projects: {
		audience: 'member',
		sections: [
			{
				title: 'What a project is',
				facts: [
					{
						term: 'Name',
						detail: 'Renamable at any time; shown on keys, requests and bills that belong to it.'
					},
					{
						term: 'Slug',
						detail: 'Set at creation from the name, uniqued inside the workspace, stable afterwards.'
					},
					{
						term: 'Environments',
						detail:
							'Every project starts with development, staging and production. Custom environments can be added.'
					},
					{
						term: 'Status',
						detail:
							'Active projects accept new keys; archived ones keep their data and can be restored.'
					}
				]
			},
			{
				title: 'Switching',
				paragraphs: [
					'Selecting a project here makes it the active project for the shell: the API Keys, Routing, Requests and other project pages all follow that selection.'
				]
			}
		]
	},
	project: {
		audience: 'member',
		sections: [
			{
				title: 'The project at a glance',
				facts: [
					{ term: 'Environments', detail: 'Each environment with its type, status and key count.' },
					{
						term: 'Sub-pages',
						detail:
							'Environments, API keys, playground, model aliases and routing policy all hang off this project.'
					},
					{ term: 'Created', detail: 'The creation date. Creation and every change are in the audit log.' }
				]
			},
			{
				title: 'Deleting a project',
				paragraphs: [
					'Deletion needs the project name typed exactly and is refused while API keys still exist unless you explicitly force it. Environments and keys go with the project; the request ledger survives with its links cleared, so cost history is never destroyed.'
				]
			}
		]
	},
	environments: {
		audience: 'member',
		sections: [
			{
				title: 'The three defaults',
				facts: [
					{ term: 'Development', detail: 'For local work. Slug development.' },
					{ term: 'Staging', detail: 'For pre-production checks. Slug staging.' },
					{ term: 'Production', detail: 'For live traffic. Slug production.' },
					{
						term: 'Custom',
						detail:
							'Any environment you add yourself. It behaves like the defaults but has type custom.'
					}
				]
			},
			{
				title: 'Per-environment settings',
				facts: [
					{
						term: 'Routing policy',
						detail: 'The policy this environment routes with. Empty inherits the project or platform default.'
					},
					{
						term: 'Monthly budget',
						detail:
							'A ceiling in USD, stored as micro-units. Empty means no environment-level ceiling.'
					},
					{
						term: 'RPM, TPM, concurrency',
						detail:
							'Rate limits for this environment. A blank field means inherit — a level may tighten the chain, never widen it.'
					}
				]
			}
		]
	},
	'keys-detail': {
		audience: 'member',
		sections: [
			{
				title: 'Reading a key',
				facts: [
					{ term: 'Prefix', detail: 'The public part of the key, shown as sk-ar-<prefix>. Identifies the key in logs and support.' },
					{
						term: 'Status',
						detail:
							'Active, disabled or revoked. Disabled keys resume when enabled again; revoked keys never do.'
					},
					{ term: 'Expires', detail: 'When the key stops working on its own. Empty means it does not.' },
					{ term: 'Last used', detail: 'The most recent request that authenticated with this key.' }
				]
			},
			{
				title: 'The secret is shown once',
				paragraphs: [
					'Only a hash of the secret is stored, so the secret itself exists only in the response that created or rotated the key. Rotating replaces it: the old secret stops working the moment the new one is issued.'
				]
			},
			{
				title: 'Usage',
				facts: [
					{ term: 'Requests', detail: 'Every logged call with this key, successes and failures together.' },
					{ term: 'Tokens', detail: 'Input and output tokens summed over the key’s requests.' },
					{ term: 'Spend', detail: 'Sum of the customer charge in micro-units, shown as USD.' }
				]
			}
		]
	},
	team: {
		audience: 'member',
		sections: [
			{
				title: 'How access works',
				facts: [
					{
						term: 'Members',
						detail:
							'People with an active membership. Each member holds exactly one role at a time.'
					},
					{
						term: 'Roles',
						detail:
							'A role is a set of permission codes. Owner, admin, developer, billing and viewer are built in; custom roles are made from the same codes.'
					},
					{
						term: 'Invitations',
						detail:
							'Pending invitations carry a one-time acceptance link. Reissuing an invitation invalidates the old link.'
					}
				]
			},
			{
				title: 'Changing and removing',
				paragraphs: [
					'Changing a role takes effect on their next request. Removing a member revokes their access immediately; their past requests and audit entries remain. The workspace owner keeps the owner role and cannot be removed.'
				]
			}
		]
	},
	invite: {
		audience: 'member',
		sections: [
			{
				title: 'This invitation',
				facts: [
					{
						term: 'Accept',
						detail:
							'Joins you to the named workspace with the invited role and makes it your current workspace.'
					},
					{ term: 'Decline', detail: 'Discards the invitation without joining.' },
					{
						term: 'Expiry',
						detail:
							'Invitations expire seven days after they were issued. Ask for a fresh link after that.'
					},
					{
						term: 'Address',
						detail:
							'The invitation names one email address. You must be signed in as that address to accept it.'
					}
				]
			}
		]
	},
	playground: {
		audience: 'member',
		sections: [
			{
				title: 'What this is',
				lede: 'A real request through the router — same auth, limits, routing and billing as production.',
				facts: [
					{ term: 'Model', detail: 'A canonical slug or one of your aliases. fudrouter/* virtuals work here too.' },
					{ term: 'Strategy override', detail: 'Picks the routing strategy for this run only. Policy default uses the bound routing policy.' },
					{ term: 'Run key', detail: 'Each run mints a short-lived key in your chosen key’s context and revokes it right after. The secret never leaves the server.' },
					{ term: 'Streaming', detail: 'Relays the SSE as it arrives; the metrics panel fills in when the stream ends.' }
				]
			},
			{
				title: 'How to read the metrics',
				facts: [
					{ term: 'Provider / connection / model', detail: 'What actually served — not what you asked for.' },
					{ term: 'Tokens', detail: 'Input, output and total as the provider reported them.' },
					{ term: 'TTFT / latency', detail: 'Time to first token (streaming) and total time.' },
					{ term: 'Cost', detail: 'Customer charge in micro-units, shown as USD.' },
					{ term: 'Fallback / attempts', detail: 'Whether a fallback route was used and how many routing attempts it took.' },
					{ term: 'Request ID', detail: 'The req_… ledger row behind this run — also in Usage.' }
				]
			}
		]
	},
	aliases: {
		audience: 'member',
		sections: [
			{
				title: 'What an alias is',
				lede: 'Your application sends a name, not a model: {"model": "production-chat"}.',
				paragraphs: [
					'Swap the models behind an alias without touching the application — no redeploy, no config change on your side. The next request resolves through the new target list.'
				],
				facts: [
					{ term: 'Primary + fallbacks', detail: 'Ordered target list, position 1..N. The router walks it in order.' },
					{ term: 'Scope', detail: 'Project aliases win over workspace aliases; the fudrouter/* virtuals are global and read-only.' },
					{ term: 'Resolution order', detail: 'Project alias → workspace alias → global virtual → literal model slug.' },
					{ term: 'Deprecated target', detail: 'A target on a deprecated or sunset model is flagged — move the traffic before it disappears.' }
				]
			}
		]
	},
	routing: {
		audience: 'member',
		sections: [
			{
				title: 'Strategies',
				lede: 'Each policy picks how candidates are scored and ordered.',
				facts: [
					{ term: 'Balanced', detail: 'Normalizes price, latency, reliability and capacity signals and blends them with your weights. The formula is internal and may change without breaking the API.' },
					{ term: 'Lowest cost / latency / reliability', detail: 'Single-signal strategies: cheapest, fastest, or most reliable candidate wins.' },
					{ term: 'Provider Priority / Weighted', detail: 'Your provider_preferences.order decides; weighted spreads load across it.' },
					{ term: 'Round Robin / Random', detail: 'Rotation across the candidate set.' },
					{ term: 'Smart', detail: 'Learns from outcomes — coming soon, shown disabled.' },
					{ term: 'Constraints', detail: 'Hard filters applied before scoring: max price, max P95 latency, min availability, allowed/blocked providers, region preference.' },
					{ term: 'Weights', detail: 'Price/latency/reliability/capacity, 0-100 each, used by Balanced.' }
				]
			},
			{
				title: 'Where a policy applies',
				paragraphs: [
					'Resolution order is environment → project → workspace → platform default. Which policy binds to which environment is shown here read-only; the link itself is edited on the environments page. Retry and fallback stay inside max_attempts and request_timeout_ms — the timeout is a deadline the router will not start an attempt past.'
				]
			}
		]
	},
	requests: {
		audience: 'member',
		sections: [
			{
				title: 'How to read a request log',
				facts: [
					{ term: 'Timestamp', detail: 'When the router accepted the call, UTC. Newest first.' },
					{ term: 'Status', detail: 'The taxonomy value, or its legacy spelling mapped to it: error reads internal_error, upstream_error reads provider_error.' },
					{ term: 'Tokens', detail: 'Input plus cached, output and reasoning counted apart on the detail page.' },
					{ term: 'Cost', detail: 'What the customer was charged for the call, in micro-units shown as USD.' },
					{ term: 'Cursor', detail: 'Pages walk newest-to-oldest by keyset, so rows never repeat or skip between pages.' }
				]
			}
		]
	},
	'request-detail': {
		audience: 'member',
		sections: [
			{
				title: 'What a request shows',
				facts: [
					{ term: 'Metadata', detail: 'Identity of the call: id, endpoint, project, environment, key. IP is not recorded on rows written before the client-address column existed.' },
					{ term: 'Model', detail: 'What you asked for versus what served it, and which connection carried it.' },
					{ term: 'Timing', detail: 'Every stage the router measured: auth, rate limit, routing, queue, connection, TTFT, generation.' },
					{ term: 'Attempts', detail: 'Each routing attempt in order, with its outcome. A retry appears here before the request as a whole resolved.' },
					{ term: 'Error', detail: 'The normalized code and HTTP status, plus the raw upstream text when one was stored.' },
					{ term: 'Prompt and response', detail: 'Rendered only while content retention allows; otherwise the block says so instead of hiding.' }
				]
			}
		]
	},
	analytics: {
		audience: 'member',
		sections: [
			{
				title: 'How the rates are computed',
				facts: [
					{ term: 'Success rate', detail: 'Successful requests over total requests in the window.' },
					{ term: 'Percentiles', detail: 'Latency P50/P95/P99. On rolled-up ranges these are bucket estimates and are labelled as such.' },
					{ term: 'TTFT', detail: 'Mean time to first token over requests that reported one.' },
					{ term: 'Fallback/retry', detail: 'Requests that needed another candidate over all requests.' },
					{ term: 'Savings', detail: 'Not shown: there is no baseline price to compute it from, and this page does not print numbers it cannot derive.' }
				]
			}
		]
	},
	budgets: {
		audience: 'member',
		sections: [
			{
				title: 'Budget periods',
				facts: [
					{ term: 'Daily / Weekly / Monthly', detail: 'Windows are UTC: midnight, Monday 00:00, the 1st of the month.' },
					{ term: 'Thresholds', detail: 'Warning and critical fire at the configured percentages; the 100% action is notify, restrict or block.' },
					{ term: 'Consumption', detail: 'Spent within the current window against the amount.' }
				]
			}
		]
	},
	limits: {
		audience: 'member',
		sections: [
			{
				title: 'The limit chain',
				facts: [
					{ term: 'Effective limit', detail: 'The smallest configured value across platform default, workspace, project, environment and API key. A level may tighten, never loosen the platform hard limit.' },
					{ term: 'Binds at', detail: 'The most specific level holding the effective value — edit there to change it.' },
					{ term: 'Empty cell', detail: 'No limit at that level: it inherits rather than counting as zero.' }
				]
			}
		]
	},
	alerts: {
		audience: 'member',
		sections: [
			{
				title: 'Alerts and their history',
				facts: [
					{ term: 'Condition', detail: 'What to watch — error rate, latency, budget threshold, and friends — with its threshold and window.' },
					{ term: 'Channel', detail: 'Where the event goes while integrations stay internal.' },
					{ term: 'Events', detail: 'Every trigger, its measured value, and whether it is still firing or resolved.' }
				]
			}
		]
	},
	'connect': {
		audience: 'member',
		sections: [
			{
				title: 'What this page is',
				lede: 'Configuration, not a client. Pick a model, copy the block for your tool.',
				paragraphs: [
					'The router serves the [OI] chat-completions API and the Anthropic Messages API directly, so a client needs a base URL, a key and a model slug — no translator in front.',
					'Each block below is generated from the values you pick above it. Nothing on this page calls the router.'
				]
			},
			{
				title: 'Reading the snippets',
				facts: [
					{
						term: 'Base URL',
						detail:
							'[OI]-shaped tools take the base ending in /v1. An Anthropic client appends /v1/messages itself, so it gets the bare origin.'
					},
					{
						term: 'Model',
						detail:
							'Any slug from the catalogue. An alias works too — it resolves to its targets at request time.'
					},
					{
						term: 'Key',
						detail:
							'Shown once at creation and stored hashed, so a snippet carries only the prefix. Paste the secret in its place.'
					},
					{
						term: 'Verify',
						detail:
							'A green check in the tool means a real completion ran — the same auth, routing and billing as production.'
					}
				]
			}
		]
	}
} as const satisfies Record<string, Guide>;
