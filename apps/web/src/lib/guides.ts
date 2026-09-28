/**
 * Explanatory copy for every control-plane page.
 *
 * Pages render this through `<Guide>`, they do not embed a private essay.
 * Adding a page is a new entry here plus one tag at the call site.
 *
 * Rules for an entry:
 * - Say only what the code actually does. No invented limits, credits, or SLAs.
 * - A fact's term is a label; its detail is a value. Do not shout the value.
 * - Keep it short enough that an operate page still leads with its form.
 */

export type GuideFact = { term: string; detail: string };

export type GuideSection = {
	title: string;
	lede?: string;
	paragraphs?: readonly string[];
	facts?: readonly GuideFact[];
};

export type GuideAudience = 'public' | 'member' | 'admin';

export type Guide = {
	audience: GuideAudience;
	sections: readonly GuideSection[];
};

export const GUIDES = {
	home: {
		audience: 'public',
		// The landing leads with the product, not with a glossary. This is the
		// ONLY explanatory block on a public page, and `guides.test.ts` fails
		// the build if it grows past one short section. Everything it used to
		// carry — surfaces, the first-call walkthrough, price units — is
		// reference material and lives in the `docs` guide, where someone
		// arrived already looking for it.
		sections: [
			{
				title: 'One key, many models',
				facts: [
					{ term: 'Catalog', detail: 'GET /v1/models is public. No key needed.' },
					{ term: 'Calls', detail: 'POST /v1/chat/completions, metered per token.' }
				]
			}
		]
	},
	
	
	docs: {
		audience: 'public',
		sections: [
			{
				title: 'Authenticate',
				lede: 'OpenAI-compatible. The samples below use $FUDROUTER_KEY so you can paste them without editing the header shape.',
				facts: [
					{
						term: 'Header',
						detail: 'Authorization: Bearer, then the key. No other scheme is accepted on chat.'
					},
					{
						term: 'Shown once',
						detail: 'The full secret exists only in the create response. Later you see the prefix.'
					},
					{
						term: '401',
						detail:
							'Missing, malformed, or revoked key. A valid key and an unknown model is not a 401.'
					},
					{
						term: 'Models list',
						detail:
							'GET /v1/models does not require a key. A 200 from it proves nothing about your key.'
					}
				]
			},
			{
				title: 'What the router records',
				facts: [
					{
						term: 'Kept',
						detail:
							'Model, token counts, cost, latency, status, and an error string when the call failed.'
					},
					{
						term: 'Not kept',
						detail: 'Prompt and completion text are not written to the request log.'
					},
					{
						term: 'Stream',
						detail:
							'stream: true returns SSE. The final chunk carries usage; that is what gets metered.'
					},
					{
						term: 'Error body',
						detail: 'Failures use an error.message object and a 4xx or 5xx status.'
					}
				]
			},
{
				title: 'How to read a price',
				lede: 'The table is the pay-as-you-go surface only. A model that is not on /v1 has no per-token price to quote.',
				facts: [
					{ term: 'Unit', detail: 'USD per 1 million tokens. Input and output are priced apart.' },
					{
						term: 'Storage',
						detail:
							'The database keeps micro-units (millionths). The page formats those, it does not round in the row.'
					},
					{
						term: 'Context',
						detail:
							'The context column is the model window, in thousands of tokens, when we have one.'
					},
					{
						term: 'Tier',
						detail:
							'Placeholder. The model table has no tier column yet, so do not treat the badge as billing.'
					},
					{
						term: 'Coding plan',
						detail:
							'Covered models would be included in a subscription. That program is not live; this page does not invent a seat price.'
					}
				]
			},
{
				title: 'How to read the catalog',
				lede: 'Grouped by surface, because the surface is the URL your client uses. The tier is a property of the row, not the group.',
				facts: [
					{
						term: 'Slug',
						detail:
							'The string you send as model. When it is the same as the display name — which it is on almost every model — the card prints it once.'
					},
					{
						term: 'Context',
						detail:
							'Window size in tokens, when the row has one. A dash means we have not recorded it.'
					},
					{
						term: 'Tier',
						detail:
							'free or premium, colour and word. Placeholder until the database owns the assignment.'
					},
					{
						term: 'Same model, two surfaces',
						detail:
							'A slug can be free on one prefix and premium on the other. Read the row, not the name alone.'
					},
					{
						term: 'What is missing',
						detail:
							'Provider names and upstream URLs are not on this page. They are an admin concern.'
					}
				]
			},
{
				title: 'What this check is',
				lede: 'A probe from this page load, not a historical uptime feed.',
				facts: [
					{
						term: 'Health',
						detail:
							'GET /health on the data plane, 4 second timeout. The service name comes from that body.'
					},
					{
						term: 'Models',
						detail:
							'If health is up, GET /v1/models and count the data array. That is "models published".'
					},
					{
						term: 'Latency',
						detail:
							'Time for this page to finish the probe. It is not the latency of your last chat call.'
					},
					{
						term: 'Not included',
						detail: 'Each upstream provider is probed from Admin → Connections, not from here.'
					}
				]
			},
{
				title: 'What signing in opens',
				facts: [
					{
						term: 'Session',
						detail: 'Email and password, or Discord. The session cookie is what later pages read.'
					},
					{
						term: 'You land on',
						detail: 'Dashboard, unless your role includes admin.view — then the home is Admin.'
					},
					{
						term: 'You can',
						detail: 'Mint keys, read your own usage, and edit your display name and timezone.'
					},
					{
						term: 'You cannot',
						detail: 'See other accounts, provider credentials, or the request log across users.'
					}
				]
			},
{
				title: 'What an account is',
				facts: [
					{
						term: 'Required',
						detail: 'Name, email, and a password of at least 8 characters. Discord skips the form.'
					},
					{
						term: 'After create',
						detail: 'You are signed in and sent to API Keys. Mint one before the first call.'
					},
					{
						term: 'Role',
						detail:
							'New accounts are members. Staff roles are assigned from Admin → Users, not at signup.'
					},
					{
						term: 'Billing',
						detail:
							'No credit is granted here. Usage is metered once you call the API; top-ups are not on this form.'
					}
				]
			}
		]
	},
	
	
	
	terms: {
		audience: 'public',
		sections: [
			{
				title: 'The service',
				lede: 'Operational summary of what the product does today. Not a finished legal instrument — the header says so until counsel signs it.',
				paragraphs: [
					'fudrouter gives API access to third-party language models through one key. Accepted calls are metered per token and recorded against your account. Upstream availability and the prices in the catalog can change without a separate notice on this page.'
				]
			},
			{
				title: 'Use, availability, changes',
				facts: [
					{
						term: 'Acceptable use',
						detail:
							'Do not use the service to break the law, infringe someone else, or disrupt the platform or its upstreams.'
					},
					{
						term: 'As-is',
						detail:
							'No uptime figure is promised on this page. Status shows a live probe, not an SLA.'
					},
					{
						term: 'Catalog',
						detail:
							'Model list and per-token prices are whatever the active catalog says when you call.'
					},
					{
						term: 'Changes',
						detail:
							'These terms can be updated. Continued use after an update is the acceptance rule until a signed version replaces this summary.'
					}
				]
			}
		]
	},
	privacy: {
		audience: 'public',
		sections: [
			{
				title: 'What is stored',
				lede: 'Operational summary. Not a finished privacy notice — the header says so until it is reviewed.',
				facts: [
					{
						term: 'Account',
						detail: 'Email, name, role, timezone, and the timestamps the auth system keeps.'
					},
					{
						term: 'Keys',
						detail:
							'A hash, plus the prefix and the name you chose. The secret is not recoverable after create.'
					},
					{
						term: 'Requests',
						detail:
							'Model, token counts, cost, latency, status, error string. Not the prompt or the completion.'
					},
					{
						term: 'Provider secrets',
						detail: 'Encrypted at rest. No page load selects the ciphertext, and no API returns it.'
					}
				]
			},
			{
				title: 'Retention and deletion',
				paragraphs: [
					'Usage rows are kept for billing and abuse review. This page does not invent a day count. To ask for account deletion, write from the email on the account — that is the address we can tie to the row.'
				]
			}
		]
	},
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
				title: 'How to read a row',
				lede: 'Your calls, newest first. This is the audit log, not a chart.',
				facts: [
					{ term: 'In / Out', detail: 'Prompt tokens and completion tokens, counted apart.' },
					{
						term: 'Cost',
						detail:
							'Micro-units for that call, formatted as USD. A failed call can still carry a cost if the upstream billed it.'
					},
					{
						term: 'Latency',
						detail:
							'Milliseconds measured by the router for that request, with thousands separators.'
					},
					{
						term: 'Status',
						detail: 'success, or the failure status plus the error string when one was stored.'
					},
					{
						term: 'Not in the row',
						detail: 'Prompt text, completion text, and which upstream account served the call.'
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
	billing: {
		audience: 'member',
		sections: [
			{
				title: 'What is metered',
				lede: 'One stored row per logged call, priced in micro-units of the row currency.',
				facts: [
					{
						term: 'Spend to date',
						detail:
							'Sum of every logged row for this account. It is a spend total, not a wallet balance and not a credit.'
					},
					{
						term: 'This month',
						detail:
							'Rows from the first of the month, UTC. The window rolls over at UTC midnight, not at your local midnight.'
					},
					{
						term: 'Cost',
						detail:
							'Stored per row in micro-units (1e-6) and shown as USD by dividing by one million. A provider that reports no price stores zero rather than an estimate.'
					},
					{
						term: 'Usage by model',
						detail:
							'Grouped by the model slug the router routed to, the same slug Usage and the admin catalog show.'
					},
					{
						term: 'Recent charges',
						detail: 'The newest rows, capped. Usage holds the complete record including failures.'
					}
				]
			},
			{
				title: 'What is not billed',
				paragraphs: [
					'No payment method is on file, no invoice is generated, and there is no balance to top up — this page does not invent one. Metering is a property of the log, so a call rejected before it reached a model has no row and no cost.'
				]
			}
		]
	}
} as const satisfies Record<string, Guide>;

export type GuideId = keyof typeof GUIDES;

export function guideFor(id: GuideId): Guide {
	return GUIDES[id];
}
